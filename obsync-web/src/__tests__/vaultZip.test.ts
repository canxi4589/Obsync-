import { describe, expect, it } from 'vitest';
import { bytesToUtf8, utf8ToBytes } from '../crypto/base64';
import { OfflineCache } from '../storage/offlineCache';
import { StorageManager } from '../storage/storageManager';
import type { FileEntry, LocalProviderConfig, ReadResult, StorageProvider } from '../storage/types';
import { exportVaultZip, importVaultZip } from '../storage/vaultZip';

class InMemProvider implements StorageProvider {
  readonly id = 'mem';
  readonly type = 'local' as const;
  readonly label = 'InMem';
  map = new Map<string, Uint8Array<ArrayBuffer>>();

  async testConnection() {
    return { ok: true, details: 'ok' };
  }
  async list(prefix = ''): Promise<FileEntry[]> {
    return Array.from(this.map.entries())
      .filter(([k]) => !prefix || k.startsWith(prefix))
      .map(([path, v]) => ({ path, size: v.byteLength }));
  }
  async read(path: string): Promise<ReadResult | null> {
    const v = this.map.get(path);
    return v ? { data: new Uint8Array(v) } : null;
  }
  async write(path: string, data: Uint8Array): Promise<void> {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    this.map.set(path, copy);
  }
  async delete(path: string): Promise<void> {
    this.map.delete(path);
  }
}

const cfg: LocalProviderConfig = {
  id: 'mem',
  type: 'local',
  label: 'InMem',
  enabled: true,
  mirrorWrites: true,
  folderName: 'Mem',
};

describe('Vault ZIP Export / Import', () => {
  it('exports .obsync-vault and imports intact into another StorageManager', async () => {
    const srcProvider = new InMemProvider();
    await srcProvider.write('.obsync-vault/vault.json', utf8ToBytes('{"version":1}'));
    await srcProvider.write('.obsync-vault/notes/n1.enc', new Uint8Array([9, 8, 7, 6]));
    await srcProvider.write('Public.md', utf8ToBytes('# Public'));
    await srcProvider.write('private/ignore-plaintext.md', utf8ToBytes('legacy plaintext'));

    const srcMgr = new StorageManager([cfg], new OfflineCache(), () => srcProvider);
    const zipPrivateOnly = await exportVaultZip(srcMgr, false);

    const dstProvider1 = new InMemProvider();
    const dstMgr1 = new StorageManager([cfg], new OfflineCache(), () => dstProvider1);
    const res1 = await importVaultZip(dstMgr1, zipPrivateOnly);

    expect(res1.imported).toBe(2);
    expect(dstProvider1.map.has('Public.md')).toBe(false);
    expect(dstProvider1.map.has('private/ignore-plaintext.md')).toBe(false);
    expect(Array.from(dstProvider1.map.get('.obsync-vault/notes/n1.enc')!)).toEqual([
      9, 8, 7, 6,
    ]);

    const zipWithPublic = await exportVaultZip(srcMgr, true);
    const dstProvider2 = new InMemProvider();
    const dstMgr2 = new StorageManager([cfg], new OfflineCache(), () => dstProvider2);
    const res2 = await importVaultZip(dstMgr2, zipWithPublic);

    expect(res2.imported).toBe(3);
    expect(bytesToUtf8(dstProvider2.map.get('Public.md')!)).toBe('# Public');
  });
});
