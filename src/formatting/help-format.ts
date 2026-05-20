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

/** Compact help text used inside the /home help panel. */
export function formatCompactHelp(commands: readonly HelpCommandEntry[]): string {
  return groupHelpCommands(commands)
    .map(group => {
      const title = `**${group.category.icon} ${group.category.title}**`;
      const lines = group.commands.map(command => `/${command.cmd} - ${command.desc}`);
      return [title, ...lines].join('\n');
    })
    .join('\n\n');
}
