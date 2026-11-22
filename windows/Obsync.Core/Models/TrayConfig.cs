namespace Obsync.Core.Models;

public sealed class TrayConfig
{
    public List<VaultEntry> Vaults { get; set; } = [];
    public int AutoSyncIntervalMinutes { get; set; } = 15;
    public bool WatchFileChanges { get; set; } = true;
    public bool StartWithWindows { get; set; }
}

public sealed class VaultEntry
{
    public string Name { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public string? RemoteUrl { get; set; }
    public string CommitMessage { get; set; } = "sync: {timestamp}";
    public bool Enabled { get; set; } = true;
    public DateTime? LastSyncUtc { get; set; }
    public string? LastStatus { get; set; }
}
