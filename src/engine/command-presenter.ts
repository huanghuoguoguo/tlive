/**
 * Command presenters - return semantic message data.
 * Platform-specific formatting is handled by adapters.
 */

import type {
  StatusData,
  HomeData,
  PermissionStatusData,
  TaskStartData,
  SessionsData,
  SessionDetailData,
  HelpData,
  NewSessionData,
  FormattableMessage,
} from '../formatting/message-types.js';

export function presentStatus(chatId: string, data: StatusData): FormattableMessage {
  return { type: 'status', chatId, data };
}

export function presentNewSession(chatId: string, data: NewSessionData): FormattableMessage {
  return { type: 'newSession', chatId, data };
}

export function presentHome(chatId: string, data: HomeData): FormattableMessage {
  return { type: 'home', chatId, data };
}

export function presentPermissionStatus(chatId: string, data: PermissionStatusData): FormattableMessage {
  return { type: 'permissionStatus', chatId, data };
}

export function presentTaskStart(chatId: string, data: TaskStartData): FormattableMessage {
  return { type: 'taskStart', chatId, data };
}

export function presentSessions(chatId: string, data: SessionsData): FormattableMessage {
  return { type: 'sessions', chatId, data };
}

export function presentSessionDetail(chatId: string, data: SessionDetailData): FormattableMessage {
  return { type: 'sessionDetail', chatId, data };
}

export function presentHelp(chatId: string, data: HelpData): FormattableMessage {
  return { type: 'help', chatId, data };
}

// --- Simple text messages (no platform-specific formatting needed) ---

export interface SimpleTextData {
  text: string;
}

export function presentPermissionModeChanged(chatId: string, mode: 'on' | 'off'): { chatId: string; text: string } {
  const text = mode === 'on'
    ? '🔐 Permission prompts: ON — dangerous tools will ask for confirmation'
    : '⚡ Permission prompts: OFF — all tools auto-allowed';
  return { chatId, text };
}

export function presentPermissionModeStatus(chatId: string, current: string): { chatId: string; text: string } {
  const text = `🔐 Permission mode: **${current}**\nUsage: \`/perm on|off\`\non = prompt for dangerous tools (default)\noff = auto-allow all`;
  return { chatId, text };
}

export function presentStopResult(chatId: string, interrupted: boolean): { chatId: string; text: string } {
  return { chatId, text: interrupted ? '⏹ Interrupted current execution' : '⚠️ No active execution to stop' };
}

export function presentHooksStatus(chatId: string, paused: boolean): { chatId: string; text: string } {
  return { chatId, text: `Hooks: ${paused ? '⏸ paused' : '▶ active'}` };
}

export function presentHooksChanged(chatId: string, paused: boolean): { chatId: string; text: string } {
  return { chatId, text: paused ? '⏸ Hooks paused — auto-allow, no notifications.' : '▶ Hooks resumed — forwarding to IM.' };
}

export function presentNoSessions(chatId: string, hint: string): { chatId: string; text: string } {
  return { chatId, text: `No sessions found${hint}` };
}

export function presentSessionUsage(chatId: string): { chatId: string; text: string } {
  return { chatId, text: 'Usage: /session <number>\nUse /sessions to list.' };
}

export function presentSessionNotFound(chatId: string, idx: number): { chatId: string; text: string } {
  return { chatId, text: `Session ${idx} not found. Use /sessions to list.` };
}

export function presentSessionSwitched(chatId: string, idx: number, cwd: string, preview: string): { chatId: string; text: string } {
  return { chatId, text: `🔄 Switched to session ${idx}\n${cwd} · ${preview}` };
}

export function presentDirectory(chatId: string, cwd: string, withIcon = false): { chatId: string; text: string } {
  return { chatId, text: withIcon ? `📂 ${cwd}` : cwd };
}

export function presentDirectoryNotFound(chatId: string, path: string): { chatId: string; text: string } {
  return { chatId, text: `❌ Directory not found: ${path}` };
}

