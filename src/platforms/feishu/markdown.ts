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