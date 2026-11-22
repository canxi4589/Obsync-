import {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  toBuffer,
  utf8ToBytes,
} from './base64';
import {
  DEFAULT_PBKDF2_ITERATIONS,
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  NONCE_BYTES,
  SALT_BYTES,
  TAG_BYTES,
  WrongSecretError,
} from './vaultCrypto';

export const CREDENTIALS_ENVELOPE_VERSION = 1 as const;
export const MIN_CREDENTIAL_PIN_LENGTH = 6;

export type CredentialUnlockMethod = 'passphrase' | 'webauthn-prf';

export interface ProviderSecretEntry {
  token?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export type ProviderSecretsMap = Record<string, ProviderSecretEntry>;

export interface EncryptedCredentialsEnvelope {
  version: 1;
  method: CredentialUnlockMethod;
  kdf?: 'PBKDF2-SHA256';
  iterations?: number;
  salt: string;
  nonce: string;
  ciphertext: string;
  webauthnCredentialId?: string;
  updatedAt: string;
}

export interface CredentialUnlockKey {
  method: CredentialUnlockMethod;
  key: CryptoKey;
  salt: Uint8Array<ArrayBuffer>;
  iterations?: number;
  webauthnCredentialId?: string;
}

const WEBAUTHN_PRF_SALT_BYTES = 32;
const WEBAUTHN_HKDF_INFO = utf8ToBytes('obsync:creds:v1:webauthn-prf');

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(b64url: string): Uint8Array<ArrayBuffer> {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return base64ToBytes(padded + '='.repeat(padLen));
}

function buildCredentialAad(
  method: CredentialUnlockMethod,
  iterations?: number
): Uint8Array<ArrayBuffer> {
  return utf8ToBytes(
    method === 'passphrase'
      ? `obsync:creds:v1:passphrase:${iterations ?? DEFAULT_PBKDF2_ITERATIONS}`
      : 'obsync:creds:v1:webauthn-prf'
  );
}

function extractPrfOutput(
  cred: PublicKeyCredential
): { enabled: boolean; first?: Uint8Array<ArrayBuffer> } {
  const ext = cred.getClientExtensionResults?.()?.prf;
  if (!ext) return { enabled: false };
  const rawFirst = ext.results?.first;
  if (rawFirst instanceof ArrayBuffer) {
    return { enabled: true, first: new Uint8Array(rawFirst) };
  }
  if (rawFirst && ArrayBuffer.isView(rawFirst)) {
    return {
      enabled: true,
      first: toBuffer(
        new Uint8Array(rawFirst.buffer, rawFirst.byteOffset, rawFirst.byteLength)
      ),
    };
  }
  return { enabled: !!ext.enabled };
}

async function deriveAesKeyFromPrfSecret(
  prfBytes: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    prfBytes,
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      salt,
      info: WEBAUTHN_HKDF_INFO,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export function isWebAuthnPrfSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials &&
    typeof navigator.credentials.create === 'function' &&
    typeof navigator.credentials.get === 'function'
  );
}

export function validateCredentialsEnvelope(
  raw: unknown,
  opts?: { minIterations?: number }
): EncryptedCredentialsEnvelope {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid encrypted credentials envelope.');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== CREDENTIALS_ENVELOPE_VERSION) {
    throw new Error(`Unsupported credentials envelope version: ${String(obj.version)}`);
  }
  if (obj.method !== 'passphrase' && obj.method !== 'webauthn-prf') {
    throw new Error(`Unsupported credential unlock method: ${String(obj.method)}`);
  }
  if (
    typeof obj.salt !== 'string' ||
    typeof obj.nonce !== 'string' ||
    typeof obj.ciphertext !== 'string' ||
    typeof obj.updatedAt !== 'string'
  ) {
    throw new Error('Malformed encrypted credentials fields.');
  }

  let saltBytes: Uint8Array;
  let nonceBytes: Uint8Array;
  let ctBytes: Uint8Array;
  try {
    saltBytes = base64ToBytes(obj.salt);
    nonceBytes = base64ToBytes(obj.nonce);
    ctBytes = base64ToBytes(obj.ciphertext);
  } catch {
    throw new Error('Invalid base64 in encrypted credentials.');
  }

  if (nonceBytes.byteLength !== NONCE_BYTES) {
    throw new Error('Invalid nonce length in encrypted credentials.');
  }
  if (ctBytes.byteLength < TAG_BYTES) {
    throw new Error('Encrypted credentials payload is too short.');
  }

  if (obj.method === 'passphrase') {
    if (obj.kdf !== 'PBKDF2-SHA256') {
      throw new Error(`Unsupported credentials KDF: ${String(obj.kdf)}`);
    }
    const minIter = opts?.minIterations ?? MIN_PBKDF2_ITERATIONS;
    if (
      typeof obj.iterations !== 'number' ||
      !Number.isInteger(obj.iterations) ||
      obj.iterations < minIter ||
      obj.iterations > MAX_PBKDF2_ITERATIONS
    ) {
      throw new Error(
        `Invalid credentials KDF iterations (${String(obj.iterations)}).`
      );
    }
    if (saltBytes.byteLength !== SALT_BYTES) {
      throw new Error('Invalid salt length for passphrase credentials.');
    }
  } else {
    if (
      typeof obj.webauthnCredentialId !== 'string' ||
      !obj.webauthnCredentialId.trim()
    ) {
      throw new Error('Missing WebAuthn credential ID.');
    }
    if (saltBytes.byteLength !== WEBAUTHN_PRF_SALT_BYTES) {
      throw new Error('Invalid PRF salt length for WebAuthn credentials.');
    }
  }

  return {
    version: 1,
    method: obj.method,
    kdf: obj.method === 'passphrase' ? 'PBKDF2-SHA256' : undefined,
    iterations: obj.method === 'passphrase' ? (obj.iterations as number) : undefined,
    salt: obj.salt,
    nonce: obj.nonce,
    ciphertext: obj.ciphertext,
    webauthnCredentialId:
      obj.method === 'webauthn-prf'
        ? (obj.webauthnCredentialId as string)
        : undefined,
    updatedAt: obj.updatedAt,
  };
}

