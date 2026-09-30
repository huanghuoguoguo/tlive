/** Machine-readable reasons a provider refuses an injected message. */
export type InjectionErrorCode = 'no_active_turn' | 'command_blocked';

/**
 * Thrown when a worker goes silent on a control call. The message was already
 * delivered to the worker, so callers report "not acknowledged" rather than
 * "failed" — a provider settling a long upstream retry still acts on it.
 */
export class ControlTimeoutError extends Error {
  readonly code = 'control_timeout';

  constructor(readonly action: string) {
    super(`Remote control timed out: ${action}`);
    this.name = 'ControlTimeoutError';
  }
}

/**
 * Thrown when a message is injected into a provider that has no turn to receive
 * it. Providers like pi enqueue unconditionally and resolve happily, so without
 * this signal the bridge reports "inserted" while the message is stranded.
 */
export class NoActiveTurnError extends Error {
  readonly code = 'no_active_turn';

  constructor(message = 'Provider has no active turn to inject into') {
    super(message);
    this.name = 'NoActiveTurnError';
  }
}

/** Thrown when the provider is mid-turn but cannot accept this particular text. */
export class CommandBlockedError extends Error {
  readonly code = 'command_blocked';

  constructor(readonly command?: string) {
    super(
      command
        ? `/${command} cannot be injected while a turn is running`
        : 'This command cannot be injected while a turn is running',
    );
    this.name = 'CommandBlockedError';
  }
}

export function injectionErrorCode(err: unknown): InjectionErrorCode | undefined {
  return err instanceof NoActiveTurnError || err instanceof CommandBlockedError
    ? err.code
    : undefined;
}
