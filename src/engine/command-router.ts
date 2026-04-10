import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { SessionStateManager } from './session-state.js';
import type { ChannelRouter } from './router.js';
import type { LLMProvider, QueryControls } from '../providers/base.js';
import { ClaudeSDKProvider } from '../providers/claude-sdk.js';
import type { ClaudeSettingSource } from '../config.js';
import type { BridgeStore } from '../store/interface.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSessionTranscriptPreview, scanClaudeSessions } from '../session-scanner.js';
import { generateSessionId } from '../utils/id.js';
import { shortPath } from '../utils/path.js';
import {
  presentApproveFailure,
  presentApproveSuccess,
  presentApproveUsage,
  presentDirectory,
  presentDirectoryNotFound,
  presentHelp,
  presentHooksChanged,
  presentHooksStatus,
  presentHome,
  presentNewSession,
  presentNoPairings,
  presentNoSessions,
  presentPairingUnavailable,
  presentPairings,
  presentPermissionModeChanged,
  presentPermissionModeStatus,
  presentPermissionStatus,
  presentRestartResult,
  presentSessionNotFound,
  presentSessionDetail,
  presentSessions,
  presentSessionSwitched,
  presentSessionUsage,
  presentSettingsChanged,
  presentSettingsStatus,
  presentSettingsUnavailable,
  presentStatus,
  presentStopResult,
  presentUpgradeCommand,
  presentUpgradeResult,
  presentVersionCheck,
  presentVersionSkipped,
  presentVersionUnskipped,
} from './command-presenter.js';
import { areHooksPaused, pauseHooks, resumeHooks } from './hooks-state.js';
import type { FormattableMessage, HomeData } from '../formatting/message-types.js';

