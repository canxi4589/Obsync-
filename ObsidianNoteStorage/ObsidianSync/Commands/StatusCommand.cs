using System.CommandLine;
using ObsidianSync.Services;

namespace ObsidianSync.Commands;

public static class StatusCommand
{
    public static Command Build()
    {
        var cmd = new Command("status", "Show vault status and encrypted note inventory.");

        cmd.SetAction((ParseResult _) =>
        {
            var config = ConfigService.Load();
            var hasPassword = EncryptionService.HasPassword();

            Console.WriteLine($"Password stored : {(hasPassword ? "yes" : "NO — run: obsync init")}");
            Console.WriteLine($"Config          : {ConfigService.ConfigPath}");
            Console.WriteLine($"Vaults          : {config.Vaults.Count}");

            foreach (var vault in config.Vaults)
            {
                Console.WriteLine();
                Console.WriteLine($"  [{vault.Name}]  {vault.Path}");

                var privateDir = Path.Combine(vault.Path, vault.PrivateFolder);
                var encDir = Path.Combine(privateDir, ".encrypted");

                var localCount = Directory.Exists(privateDir)
                    ? Directory.GetFiles(privateDir, "*.md", SearchOption.TopDirectoryOnly).Length
                    : 0;
                var encCount = Directory.Exists(encDir)
                    ? Directory.GetFiles(encDir, "*.enc").Length
                    : 0;

                Console.WriteLine($"    Local private notes  : {localCount}");
                Console.WriteLine($"    Encrypted (in git)   : {encCount}");

                if (encCount > 0)
                {
                    foreach (var f in Directory.GetFiles(encDir, "*.enc"))
                        Console.WriteLine($"      • {Path.GetFileNameWithoutExtension(f)}");
                }

                if (localCount != encCount)
                    Console.WriteLine("    ⚠ Mismatch — run: obsync sync");
            }
        });

        return cmd;
    }
}
