import { commandRegistry } from './registry.js';
import { StatusCommand } from './status.js';
import { StopCommand } from './stop.js';
import { HelpCommand } from './help.js';
import { BashCommand } from './bash.js';

/** Register all built-in commands */
export function registerAllCommands(): void {
  commandRegistry.register(new StatusCommand());
  commandRegistry.register(new StopCommand());
  commandRegistry.register(new HelpCommand());
  commandRegistry.register(new BashCommand());
  // More commands can be added here as they are migrated
}

export { commandRegistry } from './registry.js';
export { CommandRegistry } from './registry.js';
export type { CommandHandler, CommandContext, HelpEntry } from './types.js';