import type { CommandHandler, HelpEntry } from './types.js';

/** Registry for command handlers - implements open-closed principle */
class CommandRegistry {
  private handlers = new Map<string, CommandHandler>();

  /** Register a command handler */
  register(handler: CommandHandler): void {
    this.handlers.set(handler.name.toLowerCase(), handler);
  }

  /** Get handler by command name */
  get(name: string): CommandHandler | undefined {
    return this.handlers.get(name.toLowerCase());
  }

  /** Check if command exists */
  has(name: string): boolean {
    return this.handlers.has(name.toLowerCase());
  }

  /** Get all registered handlers */
  getAll(): CommandHandler[] {
    return [...this.handlers.values()];
  }

  /** Get set of quick commands for BridgeManager */
  getQuickCommands(): Set<string> {
    return new Set(
      [...this.handlers.values()]
        .filter(h => h.quick)
        .map(h => h.name.toLowerCase()),
    );
  }

  /** Get help entries for /help output */
  getHelpEntries(): HelpEntry[] {
    return [...this.handlers.values()]
      .filter(h => h.description)
      .map(h => ({
        cmd: h.name.slice(1),
        desc: h.description!,
        detail: h.helpDesc,
        example: h.helpExample,
      }));
  }
}

/** Global registry instance */
export const commandRegistry = new CommandRegistry();