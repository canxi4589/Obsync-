import {
  asBufferSource,
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  concatBytes,
  utf8ToBytes,
} from './base64';

export const VAULT_VERSION = 2 as const;
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MIN_PBKDF2_ITERATIONS = 100_000;
export const MAX_PBKDF2_ITERATIONS = 2_000_000;
export const MIN_MASTER_PASSWORD_LENGTH = 12;
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const DEK_BYTES = 32;
export const BLOB_VERSION_V1 = 0x01;
export const BLOB_VERSION = 0x02;

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HKDF_RECOVERY_INFO = utf8ToBytes('obsync:v2:recovery-kek');

export type RecoveryKdf = 'PBKDF2-SHA256' | 'HKDF-SHA256';

export interface WrappedKeyBlock {
  salt: string;
  nonce: string;
  wrappedDek: string;
}

export interface VaultMeta {
  version: 1 | 2;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  recoveryKdf?: RecoveryKdf;
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

function assertValidPassword(password: string): void {
  if (!password || password.length < MIN_MASTER_PASSWORD_LENGTH) {
    throw new Error(
      `Master password must be at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`
    );
  }
}

function assertSafeIterations(
  iterations: number,
  minIterations = 1
): void {
  if (
    typeof iterations !== 'number' ||
    !Number.isInteger(iterations) ||
    iterations < minIterations ||
    iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error(
      `Invalid KDF iterations (${String(iterations)}). Expected an integer between ${minIterations} and ${MAX_PBKDF2_ITERATIONS}.`
    );
  }
}

function validateWrappedKeyBlock(raw: unknown, label: string): WrappedKeyBlock {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid vault metadata: missing ${label}.`);
  }
  const b = raw as Record<string, unknown>;
  if (
    typeof b.salt !== 'string' ||
    typeof b.nonce !== 'string' ||
    typeof b.wrappedDek !== 'string'
  ) {
    throw new Error(`Invalid vault metadata: malformed ${label} fields.`);
  }

  let salt: Uint8Array;
  let nonce: Uint8Array;
  let wrapped: Uint8Array;
  try {
    salt = base64ToBytes(b.salt);
    nonce = base64ToBytes(b.nonce);
    wrapped = base64ToBytes(b.wrappedDek);
  } catch {
    throw new Error(`Invalid vault metadata: invalid base64 in ${label}.`);
  }

  if (salt.byteLength !== SALT_BYTES) {
    throw new Error(`Invalid vault metadata: unexpected salt length in ${label}.`);
  }
  if (nonce.byteLength !== NONCE_BYTES) {
    throw new Error(`Invalid vault metadata: unexpected nonce length in ${label}.`);
  }
  if (wrapped.byteLength !== DEK_BYTES + TAG_BYTES) {
    throw new Error(`Invalid vault metadata: unexpected wrapped key length in ${label}.`);
  }

  return { salt: b.salt, nonce: b.nonce, wrappedDek: b.wrappedDek };
}

export function validateVaultMeta(
  raw: unknown,
  opts?: { minIterations?: number }
): VaultMeta {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid vault.json: expected a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1 && obj.version !== 2) {
    throw new Error(`Unsupported vault version: ${String(obj.version)}.`);
  }
  if (obj.kdf !== 'PBKDF2-SHA256') {
    throw new Error(`Unsupported vault KDF: ${String(obj.kdf)}.`);
  }
  assertSafeIterations(
    obj.iterations as number,
    opts?.minIterations ?? MIN_PBKDF2_ITERATIONS
  );

  if (
    obj.recoveryKdf !== undefined &&
    obj.recoveryKdf !== 'PBKDF2-SHA256' &&
    obj.recoveryKdf !== 'HKDF-SHA256'
  ) {
    throw new Error(`Unsupported recovery KDF: ${String(obj.recoveryKdf)}.`);
  }

  const passwordWrap = validateWrappedKeyBlock(obj.passwordWrap, 'passwordWrap');
  const recoveryWrap = validateWrappedKeyBlock(obj.recoveryWrap, 'recoveryWrap');

  if (typeof obj.createdAt !== 'string' || typeof obj.updatedAt !== 'string') {
    throw new Error('Invalid vault.json: missing timestamps.');
  }

  return {
    version: obj.version,
    kdf: 'PBKDF2-SHA256',
    iterations: obj.iterations as number,
    recoveryKdf: obj.recoveryKdf as RecoveryKdf | undefined,
    passwordWrap,
    recoveryWrap,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
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

function buildPasswordWrapAad(iterations: number): Uint8Array<ArrayBuffer> {
  return utf8ToBytes(`obsync:v2:wrap:password:${iterations}`);
}

function buildRecoveryWrapAad(recoveryKdf: RecoveryKdf): Uint8Array<ArrayBuffer> {
  return utf8ToBytes(`obsync:v2:wrap:recovery:${recoveryKdf}`);
}

function buildBlobV2Aad(aad?: string): Uint8Array<ArrayBuffer> {
  return utf8ToBytes(aad ? `obsync:v2:${aad}` : 'obsync:v2');
}

async function deriveKekPbkdf2(
  secret: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
): Promise<CryptoKey> {
  assertSafeIterations(iterations, 1);
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

async function deriveKekHkdf(
  secret: string,
  salt: Uint8Array<ArrayBuffer>
): Promise<CryptoKey> {
  const secretBytes = utf8ToBytes(secret);
  try {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      secretBytes,
      'HKDF',
      false,
      ['deriveKey']
    );
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        salt,
        info: HKDF_RECOVERY_INFO,
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

async function wrapRawDek(
  rawDek: Uint8Array<ArrayBuffer>,
  secret: string,
  opts: {
    kdf: RecoveryKdf;
    iterations: number;
    aad?: Uint8Array<ArrayBuffer>;
  }
): Promise<WrappedKeyBlock> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const kek =
    opts.kdf === 'HKDF-SHA256'
      ? await deriveKekHkdf(secret, salt)
      : await deriveKekPbkdf2(secret, salt, opts.iterations);

  const algo: AesGcmParams = opts.aad
    ? { name: 'AES-GCM', iv: nonce, additionalData: opts.aad }
    : { name: 'AES-GCM', iv: nonce };

  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(algo, kek, rawDek)
  );
  return {
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    wrappedDek: bytesToBase64(wrapped),
  };
}

async function unwrapRawDek(
  block: WrappedKeyBlock,
  secret: string,
  opts: {
    kdf: RecoveryKdf;
    iterations: number;
    aad?: Uint8Array<ArrayBuffer>;
  }
): Promise<Uint8Array<ArrayBuffer>> {
  const salt = base64ToBytes(block.salt);
  const nonce = base64ToBytes(block.nonce);
  const wrapped = base64ToBytes(block.wrappedDek);
  const kek =
    opts.kdf === 'HKDF-SHA256'
      ? await deriveKekHkdf(secret, salt)
      : await deriveKekPbkdf2(secret, salt, opts.iterations);

  const algo: AesGcmParams = opts.aad
    ? { name: 'AES-GCM', iv: nonce, additionalData: opts.aad }
    : { name: 'AES-GCM', iv: nonce };

  try {
    return new Uint8Array(await crypto.subtle.decrypt(algo, kek, wrapped));
  } catch {
    throw new WrongSecretError();
  }
}

async function importSessionDek(
  rawDek: Uint8Array<ArrayBuffer>,
  extractable = false
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    rawDek,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt']
  );
}

async function exportRawDek(dek: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  if (!dek.extractable) {
    throw new Error(
      'Session key is non-extractable. Re-authenticate with your current master password to change credentials.'
    );
  }
  return new Uint8Array(await crypto.subtle.exportKey('raw', dek));
}

function getPasswordUnwrapOpts(meta: VaultMeta) {
  return {
    kdf: 'PBKDF2-SHA256' as const,
    iterations: meta.iterations,
    aad: meta.version >= 2 ? buildPasswordWrapAad(meta.iterations) : undefined,
  };
}

function getRecoveryUnwrapOpts(meta: VaultMeta) {
  const recoveryKdf: RecoveryKdf =
    meta.recoveryKdf ?? 'PBKDF2-SHA256';
  return {
    kdf: recoveryKdf,
    iterations: meta.iterations,
    aad: meta.version >= 2 ? buildRecoveryWrapAad(recoveryKdf) : undefined,
  };
}

export async function createVault(
  password: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS
): Promise<{ meta: VaultMeta; dek: CryptoKey; recoveryKey: string }> {
  assertValidPassword(password);
  assertSafeIterations(iterations, 1);

  const rawDek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
  const recoveryKey = generateRecoveryKey();
  const normalizedRecovery = normalizeRecoveryKey(recoveryKey);

  try {
    const [passwordWrap, recoveryWrap, dek] = await Promise.all([
      wrapRawDek(rawDek, password, {
        kdf: 'PBKDF2-SHA256',
        iterations,
        aad: buildPasswordWrapAad(iterations),
      }),
      wrapRawDek(rawDek, normalizedRecovery, {
        kdf: 'HKDF-SHA256',
        iterations,
        aad: buildRecoveryWrapAad('HKDF-SHA256'),
      }),
      importSessionDek(rawDek, false),
    ]);

    const now = new Date().toISOString();
    const meta: VaultMeta = {
      version: VAULT_VERSION,
      kdf: 'PBKDF2-SHA256',
      iterations,
      recoveryKdf: 'HKDF-SHA256',
      passwordWrap,
      recoveryWrap,
      createdAt: now,
      updatedAt: now,
    };

    return { meta, dek, recoveryKey };
  } finally {
    rawDek.fill(0);
  }
}

export async function unlockWithPassword(
  password: string,
  meta: VaultMeta,
  extractable = false
): Promise<CryptoKey> {
  if (!password) throw new WrongSecretError();
  const rawDek = await unwrapRawDek(
    meta.passwordWrap,
    password,
    getPasswordUnwrapOpts(meta)
  );
  try {
    return await importSessionDek(rawDek, extractable);
  } finally {
    rawDek.fill(0);
  }
}

export async function unlockWithRecoveryKey(
  recoveryKey: string,
  meta: VaultMeta,
  extractable = false
): Promise<CryptoKey> {
  const normalized = normalizeRecoveryKey(recoveryKey);
  if (normalized.length < 16) {
    throw new WrongSecretError('Invalid recovery key format.');
  }
  const rawDek = await unwrapRawDek(
    meta.recoveryWrap,
    normalized,
    getRecoveryUnwrapOpts(meta)
  );
  try {
    return await importSessionDek(rawDek, extractable);
  } finally {
    rawDek.fill(0);
  }
}

/**
 * Unwraps the DEK with the recovery key, re-wraps the master password, upgrades v1
 * vaults to v2 (AAD-bound wraps + HKDF recovery wrap), and returns a non-extractable
 * session DEK.
 */
export async function recoverAndRewrapPassword(
  recoveryKey: string,
  newPassword: string,
  meta: VaultMeta
): Promise<{ dek: CryptoKey; meta: VaultMeta }> {
  assertValidPassword(newPassword);
  const normalized = normalizeRecoveryKey(recoveryKey);
  if (normalized.length < 16) {
    throw new WrongSecretError('Invalid recovery key format.');
  }

  const rawDek = await unwrapRawDek(
    meta.recoveryWrap,
    normalized,
    getRecoveryUnwrapOpts(meta)
  );

  try {
    const nextIterations = Math.max(meta.iterations, DEFAULT_PBKDF2_ITERATIONS);
    const passwordWrap = await wrapRawDek(rawDek, newPassword, {
      kdf: 'PBKDF2-SHA256',
      iterations: nextIterations,
      aad: buildPasswordWrapAad(nextIterations),
    });

    // Upgrade v1 recoveryWrap to v2 HKDF+AAD too since we hold the recovery key
    const recoveryWrap =
      meta.version === 1 || meta.recoveryKdf !== 'HKDF-SHA256'
        ? await wrapRawDek(rawDek, normalized, {
            kdf: 'HKDF-SHA256',
            iterations: nextIterations,
            aad: buildRecoveryWrapAad('HKDF-SHA256'),
          })
        : meta.recoveryWrap;

    const dek = await importSessionDek(rawDek, false);
    return {
      dek,
      meta: {
        ...meta,
        version: VAULT_VERSION,
        iterations: nextIterations,
        recoveryKdf: 'HKDF-SHA256',
        passwordWrap,
        recoveryWrap,
        updatedAt: new Date().toISOString(),
      },
    };
  } finally {
    rawDek.fill(0);
  }
}

/**
 * Verifies the user's current master password, re-wraps the DEK with the new
 * password, and preserves recovery key compatibility (including for v1 vaults).
 */
export async function changePasswordWithCurrent(
  currentPassword: string,
  newPassword: string,
  meta: VaultMeta
): Promise<VaultMeta> {
  if (!currentPassword) throw new WrongSecretError();
  assertValidPassword(newPassword);

  const rawDek = await unwrapRawDek(
    meta.passwordWrap,
    currentPassword,
    getPasswordUnwrapOpts(meta)
  );

  try {
    // In v1 vaults, iterations is shared with recoveryWrap, so preserve iterations on v1
    const nextIterations =
      meta.version >= 2 && meta.recoveryKdf === 'HKDF-SHA256'
        ? Math.max(meta.iterations, DEFAULT_PBKDF2_ITERATIONS)
        : meta.iterations;

    const passwordWrap = await wrapRawDek(rawDek, newPassword, {
      kdf: 'PBKDF2-SHA256',
      iterations: nextIterations,
      aad: meta.version >= 2 ? buildPasswordWrapAad(nextIterations) : undefined,
    });

    return {
      ...meta,
      iterations: nextIterations,
      passwordWrap,
      updatedAt: new Date().toISOString(),
    };
  } finally {
    rawDek.fill(0);
  }
}

/**
 * Verifies the current master password, generates a new 160-bit recovery key,
 * and upgrades v1 vaults cleanly to v2 (AAD-bound wraps + HKDF recovery wrap).
 */
export async function regenerateRecoveryKeyWithPassword(
  currentPassword: string,
  meta: VaultMeta
): Promise<{ meta: VaultMeta; recoveryKey: string }> {
  if (!currentPassword) throw new WrongSecretError();

  const rawDek = await unwrapRawDek(
    meta.passwordWrap,
    currentPassword,
    getPasswordUnwrapOpts(meta)
  );

  try {
    const recoveryKey = generateRecoveryKey();
    const normalizedRecovery = normalizeRecoveryKey(recoveryKey);
    const nextIterations =
      meta.version === 1
        ? Math.max(meta.iterations, DEFAULT_PBKDF2_ITERATIONS)
        : meta.iterations;

    const passwordWrap =
      meta.version === 1
        ? await wrapRawDek(rawDek, currentPassword, {
            kdf: 'PBKDF2-SHA256',
            iterations: nextIterations,
            aad: buildPasswordWrapAad(nextIterations),
          })
        : meta.passwordWrap;

    const recoveryWrap = await wrapRawDek(rawDek, normalizedRecovery, {
      kdf: 'HKDF-SHA256',
      iterations: nextIterations,
      aad: buildRecoveryWrapAad('HKDF-SHA256'),
    });

    return {
      meta: {
        ...meta,
        version: VAULT_VERSION,
        iterations: nextIterations,
        recoveryKdf: 'HKDF-SHA256',
        passwordWrap,
        recoveryWrap,
        updatedAt: new Date().toISOString(),
      },
      recoveryKey,
    };
  } finally {
    rawDek.fill(0);
  }
}

export async function rewrapPassword(
  dek: CryptoKey,
  newPassword: string,
  meta: VaultMeta
): Promise<VaultMeta> {
  assertValidPassword(newPassword);
  const rawDek = await exportRawDek(dek);
  try {
    const nextIterations =
      meta.version >= 2 && meta.recoveryKdf === 'HKDF-SHA256'
        ? Math.max(meta.iterations, DEFAULT_PBKDF2_ITERATIONS)
        : meta.iterations;

    const passwordWrap = await wrapRawDek(rawDek, newPassword, {
      kdf: 'PBKDF2-SHA256',
      iterations: nextIterations,
      aad: meta.version >= 2 ? buildPasswordWrapAad(nextIterations) : undefined,
    });
    return {
      ...meta,
      iterations: nextIterations,
      passwordWrap,
      updatedAt: new Date().toISOString(),
    };
  } finally {
    rawDek.fill(0);
  }
}

export async function regenerateRecoveryKey(
  dek: CryptoKey,
  meta: VaultMeta
): Promise<{ meta: VaultMeta; recoveryKey: string }> {
  const rawDek = await exportRawDek(dek);
  try {
    const recoveryKey = generateRecoveryKey();
    const recoveryKdf: RecoveryKdf =
      meta.version >= 2 ? 'HKDF-SHA256' : 'PBKDF2-SHA256';
    const recoveryWrap = await wrapRawDek(
      rawDek,
      normalizeRecoveryKey(recoveryKey),
      {
        kdf: recoveryKdf,
        iterations: meta.iterations,
        aad: meta.version >= 2 ? buildRecoveryWrapAad(recoveryKdf) : undefined,
      }
    );
    return {
      meta: {
        ...meta,
        recoveryKdf: meta.version >= 2 ? recoveryKdf : meta.recoveryKdf,
        recoveryWrap,
        updatedAt: new Date().toISOString(),
      },
      recoveryKey,
    };
  } finally {
    rawDek.fill(0);
  }
}

export function isLegacyV1Blob(blob: Uint8Array): boolean {
  return blob.length > 0 && blob[0] === BLOB_VERSION_V1;
}

/**
 * Verifies the user's current master password and upgrades vault metadata to
 * v2 (AAD-bound password wrap at >= DEFAULT_PBKDF2_ITERATIONS + fast HKDF-SHA256
 * recovery wrap with a newly generated 160-bit recovery key).
 */
export async function upgradeVaultMetaToV2(
  currentPassword: string,
  meta: VaultMeta
): Promise<{ meta: VaultMeta; recoveryKey: string }> {
  if (!currentPassword) throw new WrongSecretError();

  const rawDek = await unwrapRawDek(
    meta.passwordWrap,
    currentPassword,
    getPasswordUnwrapOpts(meta)
  );

  try {
    const nextIterations = Math.max(meta.iterations, DEFAULT_PBKDF2_ITERATIONS);
    const recoveryKey = generateRecoveryKey();
    const normalizedRecovery = normalizeRecoveryKey(recoveryKey);

    const [passwordWrap, recoveryWrap] = await Promise.all([
      wrapRawDek(rawDek, currentPassword, {
        kdf: 'PBKDF2-SHA256',
        iterations: nextIterations,
        aad: buildPasswordWrapAad(nextIterations),
      }),
      wrapRawDek(rawDek, normalizedRecovery, {
        kdf: 'HKDF-SHA256',
        iterations: nextIterations,
        aad: buildRecoveryWrapAad('HKDF-SHA256'),
      }),
    ]);

    return {
      meta: {
        ...meta,
        version: VAULT_VERSION,
        iterations: nextIterations,
        recoveryKdf: 'HKDF-SHA256',
        passwordWrap,
        recoveryWrap,
        updatedAt: new Date().toISOString(),
      },
      recoveryKey,
    };
  } finally {
    rawDek.fill(0);
  }
}

export async function encryptBytes(
  dek: CryptoKey,
  plaintext: Uint8Array,
  aad?: string
): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const payload = asBufferSource(plaintext);
  const cipherAndTag = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: buildBlobV2Aad(aad),
      },
      dek,
      payload
    )
  );
  return concatBytes(new Uint8Array([BLOB_VERSION]), nonce, cipherAndTag);
}

export async function decryptBytes(
  dek: CryptoKey,
  blob: Uint8Array,
  expectedAad?: string
): Promise<Uint8Array<ArrayBuffer>> {
  if (blob.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new Error('Encrypted blob is too short or corrupted.');
  }
  const version = blob[0];
  if (version !== BLOB_VERSION_V1 && version !== BLOB_VERSION) {
    throw new Error(`Unsupported encrypted blob version: ${version}`);
  }
  const nonce = asBufferSource(blob.subarray(1, 1 + NONCE_BYTES));
  const cipherAndTag = asBufferSource(blob.subarray(1 + NONCE_BYTES));
  const algo: AesGcmParams =
    version === BLOB_VERSION
      ? {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: buildBlobV2Aad(expectedAad),
        }
      : { name: 'AES-GCM', iv: nonce };

  const plain = await crypto.subtle.decrypt(algo, dek, cipherAndTag);
  return new Uint8Array(plain);
}

export async function encryptJson<T>(
  dek: CryptoKey,
  value: T,
  aad?: string
): Promise<Uint8Array<ArrayBuffer>> {
  return encryptBytes(dek, utf8ToBytes(JSON.stringify(value)), aad);
}

export async function decryptJson<T>(
  dek: CryptoKey,
  blob: Uint8Array,
  expectedAad?: string
): Promise<T> {
  const plain = await decryptBytes(dek, blob, expectedAad);
  return JSON.parse(bytesToUtf8(plain)) as T;
}
