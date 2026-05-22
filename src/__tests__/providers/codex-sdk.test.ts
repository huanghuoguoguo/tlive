import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toCodexReasoningEffort } from '../../providers/codex-sdk.js';
import { resolveCodexSessionOptions } from '../../providers/codex-live-session.js';

describe('CodexSDKProvider', () => {
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    process.env.CODEX_HOME = originalCodexHome;
  });

  it('maps canonical max effort to Codex xhigh', () => {
    expect(toCodexReasoningEffort('max')).toBe('xhigh');
    expect(toCodexReasoningEffort('high')).toBe('high');
    expect(toCodexReasoningEffort(undefined)).toBeUndefined();
  });

  it('resolves Codex model and effort from current session defaults when not explicit', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'tlive-codex-home-'));
    process.env.CODEX_HOME = codexHome;
    writeFileSync(
      join(codexHome, 'config.toml'),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n[projects]\n',
    );

    const resolved = resolveCodexSessionOptions({ workingDirectory: '/repo' });

    expect(resolved.model).toBe('gpt-5.5');
    expect(resolved.modelReasoningEffort).toBe('xhigh');
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('keeps explicit per-session Codex options above user defaults', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'tlive-codex-home-'));
    process.env.CODEX_HOME = codexHome;
    writeFileSync(
      join(codexHome, 'config.toml'),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n',
    );

    const resolved = resolveCodexSessionOptions({
      workingDirectory: '/repo',
      model: 'gpt-5.4',
      modelReasoningEffort: 'medium',
    });

    expect(resolved.model).toBe('gpt-5.4');
    expect(resolved.modelReasoningEffort).toBe('medium');
    rmSync(codexHome, { recursive: true, force: true });
  });
});
