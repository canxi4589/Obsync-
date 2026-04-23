using System.CommandLine;
using ObsidianSync.Models;
using ObsidianSync.Services;

namespace ObsidianSync.Commands;

public static class SyncCommand
{
    public static Command Build()
    {
        var vaultOpt = new Option<string?>("--vault") { Description = "Vault name to sync (omit to sync all)." };
        var forceOpt = new Option<bool>("--force") { Description = "Commit even if no changes detected." };

        var cmd = new Command("sync", "Encrypt private notes and push all vaults to GitHub.");
        cmd.Options.Add(vaultOpt);
        cmd.Options.Add(forceOpt);

        cmd.SetAction((ParseResult r) =>
        {
            var vaultName = r.GetValue(vaultOpt);
            var force = r.GetValue(forceOpt);

            var password = EncryptionService.GetPassword();
            if (password is null)
            {
                Console.Error.WriteLine("No password set. Run: obsync init");
                return 1;
            }

            var config = ConfigService.Load();
            var vaults = vaultName is null
                ? config.Vaults
                : config.Vaults
                    .Where(v => v.Name.Equals(vaultName, StringComparison.OrdinalIgnoreCase))
                    .ToList();

            if (vaults.Count == 0)
            {
                Console.Error.WriteLine(vaultName is null
                    ? "No vaults configured. Run: obsync vault add"
                    : $"Vault '{vaultName}' not found.");
                return 1;
            }

            foreach (var vault in vaults)
                SyncVault(vault, password, force);

            return 0;
        });

        return cmd;
    }

    private static void SyncVault(VaultConfig vault, string password, bool force)
    {
        Console.WriteLine($"\n── Syncing [{vault.Name}] ──────────────────────────");

        if (!Directory.Exists(vault.Path))
        {
            Console.Error.WriteLine($"  Vault path missing: {vault.Path}");
            return;
        }

        var privateDir = Path.Combine(vault.Path, vault.PrivateFolder);
        var encDir = Path.Combine(privateDir, ".encrypted");

        if (Directory.Exists(privateDir))
        {
            Directory.CreateDirectory(encDir);

            var mdFiles = Directory.GetFiles(privateDir, "*.md", SearchOption.TopDirectoryOnly);
            if (mdFiles.Length > 0)
            {
                Console.WriteLine($"  Encrypting {mdFiles.Length} private note(s)...");
                foreach (var src in mdFiles)
                {
                    var dest = Path.Combine(encDir, Path.GetFileName(src) + ".enc");
                    EncryptionService.EncryptFile(src, dest, password);
                    Console.WriteLine($"    + {Path.GetFileName(src)}");
                }
            }
            else
            {
                Console.WriteLine("  No private notes to encrypt.");
            }

            // Remove .enc files that no longer have a source
            foreach (var enc in Directory.GetFiles(encDir, "*.enc"))
            {
                var originalName = Path.GetFileNameWithoutExtension(enc); // strips .enc
                var sourcePath = Path.Combine(privateDir, originalName);
                if (!File.Exists(sourcePath))
                {
                    File.Delete(enc);
                    Console.WriteLine($"    - Removed orphan: {Path.GetFileName(enc)}");
                }
            }
        }

        GitService.EnsureGitignoreEntry(vault.Path, vault.PrivateFolder);

        if (!force && !GitService.HasChanges(vault.Path))
        {
            Console.WriteLine("  No changes detected — skipping commit.");
            return;
        }

        var message = vault.CommitMessage.Replace("{timestamp}",
            DateTime.Now.ToString("yyyy-MM-dd HH:mm"));

        GitService.CommitAndPush(vault.Path, message, vault.RemoteUrl);
    }
}
