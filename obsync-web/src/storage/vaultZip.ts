import {
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  Zip,
  ZipDeflate,
  ZipPassThrough,
} from 'fflate';
import { concatBytes } from '../crypto/base64';
import { validateZipImportPath } from './pathUtils';
import type { StorageManager } from './storageManager';

export const MAX_ZIP_FILES = 10_000;
export const MAX_ZIP_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
export const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB total uncompressed

const EXPORT_READ_CONCURRENCY = 4;

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function exportVaultZip(
  manager: StorageManager,
  includePublicNotes: boolean
): Promise<Uint8Array<ArrayBuffer>> {
  const { entries } = await manager.list('');
  const paths = entries
    .map((e) => e.path)
    .filter((p) => {
      if (p.startsWith('.git/') || p.startsWith('.obsidian/')) return false;
      const isVaultFile = p.startsWith('.obsync-vault/');
      const isPublicNote =
        includePublicNotes && !isVaultFile && !p.startsWith('private/');
      return isVaultFile || isPublicNote;
    });

  // Read files with bounded concurrency
  const collected: Array<{ path: string; data: Uint8Array }> = [];
  let cursor = 0;

  async function readWorker(): Promise<void> {
    while (cursor < paths.length) {
      const idx = cursor++;
      const p = paths[idx];
      const readRes = await manager.read(p);
      if (readRes.data) {
        collected.push({ path: p, data: readRes.data });
      }
    }
  }

  const workerCount = Math.min(EXPORT_READ_CONCURRENCY, Math.max(1, paths.length));
  await Promise.all(Array.from({ length: workerCount }, () => readWorker()));

  // Stream into Zip without spawning blob: workers (CSP-safe) and STORE
  // incompressible AES-GCM `.enc` files at level 0 while deflating text files.
  const outChunks: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zipper = new Zip((err, chunk) => {
    if (err) {
      zipError = err;
      return;
    }
    outChunks.push(chunk);
  });

  for (let i = 0; i < collected.length; i++) {
    const { path, data } = collected[i];
    const isEncryptedBlob = path.toLowerCase().endsWith('.enc');
    const entry = isEncryptedBlob
      ? new ZipPassThrough(path)
      : new ZipDeflate(path, { level: 6 });
    zipper.add(entry);
    entry.push(data, true);
    if (zipError) throw zipError;
    if (i > 0 && i % 25 === 0) {
      await yieldToEventLoop();
    }
  }

  zipper.end();
  if (zipError) throw zipError;

  return concatBytes(...outChunks);
}

interface ExtractedZipEntry {
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * Safely extracts only allowlisted vault / Markdown paths while enforcing strict
 * entry count and actual streaming decompressed byte caps (Zip Bomb defense).
 */
export async function extractSafeZipEntries(
  zipBytes: Uint8Array,
  limits?: {
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
  }
): Promise<{ entries: ExtractedZipEntry[]; skipped: number }> {
  const maxFiles = limits?.maxFiles ?? MAX_ZIP_FILES;
  const maxFileBytes = limits?.maxFileBytes ?? MAX_ZIP_FILE_BYTES;
  const maxTotalBytes = limits?.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;

  const entries: ExtractedZipEntry[] = [];
  let skipped = 0;
  let seenFiles = 0;
  let totalBytes = 0;
  let abortError: Error | null = null;

  const unzipper = new Unzip((file) => {
    if (abortError) return;
    seenFiles++;
    if (seenFiles > maxFiles) {
      abortError = new Error(
        `ZIP archive exceeds maximum allowed file count (${maxFiles}).`
      );
      return;
    }

    const validated = validateZipImportPath(file.name);
    if (!validated.ok) {
      skipped++;
      return;
    }

    if (file.originalSize !== undefined) {
      if (file.originalSize > maxFileBytes) {
        abortError = new Error(
          `ZIP entry "${file.name}" exceeds maximum allowed file size (${Math.round(maxFileBytes / (1024 * 1024))} MB).`
        );
        return;
      }
      if (totalBytes + file.originalSize > maxTotalBytes) {
        abortError = new Error(
          `ZIP archive exceeds maximum total uncompressed size (${Math.round(maxTotalBytes / (1024 * 1024))} MB).`
        );
        return;
      }
    }

    const chunks: Uint8Array[] = [];
    let fileBytes = 0;
    file.ondata = (err, chunk, final) => {
      if (abortError) return;
      if (err) {
        abortError = err;
        return;
      }
      fileBytes += chunk.byteLength;
      totalBytes += chunk.byteLength;
      if (fileBytes > maxFileBytes) {
        abortError = new Error(
          `ZIP entry "${file.name}" exceeded maximum uncompressed file size.`
        );
        return;
      }
      if (totalBytes > maxTotalBytes) {
        abortError = new Error(
          `ZIP archive exceeded maximum total uncompressed size.`
        );
        return;
      }
      chunks.push(chunk);
      if (final) {
        entries.push({
          path: validated.path,
          bytes: concatBytes(...chunks),
        });
      }
    };

    try {
      file.start();
    } catch (err) {
      abortError = err instanceof Error ? err : new Error(String(err));
    }
  });

  unzipper.register(UnzipPassThrough);
  unzipper.register(UnzipInflate);

  // Feed in chunks so large archives don't stall without checking abortError
  const CHUNK = 256 * 1024;
  for (let offset = 0; offset < zipBytes.byteLength; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, zipBytes.byteLength);
    const isFinal = end >= zipBytes.byteLength;
    unzipper.push(zipBytes.subarray(offset, end), isFinal);
    if (abortError) throw abortError;
    if (!isFinal) await yieldToEventLoop();
  }
  if (zipBytes.byteLength === 0) {
    unzipper.push(zipBytes, true);
  }
  if (abortError) throw abortError;

  return { entries, skipped };
}

export async function importVaultZip(
  manager: StorageManager,
  zipBytes: Uint8Array
): Promise<{ imported: number; skipped: number }> {
  const { entries, skipped } = await extractSafeZipEntries(zipBytes);
  let imported = 0;

  for (const { path, bytes } of entries) {
    await manager.write(path, bytes, `Import ${path}`);
    imported++;
  }

  return { imported, skipped };
}
