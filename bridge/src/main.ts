import { loadConfig } from './config.js';
import { initBridgeContext } from './context.js';
import { CoreClientImpl } from './core-client.js';
import { Logger } from './logger.js';
import { JsonFileStore } from './store/json-file.js';
import { ClaudeSDKProvider } from './providers/claude-sdk.js';
import { PendingPermissions } from './permissions/gateway.js';
import { BridgeManager, type HookNotificationData } from './engine/bridge-manager.js';
import { createAdapter, loadAdapters } from './channels/index.js';
import type { ChannelType } from './channels/types.js';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { shortPath, truncate, getTliveHome, getTliveRuntimeDir } from './utils/index.js';
import { safeParseObject } from './utils/json.js';
import { CHANNEL_TYPES } from './utils/index.js';

/** Format a permission card for IM display — human-readable, not raw JSON */
function formatPermissionCard(toolName: string, input: unknown): string {
  const parts: string[] = ['🔐 Permission Required'];
  const data = safeParseObject(input as Record<string, unknown>);

  switch (toolName) {
    case 'Bash': {
      const cmd = String(data.command || '');
      const desc = data.description ? `\n${data.description}` : '';
      parts.push(`\n🖥 Bash${desc}\n\`\`\`\n${truncate(cmd, 500)}\n\`\`\``);
      break;
    }
    case 'Edit': {
      const file = shortPath(String(data.file_path || ''));
      const oldStr = String(data.old_string || '');
      const newStr = String(data.new_string || '');
      const diffLines: string[] = [];
      oldStr.split('\n').forEach(l => diffLines.push(`- ${l}`));
      newStr.split('\n').forEach(l => diffLines.push(`+ ${l}`));
      const diff = truncate(diffLines.join('\n'), 500);
      parts.push(`\n📝 Edit: \`${file}\`\n\`\`\`diff\n${diff}\n\`\`\``);
      break;
    }
    case 'Write': {
      const file = shortPath(String(data.file_path || ''));
      const content = String(data.content || '');
      parts.push(`\n📄 Write: \`${file}\` (${content.length} chars)\n\`\`\`\n${truncate(content, 200)}\n\`\`\``);
      break;
    }
    case 'Read': {
      const file = shortPath(String(data.file_path || ''));
      parts.push(`\n📖 Read: \`${file}\``);
      break;
    }
    case 'NotebookEdit': {
      const file = shortPath(String(data.file_path || ''));
      parts.push(`\n📓 NotebookEdit: \`${file}\``);
      break;
    }
    case 'Skill': {
      const skill = String(data.skill || '');
      const skillArgs = data.args ? `\nArgs: ${data.args}` : '';
      parts.push(`\n⚡ Skill: \`${skill}\`${skillArgs}`);
      break;
    }
    case 'Agent': {
      const desc = truncate(String(data.description || data.prompt || ''), 200);
      const agentType = data.subagent_type ? ` (${data.subagent_type})` : '';
      parts.push(`\n🤖 Agent${agentType}\n${desc}`);
      break;
    }
    case 'WebFetch': {
      parts.push(`\n🌐 WebFetch: \`${data.url || ''}\``);
      break;
    }
    default: {
      // MCP tools or unknown — show tool name + key fields
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
      parts.push(`\n🔧 ${toolName}\n\`\`\`\n${truncate(inputStr, 500)}\n\`\`\``);
      break;
    }
  }

  parts.push('\n⏱ Expires in 5 minutes');
  return parts.join('');
}

/** Resolve hook notification target per channel type.
 *  Feishu: prefer allowedUsers[0] via user_id (always routes to P2P chat).
 *  Telegram/Discord: use configured chatId/channelId. */
function getHookTarget(channelType: string, config: ReturnType<typeof loadConfig>, manager: BridgeManager) {
  if (channelType === CHANNEL_TYPES.TELEGRAM) {
    return { chatId: config.telegram.chatId, receiveIdType: undefined };
  }
  if (channelType === CHANNEL_TYPES.DISCORD) {
    return { chatId: config.discord.allowedChannels[0] || '', receiveIdType: undefined };
  }
  // Feishu: try user_id P2P first, fall back to lastChatId
  const userId = config.feishu.allowedUsers[0];
  if (userId) {
    const idType = userId.startsWith('ou_') ? 'open_id' : 'user_id';
    return { chatId: userId, receiveIdType: idType };
  }
  return { chatId: manager.getLastChatId(channelType), receiveIdType: undefined };
}

