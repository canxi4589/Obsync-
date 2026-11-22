import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bytesToBase64, concatBytes, utf8ToBytes } from '../crypto/base64';
import {
  BLOB_VERSION,
  BLOB_VERSION_V1,
  normalizeRecoveryKey,
  unlockWithRecoveryKey,
  type VaultIndex,
  type VaultMeta,
} from '../crypto/vaultCrypto';
import { OfflineCache } from '../storage/offlineCache';
import { StorageManager } from '../storage/storageManager';
import type { FileEntry, LocalProviderConfig, ReadResult, StorageProvider } from '../storage/types';
import { VAULT_INDEX_PATH, VaultService } from '../vault/vaultService';

class MockMemStorage implements StorageProvider {
  readonly id = 'mem';
  readonly type = 'local' as const;
  readonly label = 'MockMem';
  files = new Map<string, Uint8Array<ArrayBuffer>>();
  writeCounts = new Map<string, number>();

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
    this.writeCounts.set(path, (this.writeCounts.get(path) ?? 0) + 1);
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

function makeLegacyBlob(password: string, text: string): Uint8Array<ArrayBuffer> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = pbkdf2Sync(password, salt, 200_000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(utf8ToBytes(text)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([salt, nonce, tag, ct]));
}

describe('VaultService End-to-End', () => {
  it('initializes vault with hidden filenames, unlocks, recovers, renames, and batch-imports legacy notes', async () => {
    const backend = new MockMemStorage();
    const manager = new StorageManager([memConfig], new OfflineCache(), () => backend);
    const vaultService = new VaultService(manager);

    expect((await vaultService.checkVaultExists()).exists).toBe(false);

    // Initialize vault
    const init = await vaultService.initializeNewVault('VaultPass!2026');
    expect(backend.files.has('.obsync-vault/vault.json')).toBe(true);
    expect(backend.files.has(VAULT_INDEX_PATH)).toBe(true);

    // Save private note — ensure neither title nor plaintext appears in storage keys or values
    const saved = await vaultService.savePrivateNote(init.dek, init.index, {
      title: 'Passport Number',
      folder: 'Identity/Docs',
      content: '# Passport\nNumber: X123456',
    });

    const storageKeys = Array.from(backend.files.keys());
    expect(storageKeys.some((k) => k.includes('Passport'))).toBe(false);
    expect(storageKeys.some((k) => k.includes('Identity'))).toBe(false);
    const notePath = `.obsync-vault/notes/${saved.note.id}.enc`;
    expect(storageKeys).toContain(notePath);

    // Rename note without touching its content blob
    const writesBeforeRename = backend.writeCounts.get(notePath) ?? 0;
    const renamed = await vaultService.renamePrivateNote(init.dek, saved.index, {
      id: saved.note.id,
      title: 'Passport Info',
      folder: 'Identity',
    });
    expect(renamed.note.title).toBe('Passport Info');
    expect(backend.writeCounts.get(notePath)).toBe(writesBeforeRename);

    // Unlock on another "device"
    const check = await vaultService.checkVaultExists();
    expect(check.exists).toBe(true);
    const unlocked = await vaultService.unlockVault('VaultPass!2026', check.meta!);
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

    // Seed 3 legacy C# CLI notes and verify index.enc is written only ONCE for the whole batch
    await backend.write('private/.encrypted/wifi.md.enc', makeLegacyBlob('OldCliSecret', '# Legacy 1'));
    await backend.write('private/.encrypted/bank.md.enc', makeLegacyBlob('OldCliSecret', '# Legacy 2'));
    await backend.write('private/.encrypted/sub/pin.md.enc', makeLegacyBlob('OldCliSecret', '# Legacy 3'));

    const indexWritesBefore = backend.writeCounts.get(VAULT_INDEX_PATH) ?? 0;
    const imp = await vaultService.importLegacyPrivateNotes(
      recovered.dek,
      recovered.index,
      'OldCliSecret'
    );
    expect(imp.imported).toBe(3);
    expect(imp.failed).toHaveLength(0);
    expect(backend.writeCounts.get(VAULT_INDEX_PATH)).toBe(indexWritesBefore + 1);
    expect(imp.index.notes.some((n) => n.title === 'wifi' && n.folder === 'Imported')).toBe(true);

    // Delete note (creates tombstone instead of erasing history)
    const afterDel = await vaultService.deletePrivateNote(
      recovered.dek,
      imp.index,
      saved.note.id
    );
    expect(afterDel.index.notes.filter((n) => !n.deleted)).toHaveLength(3);
    expect(afterDel.index.notes.find((n) => n.id === saved.note.id)?.deleted).toBe(true);
    expect(backend.files.has(notePath)).toBe(false);
  });

  it('detects ciphertext swapping between notes and rejects malformed vault.json or unsafe note IDs', async () => {
    const backend = new MockMemStorage();
    const manager = new StorageManager([memConfig], new OfflineCache(), () => backend);
    const vaultService = new VaultService(manager);

    const init = await vaultService.initializeNewVault('SwapGuardPass!2026');
    const a = await vaultService.savePrivateNote(init.dek, init.index, {
      title: 'Note A',
      folder: '',
      content: 'Secret A',
    });
    const b = await vaultService.savePrivateNote(init.dek, a.index, {
      title: 'Note B',
      folder: '',
      content: 'Secret B',
    });

    // Malicious storage swaps encrypted note payloads between note A and note B
    const pathA = `.obsync-vault/notes/${a.note.id}.enc`;
    const pathB = `.obsync-vault/notes/${b.note.id}.enc`;
    const blobA = backend.files.get(pathA)!;
    const blobB = backend.files.get(pathB)!;
    backend.files.set(pathA, blobB);
    backend.files.set(pathB, blobA);

    // AAD mismatch must reject the swapped blobs
    await expect(vaultService.readPrivateNote(init.dek, a.note.id)).rejects.toThrow();
    await expect(vaultService.readPrivateNote(init.dek, b.note.id)).rejects.toThrow();

    // Unsafe noteId rejected
    await expect(vaultService.readPrivateNote(init.dek, '../escape')).rejects.toThrow(
      'Invalid private note identifier'
    );

    // Tampered vault.json with DoS iterations rejected by checkVaultExists
    await backend.write(
      '.obsync-vault/vault.json',
      utf8ToBytes(JSON.stringify({ ...init.meta, iterations: 999_999_999 }))
    );
    await expect(vaultService.checkVaultExists()).rejects.toThrow('Invalid KDF iterations');
  });

  it('merges concurrent multi-device index edits and keeps tombstones from resurrecting', async () => {
    const backend = new MockMemStorage();
    const manager = new StorageManager([memConfig], new OfflineCache(), () => backend);
    const vaultService = new VaultService(manager);

    const init = await vaultService.initializeNewVault('SharedPass!2026');
    const deviceA = vaultService;
    const deviceB = new VaultService(
      new StorageManager([memConfig], new OfflineCache(), () => backend)
    );

    const unlockedB = await deviceB.unlockVault('SharedPass!2026', init.meta);

    // Device A saves Note A (remote index updated)
    const afterA = await deviceA.savePrivateNote(init.dek, init.index, {
      title: 'From iPhone',
      folder: '',
      content: 'iphone content',
    });

    // Device B still holds its stale initial empty index, and saves Note B
    const afterB = await deviceB.savePrivateNote(unlockedB.dek, unlockedB.index, {
      title: 'From Windows',
      folder: '',
      content: 'windows content',
    });

    const activeTitles = afterB.index.notes.filter((n) => !n.deleted).map((n) => n.title);
    expect(activeTitles).toContain('From iPhone');
    expect(activeTitles).toContain('From Windows');

    // Wait 5ms so delete timestamp is strictly newer than save timestamp, then Device A deletes Note A
    await new Promise((r) => setTimeout(r, 5));
    await deviceA.deletePrivateNote(init.dek, afterA.index, afterA.note.id);

    // Device B (still holding stale afterB.index where Note A was active) saves Note B again: Note A must stay deleted
    const afterBEdit = await deviceB.savePrivateNote(unlockedB.dek, afterB.index, {
      id: afterB.note.id,
      title: 'From Windows Updated',
      folder: '',
      content: 'windows v2',
    });
    const finalActive = afterBEdit.index.notes.filter((n) => !n.deleted);
    expect(finalActive).toHaveLength(1);
    expect(finalActive[0].title).toBe('From Windows Updated');
  });

  it('performs one-click upgrade from legacy v1 vault + v1 note blobs to v2 AAD + HKDF', async () => {
    const backend = new MockMemStorage();
    const manager = new StorageManager([memConfig], new OfflineCache(), () => backend);
    const vaultService = new VaultService(manager);

    // Seed a complete legacy v1 vault with 2 v1 note blobs (no AAD)
    const rawDek = randomBytes(32);
    const pw = 'LegacyVaultPass!2026';
    const oldRec = 'OBSYNC-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-2222-3333';
    const iterations = 100_000;

    const wrapV1 = (secret: string) => {
      const salt = randomBytes(16);
      const nonce = randomBytes(12);
      const kek = pbkdf2Sync(secret, salt, iterations, 32, 'sha256');
      const cipher = createCipheriv('aes-256-gcm', kek, nonce);
      const ct = Buffer.concat([cipher.update(rawDek), cipher.final(), cipher.getAuthTag()]);
      return {
        salt: bytesToBase64(salt),
        nonce: bytesToBase64(nonce),
        wrappedDek: bytesToBase64(ct),
      };
    };
    const encryptV1Blob = (plain: Uint8Array) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', rawDek, nonce);
      const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
      return concatBytes(new Uint8Array([BLOB_VERSION_V1]), nonce, ct);
    };

    const v1Meta: VaultMeta = {
      version: 1,
      kdf: 'PBKDF2-SHA256',
      iterations,
      passwordWrap: wrapV1(pw),
      recoveryWrap: wrapV1(normalizeRecoveryKey(oldRec)),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const v1Index: VaultIndex = {
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      notes: [
        {
          id: 'legacy-note-1',
          title: 'First',
          folder: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'legacy-note-2',
          title: 'Second',
          folder: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    await backend.write('.obsync-vault/vault.json', utf8ToBytes(JSON.stringify(v1Meta)));
    await backend.write(VAULT_INDEX_PATH, encryptV1Blob(utf8ToBytes(JSON.stringify(v1Index))));
    await backend.write('.obsync-vault/notes/legacy-note-1.enc', encryptV1Blob(utf8ToBytes('Body 1')));
    await backend.write('.obsync-vault/notes/legacy-note-2.enc', encryptV1Blob(utf8ToBytes('Body 2')));

    const check = await vaultService.checkVaultExists();
    expect(check.meta!.version).toBe(1);

    const unlocked = await vaultService.unlockVault(pw, check.meta!);
    expect(await vaultService.readPrivateNote(unlocked.dek, 'legacy-note-1')).toBe('Body 1');

    // Run one-click upgrade to v2
    const upgraded = await vaultService.upgradeVaultToV2(
      pw,
      unlocked.dek,
      unlocked.index,
      check.meta!
    );

    expect(upgraded.meta.version).toBe(2);
    expect(upgraded.meta.recoveryKdf).toBe('HKDF-SHA256');
    expect(upgraded.reencryptedNotes).toBe(2);
    expect(backend.files.get('.obsync-vault/notes/legacy-note-1.enc')![0]).toBe(BLOB_VERSION);
    expect(backend.files.get('.obsync-vault/notes/legacy-note-2.enc')![0]).toBe(BLOB_VERSION);
    expect(backend.files.get(VAULT_INDEX_PATH)![0]).toBe(BLOB_VERSION);

    // New HKDF recovery key unlocks upgraded vault
    const recDek = await unlockWithRecoveryKey(upgraded.recoveryKey, upgraded.meta);
    expect(await vaultService.readPrivateNote(recDek, 'legacy-note-1')).toBe('Body 1');
    expect(await vaultService.readPrivateNote(recDek, 'legacy-note-2')).toBe('Body 2');

    // Swapping upgraded notes must now fail AAD verification
    const b1 = backend.files.get('.obsync-vault/notes/legacy-note-1.enc')!;
    const b2 = backend.files.get('.obsync-vault/notes/legacy-note-2.enc')!;
    backend.files.set('.obsync-vault/notes/legacy-note-1.enc', b2);
    backend.files.set('.obsync-vault/notes/legacy-note-2.enc', b1);
    await expect(vaultService.readPrivateNote(recDek, 'legacy-note-1')).rejects.toThrow();
  });
});
