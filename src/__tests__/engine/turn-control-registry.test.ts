import { describe, expect, it, vi } from 'vitest';
import { TurnControlRegistry } from '../../server/engine/sdk/turn-control-registry.js';

const controls = () => ({ interrupt: vi.fn(), stopTask: vi.fn() });

describe('turn control ownership', () => {
  it('does not remove replacement controls when an old turn finishes', () => {
    const registry = new TurnControlRegistry();
    const first = controls();
    const second = controls();
    registry.setControlsForChat('chat', first, 'session');
    registry.setControlsForChat('chat', second, 'session');
    registry.setControlsForChat('chat', undefined, 'session', { expectedControls: first });
    expect(registry.getControlsForSession('session')).toBe(second);
    expect(registry.getControlsForChat('chat')).toBe(second);
    registry.setControlsForChat('chat', undefined, 'session', { expectedControls: second });
    expect(registry.getControlsForSession('session')).toBeUndefined();
    expect(registry.getControlsForChat('chat')).toBeUndefined();
  });

  it('keeps chat controls belonging to a different active session', () => {
    const registry = new TurnControlRegistry();
    const first = controls();
    const second = controls();
    registry.setControlsForChat('chat', first, 'first-session');
    registry.setControlsForChat('chat', second, 'second-session');
    registry.cleanupSessionControls('first-session', { expectedControls: first });
    expect(registry.getControlsForSession('first-session')).toBeUndefined();
    expect(registry.getControlsForChat('chat')).toBe(second);
  });
});
