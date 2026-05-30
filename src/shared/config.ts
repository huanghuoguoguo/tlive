import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expandTilde, getTliveHome } from './core/path.js';
import { normalizeQuickButtonNames, type QuickButtonName } from './ui/button-registry.js';
import { DEFAULT_AGENT_PROVIDER_KIND, type AgentProviderKind } from './providers/kinds.js';
import type { Locale } from './i18n/index.js';

export type AgentSettingSource = 'user' | 'project' | 'local';
export type ConfigProfile = 'server' | 'client';

/** Project configuration for multi-repo support */
export interface ProjectConfig {
  /** Project name (unique identifier) */
  name: string;
  /** Default working directory */
  workdir: string;
  /** Provider settings sources for this project. */
  agentSettingSources?: AgentSettingSource[];
}

export const DEFAULT_AGENT_SETTING_SOURCES: AgentSettingSource[] = ['user', 'project', 'local'];

export type ProviderKind = AgentProviderKind;
export type ConfigValueReader = (key: string, defaultValue?: string) => string;

/** Structure of projects.json configuration file */
export interface ProjectsFileConfig {
  /** Default project name (used when chat has no explicit binding) */
  defaultProject?: string;
  /** List of project configurations */
  projects: ProjectConfig[];
}

/** Validation result for projects config */
export interface ProjectsValidationResult {
  valid: ProjectConfig[];
  invalid: Array<{ name: string; reason: string }>;
  defaultProject: string;
}

export interface Config {
  token: string;
  provider: ProviderKind;
  /** Locale for i18n (default: 'zh') */
  locale: Locale;
  defaultWorkdir: string;
  defaultModel: string;
  /** Provider settings sources to load (default: ['user', 'project', 'local']) */
  agentSettingSources: AgentSettingSource[];
  /** HTTP MCP endpoint for agent-facing TLive tools. */
  mcp: {
    /** Enable HTTP MCP endpoint (default: true). */
    enabled: boolean;
    /** Listen port for the MCP endpoint. */
    port: number;
    /** Streamable HTTP MCP path (default: /mcp). */
    path: string;
    /** Bearer token for MCP clients. Defaults to TL_REMOTE_TOKEN/TL_TOKEN. */
    token: string;
    /** Maximum decoded file payload accepted by file tools. */
    maxFileSizeBytes: number;
  };
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey: string;
    allowedUsers: string[];
    /** Pin newly-created topic entry messages to the chat Pin list. */
    autoPinTopics: boolean;
  };
  /** UI configuration for generated cards */
  ui: {
    /** Buttons shown on completed/failed task cards and task summary cards. */
    doneButtons: QuickButtonName[];
  };
  /** Remote client/server split configuration. */
  remote: {
    server: {
      port: number;
      path: string;
      token: string;
      heartbeatIntervalMs: number;
      clientTimeoutMs: number;
    };
    client: {
      serverUrl: string;
      token: string;
      clientId: string;
      name: string;
      note: string;
      workspaces: string[];
      reconnectIntervalMs: number;
    };
  };
}

export interface LoadConfigOptions {
  /** Set false for tlive client workers, which do not need Feishu credentials. */
  validateBridge?: boolean;
  /** Which role-specific env file to read. */
  profile?: ConfigProfile;
}

/** Validate a single project config */
function validateProjectConfig(
  project: ProjectConfig,
  index: number,
): { valid: boolean; name: string; reason?: string } {
  // Check name
  if (!project.name || typeof project.name !== 'string') {
    return { valid: false, name: `project-${index}`, reason: 'missing or invalid name' };
  }

  // Check workdir
  if (!project.workdir || typeof project.workdir !== 'string') {
    return { valid: false, name: project.name, reason: 'missing or invalid workdir' };
  }

  // Resolve workdir (handle ~ expansion)
  const resolvedWorkdir = resolve(expandTilde(project.workdir));

  // Check if workdir exists
  if (!existsSync(resolvedWorkdir)) {
    return {
      valid: false,
      name: project.name,
      reason: `workdir does not exist: ${resolvedWorkdir}`,
    };
  }

  // Check if workdir is a directory
  try {
    const stats = statSync(resolvedWorkdir);
    if (!stats.isDirectory()) {
      return {
        valid: false,
        name: project.name,
        reason: `workdir is not a directory: ${resolvedWorkdir}`,
      };
    }
  } catch {
    return {
      valid: false,
      name: project.name,
      reason: `cannot access workdir: ${resolvedWorkdir}`,
    };
  }

  return { valid: true, name: project.name };
}

/** Validate required Feishu fields. */
function validateFeishuConfig(config: Config): void {
  if (!config.feishu.appId) {
    throw new Error('Config error: TL_FS_APP_ID is required');
  }
  if (!config.feishu.appSecret) {
    throw new Error('Config error: TL_FS_APP_SECRET is required');
  }
}

