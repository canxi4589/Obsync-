import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decryptCredentialsEnvelope,
  derivePassphraseCredentialKey,
  encryptCredentialsEnvelope,
  enrollWebAuthnPrfKey,
  unlockCredentialsWithPassphrase,
  unlockCredentialsWithWebAuthn,
  validateCredentialsEnvelope,
} from '../crypto/credentialCrypto';
import { WrongSecretError } from '../crypto/vaultCrypto';
import {
  loadEncryptedCredentialsEnvelope,
  loadPreferences,
  loadStoredProviders,
  mergeProviderSecrets,
  purgeAllBrowserStorage,
  saveEncryptedProviderConfigs,
  savePreferences,
} from '../storage/configStore';
import { OfflineCache } from '../storage/offlineCache';
import type { StorageProviderConfig } from '../storage/types';

function makeMockStorage(map: Map<string, string>): Storage {
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => map.delete(k),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe('Encrypted-at-Rest Credentials & In-Memory Mode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('encrypts provider credentials with passphrase PBKDF2 + AES-256-GCM AAD and keeps plaintext out of localStorage', async () => {
    const localMap = new Map<string, string>();
    const sessionMap = new Map<string, string>();
    vi.stubGlobal('localStorage', makeMockStorage(localMap));
    vi.stubGlobal('sessionStorage', makeMockStorage(sessionMap));

    const configs: StorageProviderConfig[] = [
      {
        id: 'gh-1',
        type: 'github',
        label: 'GH',
        enabled: true,
        mirrorWrites: true,
        owner: 'alice',
        repo: 'vault',
        branch: 'main',
        token: 'github_pat_top_secret_token',
      },
      {
        id: 's3-1',
        type: 's3',
        label: 'R2',
        enabled: true,
        mirrorWrites: true,
        endpoint: 'https://r2.example.com',
        region: 'auto',
        bucket: 'notes',
        accessKeyId: 'AKIA_SECRET_ID',
        secretAccessKey: 'super_secret_s3_key',
      },
    ];

    const unlockKey = await derivePassphraseCredentialKey('my-device-pin-2026', {
      iterations: 100_000,
      enforceMinLength: true,
    });
    expect(unlockKey.key.extractable).toBe(false);

    const envelope = await saveEncryptedProviderConfigs(configs, unlockKey);
    expect(envelope).not.toBeNull();
    expect(envelope!.method).toBe('passphrase');

    // Neither localStorage nor sessionStorage may contain any plaintext credential
    const allStoredText = [
      ...Array.from(localMap.values()),
      ...Array.from(sessionMap.values()),
    ].join('\n');
    expect(allStoredText).not.toContain('github_pat_top_secret_token');
    expect(allStoredText).not.toContain('AKIA_SECRET_ID');
    expect(allStoredText).not.toContain('super_secret_s3_key');

    // Reload metadata + encrypted envelope -> stripped until unlocked
    const loaded = loadStoredProviders();
    expect(loaded.hasLegacyPlaintextSecrets).toBe(false);
    expect(loaded.configs[0].type === 'github' && loaded.configs[0].token).toBe('');
    expect(loaded.configs[1].type === 's3' && loaded.configs[1].secretAccessKey).toBe('');

    const storedEnvelope = loadEncryptedCredentialsEnvelope();
    expect(storedEnvelope).not.toBeNull();

    // Wrong passphrase rejected
    await expect(
      unlockCredentialsWithPassphrase(storedEnvelope!, 'wrong-pin')
    ).rejects.toThrow(WrongSecretError);

    // Correct passphrase decrypts secrets into RAM
    const unlocked = await unlockCredentialsWithPassphrase(
      storedEnvelope!,
      'my-device-pin-2026'
    );
    const merged = mergeProviderSecrets(loaded.configs, unlocked.secrets);
    expect(merged[0].type === 'github' && merged[0].token).toBe(
      'github_pat_top_secret_token'
    );
    expect(merged[1].type === 's3' && merged[1].accessKeyId).toBe('AKIA_SECRET_ID');
    expect(merged[1].type === 's3' && merged[1].secretAccessKey).toBe(
      'super_secret_s3_key'
    );

    // Tampered iterations (DoS or AAD mismatch) rejected
    expect(() =>
      validateCredentialsEnvelope({ ...storedEnvelope!, iterations: 999_999_999 })
    ).toThrow('Invalid credentials KDF iterations');

    await expect(
      decryptCredentialsEnvelope(
        { ...storedEnvelope!, iterations: 100_001 },
        unlocked.unlockKey
      )
    ).rejects.toThrow(WrongSecretError);
  });

  it('supports WebAuthn PRF key enrollment and unlock with HKDF-SHA256', async () => {
    const mockRawId = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]).buffer;
    const mockPrfOutput = new Uint8Array(32).fill(0x5a).buffer;

    vi.stubGlobal('window', {
      isSecureContext: true,
      location: { hostname: 'notes.example.com' },
    });
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn(async () => ({
          rawId: mockRawId,
          getClientExtensionResults: () => ({
            prf: { enabled: true, results: { first: mockPrfOutput.slice(0) } },
          }),
        })),
        get: vi.fn(async () => ({
          rawId: mockRawId,
          getClientExtensionResults: () => ({
            prf: { results: { first: mockPrfOutput.slice(0) } },
          }),
        })),
      },
    });

    const enrolled = await enrollWebAuthnPrfKey();
    expect(enrolled.method).toBe('webauthn-prf');
    expect(enrolled.key.extractable).toBe(false);
    expect(enrolled.webauthnCredentialId).toBeTruthy();

    const env = await encryptCredentialsEnvelope(
      { 'gh-1': { token: 'pat-webauthn-123' } },
      enrolled
    );
    expect(env.method).toBe('webauthn-prf');
    expect(validateCredentialsEnvelope(env).method).toBe('webauthn-prf');

    const { secrets } = await unlockCredentialsWithWebAuthn(env);
    expect(secrets['gh-1'].token).toBe('pat-webauthn-123');
  });

  it('detects legacy plaintext localStorage secrets and enforces zero-persistence in memory-only mode', async () => {
    const localMap = new Map<string, string>();
    const sessionMap = new Map<string, string>();
    vi.stubGlobal('localStorage', makeMockStorage(localMap));
    vi.stubGlobal('sessionStorage', makeMockStorage(sessionMap));

    // Seed legacy plaintext config
    localMap.set(
      'obsync.storage.providers.v1',
      JSON.stringify([
        {
          id: 'gh-legacy',
          type: 'github',
          label: 'Old GH',
          enabled: true,
          mirrorWrites: true,
          owner: 'alice',
          repo: 'vault',
          branch: 'main',
          token: 'legacy_plaintext_pat',
        },
      ])
    );

    const detected = loadStoredProviders();
    expect(detected.hasLegacyPlaintextSecrets).toBe(true);

    // Switching to memory-only wipes browser storage and prevents new writes
    purgeAllBrowserStorage();
    savePreferences({ autoLockMinutes: 5, credentialStorage: 'memory' });
    expect(localMap.size).toBe(0);
    expect(sessionMap.size).toBe(0);
    expect(loadPreferences().credentialStorage).toBe('encrypted'); // default when nothing stored

    // OfflineCache in memory-only mode stores in RAM and clearAll wipes cleanly
    const cache = new OfflineCache();
    cache.setMemoryOnly(true);
    expect(cache.isMemoryOnly()).toBe(true);
    await cache.putFile('test.md', new Uint8Array([1, 2, 3]));
    expect(await cache.listFiles()).toHaveLength(1);
    await cache.clearAll();
    expect(await cache.listFiles()).toHaveLength(0);
  });
});
