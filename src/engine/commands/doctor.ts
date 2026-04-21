import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { release } from 'node:os';
import { t } from '../../i18n/index.js';
import { getCurrentVersion } from '../../utils/version-checker.js';
import { getTliveHome } from '../../core/path.js';

export class DoctorCommand extends BaseCommand {
  readonly name = '/doctor';
  readonly quick = true;
  readonly description = '系统诊断';
  readonly helpDesc = '收集系统诊断信息，包括操作系统、Node.js版本、tlive版本、配置状态等。';
  readonly helpExample = '/doctor';

  async execute(ctx: CommandContext): Promise<boolean> {
    const locale = typeof ctx.adapter.getLocale === 'function' ? ctx.adapter.getLocale() : 'zh';
    const diagnostics = await this.collectDiagnostics(ctx);

    const lines = [
      `🏥 **${t(locale, 'doctor.title')}**`,
      '',
      `**${t(locale, 'doctor.os')}**: ${diagnostics.os}`,
      `**${t(locale, 'doctor.node')}**: ${diagnostics.nodeVersion}`,
      `**${t(locale, 'doctor.tlive')}**: v${diagnostics.tliveVersion}`,
      `**${t(locale, 'doctor.uptime')}**: ${this.formatUptime(diagnostics.uptime)}`,
      '',
      `**${t(locale, 'doctor.config')}**: ${diagnostics.configStatus}`,
    ];

    // Claude CLI status
    if (diagnostics.claudeCli) {
      lines.push(`**${t(locale, 'doctor.claudeCli')}**: ${diagnostics.claudeCli}`);
    } else {
      lines.push(`**${t(locale, 'doctor.claudeCli')}**: ❌ ${t(locale, 'doctor.notFound')}`);
    }

    // Channel status
    lines.push('', `**${t(locale, 'doctor.channels')}**:`);
    for (const channel of diagnostics.channels) {
      const statusIcon = channel.connected ? '✅' : '❌';
      lines.push(`  ${statusIcon} ${channel.type}: ${channel.status}`);
    }

    await this.send(ctx, {
      chatId: ctx.msg.chatId,
      text: lines.join('\n'),
    });

    return true;
  }

  private async collectDiagnostics(ctx: CommandContext): Promise<{
    os: string;
    nodeVersion: string;
    tliveVersion: string;
    uptime: number;
    configStatus: string;
    claudeCli: string | null;
    channels: Array<{ type: string; connected: boolean; status: string }>;
  }> {
    // OS info
    const platform = process.platform;
    const osRelease = release();
    const osName = platform === 'linux' ? 'Linux' : platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform;
    const os = `${osName} ${osRelease}`;

    // Node.js version
    const nodeVersion = process.version;

    // tlive version
    const tliveVersion = getCurrentVersion();

    // Uptime
    const uptime = Math.floor(process.uptime());

    // Config status
    const configPath = join(getTliveHome(), 'config.env');
    const configStatus = existsSync(configPath)
      ? `✅ ${t('zh', 'doctor.configFound')}`
      : `❌ ${t('zh', 'doctor.configMissing')}`;

    // Claude CLI version - run check directly
    let claudeCli: string | null = null;
    try {
      const result = this.checkClaudeCliVersion();
      if (result.version) {
        claudeCli = `✅ v${result.version}`;
      } else if (result.error) {
        claudeCli = `⚠️ ${result.error}`;
      }
    } catch {
      claudeCli = null;
    }

    // Channel status
    const adapters = ctx.services.getAdapters();
    const channels = Array.from(adapters.entries()).map(([type, adapter]) => {
      const anyAdapter = adapter as any;
      const connected = anyAdapter.isConnected?.() ?? true;
      const status = connected ? t('zh', 'doctor.connected') : t('zh', 'doctor.disconnected');
      return { type, connected, status };
    });

    return {
      os,
      nodeVersion,
      tliveVersion,
      uptime,
      configStatus,
      claudeCli,
      channels,
    };
  }

  private formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  }

  private checkClaudeCliVersion(): { version?: string; error?: string } {
    try {
      // Try common CLI paths
      const cliPaths = ['claude', 'claude-code'];
      for (const cli of cliPaths) {
        try {
          const { execSync } = require('node:child_process');
          const output = execSync(`${cli} --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
          const match = output.match(/(\d+\.\d+\.\d+)/);
          if (match) {
            return { version: match[1] };
          }
        } catch {
          // Try next CLI path
        }
      }
      return { error: 'Not found' };
    } catch {
      return { error: 'Check failed' };
    }
  }
}