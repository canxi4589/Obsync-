import {
  encryptCredentialsEnvelope,
  validateCredentialsEnvelope,
  type CredentialUnlockKey,
  type EncryptedCredentialsEnvelope,
  type ProviderSecretsMap,
} from '../crypto/credentialCrypto';
import type {
  AppPreferences,
  ObsyncTheme,
  StorageProviderConfig,
} from './types';

const PROVIDERS_KEY = 'obsync.storage.providers.v1';
const CREDENTIALS_ENC_KEY = 'obsync.storage.credentials.enc.v1';
const LEGACY_SESSION_SECRETS_KEY = 'obsync.storage.secrets.session.v1';
const PREFS_KEY = 'obsync.preferences.v1';

const VALID_THEMES: readonly ObsyncTheme[] = [
  'obsync',
  'night',
  'dracula',
  'dim',
  'nord',
  'light',
];

const DEFAULT_PREFS: AppPreferences = {
  autoLockMinutes: 10,
  credentialStorage: 'encrypted',
  theme: 'obsync',
};

function hasLocalStorage(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    'localStorage' in globalThis &&
    !!globalThis.localStorage
  );
}

function hasSessionStorage(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    'sessionStorage' in globalThis &&
    !!globalThis.sessionStorage
  );
}

export function isSharedGitHubPagesOrigin(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.location?.hostname === 'string' &&
    window.location.hostname.toLowerCase().endsWith('.github.io')
  );
}

export function providerRequiresSecret(cfg: StorageProviderConfig): boolean {
  return cfg.type === 'github' || cfg.type === 's3';
}

export function hasMissingCredentials(cfg: StorageProviderConfig): boolean {
  if (cfg.type === 'github') return !cfg.token.trim();
  if (cfg.type === 's3') {
    return !cfg.accessKeyId.trim() || !cfg.secretAccessKey.trim();
  }
  return false;
}

export function hasAnySecrets(configs: StorageProviderConfig[]): boolean {
  return configs.some(
    (c) =>
      (c.type === 'github' && !!c.token.trim()) ||
      (c.type === 's3' && (!!c.accessKeyId.trim() || !!c.secretAccessKey.trim()))
  );
}

export function extractProviderSecrets(
  configs: StorageProviderConfig[]
): ProviderSecretsMap {
  const map: ProviderSecretsMap = {};
  for (const cfg of configs) {
    if (cfg.type === 'github' && cfg.token.trim()) {
      map[cfg.id] = { token: cfg.token.trim() };
    } else if (
      cfg.type === 's3' &&
      (cfg.accessKeyId.trim() || cfg.secretAccessKey.trim())
    ) {
      map[cfg.id] = {
        accessKeyId: cfg.accessKeyId.trim(),
        secretAccessKey: cfg.secretAccessKey.trim(),
      };
    }
  }
  return map;
}

export function stripProviderSecrets(
  configs: StorageProviderConfig[]
): StorageProviderConfig[] {
  return configs.map((cfg) => {
    if (cfg.type === 'github') {
      return { ...cfg, token: '' };
    }
    if (cfg.type === 's3') {
      return { ...cfg, accessKeyId: '', secretAccessKey: '' };
    }
    return cfg;
  });
}

export function mergeProviderSecrets(
  configs: StorageProviderConfig[],
  secrets: ProviderSecretsMap
): StorageProviderConfig[] {
  return configs.map((cfg) => {
    const sec = secrets[cfg.id];
    if (!sec) return cfg;
    if (cfg.type === 'github') {
      return { ...cfg, token: sec.token ?? cfg.token };
    }
    if (cfg.type === 's3') {
      return {
        ...cfg,
        accessKeyId: sec.accessKeyId ?? cfg.accessKeyId,
        secretAccessKey: sec.secretAccessKey ?? cfg.secretAccessKey,
      };
    }
    return cfg;
  });
}

/**
 * Loads stored provider configs from localStorage. Also detects any legacy
 * plaintext GitHub PAT / S3 secret keys from older versions so the UI can
 * prompt the user to encrypt them immediately.
 */
