import { loadConfig } from './config.js';
import { initBridgeContext } from './context.js';
import { CoreClientImpl } from './core-client.js';
import { Logger } from './logger.js';
import { JsonFileStore } from './store/json-file.js';
import { ClaudeSDKProvider } from './providers/claude-sdk.js';
import { BridgeManager } from './engine/bridge-manager.js';
import { CoreHookBridge } from './engine/core-hook-bridge.js';
import { createAdapter, loadAdapters } from './channels/index.js';
import type { ChannelType } from './channels/types.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getTliveHome, getTliveRuntimeDir } from './utils/index.js';

// Whether Go Core daemon is reachable (for web terminal links in IM)
let coreAvailable = false;
let coreClient: CoreClientImpl | null = null;
// Cached config (loaded once at startup)
let cachedConfig: ReturnType<typeof loadConfig> | null = null;

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

  // Initialize components
  const store = new JsonFileStore(join(tliveHome, 'data'));
  const llm = new ClaudeSDKProvider(config.claudeSettingSources);

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

  // Initialize context
  initBridgeContext({
    store,
    llm,
    core: coreClient,
    defaultWorkdir: config.defaultWorkdir,
  });

  // Start Bridge Manager with enabled IM adapters
  const manager = new BridgeManager({ store, llm, defaultWorkdir: config.defaultWorkdir, config });
  manager.setCoreAvailable(coreAvailable);
  const hookBridge = new CoreHookBridge({
    config,
    logger,
    manager,
    store,
    isCoreAvailable: () => coreAvailable,
  });
  if (coreAvailable) {
    hookBridge.prefetchSessionCwds().catch(() => {});
  }

  // Periodically re-check Core availability
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
  hookBridge.start();
  logger.info('Bridge started');

  // Wire permission timeout → IM notification
  if (llm instanceof ClaudeSDKProvider) {
    llm.onPermissionTimeout = (toolName: string, _toolUseId: string) => {
      const text = `\u23f0 Permission timed out (5m)\nTool: ${toolName}\nAction: Denied by default`;
      hookBridge.broadcastText(text).catch((err) => {
        logger.warn(`Failed to send timeout notification: ${err}`);
      });
    };
  }

  if (coreAvailable) {
    logger.info(`Web terminal available at ${config.coreUrl}`);
  }

  // Graceful shutdown
  const shutdown = async (reason = 'signal') => {
    logger.info('Shutting down...');
    clearInterval(coreStatusInterval);
    hookBridge.stop();
    clearInterval(keepAliveInterval);
    writeStatusFile({
      pid: process.pid,
      exitedAt: new Date().toISOString(),
      exitReason: reason,
    });
    await manager.stop();
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
