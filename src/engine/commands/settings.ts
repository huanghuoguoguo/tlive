import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import {
  presentSettingsStatus,
  presentSettingsChanged,
  presentSettingsUnavailable,
} from '../messages/presenter.js';
import type { AgentSettingSource } from '../../config.js';

const PRESETS: Record<string, AgentSettingSource[]> = {
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
  readonly helpCategory = 'status' as const;
  readonly description = 'Provider 设置';
  readonly helpDesc =
    '查看或切换当前执行引擎的设置加载模式。user 仅加载全局设置，full 加载项目规则/MCP/技能，isolated 完全隔离。';
  readonly helpExample = '/settings full';

  async execute(ctx: CommandContext): Promise<boolean> {
    const arg = ctx.parts[1]?.toLowerCase();
    const scopeId = ctx.scopeId;
    const existingBinding = await ctx.services.store.getBinding(ctx.msg.channelType, scopeId);
    const providerKind = existingBinding?.provider ?? ctx.services.providers.defaultProviderKind;
    const provider = ctx.services.providers.get(providerKind);

    if (!provider?.capabilities.settingSources) {
      await this.send(ctx, presentSettingsUnavailable(ctx.msg.chatId));
      return true;
    }

    if (arg && arg in PRESETS) {
      const binding = await ctx.services.router.resolve(ctx.msg.channelType, scopeId);
      binding.provider ??= providerKind;
      binding.agentSettingSources = [...PRESETS[arg]];
      await ctx.services.store.saveBinding(binding);
      await ctx.helpers.resetSessionContext(ctx.msg.channelType, scopeId, 'settings', {
        previousCwd: binding.cwd,
        binding,
      });
      await this.send(ctx, presentSettingsChanged(ctx.msg.chatId, LABELS[arg]));
    } else {
      const binding = existingBinding;
      const current = binding?.agentSettingSources ?? ctx.services.defaultAgentSettingSources;
      const preset = ctx.helpers.getSettingsPreset(current);
      await this.send(
        ctx,
        presentSettingsStatus(
          ctx.msg.chatId,
          preset,
          current,
          binding?.agentSettingSources ? 'chat override' : 'default',
        ),
      );
    }
    return true;
  }
}
