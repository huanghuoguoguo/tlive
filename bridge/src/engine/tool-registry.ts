const TOOL_ICONS: Record<string, string> = {
  Read: '📖', Edit: '✏️', Write: '📝',
  Bash: '🖥️', Grep: '🔍', Glob: '📂',
  Agent: '🤖', WebSearch: '🌐', WebFetch: '🌐',
};

/** Tools whose results are not shown in the terminal card */
const SILENT_RESULT_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Agent', 'WebSearch', 'WebFetch']);

/** Max lines of tool output to show in preview */
export const TOOL_RESULT_MAX_LINES = 3;

export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '🔧';
}

export function getToolTitle(name: string, input: Record<string, unknown>): string {
  if (!input || Object.keys(input).length === 0) return name;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write': {
      const file = str(input.file_path).split('/').pop();
      return file ? `${name}(${file})` : name;
    }
    case 'Grep': {
      const pattern = str(input.pattern);
      const path = str(input.path) || '.';
      return pattern ? `${name}("${pattern}" in ${path})` : name;
    }
    case 'Glob': {
      const pattern = str(input.pattern);
      return pattern ? `${name}(${pattern})` : name;
    }
    case 'Bash': {
      const cmd = str(input.command);
      if (!cmd) return name;
      const truncated = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
      return `${name}(${truncated})`;
    }
    case 'Agent': {
      const desc = str(input.description) || str(input.prompt)?.slice(0, 60);
      return desc ? `${name}(${desc})` : name;
    }
    default:
      return name;
  }
}

export function getToolCommand(name: string, input: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Read': case 'Edit': case 'Write':
      return str(input.file_path);
    case 'Grep':
      return `"${str(input.pattern)}" in ${str(input.path) || '.'}`;
    case 'Glob':
      return str(input.pattern);
    case 'Bash':
      return str(input.command);
    case 'Agent':
      return str(input.description) || str(input.prompt)?.slice(0, 60) || '';
    default:
      return '';
  }
}

export function getToolResultPreview(name: string, result: string, isError = false): string {
  if (isError) {
    const preview = result.length > 200 ? result.slice(0, 197) + '...' : result;
    return `❌ Error: ${preview}`;
  }
  if (!result || SILENT_RESULT_TOOLS.has(name)) return '';

  const lines = result.split('\n');
  if (lines.length <= TOOL_RESULT_MAX_LINES) return result;

  const shown = lines.slice(0, TOOL_RESULT_MAX_LINES).join('\n');
  return `${shown}\n… +${lines.length - TOOL_RESULT_MAX_LINES} lines`;
}
