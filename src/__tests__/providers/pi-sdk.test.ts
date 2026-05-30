import { describe, expect, it } from 'vitest';
import { loadPiProviderConfig, normalizePiThinkingLevel } from '../../client/providers/pi-config.js';
import { PiSDKProvider } from '../../client/providers/pi-sdk.js';
import { toPiThinkingLevel } from '../../client/providers/pi-live-session.js';

describe('PiSDKProvider', () => {
  it('marks Pi as an interactive runtime with native queueing', () => {
    const provider = new PiSDKProvider();

    expect(provider.kind).toBe('pi');
    expect(provider.capabilities.runtimeMode).toBe('interactive');
    expect(provider.capabilities.nativeSteer).toBe(true);
    expect(provider.capabilities.nativeQueue).toBe(true);
    expect(provider.capabilities.sessionResume).toBe(true);
  });

  it('maps canonical max effort to Pi xhigh thinking', () => {
    expect(toPiThinkingLevel('max')).toBe('xhigh');
    expect(toPiThinkingLevel('high')).toBe('high');
    expect(toPiThinkingLevel(undefined)).toBeUndefined();
  });

  it('loads Pi env options in the Pi provider boundary', () => {
    const values = new Map([
      ['TL_PI_AGENT_DIR', '/tmp/pi-agent'],
      ['TL_PI_SESSION_DIR', '/tmp/pi-sessions'],
      ['TL_PI_PROVIDER', 'anthropic'],
      ['TL_PI_MODEL', 'claude-sonnet-4-5'],
      ['TL_PI_THINKING', 'xhigh'],
      ['TL_PI_NO_SESSION', 'true'],
      ['TL_PI_OFFLINE', 'true'],
    ]);

    expect(loadPiProviderConfig({ get: (key, fallback = '') => values.get(key) ?? fallback }))
      .toEqual({
        agentDir: '/tmp/pi-agent',
        sessionDir: '/tmp/pi-sessions',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        thinkingLevel: 'xhigh',
        noSession: true,
        offline: true,
      });
  });

  it('normalizes known Pi thinking levels only', () => {
    expect(normalizePiThinkingLevel('off')).toBe('off');
    expect(normalizePiThinkingLevel('minimal')).toBe('minimal');
    expect(normalizePiThinkingLevel('max')).toBeUndefined();
  });
});
