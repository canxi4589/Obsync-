import type { AppPreferences, StorageProviderConfig } from './types';

const PROVIDERS_KEY = 'obsync.storage.providers.v1';
const PREFS_KEY = 'obsync.preferences.v1';

const DEFAULT_PREFS: AppPreferences = {
  autoLockMinutes: 10,
};

function hasStorage(): boolean {
  return typeof globalThis !== 'undefined' && 'localStorage' in globalThis && !!globalThis.localStorage;
}

export function loadProviderConfigs(): StorageProviderConfig[] {
  if (!hasStorage()) return [];
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StorageProviderConfig[]) : [];
  } catch {
    return [];
  }
}

export function saveProviderConfigs(configs: StorageProviderConfig[]): void {
  if (!hasStorage()) return;
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(configs));
}

export function loadPreferences(): AppPreferences {
  if (!hasStorage()) return { ...DEFAULT_PREFS };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<AppPreferences>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePreferences(prefs: AppPreferences): void {
  if (!hasStorage()) return;
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}
