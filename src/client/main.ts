import { loadConfig } from '../shared/config.js';
import { createLocalAgentProviderRegistry } from './providers/local-factory.js';
import { getCurrentVersion } from '../shared/utils/version-checker.js';
import { generateId } from '../shared/core/id.js';
import { defaultRemoteClientName, RemoteClientWorker } from './worker.js';
import { pathToFileURL } from 'node:url';

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

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ validateBridge: false });
  const providers = createLocalAgentProviderRegistry(config);
  const worker = new RemoteClientWorker(providers, {
    serverUrl: args.serverUrl || config.remote.client.serverUrl,
    token: args.token ?? config.remote.client.token,
    clientId:
      args.clientId ||
      config.remote.client.clientId ||
      `${defaultRemoteClientName()}-${generateId('client', 6)}`,
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
