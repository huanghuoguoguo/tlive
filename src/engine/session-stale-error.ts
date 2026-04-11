/**
 * Custom error indicating that the SDK session is stale and needs a fresh session.
 * This error triggers automatic retry with a new session in QueryOrchestrator.
 */
export class SessionStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStaleError';
  }
}

/**
 * Check if an error message indicates a stale session.
 */
export function isStaleSessionError(err: string): boolean {
  return err.includes('No conversation found')
    || err.includes('session ID')
    || (err.includes('Invalid') && err.includes('signature'));
}