import { loadConfig } from './config.js';
import { initBridgeContext } from './context.js';
import { CoreClientImpl } from './core-client.js';
import { Logger } from './logger.js';
import { JsonFileStore } from './store/json-file.js';
import { resolveProvider } from './providers/index.js';
import { PendingPermissions } from './permissions/gateway.js';
import { BridgeManager } from './engine/bridge-manager.js';
import { createAdapter } from './channels/index.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';

// Whether Go Core daemon is reachable (for web terminal links in IM)
let coreAvailable = false;
let coreClient: CoreClientImpl | null = null;

// Track hook permission IDs already sent to IM (avoid duplicates across polls)
const sentPermissionIds = new Set<string>();

export function isCoreAvailable(): boolean {
  return coreAvailable;
}

export function getCoreUrl(): string {
  const config = loadConfig();
  return config.publicUrl || config.coreUrl;
}

function writeStatusFile(tliveHome: string, data: Record<string, unknown>): void {
  try {
    const runtimeDir = join(tliveHome, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'status.json'), JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal — don't block startup
  }
}

async function main() {
  const config = loadConfig();
  const tliveHome = join(homedir(), '.tlive');

  const logger = new Logger(
    join(tliveHome, 'logs', 'bridge.log'),
    [config.token, config.telegram.botToken, config.discord.botToken, config.feishu.appSecret].filter(Boolean)
  );

  logger.info('TLive Bridge starting...');
  logger.info(`Enabled channels: ${config.enabledChannels.join(', ') || 'none'}`);

  // Write startup status
  writeStatusFile(tliveHome, {
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
  } catch {
    coreAvailable = false;
    coreClient = null;
    logger.info('Go Core not running — IM-only mode (no web terminal links)');
  }

  // Periodically re-check Core availability
  setInterval(async () => {
    try {
      const resp = await fetch(`${config.coreUrl}/api/status`, {
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(3000),
      });
      coreAvailable = resp.ok;
      manager.setCoreAvailable(coreAvailable);
    } catch {
      coreAvailable = false;
      manager.setCoreAvailable(false);
    }
  }, 30_000);

  // Initialize components
  const store = new JsonFileStore(join(tliveHome, 'data'));
  const permissions = new PendingPermissions();
  const llm = resolveProvider(config.runtime, permissions);

  // Initialize context
  initBridgeContext({
    store,
    llm,
    permissions: permissions as any,
    core: (coreClient ?? {}) as any,
  });

  // Start Bridge Manager with enabled IM adapters
  const manager = new BridgeManager();
  manager.setCoreAvailable(coreAvailable);

  for (const channelType of config.enabledChannels) {
    try {
      const adapter = createAdapter(channelType as any);
      manager.registerAdapter(adapter);
      logger.info(`Registered ${channelType} adapter`);
    } catch (err) {
      logger.warn(`Failed to create ${channelType} adapter: ${err}`);
    }
  }

  await manager.start();
  logger.info('Bridge started');

  if (coreAvailable) {
    const webUrl = config.publicUrl || config.coreUrl;
    logger.info(`Web terminal available at ${webUrl}`);
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
        created_at: string;
      }>;

      for (const perm of pending) {
        // Check if we already sent this permission to IM (avoid duplicates)
        if (sentPermissionIds.has(perm.id)) continue;
        sentPermissionIds.add(perm.id);

        // Format tool info for IM display
        const inputStr = typeof perm.input === 'string'
          ? perm.input
          : JSON.stringify(perm.input, null, 2);
        const truncatedInput = inputStr.length > 500 ? inputStr.slice(0, 497) + '...' : inputStr;

        const text = `[Local] 🔒 Permission Required\n\nTool: \`${perm.tool_name}\`\n\`\`\`\n${truncatedInput}\n\`\`\`\n\n⏱ Expires in 5 minutes`;

        // Send to all active IM adapters with Allow/Deny buttons
        for (const adapter of manager.getAdapters()) {
          const chatId = config.telegram.chatId;
          if (!chatId) continue;

          try {
            const sendResult = await adapter.send({
              chatId,
              text,
              buttons: [
                { label: '✅ Allow', callbackData: `hook:allow:${perm.id}`, style: 'primary' as const },
                { label: '❌ Deny', callbackData: `hook:deny:${perm.id}`, style: 'danger' as const },
              ],
            });
            // Track for reply routing (perm may have tlive_session_id from hook script)
            if ((perm as any).tlive_session_id) {
              manager.trackHookMessage(sendResult.messageId, (perm as any).tlive_session_id);
            }
          } catch (err) {
            logger.warn(`Failed to send permission to ${adapter.channelType}: ${err}`);
          }
        }
      }
    } catch {
      // Polling failure is non-fatal
    }
  }, 2000);

  // Track notification IDs already sent to IM
  const sentNotificationIds = new Set<string>();

  // Poll Go Core for hook notifications (idle_prompt, stop, etc.)
  const notifyPollInterval = setInterval(async () => {
    if (!coreAvailable) return;
    try {
      const resp = await fetch(`${config.coreUrl}/api/hooks/notifications`, {
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return;
      const notifications = await resp.json() as Array<any>;

      for (const notif of notifications) {
        const notifId = notif.id || notif.timestamp || JSON.stringify(notif).slice(0, 50);
        if (sentNotificationIds.has(notifId)) continue;
        sentNotificationIds.add(notifId);

        for (const adapter of manager.getAdapters()) {
          // Use the first configured chat ID for notifications
          const chatId = config.telegram.chatId || config.discord.allowedChannels[0] || '';
          if (!chatId) continue;
          try {
            await manager.sendHookNotification(adapter, chatId, notif);
          } catch (err) {
            logger.warn(`Failed to send notification to ${adapter.channelType}: ${err}`);
          }
        }
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
    writeStatusFile(tliveHome, {
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
  setInterval(() => {}, 60_000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
