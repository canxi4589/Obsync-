import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bytesToBase64, bytesToUtf8, concatBytes, utf8ToBytes } from '../crypto/base64';
import { decryptLegacyCliBlob } from '../crypto/legacyDecrypt';
import {
  BLOB_VERSION,
  BLOB_VERSION_V1,
  changePasswordWithCurrent,
  createVault,
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  normalizeRecoveryKey,
  recoverAndRewrapPassword,
  regenerateRecoveryKeyWithPassword,
  unlockWithPassword,
  unlockWithRecoveryKey,
  validateVaultMeta,
  WrongSecretError,
  type VaultIndex,
  type VaultMeta,
} from '../crypto/vaultCrypto';

describe('Vault Zero-Knowledge Crypto', () => {
  it('creates v2 vault with non-extractable DEK, HKDF recovery wrap, and AAD-bound blobs', async () => {
    const { meta, dek, recoveryKey } = await createVault('MasterPass!2026', 10_000);
    expect(recoveryKey).toMatch(/^OBSYNC-[A-Z2-9]{4}(-[A-Z2-9]{4}){7}$/);
    expect(meta.kdf).toBe('PBKDF2-SHA256');
    expect(meta.version).toBe(2);
    expect(meta.recoveryKdf).toBe('HKDF-SHA256');
    expect(dek.extractable).toBe(false);

    const unlockedDek = await unlockWithPassword('MasterPass!2026', meta);
    expect(unlockedDek.extractable).toBe(false);

    const secretText = '# Bank Credentials\nSecret PIN: 9876\nEmoji: 🔒';
    const cipher = await encryptBytes(dek, utf8ToBytes(secretText), 'note:abc');
    expect(cipher[0]).toBe(BLOB_VERSION);
    const plain = await decryptBytes(unlockedDek, cipher, 'note:abc');
    expect(bytesToUtf8(plain)).toBe(secretText);

    // Ciphertext swapped to a different note ID must fail AAD check
    await expect(decryptBytes(unlockedDek, cipher, 'note:other')).rejects.toThrow();
    await expect(decryptBytes(unlockedDek, cipher, 'index')).rejects.toThrow();

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
    const idxBlob = await encryptJson(dek, idx, 'index');
    const decodedIdx = await decryptJson<VaultIndex>(unlockedDek, idxBlob, 'index');
    expect(decodedIdx.notes).toHaveLength(1);
    expect(decodedIdx.notes[0].title).toBe('Secret Note');
  });

  it('enforces minimum password length and validates vault.json metadata against KDF DoS/downgrade', async () => {
    await expect(createVault('short123', 10_000)).rejects.toThrow('at least 12 characters');

    const { meta } = await createVault('StrongVaultPass!2026', 100_000);
    expect(validateVaultMeta(meta).version).toBe(2);

    // Huge iterations DoS rejected
    expect(() =>
      validateVaultMeta({ ...meta, iterations: 500_000_000 })
    ).toThrow('Invalid KDF iterations');

    // Too-low iterations downgrade rejected
    expect(() =>
      validateVaultMeta({ ...meta, iterations: 10 })
    ).toThrow('Invalid KDF iterations');

    // Swapping passwordWrap and recoveryWrap fails AAD check on v2
    const swappedMeta: VaultMeta = {
      ...meta,
      passwordWrap: meta.recoveryWrap,
    };
    await expect(
      unlockWithPassword('StrongVaultPass!2026', swappedMeta)
    ).rejects.toThrow(WrongSecretError);
  });

  it('rejects wrong password and tampered ciphertext', async () => {
    const { meta, dek } = await createVault('CorrectHorse123', 10_000);
    await expect(unlockWithPassword('WrongHorse123', meta)).rejects.toThrow(
      WrongSecretError
    );

    const cipher = await encryptBytes(dek, utf8ToBytes('hello world'));
    const tampered = new Uint8Array(cipher);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(decryptBytes(dek, tampered)).rejects.toThrow();
  });

  it('supports recovery key unlock (normalized) and password rotation with current-password verification', async () => {
    const { meta, dek, recoveryKey } = await createVault('OldPass123456!', 10_000);
    const noteCipher = await encryptBytes(dek, utf8ToBytes('Important Note Body'), 'note:n1');

    // Wrong current password must fail rotation
    await expect(
      changePasswordWithCurrent('WrongCurrentPw!', 'BrandNewPass456!', meta)
    ).rejects.toThrow(WrongSecretError);

    // Rotate master password with valid current password
    const rotatedMeta = await changePasswordWithCurrent(
      'OldPass123456!',
      'BrandNewPass456!',
      meta
    );

    await expect(unlockWithPassword('OldPass123456!', rotatedMeta)).rejects.toThrow(
      WrongSecretError
    );
    const dekFromNewPw = await unlockWithPassword('BrandNewPass456!', rotatedMeta);
    expect(bytesToUtf8(await decryptBytes(dekFromNewPw, noteCipher, 'note:n1'))).toBe(
      'Important Note Body'
    );

    // Recovery key (lowercase & stripped hyphens) still works
    const messyInput = normalizeRecoveryKey(recoveryKey).toLowerCase();
    const dekFromRecovery = await unlockWithRecoveryKey(messyInput, rotatedMeta);
    expect(bytesToUtf8(await decryptBytes(dekFromRecovery, noteCipher, 'note:n1'))).toBe(
      'Important Note Body'
    );
  });

  it('regenerates recovery key with current-password check and invalidates previous recovery key', async () => {
    const { meta, recoveryKey: oldKey } = await createVault('MyPass123456!', 10_000);

    await expect(
      regenerateRecoveryKeyWithPassword('WrongPass123!', meta)
    ).rejects.toThrow(WrongSecretError);

    const { meta: newMeta, recoveryKey: newKey } =
      await regenerateRecoveryKeyWithPassword('MyPass123456!', meta);

    expect(newKey).not.toBe(oldKey);
    await expect(unlockWithRecoveryKey(oldKey, newMeta)).rejects.toThrow(
      WrongSecretError
    );

    const unlocked = await unlockWithRecoveryKey(newKey, newMeta);
    expect(unlocked.extractable).toBe(false);
    await expect(unlockWithPassword('MyPass123456!', newMeta)).resolves.toBeDefined();
  });

  it('maintains backwards compatibility with legacy v1 vaults and v1 blobs, upgrading on recovery', async () => {
    const rawDek = randomBytes(32);
    const v1Pw = 'LegacyV1Pass!';
    const v1Recovery = 'OBSYNC-ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789';
    const normRec = normalizeRecoveryKey(v1Recovery);
    const iterations = 100_000;

    const wrapV1 = (secret: string) => {
      const salt = randomBytes(16);
      const nonce = randomBytes(12);
      const kek = pbkdf2Sync(secret, salt, iterations, 32, 'sha256');
      const cipher = createCipheriv('aes-256-gcm', kek, nonce);
      const enc = Buffer.concat([cipher.update(rawDek), cipher.final(), cipher.getAuthTag()]);
      return {
        salt: bytesToBase64(salt),
        nonce: bytesToBase64(nonce),
        wrappedDek: bytesToBase64(enc),
      };
    };

    const v1Meta: VaultMeta = {
      version: 1,
      kdf: 'PBKDF2-SHA256',
      iterations,
      passwordWrap: wrapV1(v1Pw),
      recoveryWrap: wrapV1(normRec),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    // Create a v1 blob [0x01][nonce 12B][ciphertext + tag] without AAD
    const noteNonce = randomBytes(12);
    const noteCipher = createCipheriv('aes-256-gcm', rawDek, noteNonce);
    const noteEnc = Buffer.concat([
      noteCipher.update(utf8ToBytes('Legacy v1 note')),
      noteCipher.final(),
      noteCipher.getAuthTag(),
    ]);
    const v1Blob = concatBytes(new Uint8Array([BLOB_VERSION_V1]), noteNonce, noteEnc);

    const validated = validateVaultMeta(v1Meta);
    const unlockedV1 = await unlockWithPassword(v1Pw, validated);
    expect(bytesToUtf8(await decryptBytes(unlockedV1, v1Blob, 'note:legacy'))).toBe(
      'Legacy v1 note'
    );

    // Recovering a v1 vault upgrades metadata to v2 with HKDF recovery wrap
    const recovered = await recoverAndRewrapPassword(
      v1Recovery,
      'UpgradedV2Password!',
      validated
    );
    expect(recovered.meta.version).toBe(2);
    expect(recovered.meta.recoveryKdf).toBe('HKDF-SHA256');
    expect(bytesToUtf8(await decryptBytes(recovered.dek, v1Blob, 'note:legacy'))).toBe(
      'Legacy v1 note'
    );
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
