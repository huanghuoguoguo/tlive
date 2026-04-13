import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentSettingsStatus, presentSettingsChanged, presentSettingsUnavailable } from '../messages/presenter.js';
import { ClaudeSDKProvider } from '../../providers/claude-sdk.js';
import type { ClaudeSettingSource } from '../../config.js';

const PRESETS: Record<string, ClaudeSettingSource[]> = {
  user: ['user'],
  full: ['user', 'project', 'local'],
  isolated: [],
};

const LABELS: Record<string, string> = {
  user: '👤 user — current chat uses global auth/model only',
  full: '📦 full — current chat loads project rules, MCP, and skills',
  isolated: '🔒 isolated — current chat ignores external settings',
};

export class SettingsCommand extends BaseCommand {
  readonly name = '/settings';
  readonly quick = true;
  readonly description = 'Claude settings';

  async execute(ctx: CommandContext): Promise<boolean> {
    const arg = ctx.parts[1]?.toLowerCase();

    if (!(ctx.llm instanceof ClaudeSDKProvider)) {
      await this.send(ctx, presentSettingsUnavailable(ctx.msg.chatId));
      return true;
    }

    if (arg && arg in PRESETS) {
      const binding = await ctx.router.resolve(ctx.msg.channelType, ctx.msg.chatId);
      binding.claudeSettingSources = [...PRESETS[arg]];
      await ctx.store.saveBinding(binding);
      await ctx.helpers.resetSessionContext(
        ctx.msg.channelType,
        ctx.msg.chatId,
        'settings',
        { previousCwd: binding.cwd, binding },
      );
      await this.send(ctx, presentSettingsChanged(ctx.msg.chatId, LABELS[arg]));
    } else {
      const binding = await ctx.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
      const current = binding?.claudeSettingSources ?? ctx.defaultClaudeSettingSources;
      const preset = ctx.helpers.getSettingsPreset(current);
      await this.send(ctx, presentSettingsStatus(
        ctx.msg.chatId,
        preset,
        current,
        binding?.claudeSettingSources ? 'chat override' : 'default',
      ));
    }
    return true;
  }
}
