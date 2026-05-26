import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { getTliveHome } from '../shared/core/path.js';

export interface RemoteClientIdentity {
  clientId: string;
  clientSecret: string;
  serverUrl?: string;
  assignedAt?: string;
}

export interface RemoteClientIdentityStore {
  load(): RemoteClientIdentity | null;
  save(identity: RemoteClientIdentity): void;
}

export class FileRemoteClientIdentityStore implements RemoteClientIdentityStore {
  constructor(private readonly path = join(getTliveHome(), 'remote-client.json')) {}

  load(): RemoteClientIdentity | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<RemoteClientIdentity>;
      if (!parsed.clientId || !parsed.clientSecret) return null;
      return {
        clientId: parsed.clientId,
        clientSecret: parsed.clientSecret,
        serverUrl: parsed.serverUrl,
        assignedAt: parsed.assignedAt,
      };
    } catch {
      return null;
    }
  }

  save(identity: RemoteClientIdentity): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  }
}

export function createMachineFingerprint(): string {
  const source = `${readMachineId() || 'no-machine-id'}:${hostname()}`;
  return createHash('sha256').update(source).digest('hex');
}

function readMachineId(): string | null {
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = readFileSync(path, 'utf-8').trim();
      if (value) return value;
    } catch {
      /* try next source */
    }
  }
  return null;
}
