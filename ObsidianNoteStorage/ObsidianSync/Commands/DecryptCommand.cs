using System.CommandLine;
using ObsidianSync.Services;

namespace ObsidianSync.Commands;

public static class DecryptCommand
{
    public static Command Build()
    {
        var fileArg = new Argument<string>("filename",
            "Name of the note to decrypt (e.g. passwords.md). Searches all vaults.");
        var vaultOpt = new Option<string?>("--vault", "Limit search to specific vault.");
        var outOpt = new Option<string?>("--out",
            "Output path for decrypted file. Defaults to restoring it to private/ folder.");
        var printOpt = new Option<bool>("--print", "Print decrypted content to stdout instead of writing file.");

        var cmd = new Command("decrypt", "Decrypt a private note.")
        {
            fileArg, vaultOpt, outOpt, printOpt
        };

        cmd.SetHandler((filename, vaultName, outPath, print) =>
        {
            var password = EncryptionService.GetPassword();
            if (password is null)
            {
                Console.Error.WriteLine("No password set. Run: obsync init");
                return;
            }

            var config = ConfigService.Load();
            var vaults = vaultName is null
                ? config.Vaults
                : config.Vaults.Where(v => v.Name.Equals(vaultName, StringComparison.OrdinalIgnoreCase)).ToList();

            // Normalize — user may or may not include .md
            var baseName = filename.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
                ? filename
                : filename + ".md";
            var encName = baseName + ".enc";

            bool found = false;
            foreach (var vault in vaults)
            {
                var encPath = Path.Combine(vault.Path, vault.PrivateFolder, ".encrypted", encName);
                if (!File.Exists(encPath)) continue;

                found = true;
                Console.WriteLine($"Found in [{vault.Name}]");

                try
                {
                    if (print)
                    {
                        var bytes = File.ReadAllBytes(encPath);
                        var plain = EncryptionService.Decrypt(bytes, password);
                        Console.WriteLine(System.Text.Encoding.UTF8.GetString(plain));
                    }
                    else
                    {
                        var dest = outPath ?? Path.Combine(vault.Path, vault.PrivateFolder, baseName);
                        EncryptionService.DecryptFile(encPath, dest, password);
                        Console.WriteLine($"Decrypted → {dest}");
                    }
                }
                catch (System.Security.Cryptography.CryptographicException)
                {
                    Console.Error.WriteLine("Decryption failed — wrong password or corrupted file.");
                }
                break;
            }

            if (!found)
                Console.Error.WriteLine($"'{baseName}' not found in encrypted storage.");

        }, fileArg, vaultOpt, outOpt, printOpt);

        return cmd;
    }
}
