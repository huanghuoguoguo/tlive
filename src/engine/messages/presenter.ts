/**
 * Command presenters - return semantic message data.
 * Platform-specific formatting is handled by adapters.
 */

import type {
  StatusData,
  HomeData,
  PermissionStatusData,
  SessionsData,
  SessionDetailData,
  HelpData,
  NewSessionData,
  ProjectListData,
  QueueStatusData,
  DiagnoseData,
  FormattableMessage,
} from '../../formatting/message-types.js';

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

export function presentSessions(chatId: string, data: SessionsData): FormattableMessage {
  return { type: 'sessions', chatId, data };
}

export function presentSessionDetail(chatId: string, data: SessionDetailData): FormattableMessage {
  return { type: 'sessionDetail', chatId, data };
}

export function presentHelp(chatId: string, data: HelpData): FormattableMessage {
  return { type: 'help', chatId, data };
}

export function presentProjectList(chatId: string, data: ProjectListData): FormattableMessage {
  return { type: 'projectList', chatId, data };
}

// --- Simple text messages (no platform-specific formatting needed) ---

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

export function presentSessionSwitched(chatId: string, idx: number, cwd: string, preview: string, feedbackText?: string): { chatId: string; text: string } {
  const lines = [];
  if (feedbackText) lines.push(feedbackText);
  lines.push(`🔄 Switched to session ${idx}`);
  lines.push(`${cwd} · ${preview}`);
  return { chatId, text: lines.join('\n') };
}

export function presentDirectory(chatId: string, cwd: string, withIcon = false, feedbackText?: string): { chatId: string; text: string } {
  const lines = [];
  if (feedbackText) lines.push(feedbackText);
  lines.push(withIcon ? `📂 ${cwd}` : cwd);
  return { chatId, text: lines.join('\n') };
}

export function presentDirectoryHistory(
  chatId: string,
  current: string,
  history: string[],
  workspaceBinding?: string,
): { chatId: string; text: string } {
  const lines = [`📂 当前目录：${current}`];

  if (workspaceBinding && workspaceBinding !== current) {
    lines.push(`🏠 工作区绑定：${workspaceBinding}`);
  }

  if (history.length > 1) {
    lines.push('');
    lines.push('📋 目录历史：');
    history.slice(0, 5).forEach((dir, i) => {
      const marker = i === 0 ? '●' : `${i}.`;
      lines.push(`  ${marker} ${dir}`);
    });
    if (history.length > 5) {
      lines.push(`  ... 共 ${history.length} 个`);
    }
    lines.push('');
    lines.push('💡 使用 /cd - 返回上一目录');
  }

  return { chatId, text: lines.join('\n') };
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

function getManualInstallCommand(platform: NodeJS.Platform = process.platform, version?: string): string {
  const normalizedVersion = version?.trim() ? version.trim().replace(/^v/i, '') : '';
  if (platform === 'win32') {
    const versionArg = normalizedVersion ? ` '${normalizedVersion}'` : '';
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'tlive-install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.ps1' -UseBasicParsing -OutFile $tmp; & $tmp${versionArg}"`;
  }

  return normalizedVersion
    ? `curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash -s -- v${normalizedVersion}`
    : 'curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash';
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

export function presentUpgradeCommand(chatId: string, platform: NodeJS.Platform = process.platform): { chatId: string; text: string } {
  const cmd = getManualInstallCommand(platform);
  return { chatId, text: `Manual upgrade:\n\`\`\`\n${cmd}\n\`\`\`` };
}

export function presentRestartResult(chatId: string): { chatId: string; text: string } {
  return { chatId, text: '🔄 Restarting... The service will reconnect in a few seconds.' };
}

// --- Queue/Diagnose messages ---

export function presentQueueStatus(chatId: string, data: QueueStatusData): FormattableMessage {
  return { type: 'queueStatus', chatId, data };
}

export function presentDiagnose(chatId: string, data: DiagnoseData): FormattableMessage {
  return { type: 'diagnose', chatId, data };
}
