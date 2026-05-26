import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRemoteClientId, resolveRemoteClientWorkspaces } from '../../client/main.js';

describe('remote client id resolution', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tliveHome(): string {
    const root = mkdtempSync(join(tmpdir(), 'tlive-client-id-'));
    roots.push(root);
    return root;
  }

  it('prefers explicit client ids without writing a generated id', () => {
    const home = tliveHome();

    expect(resolveRemoteClientId('cli-client', 'config-client', { tliveHome: home })).toBe(
      'cli-client',
    );
    expect(resolveRemoteClientId(undefined, 'config-client', { tliveHome: home })).toBe(
      'config-client',
    );
  });

  it('persists generated client id and reuses it across restarts', () => {
    const home = tliveHome();

    const first = resolveRemoteClientId(undefined, undefined, {
      tliveHome: home,
      defaultName: 'worker-host',
      generate: () => 'worker-host-client-fixed',
    });
    const second = resolveRemoteClientId(undefined, undefined, {
      tliveHome: home,
      defaultName: 'worker-host',
      generate: () => 'worker-host-client-other',
    });

    expect(first).toBe('worker-host-client-fixed');
    expect(second).toBe('worker-host-client-fixed');
    expect(readFileSync(join(home, 'client-id'), 'utf8')).toBe('worker-host-client-fixed\n');
  });

  it('treats remote workspaces as quick directories after the default workdir', () => {
    expect(resolveRemoteClientWorkspaces(undefined, [], '/default')).toEqual(['/default']);
    expect(resolveRemoteClientWorkspaces(undefined, ['/quick', '/default'], '/default')).toEqual([
      '/default',
      '/quick',
    ]);
    expect(resolveRemoteClientWorkspaces(['/cli'], ['/config'], '/default')).toEqual([
      '/default',
      '/cli',
    ]);
  });
});
