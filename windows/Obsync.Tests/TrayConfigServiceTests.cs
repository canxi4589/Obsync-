using Obsync.Core.Models;
using Obsync.Core.Services;
using Xunit;

namespace Obsync.Tests;

public sealed class TrayConfigServiceTests : IDisposable
{
    private readonly string _tempDir;

    public TrayConfigServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"obsync-cfg-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_tempDir);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDir))
            Directory.Delete(_tempDir, recursive: true);
    }

    [Fact]
    public void SaveAndLoad_RoundTripsTrayConfig()
    {
        var cfgPath = Path.Combine(_tempDir, "tray-config.json");
        var service = new TrayConfigService(cfgPath, Path.Combine(_tempDir, "missing.json"));

        var input = new TrayConfig
        {
            AutoSyncIntervalMinutes = 30,
            WatchFileChanges = false,
            StartWithWindows = true,
            Vaults =
            [
                new VaultEntry
                {
                    Name = "Personal",
                    Path = @"C:\Vaults\Personal",
                    RemoteUrl = "https://github.com/u/v.git",
                    CommitMessage = "auto: {timestamp}",
                    Enabled = true
                }
            ]
        };

        service.Save(input);
        var loaded = service.Load();

        Assert.Equal(30, loaded.AutoSyncIntervalMinutes);
        Assert.False(loaded.WatchFileChanges);
        Assert.True(loaded.StartWithWindows);
        Assert.Single(loaded.Vaults);
        Assert.Equal("Personal", loaded.Vaults[0].Name);
        Assert.Equal(@"C:\Vaults\Personal", loaded.Vaults[0].Path);
    }

    [Fact]
    public void Load_MigratesLegacyCliConfigWhenTrayConfigMissing()
    {
        var cfgPath = Path.Combine(_tempDir, "tray-config.json");
        var legacyPath = Path.Combine(_tempDir, "config.json");

        File.WriteAllText(legacyPath, """
        {
          "vaults": [
            {
              "name": "LegacyVault",
              "path": "C:/Docs/MyVault",
              "remoteUrl": "https://github.com/alice/vault.git",
              "privateFolder": "private",
              "commitMessage": "sync: {timestamp}"
            }
          ]
        }
        """);

        var service = new TrayConfigService(cfgPath, legacyPath);
        var loaded = service.Load();

        Assert.Single(loaded.Vaults);
        Assert.Equal("LegacyVault", loaded.Vaults[0].Name);
        Assert.Equal("C:/Docs/MyVault", loaded.Vaults[0].Path);
        Assert.True(File.Exists(cfgPath));
    }
}
