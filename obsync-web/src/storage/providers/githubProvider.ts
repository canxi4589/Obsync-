import { base64ToBytes, bytesToBase64 } from '../../crypto/base64';
import { assertSafeStoragePath } from '../pathUtils';
import {
  AuthExpiredError,
  type FileEntry,
  type GitHubProviderConfig,
  type ReadResult,
  type StorageProvider,
} from '../types';

const API_BASE = 'https://api.github.com';

export class GitHubProvider implements StorageProvider {
  readonly id: string;
  readonly type = 'github' as const;
  readonly label: string;

  private readonly config: GitHubProviderConfig;
  private readonly shaCache = new Map<string, string>();

  constructor(config: GitHubProviderConfig) {
    this.config = config;
    this.id = config.id;
    this.label = config.label;
  }

  private get repoBase(): string {
    return `${API_BASE}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`;
  }

  private requireToken(): string {
    const token = this.config.token.trim();
    if (!token) {
      throw new AuthExpiredError(
        `GitHub (${this.label}) token missing — edit provider in Settings to re-enter your PAT.`
      );
    }
    return token;
  }

  private encodePath(path: string): string {
    return path
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join('/');
  }

  private headers(extra?: Record<string, string>): HeadersInit {
    return {
      Authorization: `Bearer ${this.requireToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  private async handleError(res: Response, context: string): Promise<never> {
    let msg = `${context} (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) msg = `${context}: ${body.message}`;
    } catch {
      // ignore non-json error body
    }
    if (res.status === 401) {
      throw new AuthExpiredError(msg);
    }
    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0' || /rate limit/i.test(msg)) {
        throw new Error(msg);
      }
      throw new AuthExpiredError(msg);
    }
    throw new Error(msg);
  }

  async testConnection(): Promise<{ ok: boolean; details: string }> {
    const res = await fetch(this.repoBase, {
      headers: this.headers(),
      cache: 'no-store',
    });

    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { message?: string };
        if (j?.message) message = j.message;
      } catch {
        // ignore
      }
      return { ok: false, details: `GitHub connection failed: ${message}` };
    }

    const repo = (await res.json()) as {
      full_name: string;
      private: boolean;
      permissions?: { push?: boolean };
      default_branch?: string;
    };

    const canPush = repo.permissions?.push ?? true;
    const branch = this.config.branch || repo.default_branch || 'main';
    return {
      ok: true,
      details: `Connected to ${repo.full_name} (${repo.private ? 'private' : 'public'}, branch: ${branch}${canPush ? '' : ', read-only'})`,
    };
  }

  private async walkContentsFallback(
    startDir: string,
    normPrefix: string
  ): Promise<FileEntry[]> {
    const branch = encodeURIComponent(this.config.branch || 'main');
    const entries: FileEntry[] = [];
    const queue: string[] = [startDir];

    while (queue.length > 0) {
      const batch = queue.splice(0, 4);
      const results = await Promise.all(
        batch.map(async (dir) => {
          const pathSegment = dir ? `/${this.encodePath(dir)}` : '';
          const url = `${this.repoBase}/contents${pathSegment}?ref=${branch}`;
          const res = await fetch(url, { headers: this.headers(), cache: 'no-store' });
          if (res.status === 404) return [];
          if (!res.ok) {
            await this.handleError(res, `GitHub list failed (${dir || '/'})`);
          }
          const json = (await res.json()) as
            | Array<{ path: string; type: string; sha: string; size?: number }>
            | { path: string; type: string; sha: string; size?: number };
          return Array.isArray(json) ? json : [json];
        })
      );

      for (const items of results) {
        for (const item of items) {
          if (item.type === 'dir') {
            if (item.path === '.git' || item.path.startsWith('.git/')) continue;
            if (
              !normPrefix ||
              item.path.startsWith(normPrefix) ||
              normPrefix.startsWith(`${item.path}/`)
            ) {
              queue.push(item.path);
            }
          } else if (item.type === 'file') {
            this.shaCache.set(item.path, item.sha);
            if (!normPrefix || item.path.startsWith(normPrefix)) {
              entries.push({
                path: item.path,
                size: item.size,
                etag: item.sha,
              });
            }
          }
        }
      }
    }

    return entries;
  }

  async list(prefix = ''): Promise<FileEntry[]> {
    const branch = encodeURIComponent(this.config.branch || 'main');
    const url = `${this.repoBase}/git/trees/${branch}?recursive=1`;
    const res = await fetch(url, {
      headers: this.headers(),
      cache: 'no-store',
    });

    if (res.status === 409) {
      // Empty Git repository
      return [];
    }
    if (res.status === 404) {
      // Distinguish a genuinely empty repository from a missing/misspelled branch name
      const repoRes = await fetch(this.repoBase, {
        headers: this.headers(),
        cache: 'no-store',
      });
      if (repoRes.ok) {
        const repoJson = (await repoRes.json()) as {
          size?: number;
          default_branch?: string;
        };
        if ((repoJson.size ?? 0) === 0) {
          return [];
        }
        throw new Error(
          `GitHub branch "${this.config.branch || 'main'}" not found (default branch is "${repoJson.default_branch ?? 'unknown'}").`
        );
      }
      await this.handleError(res, 'GitHub list failed');
    }
    if (!res.ok) {
      await this.handleError(res, 'GitHub list failed');
    }

    const data = (await res.json()) as {
      truncated?: boolean;
      tree?: Array<{ path: string; type: string; sha: string; size?: number }>;
    };

    const normPrefix = prefix.replace(/\\/g, '/').replace(/^\/+/, '');
    if (data.truncated) {
      const startDir = normPrefix.includes('/')
        ? normPrefix.slice(0, normPrefix.lastIndexOf('/'))
        : '';
      return this.walkContentsFallback(startDir, normPrefix);
    }

    const entries: FileEntry[] = [];
    for (const item of data.tree ?? []) {
      if (item.type !== 'blob') continue;
      if (normPrefix && !item.path.startsWith(normPrefix)) continue;
      this.shaCache.set(item.path, item.sha);
      entries.push({
        path: item.path,
        size: item.size,
        etag: item.sha,
      });
    }

    return entries;
  }

  async read(path: string): Promise<ReadResult | null> {
    const cleanPath = assertSafeStoragePath(path);
    const branch = encodeURIComponent(this.config.branch || 'main');
    const url = `${this.repoBase}/contents/${this.encodePath(cleanPath)}?ref=${branch}`;
    const res = await fetch(url, {
      headers: this.headers(),
      cache: 'no-store',
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      await this.handleError(res, `GitHub read failed (${cleanPath})`);
    }

    const json = (await res.json()) as {
      sha: string;
      content?: string;
      encoding?: string;
      type?: string;
    };

    if (json.sha) {
      this.shaCache.set(cleanPath, json.sha);
    }

    if (json.content && json.encoding === 'base64') {
      return {
        data: base64ToBytes(json.content),
        etag: json.sha,
      };
    }

    // Large file (>1MB) fallback via Git Blobs API
    if (json.sha) {
      const blobRes = await fetch(`${this.repoBase}/git/blobs/${json.sha}`, {
        headers: this.headers(),
        cache: 'no-store',
      });
      if (!blobRes.ok) {
        await this.handleError(blobRes, `GitHub blob read failed (${cleanPath})`);
      }
      const blob = (await blobRes.json()) as { content: string; encoding: string };
      return {
        data: base64ToBytes(blob.content),
        etag: json.sha,
      };
    }

    return { data: new Uint8Array(0), etag: json.sha };
  }

  /**
   * Resolves a file's SHA by listing its parent directory first (metadata only,
   * no base64 body download, and warms shaCache for siblings), falling back to
   * direct file metadata lookup if needed.
   */
  private async fetchCurrentSha(cleanPath: string): Promise<string | undefined> {
    const branch = encodeURIComponent(this.config.branch || 'main');
    const slashIdx = cleanPath.lastIndexOf('/');
    const parentDir = slashIdx > 0 ? cleanPath.slice(0, slashIdx) : '';
    const parentUrl = `${this.repoBase}/contents${
      parentDir ? `/${this.encodePath(parentDir)}` : ''
    }?ref=${branch}`;

    const dirRes = await fetch(parentUrl, {
      headers: this.headers(),
      cache: 'no-store',
    });

    if (dirRes.ok) {
      const json = (await dirRes.json()) as unknown;
      if (Array.isArray(json)) {
        let foundSha: string | undefined;
        for (const item of json as Array<{ path?: string; sha?: string; type?: string }>) {
          if (item.type === 'file' && item.path && item.sha) {
            this.shaCache.set(item.path, item.sha);
            if (item.path === cleanPath) foundSha = item.sha;
          }
        }
        if (!foundSha) this.shaCache.delete(cleanPath);
        return foundSha;
      }
    } else if (dirRes.status === 404) {
      this.shaCache.delete(cleanPath);
      return undefined;
    }

    // Fallback: direct contents lookup
    const url = `${this.repoBase}/contents/${this.encodePath(cleanPath)}?ref=${branch}`;
    const res = await fetch(url, { headers: this.headers(), cache: 'no-store' });
    if (res.status === 404) {
      this.shaCache.delete(cleanPath);
      return undefined;
    }
    if (!res.ok) {
      await this.handleError(res, `GitHub SHA lookup failed (${cleanPath})`);
    }
    const json = (await res.json()) as { sha?: string };
    if (json.sha) {
      this.shaCache.set(cleanPath, json.sha);
    }
    return json.sha;
  }

  async write(path: string, data: Uint8Array, message?: string): Promise<void> {
    const cleanPath = assertSafeStoragePath(path);
    const commitMsg = message || `obsync: update ${cleanPath}`;
    const contentB64 = bytesToBase64(data);

    let sha = this.shaCache.get(cleanPath);
    if (!sha) {
      sha = await this.fetchCurrentSha(cleanPath);
    }

    const attemptPut = async (currentSha?: string): Promise<Response> => {
      const body: Record<string, string> = {
        message: commitMsg,
        content: contentB64,
        branch: this.config.branch || 'main',
      };
      if (currentSha) body.sha = currentSha;

      return fetch(`${this.repoBase}/contents/${this.encodePath(cleanPath)}`, {
        method: 'PUT',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
    };

    let res = await attemptPut(sha);
    if (res.status === 409 || res.status === 422) {
      // Refresh SHA on race/mismatch and retry once
      const freshSha = await this.fetchCurrentSha(cleanPath);
      res = await attemptPut(freshSha);
    }

    if (!res.ok) {
      await this.handleError(res, `GitHub write failed (${cleanPath})`);
    }

    const json = (await res.json()) as { content?: { sha?: string } };
    if (json.content?.sha) {
      this.shaCache.set(cleanPath, json.content.sha);
    }
  }

  async delete(path: string, message?: string): Promise<void> {
    const cleanPath = assertSafeStoragePath(path);
    const sha =
      this.shaCache.get(cleanPath) ?? (await this.fetchCurrentSha(cleanPath));
    if (!sha) return; // already absent

    const commitMsg = message || `obsync: delete ${cleanPath}`;
    const attemptDel = (targetSha: string) =>
      fetch(`${this.repoBase}/contents/${this.encodePath(cleanPath)}`, {
        method: 'DELETE',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          message: commitMsg,
          sha: targetSha,
          branch: this.config.branch || 'main',
        }),
      });

    let res = await attemptDel(sha);
    if (res.status === 409) {
      const freshSha = await this.fetchCurrentSha(cleanPath);
      if (!freshSha) return;
      res = await attemptDel(freshSha);
    }

    if (res.status === 404) {
      this.shaCache.delete(cleanPath);
      return;
    }
    if (!res.ok) {
      await this.handleError(res, `GitHub delete failed (${cleanPath})`);
    }

    this.shaCache.delete(cleanPath);
  }
}
