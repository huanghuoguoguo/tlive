import type { CommandHandler } from './types.js';

const PUBLIC_TEXT_COMMANDS = new Set(['/tlive', '/home', '/stop']);

export function isPublicTextCommand(commandName: string): boolean {
  return PUBLIC_TEXT_COMMANDS.has(commandName.toLowerCase());
}

export function publicTextCommandName(text: string): string | undefined {
  const commandName = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return commandName && isPublicTextCommand(commandName) ? commandName : undefined;
}

export function publicQuickCommands(handlers: CommandHandler[]): Set<string> {
  return new Set(
    handlers
      .filter((handler) => handler.quick && isPublicTextCommand(handler.name))
      .map((handler) => handler.name.toLowerCase()),
  );
}
