import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import type { ProjectConfig, ClaudeSettingSource } from './store/interface.js';

export type { ClaudeSettingSource } from './store/interface.js';

export const DEFAULT_CLAUDE_SETTING_SOURCES: ClaudeSettingSource[] = ['user', 'project', 'local'];

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

/** Which Claude Code filesystem settings to load in bridge mode.
 *  - 'user'    → ~/.claude/settings.json (auth, model overrides)
 *  - 'project' → .claude/settings.json + CLAUDE.md (project rules, MCP, skills)
 *  - 'local'   → .claude/settings.local.json (developer overrides)
 *  Default: ['user', 'project', 'local'] — global config plus project context. */

export interface Config {
  port: number;
  token: string;
  enabledChannels: string[];
  defaultWorkdir: string;
  defaultModel: string;
  /** Claude Code settings sources to load (default: ['user', 'project', 'local']) */
  claudeSettingSources: ClaudeSettingSource[];
  /** Global proxy URL (e.g., http://127.0.0.1:7890, socks5://127.0.0.1:1080) */
  proxy: string;
  /** Webhook configuration for automation entry */
  webhook: {
    /** Enable webhook endpoint (default: false) */
    enabled: boolean;
    /** Token for webhook authentication (must match request Authorization: Bearer <token>) */
    token: string;
    /** Webhook listen port (default: 8081, separate from main port) */
    port: number;
    /** Webhook path (default: /webhook) */
    path: string;
    /** Session routing strategy when no active session exists:
     *  - 'reject': Return error if no session (default, safer)
     *  - 'create': Auto-create new session if none exists */
    sessionStrategy: 'reject' | 'create';
    /** Optional callback URL for webhook result notifications */
    callbackUrl?: string;
    /** Maximum accepted webhook requests per minute from the same source (0 disables) */
    rateLimitPerMinute: number;
  };
  /** Cron scheduler configuration for scheduled tasks (Phase 3) */
  cron: {
    /** Enable cron scheduler (default: false) */
    enabled: boolean;
    /** Default timezone for cron jobs (not implemented in Phase 3) */
    timezone?: string;
    /** Maximum concurrent job executions (default: 3) */
    maxConcurrency: number;
  };
  /** Exec configuration — LIMITED shell exec for automation (Phase 3 design only).
   *
   * SECURITY WARNING: Exec is disabled by default and should remain disabled
   * unless you have a specific need and understand the security implications.
   *
   * If enabled in future phases:
   * - Commands will be restricted to an explicit whitelist
   * - All executions will be logged with full detail
   * - Timeouts will be enforced
   * - Exec results will be delivered via IM for visibility
   */
  exec: {
    /** Enable exec capability (default: false, NOT IMPLEMENTED in Phase 3) */
    enabled: boolean;
    /** Command whitelist — only these commands can be executed (if enabled) */
    allowedCommands: string[];
    /** Execution timeout in milliseconds (default: 30000 = 30 seconds) */
    timeout: number;
    /** Log all exec commands to dedicated file */
    logExec: boolean;
  };
  telegram: {
    botToken: string;
    chatId: string;
    allowedUsers: string[];
    /** Require @mention in groups (default: true) */
    requireMention: boolean;
    /** Webhook URL (if set, uses webhook instead of polling) */
    webhookUrl: string;
    /** Webhook secret for verification */
    webhookSecret: string;
    /** Webhook listen port (default: 8443) */
    webhookPort: number;
    /** Disable link previews in outbound messages (default: true) */
    disableLinkPreview: boolean;
    /** HTTP/SOCKS proxy URL — overrides global TL_PROXY */
    proxy: string;
  };
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey: string;
    webhookPort: number;
    allowedUsers: string[];
  };
  qqbot: {
    appId: string;
    clientSecret: string;
    allowedUsers: string[];
    /** HTTP/SOCKS proxy URL — overrides global TL_PROXY */
    proxy: string;
  };
}

