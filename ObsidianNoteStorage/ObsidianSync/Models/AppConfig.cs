namespace ObsidianSync.Models;

public class AppConfig
{
    public List<VaultConfig> Vaults { get; set; } = [];
}

public class VaultConfig
{
    public string Name { get; set; } = "";
    public string Path { get; set; } = "";
    /// <summary>Optional — override remote URL. If empty, uses existing git remote.</summary>
    public string? RemoteUrl { get; set; }
    /// <summary>Subfolder name within the vault that holds sensitive notes.</summary>
    public string PrivateFolder { get; set; } = "private";
    public string CommitMessage { get; set; } = "sync: {timestamp}";
}
