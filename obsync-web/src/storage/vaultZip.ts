import { unzipSync, zipSync } from 'fflate';
import type { StorageManager } from './storageManager';

export async function exportVaultZip(
  manager: StorageManager,
  includePublicNotes: boolean
): Promise<Uint8Array<ArrayBuffer>> {
  const { entries } = await manager.list('');
  const files: Record<string, Uint8Array> = {};

  for (const entry of entries) {
    const p = entry.path;
    if (p.startsWith('.git/')) continue;
    const isVaultFile = p.startsWith('.obsync-vault/');
    const isPublicNote = includePublicNotes && !isVaultFile && !p.startsWith('private/');
    if (!isVaultFile && !isPublicNote) continue;

    const readRes = await manager.read(p);
    if (readRes.data) {
      files[p] = readRes.data;
    }
  }

  const zipped = zipSync(files, { level: 6 });
  const copy = new Uint8Array(zipped.byteLength);
  copy.set(zipped);
  return copy;
}

export async function importVaultZip(
  manager: StorageManager,
  zipBytes: Uint8Array
): Promise<{ imported: number }> {
  const extracted = unzipSync(zipBytes);
  let imported = 0;

  for (const [rawPath, bytes] of Object.entries(extracted)) {
    const cleanPath = rawPath.replace(/^\/+/, '').replace(/\\/g, '/');
    if (!cleanPath || cleanPath.endsWith('/') || cleanPath.includes('..')) continue;
    await manager.write(cleanPath, bytes, `Import ${cleanPath}`);
    imported++;
  }

  return { imported };
}
