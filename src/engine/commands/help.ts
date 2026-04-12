import { BaseCommand } from './base.js';
import type { CommandContext, HelpEntry } from './types.js';
import { presentHelp } from '../messages/presenter.js';

export class HelpCommand extends BaseCommand {
  readonly name = '/help';
  readonly quick = true;
  readonly description = 'Show all commands';

  async execute(ctx: CommandContext): Promise<boolean> {
    const entries: HelpEntry[] = [
      { cmd: 'new', desc: 'New conversation' },
      { cmd: 'sessions', desc: 'List sessions in current dir' },
      { cmd: 'sessions --all', desc: 'List all sessions' },
      { cmd: 'session <n>', desc: 'Switch to session #n' },
      { cmd: 'sessioninfo', desc: 'Show current session info' },
      { cmd: 'cd <path>', desc: 'Change directory' },
      { cmd: 'cd -', desc: 'Back to previous directory' },
      { cmd: 'pwd', desc: 'Show current directory' },
      { cmd: 'bash <cmd>', desc: 'Execute shell command' },
      { cmd: 'settings user|full|isolated', desc: 'Claude settings scope' },
      { cmd: 'perm on|off', desc: 'Permission prompts' },
      { cmd: 'stop', desc: 'Interrupt execution' },
      { cmd: 'hooks', desc: 'Show hooks status' },
      { cmd: 'hooks pause|resume', desc: 'Pause/resume hooks' },
      { cmd: 'project', desc: 'List projects' },
      { cmd: 'project use <name>', desc: 'Switch project' },
      { cmd: 'queue', desc: 'Show queue status' },
      { cmd: 'diagnose', desc: 'Run diagnostics' },
      { cmd: 'status', desc: 'Bridge status' },
      { cmd: 'upgrade', desc: 'Check for updates' },
      { cmd: 'restart', desc: 'Restart bridge' },
      { cmd: 'help', desc: 'This message' },
    ];
    await this.send(ctx, presentHelp(ctx.msg.chatId, { commands: entries }));
    return true;
  }
}