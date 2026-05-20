import { loadConfig } from './config.js';
import { initBridgeContext } from './context.js';
import { Logger } from './logger.js';
import { JsonFileStore } from './store/json-file.js';
import { ClaudeSDKProvider } from './providers/claude-sdk.js';
import { BridgeManager } from './engine/coordinators/bridge-manager.js';
import { FeishuAdapter } from './channels/feishu/adapter.js';
import { checkForUpdates, getCurrentVersion, isVersionNotified, markVersionNotified } from './utils/version-checker.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getTliveHome, getTliveRuntimeDir, readRestartRequest, deleteRestartRequest } from './core/path.js';

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
  attempts?: number;
  lastError?: string;
}

function readUpgradeResult(): UpgradeResult | null {
  const runtimeDir = getTliveRuntimeDir();
  const resultFile = join(runtimeDir, 'upgrade-result.json');
  if (!existsSync(resultFile)) return null;
  try {
    const data = JSON.parse(readFileSync(resultFile, 'utf-8')) as UpgradeResult;
    return data;
  } catch {
    return null;
  }
}

function writeUpgradeResult(data: UpgradeResult): void {
  const runtimeDir = getTliveRuntimeDir();
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, 'upgrade-result.json'), JSON.stringify(data, null, 2));
}

function deleteUpgradeResult(): void {
  try {
    unlinkSync(join(getTliveRuntimeDir(), 'upgrade-result.json'));
  } catch {}
}

/**
 * Ensure only one bridge instance runs at a time.
 * Uses a PID file lock — kills stale processes if needed.
 * Supports restart handoff via restart-request.json marker.
 */
export function acquireSingletonLock(): void {
  const runtimeDir = getTliveRuntimeDir();
  mkdirSync(runtimeDir, { recursive: true });
  const pidFile = join(runtimeDir, 'bridge.pid');

  // Check for restart handoff marker
  const restartRequest = readRestartRequest();
  if (restartRequest && restartRequest.oldPid !== process.pid) {
    console.log(`[singleton] Restart handoff detected (old PID ${restartRequest.oldPid})`);
    // Wait for old process to exit (up to 5s)
    const start = Date.now();
    const maxWait = 5000;
    while (Date.now() - start < maxWait) {
      try {
        process.kill(restartRequest.oldPid, 0);
        // Old process still alive, wait 100ms
        const end = Date.now() + 100;
        while (Date.now() < end) { /* spin */ }
      } catch {
        // Old process exited
        break;
      }
    }
    // Clean up restart marker
    deleteRestartRequest();
    console.log('[singleton] Restart handoff complete');
  }

  if (existsSync(pidFile)) {
    try {
      const oldPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        // Skip killing if this is a restart handoff (oldPid matches restart request)
        const wasRestartHandoff = restartRequest && restartRequest.oldPid === oldPid;
        if (!wasRestartHandoff) {
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
    [config.token, config.feishu.appSecret].filter(Boolean)
  );
  logger.installConsoleInterception();

  logger.info('TLive Bridge starting...');
  logger.info('Enabled channel: feishu');

  const startedAt = new Date().toISOString();

  // Write startup status
  writeStatusFile({
    pid: process.pid,
    startedAt,
    channels: ['feishu'],
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
  manager.registerAdapter(new FeishuAdapter(config.feishu));
  logger.info('Registered feishu adapter');

  await manager.start();
  logger.info('Bridge started');
  writeStatusFile({
    pid: process.pid,
    startedAt,
    readyAt: new Date().toISOString(),
    channels: ['feishu'],
    version: getCurrentVersion(),
  });

  // Check for upgrade result from previous session and notify user
  const upgradeResult = readUpgradeResult();
  if (upgradeResult) {
    const { success, version, previousVersion, error, chatId, channelType } = upgradeResult;
    const text = success
      ? `✅ 升级成功\n版本: v${previousVersion} → v${version}\n查看更新: https://github.com/huanghuoguoguo/tlive/releases`
      : `❌ 升级失败\n错误: ${error || 'Unknown error'}\n版本: v${previousVersion}`;

    let delivered = false;
    try {
      if (chatId && channelType) {
        const adapter = manager.getAdapter(channelType);
        if (adapter) {
          await adapter.send({ chatId, text });
          delivered = true;
        }
      }
      if (!delivered) {
        await manager.broadcastText(text);
        delivered = true;
      }
    } catch (err) {
      logger.warn(`Failed to send upgrade result notification: ${err}`);
    }

    if (delivered) {
      deleteUpgradeResult();
    } else {
      writeUpgradeResult({
        ...upgradeResult,
        attempts: (upgradeResult.attempts ?? 0) + 1,
        lastError: 'Failed to send upgrade result notification',
      });
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
    // Clean up restart marker if not a restart handoff
    deleteRestartRequest();
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

  // Global error boundary - prevent process crash from unhandled async exceptions
  const FATAL_ERROR_CODES = new Set(['EMFILE', 'ENOMEM', 'EADDRINUSE']);

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`[global] Unhandled rejection: ${msg}`);
    if (reason instanceof Error && reason.stack) {
      console.error(reason.stack.split('\n').slice(0, 5).join('\n'));
    }
  });

  process.on('uncaughtException', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(`[global] Uncaught exception: ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(0, 5).join('\n'));
    }
    if (code && FATAL_ERROR_CODES.has(code)) {
      console.error(`[global] Fatal system error (${code}), initiating shutdown`);
      shutdown(`uncaughtException:${code}`).catch(() => process.exit(1));
    }
  });

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
