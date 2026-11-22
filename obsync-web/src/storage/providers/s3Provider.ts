import { toBuffer, utf8ToBytes } from '../../crypto/base64';
import {
  AuthExpiredError,
  type FileEntry,
  type ReadResult,
  type S3ProviderConfig,
  type StorageProvider,
} from '../types';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toBuffer(data));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256(
  key: Uint8Array,
  message: string
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toBuffer(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, utf8ToBytes(message));
  return new Uint8Array(sig);
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodePathSegments(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => encodeRfc3986(seg))
    .join('/');
}

function canonicalizeEncodedPathname(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => {
      try {
        return encodeRfc3986(decodeURIComponent(seg));
      } catch {
        return encodeRfc3986(seg);
      }
    })
    .join('/');
}

export async function signAwsV4Headers(params: {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payload: Uint8Array;
  date?: Date;
}): Promise<Record<string, string>> {
  const now = params.date ?? new Date();
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = iso.slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(params.payload);

  const canonicalUri = canonicalizeEncodedPathname(params.url.pathname) || '/';
  const queryPairs = Array.from(params.url.searchParams.entries())
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([aKey, aVal], [bKey, bVal]) =>
      aKey < bKey
        ? -1
        : aKey > bKey
          ? 1
          : aVal < bVal
            ? -1
            : aVal > bVal
              ? 1
              : 0
    )
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const host = params.url.host;
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalUri,
    queryPairs,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const reqHash = await sha256Hex(utf8ToBytes(canonicalRequest));
  const scope = `${dateStamp}/${params.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, reqHash].join('\n');

  const kDate = await hmacSha256(
    utf8ToBytes(`AWS4${params.secretAccessKey}`),
    dateStamp
  );
  const kRegion = await hmacSha256(kDate, params.region);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  const authorization = `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    Authorization: authorization,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractXmlTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXmlEntities(match[1]) : undefined;
}

export function parseListObjectsV2Xml(xml: string): {
  items: Array<{ key: string; size?: number; etag?: string; updatedAt?: string }>;
  nextToken?: string;
} {
  const items: Array<{ key: string; size?: number; etag?: string; updatedAt?: string }> = [];
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = contentsRegex.exec(xml)) !== null) {
    const block = m[1];
    const key = extractXmlTag(block, 'Key');
    if (!key) continue;
    const sizeStr = extractXmlTag(block, 'Size');
    const etag = extractXmlTag(block, 'ETag')?.replace(/^"|"$/g, '');
    const updatedAt = extractXmlTag(block, 'LastModified');
    items.push({
      key,
      size: sizeStr ? Number(sizeStr) : undefined,
      etag,
      updatedAt,
    });
  }

  const isTruncated = extractXmlTag(xml, 'IsTruncated') === 'true';
  const nextToken = isTruncated
    ? extractXmlTag(xml, 'NextContinuationToken')
    : undefined;

  return { items, nextToken };
}

export class S3Provider implements StorageProvider {
  readonly id: string;
  readonly type = 's3' as const;
  readonly label: string;

  private readonly config: S3ProviderConfig;

  constructor(config: S3ProviderConfig) {
    this.config = config;
    this.id = config.id;
    this.label = config.label;
  }

  private get basePrefix(): string {
    return (this.config.prefix ?? '').replace(/^\/+|\/+$/g, '');
  }

  private buildFullKey(path: string): string {
    const clean = path.replace(/^\/+/, '');
    return this.basePrefix ? `${this.basePrefix}/${clean}` : clean;
  }

  private stripBasePrefix(key: string): string {
    if (!this.basePrefix) return key;
    const p = `${this.basePrefix}/`;
    return key.startsWith(p) ? key.slice(p.length) : key;
  }

  private buildObjectUrl(key?: string, query?: Record<string, string>): URL {
    const endpoint = this.config.endpoint.replace(/\/+$/, '');
    const bucket = encodeRfc3986(this.config.bucket);
    const keyPart = key ? `/${encodePathSegments(key)}` : '';
    const url = new URL(`${endpoint}/${bucket}${keyPart}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }
    return url;
  }

  private async signedFetch(
    method: string,
    url: URL,
    payload: Uint8Array = new Uint8Array(0)
  ): Promise<Response> {
    const headers = await signAwsV4Headers({
      method,
      url,
      region: this.config.region || 'auto',
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      payload,
    });

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: method === 'PUT' ? toBuffer(payload) : undefined,
      cache: 'no-store',
    });

    if (res.status === 401 || res.status === 403) {
      throw new AuthExpiredError(`S3/R2 authentication failed (HTTP ${res.status})`);
    }
    return res;
  }

  async testConnection(): Promise<{ ok: boolean; details: string }> {
    try {
      const url = this.buildObjectUrl(undefined, {
        'list-type': '2',
        'max-keys': '1',
      });
      const res = await this.signedFetch('GET', url);
      if (!res.ok) {
        return { ok: false, details: `S3/R2 connection failed (HTTP ${res.status})` };
      }
      return {
        ok: true,
        details: `Connected to bucket "${this.config.bucket}" (${this.config.region || 'auto'})`,
      };
    } catch (err) {
      return {
        ok: false,
        details: err instanceof Error ? err.message : 'S3/R2 connection failed.',
      };
    }
  }

  async list(prefix = ''): Promise<FileEntry[]> {
    const normPrefix = prefix.replace(/^\/+/, '');
    const fullPrefix = this.buildFullKey(normPrefix);
    const entries: FileEntry[] = [];
    let continuationToken: string | undefined;

    do {
      const query: Record<string, string> = { 'list-type': '2' };
      if (fullPrefix) query.prefix = fullPrefix;
      if (continuationToken) query['continuation-token'] = continuationToken;

      const res = await this.signedFetch('GET', this.buildObjectUrl(undefined, query));
      if (!res.ok) {
        throw new Error(`S3/R2 list failed (HTTP ${res.status})`);
      }

      const xml = await res.text();
      const parsed = parseListObjectsV2Xml(xml);
      for (const item of parsed.items) {
        const rel = this.stripBasePrefix(item.key);
        if (rel.startsWith('.git/')) continue;
        entries.push({
          path: rel,
          size: item.size,
          etag: item.etag,
          updatedAt: item.updatedAt,
        });
      }
      continuationToken = parsed.nextToken;
    } while (continuationToken);

    return entries;
  }

  async read(path: string): Promise<ReadResult | null> {
    const fullKey = this.buildFullKey(path);
    const res = await this.signedFetch('GET', this.buildObjectUrl(fullKey));
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`S3/R2 read failed (${path}, HTTP ${res.status})`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      data: buf,
      etag: res.headers.get('etag')?.replace(/^"|"$/g, '') ?? undefined,
    };
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const fullKey = this.buildFullKey(path);
    const res = await this.signedFetch('PUT', this.buildObjectUrl(fullKey), data);
    if (!res.ok) {
      throw new Error(`S3/R2 write failed (${path}, HTTP ${res.status})`);
    }
  }

  async delete(path: string): Promise<void> {
    const fullKey = this.buildFullKey(path);
    const res = await this.signedFetch('DELETE', this.buildObjectUrl(fullKey));
    if (res.status !== 404 && !res.ok) {
      throw new Error(`S3/R2 delete failed (${path}, HTTP ${res.status})`);
    }
  }
}
