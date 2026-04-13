import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentVersionCheck, presentUpgradeResult, presentUpgradeCommand } from '../messages/presenter.js';
import { checkForUpdates } from '../utils/version-checker.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function normalizeRequestedVersion(raw?: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'latest') return null;
  return trimmed.replace(/^v/i, '');
}

export function parseRequestedUpgradeVersion(parts: string[]): string | null {
  const subCommand = parts[1];
  if (!subCommand) return null;

  if (subCommand.toLowerCase().startsWith('confirm:')) {
    return normalizeRequestedVersion(subCommand.slice(subCommand.indexOf(':') + 1));
  }

  return normalizeRequestedVersion(parts[2]);
}

function resolvePackageRoot(entryPath = process.argv[1], override = process.env.TLIVE_PACKAGE_ROOT): string {
  if (override?.trim()) return override.trim();
  if (!entryPath) {
    return join(homedir(), '.tlive', 'app');
  }
  return join(dirname(entryPath), '..');
}

export function resolveCliPath(): string {
  const override = process.env.TLIVE_CLI_PATH?.trim();
  if (override) return override;

  const packageRoot = resolvePackageRoot();
  const packagedCli = join(packageRoot, 'scripts', 'cli.js');
  if (existsSync(packagedCli)) return packagedCli;

  return join(homedir(), '.tlive', 'app', 'scripts', 'cli.js');
}

export class UpgradeCommand extends BaseCommand {
  readonly name = '/upgrade';
  readonly quick = true;
  readonly description = 'Check for updates';

  async execute(ctx: CommandContext): Promise<boolean> {
    const rawSubCmd = ctx.parts[1];
    const subCmd = rawSubCmd?.toLowerCase();

    // Handle sub-commands with optional version parameter
    if (subCmd?.startsWith('confirm')) {
      const { spawn } = await import('node:child_process');
      const packageRoot = resolvePackageRoot();
      try {
        if (existsSync(join(packageRoot, '.git'))) {
          await this.send(ctx, presentUpgradeResult(ctx.msg.chatId, {
            success: false,
            error: '当前运行自 git checkout，请手动用 git 更新，或改用 release 安装版。',
          }));
          return true;
        }

        const cliPath = resolveCliPath();
        if (!existsSync(cliPath)) {
          throw new Error(`CLI not found: ${cliPath}`);
        }

        const requestedVersion = parseRequestedUpgradeVersion(ctx.parts);
        const childArgs = [cliPath, 'upgrade'];
        if (requestedVersion) childArgs.push(requestedVersion);

        const child = spawn(process.execPath, childArgs, {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            TLIVE_UPGRADE_PARENT_PID: String(process.pid),
          },
        });
        child.unref();

        await ctx.adapter.send({
          chatId: ctx.msg.chatId,
          text: requestedVersion
            ? `✅ 已开始升级到 v${requestedVersion}，服务将自动重启...`
            : '✅ 已开始升级到最新版本，服务将自动重启...',
        });
        setTimeout(() => process.exit(0), 1000);
      } catch (err: any) {
        await this.send(ctx, presentUpgradeResult(ctx.msg.chatId, {
          success: false,
          error: err?.message || 'Upgrade failed',
        }));
      }
      return true;
    }

    if (subCmd === 'cmd' || subCmd === 'command') {
      await this.send(ctx, presentUpgradeCommand(ctx.msg.chatId));
      return true;
    }

    if (subCmd === 'notes') {
      await ctx.adapter.send({
        chatId: ctx.msg.chatId,
        text: '📋 查看更新内容：\nhttps://github.com/huanghuoguoguo/tlive/releases',
      });
      return true;
    }

    // Check for updates
    const info = await checkForUpdates();
    if (info) {
      await this.send(ctx, presentVersionCheck(ctx.msg.chatId, info));
    } else {
      await ctx.adapter.send({
        chatId: ctx.msg.chatId,
        text: '⚠️ 无法检查更新，请稍后重试',
      });
    }
    return true;
  }
}