export function loadStoredProviders(): {
  configs: StorageProviderConfig[];
  hasLegacyPlaintextSecrets: boolean;
} {
  if (!hasLocalStorage()) {
    return { configs: [], hasLegacyPlaintextSecrets: false };
  }
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    if (!raw) return { configs: [], hasLegacyPlaintextSecrets: false };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { configs: [], hasLegacyPlaintextSecrets: false };
    }
    const configs = parsed as StorageProviderConfig[];
    const hasLegacyPlaintextSecrets = configs.some(
      (c) =>
        (c.type === 'github' && !!c.token?.trim()) ||
        (c.type === 's3' && !!c.secretAccessKey?.trim())
    );
    return { configs, hasLegacyPlaintextSecrets };
  } catch {
    return { configs: [], hasLegacyPlaintextSecrets: false };
  }
}

export function loadEncryptedCredentialsEnvelope(): EncryptedCredentialsEnvelope | null {
  if (!hasLocalStorage()) return null;
  try {
    const raw = localStorage.getItem(CREDENTIALS_ENC_KEY);
    if (!raw) return null;
    return validateCredentialsEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Persists non-secret provider metadata to localStorage and stores GitHub/S3
 * credentials ONLY inside an AES-256-GCM encrypted envelope. Never writes
 * plaintext PATs or S3 secret keys to localStorage or sessionStorage.
 */
export async function saveEncryptedProviderConfigs(
  configs: StorageProviderConfig[],
  unlockKey: CredentialUnlockKey | null
): Promise<EncryptedCredentialsEnvelope | null> {
  if (!hasLocalStorage()) return null;

  const stripped = stripProviderSecrets(configs);
  const secrets = extractProviderSecrets(configs);
  const hasSecrets = Object.keys(secrets).length > 0;

  if (hasSecrets && !unlockKey) {
    throw new Error(
      'Unlock or set a Credential Passphrase / Passkey before saving API credentials to this device.'
    );
  }

  // Clean up any legacy sessionStorage key
  if (hasSessionStorage()) {
    sessionStorage.removeItem(LEGACY_SESSION_SECRETS_KEY);
  }

  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(stripped));

  if (!hasSecrets) {
    localStorage.removeItem(CREDENTIALS_ENC_KEY);
    return null;
  }

  const envelope = await encryptCredentialsEnvelope(secrets, unlockKey!);
  localStorage.setItem(CREDENTIALS_ENC_KEY, JSON.stringify(envelope));
  return envelope;
}

/**
 * Updates non-secret provider metadata (e.g., reorder / toggle enabled) without
 * modifying an existing encrypted credentials envelope.
 */
export function saveProviderMetadataOnly(
  configs: StorageProviderConfig[]
): void {
  if (!hasLocalStorage()) return;
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(stripProviderSecrets(configs)));
}

export function clearEncryptedCredentialsEnvelope(): void {
  if (hasLocalStorage()) {
    localStorage.removeItem(CREDENTIALS_ENC_KEY);
  }
  if (hasSessionStorage()) {
    sessionStorage.removeItem(LEGACY_SESSION_SECRETS_KEY);
  }
}

/**
 * Completely removes all Obsync keys from localStorage and sessionStorage
 * (used for untrusted / public device In-Memory Only mode).
 */
export function purgeAllBrowserStorage(): void {
  if (hasLocalStorage()) {
    localStorage.removeItem(PROVIDERS_KEY);
    localStorage.removeItem(CREDENTIALS_ENC_KEY);
    localStorage.removeItem(PREFS_KEY);
  }
  if (hasSessionStorage()) {
    sessionStorage.removeItem(LEGACY_SESSION_SECRETS_KEY);
  }
}

export function loadPreferences(): AppPreferences {
  if (!hasLocalStorage()) return { ...DEFAULT_PREFS };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<AppPreferences>;
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      credentialStorage:
        parsed.credentialStorage === 'memory' ? 'memory' : 'encrypted',
      theme:
        typeof parsed.theme === 'string' &&
        (VALID_THEMES as readonly string[]).includes(parsed.theme)
          ? (parsed.theme as ObsyncTheme)
          : 'obsync',
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePreferences(prefs: AppPreferences): void {
  if (!hasLocalStorage()) return;
  // In-memory mode must leave zero trace in localStorage
  if (prefs.credentialStorage === 'memory') return;
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}
