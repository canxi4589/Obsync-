using System.Text.Json;
using Obsync.Core.Models;

namespace Obsync.Core.Services;

public sealed class TrayConfigService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    private readonly object _saveLock = new();

    public string ConfigPath { get; }
    public string LegacyConfigPath { get; }

    public TrayConfigService(string? configPath = null, string? legacyConfigPath = null)
    {
        var appData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "ObsidianSync");

        ConfigPath = configPath ?? Path.Combine(appData, "tray-config.json");
        LegacyConfigPath = legacyConfigPath ?? Path.Combine(appData, "config.json");
    }

    public TrayConfig Load()
    {
        if (File.Exists(ConfigPath))
        {
            try
            {
                var json = File.ReadAllText(ConfigPath);
                if (!string.IsNullOrWhiteSpace(json))
                {
                    return JsonSerializer.Deserialize<TrayConfig>(json, JsonOptions) ?? new TrayConfig();
                }
            }
            catch (Exception ex) when (ex is JsonException or IOException)
            {
                // Preserve corrupted config for diagnostics and recover gracefully instead of crashing
                try
                {
                    File.Copy(ConfigPath, ConfigPath + ".corrupt", overwrite: true);
                }
                catch
                {
                }
                return new TrayConfig();
            }
        }

        // Auto-migrate vaults from legacy CLI config.json if present
        if (File.Exists(LegacyConfigPath))
        {
            try
            {
                var legacyJson = File.ReadAllText(LegacyConfigPath);
                var legacy = JsonSerializer.Deserialize<LegacyAppConfig>(legacyJson, JsonOptions);
                if (legacy?.Vaults is { Count: > 0 })
                {
                    var migrated = new TrayConfig
                    {
                        Vaults = legacy.Vaults.Select(v => new VaultEntry
                        {
                            Name = v.Name,
                            Path = v.Path,
                            RemoteUrl = v.RemoteUrl,
                            CommitMessage = string.IsNullOrWhiteSpace(v.CommitMessage)
                                ? "sync: {timestamp}"
                                : v.CommitMessage,
                            Enabled = true
                        }).ToList()
                    };
                    Save(migrated);
                    return migrated;
                }
            }
            catch
            {
                // Ignore malformed legacy config and fall back to fresh TrayConfig
            }
        }

        return new TrayConfig();
    }

    public void Save(TrayConfig config)
    {
        lock (_saveLock)
        {
            var dir = Path.GetDirectoryName(ConfigPath);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }

            var tmpPath = $"{ConfigPath}.{Guid.NewGuid():N}.tmp";
            var json = JsonSerializer.Serialize(config, JsonOptions);
            File.WriteAllText(tmpPath, json);
            File.Move(tmpPath, ConfigPath, overwrite: true);
        }
    }

    private sealed class LegacyAppConfig
    {
        public List<LegacyVaultConfig> Vaults { get; set; } = [];
    }

    private sealed class LegacyVaultConfig
    {
        public string Name { get; set; } = string.Empty;
        public string Path { get; set; } = string.Empty;
        public string? RemoteUrl { get; set; }
        public string CommitMessage { get; set; } = "sync: {timestamp}";
    }
}
