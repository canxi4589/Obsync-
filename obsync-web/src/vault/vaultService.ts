import { bytesToUtf8, utf8ToBytes } from '../crypto/base64';
import { decryptLegacyCliBlob } from '../crypto/legacyDecrypt';
import {
  createVault,
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  regenerateRecoveryKey,
  rewrapPassword,
  unlockWithPassword,
  unlockWithRecoveryKey,
  type PrivateNoteEntry,
  type VaultIndex,
  type VaultMeta,
} from '../crypto/vaultCrypto';
import type { StorageManager } from '../storage/storageManager';
import type { MirrorSummary } from '../storage/types';

export const VAULT_DIR = '.obsync-vault';
export const VAULT_META_PATH = `${VAULT_DIR}/vault.json`;
export const VAULT_INDEX_PATH = `${VAULT_DIR}/index.enc`;
export const VAULT_NOTE_PATH = (id: string) => `${VAULT_DIR}/notes/${id}.enc`;

export interface VaultCheckResult {
  exists: boolean;
  meta: VaultMeta | null;
  sourceLabel: string;
  usedFallback: boolean;
  warnings: string[];
}

export function createEmptyIndex(): VaultIndex {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    notes: [],
  };
}

export function mergeVaultIndexes(local: VaultIndex, remote: VaultIndex): VaultIndex {
  const byId = new Map<string, PrivateNoteEntry>();

  for (const entry of remote.notes) {
    byId.set(entry.id, entry);
  }

  for (const localEntry of local.notes) {
    const remoteEntry = byId.get(localEntry.id);
    if (!remoteEntry) {
      byId.set(localEntry.id, localEntry);
      continue;
    }

    if (localEntry.updatedAt > remoteEntry.updatedAt) {
      byId.set(localEntry.id, localEntry);
    } else if (remoteEntry.updatedAt > localEntry.updatedAt) {
      byId.set(localEntry.id, remoteEntry);
    } else {
      // Equal timestamps: preserve tombstone if either side deleted
      byId.set(
        localEntry.id,
        remoteEntry.deleted && !localEntry.deleted ? remoteEntry : localEntry
      );
    }
  }

  const maxUpdatedAt =
    local.updatedAt > remote.updatedAt ? local.updatedAt : remote.updatedAt;

  return {
    version: 1,
    updatedAt: maxUpdatedAt,
    notes: Array.from(byId.values()),
  };
}

