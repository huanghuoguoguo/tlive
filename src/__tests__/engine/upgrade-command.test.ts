import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

describe('UpgradeCommand', () => {
  let tmpDir: string;
  let cliPath: string;
  let packageRoot: string;
  let originalCliPath: string | undefined;
  let originalPackageRoot: string | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = mkdtempSync(join(tmpdir(), 'tlive-upgrade-command-'));
    packageRoot = join(tmpDir, 'app');
    cliPath = join(packageRoot, 'scripts', 'cli.js');
    mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
    writeFileSync(cliPath, '#!/usr/bin/env node\n');

    originalCliPath = process.env.TLIVE_CLI_PATH;
    originalPackageRoot = process.env.TLIVE_PACKAGE_ROOT;
    process.env.TLIVE_CLI_PATH = cliPath;
    process.env.TLIVE_PACKAGE_ROOT = packageRoot;

    spawnMock.mockReset();
    spawnMock.mockReturnValue({ unref: vi.fn() });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => code as never));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    exitSpy.mockRestore();
    process.env.TLIVE_CLI_PATH = originalCliPath;
    process.env.TLIVE_PACKAGE_ROOT = originalPackageRoot;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses confirm callback versions and spawns the CLI upgrader', async () => {
    const { UpgradeCommand, parseRequestedUpgradeVersion } = await import('../../engine/commands/upgrade.js');
    const send = vi.fn().mockResolvedValue(undefined);
    const command = new UpgradeCommand();

    expect(parseRequestedUpgradeVersion(['/upgrade', 'confirm:v0.13.2'])).toBe('0.13.2');
    expect(parseRequestedUpgradeVersion(['/upgrade', 'confirm', 'v0.13.3'])).toBe('0.13.3');

    await command.execute({
      adapter: { send, sendFormatted: vi.fn() },
      msg: { chatId: 'chat-1' },
      parts: ['/upgrade', 'confirm:v0.13.2'],
    } as any);

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [cliPath, 'upgrade', '0.13.2'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({
          TLIVE_UPGRADE_PARENT_PID: String(process.pid),
        }),
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('v0.13.2') }),
    );

    vi.runAllTimers();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('refuses in-place auto-upgrade when running from a git checkout', async () => {
    const { UpgradeCommand } = await import('../../engine/commands/upgrade.js');
    const sendFormatted = vi.fn().mockResolvedValue(undefined);
    const command = new UpgradeCommand();

    mkdirSync(join(packageRoot, '.git'));

    await command.execute({
      adapter: { send: vi.fn(), sendFormatted },
      msg: { chatId: 'chat-1' },
      parts: ['/upgrade', 'confirm'],
    } as any);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(sendFormatted).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: '❌ Upgrade Failed',
        }),
      }),
    );
  });
});
