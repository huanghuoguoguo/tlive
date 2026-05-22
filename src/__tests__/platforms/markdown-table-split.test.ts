import { describe, expect, it } from 'vitest';
import { splitLargeTables } from '../../channels/feishu/markdown.js';

function table(rowCount: number): string {
  const header = '| Name | Value |\n|---|---|\n';
  const rows = Array.from(
    { length: rowCount },
    (_, i) => `| Row${i + 1} | ${i + 1} |`,
  ).join('\n');
  return header + rows;
}

describe('splitLargeTables', () => {
  it('leaves non-table content and small tables untouched', () => {
    const small = table(3);
    expect(splitLargeTables('Just some regular text.')).toBe('Just some regular text.');
    expect(splitLargeTables(small)).toBe(small);
  });

  it('splits oversized tables into valid table chunks with repeated headers', () => {
    const result = splitLargeTables(table(25));
    const chunks = result
      .split('\n\n---\n\n')
      .map(c => c.replace(/^\*\*表格 \d+\/3\*\*\n/, ''));

    expect(result).toContain('表格 2/3');
    expect(result).toContain('表格 3/3');
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.startsWith('| Name | Value |\n|---|---|')).toBe(true);
    }
    expect(chunks[0].split('\n')).toHaveLength(12);
    expect(chunks[2].split('\n')).toHaveLength(7);
  });

  it('preserves surrounding text and only splits the large table in mixed content', () => {
    const smallTable = `| A | B |
|---|---|
| 1 | 2 |`;
    const input = `Before\n\n${smallTable}\n\nMiddle\n\n${table(12)}\n\nAfter`;

    const result = splitLargeTables(input);

    expect(result).toContain('Before');
    expect(result).toContain(smallTable);
    expect(result).toContain('Middle');
    expect(result).toContain('表格 2/2');
    expect(result).toContain('After');
  });
});
