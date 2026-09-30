export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface PiRuntimeOptions {
  agentDir?: string;
  sessionDir?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: PiThinkingLevel;
  noSession?: boolean;
  offline?: boolean;
  /**
   * Share of the model context window to keep free so Pi compacts earlier than its
   * own `contextWindow - reserveTokens` line. 0 leaves Pi's settings.json in charge.
   */
  compactReservePercent?: number;
}

export interface PiProviderConfig extends PiRuntimeOptions {}

export interface LoadPiProviderConfigOptions {
  defaultModel?: string;
  get?: (key: string, defaultValue?: string) => string;
}

/** How much of the window to hold back by default, in percent. */
export const DEFAULT_PI_COMPACT_RESERVE_PERCENT = 20;
const MAX_PI_COMPACT_RESERVE_PERCENT = 50;

export function loadPiProviderConfig(options: LoadPiProviderConfigOptions = {}): PiProviderConfig {
  const get = options.get ?? ((key, fallback = '') => process.env[key] ?? fallback);
  return {
    ...optional('agentDir', get('TL_PI_AGENT_DIR')),
    ...optional('sessionDir', get('TL_PI_SESSION_DIR')),
    ...optional('provider', get('TL_PI_PROVIDER')),
    ...optional('model', get('TL_PI_MODEL', options.defaultModel ?? '')),
    ...optional('thinkingLevel', normalizePiThinkingLevel(get('TL_PI_THINKING'))),
    compactReservePercent: normalizePiCompactReservePercent(
      get('TL_PI_COMPACT_RESERVE_PERCENT', String(DEFAULT_PI_COMPACT_RESERVE_PERCENT)),
    ),
    noSession: get('TL_PI_NO_SESSION', 'false') === 'true',
    offline: get('TL_PI_OFFLINE', 'false') === 'true',
  };
}

/**
 * Parse `TL_PI_COMPACT_RESERVE_PERCENT`. Empty means "use the default", `0` (or
 * junk) disables the override and leaves the trigger at whatever
 * `~/.pi/agent/settings.json` asks for.
 */
export function normalizePiCompactReservePercent(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_PI_COMPACT_RESERVE_PERCENT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(MAX_PI_COMPACT_RESERVE_PERCENT, Math.round(parsed));
}

export function normalizePiThinkingLevel(value: string | undefined): PiThinkingLevel | undefined {
  return value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
    ? value
    : undefined;
}

function optional<K extends keyof PiProviderConfig>(
  key: K,
  value: PiProviderConfig[K] | undefined,
): Pick<PiProviderConfig, K> | Record<string, never> {
  return value === undefined || value === '' ? {} : ({ [key]: value } as Pick<PiProviderConfig, K>);
}
