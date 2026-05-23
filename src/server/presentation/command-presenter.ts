/**
 * Command presenters - return semantic message data.
 * Platform-specific formatting is handled by adapters.
 */

import type {
  StatusData,
  HomeData,
  PermissionStatusData,
  HelpData,
  NewSessionData,
  DiagnoseData,
  FormattableMessage,
} from '../../shared/formatting/message-types.js';
import { t, type Locale } from '../../shared/i18n/index.js';

export function presentStatus(chatId: string, data: StatusData): FormattableMessage {
  return { type: 'status', chatId, data };
}

export function presentNewSession(chatId: string, data: NewSessionData): FormattableMessage {
  return { type: 'newSession', chatId, data };
}

export function presentHome(chatId: string, data: HomeData): FormattableMessage {
  return { type: 'home', chatId, data };
}

export function presentPermissionStatus(
  chatId: string,
  data: PermissionStatusData,
): FormattableMessage {
  return { type: 'permissionStatus', chatId, data };
}

export function presentHelp(chatId: string, data: HelpData): FormattableMessage {
  return { type: 'help', chatId, data };
}

// --- Simple text messages (no platform-specific formatting needed) ---

export function presentStopResult(
  chatId: string,
  interrupted: boolean,
  _locale: Locale = 'zh',
): { chatId: string; text: string } {
  return {
    chatId,
    text: interrupted
      ? t('presenter.stopInterrupted')
      : t('presenter.stopNoExecution'),
  };
}

export function presentDirectory(
  chatId: string,
  cwd: string,
  withIcon = false,
  feedbackText?: string,
): { chatId: string; text: string } {
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
  _locale: Locale = 'zh',
): { chatId: string; text: string } {
  const lines = [t('presenter.currentDir') + current];

  if (workspaceBinding && workspaceBinding !== current) {
    lines.push(t('presenter.workspaceBinding') + workspaceBinding);
  }

  if (history.length > 1) {
    lines.push('');
    lines.push(t('presenter.dirHistory'));
    history.slice(0, 5).forEach((dir, i) => {
      const marker = i === 0 ? '●' : `${i}.`;
      lines.push(`  ${marker} ${dir}`);
    });
    if (history.length > 5) {
      lines.push(t('presenter.totalCount').replace('{count}', String(history.length)));
    }
    lines.push('');
    lines.push(t('presenter.cdHint'));
  }

  return { chatId, text: lines.join('\n') };
}

export function presentDirectoryNotFound(
  chatId: string,
  path: string,
): { chatId: string; text: string } {
  return { chatId, text: `❌ Directory not found: ${path}` };
}

export function presentSettingsUnavailable(
  chatId: string,
  _locale: Locale = 'zh',
): { chatId: string; text: string } {
  return { chatId, text: t('presenter.settingsUnavailable') };
}

export function presentSettingsChanged(
  chatId: string,
  label: string,
): { chatId: string; text: string } {
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
    text: `⚙️ Settings (${scope}): **${preset}** (${current.join(', ') || 'none'})\nUsage: \`/settings user|full|isolated\`\n  user — user-level settings\n  full — user + project + local settings\n  isolated — no external settings`,
  };
}

// --- Version/Upgrade messages ---

function getManualInstallCommand(
  platform: NodeJS.Platform = process.platform,
  version?: string,
): string {
  const normalizedVersion = version?.trim() ? version.trim().replace(/^v/i, '') : '';
  if (platform === 'win32') {
    const versionArg = normalizedVersion ? ` '${normalizedVersion}'` : '';
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'tlive-install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.ps1' -UseBasicParsing -OutFile $tmp; & $tmp${versionArg}"`;
  }

  return normalizedVersion
    ? `curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash -s -- v${normalizedVersion}`
    : 'curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash';
}

export function presentUpgradeCommand(
  chatId: string,
  platform: NodeJS.Platform = process.platform,
): { chatId: string; text: string } {
  const cmd = getManualInstallCommand(platform);
  return { chatId, text: `Manual upgrade:\n\`\`\`\n${cmd}\n\`\`\`` };
}

export function presentRestartResult(chatId: string): { chatId: string; text: string } {
  return { chatId, text: '🔄 Restarting... The service will reconnect in a few seconds.' };
}

// --- Diagnose messages ---

export function presentDiagnose(chatId: string, data: DiagnoseData): FormattableMessage {
  return { type: 'diagnose', chatId, data };
}
