import { asBufferSource, toBuffer } from '../crypto/base64';
import type { FileEntry, PendingMirrorOp } from './types';

export interface CachedFileRecord {
  path: string;
  data: Uint8Array<ArrayBuffer>;
  updatedAt: string;
  etag?: string;
}

interface CachedFileMeta {
  path: string;
  size: number;
  updatedAt: string;
  etag?: string;
}

const DB_NAME = 'obsync-cache-v1';
const DB_VERSION = 2;
const STORE_FILES = 'files';
const STORE_FILE_META = 'fileMeta';
const STORE_PENDING = 'pendingOps';
const STORE_HANDLES = 'fsHandles';

function ensureUint8ArrayBuffer(data: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
  if (data instanceof Uint8Array) {
    return asBufferSource(data);
  }
  return new Uint8Array(data);
}

export class OfflineCache {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private memoryOnly = false;
  private memFiles = new Map<string, CachedFileRecord>();
  private memPending = new Map<string, PendingMirrorOp>();
  private memHandles = new Map<string, unknown>();

  private get hasIdb(): boolean {
    return (
      typeof globalThis !== 'undefined' &&
      'indexedDB' in globalThis &&
      !!globalThis.indexedDB
    );
  }

  private get useIdb(): boolean {
    return !this.memoryOnly && this.hasIdb;
  }

  setMemoryOnly(enabled: boolean): void {
    this.memoryOnly = enabled;
  }

  isMemoryOnly(): boolean {
    return this.memoryOnly;
  }

