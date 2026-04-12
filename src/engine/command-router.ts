import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { SessionStateManager } from './session-state.js';
import type { WorkspaceStateManager } from './workspace-state.js';
import type { ChannelRouter } from './router.js';
import type { LLMProvider, QueryControls } from '../providers/base.js';
import type { SDKEngine } from './sdk-engine.js';
import { basename } from 'node:path';
import { ClaudeSDKProvider } from '../providers/claude-sdk.js';
import {
  DEFAULT_CLAUDE_SETTING_SOURCES,
  type ClaudeSettingSource,
  getProjectByName,
  loadProjectsConfig,
} from '../config.js';
import type { BridgeStore } from '../store/interface.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSessionTranscriptPreview, scanClaudeSessions } from '../session-scanner.js';
import { generateSessionId } from '../utils/id.js';
import { shortPath } from '../utils/path.js';
import { isSameRepoRoot, findGitRoot } from '../utils/repo.js';
import {
  presentApproveFailure,
  presentApproveSuccess,
  presentApproveUsage,
  presentDiagnose,
  presentDirectory,
  presentDirectoryHistory,
  presentDirectoryNotFound,
  presentHelp,
  presentHooksChanged,
  presentHooksStatus,
  presentHome,
  presentNewSession,
  presentNoPairings,
  presentNoProjects,
  presentNoSessions,
  presentPairingUnavailable,
  presentPairings,
  presentPermissionStatus,
  presentProjectInfoExtended,
  presentProjectList,
  presentProjectNotFound,
  presentProjectSwitched,
  presentProjectUsage,
  presentQueueStatus,
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
} from './command-presenter.js';
import { areHooksPaused, pauseHooks, resumeHooks } from './hooks-state.js';
import type { FormattableMessage, HomeData, ProjectListData } from '../formatting/message-types.js';
import { SESSION_STALE_THRESHOLD_MS } from '../utils/constants.js';

