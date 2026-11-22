import { describe, expect, it } from 'vitest';
import { bytesToUtf8, utf8ToBytes } from '../crypto/base64';
import { OfflineCache } from '../storage/offlineCache';
import { StorageManager } from '../storage/storageManager';
import { getConnectionFingerprint } from '../storage/storageManager';
import {
  AuthExpiredError,
  type FileEntry,
  type GoogleDriveProviderConfig,
  type LocalProviderConfig,
  type ReadResult,
  type StorageProvider,
  type StorageProviderConfig,
} from '../storage/types';

class MemoryMockProvider implements StorageProvider {
  readonly id: string;
  readonly type = 'local' as const;
  readonly label: string;
  files = new Map<string, Uint8Array<ArrayBuffer>>();
  failMode: 'none' | 'network' | 'auth' = 'none';

  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }

  private checkFailure(): void {
    if (this.failMode === 'network') throw new Error(`${this.label} offline`);
    if (this.failMode === 'auth') throw new AuthExpiredError(`${this.label} token expired`);
  }

  async testConnection() {
    this.checkFailure();
    return { ok: true, details: 'ok' };
  }

  async list(prefix = ''): Promise<FileEntry[]> {
    this.checkFailure();
    return Array.from(this.files.entries())
      .filter(([p]) => !prefix || p.startsWith(prefix))
      .map(([path, data]) => ({ path, size: data.byteLength }));
  }

  async read(path: string): Promise<ReadResult | null> {
    this.checkFailure();
    const data = this.files.get(path);
    return data ? { data: new Uint8Array(data) } : null;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.checkFailure();
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    this.files.set(path, copy);
  }

  async delete(path: string): Promise<void> {
    this.checkFailure();
    this.files.delete(path);
  }
}

function makeConfig(
  id: string,
  label: string,
  opts?: Partial<LocalProviderConfig>
): StorageProviderConfig {
  return {
    id,
    type: 'local',
    label,
    enabled: true,
    mirrorWrites: true,
    folderName: label,
    ...opts,
  };
}

