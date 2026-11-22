import { toBuffer } from '../crypto/base64';
import type { FileEntry, PendingMirrorOp } from './types';

export interface CachedFileRecord {
  path: string;
  data: Uint8Array<ArrayBuffer>;
  updatedAt: string;
  etag?: string;
}

const DB_NAME = 'obsync-cache-v1';
const DB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_PENDING = 'pendingOps';
const STORE_HANDLES = 'fsHandles';

export class OfflineCache {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private memFiles = new Map<string, CachedFileRecord>();
  private memPending = new Map<string, PendingMirrorOp>();
  private memHandles = new Map<string, unknown>();

  private get hasIdb(): boolean {
    return typeof globalThis !== 'undefined' && 'indexedDB' in globalThis && !!globalThis.indexedDB;
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES, { keyPath: 'path' });
        }
        if (!db.objectStoreNames.contains(STORE_PENDING)) {
          db.createObjectStore(STORE_PENDING, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_HANDLES)) {
          db.createObjectStore(STORE_HANDLES);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async runTx<T>(
    storeName: string,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async putFile(path: string, data: Uint8Array, etag?: string): Promise<void> {
    const record: CachedFileRecord = {
      path,
      data: toBuffer(data),
      updatedAt: new Date().toISOString(),
      etag,
    };
    if (!this.hasIdb) {
      this.memFiles.set(path, record);
      return;
    }
    await this.runTx(STORE_FILES, 'readwrite', (s) => s.put(record));
  }

  async getFile(path: string): Promise<CachedFileRecord | null> {
    if (!this.hasIdb) {
      return this.memFiles.get(path) ?? null;
    }
    const res = await this.runTx<CachedFileRecord | undefined>(
      STORE_FILES,
      'readonly',
      (s) => s.get(path)
    );
    if (!res) return null;
    return {
      ...res,
      data: toBuffer(new Uint8Array(res.data)),
    };
  }

  async deleteFile(path: string): Promise<void> {
    if (!this.hasIdb) {
      this.memFiles.delete(path);
      return;
    }
    await this.runTx(STORE_FILES, 'readwrite', (s) => s.delete(path));
  }

  async listFiles(prefix = ''): Promise<FileEntry[]> {
    const norm = prefix.replace(/^\/+/, '');
    if (!this.hasIdb) {
      return Array.from(this.memFiles.values())
        .filter((f) => !norm || f.path.startsWith(norm))
        .map((f) => ({
          path: f.path,
          size: f.data.byteLength,
          etag: f.etag,
          updatedAt: f.updatedAt,
        }));
    }
    const all = await this.runTx<CachedFileRecord[]>(STORE_FILES, 'readonly', (s) =>
      s.getAll()
    );
    return all
      .filter((f) => !norm || f.path.startsWith(norm))
      .map((f) => ({
        path: f.path,
        size: f.data?.byteLength ?? 0,
        etag: f.etag,
        updatedAt: f.updatedAt,
      }));
  }

  async enqueueMirrorOp(op: PendingMirrorOp): Promise<void> {
    const clean: PendingMirrorOp = {
      ...op,
      data: op.data ? toBuffer(op.data) : undefined,
    };
    if (!this.hasIdb) {
      this.memPending.set(clean.id, clean);
      return;
    }
    await this.runTx(STORE_PENDING, 'readwrite', (s) => s.put(clean));
  }

  async removeMirrorOp(id: string): Promise<void> {
    if (!this.hasIdb) {
      this.memPending.delete(id);
      return;
    }
    await this.runTx(STORE_PENDING, 'readwrite', (s) => s.delete(id));
  }

  async getPendingOps(providerId?: string): Promise<PendingMirrorOp[]> {
    const all = !this.hasIdb
      ? Array.from(this.memPending.values())
      : await this.runTx<PendingMirrorOp[]>(STORE_PENDING, 'readonly', (s) =>
          s.getAll()
        );
    const normalized = all.map((op) => ({
      ...op,
      data: op.data ? toBuffer(new Uint8Array(op.data)) : undefined,
    }));
    return providerId
      ? normalized.filter((op) => op.providerId === providerId)
      : normalized;
  }

  async clearPendingForProvider(providerId: string): Promise<void> {
    const ops = await this.getPendingOps(providerId);
    for (const op of ops) {
      await this.removeMirrorOp(op.id);
    }
  }

  async saveFsHandle(providerId: string, handle: unknown): Promise<void> {
    if (!this.hasIdb) {
      this.memHandles.set(providerId, handle);
      return;
    }
    await this.runTx(STORE_HANDLES, 'readwrite', (s) => s.put(handle, providerId));
  }

  async getFsHandle<T = unknown>(providerId: string): Promise<T | null> {
    if (!this.hasIdb) {
      return (this.memHandles.get(providerId) as T | undefined) ?? null;
    }
    const res = await this.runTx<T | undefined>(STORE_HANDLES, 'readonly', (s) =>
      s.get(providerId)
    );
    return res ?? null;
  }

  async deleteFsHandle(providerId: string): Promise<void> {
    if (!this.hasIdb) {
      this.memHandles.delete(providerId);
      return;
    }
    await this.runTx(STORE_HANDLES, 'readwrite', (s) => s.delete(providerId));
  }
}
