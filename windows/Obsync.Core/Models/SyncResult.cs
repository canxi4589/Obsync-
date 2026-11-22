namespace Obsync.Core.Models;

public sealed record SyncResult(
    string VaultName,
    bool Success,
    bool HadChanges,
    bool HadConflict,
    string Summary,
    string? ErrorDetails = null
);
