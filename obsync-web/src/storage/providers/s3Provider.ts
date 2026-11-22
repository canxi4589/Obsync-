import { asBufferSource, utf8ToBytes } from '../../crypto/base64';
import { assertSafeStoragePath } from '../pathUtils';
import {
  AuthExpiredError,
  type FileEntry,
  type ReadResult,
  type S3ProviderConfig,
  type StorageProvider,
} from '../types';

const SIGNING_KEY_CACHE_MAX = 8;
const signingKeyCache = new Map<string, CryptoKey>();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', asBufferSource(data));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256Raw(
  key: Uint8Array,
  message: string
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    asBufferSource(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, utf8ToBytes(message));
  return new Uint8Array(sig);
}

async function getSigningCryptoKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string
): Promise<CryptoKey> {
  // Key cache by HMAC of secret + scope (never stores plaintext secret as map key)
  const keyTag = await sha256Hex(
    utf8ToBytes(`${dateStamp}|${region}|${secretAccessKey}`)
  );
  const cached = signingKeyCache.get(keyTag);
  if (cached) return cached;

  const secretBytes = utf8ToBytes(`AWS4${secretAccessKey}`);
  let kDate: Uint8Array<ArrayBuffer> | undefined;
  let kRegion: Uint8Array<ArrayBuffer> | undefined;
  let kService: Uint8Array<ArrayBuffer> | undefined;
  let kSigning: Uint8Array<ArrayBuffer> | undefined;

  try {
    kDate = await hmacSha256Raw(secretBytes, dateStamp);
    kRegion = await hmacSha256Raw(kDate, region);
    kService = await hmacSha256Raw(kRegion, 's3');
    kSigning = await hmacSha256Raw(kService, 'aws4_request');

    const signingKey = await crypto.subtle.importKey(
      'raw',
      kSigning,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    if (signingKeyCache.size >= SIGNING_KEY_CACHE_MAX) {
      const oldest = signingKeyCache.keys().next().value;
      if (oldest) signingKeyCache.delete(oldest);
    }
    signingKeyCache.set(keyTag, signingKey);
    return signingKey;
  } finally {
    secretBytes.fill(0);
    kDate?.fill(0);
    kRegion?.fill(0);
    kService?.fill(0);
    kSigning?.fill(0);
  }
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

export function assertValidS3Endpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid S3/R2 endpoint URL.');
  }
  const isLocal =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error(
      'S3/R2 endpoint must use HTTPS (plain HTTP is allowed only for localhost).'
    );
  }
  return url;
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

  const signingKey = await getSigningCryptoKey(
    params.secretAccessKey,
    dateStamp,
    params.region
  );
  const sigBuf = await crypto.subtle.sign(
    'HMAC',
    signingKey,
    utf8ToBytes(stringToSign)
  );
  const signature = toHex(new Uint8Array(sigBuf));

  const authorization = `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    Authorization: authorization,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
}

/**
 * Single-pass XML entity decoder (prevents `&amp;lt;` double-unescaping bugs
 * and supports numeric character references used by S3).
 */
export function decodeXmlEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
    (full, entity: string) => {
      switch (entity) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default: {
          if (entity.startsWith('#x')) {
            const code = Number.parseInt(entity.slice(2), 16);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
              ? String.fromCodePoint(code)
              : full;
          }
          if (entity.startsWith('#')) {
            const code = Number.parseInt(entity.slice(1), 10);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
              ? String.fromCodePoint(code)
              : full;
          }
          return full;
        }
      }
    }
  );
}

/**
 * Linear O(n) XML tag extractor (immune to quadratic regex backtracking).
 */
function extractXmlTagLinear(block: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = block.indexOf(open);
  if (start === -1) return undefined;
  const contentStart = start + open.length;
  const end = block.indexOf(close, contentStart);
  if (end === -1) return undefined;
  return decodeXmlEntities(block.slice(contentStart, end));
}

export function parseListObjectsV2Xml(xml: string): {
  items: Array<{ key: string; size?: number; etag?: string; updatedAt?: string }>;
  nextToken?: string;
} {
  const items: Array<{ key: string; size?: number; etag?: string; updatedAt?: string }> = [];
  const openTag = '<Contents>';
  const closeTag = '</Contents>';

  let pos = 0;
  while (pos < xml.length) {
    const start = xml.indexOf(openTag, pos);
    if (start === -1) break;
    const contentStart = start + openTag.length;
    const end = xml.indexOf(closeTag, contentStart);
    if (end === -1) break;

    const block = xml.slice(contentStart, end);
    pos = end + closeTag.length;

    const key = extractXmlTagLinear(block, 'Key');
    if (!key) continue;
    const sizeStr = extractXmlTagLinear(block, 'Size');
    const etag = extractXmlTagLinear(block, 'ETag')?.replace(/^"|"$/g, '');
    const updatedAt = extractXmlTagLinear(block, 'LastModified');
    items.push({
      key,
      size: sizeStr ? Number(sizeStr) : undefined,
      etag,
      updatedAt,
    });
  }

  const isTruncated = extractXmlTagLinear(xml, 'IsTruncated') === 'true';
  const nextToken = isTruncated
    ? extractXmlTagLinear(xml, 'NextContinuationToken')
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
    return (this.config.prefix ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }

  private buildFullKey(path: string, allowEmpty = false): string {
    const clean = allowEmpty
      ? path.replace(/\\/g, '/').replace(/^\/+/, '')
      : assertSafeStoragePath(path);
    if (!clean) return this.basePrefix;
    return this.basePrefix ? `${this.basePrefix}/${clean}` : clean;
  }

  private stripBasePrefix(key: string): string {
    if (!this.basePrefix) return key;
    const p = `${this.basePrefix}/`;
    return key.startsWith(p) ? key.slice(p.length) : key;
  }

  private buildObjectUrl(key?: string, query?: Record<string, string>): URL {
    const endpoint = this.config.endpoint.replace(/\/+$/, '');
    assertValidS3Endpoint(endpoint);
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
    if (!this.config.accessKeyId.trim() || !this.config.secretAccessKey.trim()) {
      throw new AuthExpiredError(
        `S3/R2 (${this.label}) credentials missing — edit provider in Settings to re-enter your Secret Access Key.`
      );
    }

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
      body: method === 'PUT' ? asBufferSource(payload) : undefined,
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
    const fullPrefix = this.buildFullKey(prefix, true);
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
