import { concatBytes, utf8ToBytes } from '../../crypto/base64';
import {
  AuthExpiredError,
  type FileEntry,
  type GoogleDriveProviderConfig,
  type ReadResult,
  type StorageProvider,
} from '../types';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const SCOPES =
  'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';

export interface GoogleTokenRecord {
  accessToken: string;
  expiresAt: number;
  email?: string;
}

const tokenStore = new Map<string, GoogleTokenRecord>();
let gsiLoadPromise: Promise<void> | null = null;

interface GoogleOAuth2Client {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    hint?: string;
    prompt?: string;
    callback: (response: {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    }) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): { requestAccessToken(overrideConfig?: { prompt?: string; hint?: string }): void };
}

function getGoogleOAuth2(): GoogleOAuth2Client | undefined {
  const w = window as unknown as {
    google?: { accounts?: { oauth2?: GoogleOAuth2Client } };
  };
  return w.google?.accounts?.oauth2;
}

async function loadGsiScript(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('Google Sign-In requires a browser environment.');
  }
  if (getGoogleOAuth2()) return;
  if (gsiLoadPromise) return gsiLoadPromise;

  gsiLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]'
    );
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('Failed to load Google Identity Services.')),
        { once: true }
      );
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gsiLoadPromise = null;
      reject(new Error('Failed to load Google Identity Services script.'));
    };
    document.head.appendChild(script);
  });

  return gsiLoadPromise;
}

export function setGoogleDriveToken(
  providerId: string,
  record: GoogleTokenRecord
): void {
  tokenStore.set(providerId, record);
}

export function clearGoogleDriveToken(providerId: string): void {
  tokenStore.delete(providerId);
}

export function getGoogleDriveTokenStatus(providerId: string): {
  connected: boolean;
  expiresInMinutes: number;
  email?: string;
} {
  const rec = tokenStore.get(providerId);
  if (!rec) return { connected: false, expiresInMinutes: 0 };
  const remainingMs = rec.expiresAt - Date.now();
  if (remainingMs <= 30_000) {
    return { connected: false, expiresInMinutes: 0, email: rec.email };
  }
  return {
    connected: true,
    expiresInMinutes: Math.max(1, Math.round(remainingMs / 60_000)),
    email: rec.email,
  };
}

