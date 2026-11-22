export type ProviderType = 'github' | 'gdrive' | 'local' | 's3';

export class AuthExpiredError extends Error {
  constructor(message = 'Provider authentication expired or permission required.') {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

export interface FileEntry {
  path: string;
  size?: number;
  etag?: string;
  updatedAt?: string;
}

export interface ReadResult {
  data: Uint8Array<ArrayBuffer>;
  etag?: string;
}

export interface BaseProviderConfig {
  id: string;
  type: ProviderType;
  label: string;
  enabled: boolean;
  mirrorWrites: boolean;
}

export interface GitHubProviderConfig extends BaseProviderConfig {
  type: 'github';
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export interface GoogleDriveProviderConfig extends BaseProviderConfig {
  type: 'gdrive';
  clientId: string;
  accountEmail?: string;
  folderName: string;
  rootFolderId?: string;
}

export interface LocalProviderConfig extends BaseProviderConfig {
  type: 'local';
  folderName: string;
}

export interface S3ProviderConfig extends BaseProviderConfig {
  type: 's3';
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type StorageProviderConfig =
  | GitHubProviderConfig
  | GoogleDriveProviderConfig
  | LocalProviderConfig
  | S3ProviderConfig;

export interface StorageProvider {
  readonly id: string;
  readonly type: ProviderType;
  readonly label: string;
  testConnection(): Promise<{ ok: boolean; details: string }>;
  list(prefix?: string): Promise<FileEntry[]>;
  read(path: string): Promise<ReadResult | null>;
  write(path: string, data: Uint8Array, message?: string): Promise<void>;
  delete(path: string, message?: string): Promise<void>;
}

export interface PendingMirrorOp {
  id: string; // `${providerId}::${path}`
  providerId: string;
  op: 'write' | 'delete';
  path: string;
  data?: Uint8Array;
  message?: string;
  createdAt: string;
  lastError?: string;
}

export type ProviderHealthState = 'idle' | 'ok' | 'auth-expired' | 'error';

export interface ProviderRuntimeStatus {
  providerId: string;
  state: ProviderHealthState;
  lastSuccessAt?: string;
  lastError?: string;
  pendingOps: number;
}

export interface ManagedListResult {
  entries: FileEntry[];
  sourceProviderId: string;
  sourceLabel: string;
  usedFallback: boolean;
  warnings: string[];
}

export interface ManagedReadResult {
  data: Uint8Array<ArrayBuffer> | null;
  etag?: string;
  sourceProviderId: string;
  sourceLabel: string;
  usedFallback: boolean;
  warnings: string[];
}

export interface MirrorSummary {
  primaryWrittenProviderId: string;
  primaryWrittenLabel: string;
  usedFallback: boolean;
  mirroredTo: string[];
  queuedFor: { providerId: string; label: string; reason: string }[];
}

export type CredentialStorageMode = 'encrypted' | 'memory';

export type ObsyncTheme = 'obsync' | 'night' | 'dracula' | 'dim' | 'nord' | 'light';

export interface AppPreferences {
  autoLockMinutes: number;
  defaultGoogleClientId?: string;
  credentialStorage: CredentialStorageMode;
  theme?: ObsyncTheme;
}
