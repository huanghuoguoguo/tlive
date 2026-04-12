import { commandRegistry } from './registry.js';
import { StatusCommand } from './status.js';
import { StopCommand } from './stop.js';
import { HelpCommand } from './help.js';
import { BashCommand } from './bash.js';
import { PwdCommand } from './pwd.js';
import { HooksCommand } from './hooks.js';
import { PermCommand } from './perm.js';

/** Register all built-in commands */
export function registerAllCommands(): void {
  commandRegistry.register(new StatusCommand());
  commandRegistry.register(new StopCommand());
  commandRegistry.register(new HelpCommand());
  commandRegistry.register(new BashCommand());
  commandRegistry.register(new PwdCommand());
  commandRegistry.register(new HooksCommand());
  commandRegistry.register(new PermCommand());
  // TODO: Add remaining commands after migration
}

export { commandRegistry } from './registry.js';
export { CommandRegistry } from './registry.js';
export type { CommandHandler, CommandContext, HelpEntry } from './types.js';