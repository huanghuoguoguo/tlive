import { describe, expect, it } from 'vitest';
import { SessionStaleError, isStaleSessionError } from '../engine/session-stale-error.js';

describe('SessionStaleError', () => {
  it('creates error with correct name', () => {
    const err = new SessionStaleError('test message');
    expect(err.name).toBe('SessionStaleError');
    expect(err.message).toBe('test message');
    expect(err instanceof Error).toBe(true);
  });

  describe('isStaleSessionError', () => {
    it('detects "No conversation found" error', () => {
      expect(isStaleSessionError('No conversation found for session')).toBe(true);
    });

    it('detects "session ID" error', () => {
      expect(isStaleSessionError('Invalid session ID')).toBe(true);
    });

    it('detects "Invalid signature" error', () => {
      expect(isStaleSessionError('Invalid request signature')).toBe(true);
    });

    it('returns false for other errors', () => {
      expect(isStaleSessionError('Network timeout')).toBe(false);
      expect(isStaleSessionError('Rate limited')).toBe(false);
      expect(isStaleSessionError('Internal server error')).toBe(false);
    });
  });
});