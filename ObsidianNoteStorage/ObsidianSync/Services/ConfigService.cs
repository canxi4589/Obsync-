using System.Text.Json;
using ObsidianSync.Models;

namespace ObsidianSync.Services;

public static class ConfigService
{
    private static readonly string ConfigDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ObsidianSync");

    public static string ConfigPath => Path.Combine(ConfigDir, "config.json");

    public static bool ConfigExists => File.Exists(ConfigPath);

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    /// <summary>
    /// Prints an error with the expected config path and exits with code 1
    /// if the config file does not exist. Call this for commands that require
    /// an initialised config (everything except <c>init</c> and <c>vault add</c>).
    /// </summary>
    public static void AssertExists()
    {
        if (!File.Exists(ConfigPath))
        {
            Console.Error.WriteLine($"Config file not found at: {ConfigPath}");
            Console.Error.WriteLine();
            Console.Error.WriteLine("Expected file: config.json");
            Console.Error.WriteLine("Sample contents:");
            Console.Error.WriteLine("  {");
            Console.Error.WriteLine("    \"vaults\": [");
            Console.Error.WriteLine("      {");
            Console.Error.WriteLine("        \"name\": \"my-vault\",");
            Console.Error.WriteLine("        \"path\": \"C:/Users/you/Documents/MyVault\",");
            Console.Error.WriteLine("        \"remoteUrl\": \"https://github.com/you/my-vault.git\",");
            Console.Error.WriteLine("        \"privateFolder\": \"private\",");
            Console.Error.WriteLine("        \"commitMessage\": \"sync: {timestamp}\"");
            Console.Error.WriteLine("      }");
            Console.Error.WriteLine("    ]");
            Console.Error.WriteLine("  }");
            Console.Error.WriteLine();
            Console.Error.WriteLine("Run 'obsync init' to set up ObsidianSync, then 'obsync vault add' to register a vault.");
            Environment.Exit(1);
        }
    }

    public static AppConfig Load()
    {
        if (!File.Exists(ConfigPath))
            return new AppConfig();

        try
        {
            var json = File.ReadAllText(ConfigPath);
            if (string.IsNullOrWhiteSpace(json))
                return new AppConfig();
            return JsonSerializer.Deserialize<AppConfig>(json, JsonOpts) ?? new AppConfig();
        }
        catch (JsonException ex)
        {
            Console.Error.WriteLine($"Config file is malformed: {ex.Message}");
            Console.Error.WriteLine($"Fix or delete: {ConfigPath}");
            Environment.Exit(1);
            return new AppConfig(); // unreachable — satisfies compiler
        }
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
