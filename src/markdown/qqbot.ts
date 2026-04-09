import { truncateLongCodeBlocks } from './ir.js';

/**
 * Convert markdown to QQ Bot compatible format.
 * QQ Bot supports markdown format (msg_type: 2) with some limitations.
 * - Code blocks work but should be truncated for long content
 * - Tables are converted to preformatted text
 * - Links are preserved
 */
export function markdownToQQBot(text: string): string {
  // Truncate long code blocks
  text = truncateLongCodeBlocks(text, 30);

  // Convert tables to plain text representation
  // Match markdown tables and convert them to code blocks
  text = text.replace(/^\|.*\|\n^\|[-:| ]+\|\n(\|.*\|\n)+/gm, (table) => {
    const lines = table.trim().split('\n');
    const rows = lines.map(line =>
      line.split('|')
        .filter(cell => cell.trim())
        .map(cell => cell.trim())
    );
    // Skip separator line (index 1)
    const dataRows = rows.filter((_, i) => i !== 1);
    if (dataRows.length === 0) return '';

    // Calculate column widths
    const colCount = Math.max(...dataRows.map(r => r.length));
    const widths: number[] = Array(colCount).fill(0);
    for (const row of dataRows) {
      for (let i = 0; i < row.length; i++) {
        widths[i] = Math.max(widths[i], row[i].length);
      }
    }

    // Format as code block
    const formatted = dataRows.map(row =>
      row.map((cell, i) => cell.padEnd(widths[i])).join(' | ')
    ).join('\n');
    return '```\n' + formatted + '\n```';
  });

  return text.trim();
}