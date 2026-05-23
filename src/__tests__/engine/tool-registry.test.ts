import { describe, expect, it } from 'vitest';
import {
  getToolCommand,
  getToolIcon,
  getToolResultPreview,
  getToolTitle,
} from '../../server/engine/sdk/tool-registry.js';

describe('tool-registry', () => {
  it('formats representative tool icons, titles, and commands', () => {
    const cases = [
      ['Read', { file_path: '/home/user/project/src/main.ts' }, '📖', 'Read(main.ts)', '/home/user/project/src/main.ts'],
      ['Bash', { command: 'npm test' }, '🖥️', 'Bash(npm test)', 'npm test'],
      ['Grep', { pattern: 'TODO', path: 'src/' }, '🔍', 'Grep("TODO" in src/)', '"TODO" in src/'],
      ['Glob', { pattern: '**/*.ts' }, '📂', 'Glob(**/*.ts)', '**/*.ts'],
      ['Agent', { description: 'Explore codebase' }, '🤖', 'Agent(Explore codebase)', 'Explore codebase'],
      ['CustomTool', {}, '🔧', 'CustomTool', ''],
    ] as const;

    for (const [toolName, input, icon, title, command] of cases) {
      expect(getToolIcon(toolName)).toBe(icon);
      expect(getToolTitle(toolName, input)).toBe(title);
      expect(getToolCommand(toolName, input)).toBe(command);
    }
  });

  it('truncates long Bash titles without truncating the executable command', () => {
    const longCmd =
      'find . -name "*.ts" -type f -exec grep -l "pattern" {} \\; | sort | head -20';
    expect(getToolTitle('Bash', { command: longCmd }).length).toBeLessThanOrEqual(90);
    expect(getToolCommand('Bash', { command: longCmd })).toBe(longCmd);
  });

  it('formats result previews by user-visible relevance', () => {
    expect(getToolResultPreview('Read', 'file content here')).toBe('');
    expect(getToolResultPreview('Glob', 'file1.ts\nfile2.ts')).toBe('');
    expect(getToolResultPreview('Bash', 'OK')).toBe('OK');

    const longOutput = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(getToolResultPreview('Bash', longOutput)).toContain('+27 lines');
    expect(getToolResultPreview('Read', 'File not found', true)).toBe('❌ Error: File not found');
  });
});
