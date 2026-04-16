import { loadConfig } from './config.js';
import { initBridgeContext } from './context.js';
import { Logger } from './logger.js';
import { JsonFileStore } from './store/json-file.js';
import { ClaudeSDKProvider } from './providers/claude-sdk.js';
import { BridgeManager } from './engine/coordinators/bridge-manager.js';
import { createAdapter, loadAdapters } from './channels/index.js';
import type { ChannelType } from './channels/types.js';
import { checkForUpdates, getCurrentVersion, isVersionNotified, markVersionNotified } from './utils/version-checker.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getTliveHome, getTliveRuntimeDir } from './core/path.js';

// Cached config (loaded once at startup)
let cachedConfig: ReturnType<typeof loadConfig> | null = null;

export function writeStatusFile(data: Record<string, unknown>): void {
  try {
    const runtimeDir = getTliveRuntimeDir();
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'status.json'), JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal — don't block startup
  }
}

/** Check upgrade result file and notify user if present */
interface UpgradeResult {
  success: boolean;
  version: string;
  previousVersion: string;
  error?: string;
  chatId?: string;
  channelType?: string;
  timestamp: string;
}

function readUpgradeResult(): UpgradeResult | null {
  const runtimeDir = getTliveRuntimeDir();
  const resultFile = join(runtimeDir, 'upgrade-result.json');
  if (!existsSync(resultFile)) return null;
  try {
    const data = JSON.parse(readFileSync(resultFile, 'utf-8')) as UpgradeResult;
    // Clean up after reading
    unlinkSync(resultFile);
    return data;
  } catch {
    return null;
  }
}

/**
 * Ensure only one bridge instance runs at a time.
 * Uses a PID file lock — kills stale processes if needed.
 */
export function acquireSingletonLock(): void {
  const runtimeDir = getTliveRuntimeDir();
  mkdirSync(runtimeDir, { recursive: true });
  const pidFile = join(runtimeDir, 'bridge.pid');

  if (existsSync(pidFile)) {
    try {
      const oldPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        // Check if process is still alive
        try {
          process.kill(oldPid, 0);
          // Process is alive — kill it
          console.warn(`[singleton] Killing existing bridge process (PID ${oldPid})`);
          process.kill(oldPid, 'SIGTERM');
          // Brief wait for graceful shutdown
          const start = Date.now();
          while (Date.now() - start < 2000) {
            try { process.kill(oldPid, 0); } catch { break; }
            // busy-wait ~50ms
            const end = Date.now() + 50;
            while (Date.now() < end) { /* spin */ }
          }
          // Force kill if still alive
          try {
            process.kill(oldPid, 0);
            process.kill(oldPid, 'SIGKILL');
            console.warn(`[singleton] Force-killed PID ${oldPid}`);
          } catch {
            // Already dead — good
          }
        } catch {
          // Process not alive — stale PID file, safe to proceed
        }
      }
    } catch {
      // Malformed PID file — overwrite
    }
  }

  // Write our PID
  writeFileSync(pidFile, String(process.pid));

  // Clean up PID file on exit
  const cleanPid = () => {
    try {
      const current = readFileSync(pidFile, 'utf-8').trim();
      if (current === String(process.pid)) {
        unlinkSync(pidFile);
      }
    } catch { /* ignore */ }
  };
  process.on('exit', cleanPid);
}

export async function main() {
  // Ensure only one bridge instance runs
  acquireSingletonLock();

  cachedConfig = loadConfig();
  const config = cachedConfig;
  const tliveHome = getTliveHome();

  const logger = new Logger(
    join(tliveHome, 'logs', 'bridge.log'),
    [config.token, config.telegram.botToken, config.feishu.appSecret].filter(Boolean)
  );
  logger.installConsoleInterception();

  logger.info('TLive Bridge starting...');
  logger.info(`Enabled channels: ${config.enabledChannels.join(', ') || 'none'}`);

  // Write startup status
  writeStatusFile({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    channels: config.enabledChannels,
    version: getCurrentVersion(),
  });

  // Initialize components
  const store = new JsonFileStore(join(tliveHome, 'data'));
  const llm = new ClaudeSDKProvider(config.claudeSettingSources);

  // Initialize context
  initBridgeContext({
    store,
    llm,
    defaultWorkdir: config.defaultWorkdir,
  });

  // Start Bridge Manager with enabled IM adapters
  const manager = new BridgeManager({ store, llm, defaultWorkdir: config.defaultWorkdir, config });

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

  // Check for upgrade result from previous session and notify user
  const upgradeResult = readUpgradeResult();
  if (upgradeResult) {
    const { success, version, previousVersion, error, chatId, channelType } = upgradeResult;
    const text = success
      ? `✅ 升级成功\n版本: v${previousVersion} → v${version}\n查看更新: https://github.com/huanghuoguoguo/tlive/releases`
      : `❌ 升级失败\n错误: ${error || 'Unknown error'}\n版本: v${previousVersion}`;

    // Send to specific chat if we have the info, otherwise broadcast
    if (chatId && channelType) {
      const adapter = manager.getAdapter(channelType);
      if (adapter) {
        adapter.send({ chatId, text }).catch((err) => {
          logger.warn(`Failed to send upgrade result to ${channelType}: ${err}`);
        });
      } else {
        // Fallback to broadcast if adapter not available
        manager.broadcastText(text).catch(() => {});
      }
    } else {
      manager.broadcastText(text).catch(() => {});
    }
    logger.info(`Upgrade result: ${success ? 'success' : 'failed'} (${previousVersion} → ${version})`);
  }

  // Wire permission timeout → IM notification
  if (llm instanceof ClaudeSDKProvider) {
    llm.onPermissionTimeout = (toolName: string, _toolUseId: string) => {
      const text = `\u23f0 Permission timed out (5m)\nTool: ${toolName}\nAction: Denied by default`;
      manager.broadcastText(text).catch((err) => {
        logger.warn(`Failed to send timeout notification: ${err}`);
      });
    };
  }

  // Version check: startup + periodic
  // Each version is only notified once automatically (stored in notified-versions.json)

  const checkAndNotifyUpdate = async () => {
    try {
      const info = await checkForUpdates();
      if (info?.hasUpdate && !isVersionNotified(info.latest)) {
        logger.info(`New version available: v${info.latest} (current: v${info.current})`);
        await manager.broadcastFormatted({
          type: 'versionUpdate',
          data: {
            current: info.current,
            latest: info.latest,
            publishedAt: info.publishedAt,
          },
        }).catch(() => {});
        // Mark as notified after successful broadcast
        markVersionNotified(info.latest);
      }
    } catch (err) {
      logger.warn(`Version check failed: ${err}`);
    }
  };

  // Check on startup (after 30s delay to let things settle)
  setTimeout(() => checkAndNotifyUpdate(), 30_000);
  // Check every 6 hours
  const versionCheckInterval = setInterval(() => checkAndNotifyUpdate(), 6 * 60 * 60 * 1000);

  logger.info(`TLive Bridge v${getCurrentVersion()} started`);

  // Graceful shutdown
  const shutdown = async (reason = 'signal') => {
    logger.info('Shutting down...');
    clearInterval(versionCheckInterval);
    clearInterval(keepAliveInterval);
    writeStatusFile({
      pid: process.pid,
      exitedAt: new Date().toISOString(),
      exitReason: reason,
    });
    await manager.stop();
    logger.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  const keepAliveInterval = setInterval(() => {}, 60_000);
}

export function shouldRunMain(entryArg = process.argv[1]): boolean {
  if (!entryArg) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(entryArg).href;
  } catch {
    return false;
  }
}

if (shouldRunMain()) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
