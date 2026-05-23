import type { HelpCategoryInfo, HelpCommandEntry } from './message-types.js';

export interface HelpCommandGroup {
  category: HelpCategoryInfo;
  commands: HelpCommandEntry[];
}

/** Group help commands by their command-owned category metadata. */
export function groupHelpCommands(commands: readonly HelpCommandEntry[]): HelpCommandGroup[] {
  const groups = new Map<string, HelpCommandGroup>();

  for (const command of commands) {
    const existing = groups.get(command.category.id);
    if (existing) {
      existing.commands.push(command);
      continue;
    }
    groups.set(command.category.id, {
      category: command.category,
      commands: [command],
    });
  }

  return [...groups.values()].sort((a, b) => a.category.order - b.category.order);
}