export function presentSettingsUnavailable(chatId: string): { chatId: string; text: string } {
  return { chatId, text: '⚠️ Settings only available for Claude provider' };
}

export function presentSettingsChanged(chatId: string, label: string): { chatId: string; text: string } {
  return { chatId, text: `⚙️ Settings: ${label}` };
}

export function presentSettingsStatus(
  chatId: string,
  preset: string,
  current: string[],
  scope: 'default' | 'chat override' = 'default',
): { chatId: string; text: string } {
  return {
    chatId,
    text: `⚙️ Settings (${scope}): **${preset}** (${current.join(', ') || 'none'})\nUsage: \`/settings user|full|isolated\`\n  user — ~/.claude/settings.json (auth, model)\n  full — + CLAUDE.md, MCP servers, skills\n  isolated — no external settings`,
  };
}

export function presentApproveUsage(chatId: string): { chatId: string; text: string } {
  return { chatId, text: 'Usage: /approve <pairing_code>' };
}

export function presentApproveSuccess(chatId: string, username: string, userId: string): { chatId: string; text: string } {
  return { chatId, text: `✅ Approved user ${username} (${userId})` };
}

export function presentApproveFailure(chatId: string): { chatId: string; text: string } {
  return { chatId, text: '❌ Code not found or expired' };
}

export function presentPairingUnavailable(chatId: string): { chatId: string; text: string } {
  return { chatId, text: '⚠️ Pairing not available' };
}

export function presentNoPairings(chatId: string): { chatId: string; text: string } {
  return { chatId, text: 'No pending pairing requests.' };
}

export function presentPairings(chatId: string, lines: string[]): { chatId: string; text: string } {
  return { chatId, text: `🔐 **Pending Pairings**\n\n${lines.join('\n')}\n\nUse /approve <code> to approve.` };
}

// --- Version/Upgrade messages ---

export interface VersionCheckData {
  current: string;
  latest: string;
  hasUpdate: boolean;
  publishedAt?: string;
}

export interface UpgradeResultData {
  success: boolean;
  version?: string;
  error?: string;
}

export function presentVersionCheck(chatId: string, info: VersionCheckData): FormattableMessage {
  // Use a generic 'notification' type for version check
  // The formatter will handle platform-specific rendering
  const summary = info.hasUpdate
    ? `Current: v${info.current}\nLatest: v${info.latest}`
    : `You're on the latest version: v${info.current}`;

  return {
    type: 'notification',
    chatId,
    data: {
      type: 'generic',
      title: info.hasUpdate ? '🔄 Update Available' : '✅ Up to Date',
      summary,
    },
  };
}

export function presentUpgradeResult(chatId: string, result: UpgradeResultData): FormattableMessage {
  return {
    type: 'notification',
    chatId,
    data: {
      type: result.success ? 'stop' : 'generic',
      title: result.success ? '⬆️ Upgrade Complete' : '❌ Upgrade Failed',
      summary: result.success
        ? `Version: v${result.version}\nRestart tlive to apply changes.`
        : result.error || 'Unknown error',
    },
  };
}

export function presentUpgradeCommand(chatId: string): { chatId: string; text: string } {
  const cmd = 'curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash';
  return { chatId, text: `Manual upgrade:\n\`\`\`\n${cmd}\n\`\`\`` };
}

export function presentRestartResult(chatId: string): { chatId: string; text: string } {
  return { chatId, text: '🔄 Restarting... The service will reconnect in a few seconds.' };
}

export function presentVersionSkipped(chatId: string, version: string): { chatId: string; text: string } {
  return { chatId, text: `⏭️ Skipped version v${version}\n\nYou will be notified when a newer version is available.` };
}

export function presentVersionUnskipped(chatId: string): { chatId: string; text: string } {
  return { chatId, text: '↩️ Update notifications re-enabled.' };
}
