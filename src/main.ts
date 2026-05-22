import { loadConfig } from './config.js';
import { Logger } from './logger.js';
import { JsonFileStore } from './store/json-file.js';
import { createAgentProviderRegistry } from './providers/factory.js';
import { BridgeManager } from './engine/coordinators/bridge-manager.js';
import { FeishuAdapter } from './channels/feishu/adapter.js';
import { RemoteClientRegistry } from './server/client-registry.js';
import { LOCAL_CLIENT_ID } from './server/client-agent-provider.js';
import type { HomeClientEntry } from './formatting/message-types.js';
import {
  checkForUpdates,
  getCurrentVersion,
  isVersionNotified,
  markVersionNotified,
} from './utils/version-checker.js';
import { dirname, join } from 'node:path';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  getTliveHome,
  getTliveRuntimeDir,
  readRestartRequest,
  deleteRestartRequest,
} from './core/path.js';

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

interface SingletonLock {
  pid: number;
  startedAt?: string;
  argv?: string[];
  cwd?: string;
}

interface ProcessMetadata {
  cmdline: string[];
  comm?: string;
  cwd?: string;
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function parseSingletonLock(content: string): SingletonLock | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        pid?: unknown;
        startedAt?: unknown;
        argv?: unknown;
        cwd?: unknown;
      };
      const pid = Number(parsed.pid);
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      return {
        pid,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined,
        argv: Array.isArray(parsed.argv)
          ? parsed.argv.filter((value): value is string => typeof value === 'string')
          : undefined,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
      };
    } catch {
      return null;
    }
  }

  const pid = Number(trimmed);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid };
}