export async function derivePassphraseCredentialKey(
  passphrase: string,
  opts?: {
    salt?: Uint8Array<ArrayBuffer>;
    iterations?: number;
    enforceMinLength?: boolean;
  }
): Promise<CredentialUnlockKey> {
  if (!passphrase) {
    throw new WrongSecretError('Passphrase / PIN cannot be empty.');
  }
  if (opts?.enforceMinLength && passphrase.length < MIN_CREDENTIAL_PIN_LENGTH) {
    throw new Error(
      `Credential passphrase / PIN must be at least ${MIN_CREDENTIAL_PIN_LENGTH} characters.`
    );
  }

  const iterations = opts?.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error(`Invalid credentials KDF iterations: ${iterations}`);
  }

  const salt = opts?.salt
    ? toBuffer(opts.salt)
    : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const pwBytes = utf8ToBytes(passphrase);

  try {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      pwBytes,
      'PBKDF2',
      false,
      ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
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
    return {
      method: 'passphrase',
      key,
      salt,
      iterations,
    };
  } finally {
    pwBytes.fill(0);
  }
}

export async function enrollWebAuthnPrfKey(): Promise<CredentialUnlockKey> {
  if (!isWebAuthnPrfSupported()) {
    throw new Error(
      'WebAuthn Passkey PRF is not available in this browser context. Use a Passphrase / PIN instead.'
    );
  }

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const prfSalt = crypto.getRandomValues(new Uint8Array(WEBAUTHN_PRF_SALT_BYTES));

  const createOpts: CredentialCreationOptions = {
    publicKey: {
      challenge,
      rp: {
        name: 'Obsync Local Credentials',
        id: window.location.hostname,
      },
      user: {
        id: userId,
        name: 'obsync-device-unlock',
        displayName: 'Obsync Credential Unlock',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60_000,
      extensions: {
        prf: {
          eval: {
            first: prfSalt,
          },
        },
      } as AuthenticationExtensionsClientInputs,
    },
  };

  const cred = (await navigator.credentials.create(
    createOpts
  )) as PublicKeyCredential | null;
  if (!cred) {
    throw new Error('Passkey registration was cancelled.');
  }

  const credentialId = toBase64Url(new Uint8Array(cred.rawId));
  const prf = extractPrfOutput(cred);
  if (!prf.enabled) {
    throw new Error(
      'This authenticator or browser does not support the WebAuthn PRF extension. Use a Passphrase / PIN instead.'
    );
  }

  if (prf.first) {
    try {
      const key = await deriveAesKeyFromPrfSecret(prf.first, prfSalt);
      return {
        method: 'webauthn-prf',
        key,
        salt: prfSalt,
        webauthnCredentialId: credentialId,
      };
    } finally {
      prf.first.fill(0);
    }
  }

  // Some browsers report prf.enabled=true on create() and return PRF output on get()
  return unlockWebAuthnPrfKey(credentialId, bytesToBase64(prfSalt));
}

export async function unlockWebAuthnPrfKey(
  credentialIdB64Url: string,
  saltB64: string
): Promise<CredentialUnlockKey> {
  if (!isWebAuthnPrfSupported()) {
    throw new Error('WebAuthn Passkey PRF is not available in this browser context.');
  }

  const prfSalt = base64ToBytes(saltB64);
  const rawId = fromBase64Url(credentialIdB64Url);
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const getOpts: CredentialRequestOptions = {
    publicKey: {
      challenge,
      rpId: window.location.hostname,
      allowCredentials: [{ type: 'public-key', id: rawId }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: {
        prf: {
          eval: {
            first: prfSalt,
          },
        },
      } as AuthenticationExtensionsClientInputs,
    },
  };

  const assertion = (await navigator.credentials.get(
    getOpts
  )) as PublicKeyCredential | null;
  if (!assertion) {
    throw new Error('Passkey unlock was cancelled.');
  }

  const prf = extractPrfOutput(assertion);
  if (!prf.first) {
    throw new Error(
      'Authenticator did not return a WebAuthn PRF key. Try re-enrolling or using a Passphrase / PIN.'
    );
  }

  try {
    const key = await deriveAesKeyFromPrfSecret(prf.first, prfSalt);
    return {
      method: 'webauthn-prf',
      key,
      salt: prfSalt,
      webauthnCredentialId: credentialIdB64Url,
    };
  } finally {
    prf.first.fill(0);
  }
}

export async function encryptCredentialsEnvelope(
  secrets: ProviderSecretsMap,
  unlockKey: CredentialUnlockKey
): Promise<EncryptedCredentialsEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plainBytes = utf8ToBytes(JSON.stringify(secrets));
  const aad = buildCredentialAad(unlockKey.method, unlockKey.iterations);

  try {
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad },
        unlockKey.key,
        plainBytes
      )
    );
    return {
      version: CREDENTIALS_ENVELOPE_VERSION,
      method: unlockKey.method,
      kdf: unlockKey.method === 'passphrase' ? 'PBKDF2-SHA256' : undefined,
      iterations:
        unlockKey.method === 'passphrase'
          ? (unlockKey.iterations ?? DEFAULT_PBKDF2_ITERATIONS)
          : undefined,
      salt: bytesToBase64(unlockKey.salt),
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(encrypted),
      webauthnCredentialId: unlockKey.webauthnCredentialId,
      updatedAt: new Date().toISOString(),
    };
  } finally {
    plainBytes.fill(0);
  }
}