/** Load and validate projects configuration from projects.json (optional) */
export function loadProjectsConfig(): ProjectsValidationResult | undefined {
  const projectsPath = join(getTliveHome(), 'projects.json');
  try {
    const content = readFileSync(projectsPath, 'utf-8');
    const data: ProjectsFileConfig = JSON.parse(content);

    if (!Array.isArray(data.projects) || data.projects.length === 0) {
      return undefined;
    }

    // Validate each project
    const valid: ProjectConfig[] = [];
    const invalid: Array<{ name: string; reason: string }> = [];

    for (let i = 0; i < data.projects.length; i++) {
      const project = data.projects[i];
      const result = validateProjectConfig(project, i);
      if (result.valid) {
        // Resolve workdir path for valid projects
        valid.push({
          ...project,
          workdir: resolve(expandTilde(project.workdir)),
        });
      } else {
        invalid.push({ name: result.name, reason: result.reason || 'unknown' });
      }
    }

    // Determine default project
    let defaultProject = data.defaultProject || '';
    if (!defaultProject && valid.length > 0) {
      // Use first valid project as default
      defaultProject = valid[0].name;
    }

    // Verify default project exists in valid list
    if (defaultProject && !valid.some((p) => p.name === defaultProject)) {
      // Default project is invalid or missing, use first valid
      if (valid.length > 0) {
        defaultProject = valid[0].name;
      }
    }

    return { valid, invalid, defaultProject };
  } catch {
    // File doesn't exist or invalid JSON — single-project mode
  }
  return undefined;
}

function parseList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeHttpPath(path: string, defaultPath: string): string {
  const trimmed = path.trim();
  if (!trimmed) return defaultPath;
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : withLeadingSlash;
}

function normalizeLocale(value: string | undefined): Locale {
  return value === 'en' ? 'en' : 'zh';
}

function normalizeProvider(value: string | undefined): ProviderKind {
  return value === 'codex' || value === 'pi' ? value : DEFAULT_AGENT_PROVIDER_KIND;
}

