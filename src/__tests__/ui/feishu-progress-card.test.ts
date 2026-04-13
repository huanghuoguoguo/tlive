import { describe, it, expect } from 'vitest';
import { FeishuFormatter } from '../../platforms/feishu/formatter.js';
import type { ProgressData } from '../../formatting/message-types.js';

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

describe('FeishuFormatter.formatQuestion', () => {
  const formatter = new FeishuFormatter('zh');

  /** Helper to extract form container elements */
  function getFormElements(msg: any): any[] {
    const elements = getElements(msg);
    const formContainer = elements.find(e => e.tag === 'form');
    return formContainer?.elements || [];
  }

  it('uses select_static for >4 options', () => {
    const msg = formatter.formatQuestion('chat1', {
      question: '选择一个选项',
      options: [
        { label: 'Option A' },
        { label: 'Option B' },
        { label: 'Option C' },
        { label: 'Option D' },
        { label: 'Option E' },
      ],
      multiSelect: false,
      permId: 'test-123',
      sessionId: 'sdk',
    });

    const formElements = getFormElements(msg as any);
    const selectStatic = formElements.find(e => e.tag === 'select_static');
    expect(selectStatic).toBeDefined();
    expect(selectStatic!.name).toBe('_select');
    expect(selectStatic!.options).toHaveLength(5);

    // Should have input for free text
    const input = formElements.find(e => e.tag === 'input' && e.name === '_text_answer');
    expect(input).toBeDefined();

    // Submit button with form_action_type: submit (embedded in column_set inside form)
    const columnSets = formElements.filter(e => e.tag === 'column_set');
    expect(columnSets.length).toBeGreaterThan(0);
    const submitBtn = columnSets[0]?.columns?.[0]?.elements?.[0];
    expect(submitBtn?.tag).toBe('button');
    expect(submitBtn?.form_action_type).toBe('submit');
    // permId comes from button name (derived from callbackData)
    expect(submitBtn?.name).toBe('test-123');
  });

  it('uses buttons for few options', () => {
    const msg = formatter.formatQuestion('chat1', {
      question: '同意吗？',
      options: [
        { label: 'Yes' },
        { label: 'No' },
      ],
      multiSelect: false,
      permId: 'test-456',
      sessionId: 'sdk',
    });

    const formElements = getFormElements(msg as any);
    const selectStatic = formElements.find(e => e.tag === 'select_static');
    expect(selectStatic).toBeUndefined();

    // Should have input for free text
    const input = formElements.find(e => e.tag === 'input' && e.name === '_text_answer');
    expect(input).toBeDefined();

    // Buttons inside column_set inside form - find any button with callback behavior
    const columnSets = formElements.filter(e => e.tag === 'column_set');
    expect(columnSets.length).toBeGreaterThan(0);

    // Find all buttons across all column_sets
    const allButtons: any[] = [];
    for (const cs of columnSets) {
      for (const col of cs.columns || []) {
        for (const el of col.elements || []) {
          if (el.tag === 'button') allButtons.push(el);
        }
      }
    }
    expect(allButtons.length).toBeGreaterThan(0);

    // At least one button should have callback behavior (option buttons)
    const callbackBtn = allButtons.find(b => b.behaviors?.[0]?.value?.action?.includes('askq'));
    expect(callbackBtn).toBeDefined();
  });

  it('permId is embedded in submit button name', () => {
    const msg = formatter.formatQuestion('chat1', {
      question: 'Test',
      options: [{ label: 'A' }],
      multiSelect: false,
      permId: 'perm-xyz',
      sessionId: 'sdk',
    });

    const formElements = getFormElements(msg as any);
    // No hidden input - permId comes from submit button
    const hiddenInput = formElements.find(e => e.tag === 'input' && e.name === '_interaction_id');
    expect(hiddenInput).toBeUndefined();

    // Find submit button and check its name contains permId
    const columnSets = formElements.filter(e => e.tag === 'column_set');
    for (const cs of columnSets) {
      for (const col of cs.columns || []) {
        for (const el of col.elements || []) {
          if (el.tag === 'button' && el.form_action_type === 'submit') {
            expect(el.name).toBe('perm-xyz');
            return;
          }
        }
      }
    }
  });

  it('uses form container for all components', () => {
    const msg = formatter.formatQuestion('chat1', {
      question: 'Test question',
      options: [{ label: 'A' }, { label: 'B' }],
      multiSelect: false,
      permId: 'test-789',
      sessionId: 'sdk',
    });

    const elements = getElements(msg as any);
    const formContainer = elements.find(e => e.tag === 'form');
    expect(formContainer).toBeDefined();
    expect(formContainer!.name).toContain('form_');
  });
});