/** Format file size in human-readable format */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatSessionDate(mtime: number): string {
  return new Date(mtime).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Format relative time (e.g., "2小时前", "刚刚") */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHour < 24) return `${diffHour}小时前`;
  if (diffDay < 7) return `${diffDay}天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
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
    private workspace: WorkspaceStateManager,
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
    private defaultClaudeSettingSources: ClaudeSettingSource[] = DEFAULT_CLAUDE_SETTING_SOURCES,
    private sdkEngine?: SDKEngine,
  ) {}

  private getSettingsPreset(sources: ClaudeSettingSource[]): string {
    if (sources.length === 0) return 'isolated';
    if (sources.length === 1 && sources[0] === 'user') return 'user';
    if (sources.length === 3 && sources[0] === 'user' && sources[1] === 'project' && sources[2] === 'local') {
      return 'full';
    }
    return sources.join(',');
  }

  private sameSettingSources(
    current: ClaudeSettingSource[] | undefined,
    next: ClaudeSettingSource[] | undefined,
  ): boolean {
    const left = current ?? [];
    const right = next ?? [];
    return left.length === right.length && left.every((source, index) => source === right[index]);
  }

  private updateWorkspaceBindingFromPath(channelType: string, chatId: string, cwd: string): void {
    const gitRoot = findGitRoot(cwd);
    if (gitRoot) {
      this.workspace.setBinding(channelType, chatId, gitRoot);
      return;
    }
    this.workspace.clearBinding(channelType, chatId);
  }

  private async buildHomePayload(channelType: string, chatId: string): Promise<HomeData> {
    const binding = await this.store.getBinding(channelType, chatId);
    const currentCwd = binding?.cwd || this.defaultWorkdir;
    const chatKey = this.state.stateKey(channelType, chatId);
    const recentSessions = scanClaudeSessions(3, currentCwd);

    // Get permission status info
    const permStatus = this.permissions.getPermissionStatus(chatKey, binding?.sessionId);
    const activeChannels = Array.from(this.getAdapters().keys());

    // Get workspace binding (long-term repo attribution)
    const workspaceBinding = this.workspace.getBinding(channelType, chatId);

    // Get project name from workspace state
    const projectName = binding?.projectName ?? this.workspace.getProjectName(channelType, chatId);

    // Get last active time from SessionStateManager
    const lastActiveTime = this.state.getLastActiveTime(channelType, chatId);

    // Get queue info and stale status from SDKEngine
    const activeSessionKey = this.sdkEngine?.getActiveSessionKey(channelType, chatId);
    const queueInfo = activeSessionKey ? this.sdkEngine?.getQueueInfo(activeSessionKey) : undefined;
    const sessionStale = this.sdkEngine?.isChatSessionStale(channelType, chatId) ?? false;

    return {
      cwd: shortPath(currentCwd),
      workspaceBinding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
      currentProject: projectName,
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
      // Phase 2: Session governance fields
      lastActiveAt: lastActiveTime ? formatRelativeTime(lastActiveTime) : undefined,
      queueInfo,
      sessionStale,
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
        // Unified session cleanup before creating new session
        const previousBinding = await this.store.getBinding(msg.channelType, msg.chatId);
        const hadActiveSession = this.sdkEngine?.cleanupSession(
          msg.channelType,
          msg.chatId,
          'new',
          previousBinding?.cwd,
        ) ?? false;

        const newSessionId = generateSessionId();
        await this.router.rebind(msg.channelType, msg.chatId, newSessionId, {
          cwd: previousBinding?.cwd,
          claudeSettingSources: previousBinding?.claudeSettingSources,
          projectName: previousBinding?.projectName,
        });

        this.state.clearLastActive(msg.channelType, msg.chatId);
        this.state.clearThread(msg.channelType, msg.chatId);
        this.permissions.clearSessionWhitelist(previousBinding?.sessionId);

        const feedbackText = hadActiveSession
          ? `🔄 已关闭旧会话，开启新会话`
          : undefined;
        await send(adapter, presentNewSession(msg.chatId, { cwd: previousBinding?.cwd, feedbackText }));

        // Send home screen after session reset
        const homeData = await this.buildHomePayload(msg.channelType, msg.chatId);
        homeData.hasActiveTask = false;
        await send(adapter, presentHome(msg.chatId, homeData));
        return true;
      }
      case '/home': {
        await send(adapter, presentHome(msg.chatId, await this.buildHomePayload(msg.channelType, msg.chatId)));
        return true;
      }
      case '/perm': {
        const sub = parts[1]?.toLowerCase();
        const mode = (sub === 'on' || sub === 'off') ? sub : this.state.getPermMode(msg.channelType, msg.chatId);
        if (sub === 'on' || sub === 'off') {
          this.state.setPermMode(msg.channelType, msg.chatId, sub);
        }
        // Always send permission status card; formatter handles platform fallback
        const binding = await this.store.getBinding(msg.channelType, msg.chatId);
        const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
        await send(adapter, presentPermissionStatus(msg.chatId, {
          mode,
          ...this.permissions.getPermissionStatus(chatKey, binding?.sessionId),
        }));
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

        // Get workspace binding for display
        const workspaceBinding = this.workspace.getBinding(msg.channelType, msg.chatId);

        if (sessions.length === 0) {
          const hint = showAll ? '' : ` in ${shortPath(currentCwd)}\nUse /sessions --all to see all projects.`;
          await send(adapter, presentNoSessions(msg.chatId, hint));
          return true;
        }

        // Check stale status for each session (based on mtime)
        const now = Date.now();
        const sessionData = sessions.map((s, i) => ({
          index: i + 1,
          date: formatSessionDate(s.mtime),
          cwd: shortPath(s.cwd),
          size: formatSize(s.size),
          preview: s.preview,
          isCurrent: currentSdkId === s.sdkSessionId,
          // Mark as stale if inactive for more than SESSION_STALE_THRESHOLD_MS
          isStale: (now - s.mtime) > SESSION_STALE_THRESHOLD_MS,
        }));

        const filterHint = showAll ? ' (all projects)' : ` (${shortPath(currentCwd)})`;
        await send(adapter, presentSessions(msg.chatId, {
          workspaceBinding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
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
        const switchedRepo = !isSameRepoRoot(currentCwd, target.cwd);

        // Close old SDK session if switching to a different workdir
        const hadActiveSession = this.sdkEngine?.cleanupSession(
          msg.channelType,
          msg.chatId,
          'switch',
          currentCwd,
        ) ?? false;

        const newBindingId = generateSessionId();
        await this.router.rebind(msg.channelType, msg.chatId, newBindingId, {
          sdkSessionId: target.sdkSessionId,
          cwd: target.cwd, // update cwd to session's directory
          claudeSettingSources: binding?.claudeSettingSources,
          projectName: switchedRepo ? undefined : binding?.projectName,
        });
        this.updateWorkspaceBindingFromPath(msg.channelType, msg.chatId, target.cwd);
        if (switchedRepo) {
          this.workspace.clearProjectName(msg.channelType, msg.chatId);
        }

        this.state.clearLastActive(msg.channelType, msg.chatId);
        this.permissions.clearSessionWhitelist(binding?.sessionId);

        const feedbackText = hadActiveSession && switchedRepo
          ? `🔄 已关闭旧工作区的活跃会话`
          : undefined;
        await send(adapter, presentSessionSwitched(msg.chatId, idx, shortPath(target.cwd), target.preview, feedbackText));
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
          // Show current directory and history
          const binding = await this.store.getBinding(msg.channelType, msg.chatId);
          const current = binding?.cwd || this.defaultWorkdir;
          const history = this.workspace.getHistory(msg.channelType, msg.chatId);
          const workspaceBinding = this.workspace.getBinding(msg.channelType, msg.chatId);
          await send(adapter, presentDirectoryHistory(msg.chatId, shortPath(current), history.map(shortPath), workspaceBinding ? shortPath(workspaceBinding) : undefined));
          return true;
        }

        // Handle /cd - (back to previous directory)
        if (path === '-') {
          const previousDir = this.workspace.getPreviousDirectory(msg.channelType, msg.chatId);
          if (!previousDir) {
            await send(adapter, { chatId: msg.chatId, text: '⚠️ 没有历史目录可返回' });
            return true;
          }

          // Switch to previous directory
          const binding = await this.store.getBinding(msg.channelType, msg.chatId);
          const currentCwd = binding?.cwd || this.defaultWorkdir;
          const switchedRepo = !isSameRepoRoot(currentCwd, previousDir);

          // Cross-repo directory switches must reset session context.
          if (switchedRepo) {
            this.sdkEngine?.cleanupSession(
              msg.channelType,
              msg.chatId,
              'cd',
              currentCwd,
            );
          }

          // Update binding
          if (binding) {
            binding.cwd = previousDir;
            if (switchedRepo) {
              binding.sdkSessionId = undefined;
              binding.projectName = undefined;
            }
            await this.store.saveBinding(binding);
          } else {
            await this.router.rebind(msg.channelType, msg.chatId, generateSessionId(), { cwd: previousDir });
          }
          this.workspace.pushHistory(msg.channelType, msg.chatId, previousDir);
          this.updateWorkspaceBindingFromPath(msg.channelType, msg.chatId, previousDir);

          if (switchedRepo) {
            this.workspace.clearProjectName(msg.channelType, msg.chatId);
            this.permissions.clearSessionWhitelist(binding?.sessionId);
          }

          const feedbackText = `🔙 已切换到上一目录`;
          await send(adapter, presentDirectory(msg.chatId, shortPath(previousDir), true, feedbackText));
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

        // Track directory history before switching
        this.workspace.pushHistory(msg.channelType, msg.chatId, baseCwd);

        const switchedRepo = !isSameRepoRoot(baseCwd, resolvedPath);
        // Keep session for same-repo directory changes; reset only when crossing repos.
        const hadActiveSession = switchedRepo
          ? (this.sdkEngine?.cleanupSession(
            msg.channelType,
            msg.chatId,
            'cd',
            baseCwd,
          ) ?? false)
          : false;

        // Update binding
        if (binding) {
          binding.cwd = resolvedPath;
          // Clear sdkSessionId when switching repo to avoid mismatch
          if (switchedRepo) {
            binding.sdkSessionId = undefined;
            binding.projectName = undefined;
          }
          await this.store.saveBinding(binding);
        } else {
          await this.router.rebind(msg.channelType, msg.chatId, generateSessionId(), { cwd: resolvedPath });
        }
        this.workspace.pushHistory(msg.channelType, msg.chatId, resolvedPath);
        this.updateWorkspaceBindingFromPath(msg.channelType, msg.chatId, resolvedPath);

        // Clear permission whitelist when switching repo
        if (switchedRepo) {
          this.workspace.clearProjectName(msg.channelType, msg.chatId);
          this.permissions.clearSessionWhitelist(binding?.sessionId);
        }

        const feedbackText = hadActiveSession && switchedRepo
          ? `🔄 已关闭旧仓库的活跃会话`
          : undefined;
        await send(adapter, presentDirectory(msg.chatId, shortPath(resolvedPath), true, feedbackText));
        return true;
      }
      case '/pwd': {
        const binding = await this.store.getBinding(msg.channelType, msg.chatId);
        const current = binding?.cwd || this.defaultWorkdir;
        const history = this.workspace.getHistory(msg.channelType, msg.chatId);
        const workspaceBinding = this.workspace.getBinding(msg.channelType, msg.chatId);

        // Enhanced display: show current, history, and workspace binding
        if (history.length > 1 || workspaceBinding) {
          await send(adapter, presentDirectoryHistory(
            msg.chatId,
            shortPath(current),
            history.map(shortPath),
            workspaceBinding ? shortPath(workspaceBinding) : undefined,
          ));
        } else {
          await send(adapter, presentDirectory(msg.chatId, shortPath(current)));
        }
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
          const binding = await this.router.resolve(msg.channelType, msg.chatId);
          const previousBinding = await this.store.getBinding(msg.channelType, msg.chatId);
          binding.claudeSettingSources = [...PRESETS[arg]];
          binding.sdkSessionId = undefined;
          await this.store.saveBinding(binding);
          this.sdkEngine?.cleanupSession(msg.channelType, msg.chatId, 'settings', previousBinding?.cwd);
          this.permissions.clearSessionWhitelist(binding.sessionId);
          const labels: Record<string, string> = {
            user: '👤 user — current chat uses global auth/model only',
            full: '📦 full — current chat loads project rules, MCP, and skills',
            isolated: '🔒 isolated — current chat ignores external settings',
          };
          await send(adapter, presentSettingsChanged(msg.chatId, labels[arg]));
        } else {
          const binding = await this.store.getBinding(msg.channelType, msg.chatId);
          const current = binding?.claudeSettingSources ?? this.defaultClaudeSettingSources;
          const preset = this.getSettingsPreset(current);
          await send(
            adapter,
            presentSettingsStatus(
              msg.chatId,
              preset,
              current,
              binding?.claudeSettingSources ? 'chat override' : 'default',
            ),
          );
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

        // Check for updates
        const { checkForUpdates } = await import('./version-checker.js');
        const info = await checkForUpdates();
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
      case '/queue': {
        const sub = parts[1]?.toLowerCase();

        // Get active session key
        const activeSessionKey = this.sdkEngine?.getActiveSessionKey(msg.channelType, msg.chatId);

        if (!activeSessionKey) {
          await send(adapter, { chatId: msg.chatId, text: '⚠️ 无活跃会话，队列不可用' });
          return true;
        }

        // /queue clear - clear the queue
        if (sub === 'clear') {
          const cleared = this.sdkEngine?.clearQueue(activeSessionKey) ?? 0;
          if (cleared > 0) {
            await send(adapter, { chatId: msg.chatId, text: `✅ 已清空队列 (${cleared} 条消息)` });
          } else {
            await send(adapter, { chatId: msg.chatId, text: '队列已为空' });
          }
          return true;
        }

        // /queue depth <n> - set max queue depth
        if (sub === 'depth') {
          const depth = parseInt(parts[2], 10);
          if (Number.isNaN(depth) || depth < 1 || depth > 10) {
            await send(adapter, { chatId: msg.chatId, text: '⚠️ 队列深度需为 1-10 的整数' });
            return true;
          }
          this.sdkEngine?.setMaxQueueDepth(depth);
          await send(adapter, { chatId: msg.chatId, text: `✅ 已设置队列深度为 ${depth}` });
          return true;
        }

        // /queue or /queue status - show queue status
        const queueDepth = this.sdkEngine?.getQueueDepth(activeSessionKey) ?? 0;
        const maxDepth = this.sdkEngine?.getMaxQueueDepth() ?? 3;
        const queuedMessages = this.sdkEngine?.getQueuedMessages(activeSessionKey) ?? [];

        await send(adapter, presentQueueStatus(msg.chatId, {
          sessionKey: activeSessionKey,
          depth: queueDepth,
          maxDepth,
          queuedMessages,
        }));
        return true;
      }
      case '/diagnose': {
        // Collect system diagnostics
        const activeSessions = this.sdkEngine?.getActiveSessionCount() ?? 0;
        const idleSessions = this.sdkEngine?.getIdleSessionCount() ?? 0;
        const totalBubbleMappings = this.sdkEngine?.getTotalBubbleMappings() ?? 0;
        const queueStats = this.sdkEngine?.getAllQueueStats() ?? [];
        const totalQueuedMessages = this.sdkEngine?.getTotalQueuedMessages() ?? 0;

        // Get processing chats count
        let processingChats = 0;
        for (const chatKey of this.activeControls.keys()) {
          if (this.state.isProcessing(chatKey)) processingChats++;
        }

        // Get memory usage
        const memUsage = process.memoryUsage();
        const memoryUsage = `${formatSize(memUsage.heapUsed)} / ${formatSize(memUsage.heapTotal)}`;

        await send(adapter, presentDiagnose(msg.chatId, {
          activeSessions,
          totalBubbleMappings,
          queueStats,
          totalQueuedMessages,
          memoryUsage,
          processingChats,
          idleSessions,
        }));
        return true;
      }
      case '/project': {
        const sub = parts[1]?.toLowerCase();

        // Load projects config
        const projectsConfig = loadProjectsConfig();

        if (!projectsConfig || projectsConfig.valid.length === 0) {
          await send(adapter, presentNoProjects(msg.chatId));
          return true;
        }

        // /project or /project list - show all projects
        if (!sub || sub === 'list') {
          const binding = await this.store.getBinding(msg.channelType, msg.chatId);
          const currentProjectName = binding?.projectName ?? this.workspace.getProjectName(msg.channelType, msg.chatId);
          const projects: ProjectListData['projects'] = projectsConfig.valid.map(p => ({
            name: p.name,
            workdir: shortPath(p.workdir),
            isCurrent: p.name === currentProjectName,
            isDefault: p.name === projectsConfig.defaultProject,
          }));

          await send(adapter, presentProjectList(msg.chatId, {
            projects,
            defaultProject: projectsConfig.defaultProject,
            currentProject: currentProjectName,
          }));
          return true;
        }

        // /project use <name> - switch to a project
        if (sub === 'use') {
          const projectName = parts[2]?.trim();
          if (!projectName) {
            await send(adapter, presentProjectUsage(msg.chatId));
            return true;
          }

          const project = getProjectByName(projectsConfig.valid, projectName);
          if (!project) {
            await send(adapter, presentProjectNotFound(msg.chatId, projectName));
            return true;
          }

          // Get current binding
          const binding = await this.store.getBinding(msg.channelType, msg.chatId);
          const currentCwd = binding?.cwd || this.defaultWorkdir;
          const previousProjectName = binding?.projectName ?? this.workspace.getProjectName(msg.channelType, msg.chatId);

          // Track directory history before switching
          this.workspace.pushHistory(msg.channelType, msg.chatId, currentCwd);

          const switchedRepo = !isSameRepoRoot(currentCwd, project.workdir);
          const settingsChanged = !this.sameSettingSources(
            binding?.claudeSettingSources,
            project.claudeSettingSources,
          );
          const shouldResetSession = switchedRepo || settingsChanged;
          const hadActiveSession = shouldResetSession
            ? (this.sdkEngine?.cleanupSession(
              msg.channelType,
              msg.chatId,
              switchedRepo ? 'cd' : 'settings',
              currentCwd,
            ) ?? false)
            : false;

          // Update binding with new workdir
          if (binding) {
            binding.cwd = project.workdir;
            binding.projectName = project.name;
            binding.claudeSettingSources = project.claudeSettingSources
              ? [...project.claudeSettingSources]
              : undefined;
            if (shouldResetSession) {
              binding.sdkSessionId = undefined;
            }
            await this.store.saveBinding(binding);
          } else {
            await this.router.rebind(msg.channelType, msg.chatId, generateSessionId(), {
              cwd: project.workdir,
              projectName: project.name,
              claudeSettingSources: project.claudeSettingSources
                ? [...project.claudeSettingSources]
                : undefined,
            });
          }
          this.workspace.pushHistory(msg.channelType, msg.chatId, project.workdir);

          // Update workspace state
          this.workspace.setProjectName(msg.channelType, msg.chatId, project.name);
          this.workspace.setBinding(msg.channelType, msg.chatId, project.workdir);

          // Clear permission whitelist when switching repo
          if (switchedRepo || settingsChanged) {
            this.permissions.clearSessionWhitelist(binding?.sessionId);
          }

          const feedbackParts: string[] = [];
          if (previousProjectName && previousProjectName !== project.name) {
            feedbackParts.push(`已从项目 ${previousProjectName} 切换`);
          } else {
            feedbackParts.push(`已切换到项目 ${project.name}`);
          }
          feedbackParts.push(`工作区更新为 ${shortPath(project.workdir)}`);
          if (hadActiveSession && switchedRepo) {
            feedbackParts.push('已关闭旧项目的活跃会话');
          } else if (hadActiveSession && settingsChanged) {
            feedbackParts.push('已应用项目设置并重置会话');
          }

          await send(adapter, presentProjectSwitched(msg.chatId, {
            projectName: project.name,
            workdir: shortPath(project.workdir),
            feedbackText: feedbackParts.join('，'),
          }));
          return true;
        }

        // /project status - show current project status
        if (sub === 'status' || sub === 'info') {
          const binding = await this.store.getBinding(msg.channelType, msg.chatId);
          const currentProjectName = binding?.projectName ?? this.workspace.getProjectName(msg.channelType, msg.chatId);
          const currentCwd = binding?.cwd || this.defaultWorkdir;
          const workspaceBinding = this.workspace.getBinding(msg.channelType, msg.chatId);

          if (!currentProjectName) {
            // No project bound - show implicit project info
            const implicitName = basename(currentCwd);
            await send(adapter, presentProjectInfoExtended(msg.chatId, {
              projectName: implicitName,
              workdir: shortPath(currentCwd),
              isImplicit: true,
              workspaceBinding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
            }));
          } else {
            const project = getProjectByName(projectsConfig.valid, currentProjectName);
            await send(adapter, presentProjectInfoExtended(msg.chatId, {
              projectName: currentProjectName,
              workdir: project ? shortPath(project.workdir) : shortPath(currentCwd),
              isImplicit: false,
              workspaceBinding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
              isValidProject: !!project,
            }));
          }
          return true;
        }

        // Unknown subcommand
        await send(adapter, presentProjectUsage(msg.chatId));
        return true;
      }
      default:
        return false;
    }
  }
}