function loadEnvFile(path: string): Record<string, string> {
  try {
    const content = readFileSync(path, 'utf-8');
    const env: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Remove surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function isServerConfigKey(key: string): boolean {
  return (
    key === 'TL_TOKEN' ||
    key === 'TL_LOCALE' ||
    key === 'TL_ENABLED_CHANNELS' ||
    key === 'TL_PORT' ||
    key === 'TL_DONE_BUTTONS' ||
    key === 'TL_LOCAL_CLIENT_DISABLED' ||
    key === 'TL_SERVER_STANDALONE' ||
    key === 'TL_REMOTE_TOKEN' ||
    key === 'TL_REMOTE_HEARTBEAT_MS' ||
    key === 'TL_REMOTE_CLIENT_TIMEOUT_MS' ||
    key === 'TL_DEBUG_EVENTS' ||
    key.startsWith('TL_FS_') ||
    key.startsWith('TL_MCP_') ||
    key.startsWith('TL_REMOTE_SERVER_') ||
    key.startsWith('TL_WEBHOOK_') ||
    key.startsWith('TL_COST_')
  );
}

function isClientConfigKey(key: string): boolean {
  return (
    key === 'TL_PROVIDER' ||
    key === 'TL_AGENT_SETTINGS' ||
    key === 'TL_DEFAULT_WORKDIR' ||
    key === 'TL_DEFAULT_MODEL' ||
    key === 'TL_REMOTE_TOKEN' ||
    key === 'TL_REMOTE_SERVER_URL' ||
    key === 'TL_REMOTE_RECONNECT_MS' ||
    key === 'TL_REMOTE_WORKSPACES' ||
    key === 'TL_CLAUDE_TMPDIR' ||
    key === 'TL_MCP_URL' ||
    key === 'TL_DEBUG_EVENTS' ||
    key.startsWith('TL_REMOTE_CLIENT_') ||
    key.startsWith('TL_CODEX_') ||
    key.startsWith('TL_PI_') ||
    key.startsWith('CTI_') ||
    key === 'HTTP_PROXY' ||
    key === 'HTTPS_PROXY' ||
    key === 'ALL_PROXY' ||
    key === 'NO_PROXY' ||
    !key.startsWith('TL_')
  );
}

function migratedEnvForProfile(
  profile: ConfigProfile,
  legacyEnv: Record<string, string>,
): Record<string, string> {
  const isKeyForProfile = profile === 'server' ? isServerConfigKey : isClientConfigKey;
  return Object.fromEntries(Object.entries(legacyEnv).filter(([key]) => isKeyForProfile(key)));
}

function serializeEnvFile(env: Record<string, string>, source: string): string {
  const lines = [
    `# Migrated from ${source}.`,
    '# Edit this role-specific file; runtime no longer reads config.env.',
  ];
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}

export function migrateLegacyConfigEnvFiles(tliveHome: string = getTliveHome()): void {
  const legacyPath = join(tliveHome, 'config.env');
  if (!existsSync(legacyPath)) return;

  const legacyEnv = loadEnvFile(legacyPath);
  for (const profile of ['server', 'client'] as const) {
    const targetPath = join(tliveHome, `${profile}.env`);
    if (existsSync(targetPath)) continue;
    const migratedEnv = migratedEnvForProfile(profile, legacyEnv);
    try {
      writeFileSync(targetPath, serializeEnvFile(migratedEnv, legacyPath), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      /* Another process may have created the file. */
    }
  }
}

export function loadConfigEnvFiles(profile: ConfigProfile): Record<string, string> {
  const tliveHome = getTliveHome();
  migrateLegacyConfigEnvFiles(tliveHome);
  return loadEnvFile(join(tliveHome, `${profile}.env`));
}

export function createConfigValueReader(profile: ConfigProfile = 'server'): ConfigValueReader {
  const envFile = loadConfigEnvFiles(profile);

  // Inject config into process.env for downstream helpers. The client also
  // exposes TL_* keys because provider SDK child processes read them directly;
  // the server keeps TL_* isolated to avoid leaking control-plane values into
  // client config when tests load both profiles in one process. Shell env wins.
  for (const [key, value] of Object.entries(envFile)) {
    const expose = profile === 'client' || !key.startsWith('TL_');
    if (expose && !(key in process.env)) {
      process.env[key] = value;
    }
  }

  return (key, defaultValue = ''): string => process.env[key] ?? envFile[key] ?? defaultValue;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const profile = options.profile ?? (options.validateBridge === false ? 'client' : 'server');
  const get = createConfigValueReader(profile);

  const remoteToken = get('TL_REMOTE_TOKEN', get('TL_TOKEN'));

  const config: Config = {
    token: get('TL_TOKEN'),
    provider: normalizeProvider(get('TL_PROVIDER', DEFAULT_AGENT_PROVIDER_KIND)),
    locale: normalizeLocale(get('TL_LOCALE')),
    agentSettingSources: parseList(
      get('TL_AGENT_SETTINGS', DEFAULT_AGENT_SETTING_SOURCES.join(',')),
    ) as AgentSettingSource[],
    defaultWorkdir: get('TL_DEFAULT_WORKDIR', process.cwd()),
    defaultModel: get('TL_DEFAULT_MODEL'),
    mcp: {
      enabled: get('TL_MCP_ENABLED', 'true') !== 'false',
      port: parseInt(get('TL_MCP_PORT', '8081'), 10),
      path: normalizeHttpPath(get('TL_MCP_PATH', '/mcp'), '/mcp'),
      token: get('TL_MCP_TOKEN', get('TL_REMOTE_TOKEN', get('TL_TOKEN'))),
      maxFileSizeBytes:
        Math.max(1, Number.parseInt(get('TL_MCP_MAX_FILE_MB', '20'), 10) || 20) * 1024 * 1024,
    },
    feishu: {
      appId: get('TL_FS_APP_ID'),
      appSecret: get('TL_FS_APP_SECRET'),
      verificationToken: get('TL_FS_VERIFICATION_TOKEN'),
      encryptKey: get('TL_FS_ENCRYPT_KEY'),
      allowedUsers: parseList(get('TL_FS_ALLOWED_USERS')),
      autoPinTopics: get('TL_FS_AUTO_PIN_TOPIC', 'true') !== 'false',
    },
    ui: {
      doneButtons: normalizeQuickButtonNames(get('TL_DONE_BUTTONS', 'home')),
    },
    remote: {
      server: {
        port: parseInt(get('TL_REMOTE_SERVER_PORT', '8787'), 10),
        path: normalizeHttpPath(get('TL_REMOTE_SERVER_PATH', '/tlive'), '/tlive'),
        token: remoteToken,
        heartbeatIntervalMs: Math.max(
          5_000,
          Number.parseInt(get('TL_REMOTE_HEARTBEAT_MS', '30000'), 10) || 30_000,
        ),
        clientTimeoutMs: Math.max(
          10_000,
          Number.parseInt(get('TL_REMOTE_CLIENT_TIMEOUT_MS', '90000'), 10) || 90_000,
        ),
      },
      client: {
        serverUrl: get('TL_REMOTE_SERVER_URL', 'ws://127.0.0.1:8787/tlive'),
        token: remoteToken,
        clientId: get('TL_REMOTE_CLIENT_ID'),
        name: get('TL_REMOTE_CLIENT_NAME'),
        note: get('TL_REMOTE_CLIENT_NOTE'),
        workspaces: parseList(get('TL_REMOTE_WORKSPACES')),
        reconnectIntervalMs: Math.max(
          500,
          Number.parseInt(get('TL_REMOTE_RECONNECT_MS', '3000'), 10) || 3000,
        ),
      },
    },
  };

  // Validate required fields
  if (options.validateBridge !== false && !config.token) {
    throw new Error('Config error: TL_TOKEN is required');
  }

  if (options.validateBridge !== false) {
    validateFeishuConfig(config);
  }

  return config;
}
