import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bytesToUtf8, utf8ToBytes } from '../crypto/base64';
import { decryptLegacyCliBlob } from '../crypto/legacyDecrypt';
import {
  createVault,
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  normalizeRecoveryKey,
  regenerateRecoveryKey,
  rewrapPassword,
  unlockWithPassword,
  unlockWithRecoveryKey,
  WrongSecretError,
  type VaultIndex,
} from '../crypto/vaultCrypto';

describe('Vault Zero-Knowledge Crypto', () => {
  it('creates vault, unlocks with password, encrypts & decrypts blobs and JSON', async () => {
    const { meta, dek, recoveryKey } = await createVault('MasterPass!2026', 10_000);
    expect(recoveryKey).toMatch(/^OBSYNC-[A-Z2-9]{4}(-[A-Z2-9]{4}){7}$/);
    expect(meta.kdf).toBe('PBKDF2-SHA256');
    expect(meta.version).toBe(1);

    const unlockedDek = await unlockWithPassword('MasterPass!2026', meta);

    const secretText = '# Bank Credentials\nSecret PIN: 9876\nEmoji: 🔒';
    const cipher = await encryptBytes(dek, utf8ToBytes(secretText));
    const plain = await decryptBytes(unlockedDek, cipher);
    expect(bytesToUtf8(plain)).toBe(secretText);

    const idx: VaultIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      notes: [
        {
          id: 'note-1',
          title: 'Secret Note',
          folder: 'Finance',
          createdAt: '2026-11-22T00:00:00.000Z',
          updatedAt: '2026-11-22T00:00:00.000Z',
        },
      ],
    };
    const idxBlob = await encryptJson(dek, idx);
    const decodedIdx = await decryptJson<VaultIndex>(unlockedDek, idxBlob);
    expect(decodedIdx.notes).toHaveLength(1);
    expect(decodedIdx.notes[0].title).toBe('Secret Note');
  });

  it('rejects wrong password and tampered ciphertext', async () => {
    const { meta, dek } = await createVault('CorrectHorse', 10_000);
    await expect(unlockWithPassword('WrongHorse', meta)).rejects.toThrow(
      WrongSecretError
    );

    const cipher = await encryptBytes(dek, utf8ToBytes('hello world'));
    const tampered = new Uint8Array(cipher);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(decryptBytes(dek, tampered)).rejects.toThrow();
  });

  it('supports recovery key unlock (normalized) and password rotation without losing notes', async () => {
    const { meta, dek, recoveryKey } = await createVault('OldPass123', 10_000);
    const noteCipher = await encryptBytes(dek, utf8ToBytes('Important Note Body'));

    // Rotate master password
    const rotatedMeta = await rewrapPassword(dek, 'BrandNewPass456', meta);

    await expect(unlockWithPassword('OldPass123', rotatedMeta)).rejects.toThrow(
      WrongSecretError
    );
    const dekFromNewPw = await unlockWithPassword('BrandNewPass456', rotatedMeta);
    expect(bytesToUtf8(await decryptBytes(dekFromNewPw, noteCipher))).toBe(
      'Important Note Body'
    );

    // Recovery key (lowercase & stripped hyphens) still works
    const messyInput = normalizeRecoveryKey(recoveryKey).toLowerCase();
    const dekFromRecovery = await unlockWithRecoveryKey(messyInput, rotatedMeta);
    expect(bytesToUtf8(await decryptBytes(dekFromRecovery, noteCipher))).toBe(
      'Important Note Body'
    );
  });

  it('regenerates recovery key and invalidates previous recovery key', async () => {
    const { meta, dek, recoveryKey: oldKey } = await createVault('MyPass', 10_000);
    const { meta: newMeta, recoveryKey: newKey } = await regenerateRecoveryKey(
      dek,
      meta
    );

    expect(newKey).not.toBe(oldKey);
    await expect(unlockWithRecoveryKey(oldKey, newMeta)).rejects.toThrow(
      WrongSecretError
    );

    const unlocked = await unlockWithRecoveryKey(newKey, newMeta);
    expect(unlocked).toBeDefined();
    await expect(unlockWithPassword('MyPass', newMeta)).resolves.toBeDefined();
  });

  it('decrypts legacy C# EncryptionService binary format [salt 16][nonce 12][tag 16][ciphertext]', async () => {
    const legacyPassword = 'LegacyWindowsPassword!';
    const plaintext = Buffer.from('# Legacy Private Note\nLine 2', 'utf8');

    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const key = pbkdf2Sync(legacyPassword, salt, 200_000, 32, 'sha256');
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Exact C# layout: salt | nonce | tag | ciphertext
    const csharpBlob = new Uint8Array(Buffer.concat([salt, nonce, tag, encrypted]));

    const decoded = await decryptLegacyCliBlob(csharpBlob, legacyPassword);
    expect(bytesToUtf8(decoded)).toBe('# Legacy Private Note\nLine 2');

    await expect(decryptLegacyCliBlob(csharpBlob, 'bad-password')).rejects.toThrow(
      WrongSecretError
    );
  });
});
