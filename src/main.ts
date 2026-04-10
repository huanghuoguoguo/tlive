import { loadConfig } from './config.js';
import { initBridgeContext } from './context.js';
import { Logger } from './logger.js';
import { JsonFileStore } from './store/json-file.js';
import { ClaudeSDKProvider } from './providers/claude-sdk.js';
import { BridgeManager } from './engine/bridge-manager.js';
import { createAdapter, loadAdapters } from './channels/index.js';
import type { ChannelType } from './channels/types.js';
import { checkForUpdates, getCurrentVersion } from './engine/version-checker.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { getTliveHome, getTliveRuntimeDir } from './utils/index.js';

// Cached config (loaded once at startup)
let cachedConfig: ReturnType<typeof loadConfig> | null = null;

function writeStatusFile(data: Record<string, unknown>): void {
  try {
    const runtimeDir = getTliveRuntimeDir();
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'status.json'), JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal — don't block startup
  }
}

/**
 * Ensure only one bridge instance runs at a time.
 * Uses a PID file lock — kills stale processes if needed.
 */
function acquireSingletonLock(): void {
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

async function main() {
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

  // Wire permission timeout → IM notification
  if (llm instanceof ClaudeSDKProvider) {
    llm.onPermissionTimeout = (toolName: string, _toolUseId: string) => {
      const text = `\u23f0 Permission timed out (5m)\nTool: ${toolName}\nAction: Denied by default`;
      manager.broadcastText(text).catch((err) => {
        logger.warn(`Failed to send timeout notification: ${err}`);
      });
    };
  }

  // Version check: startup + every 6 hours
  const checkAndNotifyUpdate = async () => {
    try {
      const info = await checkForUpdates();
      if (info?.hasUpdate) {
        logger.info(`New version available: v${info.latest} (current: v${info.current})`);
        await manager.broadcastFormatted({
          type: 'versionUpdate',
          data: {
            current: info.current,
            latest: info.latest,
            publishedAt: info.publishedAt,
          },
        }).catch(() => {});
      }
    } catch (err) {
      logger.warn(`Version check failed: ${err}`);
    }
  };

  // Check on startup (after 30s delay to let things settle)
  setTimeout(checkAndNotifyUpdate, 30_000);
  // Check every 6 hours
  const versionCheckInterval = setInterval(checkAndNotifyUpdate, 6 * 60 * 60 * 1000);

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

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
