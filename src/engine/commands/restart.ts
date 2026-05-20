import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentRestartResult } from '../messages/presenter.js';
import { getTliveRuntimeDir, writeRestartRequest } from '../../core/path.js';
import { join } from 'node:path';

export class RestartCommand extends BaseCommand {
  readonly name = '/restart';
  readonly quick = true;
  readonly description = '重启 Bridge';
  readonly helpDesc = '重启 Bridge 服务。自动 spawn 新进程后退出，无需外部守护进程。';
  readonly helpExample = '/restart';

  async execute(ctx: CommandContext): Promise<boolean> {
    await this.send(ctx, presentRestartResult(ctx.msg.chatId));

    // Prepare restart handoff
    const runtimeDir = getTliveRuntimeDir();
    const pidFile = join(runtimeDir, 'bridge.pid');

    // Write restart marker before spawning
    writeRestartRequest(process.pid);

    // Delete PID file to let new process write its own
    try { unlinkSync(pidFile); } catch { /* ignore */ }

    // Spawn new process with same environment
    const entry = process.argv[1];
    if (entry && existsSync(entry)) {
      try {
        spawn(process.execPath, [entry], {
          detached: true,
          windowsHide: true,
          stdio: 'ignore',
          env: process.env,
        }).unref();
      } catch (err) {
        console.error(`[restart] Failed to spawn new process: ${err}`);
        // Don't exit if spawn failed - let user manually restart
        return true;
      }
    }

    // Exit after delay
    setTimeout(() => {
      process.exit(0);
    }, 1000);
    return true;
  }
}