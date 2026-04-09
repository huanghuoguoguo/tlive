import { describe, it, expect } from 'vitest';
import { FeishuFormatter } from '../formatting/feishu-formatter.js';
import type { ProgressData } from '../formatting/message-types.js';

function createProgressData(overrides: Partial<ProgressData> = {}): ProgressData {
  return {
    phase: 'completed',
    taskSummary: 'test task',
    elapsedSeconds: 5,
    renderedText: '',
    todoItems: [],
    totalTools: 0,
    ...overrides,
  };
}

/** Extract feishuElements from OutboundMessage */
function getElements(msg: ReturnType<FeishuFormatter['formatProgress']>): any[] {
  return (msg as any).feishuElements ?? [];
}

/** Extract feishuHeader from OutboundMessage */
function getHeader(msg: ReturnType<FeishuFormatter['formatProgress']>): any {
  return (msg as any).feishuHeader;
}

/** Find all elements with a given tag */
function findByTag(elements: any[], tag: string): any[] {
  return elements.filter(e => e.tag === tag);
}

describe('FeishuFormatter.formatProgress', () => {
  const formatter = new FeishuFormatter('zh');

  describe('completed phase — clean layout', () => {
    it('shows response text directly without task/phase/duration fields', () => {
      const msg = formatter.formatProgress('chat1', createProgressData({
        phase: 'completed',
        renderedText: 'Hello! How can I help?',
        footerLine: '[claude-sonnet] │ ~/workspace',
      }));

      const elements = getElements(msg);
      const markdowns = findByTag(elements, 'markdown');
      const allText = markdowns.map(e => e.content).join('\n');

      // Should contain the response text
      expect(allText).toContain('Hello! How can I help?');
      // Should contain footer
      expect(allText).toContain('~/workspace');
      // Should NOT contain verbose status fields
      expect(allText).not.toContain('**任务**');
      expect(allText).not.toContain('**当前阶段**');
      expect(allText).not.toContain('**运行时长**');
    });

    it('uses green header for completed', () => {
      const msg = formatter.formatProgress('chat1', createProgressData({ phase: 'completed' }));
      const header = getHeader(msg);
      expect(header.template).toBe('green');
      expect(header.title).toContain('已完成');
    });

    it('uses red header for failed', () => {
      const msg = formatter.formatProgress('chat1', createProgressData({ phase: 'failed' }));
      const header = getHeader(msg);
      expect(header.template).toBe('red');
    });
  });

  describe('executing phase — shows status info', () => {
    it('shows current tool and duration', () => {
      const msg = formatter.formatProgress('chat1', createProgressData({
        phase: 'executing',
        elapsedSeconds: 12,
        currentTool: { name: 'Bash', input: 'npm test', elapsed: 3 },
        totalTools: 2,
      }));

      const elements = getElements(msg);
      const allText = findByTag(elements, 'markdown').map(e => e.content).join('\n');
      expect(allText).toContain('Bash');
      expect(allText).toContain('npm test');
      expect(allText).toContain('12s');
    });
  });

  describe('collapsible_panel — correct structure per Feishu Card 2.0 docs', () => {
    it('thinking panel uses elements array (not body.elements)', () => {
      const msg = formatter.formatProgress('chat1', createProgressData({
        phase: 'completed',
        renderedText: 'Result text',
        thinkingText: 'Let me think about this...',
      }));

      const elements = getElements(msg);
      const panels = findByTag(elements, 'collapsible_panel');

      expect(panels.length).toBeGreaterThanOrEqual(1);
      const thinkingPanel = panels.find(p => p.header?.title?.content?.includes('思考'));
      expect(thinkingPanel).toBeDefined();

      // Correct: uses elements array directly
      expect(thinkingPanel.elements).toBeDefined();
      expect(Array.isArray(thinkingPanel.elements)).toBe(true);
      expect(thinkingPanel.elements[0].tag).toBe('markdown');
      expect(thinkingPanel.elements[0].content).toContain('Let me think');

      // Incorrect pattern must NOT be present
      expect(thinkingPanel.body).toBeUndefined();

      // Default collapsed
      expect(thinkingPanel.expanded).toBe(false);
    });

    it('tool logs panel uses elements array (not body.elements)', () => {
      const msg = formatter.formatProgress('chat1', createProgressData({
        phase: 'completed',
        renderedText: 'Done',
        toolLogs: [
          { name: 'Read', input: 'src/main.ts', result: 'file content...', isError: false },
          { name: 'Bash', input: 'npm test', result: '407 passed', isError: false },
        ],
      }));

      const elements = getElements(msg);
      const panels = findByTag(elements, 'collapsible_panel');
      const toolPanel = panels.find(p => p.header?.title?.content?.includes('工具'));

      expect(toolPanel).toBeDefined();
      // Correct structure
      expect(toolPanel.elements).toBeDefined();
      expect(Array.isArray(toolPanel.elements)).toBe(true);
      expect(toolPanel.body).toBeUndefined();

      // Content includes tool names
      const content = toolPanel.elements[0].content;
      expect(content).toContain('Read');
      expect(content).toContain('Bash');
      expect(content).toContain('npm test');

      // Header shows count
      expect(toolPanel.header.title.content).toContain('2');
    });

    it('no panels when no thinking or tool logs', () => {
      const msg = formatter.formatProgress('chat1', createProgressData({
        phase: 'completed',
        renderedText: 'Simple response',
      }));

      const elements = getElements(msg);
      const panels = findByTag(elements, 'collapsible_panel');
      expect(panels).toHaveLength(0);
    });

    it('skips thinking panel when thinkingText is empty/whitespace', () => {
      const msg = formatter.formatProgress('chat1', createProgressData({
        phase: 'completed',
        renderedText: 'Result',
        thinkingText: '   ',
      }));

      const elements = getElements(msg);
      const panels = findByTag(elements, 'collapsible_panel');
      expect(panels).toHaveLength(0);
    });
  });

  describe('todo progress', () => {
    it('renders todo items in both executing and completed phases', () => {
      for (const phase of ['executing', 'completed'] as const) {
        const msg = formatter.formatProgress('chat1', createProgressData({
          phase,
          renderedText: phase === 'completed' ? 'Done' : '',
          todoItems: [
            { content: 'Step 1', status: 'completed' },
            { content: 'Step 2', status: 'in_progress' },
            { content: 'Step 3', status: 'pending' },
          ],
        }));

        const elements = getElements(msg);
        const allText = findByTag(elements, 'markdown').map(e => e.content).join('\n');
        expect(allText).toContain('1/3');
        expect(allText).toContain('Step 1');
        expect(allText).toContain('Step 2');
      }
    });
  });
});
