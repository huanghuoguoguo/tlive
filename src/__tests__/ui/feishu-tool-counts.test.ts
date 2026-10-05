import { describe, expect, it } from 'vitest';
import { compactSubagentCard, type SubagentCardChunk } from '../../server/channels/feishu/subagent-budget.js';
import { fitsFeishuCard, type CardObject } from '../../server/channels/feishu/card-budget.js';
const limits = { maxBytes: 2000, maxElements: 30, maxTables: 4 };
function fixture(names: string[], statuses: string[] = []) {
  const chunks: SubagentCardChunk[] = names.map((toolName, i) => ({ kind: 'tool', elementIds: [`tool-${i}`], toolName, status: statuses[i] ?? 'completed' }));
  const card: CardObject = { schema: '2.0', header: { template: 'blue', title: { tag: 'plain_text', content: 'fixture' } }, body: { elements: names.map((name, i) => ({ tag: 'markdown', element_id: `tool-${i}`, content: `${name} ${'old argument and result '.repeat(250)}` })) } };
  return { card, chunks };
}
const visible = (card: CardObject): string => JSON.stringify(card).replace(/\\\\([*_])/g, '$1');
describe('compact tool-name counters', () => {
  it('combines same names within a simplified region and preserves failure/interruption/running counts', () => {
    const { card, chunks } = fixture(['search', 'read', 'search', 'search', 'search', 'search'], ['completed', 'completed', 'failed', 'interrupted', 'running', 'completed']);
    const original = JSON.stringify(card);
    const output = compactSubagentCard(card, chunks, limits);
    expect(fitsFeishuCard(output, limits)).toBe(true);
    expect(visible(output)).toContain('search ×5 · ❌失败1 · ⏹中断1 · ⏳执行中1');
    expect(visible(output)).toContain('read');
    expect(JSON.stringify(output)).not.toContain('old argument');
    expect(JSON.stringify(card)).toBe(original);
  });
  it('does not combine across retained text or reinterpret a name ending in x2', () => {
    const { card, chunks } = fixture(['searchx2', 'searchx2']);
    card.body.elements.splice(1, 0, { tag: 'markdown', element_id: 'gap', content: 'KEEP_GAP' });
    // A retained display separator is not part of the compactable semantic chunks.
    const output = compactSubagentCard(card, chunks, limits);
    expect(visible(output)).toContain('KEEP_GAP');
    expect(visible(output)).not.toContain('searchx2 ×2');
    expect(fitsFeishuCard(output, limits)).toBe(true);
  });
  it('does not simplify or count tools when the original card already fits', () => {
    const { card, chunks } = fixture(['search', 'search']);
    for (const node of card.body.elements) node.content = 'full visible call';
    expect(compactSubagentCard(card, chunks, limits)).toEqual(card);
  });
});
