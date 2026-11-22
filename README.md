# Obsync — Zero-Knowledge Obsidian Notes (iPhone + Windows)

**Obsync** lets you read, create, and edit both **public Obsidian notes** and a **password-locked private vault** across **iPhone** and **Windows**, with **no single cloud lock-in**:

- **Obsync PWA (`obsync-web/`)** — Mobile-first Progressive Web App for **iPhone** (*Add to Home Screen*) and **Windows** (*Install App* / browser).
- **Zero-Knowledge Private Vault (`.obsync-vault/`)** — Platform-independent AES-256-GCM encryption (Web Crypto API) with hidden filenames, zero plaintext on disk, and a one-time **Recovery Key** in case you forget your password.
- **Multi-Provider Storage & Fallback Order** — Connect **GitHub**, **multiple Google Drive accounts**, a **Local Disk Folder**, or **S3 / Cloudflare R2 / MinIO**. Choose your **Primary** and ordered **Fallbacks** with automatic failover reads, background write mirroring, IndexedDB offline cache, and encrypted `.zip` backup.
- **Obsync Tray (`windows/Obsync.Tray`)** — Lightweight Windows System Tray app that auto-syncs your local Obsidian vault folders via two-way `git pull --rebase` + `git push` (replaces the old CLI and Task Scheduler script).

---

## Security & Encryption Model

- **Key Wrapping (DEK / KEK):**
  - On vault creation, Obsync generates a random 256-bit **Data Encryption Key (DEK)**.
  - Your **Master Password** derives a Key-Encryption Key (KEK) via **PBKDF2-HMAC-SHA256 (600,000 iterations, random 16-byte salt)** to wrap the DEK inside `.obsync-vault/vault.json`.
  - A one-time **Recovery Key** (`OBSYNC-XXXX-...`, 160-bit entropy) wraps a second copy of the DEK inside `vault.json`.
- **Hidden Filenames & Zero Plaintext on Disk:**
  - Encrypted note titles, folder paths, and timestamps live in `.obsync-vault/index.enc`.
  - Encrypted note contents live in `.obsync-vault/notes/<uuid>.enc` (`[version 1B][nonce 12B][AES-GCM ciphertext + 16B tag]`).
  - Your password is **never saved** anywhere (not on disk, not in `localStorage`, not on GitHub/Drive). Unlocking keeps the DEK only in memory until you click **Lock** or the idle timeout expires.
- **Forgot Password?**
  - Click **Forgot password? Use Recovery Key** on the lock screen, enter your saved Recovery Key, and set a new master password without losing any notes.
- **Legacy CLI Migration:**
  - Once unlocked, open **Private → Settings (gear icon) → Import Legacy CLI Notes** to decrypt and import existing `private/.encrypted/*.md.enc` files created by the older Windows CLI.

---

## 1. Obsync PWA (`obsync-web/`)

### Run Locally
Requires **Node.js 22+**:

```bash
cd obsync-web
npm install
npm run dev
```

Run checks and production build:

```bash
npm run typecheck
npm test
npm run build
```

### Deploy Free to GitHub Pages (HTTPS required for iPhone PWA)
1. Push this repository to GitHub on branch `main`.
2. In your GitHub repo settings, go to **Settings → Pages → Source** and select **GitHub Actions**.
3. The included workflow [`.github/workflows/deploy-pwa.yml`](.github/workflows/deploy-pwa.yml) automatically builds `obsync-web/` and deploys `obsync-web/dist`.
4. Open the GitHub Pages URL on your **iPhone in Safari → Share → Add to Home Screen** (or in Chrome/Edge on Windows → **Install Obsync**).

---

## 2. Setting Up Storage Providers & Fallbacks

Open **Storage & Backup** inside Obsync and click **Add Provider**. Use the ▲ / ▼ arrows to set **PRIMARY**, **FALLBACK #1**, **FALLBACK #2**, etc.

### GitHub
1. Create a **Fine-Grained Personal Access Token** in GitHub (**Settings → Developer settings → Personal access tokens → Fine-grained tokens**).
2. Restrict it **only** to your Obsidian vault repository with permission **Contents: Read and write**.
3. Enter your GitHub username, repo name, branch (`main`), and token in Obsync.

### Google Drive (Multiple Accounts Supported)
1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Configure **OAuth consent screen** (External → add your Google emails as **Test users** while in testing mode) and add scope `https://www.googleapis.com/auth/drive.file`.
3. Create an **OAuth Client ID** of type **Web application**, adding your PWA origin (e.g., `https://<username>.github.io` and `http://localhost:5173`) under **Authorized JavaScript origins**.
4. In Obsync, add as many Google accounts as you want using that Client ID. Each account stores encrypted files inside its own `ObsyncVault` folder.
   - *Note:* Static browser OAuth tokens expire after ~1 hour; tap **Reconnect** in Settings to refresh a Drive session and sync any queued fallback writes.

### Local Disk Folder (Windows / Mac Desktop)
- Uses the browser File System Access API (Chrome / Edge) to read and write directly to your Obsidian folder on disk. Private notes stay encrypted inside `.obsync-vault/`.

### Cloudflare R2 / AWS S3 / MinIO
- Enter endpoint URL, region (`auto` for R2), bucket name, and Access Key / Secret Key (signed locally via AWS SigV4 in Web Crypto). Make sure bucket CORS allows `GET`, `PUT`, `DELETE` from your PWA origin.

---

## 3. Windows Tray Auto-Syncer (`windows/Obsync.Tray`)

A lightweight Windows background tray app that keeps your local Obsidian vault folder (public `.md` files and `.obsync-vault/`) synced with GitHub via two-way `git pull --rebase --autostash` and `git push`.

### Build & Test (.NET 9 SDK required)

```powershell
dotnet build Obsync.sln -c Release
dotnet test Obsync.sln -c Release
```

### Run / Publish

```powershell
dotnet publish windows/Obsync.Tray/Obsync.Tray.csproj -c Release -r win-x64 --self-contained false
```

- Right-click the tray icon for **Sync Now**, **Vaults** (quick-open folder), **Settings...**, **Start with Windows**, and **Exit**.
- Existing vaults from the legacy CLI (`%APPDATA%\ObsidianSync\config.json`) are automatically imported into `%APPDATA%\ObsidianSync\tray-config.json`.
- If a remote merge conflict occurs during `git pull --rebase`, the tray app safely runs `git rebase --abort` so your vault is never left wedged and displays a warning notification.
