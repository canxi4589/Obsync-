using System.Text.Json;
using ObsidianSync.Models;

namespace ObsidianSync.Services;

public static class ConfigService
{
    private static readonly string ConfigDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ObsidianSync");

    public static string ConfigPath => Path.Combine(ConfigDir, "config.json");

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static AppConfig Load()
    {
        if (!File.Exists(ConfigPath))
            return new AppConfig();

        var json = File.ReadAllText(ConfigPath);
        return JsonSerializer.Deserialize<AppConfig>(json, JsonOpts) ?? new AppConfig();
    }

    public static void Save(AppConfig config)
    {
        Directory.CreateDirectory(ConfigDir);
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(config, JsonOpts));
    }

    public static VaultConfig? GetVault(AppConfig config, string? name)
    {
        if (config.Vaults.Count == 0)
        {
            Console.Error.WriteLine("No vaults configured. Run: obsync vault add");
            return null;
        }

        if (name is null)
        {
            if (config.Vaults.Count == 1)
                return config.Vaults[0];

            Console.Error.WriteLine("Multiple vaults — specify with --vault <name>. Vaults:");
            foreach (var v in config.Vaults)
                Console.Error.WriteLine($"  {v.Name}  ({v.Path})");
            return null;
        }

        var match = config.Vaults.FirstOrDefault(v =>
            v.Name.Equals(name, StringComparison.OrdinalIgnoreCase));

        if (match is null)
            Console.Error.WriteLine($"Vault '{name}' not found.");

        return match;
    }
}
