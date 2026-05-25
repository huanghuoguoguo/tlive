import { loadConfig } from '../shared/config.js';
import { createLocalAgentProviderRegistry } from './providers/local-factory.js';
import { getCurrentVersion } from '../shared/utils/version-checker.js';
import { generateId } from '../shared/core/id.js';
import { getTliveHome } from '../shared/core/path.js';
import { defaultRemoteClientName, RemoteClientWorker } from './worker.js';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

interface ClientCliArgs {
  serverUrl?: string;
  token?: string;
  clientId?: string;
  name?: string;
  workspaces?: string[];
}

function parseArgs(argv: string[]): ClientCliArgs {
  const out: ClientCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--server') out.serverUrl = next();
    else if (arg === '--token') out.token = next();
    else if (arg === '--id' || arg === '--client-id') out.clientId = next();
    else if (arg === '--name') out.name = next();
    else if (arg === '--workspace') out.workspaces = [...(out.workspaces ?? []), next()];
    else if (arg === '--workspaces') out.workspaces = parseList(next());
  }
  return out;
}

function parseList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface ResolveRemoteClientIdOptions {
  tliveHome?: string;
  defaultName?: string;
  generate?: () => string;
}

export function resolveRemoteClientId(
  cliClientId: string | undefined,
  configClientId: string | undefined,
  options: ResolveRemoteClientIdOptions = {},
): string {
  if (cliClientId?.trim()) return cliClientId.trim();
  if (configClientId?.trim()) return configClientId.trim();

  const tliveHome = options.tliveHome ?? getTliveHome();
  const idPath = join(tliveHome, 'client-id');
  if (existsSync(idPath)) {
    const persisted = readFileSync(idPath, 'utf8').trim();
    if (persisted) return persisted;
  }

  const defaultName = options.defaultName ?? defaultRemoteClientName();
  const generated = options.generate?.() ?? `${defaultName}-${generateId('client', 6)}`;
  mkdirSync(dirname(idPath), { recursive: true });
  writeFileSync(idPath, `${generated}\n`, { mode: 0o600 });
  return generated;
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ validateBridge: false });
  const providers = createLocalAgentProviderRegistry(config);
  const worker = new RemoteClientWorker(providers, {
    serverUrl: args.serverUrl || config.remote.client.serverUrl,
    token: args.token ?? config.remote.client.token,
    clientId: resolveRemoteClientId(args.clientId, config.remote.client.clientId),
    name: args.name || config.remote.client.name || defaultRemoteClientName(),
    workspaces:
      args.workspaces?.length
        ? args.workspaces
        : config.remote.client.workspaces.length
          ? config.remote.client.workspaces
          : [config.defaultWorkdir],
    reconnectIntervalMs: config.remote.client.reconnectIntervalMs,
    version: getCurrentVersion(),
  });

  const shutdown = () => {
    worker.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await worker.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Remote client failed:', err);
    process.exit(1);
  });
}