describe('StorageManager Priority, Failover & Mirroring', () => {
  it('reads from Primary and fails over sequentially down to Offline Cache', async () => {
    const mocks = new Map<string, MemoryMockProvider>([
      ['p1', new MemoryMockProvider('p1', 'GitHub')],
      ['p2', new MemoryMockProvider('p2', 'GDrive-1')],
      ['p3', new MemoryMockProvider('p3', 'GDrive-2')],
    ]);

    const manager = new StorageManager(
      [
        makeConfig('p1', 'GitHub'),
        makeConfig('p2', 'GDrive-1'),
        makeConfig('p3', 'GDrive-2'),
      ],
      new OfflineCache(),
      (cfg) => mocks.get(cfg.id)!
    );

    await manager.write('.obsync-vault/vault.json', utf8ToBytes('{"v":1}'));

    // Primary read
    const r1 = await manager.read('.obsync-vault/vault.json');
    expect(r1.sourceProviderId).toBe('p1');
    expect(r1.usedFallback).toBe(false);
    expect(bytesToUtf8(r1.data!)).toBe('{"v":1}');

    // Primary down -> Fallback #1
    mocks.get('p1')!.failMode = 'network';
    const r2 = await manager.read('.obsync-vault/vault.json');
    expect(r2.sourceProviderId).toBe('p2');
    expect(r2.usedFallback).toBe(true);

    // Primary & Fallback #1 down -> Fallback #2
    mocks.get('p2')!.failMode = 'auth';
    const r3 = await manager.read('.obsync-vault/vault.json');
    expect(r3.sourceProviderId).toBe('p3');
    expect(r3.usedFallback).toBe(true);

    // All remote providers down -> Offline Cache
    mocks.get('p3')!.failMode = 'network';
    const r4 = await manager.read('.obsync-vault/vault.json');
    expect(r4.sourceProviderId).toBe('offline-cache');
    expect(bytesToUtf8(r4.data!)).toBe('{"v":1}');
  });

  it('does not fail over on authoritative 404 from Primary', async () => {
    const p1 = new MemoryMockProvider('p1', 'GitHub');
    const p2 = new MemoryMockProvider('p2', 'GDrive');
    await p2.write('stale-note.md', utf8ToBytes('stale'));

    const manager = new StorageManager(
      [makeConfig('p1', 'GitHub'), makeConfig('p2', 'GDrive')],
      new OfflineCache(),
      (cfg) => (cfg.id === 'p1' ? p1 : p2)
    );

    const res = await manager.read('stale-note.md');
    expect(res.sourceProviderId).toBe('p1');
    expect(res.data).toBeNull();
  });

  it('queues failed mirror writes and skips stale Primary until flushed', async () => {
    const p1 = new MemoryMockProvider('p1', 'Primary');
    const p2 = new MemoryMockProvider('p2', 'Fallback');

    const manager = new StorageManager(
      [makeConfig('p1', 'Primary'), makeConfig('p2', 'Fallback')],
      new OfflineCache(),
      (cfg) => (cfg.id === 'p1' ? p1 : p2)
    );

    await manager.write('note.md', utf8ToBytes('v1'));

    // Primary fails during v2 write; Fallback receives v2 and Primary gets queued
    p1.failMode = 'network';
    const summary = await manager.write('note.md', utf8ToBytes('v2'));
    expect(summary.primaryWrittenProviderId).toBe('p2');
    expect(summary.usedFallback).toBe(true);
    expect(summary.queuedFor).toHaveLength(1);
    expect(summary.queuedFor[0].providerId).toBe('p1');

    // Primary comes back online before flush: read() must NOT return stale 'v1' from Primary
    p1.failMode = 'none';
    const readFresh = await manager.read('note.md');
    expect(readFresh.sourceProviderId).toBe('p2');
    expect(bytesToUtf8(readFresh.data!)).toBe('v2');

    // Flush pending mirror op -> Primary gets v2
    const flushed = await manager.flushPendingMirrors();
    expect(flushed.flushed).toBe(1);
    expect(flushed.remaining).toBe(0);

    const readPrimaryNow = await manager.read('note.md');
    expect(readPrimaryNow.sourceProviderId).toBe('p1');
    expect(bytesToUtf8(readPrimaryNow.data!)).toBe('v2');
  });

  it('mirrors all files from one provider to another', async () => {
    const p1 = new MemoryMockProvider('p1', 'GitHub');
    const p2 = new MemoryMockProvider('p2', 'BackupDrive');

    await p1.write('.obsync-vault/vault.json', utf8ToBytes('{}'));
    await p1.write('.obsync-vault/notes/a.enc', new Uint8Array([1, 2, 3, 4]));
    await p1.write('.git/HEAD', utf8ToBytes('ref: refs/heads/main'));

    const manager = new StorageManager(
      [makeConfig('p1', 'GitHub'), makeConfig('p2', 'BackupDrive')],
      new OfflineCache(),
      (cfg) => (cfg.id === 'p1' ? p1 : p2)
    );

    const res = await manager.mirrorAllFiles('p1', 'p2');
    expect(res.copied).toBe(2);
    expect(res.failed).toBe(0);
    expect(p2.files.has('.git/HEAD')).toBe(false);
    expect(Array.from(p2.files.get('.obsync-vault/notes/a.enc')!)).toEqual([1, 2, 3, 4]);
  });

  it('preserves Google Drive fingerprint and provider instance when rootFolderId is discovered', () => {
    const gdBase: GoogleDriveProviderConfig = {
      id: 'gd-1',
      type: 'gdrive',
      label: 'Drive',
      enabled: true,
      mirrorWrites: true,
      clientId: 'client-1',
      accountEmail: 'user@gmail.com',
      folderName: 'ObsyncVault',
    };
    const gdWithRoot: GoogleDriveProviderConfig = {
      ...gdBase,
      rootFolderId: 'folder-abc',
    };

    expect(getConnectionFingerprint(gdBase)).toBe(getConnectionFingerprint(gdWithRoot));

    let factoryCalls = 0;
    const manager = new StorageManager([gdBase], new OfflineCache(), () => {
      factoryCalls++;
      return new MemoryMockProvider('gd-1', 'Drive');
    });
    expect(factoryCalls).toBe(1);

    manager.setConfigs([gdWithRoot]);
    expect(factoryCalls).toBe(1);
  });

  it('blocks .git and traversal paths centrally and supports clearing offline files on vault switch', async () => {
    const p1 = new MemoryMockProvider('p1', 'Primary');
    const cache = new OfflineCache();
    const manager = new StorageManager(
      [makeConfig('p1', 'Primary')],
      cache,
      () => p1
    );

    await expect(manager.write('.git/config', utf8ToBytes('evil'))).rejects.toThrow(
      'forbidden'
    );
    await expect(manager.read('../secret.md')).rejects.toThrow('forbidden');
    await expect(manager.delete('sub/.git/HEAD')).rejects.toThrow('forbidden');

    await manager.write('note.md', utf8ToBytes('hello'));
    expect(await cache.listFiles()).toHaveLength(1);
    await manager.clearOfflineFiles();
    expect(await cache.listFiles()).toHaveLength(0);
  });
});
