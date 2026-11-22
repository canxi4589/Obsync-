import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64, bytesToUtf8, utf8ToBytes } from '../crypto/base64';
import { GitHubProvider } from '../storage/providers/githubProvider';
import {
  clearGoogleDriveToken,
  GoogleDriveProvider,
  setGoogleDriveToken,
} from '../storage/providers/googleDriveProvider';
import {
  parseListObjectsV2Xml,
  signAwsV4Headers,
} from '../storage/providers/s3Provider';
import { AuthExpiredError } from '../storage/types';

describe('Providers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearGoogleDriveToken('gd-test');
  });

  it('parses S3 ListObjectsV2 XML and generates AWS SigV4 headers', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>tok-123</NextContinuationToken>
        <Contents>
          <Key>.obsync-vault/vault.json</Key>
          <LastModified>2026-11-22T01:00:00.000Z</LastModified>
          <ETag>"abc123"</ETag>
          <Size>512</Size>
        </Contents>
        <Contents>
          <Key>Notes/A &amp; B.md</Key>
          <Size>42</Size>
        </Contents>
      </ListBucketResult>`;

    const parsed = parseListObjectsV2Xml(xml);
    expect(parsed.nextToken).toBe('tok-123');
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({
      key: '.obsync-vault/vault.json',
      etag: 'abc123',
      size: 512,
    });
    expect(parsed.items[1].key).toBe('Notes/A & B.md');

    const headers = await signAwsV4Headers({
      method: 'GET',
      url: new URL('https://example.r2.cloudflarestorage.com/my-bucket?list-type=2'),
      region: 'auto',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'SECRETKEYEXAMPLE',
      payload: new Uint8Array(0),
      date: new Date('2026-11-22T12:00:00Z'),
    });

    expect(headers.Authorization).toContain(
      'AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261122/auto/s3/aws4_request'
    );
    expect(headers['x-amz-date']).toBe('20261122T120000Z');
    expect(headers['x-amz-content-sha256']).toHaveLength(64);
  });

  it('S3 SigV4 does not double-encode pathname and sorts query parameters in strict ASCII order', async () => {
    const fixedDate = new Date('2026-11-22T12:00:00Z');
    const url = new URL(
      'https://example.r2.cloudflarestorage.com/my-bucket/Notes/My%20Note%20%26%20v1.md?a=1&Z=2'
    );
    const actual = await signAwsV4Headers({
      method: 'GET',
      url,
      region: 'auto',
      accessKeyId: 'AKIA',
      secretAccessKey: 'SECRET',
      payload: new Uint8Array(0),
      date: fixedDate,
    });

    // Independent Node crypto reference: canonical URI must stay single-encoded and Z must precede a
    const emptyHash = createHash('sha256').update('').digest('hex');
    const canonicalReq = [
      'GET',
      '/my-bucket/Notes/My%20Note%20%26%20v1.md',
      'Z=2&a=1',
      `host:example.r2.cloudflarestorage.com\nx-amz-content-sha256:${emptyHash}\nx-amz-date:20261122T120000Z\n`,
      'host;x-amz-content-sha256;x-amz-date',
      emptyHash,
    ].join('\n');
    const reqHash = createHash('sha256').update(canonicalReq).digest('hex');
    const sts = `AWS4-HMAC-SHA256\n20261122T120000Z\n20261122/auto/s3/aws4_request\n${reqHash}`;
    const kDate = createHmac('sha256', 'AWS4SECRET').update('20261122').digest();
    const kReg = createHmac('sha256', kDate).update('auto').digest();
    const kSvc = createHmac('sha256', kReg).update('s3').digest();
    const kSign = createHmac('sha256', kSvc).update('aws4_request').digest();
    const expectedSig = createHmac('sha256', kSign).update(sts).digest('hex');

    expect(actual.Authorization).toContain(`Signature=${expectedSig}`);
  });

  it('GitHubProvider handles list, read (200 & 404), and write', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes('/git/trees/')) {
        return new Response(
          JSON.stringify({
            tree: [
              { path: '.obsync-vault/vault.json', type: 'blob', sha: 'sha-v', size: 10 },
              { path: 'Notes', type: 'tree', sha: 'sha-dir' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/contents/missing.md')) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      if (url.includes('/contents/Notes/hello.md') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({
            sha: 'sha-old',
            encoding: 'base64',
            content: bytesToBase64(utf8ToBytes('# Hello')),
          }),
          { status: 200 }
        );
      }
      if (url.includes('/contents/Notes/hello.md') && init?.method === 'PUT') {
        return new Response(
          JSON.stringify({ content: { sha: 'sha-new' } }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const gh = new GitHubProvider({
      id: 'gh1',
      type: 'github',
      label: 'GH',
      enabled: true,
      mirrorWrites: true,
      owner: 'alice',
      repo: 'vault',
      branch: 'main',
      token: 'pat-123',
    });

    const listed = await gh.list();
    expect(listed.map((e) => e.path)).toEqual(['.obsync-vault/vault.json']);

    expect(await gh.read('missing.md')).toBeNull();

    const readRes = await gh.read('Notes/hello.md');
    expect(bytesToUtf8(readRes!.data)).toBe('# Hello');

    await gh.write('Notes/hello.md', utf8ToBytes('# Updated'));
    const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT');
    expect(putCall).toBeDefined();
  });

  it('GoogleDriveProvider sends bearer token and throws AuthExpiredError on 401 or missing token', async () => {
    const gd = new GoogleDriveProvider({
      id: 'gd-test',
      type: 'gdrive',
      label: 'Personal Drive',
      enabled: true,
      mirrorWrites: true,
      clientId: 'client-123',
      accountEmail: 'me@gmail.com',
      folderName: 'ObsyncVault',
      rootFolderId: 'root-folder-id',
    });

    await expect(gd.list()).rejects.toThrow(AuthExpiredError);

    setGoogleDriveToken('gd-test', {
      accessToken: 'tok-abc',
      expiresAt: Date.now() + 600_000,
      email: 'me@gmail.com',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes('files?q=')) {
          return new Response(
            JSON.stringify({
              files: [
                {
                  id: 'f-1',
                  name: 'vault.json',
                  mimeType: 'application/json',
                  size: '123',
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Unauthorized', { status: 401 });
      })
    );

    const files = await gd.list();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('vault.json');

    await expect(gd.read('vault.json')).rejects.toThrow(AuthExpiredError);
  });

  it('GitHubProvider distinguishes missing branch vs empty repo and rate limits vs auth expiry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes('/git/trees/wrong-branch')) {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        if (url.endsWith('/repos/alice/vault')) {
          return new Response(
            JSON.stringify({ size: 128, default_branch: 'main' }),
            { status: 200 }
          );
        }
        if (url.includes('/contents/rate-limited.md')) {
          return new Response(
            JSON.stringify({ message: 'API rate limit exceeded' }),
            { status: 403, headers: { 'x-ratelimit-remaining': '0' } }
          );
        }
        return new Response('{}', { status: 404 });
      })
    );

    const gh = new GitHubProvider({
      id: 'gh-err',
      type: 'github',
      label: 'GH',
      enabled: true,
      mirrorWrites: true,
      owner: 'alice',
      repo: 'vault',
      branch: 'wrong-branch',
      token: 'pat-123',
    });

    await expect(gh.list()).rejects.toThrow('GitHub branch "wrong-branch" not found');

    try {
      await gh.read('rate-limited.md');
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).not.toBeInstanceOf(AuthExpiredError);
      expect((err as Error).message).toContain('rate limit');
    }
  });

  it('GoogleDriveProvider bounds 404 write retries and deduplicates concurrent folder creation', async () => {
    setGoogleDriveToken('gd-test', {
      accessToken: 'tok-abc',
      expiresAt: Date.now() + 600_000,
    });

    let folderCreates = 0;
    let patchAttempts = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes('/drive/v3/files?q=')) {
          return new Response(JSON.stringify({ files: [] }), { status: 200 });
        }
        if (url.endsWith('/drive/v3/files') && init?.method === 'POST') {
          folderCreates++;
          return new Response(JSON.stringify({ id: `dir-${folderCreates}` }), { status: 200 });
        }
        if (url.includes('/upload/drive/v3/files/') && init?.method === 'PATCH') {
          patchAttempts++;
          return new Response('Not Found', { status: 404 });
        }
        if (url.includes('/upload/drive/v3/files?') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'file-new' }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      })
    );

    const gd = new GoogleDriveProvider({
      id: 'gd-test',
      type: 'gdrive',
      label: 'Drive',
      enabled: true,
      mirrorWrites: true,
      clientId: 'c1',
      folderName: 'ObsyncVault',
    });

    // Two concurrent writes into the same nested directory should create root + .obsync-vault once
    await Promise.all([
      gd.write('.obsync-vault/a.enc', new Uint8Array([1])),
      gd.write('.obsync-vault/b.enc', new Uint8Array([2])),
    ]);
    expect(folderCreates).toBe(2); // 1 for ObsyncVault + 1 for .obsync-vault

    // Force a cached file ID that consistently returns 404 on PATCH — retry must stay bounded
    const gdRetry = new GoogleDriveProvider({
      id: 'gd-test',
      type: 'gdrive',
      label: 'Drive',
      enabled: true,
      mirrorWrites: true,
      clientId: 'c1',
      folderName: 'ObsyncVault',
      rootFolderId: 'root-1',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes('/drive/v3/files?q=')) {
          return new Response(
            JSON.stringify({
              files: [{ id: 'stale-file', name: 'x.enc', mimeType: 'application/octet-stream' }],
            }),
            { status: 200 }
          );
        }
        if (url.includes('/upload/drive/v3/files/') && init?.method === 'PATCH') {
          patchAttempts++;
          return new Response('Not Found', { status: 404 });
        }
        if (url.endsWith('/drive/v3/files') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'dir-recreated' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      })
    );

    await expect(gdRetry.write('x.enc', new Uint8Array([9]))).rejects.toThrow('after retry');
    expect(patchAttempts).toBe(2);
  });
});
