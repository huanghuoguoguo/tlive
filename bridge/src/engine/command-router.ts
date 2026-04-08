import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { SessionStateManager } from './session-state.js';
import type { ChannelRouter } from './router.js';
import type { LLMProvider, QueryControls } from '../providers/base.js';
import type { VerboseLevel } from './session-state.js';
import { ClaudeSDKProvider } from '../providers/claude-sdk.js';
import type { ClaudeSettingSource } from '../config.js';
import type { BridgeStore } from '../store/interface.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { scanClaudeSessions } from '../session-scanner.js';
import { truncate } from '../utils/string.js';
import { generateSessionId } from '../utils/id.js';
import { shortPath } from '../utils/path.js';
import {
  presentApproveFailure,
  presentApproveSuccess,
  presentApproveUsage,
  presentBashOutput,
  presentDirectory,
  presentDirectoryNotFound,
  presentEffortChanged,
  presentEffortStatus,
  presentHelp,
  presentHooksChanged,
  presentHooksStatus,
  presentModelChanged,
  presentModelStatus,
  presentNewSession,
  presentNoPairings,
  presentNoSessions,
  presentPairingUnavailable,
  presentPairings,
  presentPermissionModeChanged,
  presentPermissionModeStatus,
  presentSessionNotFound,
  presentSessions,
  presentSessionSwitched,
  presentSessionUsage,
  presentSettingsChanged,
  presentSettingsStatus,
  presentSettingsUnavailable,
  presentStatus,
  presentStopResult,
  presentVerbose,
  presentVerboseUsage,
} from './command-presenter.js';
import { areHooksPaused, pauseHooks, resumeHooks } from './hooks-state.js';

const execAsync = promisify(exec);

