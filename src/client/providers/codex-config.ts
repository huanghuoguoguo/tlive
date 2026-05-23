import type { CodexRuntimeOptions } from './codex-live-session.js';
import { createConfigValueReader, type ConfigValueReader } from '../../shared/config.js';

export interface CodexProviderConfig extends CodexRuntimeOptions {
  codexPath?: string;
}

export interface LoadCodexProviderConfigOptions {
  defaultModel?: string;
  get?: ConfigValueReader;
}

export function loadCodexProviderConfig(
  options: LoadCodexProviderConfigOptions = {},
): CodexProviderConfig {
  const get = options.get ?? createConfigValueReader();
  const model = get('TL_CODEX_MODEL', options.defaultModel ?? get('TL_DEFAULT_MODEL'));
  const codexPath = get('TL_CODEX_PATH');
  return {
    ...(model ? { model } : {}),
    ...(codexPath ? { codexPath } : {}),
    sandboxMode: normalizeCodexSandboxMode(get('TL_CODEX_SANDBOX_MODE', 'workspace-write')),
    approvalPolicy: normalizeCodexApprovalPolicy(get('TL_CODEX_APPROVAL_POLICY', 'on-request')),
    skipGitRepoCheck: get('TL_CODEX_SKIP_GIT_REPO_CHECK', 'false') === 'true',
    ...optional('modelReasoningEffort', normalizeCodexReasoningEffort(get('TL_CODEX_REASONING_EFFORT'))),
    ...optional('networkAccessEnabled', parseOptionalBoolean(get('TL_CODEX_NETWORK_ACCESS'))),
    ...optional('webSearchMode', normalizeCodexWebSearchMode(get('TL_CODEX_WEB_SEARCH'))),
  };
}

function optional<K extends keyof CodexProviderConfig>(
  key: K,
  value: CodexProviderConfig[K] | undefined,
): Pick<CodexProviderConfig, K> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Pick<CodexProviderConfig, K>;
}

function normalizeCodexSandboxMode(value: string | undefined): CodexRuntimeOptions['sandboxMode'] {
  if (value === 'read-only' || value === 'danger-full-access') return value;
  return 'workspace-write';
}

function normalizeCodexApprovalPolicy(
  value: string | undefined,
): CodexRuntimeOptions['approvalPolicy'] {
  if (value === 'never' || value === 'on-failure' || value === 'untrusted') return value;
  return 'on-request';
}

function normalizeCodexReasoningEffort(
  value: string | undefined,
): CodexRuntimeOptions['modelReasoningEffort'] {
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

function normalizeCodexWebSearchMode(value: string | undefined): CodexRuntimeOptions['webSearchMode'] {
  if (value === 'disabled' || value === 'cached' || value === 'live') return value;
  return undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value === 'true';
}
