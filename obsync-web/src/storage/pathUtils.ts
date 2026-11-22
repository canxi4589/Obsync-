const INVALID_WIN_CHARS = /[:*?"<>|\x00-\x1f]/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const RESERVED_PREFIXES = ['.obsync-vault/', '.git/', '.obsidian/', 'private/'];
const SAFE_VAULT_NOTE_PATH = /^\.obsync-vault\/notes\/[a-zA-Z0-9_-]{1,128}\.enc$/;

export function normalizeStoragePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function hasTraversalSegment(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').some((seg) => seg === '.' || seg === '..');
}

export function hasForbiddenSegment(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized
    .split('/')
    .filter(Boolean)
    .some((seg) => {
      const lower = seg.toLowerCase();
      return seg === '.' || seg === '..' || lower === '.git';
    });
}

/**
 * Defense-in-depth validation for all storage provider read/write/delete paths.
 * Blocks path traversal, NUL/control characters, and any access into `.git`.
 */
export function assertSafeStoragePath(rawPath: string): string {
  const clean = normalizeStoragePath(rawPath);
  if (!clean || clean.endsWith('/')) {
    throw new Error('Invalid empty file path.');
  }
  if (/[\x00-\x1f]/.test(clean)) {
    throw new Error('Path contains invalid control characters.');
  }
  if (hasForbiddenSegment(clean)) {
    throw new Error('Path contains forbidden traversal or .git segment.');
  }
  return clean;
}

export function validatePublicNotePath(
  raw: string
): { ok: true; path: string } | { ok: false; error: string } {
  const cleaned = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!cleaned) {
    return { ok: false, error: 'Note path cannot be empty.' };
  }

  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length === 0) {
    return { ok: false, error: 'Note path cannot be empty.' };
  }

  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      return { ok: false, error: 'Path cannot contain "." or ".." segments.' };
    }
    if (seg.toLowerCase() === '.git' || seg.toLowerCase() === '.obsidian') {
      return {
        ok: false,
        error: 'Path cannot contain reserved ".git" or ".obsidian" folders.',
      };
    }
    if (INVALID_WIN_CHARS.test(seg)) {
      return {
        ok: false,
        error: 'Path contains invalid filename characters (: * ? " < > |).',
      };
    }
    if (seg.endsWith('.') || seg.endsWith(' ')) {
      return {
        ok: false,
        error: 'Folder or file names cannot end with a dot or space.',
      };
    }
    if (WINDOWS_RESERVED_NAME.test(seg)) {
      return {
        ok: false,
        error: `Filename "${seg}" is a reserved Windows device name.`,
      };
    }
  }

  let finalPath = segments.join('/');
  if (!finalPath.toLowerCase().endsWith('.md')) {
    finalPath += '.md';
  }

  const lower = finalPath.toLowerCase();
  if (
    RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    lower === '.obsync-vault' ||
    lower === '.git' ||
    lower === '.obsidian'
  ) {
    return {
      ok: false,
      error:
        'Cannot create public notes inside reserved folders (.obsync-vault, .git, .obsidian, private).',
    };
  }

  return { ok: true, path: finalPath };
}

/**
 * Strict allowlist for files extracted during ZIP backup import.
 * Permits only Obsync encrypted vault files and safe public Markdown notes,
 * blocking `.git/`, `.obsidian/` plugins, traversal paths, and executable files.
 */
export function validateZipImportPath(
  rawPath: string
): { ok: true; path: string } | { ok: false; reason: string } {
  const clean = normalizeStoragePath(rawPath).replace(/\/+$/, '');
  if (!clean || rawPath.endsWith('/') || rawPath.endsWith('\\')) {
    return { ok: false, reason: 'Directory or empty entry.' };
  }
  if (hasTraversalSegment(clean) || hasForbiddenSegment(clean)) {
    return { ok: false, reason: 'Forbidden traversal or .git segment.' };
  }

  if (
    clean === '.obsync-vault/vault.json' ||
    clean === '.obsync-vault/index.enc' ||
    SAFE_VAULT_NOTE_PATH.test(clean)
  ) {
    return { ok: true, path: clean };
  }

  // Only allow safe public Markdown files outside reserved/executable directories
  if (!clean.toLowerCase().endsWith('.md')) {
    return { ok: false, reason: 'Non-vault, non-Markdown entry blocked.' };
  }

  const checked = validatePublicNotePath(clean);
  if (!checked.ok) {
    return { ok: false, reason: checked.error };
  }
  return { ok: true, path: checked.path };
}