/** Format file size in human-readable format */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export class CommandRouter {
  constructor(
    private state: SessionStateManager,
    private getAdapters: () => Map<string, BaseChannelAdapter>,
    private router: ChannelRouter,
    private isCoreAvailable: () => boolean,
    private store: BridgeStore,
    private defaultWorkdir: string,
    private llm: LLMProvider,
    private activeControls: Map<string, QueryControls>,
    private permissions: { clearSessionWhitelist(): void },
    private onNewSession?: (channelType: string, chatId: string) => void,
  ) {}

  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const parts = msg.text.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/status': {
        const healthy = this.isCoreAvailable();
        const coreStatus = healthy ? '🟢 connected' : '🔴 disconnected';
        const channelList = Array.from(this.getAdapters().keys()).join(', ') || 'none';
        await adapter.send(presentStatus(msg.chatId, adapter.channelType, coreStatus, channelList));
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
        this.permissions.clearSessionWhitelist();

        const cwdLabel = binding?.cwd ? ` in ${shortPath(binding.cwd)}` : '';
        await adapter.send(presentNewSession(msg.chatId, adapter.channelType, cwdLabel));
        return true;
      }
      case '/verbose': {
        const level = parseInt(parts[1], 10) as VerboseLevel;
        if ([0, 1].includes(level)) {
          this.state.setVerboseLevel(msg.channelType, msg.chatId, level);
          await adapter.send(presentVerbose(msg.chatId, adapter.channelType, level));
        } else {
          await adapter.send(presentVerboseUsage(msg.chatId, adapter.channelType));
        }
        return true;
      }
      case '/perm': {
        const sub = parts[1]?.toLowerCase();
        if (sub === 'on' || sub === 'off') {
          this.state.setPermMode(msg.channelType, msg.chatId, sub);
          await adapter.send(presentPermissionModeChanged(msg.chatId, adapter.channelType, sub));
        } else {
          const current = this.state.getPermMode(msg.channelType, msg.chatId);
          await adapter.send(presentPermissionModeStatus(msg.chatId, adapter.channelType, current));
        }
        return true;
      }
      case '/stop': {
        const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
        const ctrl = this.activeControls.get(chatKey);
        if (ctrl) {
          this.activeControls.delete(chatKey);
          await ctrl.interrupt();
          await adapter.send(presentStopResult(msg.chatId, true));
        } else {
          await adapter.send(presentStopResult(msg.chatId, false));
        }
        return true;
      }
      case '/effort': {
        const LEVELS = ['low', 'medium', 'high', 'max'] as const;
        const level = parts[1]?.toLowerCase();
        if (level && LEVELS.includes(level as typeof LEVELS[number])) {
          this.state.setEffort(msg.channelType, msg.chatId, level as typeof LEVELS[number]);
          await adapter.send(presentEffortChanged(msg.chatId, level as typeof LEVELS[number]));
        } else {
          const current = this.state.getEffort(msg.channelType, msg.chatId) || 'default';
          await adapter.send(presentEffortStatus(msg.chatId, current));
        }
        return true;
      }
      case '/hooks': {
        const sub = parts[1]?.toLowerCase();
        if (sub === 'pause') {
          pauseHooks();
          await adapter.send(presentHooksChanged(msg.chatId, true));
        } else if (sub === 'resume') {
          resumeHooks();
          await adapter.send(presentHooksChanged(msg.chatId, false));
        } else {
          await adapter.send(presentHooksStatus(msg.chatId, areHooksPaused()));
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
          await adapter.send(presentNoSessions(msg.chatId, hint));
          return true;
        }

        const lines: string[] = [];
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i];
          const isCurrent = currentSdkId === s.sdkSessionId;
          const marker = isCurrent ? ' ◀' : '';
          const date = new Date(s.mtime).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          const cwdShort = shortPath(s.cwd);
          const sizeStr = formatSize(s.size);
          lines.push(`${i + 1}. ${date} · ${cwdShort} · ${sizeStr} · ${s.preview}${marker}`);
        }

        const filterHint = showAll ? ' (all projects)' : ` (${shortPath(currentCwd)})`;
        const footer = '\nUse /session <n> to switch';
        await adapter.send(presentSessions(msg.chatId, adapter.channelType, filterHint, lines, footer));
        return true;
      }
      case '/session': {
        const idx = parseInt(parts[1], 10);
        if (Number.isNaN(idx) || idx < 1) {
          await adapter.send(presentSessionUsage(msg.chatId));
          return true;
        }

        const binding = await this.store.getBinding(msg.channelType, msg.chatId);
        const currentCwd = binding?.cwd || this.defaultWorkdir;
        const sessions = scanClaudeSessions(10, currentCwd);

        if (idx > sessions.length) {
          await adapter.send(presentSessionNotFound(msg.chatId, idx));
          return true;
        }

        const target = sessions[idx - 1];

        const newBindingId = generateSessionId();
        await this.router.rebind(msg.channelType, msg.chatId, newBindingId, {
          sdkSessionId: target.sdkSessionId,
          cwd: target.cwd, // update cwd to session's directory
        });

        this.state.clearLastActive(msg.channelType, msg.chatId);

        await adapter.send(presentSessionSwitched(msg.chatId, idx, shortPath(target.cwd), target.preview));
        return true;
      }
      case '/bash': {
        const cmdText = msg.text.slice('/bash '.length).trim();
        if (!cmdText) {
          await adapter.send({ chatId: msg.chatId, text: 'Usage: /bash <command>' });
          return true;
        }

        const binding = await this.store.getBinding(msg.channelType, msg.chatId);
        const cwd = binding?.cwd || this.defaultWorkdir;

        try {
          const { stdout, stderr } = await execAsync(cmdText, {
            cwd,
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
          });

          const output = (stdout + (stderr ? '\n⚠️ stderr:\n' + stderr : '')).trim();
          const truncated = truncate(output, 3000);
          await adapter.send(presentBashOutput(msg.chatId, adapter.channelType, truncated));
        } catch (err: any) {
          const errMsg = err.stderr || err.message || String(err);
          const truncated = truncate(errMsg, 1000);
          await adapter.send({ chatId: msg.chatId, text: `❌ ${truncated}` });
        }
        return true;
      }
      case '/cd': {
        const path = parts.slice(1).join(' ').trim();

        if (!path) {
          // Show current directory
          const binding = await this.store.getBinding(msg.channelType, msg.chatId);
          const current = binding?.cwd || this.defaultWorkdir;
          await adapter.send(presentDirectory(msg.chatId, shortPath(current), true));
          return true;
        }

        // Handle ~ expansion
        const expandedPath = path.startsWith('~') ? join(homedir(), path.slice(1)) : path;

        // Resolve relative paths
        const binding = await this.store.getBinding(msg.channelType, msg.chatId);
        const baseCwd = binding?.cwd || this.defaultWorkdir;
        const resolvedPath = expandedPath.startsWith('/') ? expandedPath : join(baseCwd, expandedPath);

        if (!existsSync(resolvedPath)) {
          await adapter.send(presentDirectoryNotFound(msg.chatId, shortPath(resolvedPath)));
          return true;
        }

        // Update binding
        if (binding) {
          binding.cwd = resolvedPath;
          await this.store.saveBinding(binding);
        } else {
          await this.router.rebind(msg.channelType, msg.chatId, generateSessionId(), { cwd: resolvedPath });
        }

        await adapter.send(presentDirectory(msg.chatId, shortPath(resolvedPath), true));
        return true;
      }
      case '/pwd': {
        const binding = await this.store.getBinding(msg.channelType, msg.chatId);
        const current = binding?.cwd || this.defaultWorkdir;
        await adapter.send(presentDirectory(msg.chatId, shortPath(current)));
        return true;
      }
      case '/model': {
        const model = parts.slice(1).join(' ').trim();
        if (model) {
          if (model === 'reset' || model === 'default') {
            this.state.setModel(msg.channelType, msg.chatId, undefined);
            await adapter.send(presentModelChanged(msg.chatId));
          } else {
            this.state.setModel(msg.channelType, msg.chatId, model);
            await adapter.send(presentModelChanged(msg.chatId, model));
          }
        } else {
          const current = this.state.getModel(msg.channelType, msg.chatId) || 'default';
          await adapter.send(presentModelStatus(msg.chatId, current));
        }
        return true;
      }
      case '/settings': {
        const arg = parts[1]?.toLowerCase();

        if (!(this.llm instanceof ClaudeSDKProvider)) {
          await adapter.send(presentSettingsUnavailable(msg.chatId));
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
          await adapter.send(presentSettingsChanged(msg.chatId, labels[arg]));
        } else {
          const current = this.llm.getSettingSources();
          const preset = current.length === 0 ? 'isolated'
            : current.length === 1 && current[0] === 'user' ? 'user'
            : current.includes('project') ? 'full'
            : current.join(',');
          await adapter.send(presentSettingsStatus(msg.chatId, preset, current));
        }
        return true;
      }
      case '/help': {
        await adapter.send(presentHelp(msg.chatId, adapter.channelType));
        return true;
      }
      case '/approve': {
        const code = parts[1];
        if (!code) {
          await adapter.send(presentApproveUsage(msg.chatId));
          return true;
        }
        const tgAdapter = this.getAdapters().get('telegram');
        if (tgAdapter && 'approvePairing' in tgAdapter) {
          const result = (tgAdapter as any).approvePairing(code);
          if (result) {
            await adapter.send(presentApproveSuccess(msg.chatId, result.username, result.userId));
          } else {
            await adapter.send(presentApproveFailure(msg.chatId));
          }
        } else {
          await adapter.send(presentPairingUnavailable(msg.chatId));
        }
        return true;
      }
      case '/pairings': {
        const tgAdapter = this.getAdapters().get('telegram');
        if (tgAdapter && 'listPairings' in tgAdapter) {
          const pairings = (tgAdapter as any).listPairings() as Array<{ code: string; userId: string; username: string }>;
          if (pairings.length === 0) {
            await adapter.send(presentNoPairings(msg.chatId));
          } else {
            const lines = pairings.map(p => `• <code>${p.code}</code> — ${p.username} (${p.userId})`);
            await adapter.send(presentPairings(msg.chatId, lines));
          }
        } else {
          await adapter.send(presentPairingUnavailable(msg.chatId));
        }
        return true;
      }
      default:
        return false;
    }
  }
}