/** Hint text for AskUserQuestion multi-select */
function askqMultiSelectHint(channelType: string): string {
  const hints: Record<string, string> = {
    [CHANNEL_TYPES.FEISHU]: '\n\n💬 点击选项切换选中，然后按 Submit 确认',
    [CHANNEL_TYPES.TELEGRAM]: '\n\n💬 Tap options to toggle, then Submit',
    [CHANNEL_TYPES.DISCORD]: '\n\n💬 Tap options to toggle, then Submit',
  };
  return hints[channelType] || '';
}

/** Hint text for AskUserQuestion single-select */
function askqSingleSelectHint(channelType: string): string {
  const hints: Record<string, string> = {
    [CHANNEL_TYPES.FEISHU]: '\n\n💬 回复数字选择，或直接输入内容',
    [CHANNEL_TYPES.TELEGRAM]: '\n\n💬 Reply with number to select, or type your answer',
    [CHANNEL_TYPES.DISCORD]: '\n\n💬 Reply with number to select, or type your answer',
  };
  return hints[channelType] || '';
}

/** Hint text for permission approval */
function permApprovalHint(channelType: string): string {
  const hints: Record<string, string> = {
    [CHANNEL_TYPES.FEISHU]: '\n\n💬 或回复 **allow** / **deny**',
    [CHANNEL_TYPES.TELEGRAM]: '\n\n💬 Or reply <b>allow</b> / <b>deny</b>',
    [CHANNEL_TYPES.DISCORD]: '\n\n💬 Or reply `allow` / `deny`',
  };
  return hints[channelType] || '';
}

// Whether Go Core daemon is reachable (for web terminal links in IM)
let coreAvailable = false;
let coreClient: CoreClientImpl | null = null;
// Cached config (loaded once at startup)
let cachedConfig: ReturnType<typeof loadConfig> | null = null;

// Track hook permission IDs already sent to IM (avoid duplicates across polls)
// Cleanup: remove IDs older than 10 minutes (permissions expire in 5 min)
const sentPermissionIds = new Map<string, number>();
// Track notification IDs already sent to IM
const sentNotificationIds = new Map<string, number>();
// Cache session cwd — a session's cwd never changes after creation
const sessionCwdCache = new Map<string, string>();

