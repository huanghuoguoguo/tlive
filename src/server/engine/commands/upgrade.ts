import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { checkForUpdates } from '../../../shared/utils/version-checker.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getTliveHome } from '../../../shared/core/path.js';
import { t } from '../../../shared/i18n/index.js';

const UPGRADE_IN_FLIGHT_TTL_MS = 10 * 60 * 1000;

interface UpgradeInFlight {
  startedAt: number;
  current?: string;
  latest?: string;
}

let upgradeInFlight: UpgradeInFlight | null = null;

function activeUpgradeInFlight(now = Date.now()): UpgradeInFlight | null {
  if (!upgradeInFlight) return null;
  if (now - upgradeInFlight.startedAt <= UPGRADE_IN_FLIGHT_TTL_MS) return upgradeInFlight;
  upgradeInFlight = null;
  return null;
}

function beginUpgradeInFlight(): UpgradeInFlight | null {
  if (activeUpgradeInFlight()) return null;
  upgradeInFlight = { startedAt: Date.now() };
  return upgradeInFlight;
}

function clearUpgradeInFlight(lock: UpgradeInFlight): void {
  if (upgradeInFlight === lock) {
    upgradeInFlight = null;
  }
}

function upgradeAlreadyRunningText(lock: UpgradeInFlight): string {
  const version = lock.latest
    ? `：v${lock.current || '?'} → v${lock.latest}`
    : '，正在检查版本';
  return t('cmd.upgrade.alreadyRunning').replace('{version}', version);
}

function resolvePackageRoot(
  entryPath = process.argv[1],
  override = process.env.TLIVE_PACKAGE_ROOT,
): string {
  if (override?.trim()) return override.trim();
  if (!entryPath) {
    return join(getTliveHome(), 'app');
  }
  return join(dirname(entryPath), '..');
}

function resolveCliPath(): string {
  const override = process.env.TLIVE_CLI_PATH?.trim();
  if (override) return override;

  const packageRoot = resolvePackageRoot();
  const packagedCli = join(packageRoot, 'scripts', 'cli.js');
  if (existsSync(packagedCli)) return packagedCli;

  return join(getTliveHome(), 'app', 'scripts', 'cli.js');
}

export class UpgradeCommand extends BaseCommand {
  readonly name = '/upgrade';
  readonly quick = true;
  readonly helpCategory = 'system' as const;
  readonly description = '升级版本';
  readonly helpDesc = '检查并升级到最新版本。服务会自动重启。notes 查看更新日志。';
  readonly helpExample = '/upgrade 或 /upgrade notes';

  async execute(ctx: CommandContext): Promise<boolean> {
    const subCmd = ctx.parts[1]?.toLowerCase();

    if (subCmd === 'notes') {
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: t('cmd.upgrade.notesHint'),
      });
      return true;
    }

    const active = activeUpgradeInFlight();
    if (active) {
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: upgradeAlreadyRunningText(active),
      });
      return true;
    }

    const lock = beginUpgradeInFlight();
    if (!lock) {
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: upgradeAlreadyRunningText(activeUpgradeInFlight() ?? { startedAt: Date.now() }),
      });
      return true;
    }

    // Check for updates first
    const info = await checkForUpdates().catch(() => null);

    if (!info) {
      clearUpgradeInFlight(lock);
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: t('cmd.upgrade.checkFailed'),
      });
      return true;
    }

    if (!info.hasUpdate) {
      clearUpgradeInFlight(lock);
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: t('cmd.upgrade.alreadyLatest').replace('{version}', info.current),
      });
      return true;
    }

    lock.current = info.current;
    lock.latest = info.latest;

    try {
      // Execute upgrade directly
      const { spawn } = await import('node:child_process');
      const packageRoot = resolvePackageRoot();

      if (existsSync(join(packageRoot, '.git'))) {
        clearUpgradeInFlight(lock);
        await this.send(ctx, {
          chatId: ctx.msg.chatId,
          text: t('cmd.upgrade.gitCheckout'),
        });
        return true;
      }

      const cliPath = resolveCliPath();
      if (!existsSync(cliPath)) {
        throw new Error(`CLI not found: ${cliPath}`);
      }

      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: t('cmd.upgrade.starting')
          .replace('{current}', info.current)
          .replace('{latest}', info.latest),
      });

      const child = spawn(process.execPath, [cliPath, 'upgrade', info.latest], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          TLIVE_UPGRADE_PARENT_PID: String(process.pid),
          TLIVE_UPGRADE_CHAT_ID: ctx.msg.chatId,
          TLIVE_UPGRADE_CHANNEL_TYPE: ctx.adapter.channelType,
          TLIVE_UPGRADE_FROM_VERSION: info.current,
        },
      });
      child.unref();

      setTimeout(() => process.exit(0), 250);
    } catch (err: any) {
      clearUpgradeInFlight(lock);
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: t('cmd.upgrade.failed').replace(
          '{error}',
          err?.message || 'Unknown error',
        ),
      });
    }
    return true;
  }
}