/** Format file size in human-readable format */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatSessionDate(mtime: number): string {
  return new Date(mtime).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Helper to send either a formatted message or simple text */
async function send(
  adapter: BaseChannelAdapter,
  msg: FormattableMessage | { chatId: string; text: string },
): Promise<void> {
  if ('type' in msg) {
    await adapter.sendFormatted(msg);
  } else {
    await adapter.send({ chatId: msg.chatId, text: msg.text });
  }
}

export class CommandRouter {
  constructor(
    private state: SessionStateManager,
    private getAdapters: () => Map<string, BaseChannelAdapter>,
    private router: ChannelRouter,
    private store: BridgeStore,
    private defaultWorkdir: string,
    private llm: LLMProvider,
    private activeControls: Map<string, QueryControls>,
    private permissions: {
      clearSessionWhitelist(sessionId?: string): void;
      getPermissionStatus(chatKey: string, sessionId?: string): {
        rememberedTools: number;
        rememberedBashPrefixes: number;
        pending?: { toolName: string; input: string };
        lastDecision?: { toolName: string; decision: 'allow' | 'allow_always' | 'deny' | 'cancelled' };
      };
    },
    private onNewSession?: (channelType: string, chatId: string) => void,
  ) {}

  private async buildHomePayload(channelType: string, chatId: string): Promise<HomeData> {
    const binding = await this.store.getBinding(channelType, chatId);
    const currentCwd = binding?.cwd || this.defaultWorkdir;
    const chatKey = this.state.stateKey(channelType, chatId);
    const recentSessions = scanClaudeSessions(3, currentCwd);

    // Get permission status info
    const permStatus = this.permissions.getPermissionStatus(chatKey, binding?.sessionId);
    const activeChannels = Array.from(this.getAdapters().keys());

    return {
      cwd: shortPath(currentCwd),
      hasActiveTask: this.activeControls.has(chatKey),
      permissionMode: this.state.getPermMode(channelType, chatId),
      recentSummary: recentSessions[0]?.preview,
      recentSessions: recentSessions.map((session, index) => ({
        index: index + 1,
        date: formatSessionDate(session.mtime),
        preview: session.preview,
        isCurrent: binding?.sdkSessionId === session.sdkSessionId,
      })),
      // Enhanced status overview
      pendingPermission: permStatus.pending,
      lastPermissionDecision: permStatus.lastDecision,
      sessionWhitelistCount: permStatus.rememberedTools + permStatus.rememberedBashPrefixes,
      bridgeHealthy: activeChannels.length > 0,
      activeChannels,
    };
  }

  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const parts = msg.text.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/status': {
        const channelList = Array.from(this.getAdapters().keys()).join(', ') || 'none';
        await send(adapter, presentStatus(msg.chatId, {
          healthy: true,
          channels: channelList.split(', '),
        }));
        return true;
      }
      case '/new': {
        // Close any active LiveSession(s) for this chat before creating new session
        this.onNewSession?.(msg.channelType, msg.chatId);
        // Just clear session, keep current cwd
        const binding = await this.store.getBinding(msg.channelType, msg.chatId);

        const newSessionId = generateSessionId();
        await this.router.rebind(msg.channelType, msg.chatId, newSessionId, {
          cwd: binding?.cwd,
        });

        this.state.clearLastActive(msg.channelType, msg.chatId);
        this.state.clearThread(msg.channelType, msg.chatId);
        this.permissions.clearSessionWhitelist(binding?.sessionId);

        await send(adapter, presentNewSession(msg.chatId, { cwd: binding?.cwd }));

        // Send home screen for platforms with rich card support
        if (adapter.supportsRichCards()) {
          const homeData = await this.buildHomePayload(msg.channelType, msg.chatId);
          homeData.hasActiveTask = false;
          await send(adapter, presentHome(msg.chatId, homeData));
        }
        return true;
      }
      case '/home': {
        await send(adapter, presentHome(msg.chatId, await this.buildHomePayload(msg.channelType, msg.chatId)));
        return true;
      }
      case '/perm': {
        const sub = parts[1]?.toLowerCase();
        if (sub === 'on' || sub === 'off') {
          this.state.setPermMode(msg.channelType, msg.chatId, sub);
          if (adapter.supportsRichCards()) {
            const binding = await this.store.getBinding(msg.channelType, msg.chatId);
            const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
            await send(adapter, presentPermissionStatus(msg.chatId, {
              mode: sub,
              ...this.permissions.getPermissionStatus(chatKey, binding?.sessionId),
            }));
          } else {
            await send(adapter, presentPermissionModeChanged(msg.chatId, sub));
          }
        } else {
          if (adapter.supportsRichCards()) {
            const binding = await this.store.getBinding(msg.channelType, msg.chatId);
            const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
            await send(adapter, presentPermissionStatus(msg.chatId, {
              mode: this.state.getPermMode(msg.channelType, msg.chatId),
              ...this.permissions.getPermissionStatus(chatKey, binding?.sessionId),
            }));
          } else {
            const current = this.state.getPermMode(msg.channelType, msg.chatId);
            await send(adapter, presentPermissionModeStatus(msg.chatId, current));
          }
        }
        return true;
      }
      case '/stop': {
        const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
        const ctrl = this.activeControls.get(chatKey);
        if (ctrl) {
          this.activeControls.delete(chatKey);
          await ctrl.interrupt();
          await send(adapter, presentStopResult(msg.chatId, true));
        } else {
          await send(adapter, presentStopResult(msg.chatId, false));
        }
        return true;
      }
      case '/hooks': {
        const sub = parts[1]?.toLowerCase();
        if (sub === 'pause') {
          pauseHooks();
          await send(adapter, presentHooksChanged(msg.chatId, true));
        } else if (sub === 'resume') {
          resumeHooks();
          await send(adapter, presentHooksChanged(msg.chatId, false));
        } else {
          await send(adapter, presentHooksStatus(msg.chatId, areHooksPaused()));
        }
        return true;
      }
      case '/sessions': {
        const binding = await this.store.getBinding(msg.channelType, msg.chatId);
        const currentCwd = binding?.cwd || this.defaultWorkdir;
        const showAll = parts[1]?.toLowerCase() === '--all' || parts[1]?.toLowerCase() === '-a';

        const sessions = scanClaudeSessions(10, showAll ? undefined : currentCwd);
        const currentSdkId = binding?.sdkSessionId;

        if (sessions.length === 0) {
          const hint = showAll ? '' : ` in ${shortPath(currentCwd)}\nUse /sessions --all to see all projects.`;
          await send(adapter, presentNoSessions(msg.chatId, hint));
          return true;
        }

        const sessionData = sessions.map((s, i) => ({
          index: i + 1,
          date: formatSessionDate(s.mtime),
          cwd: shortPath(s.cwd),
          size: formatSize(s.size),
          preview: s.preview,
          isCurrent: currentSdkId === s.sdkSessionId,
        }));

        const filterHint = showAll ? ' (all projects)' : ` (${shortPath(currentCwd)})`;
        await send(adapter, presentSessions(msg.chatId, {
          sessions: sessionData,
          filterHint,
        }));
        return true;
      }
      case '/session': {
        const idx = parseInt(parts[1], 10);
        if (Number.isNaN(idx) || idx < 1) {
          await send(adapter, presentSessionUsage(msg.chatId));
          return true;
        }

        const binding = await this.store.getBinding(msg.channelType, msg.chatId);
        const currentCwd = binding?.cwd || this.defaultWorkdir;
        const sessions = scanClaudeSessions(10, currentCwd);

        if (idx > sessions.length) {
          await send(adapter, presentSessionNotFound(msg.chatId, idx));
          return true;
        }

        const target = sessions[idx - 1];

        const newBindingId = generateSessionId();
        await this.router.rebind(msg.channelType, msg.chatId, newBindingId, {
          sdkSessionId: target.sdkSessionId,
          cwd: target.cwd, // update cwd to session's directory
        });

        this.state.clearLastActive(msg.channelType, msg.chatId);

        await send(adapter, presentSessionSwitched(msg.chatId, idx, shortPath(target.cwd), target.preview));
        return true;
      }
      case '/sessioninfo': {
        const idx = parseInt(parts[1], 10);
        if (Number.isNaN(idx) || idx < 1) {
          await send(adapter, presentSessionUsage(msg.chatId));
          return true;
        }

        const binding = await this.store.getBinding(msg.channelType, msg.chatId);
        const currentCwd = binding?.cwd || this.defaultWorkdir;
        const showAll = parts[2]?.toLowerCase() === '--all' || parts[1]?.toLowerCase() === '--all';
        const sessions = scanClaudeSessions(10, showAll ? undefined : currentCwd);
        if (idx > sessions.length) {
          await send(adapter, presentSessionNotFound(msg.chatId, idx));
          return true;
        }

        const target = sessions[idx - 1];
        const transcript = readSessionTranscriptPreview(target, 4).map(item => ({
          role: item.role,
          text: item.text,
        }));
        await send(adapter, presentSessionDetail(msg.chatId, {
          index: idx,
          cwd: shortPath(target.cwd),
          preview: target.preview,
          date: formatSessionDate(target.mtime),
          size: formatSize(target.size),
          transcript,
        }));
        return true;
      }
      case '/cd': {
        const path = parts.slice(1).join(' ').trim();

        if (!path) {
          // Show current directory
          const binding = await this.store.getBinding(msg.channelType, msg.chatId);
          const current = binding?.cwd || this.defaultWorkdir;
          await send(adapter, presentDirectory(msg.chatId, shortPath(current), true));
          return true;
        }

        // Handle ~ expansion
        const expandedPath = path.startsWith('~') ? join(homedir(), path.slice(1)) : path;

        // Resolve relative paths
        const binding = await this.store.getBinding(msg.channelType, msg.chatId);
        const baseCwd = binding?.cwd || this.defaultWorkdir;
        const resolvedPath = expandedPath.startsWith('/') ? expandedPath : join(baseCwd, expandedPath);

        if (!existsSync(resolvedPath)) {
          await send(adapter, presentDirectoryNotFound(msg.chatId, shortPath(resolvedPath)));
          return true;
        }

        // Update binding
        if (binding) {
          binding.cwd = resolvedPath;
          await this.store.saveBinding(binding);
        } else {
          await this.router.rebind(msg.channelType, msg.chatId, generateSessionId(), { cwd: resolvedPath });
        }

        await send(adapter, presentDirectory(msg.chatId, shortPath(resolvedPath), true));
        return true;
      }
      case '/pwd': {
        const binding = await this.store.getBinding(msg.channelType, msg.chatId);
        const current = binding?.cwd || this.defaultWorkdir;
        await send(adapter, presentDirectory(msg.chatId, shortPath(current)));
        return true;
      }
      case '/settings': {
        const arg = parts[1]?.toLowerCase();

        if (!(this.llm instanceof ClaudeSDKProvider)) {
          await send(adapter, presentSettingsUnavailable(msg.chatId));
          return true;
        }

        const PRESETS: Record<string, ClaudeSettingSource[]> = {
          user: ['user'],
          full: ['user', 'project', 'local'],
          isolated: [],
        };

        if (arg && arg in PRESETS) {
          this.llm.setSettingSources(PRESETS[arg]);
          const labels: Record<string, string> = {
            user: '👤 user — auth & model only',
            full: '📦 full — auth, CLAUDE.md, MCP, skills',
            isolated: '🔒 isolated — no external settings',
          };
          await send(adapter, presentSettingsChanged(msg.chatId, labels[arg]));
        } else {
          const current = this.llm.getSettingSources();
          const preset = current.length === 0 ? 'isolated'
            : current.length === 1 && current[0] === 'user' ? 'user'
            : current.includes('project') ? 'full'
            : current.join(',');
          await send(adapter, presentSettingsStatus(msg.chatId, preset, current));
        }
        return true;
      }
      case '/help': {
        await send(adapter, presentHelp(msg.chatId, {
          commands: [
            { cmd: 'new', desc: 'New conversation' },
            { cmd: 'sessions', desc: 'List sessions in current dir' },
            { cmd: 'session <n>', desc: 'Switch to session #n' },
            { cmd: 'cd <path>', desc: 'Change directory' },
            { cmd: 'pwd', desc: 'Show current directory' },
            { cmd: 'perm on|off', desc: 'Permission prompts' },
            { cmd: 'stop', desc: 'Interrupt execution' },
            { cmd: 'status', desc: 'Bridge status' },
            { cmd: 'help', desc: 'This message' },
          ],
        }));
        return true;
      }
      case '/help-cli': {
        // For non-Feishu, just show regular help
        await send(adapter, presentHelp(msg.chatId, {
          commands: [
            { cmd: 'new', desc: 'New conversation' },
            { cmd: 'sessions', desc: 'List sessions' },
            { cmd: 'session <n>', desc: 'Switch session' },
            { cmd: 'cd <path>', desc: 'Change directory' },
            { cmd: 'perm on|off', desc: 'Permission prompts' },
            { cmd: 'settings user|full|isolated', desc: 'Claude settings' },
            { cmd: 'stop', desc: 'Interrupt execution' },
            { cmd: 'status', desc: 'Bridge status' },
            { cmd: 'help', desc: 'Commands list' },
          ],
        }));
        return true;
      }
      case '/approve': {
        const code = parts[1];
        if (!code) {
          await send(adapter, presentApproveUsage(msg.chatId));
          return true;
        }
        const tgAdapter = this.getAdapters().get('telegram');
        if (tgAdapter && 'approvePairing' in tgAdapter) {
          const result = (tgAdapter as any).approvePairing(code);
          if (result) {
            await send(adapter, presentApproveSuccess(msg.chatId, result.username, result.userId));
          } else {
            await send(adapter, presentApproveFailure(msg.chatId));
          }
        } else {
          await send(adapter, presentPairingUnavailable(msg.chatId));
        }
        return true;
      }
      case '/pairings': {
        const tgAdapter = this.getAdapters().get('telegram');
        if (tgAdapter && 'listPairings' in tgAdapter) {
          const pairings = (tgAdapter as any).listPairings() as Array<{ code: string; userId: string; username: string }>;
          if (pairings.length === 0) {
            await send(adapter, presentNoPairings(msg.chatId));
          } else {
            const lines = pairings.map(p => `• <code>${p.code}</code> — ${p.username} (${p.userId})`);
            await send(adapter, presentPairings(msg.chatId, lines));
          }
        } else {
          await send(adapter, presentPairingUnavailable(msg.chatId));
        }
        return true;
      }
      case '/upgrade': {
        const subCmd = parts[1]?.toLowerCase();

        // Handle sub-commands with optional version parameter (e.g., confirm:0.9.3)
        if (subCmd?.startsWith('confirm')) {
          const { execSync } = await import('node:child_process');
          try {
            // Download and run installer
            const cmd = 'curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash';
            execSync(cmd, { stdio: 'inherit', timeout: 120_000 });
            await adapter.send({
              chatId: msg.chatId,
              text: '✅ 升级完成，正在重启...',
            });
            // Restart bridge to load new code (exit, daemon manager will restart)
            setTimeout(() => process.exit(0), 1000);
          } catch (err: any) {
            await send(adapter, presentUpgradeResult(msg.chatId, {
              success: false,
              error: err?.message || 'Upgrade failed',
            }));
          }
          return true;
        }

        if (subCmd?.startsWith('skip')) {
          // Extract version from skip:VERSION format
          const version = subCmd.split(':')[1];
          if (version) {
            const { skipVersion } = await import('./version-checker.js');
            skipVersion(version);
            await send(adapter, presentVersionSkipped(msg.chatId, version));
          }
          return true;
        }

        if (subCmd === 'unskip') {
          const { clearSkippedVersion } = await import('./version-checker.js');
          clearSkippedVersion();
          await send(adapter, presentVersionUnskipped(msg.chatId));
          return true;
        }

        if (subCmd === 'cmd' || subCmd === 'command') {
          await send(adapter, presentUpgradeCommand(msg.chatId));
          return true;
        }

        if (subCmd === 'notes') {
          // Show release notes link
          await adapter.send({
            chatId: msg.chatId,
            text: '📋 查看更新内容：\nhttps://github.com/huanghuoguoguo/tlive/releases',
          });
          return true;
        }

        // Check for updates (ignore skip to always show when manually checking)
        const { checkForUpdates } = await import('./version-checker.js');
        const info = await checkForUpdates({ ignoreSkip: true });
        if (info) {
          await send(adapter, presentVersionCheck(msg.chatId, info));
        } else {
          await adapter.send({
            chatId: msg.chatId,
            text: '⚠️ 无法检查更新，请稍后重试',
          });
        }
        return true;
      }
      case '/restart': {
        await send(adapter, presentRestartResult(msg.chatId));
        // Delay restart to allow message to be sent
        setTimeout(() => {
          process.exit(0); // Exit cleanly, external process manager should restart
        }, 1000);
        return true;
      }
      default:
        return false;
    }
  }
}