/** Validate a single project config */
function validateProjectConfig(project: ProjectConfig, index: number): { valid: boolean; name: string; reason?: string } {
  // Check name
  if (!project.name || typeof project.name !== 'string') {
    return { valid: false, name: `project-${index}`, reason: 'missing or invalid name' };
  }

  // Check workdir
  if (!project.workdir || typeof project.workdir !== 'string') {
    return { valid: false, name: project.name, reason: 'missing or invalid workdir' };
  }

  // Resolve workdir (handle ~ expansion)
  const resolvedWorkdir = project.workdir.startsWith('~')
    ? join(homedir(), project.workdir.slice(1))
    : resolve(project.workdir);

  // Check if workdir exists
  if (!existsSync(resolvedWorkdir)) {
    return { valid: false, name: project.name, reason: `workdir does not exist: ${resolvedWorkdir}` };
  }

  // Check if workdir is a directory
  try {
    const stats = statSync(resolvedWorkdir);
    if (!stats.isDirectory()) {
      return { valid: false, name: project.name, reason: `workdir is not a directory: ${resolvedWorkdir}` };
    }
  } catch {
    return { valid: false, name: project.name, reason: `cannot access workdir: ${resolvedWorkdir}` };
  }

  return { valid: true, name: project.name };
}

/** Load and validate projects configuration from projects.json (optional) */
export function loadProjectsConfig(): ProjectsValidationResult | undefined {
  const projectsPath = join(homedir(), '.tlive', 'projects.json');
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
          workdir: project.workdir.startsWith('~')
            ? join(homedir(), project.workdir.slice(1))
            : resolve(project.workdir),
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
    if (defaultProject && !valid.some(p => p.name === defaultProject)) {
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

/** Get project config by name */
export function getProjectByName(projects: ProjectConfig[], name: string): ProjectConfig | undefined {
  return projects.find(p => p.name === name);
}

/** Create implicit default project from config */
export function createImplicitProject(defaultWorkdir: string, claudeSettingSources: ClaudeSettingSource[]): ProjectConfig {
  return {
    name: basename(defaultWorkdir) || 'default',
    workdir: defaultWorkdir,
    claudeSettingSources,
  };
}

function parseList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '/webhook';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : withLeadingSlash;
}

function normalizeWebhookSessionStrategy(value: string | undefined): 'reject' | 'create' {
  return value === 'create' ? 'create' : 'reject';
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
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

export function maskSecret(value: string): string {
  if (!value || value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

export function loadConfig(): Config {
  // 1. Load env file
  const envFile = loadEnvFile(join(homedir(), '.tlive', 'config.env'));

  // 2. Inject non-TL_ vars into process.env so providers can access them
  //    (e.g. ANTHROPIC_API_KEY) — process.env takes precedence
  for (const [key, value] of Object.entries(envFile)) {
    if (!key.startsWith('TL_') && !(key in process.env)) {
      process.env[key] = value;
    }
  }

  // 3. Merge: env vars override env file
  const get = (key: string, defaultValue = ''): string =>
    process.env[key] ?? envFile[key] ?? defaultValue;

  const port = parseInt(get('TL_PORT', '8080'), 10);
  const globalProxy = get('TL_PROXY');

  const config: Config = {
    port,
    token: get('TL_TOKEN'),
    enabledChannels: parseList(get('TL_ENABLED_CHANNELS')),
    claudeSettingSources: parseList(
      get('TL_CLAUDE_SETTINGS', DEFAULT_CLAUDE_SETTING_SOURCES.join(',')),
    ) as ClaudeSettingSource[],
    proxy: globalProxy,
    defaultWorkdir: get('TL_DEFAULT_WORKDIR', process.cwd()),
    defaultModel: get('TL_DEFAULT_MODEL'),
    webhook: {
      enabled: get('TL_WEBHOOK_ENABLED', 'false') === 'true',
      token: get('TL_WEBHOOK_TOKEN'),
      port: parseInt(get('TL_WEBHOOK_PORT', '8081'), 10),
      path: normalizeWebhookPath(get('TL_WEBHOOK_PATH', '/webhook')),
      sessionStrategy: normalizeWebhookSessionStrategy(get('TL_WEBHOOK_SESSION_STRATEGY', 'reject')),
      callbackUrl: get('TL_WEBHOOK_CALLBACK_URL') || undefined,
      rateLimitPerMinute: Math.max(0, Number.parseInt(get('TL_WEBHOOK_RATE_LIMIT_PER_MINUTE', '30'), 10) || 0),
    },
    cron: {
      enabled: get('TL_CRON_ENABLED', 'false') === 'true',
      timezone: get('TL_CRON_TIMEZONE') || undefined,
      maxConcurrency: parsePositiveInt(get('TL_CRON_MAX_CONCURRENCY', '3'), 3),
    },
    exec: {
      // IMPORTANT: Exec is disabled by default and not implemented in Phase 3
      // This is a design placeholder for potential future implementation
      enabled: false, // Hard-coded false for Phase 3 — no env var override allowed
      allowedCommands: parseList(get('TL_EXEC_ALLOWED_COMMANDS', '')),
      timeout: parseInt(get('TL_EXEC_TIMEOUT', '30000'), 10),
      logExec: get('TL_EXEC_LOG', 'true') === 'true',
    },
    telegram: {
      botToken: get('TL_TG_BOT_TOKEN'),
      chatId: get('TL_TG_CHAT_ID'),
      allowedUsers: parseList(get('TL_TG_ALLOWED_USERS')),
      requireMention: get('TL_TG_REQUIRE_MENTION', 'true') !== 'false',
      webhookUrl: get('TL_TG_WEBHOOK_URL'),
      webhookSecret: get('TL_TG_WEBHOOK_SECRET'),
      webhookPort: parseInt(get('TL_TG_WEBHOOK_PORT', '8443'), 10),
      disableLinkPreview: get('TL_TG_DISABLE_LINK_PREVIEW', 'true') !== 'false',
      proxy: get('TL_TG_PROXY') || globalProxy,
    },
    feishu: {
      appId: get('TL_FS_APP_ID'),
      appSecret: get('TL_FS_APP_SECRET'),
      verificationToken: get('TL_FS_VERIFICATION_TOKEN'),
      encryptKey: get('TL_FS_ENCRYPT_KEY'),
      webhookPort: parseInt(get('TL_FS_WEBHOOK_PORT', '9100'), 10),
      allowedUsers: parseList(get('TL_FS_ALLOWED_USERS')),
    },
    qqbot: {
      appId: get('TL_QQ_APP_ID'),
      clientSecret: get('TL_QQ_CLIENT_SECRET'),
      allowedUsers: parseList(get('TL_QQ_ALLOWED_USERS')),
      proxy: get('TL_QQ_PROXY') || globalProxy,
    },
  };

  // Validate required fields
  if (!config.token) {
    throw new Error('Config error: TL_TOKEN is required');
  }

  for (const channel of config.enabledChannels) {
    switch (channel) {
      case 'telegram':
        if (!config.telegram.botToken) {
          throw new Error('Config error: TL_TG_BOT_TOKEN is required (telegram is in enabled channels)');
        }
        break;
      case 'feishu':
        if (!config.feishu.appId) {
          throw new Error('Config error: TL_FS_APP_ID is required (feishu is in enabled channels)');
        }
        if (!config.feishu.appSecret) {
          throw new Error('Config error: TL_FS_APP_SECRET is required (feishu is in enabled channels)');
        }
        break;
      case 'qqbot':
        if (!config.qqbot.appId) {
          throw new Error('Config error: TL_QQ_APP_ID is required (qqbot is in enabled channels)');
        }
        if (!config.qqbot.clientSecret) {
          throw new Error('Config error: TL_QQ_CLIENT_SECRET is required (qqbot is in enabled channels)');
        }
        break;
    }
  }

  return config;
}
