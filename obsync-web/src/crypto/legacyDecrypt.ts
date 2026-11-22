import { asBufferSource, concatBytes, utf8ToBytes } from './base64';
import { WrongSecretError } from './vaultCrypto';

const LEGACY_SALT_SIZE = 16;
const LEGACY_NONCE_SIZE = 12;
const LEGACY_TAG_SIZE = 16;
const LEGACY_ITERATIONS = 200_000;

/**
 * Decrypts files created by the legacy C# ObsidianSync CLI:
 * Binary layout: [salt 16B][nonce 12B][tag 16B][ciphertext]
 * KDF: PBKDF2-HMAC-SHA256, 200,000 iterations, 256-bit AES-GCM.
 */
export async function decryptLegacyCliBlob(
  data: Uint8Array,
  password: string
): Promise<Uint8Array<ArrayBuffer>> {
  const headerSize = LEGACY_SALT_SIZE + LEGACY_NONCE_SIZE + LEGACY_TAG_SIZE;
  if (data.length < headerSize) {
    throw new Error('Data too short — not a valid legacy encrypted file.');
  }

  const salt = asBufferSource(data.subarray(0, LEGACY_SALT_SIZE));
  const nonce = asBufferSource(
    data.subarray(LEGACY_SALT_SIZE, LEGACY_SALT_SIZE + LEGACY_NONCE_SIZE)
  );
  const tag = data.subarray(
    LEGACY_SALT_SIZE + LEGACY_NONCE_SIZE,
    headerSize
  );
  const ciphertext = data.subarray(headerSize);

  // Web Crypto expects ciphertext || tag, whereas C# stored tag || ciphertext
  const combined = concatBytes(ciphertext, tag);

  const pwBytes = utf8ToBytes(password);
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
        iterations: LEGACY_ITERATIONS,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce },
        key,
        combined
      );
      return new Uint8Array(plain);
    } catch {
      throw new WrongSecretError(
        'Legacy decryption failed — wrong password or corrupted file.'
      );
    }
  } finally {
    pwBytes.fill(0);
  }
}