/** Prefetch all session CWDs at startup (avoid per-poll fetching of entire session list) */
async function prefetchSessionCwds(): Promise<void> {
  try {
    const resp = await fetch(`${cachedConfig!.coreUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${cachedConfig!.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const sessions = await resp.json() as Array<{ id: string; cwd?: string }>;
      for (const s of sessions) {
        if (s.cwd) sessionCwdCache.set(s.id, s.cwd);
      }
      console.log(`[bridge] Prefetched ${sessionCwdCache.size} session CWDs`);
    }
  } catch { /* non-fatal */ }
}

/** Cleanup stale entries from tracking maps (called periodically) */
function cleanupStaleEntries(): void {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 minutes
  for (const [id, timestamp] of sentPermissionIds) {
    if (now - timestamp > maxAge) {
      sentPermissionIds.delete(id);
    }
  }
  for (const [id, timestamp] of sentNotificationIds) {
    if (now - timestamp > maxAge) {
      sentNotificationIds.delete(id);
    }
  }
}

export function isCoreAvailable(): boolean {
  return coreAvailable;
}

export function getCoreUrl(): string {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig.coreUrl;
}

function writeStatusFile(data: Record<string, unknown>): void {
  try {
    const runtimeDir = getTliveRuntimeDir();
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'status.json'), JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal — don't block startup
  }
}

async function main() {
  cachedConfig = loadConfig();
  const config = cachedConfig;
  const tliveHome = getTliveHome();

  const logger = new Logger(
    join(tliveHome, 'logs', 'bridge.log'),
    [config.token, config.telegram.botToken, config.discord.botToken, config.feishu.appSecret].filter(Boolean)
  );

  logger.info('TLive Bridge starting...');
  logger.info(`Enabled channels: ${config.enabledChannels.join(', ') || 'none'}`);

  // Write startup status
  writeStatusFile({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    channels: config.enabledChannels,
    version: '0.1.0',
  });

  // Try connecting to Go Core daemon (optional — Bridge works without it)
  coreClient = new CoreClientImpl(config.coreUrl, config.token);
  try {
    await coreClient.connect();
    coreAvailable = true;
    logger.info(`Go Core detected at ${config.coreUrl}`);
    // Prefetch all session cwds at startup (session cwd never changes)
    prefetchSessionCwds().catch(() => {});
  } catch {
    coreAvailable = false;
    coreClient = null;
    logger.info('Go Core not running — IM-only mode (no web terminal links)');
  }

  // Initialize components
  const store = new JsonFileStore(join(tliveHome, 'data'));
  const permissions = new PendingPermissions();
  const llm = new ClaudeSDKProvider(permissions, config.claudeSettingSources);

  // Initialize context
  initBridgeContext({
    store,
    llm,
    core: coreClient,
    defaultWorkdir: config.defaultWorkdir,
  });

  // Start Bridge Manager with enabled IM adapters
  const manager = new BridgeManager();
  manager.setCoreAvailable(coreAvailable);

  // Periodically re-check Core availability and cleanup stale entries
  // (defined after manager is created to avoid reference-before-definition)
  const coreStatusInterval = setInterval(async () => {
    try {
      const resp = await fetch(`${config.coreUrl}/api/status`, {
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(3000),
      });
      const newAvailable = resp.ok;
      // Only update if status changed
      if (newAvailable !== coreAvailable) {
        coreAvailable = newAvailable;
        manager.setCoreAvailable(coreAvailable);
      }
    } catch {
      if (coreAvailable) {
        coreAvailable = false;
        manager.setCoreAvailable(false);
      }
    }
  }, 30_000);

  // Cleanup stale tracking entries every 5 minutes
  const cleanupInterval = setInterval(cleanupStaleEntries, 5 * 60 * 1000);

  // Dynamically load only the adapters we need (reduces memory from ~180MB to ~60MB)
  await loadAdapters(config.enabledChannels);

  for (const channelType of config.enabledChannels) {
    try {
      const adapter = createAdapter(channelType as ChannelType);
      manager.registerAdapter(adapter);
      logger.info(`Registered ${channelType} adapter`);
    } catch (err) {
      logger.warn(`Failed to create ${channelType} adapter: ${err}`);
    }
  }

  await manager.start();
  logger.info('Bridge started');

  // Wire permission timeout → IM notification
  if (llm instanceof ClaudeSDKProvider) {
    llm.onPermissionTimeout = (toolName: string, _toolUseId: string) => {
      const text = `\u23f0 Permission timed out (5m)\nTool: ${toolName}\nAction: Denied by default`;
      for (const adapter of manager.getAdapters()) {
        const target = getHookTarget(adapter.channelType, config, manager);
        if (!target.chatId) continue;
        adapter.send({ chatId: target.chatId, receiveIdType: target.receiveIdType, text }).catch((err) => {
          logger.warn(`Failed to send timeout notification to ${adapter.channelType}: ${err}`);
        });
      }
    };
  }

  if (coreAvailable) {
    logger.info(`Web terminal available at ${config.coreUrl}`);
  }

  // Poll Go Core for pending hook permissions (if Core is available)
  const hookPollInterval = setInterval(async () => {
    if (!coreAvailable) return;
    try {
      const resp = await fetch(`${config.coreUrl}/api/hooks/pending`, {
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return;
      const pending = await resp.json() as Array<{
        id: string;
        tool_name: string;
        input: unknown;
        session_id?: string;
        permission_suggestions?: unknown[];
        created_at: string;
      }>;
      if (pending.length === 0) return;

      // Resolve unknown session cwds in one batch (session cwd never changes after creation)
      const unknownSids = [...new Set(pending.map(p => p.session_id).filter((s): s is string => !!s && !sessionCwdCache.has(s)))];
      if (unknownSids.length > 0) {
        try {
          const sessResp = await fetch(`${config.coreUrl}/api/sessions`, {
            headers: { Authorization: `Bearer ${config.token}` },
            signal: AbortSignal.timeout(3000),
          });
          if (sessResp.ok) {
            const sessions = await sessResp.json() as Array<{ id: string; cwd?: string }>;
            for (const s of sessions) {
              if (s.cwd) sessionCwdCache.set(s.id, s.cwd);
            }
          }
        } catch { /* non-fatal */ }
      }

      for (const perm of pending) {
        // Check if we already sent this permission to IM (avoid duplicates)
        if (sentPermissionIds.has(perm.id)) continue;
        sentPermissionIds.set(perm.id, Date.now());

        // Build context label consistent with hook notifications (e.g. "tlive · #5f6dea")
        const contextParts: string[] = [];
        const sessionCwd = perm.session_id ? sessionCwdCache.get(perm.session_id) : undefined;
        if (sessionCwd) contextParts.push(basename(sessionCwd));
        if (perm.session_id) contextParts.push(`#${perm.session_id.slice(-6)}`);
        const contextSuffix = contextParts.length > 0 ? ' · ' + contextParts.join(' · ') : '';

        // AskUserQuestion — render as interactive question card instead of permission card
        if (perm.tool_name === 'AskUserQuestion') {
          const sid = perm.session_id || '';
          const inputData = safeParseObject(perm.input as Record<string, unknown>);
          const questions = (inputData?.questions ?? []) as Array<{
            question: string;
            header: string;
            options: Array<{ label: string; description?: string }>;
            multiSelect: boolean;
          }>;

          if (questions.length > 0) {
            const q = questions[0];
            // Build question text with options list
            const header = q.header ? `📋 **${q.header}**\n\n` : '';
            const optionsList = q.options
              .map((opt, i) => `${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
              .join('\n');
            const questionText = `${header}${q.question}\n\n${optionsList}`;

            // Build buttons: multiSelect uses toggle+submit, singleSelect uses direct select
            const isMulti = q.multiSelect;
            const buttons: Array<{ label: string; callbackData: string; style: 'primary' | 'danger'; row?: number }> = isMulti
              ? [
                  ...q.options.map((opt, idx) => ({
                    label: `☐ ${opt.label}`,
                    callbackData: `askq_toggle:${perm.id}:${idx}:${sid}`,
                    style: 'primary' as const,
                    row: idx,
                  })),
                  { label: '✅ Submit', callbackData: `askq_submit:${perm.id}:${sid}`, style: 'primary' as const, row: q.options.length },
                  { label: '❌ Skip', callbackData: `askq_skip:${perm.id}:${sid}`, style: 'danger' as const, row: q.options.length },
                ]
              : [
                  ...q.options.map((opt, idx) => ({
                    label: `${idx + 1}. ${opt.label}`,
                    callbackData: `askq:${perm.id}:${idx}:${sid}`,
                    style: 'primary' as const,
                  })),
                  { label: '❌ Skip', callbackData: `askq_skip:${perm.id}:${sid}`, style: 'danger' as const },
                ];

            // Store question data for answer resolution
            manager.storeQuestionData(perm.id, questions, contextSuffix);

            // Send to all active IM adapters
            for (const adapter of manager.getAdapters()) {
              const target = getHookTarget(adapter.channelType, config, manager);
              if (!target.chatId) continue;

              try {
                const hint = isMulti ? askqMultiSelectHint(adapter.channelType) : askqSingleSelectHint(adapter.channelType);
                const contextHeader = contextSuffix ? `❓ Terminal${contextSuffix}\n\n` : '';
                const outMsg: import('./channels/types.js').OutboundMessage = {
                  chatId: target.chatId,
                  receiveIdType: target.receiveIdType,
                  text: adapter.channelType === CHANNEL_TYPES.FEISHU ? questionText + hint : contextHeader + questionText + hint,
                  buttons,
                  feishuHeader: adapter.channelType === CHANNEL_TYPES.FEISHU ? { template: 'blue', title: `❓ Terminal${contextSuffix}` } : undefined,
                };
                if (adapter.channelType === CHANNEL_TYPES.TELEGRAM) {
                  outMsg.html = `<b>❓ Terminal${contextSuffix}</b>\n\n` + questionText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') + hint;
                  outMsg.text = undefined;
                }
                const sendResult = await adapter.send(outMsg);
                if (perm.session_id) {
                  manager.trackHookMessage(sendResult.messageId, perm.session_id);
                }
                manager.trackPermissionMessage(sendResult.messageId, perm.id, perm.session_id || '', adapter.channelType);
              } catch (err) {
                console.warn(`Failed to send question to ${adapter.channelType}: ${err}`);
              }
            }
            continue; // Skip normal permission handling
          }
        }

        // Format tool info for IM display (human-readable)
        const text = formatPermissionCard(perm.tool_name, perm.input);

        // Build buttons: Allow, (optionally) Always Allow, Deny
        const sid = perm.session_id || '';
        const buttons: Array<{ label: string; callbackData: string; style: 'primary' | 'danger' }> = [
          { label: '✅ Allow', callbackData: `hook:allow:${perm.id}:${sid}`, style: 'primary' },
        ];
        if (perm.permission_suggestions && perm.permission_suggestions.length > 0) {
          buttons.push({ label: '📌 Always', callbackData: `hook:allow_always:${perm.id}:${sid}`, style: 'primary' });
        }
        buttons.push({ label: '❌ Deny', callbackData: `hook:deny:${perm.id}:${sid}`, style: 'danger' });

        // Send to all active IM adapters
        for (const adapter of manager.getAdapters()) {
          const target = getHookTarget(adapter.channelType, config, manager);
          if (!target.chatId) continue;

          try {
            const hint = permApprovalHint(adapter.channelType);
            const permContextHeader = contextSuffix ? `🔐 Terminal${contextSuffix}\n\n` : '';
            const outMsg: import('./channels/types.js').OutboundMessage = {
              chatId: target.chatId,
              receiveIdType: target.receiveIdType,
              text: adapter.channelType === CHANNEL_TYPES.FEISHU ? text + hint : permContextHeader + text + hint,
              buttons,
              feishuHeader: adapter.channelType === CHANNEL_TYPES.FEISHU ? { template: 'orange', title: `🔐 Terminal${contextSuffix}` } : undefined,
            };
            if (adapter.channelType === CHANNEL_TYPES.TELEGRAM) {
              outMsg.html = `<b>🔐 Terminal${contextSuffix}</b>\n\n` + text + hint;
              outMsg.text = undefined;
            }
            const sendResult = await adapter.send(outMsg);
            // Track for reply routing and permission resolution
            if (perm.session_id) {
              manager.trackHookMessage(sendResult.messageId, perm.session_id);
            }
            manager.trackPermissionMessage(sendResult.messageId, perm.id, perm.session_id || '', adapter.channelType);
            manager.storeHookPermissionText(perm.id, text);
          } catch (err) {
            logger.warn(`Failed to send permission to ${adapter.channelType}: ${err}`);
          }
        }
      }
    } catch {
      // Polling failure is non-fatal
    }
  }, 2000);

  // Record startup time to skip stale notifications from before this Bridge process started.
  const bridgeStartTime = new Date();

  // Poll Go Core for hook notifications (idle_prompt, stop, etc.)
  const notifyPollInterval = setInterval(async () => {
    if (!coreAvailable) return;
    try {
      const resp = await fetch(`${config.coreUrl}/api/hooks/notifications`, {
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return;
      const notifications = await resp.json() as Array<{ id: string; message: string; [key: string]: unknown }>;

      for (const notif of notifications) {
        if (sentNotificationIds.has(notif.id)) continue;
        sentNotificationIds.set(notif.id, Date.now());

        // Skip notifications from before this Bridge process started
        const notifTime = (notif as { timestamp?: string }).timestamp;
        if (notifTime && new Date(notifTime) < bridgeStartTime) continue;

        // Parse the stored message (raw hook JSON) to get hook data
        let hookData: HookNotificationData = notif as HookNotificationData;
        try { hookData = JSON.parse(notif.message) as HookNotificationData; } catch {}

        // Skip non-hook notifications (no tlive_hook_type means not from our scripts)
        if (!hookData.tlive_hook_type) continue;

        // Find the channel that owns this session (by sdkSessionId or sessionId)
        const sessionId = hookData.tlive_session_id;
        let targetChannel: { channelType: string; chatId: string } | null = null;

        if (sessionId) {
          // Use indexed lookup instead of O(n) scan
          const binding = await store.getBindingBySessionId(sessionId);
          if (binding) {
            targetChannel = { channelType: binding.channelType, chatId: binding.chatId };
          }
        }

        if (targetChannel) {
          // Only send to the channel that owns this session
          const adapter = manager.getAdapter(targetChannel.channelType);
          if (adapter) {
            try {
              await manager.sendHookNotification(adapter, targetChannel.chatId, hookData);
            } catch (err) {
              logger.warn(`Failed to send notification to ${targetChannel.channelType}: ${err}`);
            }
          }
        }
        // If no targetChannel found, this session was created via Web UI — don't spam IM channels
      }
    } catch {
      // Non-fatal
    }
  }, 2000);

  // Graceful shutdown
  const shutdown = async (reason = 'signal') => {
    logger.info('Shutting down...');
    clearInterval(hookPollInterval);
    clearInterval(notifyPollInterval);
    clearInterval(coreStatusInterval);
    clearInterval(cleanupInterval);
    clearInterval(keepAliveInterval);
    writeStatusFile({
      pid: process.pid,
      exitedAt: new Date().toISOString(),
      exitReason: reason,
    });
    await manager.stop();
    permissions.denyAll();
    if (coreClient) await coreClient.disconnect();
    logger.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  const keepAliveInterval = setInterval(() => {}, 60_000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
