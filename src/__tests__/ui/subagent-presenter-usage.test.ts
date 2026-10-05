import { describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../../server/channels/base.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import { SubagentFlowPresenter } from '../../server/presentation/subagent-presenter.js';
import type { StepUsage, SubagentSnapshot } from '../../shared/canonical/schema.js';
import type { FormattableMessage, ProgressData } from '../../shared/formatting/message-types.js';

function snapshot(usage?: StepUsage): SubagentSnapshot {
  return {
    kind: 'subagent_snapshot', parentToolUseId: 'parent-tool', childId: 'child',
    agentName: 'worker', task: 'Read two files', status: 'completed',
    timeline: ['a', 'b'].map((id) => ({
      kind: 'tool', blockId: `block-${id}`, toolId: id, toolName: 'read',
      toolInput: `/${id}`, toolResult: 'done', status: 'completed',
      ...(usage ? { usage: { ...usage } } : {}),
    })),
  };
}

function fixture(cwd?: string) {
  const formatter = new FeishuFormatter('zh');
  const data: ProgressData[] = [];
  const adapter = {
    getLocale: () => 'zh' as const,
    format: vi.fn((message: FormattableMessage) => {
      if (message.type !== 'progress') throw new Error('Expected progress');
      data.push(message.data);
      return formatter.format(message);
    }),
    send: vi.fn(async () => ({ success: true, messageId: 'child-card' })),
  };
  const presenter = new SubagentFlowPresenter({
    adapter: adapter as unknown as BaseChannelAdapter,
    parentTurnId: 'parent-turn', model: 'PARENT_MODEL_MUST_NOT_APPEAR', cwd,
    inbound: {
      channelType: 'feishu', chatId: 'chat', messageId: 'parent-message',
      userId: 'owner', text: 'fixture',
    },
  });
  return { presenter, adapter, data };
}

describe('Subagent presenter usage ownership', () => {
  it('passes child usage through the structured timeline and renders the main-card suffix once per step', async () => {
    const f = fixture('/tmp/child-work');
    const usage = { step: 1, inputTokens: 140, outputTokens: 20, contextTokens: 460, contextWindow: 1000 };
    const source = snapshot(usage);
    const original = structuredClone(source);
    try {
      f.presenter.update(source);
      await f.presenter.finish();
      const rendered = JSON.stringify(f.adapter.format.mock.results[0].value);
      expect(f.data[0].timeline?.map((entry) => entry.usage)).toEqual([usage, usage]);
      expect(rendered).toContain('↓140 ↑20 460 46%');
      expect(rendered).not.toContain('↓280');
      expect(rendered).not.toContain('PARENT_MODEL_MUST_NOT_APPEAR');
      expect(f.data[0].footerLine).toContain('child-work');
      expect(f.data[0].contextUsage).toBeUndefined();
      expect(source).toEqual(original);
      source.timeline[0].usage!.inputTokens = 999;
      expect(f.data[0].timeline?.[0].usage?.inputTokens).toBe(140);
    } finally {
      await f.presenter.dispose();
    }
  });

  it('omits the model-only footer, invented usage and context percentages when child metadata is absent', async () => {
    const f = fixture();
    try {
      f.presenter.update(snapshot());
      await f.presenter.finish();
      const rendered = JSON.stringify(f.adapter.format.mock.results[0].value);
      expect(f.data[0].footerLine).toBeUndefined();
      expect(f.data[0].timeline?.every((entry) => entry.usage === undefined)).toBe(true);
      expect(rendered).not.toContain('PARENT_MODEL_MUST_NOT_APPEAR');
      expect(rendered).not.toMatch(/↓\d|↑\d|\d%/u);
    } finally {
      await f.presenter.dispose();
    }
  });

  it('renders token counts without a percentage when only the child window is unknown', async () => {
    const f = fixture();
    try {
      f.presenter.update(snapshot({ step: 1, inputTokens: 140, outputTokens: 20, contextTokens: 460 }));
      await f.presenter.finish();
      const rendered = JSON.stringify(f.adapter.format.mock.results[0].value);
      expect(rendered).toContain('↓140 ↑20 460');
      expect(rendered).not.toMatch(/\d%/u);
    } finally {
      await f.presenter.dispose();
    }
  });
});
