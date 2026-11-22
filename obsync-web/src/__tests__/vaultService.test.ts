import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { utf8ToBytes } from '../crypto/base64';
import { OfflineCache } from '../storage/offlineCache';
import { StorageManager } from '../storage/storageManager';
import type { FileEntry, LocalProviderConfig, ReadResult, StorageProvider } from '../storage/types';
import { VaultService } from '../vault/vaultService';

class MockMemStorage implements StorageProvider {
  readonly id = 'mem';
  readonly type = 'local' as const;
  readonly label = 'MockMem';
  files = new Map<string, Uint8Array<ArrayBuffer>>();

  async testConnection() {
    return { ok: true, details: 'ok' };
  }
  async list(prefix = ''): Promise<FileEntry[]> {
    return Array.from(this.files.entries())
      .filter(([p]) => !prefix || p.startsWith(prefix))
      .map(([path, d]) => ({ path, size: d.byteLength }));
  }
  async read(path: string): Promise<ReadResult | null> {
    const d = this.files.get(path);
    return d ? { data: new Uint8Array(d) } : null;
  }
  async write(path: string, data: Uint8Array): Promise<void> {
    const c = new Uint8Array(data.byteLength);
    c.set(data);
    this.files.set(path, c);
  }
  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
}

const memConfig: LocalProviderConfig = {
  id: 'mem',
  type: 'local',
  label: 'MockMem',
  enabled: true,
  mirrorWrites: true,
  folderName: 'MockMem',
};

describe('VaultService End-to-End', () => {
  it('initializes vault with hidden filenames, unlocks, recovers, and imports legacy notes', async () => {
    const backend = new MockMemStorage();
    const manager = new StorageManager([memConfig], new OfflineCache(), () => backend);
    const vaultService = new VaultService(manager);

    expect((await vaultService.checkVaultExists()).exists).toBe(false);

    // Initialize vault
    const init = await vaultService.initializeNewVault('VaultPass!1');
    expect(backend.files.has('.obsync-vault/vault.json')).toBe(true);
    expect(backend.files.has('.obsync-vault/index.enc')).toBe(true);

    // Save private note — ensure neither title nor plaintext appears in storage keys or values
    const saved = await vaultService.savePrivateNote(init.dek, init.index, {
      title: 'Passport Number',
      folder: 'Identity/Docs',
      content: '# Passport\nNumber: X123456',
    });

    const storageKeys = Array.from(backend.files.keys());
    expect(storageKeys.some((k) => k.includes('Passport'))).toBe(false);
    expect(storageKeys.some((k) => k.includes('Identity'))).toBe(false);
    expect(storageKeys).toContain(`.obsync-vault/notes/${saved.note.id}.enc`);

    // Unlock on another "device"
    const check = await vaultService.checkVaultExists();
    expect(check.exists).toBe(true);
    const unlocked = await vaultService.unlockVault('VaultPass!1', check.meta!);
    expect(unlocked.index.notes).toHaveLength(1);
    expect(await vaultService.readPrivateNote(unlocked.dek, saved.note.id)).toBe(
      '# Passport\nNumber: X123456'
    );

    // Forgot password -> recover via recovery key
    const recovered = await vaultService.recoverVault(
      init.recoveryKey,
      'BrandNewMaster!2',
      check.meta!
    );
    expect(await vaultService.readPrivateNote(recovered.dek, saved.note.id)).toBe(
      '# Passport\nNumber: X123456'
    );

    // Seed a legacy C# CLI note in private/.encrypted/ and import it
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const key = pbkdf2Sync('OldCliSecret', salt, 200_000, 32, 'sha256');
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([cipher.update(utf8ToBytes('# Legacy\nOld secret')), cipher.final()]);
    const tag = cipher.getAuthTag();
    await backend.write(
      'private/.encrypted/wifi.md.enc',
      new Uint8Array(Buffer.concat([salt, nonce, tag, ct]))
    );

    const imp = await vaultService.importLegacyPrivateNotes(
      recovered.dek,
      recovered.index,
      'OldCliSecret'
    );
    expect(imp.imported).toBe(1);
    expect(imp.failed).toHaveLength(0);
    expect(imp.index.notes.some((n) => n.title === 'wifi' && n.folder === 'Imported')).toBe(
      true
    );

    // Delete note
    const afterDel = await vaultService.deletePrivateNote(
      recovered.dek,
      imp.index,
      saved.note.id
    );
    expect(afterDel.index.notes).toHaveLength(1);
    expect(backend.files.has(`.obsync-vault/notes/${saved.note.id}.enc`)).toBe(false);
  });
});