describe('FeishuFormatter.formatProgress', () => {
  const formatter = new FeishuFormatter('zh');

  describe('completed phase — clean layout', () => {
    it('shows response text directly without task/phase/duration fields', () => {
      // In real flow, MessageRenderer.renderDone() includes footerLine in renderedText
      const msg = formatter.formatProgress('chat1', createProgressData({
        phase: 'completed',
        renderedText: 'Hello! How can I help?\n───────────────\n[claude-sonnet] │ ~/workspace',
        footerLine: '[claude-sonnet] │ ~/workspace',
      }));

      const elements = getElements(msg);
      const markdowns = findByTag(elements, 'markdown');
      const allText = markdowns.map(e => e.content).join('\n');

      // Should contain the response text
      expect(allText).toContain('Hello! How can I help?');
      // Should contain footer (now in renderedText, not added separately)
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

    it('shows tool output in an expanded panel while still executing', () => {
      const msg = formatter.formatProgress('chat1', createProgressData({
        phase: 'executing',
        elapsedSeconds: 6,
        totalTools: 1,
        timeline: [
          {
            kind: 'tool',
            toolName: 'Bash',
            toolInput: 'df -h / /mnt/c /mnt/d /mnt/e 2>/dev/null',
            toolResult: 'Filesystem  Size  Used  Avail',
          },
        ],
      }));

      const elements = getElements(msg);
      const panels = findByTag(elements, 'collapsible_panel');
      expect(panels).toHaveLength(1);
      expect(panels[0].expanded).toBe(true);
      expect(panels[0].header.title.content).toContain('Bash');
      expect(panels[0].elements[0].content).toContain('df -h');
      expect(panels[0].elements[0].content).toContain('Filesystem');
    });

    it('keeps the latest operation visible when earlier traces are long', () => {
      const longText = '早期步骤内容。'.repeat(220);
      const msg = formatter.formatProgress('chat1', createProgressData({
        phase: 'executing',
        totalTools: 3,
        timeline: [
          { kind: 'thinking', text: `步骤一：${longText}` },
          { kind: 'tool', toolName: 'Read', toolInput: 'src/a.ts', toolResult: 'ok' },
          { kind: 'thinking', text: `步骤二：${longText}` },
          { kind: 'tool', toolName: 'Read', toolInput: 'src/b.ts', toolResult: 'ok' },
          { kind: 'thinking', text: '步骤三：总结最新状态并继续修改。' },
          { kind: 'tool', toolName: 'Edit', toolInput: 'src/c.ts' },
        ],
      }));

      const panels = findByTag(getElements(msg), 'collapsible_panel');
      expect(panels.length).toBeGreaterThan(0);
      const latestPanel = panels[panels.length - 1];
      expect(latestPanel.expanded).toBe(true);
      expect(latestPanel.header.title.content).toContain('步骤三');
      expect(latestPanel.elements[0].content).toContain('src/c.ts');
    });
  });

  describe('collapsible_panel — correct structure per Feishu Card 2.0 docs', () => {
    it('groups one thinking step and its tools into a single operation panel', () => {
      const msg = formatter.formatProgress('chat1', createProgressData({
        phase: 'completed',
        renderedText: 'Final answer',
        timeline: [
          { kind: 'thinking', text: '评估当前改动内容。接着确认变更点。' },
          { kind: 'tool', toolName: 'Read', toolInput: 'src/main.ts', toolResult: 'ok' },
          { kind: 'text', text: 'intermediate text that should be skipped in completed mode' },
        ],
      }));

      const elements = getElements(msg);
      expect(elements[0].tag).toBe('collapsible_panel');
      expect(elements[0].header.title.content).toContain('评估当前改动内容');
      expect(elements[0].header.title.content).toContain('Read×1');
      expect(elements[0].elements[0].content).toContain('评估当前改动内容');
      expect(elements[0].elements[0].content).toContain('src/main.ts');
      expect(elements[1].tag).toBe('markdown');
      expect(elements[1].content).toContain('Final answer');
    });

    it('starts a new operation panel when a new thinking step appears after tools', () => {
      const msg = formatter.formatProgress('chat1', createProgressData({
        phase: 'completed',
        renderedText: 'Final answer\n───────────────\n🖥️ Bash ×2 (2 total)\n[glm-5] │ ~/workspace/tlive │ #ea22',
        toolSummary: '🖥️ Bash ×2 (2 total)',
        footerLine: '[glm-5] │ ~/workspace/tlive │ #ea22',
        timeline: [
          { kind: 'thinking', text: '用户想查看磁盘使用情况。' },
          { kind: 'tool', toolName: 'Bash', toolInput: 'df -h / /mnt/c /mnt/d /mnt/e 2>/dev/null' },
          { kind: 'tool', toolName: 'Bash', toolInput: 'df -h / /mnt/c /mnt/d /mnt/e 2>/dev/null', toolResult: 'Filesystem  Size  Used  Avail' },
          { kind: 'thinking', text: '显示磁盘使用情况表格。' },
        ],
      }));

      const elements = getElements(msg);
      const panels = findByTag(elements, 'collapsible_panel');
      expect(panels).toHaveLength(2);

      const firstPanel = panels[0];
      expect(firstPanel.header.title.content).toContain('用户想查看磁盘使用情况');
      expect(firstPanel.header.title.content).toContain('Bash×1');
      expect(firstPanel.elements[0].content).toContain('用户想查看磁盘使用情况。');
      expect(firstPanel.elements[0].content).toContain('Filesystem');

      const secondPanel = panels[1];
      expect(secondPanel.header.title.content).toContain('显示磁盘使用情况表格');
      expect(secondPanel.elements[0].content).toContain('显示磁盘使用情况表格。');

      const markdowns = findByTag(elements, 'markdown').map(e => e.content).join('\n');
      expect(markdowns).toContain('Final answer');
      expect(markdowns).not.toContain('🖥️ Bash ×2 (2 total)');
      expect(markdowns).toContain('~/workspace/tlive');
    });

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

    it('omits completed body when trace-only mode is enabled', () => {
      const msg = formatter.formatProgress('chat1', createProgressData({
        phase: 'completed',
        renderedText: 'Final answer\n───────────────\n[glm-5] │ ~/workspace/tlive │ #ea22',
        footerLine: '[glm-5] │ ~/workspace/tlive │ #ea22',
        completedTraceOnly: true,
        timeline: [
          { kind: 'thinking', text: 'Read files first' },
          { kind: 'tool', toolName: 'Read', toolInput: 'src/main.ts', toolResult: 'ok' },
        ],
      }));

      const elements = getElements(msg);
      const markdowns = findByTag(elements, 'markdown').map(e => e.content).join('\n');
      expect(markdowns).not.toContain('Final answer');
      expect(markdowns).not.toContain('~/workspace/tlive');
      expect(findByTag(elements, 'collapsible_panel')).toHaveLength(1);
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