function readSingletonLock(pidFile: string): SingletonLock | null {
  try {
    return parseSingletonLock(readFileSync(pidFile, 'utf-8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(pid: number, timeoutMs: number, intervalMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    sleepSync(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  return !isProcessAlive(pid);
}

function readProcessMetadata(pid: number): ProcessMetadata | null {
  const procRoot =
    process.env.NODE_ENV === 'test' ? process.env.TLIVE_PROC_ROOT?.trim() || '/proc' : '/proc';
  const procDir = join(procRoot, String(pid));

  try {
    const rawCmdline = readFileSync(join(procDir, 'cmdline'));
    const cmdline = rawCmdline.toString('utf-8').split('\0').filter(Boolean);
    let comm: string | undefined;
    let cwd: string | undefined;

    try {
      comm = readFileSync(join(procDir, 'comm'), 'utf-8').trim();
    } catch {
      /* optional */
    }

    try {
      cwd = readlinkSync(join(procDir, 'cwd'));
    } catch {
      /* optional */
    }

    return { cmdline, comm, cwd };
  } catch {
    return null;
  }
}

function looksLikeTliveBridgeProcess(metadata: ProcessMetadata): boolean {
  const cmdline = metadata.cmdline.join(' ').toLowerCase();
  const command = metadata.cmdline[0]?.toLowerCase() ?? '';
  const comm = metadata.comm?.toLowerCase() ?? '';
  const cwd = metadata.cwd?.toLowerCase() ?? '';

  const nodeLike = command.includes('node') || comm.includes('node');
  const hasTliveCommand = cmdline.includes('tlive');
  const hasBridgeEntry = cmdline.includes('dist/main.mjs') || cmdline.includes('src/main.ts');

  return nodeLike && (hasTliveCommand || (hasBridgeEntry && cwd.endsWith('/tlive')));
}

function writeLockFileAtomically(pidFile: string, content: string): boolean {
  const tempFile = join(
    dirname(pidFile),
    `.bridge.pid.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );

  try {
    writeFileSync(tempFile, content, { flag: 'wx', mode: 0o600 });
    try {
      linkSync(tempFile, pidFile);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;

      try {
        writeFileSync(pidFile, content, { flag: 'wx', mode: 0o600 });
        return true;
      } catch (fallbackErr) {
        if ((fallbackErr as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw fallbackErr;
      }
    }
  } finally {
    try {
      unlinkSync(tempFile);
    } catch {
      /* ignore */
    }
  }
}

function removePidFile(pidFile: string): void {
  try {
    unlinkSync(pidFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function terminateExistingBridge(lock: SingletonLock): void {
  const metadata = readProcessMetadata(lock.pid);
  if (!metadata || !looksLikeTliveBridgeProcess(metadata)) {
    console.warn(
      `[singleton] PID ${lock.pid} is alive but does not look like a tlive bridge; ` +
        'leaving the process untouched and replacing the stale lock',
    );
    return;
  }

  console.warn(`[singleton] Killing existing bridge process (PID ${lock.pid})`);
  process.kill(lock.pid, 'SIGTERM');

  if (waitForProcessExit(lock.pid, 2000, 50)) return;

  const metadataBeforeKill = readProcessMetadata(lock.pid);
  if (!metadataBeforeKill || !looksLikeTliveBridgeProcess(metadataBeforeKill)) {
    console.warn(
      `[singleton] PID ${lock.pid} no longer matches tlive bridge metadata; skipping SIGKILL`,
    );
    return;
  }

  process.kill(lock.pid, 'SIGKILL');
  console.warn(`[singleton] Force-killed PID ${lock.pid}`);
}

function registerPidCleanup(pidFile: string): void {
  const cleanPid = () => {
    try {
      const current = readSingletonLock(pidFile);
      if (current?.pid === process.pid) {
        unlinkSync(pidFile);
      }
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanPid);
}

/**
 * Ensure only one bridge instance runs at a time.
 * Uses an atomically-created PID file and validates live processes before killing.
 * Supports restart handoff via restart-request.json marker.
 */
export function acquireSingletonLock(): void {
  const runtimeDir = getTliveRuntimeDir();
  mkdirSync(runtimeDir, { recursive: true });
  const pidFile = join(runtimeDir, 'bridge.pid');

  const restartRequest = readRestartRequest();
  if (restartRequest && restartRequest.oldPid !== process.pid) {
    console.log(`[singleton] Restart handoff detected (old PID ${restartRequest.oldPid})`);
    if (!waitForProcessExit(restartRequest.oldPid, 5000, 100)) {
      console.warn(
        `[singleton] Restart handoff old PID ${restartRequest.oldPid} still alive after 5000ms`,
      );
    }
    deleteRestartRequest();
    console.log('[singleton] Restart handoff complete');
  }

  const lockContent = `${process.pid}\n`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (writeLockFileAtomically(pidFile, lockContent)) {
      registerPidCleanup(pidFile);
      return;
    }

    const existingLock = readSingletonLock(pidFile);
    if (!existingLock) {
      console.warn('[singleton] Malformed bridge.pid lock found; replacing it');
      removePidFile(pidFile);
      continue;
    }

    if (existingLock.pid === process.pid) {
      registerPidCleanup(pidFile);
      return;
    }

    const wasRestartHandoff = restartRequest?.oldPid === existingLock.pid;
    if (!wasRestartHandoff && isProcessAlive(existingLock.pid)) {
      terminateExistingBridge(existingLock);
    }

    removePidFile(pidFile);
  }

  throw new Error('[singleton] Failed to acquire bridge.pid lock after retries');
}

export async function main() {
  // Ensure only one bridge instance runs
  acquireSingletonLock();

  cachedConfig = loadConfig();
  const config = cachedConfig;
  const tliveHome = getTliveHome();

  const logger = new Logger(
    join(tliveHome, 'logs', 'bridge.log'),
    [config.token, config.feishu.appSecret].filter(Boolean),
  );
  logger.installConsoleInterception();

  logger.info('TLive Bridge starting...');
  logger.info('Enabled channel: feishu');

  const startedAt = new Date().toISOString();
  const remoteClients = config.remote.server.enabled
    ? new RemoteClientRegistry({
        port: config.remote.server.port,
        path: config.remote.server.path,
        token: config.remote.server.token,
        heartbeatIntervalMs: config.remote.server.heartbeatIntervalMs,
        clientTimeoutMs: config.remote.server.clientTimeoutMs,
      })
    : undefined;
  remoteClients?.start();

  // Write startup status
  writeStatusFile({
    pid: process.pid,
    startedAt,
    channels: ['feishu'],
    remoteServer: config.remote.server.enabled
      ? {
          port: config.remote.server.port,
          path: config.remote.server.path,
          providers: config.remote.server.providers,
        }
      : undefined,
    version: getCurrentVersion(),
  });

  // Initialize components
  const store = new JsonFileStore(join(tliveHome, 'data'));
  const providers = createAgentProviderRegistry(config, { remoteClientRegistry: remoteClients });
  const llm = providers.defaultProvider;
  const getExecutionClients = (): HomeClientEntry[] => {
    const localProviders = providers
      .availableForNewSession()
      .filter(() => config.remote.server.localClientEnabled)
      .map((provider) => ({
        kind: provider.kind,
        displayName: provider.displayName,
        available: provider.available,
        isDefault: provider.isDefault,
        reason: provider.reason,
      }));
    const localClient: HomeClientEntry[] =
      config.remote.server.localClientEnabled && localProviders.length
        ? [
            {
              clientId: LOCAL_CLIENT_ID,
              name: 'local',
              online: true,
              isDefault: false,
              isLocal: true,
              activeTurns: 0,
              maxConcurrency: 1,
              workspaces: [{ path: config.defaultWorkdir, isDefault: true }],
              providers: localProviders,
              version: getCurrentVersion(),
            },
          ]
        : [];
    const remote = remoteClients?.listClients().map((client) => ({
      clientId: client.clientId,
      name: client.name,
      online: true,
      isDefault: false,
      activeTurns: client.activeTurns,
      maxConcurrency: client.maxConcurrency,
      workspaces: client.workspaces.map((workspace, index) => ({
        path: workspace.path,
        label: workspace.label,
        isDefault: index === 0,
      })),
      providers: client.providers.map((provider) => ({
        kind: provider.kind,
        displayName: provider.displayName,
        available: provider.available,
        isDefault: false,
        reason: provider.reason,
      })),
      lastSeenAt: new Date(client.lastSeenAt).toISOString(),
      version: client.version,
    })) ?? [];
    return [...localClient, ...remote];
  };

  // Start Bridge Manager with enabled IM adapters
  const manager = new BridgeManager({
    store,
    llm,
    providers,
    defaultWorkdir: config.defaultWorkdir,
    config,
    getExecutionClients,
  });
  manager.registerAdapter(
    new FeishuAdapter(config.feishu, {
      doneButtons: config.ui.doneButtons,
      autoPinTopics: config.feishu.autoPinTopics,
    }),
  );
  logger.info('Registered feishu adapter');

  await manager.start();
  logger.info('Bridge started');
  writeStatusFile({
    pid: process.pid,
    startedAt,
    readyAt: new Date().toISOString(),
    channels: ['feishu'],
    remoteServer: config.remote.server.enabled
      ? {
          port: config.remote.server.port,
          path: config.remote.server.path,
          providers: config.remote.server.providers,
        }
      : undefined,
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
    logger.info(
      `Upgrade result: ${success ? 'success' : 'failed'} (${previousVersion} → ${version})`,
    );
  }

  // Wire provider permission timeout → IM notification.
  for (const provider of providers.configuredProviders()) {
    if (!provider.capabilities.interactivePermissions) continue;
    provider.onPermissionTimeout = (toolName: string, _toolUseId: string) => {
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
        await manager
          .broadcastFormatted({
            type: 'versionUpdate',
            data: {
              current: info.current,
              latest: info.latest,
              publishedAt: info.publishedAt,
            },
          })
          .catch(() => {});
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
    remoteClients?.stop();
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
