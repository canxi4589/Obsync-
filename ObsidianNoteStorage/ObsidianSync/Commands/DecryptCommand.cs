using System.CommandLine;
using ObsidianSync.Services;

namespace ObsidianSync.Commands;

public static class DecryptCommand
{
    public static Command Build()
    {
        var fileArg = new Argument<string>("filename")
        {
            Description = "Name of the note to decrypt (e.g. passwords.md). Searches all vaults."
        };
        var vaultOpt = new Option<string?>("--vault") { Description = "Limit search to specific vault." };
        var outOpt = new Option<string?>("--out")
        {
            Description = "Output path for decrypted file. Defaults to restoring it to private/ folder."
        };
        var printOpt = new Option<bool>("--print") { Description = "Print decrypted content to stdout instead of writing file." };

        var cmd = new Command("decrypt", "Decrypt a private note.");
        cmd.Arguments.Add(fileArg);
        cmd.Options.Add(vaultOpt);
        cmd.Options.Add(outOpt);
        cmd.Options.Add(printOpt);

        cmd.SetAction((ParseResult r) =>
        {
            var filename = r.GetValue(fileArg)!;
            var vaultName = r.GetValue(vaultOpt);
            var outPath = r.GetValue(outOpt);
            var print = r.GetValue(printOpt);

            if (print && outPath is not null)
                Console.WriteLine("Warning: --out is ignored when --print is used.");

            var password = EncryptionService.GetPassword();
            if (password is null)
            {
                Console.Error.WriteLine("No password set. Run: obsync init");
                return 1;
            }

            var config = ConfigService.Load();
            var vaults = vaultName is null
                ? config.Vaults
                : config.Vaults.Where(v => v.Name.Equals(vaultName!, StringComparison.OrdinalIgnoreCase)).ToList();

            var baseName = filename.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
                ? filename
                : filename + ".md";
            var encName = baseName + ".enc";

            var matches = vaults
                .Select(v => (vault: v, encPath: Path.Combine(v.Path, v.PrivateFolder, ".encrypted", encName)))
                .Where(x => File.Exists(x.encPath))
                .ToList();

            if (matches.Count == 0)
            {
                Console.Error.WriteLine($"'{baseName}' not found in encrypted storage.");
                return 1;
            }

            if (matches.Count > 1)
            {
                Console.Error.WriteLine($"'{baseName}' found in multiple vaults — use --vault to specify:");
                foreach (var (v, _) in matches)
                    Console.Error.WriteLine($"  {v.Name}");
                return 1;
            }

            var (vault, encPath) = matches[0];
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
                return 0;
            }
            catch (System.Security.Cryptography.CryptographicException)
            {
                Console.Error.WriteLine("Decryption failed — wrong password or corrupted file.");
                return 1;
            }
        });

        return cmd;
    }
}
