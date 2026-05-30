export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface PiRuntimeOptions {
  agentDir?: string;
  sessionDir?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: PiThinkingLevel;
  noSession?: boolean;
  offline?: boolean;
}

export interface PiProviderConfig extends PiRuntimeOptions {}

export interface LoadPiProviderConfigOptions {
  defaultModel?: string;
  get?: (key: string, defaultValue?: string) => string;
}

export function loadPiProviderConfig(
  options: LoadPiProviderConfigOptions = {},
): PiProviderConfig {
  const get = options.get ?? ((key, fallback = '') => process.env[key] ?? fallback);
  return {
    ...optional('agentDir', get('TL_PI_AGENT_DIR')),
    ...optional('sessionDir', get('TL_PI_SESSION_DIR')),
    ...optional('provider', get('TL_PI_PROVIDER')),
    ...optional('model', get('TL_PI_MODEL', options.defaultModel ?? '')),
    ...optional('thinkingLevel', normalizePiThinkingLevel(get('TL_PI_THINKING'))),
    noSession: get('TL_PI_NO_SESSION', 'false') === 'true',
    offline: get('TL_PI_OFFLINE', 'false') === 'true',
  };
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
