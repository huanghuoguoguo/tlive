import { loadConfig } from './config.js';
import { initBridgeContext } from './context.js';
import { CoreClientImpl } from './core-client.js';
import { Logger } from './logger.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Whether Go Core daemon is reachable (for web terminal links in IM)
let coreAvailable = false;
let coreClient: CoreClientImpl | null = null;

export function isCoreAvailable(): boolean {
  return coreAvailable;
}

export function getCoreUrl(): string {
  const config = loadConfig();
  return config.publicUrl || config.coreUrl;
}

async function main() {
  const config = loadConfig();

  const logDir = join(homedir(), '.tlive', 'logs');
  const logger = new Logger(
    join(logDir, 'bridge.log'),
    [config.token, config.telegram.botToken, config.discord.botToken, config.feishu.appSecret].filter(Boolean)
  );

  logger.info('TLive Bridge starting...');
  logger.info(`Enabled channels: ${config.enabledChannels.join(', ') || 'none'}`);

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
    } catch {
      coreAvailable = false;
    }
  }, 30_000);

  // Initialize context
  initBridgeContext({
    store: {} as any,       // TODO: wire JsonFileStore
    llm: {} as any,         // TODO: wire Claude SDK provider
    permissions: {} as any, // TODO: wire Permission gateway
    core: (coreClient ?? {}) as any,
  });

  logger.info('Bridge initialized');
  if (coreAvailable) {
    const webUrl = config.publicUrl || config.coreUrl;
    logger.info(`Web terminal available at ${webUrl}`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    if (coreClient) await coreClient.disconnect();
    logger.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive
  setInterval(() => {}, 60_000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