function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class VaultService {
  private readonly storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async checkVaultExists(): Promise<VaultCheckResult> {
    const res = await this.storage.read(VAULT_META_PATH);
    if (!res.data) {
      return {
        exists: false,
        meta: null,
        sourceLabel: res.sourceLabel,
        usedFallback: res.usedFallback,
        warnings: res.warnings,
      };
    }

    const meta = JSON.parse(bytesToUtf8(res.data)) as VaultMeta;
    return {
      exists: true,
      meta,
      sourceLabel: res.sourceLabel,
      usedFallback: res.usedFallback,
      warnings: res.warnings,
    };
  }

  async initializeNewVault(password: string): Promise<{
    dek: CryptoKey;
    meta: VaultMeta;
    index: VaultIndex;
    recoveryKey: string;
    mirror: MirrorSummary;
  }> {
    const { meta, dek, recoveryKey } = await createVault(password);
    const index = createEmptyIndex();

    const metaBytes = utf8ToBytes(JSON.stringify(meta, null, 2));
    const indexBytes = await encryptJson(dek, index);

    await this.storage.write(VAULT_META_PATH, metaBytes, 'Initialize Obsync private vault');
    const mirror = await this.storage.write(
      VAULT_INDEX_PATH,
      indexBytes,
      'Initialize Obsync encrypted vault index'
    );

    return { dek, meta, index, recoveryKey, mirror };
  }

  async unlockVault(
    password: string,
    meta: VaultMeta
  ): Promise<{ dek: CryptoKey; index: VaultIndex; usedFallback: boolean; sourceLabel: string }> {
    const dek = await unlockWithPassword(password, meta);
    const indexRes = await this.storage.read(VAULT_INDEX_PATH);
    const index = indexRes.data
      ? await decryptJson<VaultIndex>(dek, indexRes.data)
      : createEmptyIndex();

    return {
      dek,
      index,
      usedFallback: indexRes.usedFallback,
      sourceLabel: indexRes.sourceLabel,
    };
  }

  async recoverVault(
    recoveryKey: string,
    newPassword: string,
    meta: VaultMeta
  ): Promise<{ dek: CryptoKey; meta: VaultMeta; index: VaultIndex }> {
    const dek = await unlockWithRecoveryKey(recoveryKey, meta);
    const updatedMeta = await rewrapPassword(dek, newPassword, meta);

    await this.storage.write(
      VAULT_META_PATH,
      utf8ToBytes(JSON.stringify(updatedMeta, null, 2)),
      'Reset Obsync vault password via recovery key'
    );

    const indexRes = await this.storage.read(VAULT_INDEX_PATH);
    const index = indexRes.data
      ? await decryptJson<VaultIndex>(dek, indexRes.data)
      : createEmptyIndex();

    return { dek, meta: updatedMeta, index };
  }

  async changeMasterPassword(
    dek: CryptoKey,
    newPassword: string,
    meta: VaultMeta
  ): Promise<VaultMeta> {
    const updated = await rewrapPassword(dek, newPassword, meta);
    await this.storage.write(
      VAULT_META_PATH,
      utf8ToBytes(JSON.stringify(updated, null, 2)),
      'Update Obsync master password'
    );
    return updated;
  }

  async regenerateRecoveryKeyAndSave(
    dek: CryptoKey,
    meta: VaultMeta
  ): Promise<{ meta: VaultMeta; recoveryKey: string }> {
    const { meta: updated, recoveryKey } = await regenerateRecoveryKey(dek, meta);
    await this.storage.write(
      VAULT_META_PATH,
      utf8ToBytes(JSON.stringify(updated, null, 2)),
      'Regenerate Obsync recovery key'
    );
    return { meta: updated, recoveryKey };
  }

  async refreshIndex(dek: CryptoKey): Promise<VaultIndex> {
    const res = await this.storage.read(VAULT_INDEX_PATH);
    if (!res.data) return createEmptyIndex();
    return decryptJson<VaultIndex>(dek, res.data);
  }

  async readPrivateNote(dek: CryptoKey, noteId: string): Promise<string> {
    const res = await this.storage.read(VAULT_NOTE_PATH(noteId));
    if (!res.data) {
      throw new Error('Encrypted note payload not found.');
    }
    const plain = await decryptBytes(dek, res.data);
    return bytesToUtf8(plain);
  }

  private async fetchAndMergeIndex(
    dek: CryptoKey,
    currentIndex: VaultIndex
  ): Promise<VaultIndex> {
    try {
      const res = await this.storage.read(VAULT_INDEX_PATH);
      if (!res.data) return currentIndex;
      const remoteIndex = await decryptJson<VaultIndex>(dek, res.data);
      return mergeVaultIndexes(currentIndex, remoteIndex);
    } catch {
      return currentIndex;
    }
  }

  async savePrivateNote(
    dek: CryptoKey,
    currentIndex: VaultIndex,
    input: { id?: string; title: string; folder: string; content: string }
  ): Promise<{ index: VaultIndex; note: PrivateNoteEntry; mirror: MirrorSummary }> {
    const cleanTitle = input.title.trim() || 'Untitled';
    const cleanFolder = input.folder
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    const now = new Date().toISOString();

    const baseIndex = await this.fetchAndMergeIndex(dek, currentIndex);
    const id = input.id ?? createUuid();
    const existing = baseIndex.notes.find((n) => n.id === id);

    const note: PrivateNoteEntry = {
      id,
      title: cleanTitle,
      folder: cleanFolder,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deleted: false,
    };

    const noteCipher = await encryptBytes(dek, utf8ToBytes(input.content));
    await this.storage.write(
      VAULT_NOTE_PATH(id),
      noteCipher,
      `Update encrypted note ${id}`
    );

    const nextNotes = existing
      ? baseIndex.notes.map((n) => (n.id === id ? note : n))
      : [...baseIndex.notes, note];

    const nextIndex: VaultIndex = {
      version: 1,
      updatedAt: now,
      notes: nextNotes,
    };

    const indexCipher = await encryptJson(dek, nextIndex);
    const mirror = await this.storage.write(
      VAULT_INDEX_PATH,
      indexCipher,
      'Update encrypted vault index'
    );

    return { index: nextIndex, note, mirror };
  }

  async deletePrivateNote(
    dek: CryptoKey,
    currentIndex: VaultIndex,
    noteId: string
  ): Promise<{ index: VaultIndex; mirror: MirrorSummary }> {
    const now = new Date().toISOString();
    const baseIndex = await this.fetchAndMergeIndex(dek, currentIndex);
    const existing = baseIndex.notes.find((n) => n.id === noteId);

    const tombstone: PrivateNoteEntry = {
      id: noteId,
      title: '',
      folder: '',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deleted: true,
    };

    const nextNotes = existing
      ? baseIndex.notes.map((n) => (n.id === noteId ? tombstone : n))
      : [...baseIndex.notes, tombstone];

    const nextIndex: VaultIndex = {
      version: 1,
      updatedAt: now,
      notes: nextNotes,
    };

    await this.storage.delete(
      VAULT_NOTE_PATH(noteId),
      `Delete encrypted note ${noteId}`
    );

    const indexCipher = await encryptJson(dek, nextIndex);
    const mirror = await this.storage.write(
      VAULT_INDEX_PATH,
      indexCipher,
      'Update encrypted vault index'
    );

    return { index: nextIndex, mirror };
  }

  async importLegacyPrivateNotes(
    dek: CryptoKey,
    currentIndex: VaultIndex,
    legacyPassword: string,
    legacyFolder = 'private'
  ): Promise<{ imported: number; failed: string[]; index: VaultIndex }> {
    const prefix = `${legacyFolder.replace(/^\/+|\/+$/g, '')}/.encrypted/`;
    const listRes = await this.storage.list(prefix);
    const encFiles = listRes.entries.filter((e) => e.path.endsWith('.enc'));

    let workingIndex = currentIndex;
    let imported = 0;
    const failed: string[] = [];

    for (const file of encFiles) {
      try {
        const readRes = await this.storage.read(file.path);
        if (!readRes.data) continue;
        const plainBytes = await decryptLegacyCliBlob(readRes.data, legacyPassword);
        const content = bytesToUtf8(plainBytes);

        const rawName = file.path.slice(prefix.length).replace(/\.enc$/i, '');
        const parts = rawName.split('/');
        const title = (parts.pop() ?? 'Imported').replace(/\.md$/i, '');
        const folder = parts.length > 0 ? `Imported/${parts.join('/')}` : 'Imported';

        const saved = await this.savePrivateNote(dek, workingIndex, {
          title,
          folder,
          content,
        });
        workingIndex = saved.index;
        imported++;
      } catch {
        failed.push(file.path);
      }
    }

    return { imported, failed, index: workingIndex };
  }
}
