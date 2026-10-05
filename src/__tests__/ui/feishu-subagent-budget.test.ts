import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cardBudget from '../../server/channels/feishu/card-budget.js';
import {
  type CardObject,
  type FeishuCardBudget,
  fitsFeishuCard,
  measureFeishuCard,
  planFeishuCards,
} from '../../server/channels/feishu/card-budget.js';
import {
  compactSubagentCard,
  type SubagentCardChunk,
} from '../../server/channels/feishu/subagent-budget.js';

const budget: FeishuCardBudget = { maxBytes: 1800, maxElements: 30, maxTables: 4 };
const md = (content: string, element_id: string): CardObject => ({ tag: 'markdown', content, element_id });
const card = (elements: CardObject[]): CardObject => ({
  schema: '2.0',
  config: { wide_screen_mode: true, update_multi: true },
  header: { template: 'red', title: { tag: 'plain_text', content: '子代理进度' } },
  body: { elements },
});
const panel = (id: string, elements: CardObject[]): CardObject => ({
  tag: 'collapsible_panel', element_id: id, expanded: false,
  header: { title: { tag: 'plain_text', content: '工具分组' } }, elements,
});
const button = (id: string): CardObject => ({
  tag: 'column_set', element_id: id, columns: [{ tag: 'column', elements: [{
    tag: 'button', text: { tag: 'plain_text', content: '查看完整详情' },
    behaviors: [{ type: 'callback', value: { action: 'detail:private-payload' } }],
  }] }],
});
const thought = (id: string, content: string): CardObject => panel(id, [md(content, `${id}-text`), button(`${id}-button`)]);
function tool(id: string, name: string, size = 400): { nodes: CardObject[]; chunk: SubagentCardChunk } {
  return {
    nodes: [
      md(`✅ Completed · **${name}**\nARGS_${id}_${'参数😀'.repeat(size)}`, `${id}-args`),
      panel(`${id}-result`, [md(`STDOUT_${id}_${'结果🚀'.repeat(size)}`, `${id}-stdout`)]),
      button(`${id}-button`),
    ],
    chunk: { kind: 'tool', toolName: name, status: 'completed', elementIds: [`${id}-args`, `${id}-result`, `${id}-button`] },
  };
}
function nodes(value: unknown): CardObject[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const node = value as CardObject;
  return [node, ...Object.values(node).flatMap(nodes)];
}
function visible(value: CardObject): string {
  return nodes(value).filter((node) => typeof node.content === 'string')
    .map((node) => (node.content as string).replace(/\\([\\`*_{}\[\]()<>#!|~+\-.])/g, '$1')).join('\n');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function verify(output: CardObject, source: CardObject, limits: FeishuCardBudget = budget): void {
  expect(fitsFeishuCard(output, limits)).toBe(true);
  expect(output.header).toEqual(source.header);
  const measured = measureFeishuCard(output);
  expect(measured.bytes).toBeLessThanOrEqual(limits.maxBytes);
  expect(measured.requestBytes).toBeLessThanOrEqual(limits.maxBytes);
  expect(measured.elements).toBeLessThanOrEqual(limits.maxElements);
  expect(measured.tables).toBeLessThanOrEqual(limits.maxTables);
  expect(Object.keys(output)).not.toContain('chunks');
  expect(JSON.stringify(output)).not.toMatch(/\\u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2}/);
}

afterEach(() => vi.restoreAllMocks());

describe('single-card subagent display budget', () => {
  it('returns an equal, independent deep clone when the complete original already fits', () => {
    const source = freeze(card([panel('group', [md('保留原样😀', 'text'), button('button')])]));
    const chunks = freeze<SubagentCardChunk[]>([{ kind: 'text', elementIds: ['text'] }]);
    const before = JSON.stringify(source);
    const output = compactSubagentCard(source, chunks, budget);
    expect(output).toEqual(source);
    expect(output).not.toBe(source);
    expect(output.header).not.toBe(source.header);
    expect(output.body.elements[0].elements).not.toBe(source.body.elements[0].elements);
    output.body.elements[0].elements[0].content = 'changed';
    expect(JSON.stringify(source)).toBe(before);
    expect(chunks).toEqual([{ kind: 'text', elementIds: ['text'] }]);
  });

  it('removes the oldest whole thought and its buttons before touching a newer tool or text', () => {
    const recent = tool('recent', 'bash', 1);
    const source = freeze(card([thought('old', 'HIDDEN_THOUGHT_'.repeat(3000)), ...recent.nodes, md('最新正文😀', 'new')]));
    const before = JSON.stringify(source);
    const output = compactSubagentCard(source, [
      { kind: 'thinking', elementIds: ['old'] }, recent.chunk, { kind: 'text', elementIds: ['new'] },
    ], budget);
    verify(output, source);
    expect(output.body.elements).toEqual([...recent.nodes, md('最新正文😀', 'new')]);
    expect(JSON.stringify(output)).not.toContain('HIDDEN_THOUGHT');
    expect(JSON.stringify(output)).not.toContain('old-button');
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each(['failed', 'interrupted'])('strips old tool arguments/stdout/buttons but keeps the %s status visible', (status) => {
    const old = tool('old', 'bash');
    old.chunk.status = status;
    old.chunk.elementIds.push('failure-summary');
    const source = freeze(card([
      panel('outer', [panel('inner', old.nodes), md('KEEP_LATEST', 'latest')]),
      md(`${status}: STDOUT_old_${'long failure'.repeat(200)}`, 'failure-summary'),
      md('❌ PROVIDER_FINAL_ERROR', 'final-state'),
    ]));
    const before = JSON.stringify(source);
    const output = compactSubagentCard(source, [old.chunk, { kind: 'text', elementIds: ['latest'] }], budget);
    verify(output, source);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('ARGS_old');
    expect(serialized).not.toContain('STDOUT_old');
    expect(serialized).not.toContain('private-payload');
    expect(visible(output)).toContain('bash');
    expect(visible(output)).toContain(status === 'failed' ? '❌失败1' : '⏹中断1');
    expect(visible(output)).toContain('PROVIDER_FINAL_ERROR');
    expect(nodes(output).find((node) => node.element_id === 'outer')?.expanded).toBe(true);
    expect(nodes(output).find((node) => node.element_id === 'latest')).toEqual(md('KEEP_LATEST', 'latest'));
    expect(JSON.stringify(source)).toBe(before);
  });

  it('shrinks the earliest text to its Unicode-safe suffix and leaves newer text byte-for-byte intact', () => {
    const text = 'OLD_PREFIX_' + '中文😀🚀\\"\n'.repeat(2500) + '精确保留末尾👩‍💻😀';
    const source = freeze(card([md(text, 'old'), md('LATEST_UNCHANGED', 'new')]));
    const output = compactSubagentCard(source, [
      { kind: 'text', elementIds: ['old'] }, { kind: 'text', elementIds: ['new'] },
    ], budget);
    verify(output, source);
    const old = nodes(output).find((node) => node.element_id === 'old')!;
    expect(old.content).toContain('较早内容已截断');
    expect(visible(output)).toContain('精确保留末尾👩‍💻😀');
    expect(JSON.stringify(output)).not.toContain('OLD_PREFIX');
    expect(nodes(output).find((node) => node.element_id === 'new')).toEqual(md('LATEST_UNCHANGED', 'new'));
    const decoded = visible(card([old])).split('较早内容已截断]\n')[1];
    expect(text.endsWith(decoded)).toBe(true);
    expect(source.body.elements[0].content).toBe(text);
  });

  it.each(['```typescript\n', '~~~~python\n', '| H |\n| --- |\n'])('literalizes dangerous text fragments (%s) without leaving a live fence/table', (opening) => {
    const source = card([md(opening + '危险正文😀'.repeat(1000) + '\n| end |\n```', 'text')]);
    const output = compactSubagentCard(source, [{ kind: 'text', elementIds: ['text'] }], budget);
    verify(output, source);
    expect(measureFeishuCard(output).tables).toBe(0);
    expect(visible(output)).toContain('| end |\n```');
    const content = output.body.elements[0].content;
    expect(content).not.toMatch(/^ {0,3}(`{3,}|~{3,})/m);
    expect(content).not.toMatch(/^\|/m);
  });

  it('counts the final table budget, including the newest single block with many small tables', () => {
    const tables = Array.from({ length: 9 }, (_, index) => `| H${index} |\n| --- |\n| 数据${index}😀 |\n\n`).join('');
    const source = card([md('OLDER', 'older'), md(tables, 'newest')]);
    const limits = { ...budget, maxTables: 1 };
    const output = compactSubagentCard(source, [
      { kind: 'text', elementIds: ['older'] }, { kind: 'text', elementIds: ['newest'] },
    ], limits);
    verify(output, source, limits);
    expect(visible(output)).toContain('数据8😀');
    expect(measureFeishuCard(output).tables).toBe(0);
    expect(visible(output)).toContain('纯文本预览');
  });

  it('merges hundreds of repeated name-only tools in exact order, removing now-empty groups', () => {
    const tools = Array.from({ length: 240 }, (_, index) => tool(`t${index}`, index % 3 === 0 ? 'Read' : index % 3 === 1 ? 'Read' : 'Grep', 1));
    const source = freeze(card([
      ...tools.map((entry, index) => panel(`g${index}`, [panel(`nested${index}`, entry.nodes)])),
      md('LATEST', 'latest'),
    ]));
    const limits = { maxBytes: 9000, maxElements: 3, maxTables: 1 };
    const output = compactSubagentCard(source, [...tools.map((entry) => entry.chunk), { kind: 'text', elementIds: ['latest'] }], limits);
    verify(output, source, limits);
    expect(nodes(output).filter((node) => node.tag === 'collapsible_panel')).toHaveLength(0);
    expect(nodes(output).filter((node) => node.tag === 'button')).toHaveLength(0);
    expect(output.body.elements).toHaveLength(2);
    const counts = new Map<string, number>();
    for (const entry of tools) counts.set(entry.chunk.toolName!, (counts.get(entry.chunk.toolName!) ?? 0) + 1);
    expect(output.body.elements[0].content).toBe(`**历史工具 · 240 次**\n${[...counts].map(([name, count]) => `${name} ×${count}`).join('；')}`);
    expect(output.body.elements[1]).toEqual(md('LATEST', 'latest'));
  });

  it('uses count/omission summaries under extreme pressure and preserves new text plus failure states', () => {
    const tools = Array.from({ length: 150 }, (_, index) => tool(`t${index}`, `Very_Long_Tool_Name_${index}_😀`, 1));
    tools[0].chunk.status = 'failed';
    tools[1].chunk.status = 'interrupted';
    const source = freeze(card([
      ...tools.flatMap((entry) => entry.nodes), md('NEWEST_RETAINED_最新😀', 'last'),
      md('❌ FINAL_FAILED', 'final-state'),
    ]));
    const limits = { maxBytes: 650, maxElements: 2, maxTables: 1 };
    const output = compactSubagentCard(source, [...tools.map((entry) => entry.chunk), { kind: 'text', elementIds: ['last'] }], limits);
    verify(output, source, limits);
    expect(output.body.elements).toHaveLength(1);
    expect(visible(output)).toContain('工具 150 次');
    expect(visible(output)).toContain('失败 1');
    expect(visible(output)).toContain('中断 1');
    expect(visible(output)).toContain('NEWEST_RETAINED_最新😀');
    expect(visible(output)).toContain('FINAL_FAILED');
    expect(JSON.stringify(output)).not.toContain('ARGS_');
    expect(JSON.stringify(output)).not.toContain('STDOUT_');
    expect(JSON.stringify(output)).not.toContain('Very_Long_Tool_Name_0_');
  });

  it('reduces a giant last tool before sacrificing unrelated history', () => {
    const previous = tool('old', 'Read', 1);
    const giant = tool('giant', 'web_read', 5000);
    const source = freeze(card([
      thought('think', 'KEEP_THOUGHT'), ...previous.nodes,
      md('KEEP_OLD_PROSE', 'prose'), ...giant.nodes, md('LATEST', 'last'),
    ]));
    const output = compactSubagentCard(source, [
      { kind: 'thinking', elementIds: ['think'] }, previous.chunk,
      { kind: 'text', elementIds: ['prose'] }, giant.chunk,
      { kind: 'text', elementIds: ['last'] },
    ], { ...budget, maxBytes: 3500 });
    verify(output, source, { ...budget, maxBytes: 3500 });
    expect(visible(output)).toContain('KEEP_THOUGHT');
    expect(visible(output)).toContain('KEEP_OLD_PROSE');
    expect(visible(output)).toContain('ARGS_old');
    expect(visible(output)).not.toContain('STDOUT_giant');
    expect(visible(output)).toContain('历史工具 · 1 次');
  });

  it('does not leave repeated empty truncation markers between compact tool history', () => {
    const elements: CardObject[] = [];
    const chunks: SubagentCardChunk[] = [];
    for (let index = 0; index < 12; index++) {
      const entry = tool(`t${index}`, 'search', 1);
      elements.push(...entry.nodes, md('OLD_PROSE_'.repeat(2000), `p${index}`));
      chunks.push(entry.chunk, { kind: 'text', elementIds: [`p${index}`] });
    }
    elements.push(md('LATEST_UNCHANGED', 'last'));
    chunks.push({ kind: 'text', elementIds: ['last'] });
    const source = freeze(card(elements));
    const output = compactSubagentCard(source, chunks, budget);
    verify(output, source);
    expect(visible(output).match(/较早内容已截断/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(visible(output)).toContain('LATEST_UNCHANGED');
    expect(visible(output)).toContain('历史工具');
  });

  it('retains usage in compact history and counts parallel calls once per step', () => {
    const first = tool('first', 'search');
    const second = tool('second', 'search');
    const usage = { step: 1, inputTokens: 3000, outputTokens: 100, contextTokens: 5000, contextWindow: 10000 };
    first.chunk.usage = usage;
    second.chunk.usage = { ...usage };
    const source = freeze(card([...first.nodes, ...second.nodes, md('LATEST', 'last')]));
    const output = compactSubagentCard(source, [first.chunk, second.chunk, { kind: 'text', elementIds: ['last'] }], budget);
    verify(output, source);
    expect(visible(output)).toContain('历史工具 · 2 次');
    expect(visible(output)).toContain('↓3k ↑100 5k 50%');
    expect(visible(output)).not.toContain('↓6k');
    expect(first.chunk.usage).toEqual(usage);
  });

  it('keeps the newest giant single block suffix rather than looping or preserving hidden full text', () => {
    const previous = tool('old', 'Read', 1);
    const text = 'LATEST_PREFIX_SECRET_' + '😀新的最大单块'.repeat(20000) + 'NEWEST_SUFFIX🚀';
    const source = freeze(card([...previous.nodes, md(text, 'last')]));
    const check = vi.spyOn(cardBudget, 'fitsFeishuCard');
    const output = compactSubagentCard(source, [previous.chunk, { kind: 'text', elementIds: ['last'] }], budget);
    const checks = check.mock.calls.length;
    verify(output, source);
    expect(checks).toBeLessThan(80);
    expect(visible(output)).toContain('NEWEST_SUFFIX🚀');
    expect(JSON.stringify(output)).not.toContain('LATEST_PREFIX_SECRET');
    expect(source.body.elements.at(-1).content).toBe(text);
  });

  it('supports text object IDs and legacy top-level elements without damaging the header', () => {
    const source: CardObject = { header: { title: { tag: 'plain_text', content: 'LEGACY' } }, elements: [
      { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'div', text: { tag: 'lark_md', element_id: 'inner-text', content: '中文😀'.repeat(5000) + 'TAIL' } }] }] },
    ] };
    const output = compactSubagentCard(source, [{ kind: 'text', elementIds: ['inner-text'] }], budget);
    verify(output, source);
    expect(output.body).toBeUndefined();
    expect(visible(output)).toContain('TAIL');
    expect(nodes(output).filter((node) => node.tag === 'column_set')).toHaveLength(0);
  });

  it('handles overlapping parent/descendant IDs and removes empty body-style wrappers', () => {
    const source = card([{ tag: 'collapsible_panel', element_id: 'think', header: { title: { tag: 'plain_text', content: '思考' } }, body: { elements: [
      panel('nested', [md('THINKING'.repeat(5000), 'text')]), button('think-button'),
    ] } }, panel('already-empty', []), md('KEEP', 'keep')]);
    const output = compactSubagentCard(source, [{ kind: 'thinking', elementIds: ['think', 'nested', 'text', 'think-button'] }], budget);
    verify(output, source);
    expect(output.body.elements).toEqual([md('KEEP', 'keep')]);
  });

  it('retains a failed/interrupted thinking-only terminal signal without retaining the thought', () => {
    const source = card([thought('thought', 'SECRET_THOUGHT_'.repeat(3000))]);
    const output = compactSubagentCard(source, [{ kind: 'thinking', elementIds: ['thought'], status: 'interrupted' }], budget);
    verify(output, source);
    expect(visible(output)).toContain('interrupted');
    expect(JSON.stringify(output)).not.toContain('SECRET_THOUGHT');
    expect(nodes(output).filter((node) => node.tag === 'button')).toHaveLength(0);
  });

  it('can shed optional notification summaries and body formatting instead of hiding full text', () => {
    const source = card([md('最新正文😀', 'text'), md('❌ FINAL_ERROR', 'error')]);
    source.config.summary = { content: 'HIDDEN_CONFIG_FULLTEXT'.repeat(3000) };
    source.body.padding = 'x'.repeat(3000);
    const output = compactSubagentCard(source, [{ kind: 'text', elementIds: ['text'] }], budget);
    verify(output, source);
    expect(JSON.stringify(output)).not.toContain('HIDDEN_CONFIG_FULLTEXT');
    expect(output.body.padding).toBeUndefined();
    expect(visible(output)).toContain('最新正文😀');
    expect(visible(output)).toContain('FINAL_ERROR');
    expect(visible(output)).toContain('失败');
  });

  it('fits a minimal state-preserving envelope and throws explicitly if even it cannot fit', () => {
    const source = card([md('❌ FINAL_ERROR_' + '错误😀'.repeat(5000), 'error')]);
    const minimum = { schema: '2.0', header: source.header, body: { elements: [
      { tag: 'markdown', content: '\\[省略\\] 失败\n' },
    ] } };
    const limits = { maxBytes: measureFeishuCard(minimum).requestBytes, maxElements: 2, maxTables: 1 };
    const output = compactSubagentCard(source, [], limits);
    verify(output, source, limits);
    expect(output.config).toBeUndefined();
    expect(visible(output)).toContain('省略');
    expect(visible(output)).toContain('失败');
    expect(() => compactSubagentCard(source, [], { ...limits, maxBytes: 1 })).toThrow('minimum legal envelope cannot fit budget');
    expect(() => compactSubagentCard(source, [], { ...limits, maxElements: 1 })).toThrow('minimum legal envelope cannot fit budget');
    const hugeHeader = card([md('x', 'text')]);
    hugeHeader.header.title.content = 'HEADER'.repeat(10000);
    expect(() => compactSubagentCard(hugeHeader, [{ kind: 'text', elementIds: ['text'] }], budget)).toThrow('minimum legal envelope');
  });

  it('does not apply lossy limits to the independent ordinary main-card planner', () => {
    const text = 'MAIN_CARD_FULL_TEXT_中文😀'.repeat(1200);
    const source = freeze(card([md(text, 'main')]));
    const plans = planFeishuCards(source, budget);
    expect(plans.length).toBeGreaterThan(1);
    expect(plans.flatMap((plan) => plan.slices).map((slice) => text.slice(slice.start, slice.end)).join('')).toBe(text);
    expect(source.body.elements[0].content).toBe(text);
  });

  it('bounds actual fit checks for randomized nested fixtures and leaves all inputs unchanged', () => {
    let seed = 0x4f12ab;
    const random = (max: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    const check = vi.spyOn(cardBudget, 'fitsFeishuCard');
    for (let fixture = 0; fixture < 100; fixture++) {
      const chunks: SubagentCardChunk[] = [];
      const elements: CardObject[] = [];
      const count = 2 + random(25);
      for (let index = 0; index < count; index++) {
        const id = `f${fixture}-${index}`;
        const kind = random(3);
        const length = 1 + random(250);
        if (kind === 0) {
          elements.push(panel(`wrapper-${id}`, [thought(id, '机密思考😀'.repeat(length))]));
          chunks.push({ kind: 'thinking', elementIds: [id] });
        } else if (kind === 1) {
          const entry = tool(id, ['bash', 'Read', 'my_tool😀'][random(3)], length);
          if (random(4) === 0) entry.chunk.status = random(2) ? 'failed' : 'interrupted';
          elements.push(panel(`wrapper-${id}`, entry.nodes));
          chunks.push(entry.chunk);
        } else {
          elements.push(panel(`wrapper-${id}`, [md('中文😀\\"\n| --- |\n'.repeat(length) + `END_${id}🚀`, id)]));
          chunks.push({ kind: 'text', elementIds: [id] });
        }
      }
      elements.push(md(`FINAL_${fixture}😀`, 'final'));
      chunks.push({ kind: 'text', elementIds: ['final'] });
      const source = freeze(card(elements));
      freeze(chunks);
      const before = JSON.stringify(source);
      const limits = { maxBytes: 650 + random(2200), maxElements: 2 + random(20), maxTables: 1 + random(4) };
      const start = check.mock.calls.length;
      const output = compactSubagentCard(source, chunks, limits);
      expect(check.mock.calls.length - start).toBeLessThan(chunks.length * 30 + 200);
      verify(output, source, limits);
      expect(visible(output)).toContain(`FINAL_${fixture}😀`);
      expect(JSON.stringify(source)).toBe(before);
    }
  }, 15000);
});