export async function authorizeGoogleDriveAccount(
  providerId: string,
  clientId: string,
  loginHint?: string
): Promise<GoogleTokenRecord> {
  if (!clientId.trim()) {
    throw new Error('Google OAuth Client ID is required.');
  }

  await loadGsiScript();
  const oauth2 = getGoogleOAuth2();
  if (!oauth2) {
    throw new Error('Google Identity Services failed to initialize.');
  }

  const tokenResp = await new Promise<{ accessToken: string; expiresAt: number }>(
    (resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: clientId.trim(),
        scope: SCOPES,
        hint: loginHint,
        prompt: loginHint ? '' : 'select_account consent',
        callback: (res) => {
          if (res.error || !res.access_token) {
            reject(
              new Error(
                res.error_description || res.error || 'Google sign-in cancelled.'
              )
            );
            return;
          }
          const expiresInSec = res.expires_in ?? 3600;
          resolve({
            accessToken: res.access_token,
            expiresAt: Date.now() + expiresInSec * 1000,
          });
        },
        error_callback: (err) => {
          reject(new Error(err.message || err.type || 'Google OAuth popup failed.'));
        },
      });
      client.requestAccessToken({
        hint: loginHint,
        prompt: loginHint ? 'select_account' : 'select_account consent',
      });
    }
  );

  let email = loginHint;
  try {
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenResp.accessToken}` },
    });
    if (infoRes.ok) {
      const info = (await infoRes.json()) as { email?: string };
      if (info.email) email = info.email;
    }
  } catch {
    // Email lookup optional
  }

  const record: GoogleTokenRecord = {
    accessToken: tokenResp.accessToken,
    expiresAt: tokenResp.expiresAt,
    email,
  };
  tokenStore.set(providerId, record);
  return record;
}

interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
}

export class GoogleDriveProvider implements StorageProvider {
  readonly id: string;
  readonly type = 'gdrive' as const;
  readonly label: string;

  private readonly config: GoogleDriveProviderConfig;
  private readonly folderIdCache = new Map<string, string>();
  private readonly fileIdCache = new Map<string, string>();
  private readonly pendingDirOps = new Map<string, Promise<string | null>>();

  constructor(config: GoogleDriveProviderConfig) {
    this.config = config;
    this.id = config.id;
    this.label = config.label;
    if (config.rootFolderId) {
      this.folderIdCache.set('', config.rootFolderId);
    }
  }

  getRootFolderId(): string | undefined {
    return this.folderIdCache.get('');
  }

  private getAccessToken(): string {
    const rec = tokenStore.get(this.id);
    if (!rec || Date.now() >= rec.expiresAt - 15_000) {
      throw new AuthExpiredError(
        `Google Drive (${this.config.accountEmail || this.label}) session expired — click Reconnect in Settings.`
      );
    }
    return rec.accessToken;
  }

  private async authFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = this.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);

    const res = await fetch(url, { ...init, headers, cache: 'no-store' });
    if (res.status === 401) {
      tokenStore.delete(this.id);
      throw new AuthExpiredError(
        `Google Drive (${this.config.accountEmail || this.label}) token rejected — please Reconnect.`
      );
    }
    return res;
  }

  private escapeQuery(val: string): string {
    return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  private async findChild(
    parentId: string,
    name: string,
    isFolder: boolean
  ): Promise<DriveFileItem | null> {
    const mimeOp = isFolder ? '=' : '!=';
    const q = `'${this.escapeQuery(parentId)}' in parents and name = '${this.escapeQuery(
      name
    )}' and mimeType ${mimeOp} '${DRIVE_FOLDER_MIME}' and trashed = false`;

    const url = `${DRIVE_API}/files?q=${encodeURIComponent(
      q
    )}&fields=${encodeURIComponent('files(id,name,mimeType,size,modifiedTime,md5Checksum)')}&pageSize=1`;

    const res = await this.authFetch(url);
    if (!res.ok) {
      throw new Error(`Google Drive query failed (HTTP ${res.status})`);
    }
    const json = (await res.json()) as { files?: DriveFileItem[] };
    return json.files?.[0] ?? null;
  }

  private async createFolder(parentId: string, name: string): Promise<string> {
    const res = await this.authFetch(`${DRIVE_API}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: DRIVE_FOLDER_MIME,
        parents: parentId === 'root' ? undefined : [parentId],
      }),
    });
    if (!res.ok) {
      throw new Error(`Google Drive create folder failed (HTTP ${res.status})`);
    }
    const created = (await res.json()) as { id: string };
    return created.id;
  }

  private async runDedupedDirOp(
    cacheKey: string,
    op: () => Promise<string | null>
  ): Promise<string | null> {
    const inFlight = this.pendingDirOps.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = op().finally(() => {
      this.pendingDirOps.delete(cacheKey);
    });
    this.pendingDirOps.set(cacheKey, promise);
    return promise;
  }

  private async ensureRootFolder(createIfMissing: boolean): Promise<string | null> {
    const cached = this.folderIdCache.get('');
    if (cached) return cached;

    return this.runDedupedDirOp(`__root__:${createIfMissing ? 'rw' : 'ro'}`, async () => {
      const recheck = this.folderIdCache.get('');
      if (recheck) return recheck;

      const folderName = this.config.folderName || 'ObsyncVault';
      const existing = await this.findChild('root', folderName, true);
      if (existing) {
        this.folderIdCache.set('', existing.id);
        return existing.id;
      }
      if (!createIfMissing) return null;

      const id = await this.createFolder('root', folderName);
      this.folderIdCache.set('', id);
      return id;
    });
  }

  private async resolveDir(
    segments: string[],
    createIfMissing: boolean
  ): Promise<string | null> {
    const rootId = await this.ensureRootFolder(createIfMissing);
    if (!rootId) return null;

    let currentId = rootId;
    let currentKey = '';
    for (const seg of segments) {
      currentKey = currentKey ? `${currentKey}/${seg}` : seg;
      const cached = this.folderIdCache.get(currentKey);
      if (cached) {
        currentId = cached;
        continue;
      }

      const parentForSeg = currentId;
      const keyForSeg = currentKey;
      const resolvedId = await this.runDedupedDirOp(
        `${keyForSeg}:${createIfMissing ? 'rw' : 'ro'}`,
        async () => {
          const again = this.folderIdCache.get(keyForSeg);
          if (again) return again;

          const found = await this.findChild(parentForSeg, seg, true);
          if (found) {
            this.folderIdCache.set(keyForSeg, found.id);
            return found.id;
          }
          if (createIfMissing) {
            const createdId = await this.createFolder(parentForSeg, seg);
            this.folderIdCache.set(keyForSeg, createdId);
            return createdId;
          }
          return null;
        }
      );

      if (!resolvedId) return null;
      currentId = resolvedId;
    }

    return currentId;
  }

  private async resolveFileId(cleanPath: string): Promise<string | null> {
    const cached = this.fileIdCache.get(cleanPath);
    if (cached) return cached;

    const parts = cleanPath.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const fileName = parts[parts.length - 1];
    const dirId = await this.resolveDir(parts.slice(0, -1), false);
    if (!dirId) return null;

    const item = await this.findChild(dirId, fileName, false);
    if (!item) return null;

    this.fileIdCache.set(cleanPath, item.id);
    return item.id;
  }

  async testConnection(): Promise<{ ok: boolean; details: string }> {
    try {
      const folderId = await this.ensureRootFolder(true);
      const email =
        tokenStore.get(this.id)?.email || this.config.accountEmail || 'connected';
      return {
        ok: true,
        details: `Connected Google Drive (${email}), folder "${this.config.folderName || 'ObsyncVault'}" [${folderId}]`,
      };
    } catch (err) {
      return {
        ok: false,
        details: err instanceof Error ? err.message : 'Google Drive check failed.',
      };
    }
  }

  async list(prefix = ''): Promise<FileEntry[]> {
    const rootId = await this.ensureRootFolder(false);
    if (!rootId) return [];

    const normPrefix = prefix.replace(/^\/+/, '');
    const entries: FileEntry[] = [];
    const queue: Array<{ id: string; relPath: string }> = [{ id: rootId, relPath: '' }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      let pageToken: string | undefined;

      do {
        const q = `'${this.escapeQuery(current.id)}' in parents and trashed = false`;
        const url = `${DRIVE_API}/files?q=${encodeURIComponent(
          q
        )}&fields=${encodeURIComponent(
          'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)'
        )}&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;

        const res = await this.authFetch(url);
        if (!res.ok) {
          throw new Error(`Google Drive list failed (HTTP ${res.status})`);
        }
        const json = (await res.json()) as {
          nextPageToken?: string;
          files?: DriveFileItem[];
        };

        for (const item of json.files ?? []) {
          if (item.name === '.git') continue;
          const rel = current.relPath ? `${current.relPath}/${item.name}` : item.name;

          if (item.mimeType === DRIVE_FOLDER_MIME) {
            this.folderIdCache.set(rel, item.id);
            queue.push({ id: item.id, relPath: rel });
          } else {
            this.fileIdCache.set(rel, item.id);
            if (!normPrefix || rel.startsWith(normPrefix)) {
              entries.push({
                path: rel,
                size: item.size ? Number(item.size) : undefined,
                etag: item.md5Checksum ?? item.id,
                updatedAt: item.modifiedTime,
              });
            }
          }
        }

        pageToken = json.nextPageToken;
      } while (pageToken);
    }

    return entries;
  }

  async read(path: string): Promise<ReadResult | null> {
    const cleanPath = path.replace(/^\/+/, '');
    const fileId = await this.resolveFileId(cleanPath);
    if (!fileId) return null;

    const res = await this.authFetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`
    );

    if (res.status === 404) {
      this.fileIdCache.delete(cleanPath);
      return null;
    }
    if (!res.ok) {
      throw new Error(`Google Drive read failed (${cleanPath}, HTTP ${res.status})`);
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    return { data: buf, etag: fileId };
  }

  private buildMultipartBody(
    metadata: Record<string, unknown>,
    data: Uint8Array,
    boundary: string
  ): Uint8Array<ArrayBuffer> {
    const head = utf8ToBytes(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
        metadata
      )}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const tail = utf8ToBytes(`\r\n--${boundary}--`);
    return concatBytes(head, data, tail);
  }

  async write(
    path: string,
    data: Uint8Array,
    message?: string,
    attempt = 0
  ): Promise<void> {
    const cleanPath = path.replace(/^\/+/, '');
    const parts = cleanPath.split('/').filter(Boolean);
    const fileName = parts[parts.length - 1];
    const parentId = await this.resolveDir(parts.slice(0, -1), true);
    if (!parentId) throw new Error('Failed to create parent folder in Google Drive.');

    let existingId = this.fileIdCache.get(cleanPath);
    if (!existingId) {
      const found = await this.findChild(parentId, fileName, false);
      if (found) {
        existingId = found.id;
        this.fileIdCache.set(cleanPath, existingId);
      }
    }

    const boundary = `obsync_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    if (existingId) {
      const body = this.buildMultipartBody({ name: fileName }, data, boundary);
      const res = await this.authFetch(
        `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existingId)}?uploadType=multipart`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        }
      );
      if (res.status === 404) {
        this.fileIdCache.delete(cleanPath);
        this.folderIdCache.clear();
        if (attempt < 1) {
          await this.write(cleanPath, data, message, attempt + 1);
          return;
        }
        throw new Error(`Google Drive update failed after retry (${cleanPath}, HTTP 404)`);
      }
      if (!res.ok) {
        throw new Error(`Google Drive update failed (${cleanPath}, HTTP ${res.status})`);
      }
    } else {
      const body = this.buildMultipartBody(
        { name: fileName, parents: [parentId] },
        data,
        boundary
      );
      const res = await this.authFetch(
        `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        }
      );
      if (res.status === 404) {
        this.fileIdCache.delete(cleanPath);
        this.folderIdCache.clear();
        if (attempt < 1) {
          await this.write(cleanPath, data, message, attempt + 1);
          return;
        }
      }
      if (!res.ok) {
        throw new Error(`Google Drive create failed (${cleanPath}, HTTP ${res.status})`);
      }
      const created = (await res.json()) as { id: string };
      this.fileIdCache.set(cleanPath, created.id);
    }
  }

  async delete(path: string): Promise<void> {
    const cleanPath = path.replace(/^\/+/, '');
    const fileId = await this.resolveFileId(cleanPath);
    if (!fileId) return;

    const res = await this.authFetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
      { method: 'DELETE' }
    );
    if (res.status !== 404 && !res.ok) {
      throw new Error(`Google Drive delete failed (${cleanPath}, HTTP ${res.status})`);
    }
    this.fileIdCache.delete(cleanPath);
  }
}
