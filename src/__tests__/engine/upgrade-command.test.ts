import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../../utils/version-checker.js', () => ({
  checkForUpdates: vi.fn(),
}));

describe('UpgradeCommand', () => {
  let tmpDir: string;
  let cliPath: string;
  let packageRoot: string;
  let originalCliPath: string | undefined;
  let originalPackageRoot: string | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let checkForUpdatesMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
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

    const mod = await import('../../utils/version-checker.js');
    checkForUpdatesMock = mod.checkForUpdates as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.useRealTimers();
    exitSpy.mockRestore();
    process.env.TLIVE_CLI_PATH = originalCliPath;
    process.env.TLIVE_PACKAGE_ROOT = originalPackageRoot;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows update notes link for /upgrade notes', async () => {
    const { UpgradeCommand } = await import('../../engine/commands/upgrade.js');
    const send = vi.fn().mockResolvedValue(undefined);
    const command = new UpgradeCommand();

    await command.execute({
      adapter: { send },
      msg: { chatId: 'chat-1' },
      parts: ['/upgrade', 'notes'],
    } as any);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('github.com') }),
    );
  });

  it('shows already latest when no update available', async () => {
    checkForUpdatesMock.mockResolvedValue({ hasUpdate: false, current: '0.13.4', latest: '0.13.4' });

    const { UpgradeCommand } = await import('../../engine/commands/upgrade.js');
    const send = vi.fn().mockResolvedValue(undefined);
    const command = new UpgradeCommand();

    await command.execute({
      adapter: { send },
      msg: { chatId: 'chat-1' },
      parts: ['/upgrade'],
    } as any);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('已是最新版本') }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns upgrade process directly when update available', async () => {
    checkForUpdatesMock.mockResolvedValue({ hasUpdate: true, current: '0.13.3', latest: '0.13.4' });

    const { UpgradeCommand } = await import('../../engine/commands/upgrade.js');
    const send = vi.fn().mockResolvedValue(undefined);
    const command = new UpgradeCommand();

    await command.execute({
      adapter: { send },
      msg: { chatId: 'chat-1' },
      parts: ['/upgrade'],
    } as any);

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [cliPath, 'upgrade'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({
          TLIVE_UPGRADE_PARENT_PID: String(process.pid),
        }),
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('0.13.3') }),
    );

    vi.runAllTimers();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('refuses upgrade when running from git checkout', async () => {
    checkForUpdatesMock.mockResolvedValue({ hasUpdate: true, current: '0.13.3', latest: '0.13.4' });

    const { UpgradeCommand } = await import('../../engine/commands/upgrade.js');
    const send = vi.fn().mockResolvedValue(undefined);
    const command = new UpgradeCommand();

    // Create .git directory to simulate git checkout
    mkdirSync(join(packageRoot, '.git'));

    await command.execute({
      adapter: { send },
      msg: { chatId: 'chat-1' },
      parts: ['/upgrade'],
    } as any);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('git') }),
    );
  });

  it('handles check failure gracefully', async () => {
    checkForUpdatesMock.mockResolvedValue(null);

    const { UpgradeCommand } = await import('../../engine/commands/upgrade.js');
    const send = vi.fn().mockResolvedValue(undefined);
    const command = new UpgradeCommand();

    await command.execute({
      adapter: { send },
      msg: { chatId: 'chat-1' },
      parts: ['/upgrade'],
    } as any);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('无法检查更新') }),
    );
  });
});