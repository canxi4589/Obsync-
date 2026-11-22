import {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  concatBytes,
  toBuffer,
  utf8ToBytes,
} from './base64';

export const VAULT_VERSION = 1 as const;
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const BLOB_VERSION = 0x01;

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface WrappedKeyBlock {
  salt: string;
  nonce: string;
  wrappedDek: string;
}

export interface VaultMeta {
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  passwordWrap: WrappedKeyBlock;
  recoveryWrap: WrappedKeyBlock;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateNoteEntry {
  id: string;
  title: string;
  folder: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

export interface VaultIndex {
  version: 1;
  updatedAt: string;
  notes: PrivateNoteEntry[];
}

export class WrongSecretError extends Error {
  constructor(message = 'Incorrect password or recovery key.') {
    super(message);
    this.name = 'WrongSecretError';
  }
}

export function generateRecoveryKey(): string {
  // 20 bytes = 160 bits = exactly 32 Base32 characters (8 groups of 4)
  const random = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0;
  let value = 0;
  let chars = '';

  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      chars += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  random.fill(0);

  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += 4) {
    groups.push(chars.slice(i, i + 4));
  }
  return `OBSYNC-${groups.join('-')}`;
}

export function normalizeRecoveryKey(input: string): string {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact.startsWith('OBSYNC') ? compact.slice(6) : compact;
}

async function deriveKek(
  secret: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
): Promise<CryptoKey> {
  const secretBytes = utf8ToBytes(secret);
  try {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      secretBytes,
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  } finally {
    secretBytes.fill(0);
  }
}

async function wrapDek(
  dek: CryptoKey,
  secret: string,
  iterations: number
): Promise<WrappedKeyBlock> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const kek = await deriveKek(secret, salt, iterations);
  const rawDek = new Uint8Array(await crypto.subtle.exportKey('raw', dek));

  try {
    const wrapped = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, kek, rawDek)
    );
    return {
      salt: bytesToBase64(salt),
      nonce: bytesToBase64(nonce),
      wrappedDek: bytesToBase64(wrapped),
    };
  } finally {
    rawDek.fill(0);
  }
}

async function unwrapDek(
  block: WrappedKeyBlock,
  secret: string,
  iterations: number
): Promise<CryptoKey> {
  const salt = base64ToBytes(block.salt);
  const nonce = base64ToBytes(block.nonce);
  const wrapped = base64ToBytes(block.wrappedDek);
  const kek = await deriveKek(secret, salt, iterations);

  let rawDek: Uint8Array<ArrayBuffer>;
  try {
    rawDek = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, kek, wrapped)
    );
  } catch {
    throw new WrongSecretError();
  }

  try {
    return await crypto.subtle.importKey(
      'raw',
      rawDek,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  } finally {
    rawDek.fill(0);
  }
}

export async function createVault(
  password: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS
): Promise<{ meta: VaultMeta; dek: CryptoKey; recoveryKey: string }> {
  if (!password) {
    throw new Error('Master password cannot be empty.');
  }

  const dek = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const recoveryKey = generateRecoveryKey();
  const normalizedRecovery = normalizeRecoveryKey(recoveryKey);

  const [passwordWrap, recoveryWrap] = await Promise.all([
    wrapDek(dek, password, iterations),
    wrapDek(dek, normalizedRecovery, iterations),
  ]);

  const now = new Date().toISOString();
  const meta: VaultMeta = {
    version: VAULT_VERSION,
    kdf: 'PBKDF2-SHA256',
    iterations,
    passwordWrap,
    recoveryWrap,
    createdAt: now,
    updatedAt: now,
  };

  return { meta, dek, recoveryKey };
}

export async function unlockWithPassword(
  password: string,
  meta: VaultMeta
): Promise<CryptoKey> {
  if (!password) throw new WrongSecretError();
  return unwrapDek(meta.passwordWrap, password, meta.iterations);
}

export async function unlockWithRecoveryKey(
  recoveryKey: string,
  meta: VaultMeta
): Promise<CryptoKey> {
  const normalized = normalizeRecoveryKey(recoveryKey);
  if (normalized.length < 16) {
    throw new WrongSecretError('Invalid recovery key format.');
  }
  return unwrapDek(meta.recoveryWrap, normalized, meta.iterations);
}

export async function rewrapPassword(
  dek: CryptoKey,
  newPassword: string,
  meta: VaultMeta
): Promise<VaultMeta> {
  if (!newPassword) {
    throw new Error('New master password cannot be empty.');
  }
  const passwordWrap = await wrapDek(dek, newPassword, meta.iterations);
  return {
    ...meta,
    passwordWrap,
    updatedAt: new Date().toISOString(),
  };
}

export async function regenerateRecoveryKey(
  dek: CryptoKey,
  meta: VaultMeta
): Promise<{ meta: VaultMeta; recoveryKey: string }> {
  const recoveryKey = generateRecoveryKey();
  const recoveryWrap = await wrapDek(
    dek,
    normalizeRecoveryKey(recoveryKey),
    meta.iterations
  );
  return {
    meta: {
      ...meta,
      recoveryWrap,
      updatedAt: new Date().toISOString(),
    },
    recoveryKey,
  };
}

export async function encryptBytes(
  dek: CryptoKey,
  plaintext: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const payload = toBuffer(plaintext);
  const cipherAndTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, dek, payload)
  );
  return concatBytes(new Uint8Array([BLOB_VERSION]), nonce, cipherAndTag);
}

export async function decryptBytes(
  dek: CryptoKey,
  blob: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  if (blob.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new Error('Encrypted blob is too short or corrupted.');
  }
  if (blob[0] !== BLOB_VERSION) {
    throw new Error(`Unsupported encrypted blob version: ${blob[0]}`);
  }
  const nonce = toBuffer(blob.subarray(1, 1 + NONCE_BYTES));
  const cipherAndTag = toBuffer(blob.subarray(1 + NONCE_BYTES));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    dek,
    cipherAndTag
  );
  return new Uint8Array(plain);
}

export async function encryptJson<T>(
  dek: CryptoKey,
  value: T
): Promise<Uint8Array<ArrayBuffer>> {
  return encryptBytes(dek, utf8ToBytes(JSON.stringify(value)));
}

export async function decryptJson<T>(
  dek: CryptoKey,
  blob: Uint8Array
): Promise<T> {
  const plain = await decryptBytes(dek, blob);
  return JSON.parse(bytesToUtf8(plain)) as T;
}