  async clearAll(): Promise<void> {
    this.memFiles.clear();
    this.memPending.clear();
    this.memHandles.clear();
    if (!this.hasIdb) return;
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        [STORE_FILES, STORE_FILE_META, STORE_PENDING, STORE_HANDLES],
        'readwrite'
      );
      tx.objectStore(STORE_FILES).clear();
      tx.objectStore(STORE_FILE_META).clear();
      tx.objectStore(STORE_PENDING).clear();
      tx.objectStore(STORE_HANDLES).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
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
        if (!db.objectStoreNames.contains(STORE_FILE_META)) {
          const metaStore = db.createObjectStore(STORE_FILE_META, {
            keyPath: 'path',
          });
          // Backfill fileMeta when upgrading an existing v1 cache
          if (event.oldVersion > 0 && event.oldVersion < 2 && req.transaction) {
            const filesStore = req.transaction.objectStore(STORE_FILES);
            const cursorReq = filesStore.openCursor();
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (!cursor) return;
              const rec = cursor.value as CachedFileRecord;
              const meta: CachedFileMeta = {
                path: rec.path,
                size: rec.data?.byteLength ?? 0,
                updatedAt: rec.updatedAt,
                etag: rec.etag,
              };
              metaStore.put(meta);
              cursor.continue();
            };
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        this.dbPromise = null;
        reject(req.error);
      };
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
      tx.onerror = () => reject(tx.error);
    });
  }

  async putFile(path: string, data: Uint8Array, etag?: string): Promise<void> {
    const buf = toBuffer(data);
    const updatedAt = new Date().toISOString();
    const record: CachedFileRecord = {
      path,
      data: buf,
      updatedAt,
      etag,
    };
    if (!this.useIdb) {
      this.memFiles.set(path, record);
      return;
    }
    const meta: CachedFileMeta = {
      path,
      size: buf.byteLength,
      updatedAt,
      etag,
    };
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_FILES, STORE_FILE_META], 'readwrite');
      tx.objectStore(STORE_FILES).put(record);
      tx.objectStore(STORE_FILE_META).put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async getFile(path: string): Promise<CachedFileRecord | null> {
    if (!this.useIdb) {
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
      data: ensureUint8ArrayBuffer(res.data),
    };
  }

  async deleteFile(path: string): Promise<void> {
    if (!this.useIdb) {
      this.memFiles.delete(path);
      return;
    }
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_FILES, STORE_FILE_META], 'readwrite');
      tx.objectStore(STORE_FILES).delete(path);
      tx.objectStore(STORE_FILE_META).delete(path);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async clearFiles(): Promise<void> {
    this.memFiles.clear();
    if (!this.useIdb) {
      return;
    }
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_FILES, STORE_FILE_META], 'readwrite');
      tx.objectStore(STORE_FILES).clear();
      tx.objectStore(STORE_FILE_META).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async listFiles(prefix = ''): Promise<FileEntry[]> {
    const norm = prefix.replace(/^\/+/, '');
    if (!this.useIdb) {
      return Array.from(this.memFiles.values())
        .filter((f) => !norm || f.path.startsWith(norm))
        .map((f) => ({
          path: f.path,
          size: f.data.byteLength,
          etag: f.etag,
          updatedAt: f.updatedAt,
        }));
    }
    // Read lightweight metadata store only — never deserializes binary file payloads
    const allMeta = await this.runTx<CachedFileMeta[]>(
      STORE_FILE_META,
      'readonly',
      (s) => s.getAll()
    );
    return allMeta
      .filter((f) => !norm || f.path.startsWith(norm))
      .map((f) => ({
        path: f.path,
        size: f.size,
        etag: f.etag,
        updatedAt: f.updatedAt,
      }));
  }

  async enqueueMirrorOp(op: PendingMirrorOp): Promise<void> {
    const clean: PendingMirrorOp = {
      ...op,
      data: op.data ? toBuffer(op.data) : undefined,
    };
    if (!this.useIdb) {
      this.memPending.set(clean.id, clean);
      return;
    }
    await this.runTx(STORE_PENDING, 'readwrite', (s) => s.put(clean));
  }

  async removeMirrorOp(id: string): Promise<void> {
    if (!this.useIdb) {
      this.memPending.delete(id);
      return;
    }
    await this.runTx(STORE_PENDING, 'readwrite', (s) => s.delete(id));
  }

  /**
   * Key-only lookup (`${providerId}::${path}`) avoiding binary blob deserialization.
   */
  async getPendingOpKeys(): Promise<string[]> {
    if (!this.useIdb) {
      return Array.from(this.memPending.keys());
    }
    const keys = await this.runTx<IDBValidKey[]>(
      STORE_PENDING,
      'readonly',
      (s) => s.getAllKeys()
    );
    return keys.map(String);
  }

  async getPendingCountsByProvider(): Promise<{
    counts: Map<string, number>;
    total: number;
  }> {
    const keys = await this.getPendingOpKeys();
    const counts = new Map<string, number>();
    for (const key of keys) {
      const sep = key.indexOf('::');
      if (sep <= 0) continue;
      const providerId = key.slice(0, sep);
      counts.set(providerId, (counts.get(providerId) ?? 0) + 1);
    }
    return { counts, total: keys.length };
  }

  async getPendingProviderIdsForPath(path: string): Promise<Set<string>> {
    const keys = await this.getPendingOpKeys();
    const suffix = `::${path}`;
    const result = new Set<string>();
    for (const key of keys) {
      if (key.endsWith(suffix)) {
        const providerId = key.slice(0, key.length - suffix.length);
        if (providerId) result.add(providerId);
      }
    }
    return result;
  }

  async getPendingOps(providerId?: string): Promise<PendingMirrorOp[]> {
    const all = !this.useIdb
      ? Array.from(this.memPending.values())
      : await this.runTx<PendingMirrorOp[]>(STORE_PENDING, 'readonly', (s) =>
          s.getAll()
        );
    const filtered = providerId
      ? all.filter((op) => op.providerId === providerId)
      : all;
    return filtered.map((op) => ({
      ...op,
      data: op.data ? ensureUint8ArrayBuffer(op.data) : undefined,
    }));
  }

  async clearPendingForProvider(providerId: string): Promise<void> {
    const prefix = `${providerId}::`;
    if (!this.useIdb) {
      for (const key of Array.from(this.memPending.keys())) {
        if (key.startsWith(prefix)) this.memPending.delete(key);
      }
      return;
    }

    const keys = await this.getPendingOpKeys();
    const matching = keys.filter((k) => k.startsWith(prefix));
    if (matching.length === 0) return;

    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING, 'readwrite');
      const store = tx.objectStore(STORE_PENDING);
      for (const key of matching) {
        store.delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async saveFsHandle(providerId: string, handle: unknown): Promise<void> {
    if (!this.useIdb) {
      this.memHandles.set(providerId, handle);
      return;
    }
    await this.runTx(STORE_HANDLES, 'readwrite', (s) => s.put(handle, providerId));
  }

  async getFsHandle<T = unknown>(providerId: string): Promise<T | null> {
    if (!this.useIdb) {
      return (this.memHandles.get(providerId) as T | undefined) ?? null;
    }
    const res = await this.runTx<T | undefined>(STORE_HANDLES, 'readonly', (s) =>
      s.get(providerId)
    );
    return res ?? null;
  }

  async deleteFsHandle(providerId: string): Promise<void> {
    if (!this.useIdb) {
      this.memHandles.delete(providerId);
      return;
    }
    await this.runTx(STORE_HANDLES, 'readwrite', (s) => s.delete(providerId));
  }
}
