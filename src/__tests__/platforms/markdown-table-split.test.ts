import { describe, it, expect } from 'vitest';
import { splitLargeTables } from '../../channels/feishu/markdown.js';

describe('splitLargeTables', () => {
  it('should keep small tables unchanged', () => {
    const input = `| Name | Value |
|---|---|
| A | 1 |
| B | 2 |
| C | 3 |`;

    expect(splitLargeTables(input)).toBe(input);
  });

  it('should split tables with more than 10 rows', () => {
    const header = '| Name | Value |\n|---|---|\n';
    const rows = Array.from({ length: 15 }, (_, i) => `| Row${i + 1} | ${i + 1} |`).join('\n');
    const input = header + rows;

    const result = splitLargeTables(input);

    // Should have split into 2 tables
    expect(result).toContain('---');
    expect(result).toContain('表格 2/2');
  });

  it('should split tables with 25 rows into 3 tables', () => {
    const header = '| Name | Value |\n|---|---|\n';
    const rows = Array.from({ length: 25 }, (_, i) => `| Row${i + 1} | ${i + 1} |`).join('\n');
    const input = header + rows;

    const result = splitLargeTables(input);

    // Should have split into 3 tables (10 + 10 + 5)
    expect(result).toContain('表格 2/3');
    expect(result).toContain('表格 3/3');
  });

  it('should handle multiple tables in content', () => {
    const smallTable = `| A | B |
|---|---|
| 1 | 2 |`;

    const largeTableHeader = '| Name | Value |\n|---|---|\n';
    const largeTableRows = Array.from({ length: 12 }, (_, i) => `| X${i} | ${i} |`).join('\n');
    const largeTable = largeTableHeader + largeTableRows;

    const input = `Some text before.\n\n${smallTable}\n\nMore text.\n\n${largeTable}`;

    const result = splitLargeTables(input);

    // Small table should remain unchanged
    expect(result).toContain('| A | B |');
    // Large table should be split
    expect(result).toContain('表格 2/2');
  });

  it('should preserve first table header without hint', () => {
    const header = '| Col1 | Col2 |\n|---|---|\n';
    const rows = Array.from({ length: 15 }, (_, i) => `| A${i} | B${i} |`).join('\n');
    const input = header + rows;

    const result = splitLargeTables(input);

    // First table chunk should NOT have the hint prefix
    const firstChunkStart = result.indexOf('| Col1 | Col2 |');
    expect(firstChunkStart).toBe(0);
  });

  it('should handle text without tables', () => {
    const input = 'Just some regular text without any tables.';
    expect(splitLargeTables(input)).toBe(input);
  });
});