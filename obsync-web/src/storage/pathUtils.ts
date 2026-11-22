const INVALID_WIN_CHARS = /[:*?"<>|\x00-\x1f]/;
const RESERVED_PREFIXES = ['.obsync-vault/', '.git/', 'private/'];

export function hasTraversalSegment(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').some((seg) => seg === '.' || seg === '..');
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
  }

  let finalPath = segments.join('/');
  if (!finalPath.toLowerCase().endsWith('.md')) {
    finalPath += '.md';
  }

  const lower = finalPath.toLowerCase();
  if (
    RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    lower === '.obsync-vault' ||
    lower === '.git'
  ) {
    return {
      ok: false,
      error: 'Cannot create public notes inside reserved folders (.obsync-vault, .git, private).',
    };
  }

  return { ok: true, path: finalPath };
}
