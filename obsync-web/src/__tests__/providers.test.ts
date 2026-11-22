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
});
