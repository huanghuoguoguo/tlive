import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expandTilde, getTliveHome } from './core/path.js';
import { normalizeQuickButtonNames, type QuickButtonName } from './ui/button-registry.js';
import { DEFAULT_AGENT_PROVIDER_KIND, type AgentProviderKind } from './providers/kinds.js';

export type AgentSettingSource = 'user' | 'project' | 'local';

/** Webhook default chat configuration */
export interface WebhookDefaultChat {
  /** Channel type. Only 'feishu' is supported. */
  channelType: string;
  /** Chat ID to route webhook messages to */
  chatId: string;
}

/** Project configuration for multi-repo support */
export interface ProjectConfig {
  /** Project name (unique identifier) */
  name: string;
  /** Default working directory */
  workdir: string;
  /** Provider settings sources for this project. */
  agentSettingSources?: AgentSettingSource[];
  /** Default chat for webhook routing (optional) */
  webhookDefaultChat?: WebhookDefaultChat;
}

export const DEFAULT_AGENT_SETTING_SOURCES: AgentSettingSource[] = ['user', 'project', 'local'];

export type ProviderKind = AgentProviderKind;
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type CodexWebSearchMode = 'disabled' | 'cached' | 'live';

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
  port: number;
  token: string;
  provider: ProviderKind;
  defaultWorkdir: string;
  defaultModel: string;
  /** Provider settings sources to load (default: ['user', 'project', 'local']) */
  agentSettingSources: AgentSettingSource[];
  codex: {
    model: string;
    codexPath: string;
    sandboxMode: CodexSandboxMode;
    approvalPolicy: CodexApprovalPolicy;
    skipGitRepoCheck: boolean;
    modelReasoningEffort?: CodexReasoningEffort;
    networkAccessEnabled?: boolean;
    webSearchMode?: CodexWebSearchMode;
  };
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
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey: string;
    webhookPort: number;
    allowedUsers: string[];
    /** Pin newly-created topic entry messages to the chat Pin list. */
    autoPinTopics: boolean;
  };
  /** UI configuration for generated cards */
  ui: {
    /** Buttons shown on completed/failed task cards and task summary cards. */
    doneButtons: QuickButtonName[];
  };
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

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '/webhook';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : withLeadingSlash;
}

function normalizeWebhookSessionStrategy(value: string | undefined): 'reject' | 'create' {
  return value === 'create' ? 'create' : 'reject';
}

function normalizeProvider(value: string | undefined): ProviderKind {
  return value === 'codex' ? 'codex' : DEFAULT_AGENT_PROVIDER_KIND;
}

function normalizeCodexSandboxMode(value: string | undefined): CodexSandboxMode {
  if (value === 'read-only' || value === 'danger-full-access') return value;
  return 'workspace-write';
}

function normalizeCodexApprovalPolicy(value: string | undefined): CodexApprovalPolicy {
  if (value === 'never' || value === 'on-failure' || value === 'untrusted') return value;
  return 'on-request';
}

function normalizeCodexReasoningEffort(
  value: string | undefined,
): CodexReasoningEffort | undefined {
  if (
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  ) {
    return value;
  }
  return undefined;
}

function normalizeCodexWebSearchMode(value: string | undefined): CodexWebSearchMode | undefined {
  if (value === 'disabled' || value === 'cached' || value === 'live') return value;
  return undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value === 'true';
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

export function loadConfig(): Config {
  // 1. Load env file
  const envFile = loadEnvFile(join(getTliveHome(), 'config.env'));

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

  const config: Config = {
    port,
    token: get('TL_TOKEN'),
    provider: normalizeProvider(get('TL_PROVIDER', DEFAULT_AGENT_PROVIDER_KIND)),
    agentSettingSources: parseList(
      get('TL_AGENT_SETTINGS', get('TL_CLAUDE_SETTINGS', DEFAULT_AGENT_SETTING_SOURCES.join(','))),
    ) as AgentSettingSource[],
    defaultWorkdir: get('TL_DEFAULT_WORKDIR', process.cwd()),
    defaultModel: get('TL_DEFAULT_MODEL'),
    codex: {
      model: get('TL_CODEX_MODEL', get('TL_DEFAULT_MODEL')),
      codexPath: get('TL_CODEX_PATH'),
      sandboxMode: normalizeCodexSandboxMode(get('TL_CODEX_SANDBOX_MODE', 'workspace-write')),
      approvalPolicy: normalizeCodexApprovalPolicy(get('TL_CODEX_APPROVAL_POLICY', 'on-request')),
      skipGitRepoCheck: get('TL_CODEX_SKIP_GIT_REPO_CHECK', 'false') === 'true',
      modelReasoningEffort: normalizeCodexReasoningEffort(get('TL_CODEX_REASONING_EFFORT')),
      networkAccessEnabled: parseOptionalBoolean(get('TL_CODEX_NETWORK_ACCESS')),
      webSearchMode: normalizeCodexWebSearchMode(get('TL_CODEX_WEB_SEARCH')),
    },
    webhook: {
      enabled: get('TL_WEBHOOK_ENABLED', 'false') === 'true',
      token: get('TL_WEBHOOK_TOKEN'),
      port: parseInt(get('TL_WEBHOOK_PORT', '8081'), 10),
      path: normalizeWebhookPath(get('TL_WEBHOOK_PATH', '/webhook')),
      sessionStrategy: normalizeWebhookSessionStrategy(
        get('TL_WEBHOOK_SESSION_STRATEGY', 'reject'),
      ),
      callbackUrl: get('TL_WEBHOOK_CALLBACK_URL') || undefined,
      rateLimitPerMinute: Math.max(
        0,
        Number.parseInt(get('TL_WEBHOOK_RATE_LIMIT_PER_MINUTE', '30'), 10) || 0,
      ),
    },
    exec: {
      // IMPORTANT: Exec is disabled by default and not implemented in Phase 3
      // This is a design placeholder for potential future implementation
      enabled: false, // Hard-coded false for Phase 3 — no env var override allowed
      allowedCommands: parseList(get('TL_EXEC_ALLOWED_COMMANDS', '')),
      timeout: parseInt(get('TL_EXEC_TIMEOUT', '30000'), 10),
      logExec: get('TL_EXEC_LOG', 'true') === 'true',
    },
    feishu: {
      appId: get('TL_FS_APP_ID'),
      appSecret: get('TL_FS_APP_SECRET'),
      verificationToken: get('TL_FS_VERIFICATION_TOKEN'),
      encryptKey: get('TL_FS_ENCRYPT_KEY'),
      webhookPort: parseInt(get('TL_FS_WEBHOOK_PORT', '9100'), 10),
      allowedUsers: parseList(get('TL_FS_ALLOWED_USERS')),
      autoPinTopics: get('TL_FS_AUTO_PIN_TOPIC', 'true') !== 'false',
    },
    ui: {
      doneButtons: normalizeQuickButtonNames(get('TL_DONE_BUTTONS', 'home')),
    },
  };

  // Validate required fields
  if (!config.token) {
    throw new Error('Config error: TL_TOKEN is required');
  }

  validateFeishuConfig(config);

  return config;
}