export async function decryptCredentialsEnvelope(
  envelope: EncryptedCredentialsEnvelope,
  unlockKey: CredentialUnlockKey
): Promise<ProviderSecretsMap> {
  if (envelope.method !== unlockKey.method) {
    throw new WrongSecretError('Credential unlock method mismatch.');
  }

  const nonce = base64ToBytes(envelope.nonce);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const aad = buildCredentialAad(envelope.method, envelope.iterations);

  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad },
      unlockKey.key,
      ciphertext
    );
  } catch {
    throw new WrongSecretError(
      'Incorrect passphrase / PIN or corrupted credential store.'
    );
  }

  const plainBytes = new Uint8Array(plainBuf);
  try {
    const parsed = JSON.parse(bytesToUtf8(plainBytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Malformed decrypted credentials payload.');
    }
    return parsed as ProviderSecretsMap;
  } finally {
    plainBytes.fill(0);
  }
}

export async function unlockCredentialsWithPassphrase(
  envelope: EncryptedCredentialsEnvelope,
  passphrase: string
): Promise<{ secrets: ProviderSecretsMap; unlockKey: CredentialUnlockKey }> {
  if (envelope.method !== 'passphrase') {
    throw new Error('Stored credentials are protected by WebAuthn Passkey.');
  }
  const salt = base64ToBytes(envelope.salt);
  const unlockKey = await derivePassphraseCredentialKey(passphrase, {
    salt,
    iterations: envelope.iterations ?? DEFAULT_PBKDF2_ITERATIONS,
  });
  const secrets = await decryptCredentialsEnvelope(envelope, unlockKey);
  return { secrets, unlockKey };
}

export async function unlockCredentialsWithWebAuthn(
  envelope: EncryptedCredentialsEnvelope
): Promise<{ secrets: ProviderSecretsMap; unlockKey: CredentialUnlockKey }> {
  if (envelope.method !== 'webauthn-prf' || !envelope.webauthnCredentialId) {
    throw new Error('Stored credentials are not protected by WebAuthn Passkey.');
  }
  const unlockKey = await unlockWebAuthnPrfKey(
    envelope.webauthnCredentialId,
    envelope.salt
  );
  const secrets = await decryptCredentialsEnvelope(envelope, unlockKey);
  return { secrets, unlockKey };
}
