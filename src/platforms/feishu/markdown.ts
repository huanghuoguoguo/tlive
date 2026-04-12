export function markdownToFeishu(text: string): string {
  let result = text;
  result = result.replace(/<b>(.*?)<\/b>/g, '**$1**');
  result = result.replace(/<i>(.*?)<\/i>/g, '*$1*');
  result = result.replace(/<s>(.*?)<\/s>/g, '~~$1~~');
  result = result.replace(/<code>(.*?)<\/code>/g, '`$1`');
  result = result.replace(/<a href="(.*?)">(.*?)<\/a>/g, '[$2]($1)');
  result = result.replace(/<pre>([\s\S]*?)<\/pre>/g, '```\n$1\n```');
  result = result.replace(/<\/?[^>]+>/g, '');
  return result;
}

/**
 * Downgrade markdown headings (## Title) to bold text (**Title**).
 * Feishu Card renders headings very large; bold is more appropriate for card content.
 * Ensures a blank line before each heading for proper spacing.
 */
export function downgradeHeadings(text: string): string {
  // Ensure blank line before heading lines (unless already blank or start of text)
  let result = text.replace(/([^\n])\n(#{1,6}\s)/g, '$1\n\n$2');
  // Convert headings to bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
  return result;
}

/** Maximum rows per table in Feishu card (platform limit ~10) */
const MAX_TABLE_ROWS = 10;

/**
 * Split large markdown tables into multiple smaller tables.
 * Feishu cards have a limit on table rows (~10). This function:
 * 1. Detects markdown tables in content
 * 2. Splits tables with more than MAX_TABLE_ROWS into multiple tables
 * 3. Adds a separator hint between split tables
 */
export function splitLargeTables(text: string): string {
  // Match markdown tables: header row + separator + data rows
  // Table pattern: | cell | cell | ... | followed by |---|---|...| and data rows
  const tableRegex = /^(\|.*\|)\n(\|[-:| ]+\|)\n((?:\|.*\|\n?)+)/gm;

  return text.replace(tableRegex, (match, headerRow, separatorRow, dataRows) => {
    // Parse data rows
    const rows = dataRows.trim().split('\n').filter((r: string) => r.trim().startsWith('|'));

    if (rows.length <= MAX_TABLE_ROWS) {
      // Table is within limit, keep as-is
      return match;
    }

    // Split into multiple tables
    const tables: string[] = [];
    const header = `${headerRow}\n${separatorRow}\n`;

    for (let i = 0; i < rows.length; i += MAX_TABLE_ROWS) {
      const chunk = rows.slice(i, i + MAX_TABLE_ROWS);
      const chunkIndex = Math.floor(i / MAX_TABLE_ROWS);
      const totalChunks = Math.ceil(rows.length / MAX_TABLE_ROWS);

      // First chunk keeps original header, subsequent chunks show continuation hint
      if (chunkIndex === 0) {
        tables.push(header + chunk.join('\n'));
      } else {
        // Add continuation hint as table note
        const hint = `**表格 ${chunkIndex + 1}/${totalChunks}**\n`;
        tables.push(hint + header + chunk.join('\n'));
      }
    }

    // Add separator between tables
    return tables.join('\n\n---\n\n');
  });
}