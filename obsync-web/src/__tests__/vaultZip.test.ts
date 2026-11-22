import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { bytesToUtf8, utf8ToBytes } from '../crypto/base64';
import { OfflineCache } from '../storage/offlineCache';
import { validatePublicNotePath } from '../storage/pathUtils';
import { StorageManager } from '../storage/storageManager';
import type { FileEntry, LocalProviderConfig, ReadResult, StorageProvider } from '../storage/types';
import {
  exportVaultZip,
  extractSafeZipEntries,
  importVaultZip,
} from '../storage/vaultZip';

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
    await srcProvider.write('.obsync-vault/vault.json', utf8ToBytes('{"version":2}'));
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

  it('blocks .git, .obsidian plugins, Windows reserved names, non-Markdown files, and traversal paths', async () => {
    const zipBytes = zipSync({
      'draft..v2.md': utf8ToBytes('# Draft v2'),
      '../escape.md': utf8ToBytes('evil'),
      'Notes/../secret.md': utf8ToBytes('evil'),
      '\\..\\backslash-escape.md': utf8ToBytes('evil'),
      '.git/config': utf8ToBytes('[core]\nfsmonitor = calc.exe'),
      '.git/hooks/pre-commit': utf8ToBytes('#!/bin/sh\npwn'),
      '.obsidian/plugins/evil/main.js': utf8ToBytes('require("child_process").exec("calc")'),
      'CON.md': utf8ToBytes('reserved windows name'),
      'script.exe': utf8ToBytes('MZ'),
    });

    const provider = new InMemProvider();
    const mgr = new StorageManager([cfg], new OfflineCache(), () => provider);
    const res = await importVaultZip(mgr, new Uint8Array(zipBytes));

    expect(res.imported).toBe(1);
    expect(res.skipped).toBe(8);
    expect(provider.map.has('draft..v2.md')).toBe(true);
    expect(provider.map.has('.git/config')).toBe(false);
    expect(provider.map.has('.obsidian/plugins/evil/main.js')).toBe(false);
    expect(provider.map.has('CON.md')).toBe(false);

    expect(validatePublicNotePath('Journal/draft..v2')).toEqual({
      ok: true,
      path: 'Journal/draft..v2.md',
    });
    expect(validatePublicNotePath('.obsync-vault/hack.md').ok).toBe(false);
    expect(validatePublicNotePath('.obsidian/hack.md').ok).toBe(false);
    expect(validatePublicNotePath('../outside.md').ok).toBe(false);
    expect(validatePublicNotePath('bad:name.md').ok).toBe(false);
    expect(validatePublicNotePath('CON.md').ok).toBe(false);
    expect(validatePublicNotePath('Notes/NUL').ok).toBe(false);
  });

  it('aborts extraction when ZIP archive exceeds Zip Bomb file count or uncompressed size caps', async () => {
    const compressible = new Uint8Array(64 * 1024).fill(65); // 64 KB of 'A'
    const bombZip = zipSync({ 'big.md': compressible }, { level: 9 });

    // Compressed size is tiny (~100 bytes), but uncompressed is 64 KB — must reject against 16 KB cap
    expect(bombZip.byteLength).toBeLessThan(1024);
    await expect(
      extractSafeZipEntries(new Uint8Array(bombZip), {
        maxFileBytes: 16 * 1024,
        maxTotalBytes: 16 * 1024,
      })
    ).rejects.toThrow('maximum');

    // File count cap
    const manyZip = zipSync({
      'a.md': utf8ToBytes('1'),
      'b.md': utf8ToBytes('2'),
      'c.md': utf8ToBytes('3'),
    });
    await expect(
      extractSafeZipEntries(new Uint8Array(manyZip), { maxFiles: 2 })
    ).rejects.toThrow('maximum allowed file count');
  });
});
