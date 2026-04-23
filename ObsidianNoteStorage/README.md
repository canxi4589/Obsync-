# ObsidianSync

Personal CLI tool. Encrypts private Obsidian notes and pushes vaults to GitHub via git.

## How it works

- Notes inside `private/` stay local, gitignored
- On sync: each `.md` in `private/` gets AES-encrypted to `private/.encrypted/*.md.enc`
- Encrypted files commit and push to GitHub — plaintext never leaves machine
- Password stored via Windows DPAPI (no plain-text secrets)

## Setup

**1. Build**

```
dotnet publish -c Release
```

Add the output folder to PATH, or call the exe directly.

**2. Init — set master password**

```
obsync init
```

Creates config at `%APPDATA%\ObsidianSync\config.json`.

**3. Add vault**

```
obsync vault add <name> <path>
obsync vault add my-vault "C:\Users\you\Documents\MyVault" --remote https://github.com/you/my-vault.git
```

**4. Sync**

```
obsync sync
```

## Commands

| Command | Description |
|---|---|
| `obsync init` | Set or update master password |
| `obsync sync` | Encrypt private notes and push all vaults |
| `obsync sync --vault <name>` | Sync one vault |
| `obsync sync --force` | Commit even if no changes |
| `obsync status` | Show vault state and encrypted note inventory |
| `obsync list` | Tree view of vault contents with sync status |
| `obsync list --all` | Include all folders, not just private |
| `obsync decrypt <note.md>` | Restore encrypted note to private/ |
| `obsync decrypt <note.md> --print` | Print decrypted content to stdout |
| `obsync vault add <name> <path>` | Register vault |
| `obsync vault list` | List registered vaults |
| `obsync vault remove <name>` | Remove vault from config |

## Config file

Location: `%APPDATA%\ObsidianSync\config.json`

```json
{
  "vaults": [
    {
      "name": "my-vault",
      "path": "C:/Users/you/Documents/MyVault",
      "remoteUrl": "https://github.com/you/my-vault.git",
      "privateFolder": "private",
      "commitMessage": "sync: {timestamp}"
    }
  ]
}
```

`remoteUrl` is optional if the vault already has a git remote configured.

## Auto-sync via Task Scheduler

```powershell
.\ObsidianSync\setup-scheduler.ps1 -ExePath "C:\path\to\obsync.exe"
```

Runs `obsync sync` daily at midnight. Optional: `-TriggerTime "06:00"`.

## Requirements

- Windows (DPAPI used for password storage)
- Windows task scheduler
- .NET 9
- Git installed and on PATH
