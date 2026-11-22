using System.Diagnostics;
using Obsync.Core.Models;
using Obsync.Core.Services;
using Xunit;

namespace Obsync.Tests;

public sealed class GitSyncServiceTests : IDisposable
{
    private readonly string _tempDir;
    private readonly string _gitExe;
    private readonly GitSyncService _syncService;

    public GitSyncServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"obsync-git-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_tempDir);
        _gitExe = GitSyncService.ResolveGitExecutable();
        _syncService = new GitSyncService(_gitExe);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_tempDir))
                Directory.Delete(_tempDir, recursive: true);
        }
        catch
        {
            // Ignore locked git pack files on Windows temp cleanup
        }
    }

    private (string BareRemote, string CloneA, string CloneB) SetupRepoPair()
    {
        var bare = Path.Combine(_tempDir, "remote.git");
        var cloneA = Path.Combine(_tempDir, "cloneA");
        var cloneB = Path.Combine(_tempDir, "cloneB");

        RunGit(_tempDir, "init", "--bare", "--initial-branch=main", bare);
        RunGit(_tempDir, "clone", bare, cloneA);
        ConfigureUser(cloneA);
        RunGit(cloneA, "checkout", "-b", "main");
        File.WriteAllText(Path.Combine(cloneA, "README.md"), "# Seed\n");
        RunGit(cloneA, "add", ".");
        RunGit(cloneA, "commit", "-m", "initial");
        RunGit(cloneA, "push", "-u", "origin", "main");

        RunGit(_tempDir, "clone", bare, cloneB);
        ConfigureUser(cloneB);

        return (bare, cloneA, cloneB);
    }

    private void ConfigureUser(string dir)
    {
        RunGit(dir, "config", "user.email", "test@obsync.local");
        RunGit(dir, "config", "user.name", "Obsync Test");
    }

    private void RunGit(string dir, params string[] args)
    {
        var psi = new ProcessStartInfo(_gitExe)
        {
            WorkingDirectory = dir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var proc = Process.Start(psi)!;
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit();
        if (proc.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"git {string.Join(' ', args)} failed ({proc.ExitCode}): {stderr}\n{stdout}");
        }
    }

    [Fact]
    public async Task TwoWaySync_RebasesNonConflictingChangesAndPreservesEncryptedVault()
    {
        var (_, cloneA, cloneB) = SetupRepoPair();

        // Clone B (simulating iPhone PWA) pushes an encrypted vault + note
        var encDirB = Path.Combine(cloneB, ".obsync-vault", "notes");
        Directory.CreateDirectory(encDirB);
        var encBytes = new byte[] { 1, 2, 3, 4, 250, 251, 252, 253 };
        await File.WriteAllTextAsync(Path.Combine(cloneB, ".obsync-vault", "vault.json"), """{"version":1}""");
        await File.WriteAllBytesAsync(Path.Combine(encDirB, "note-uuid.enc"), encBytes);
        await File.WriteAllTextAsync(Path.Combine(cloneB, "from-iphone.md"), "Hello from iPhone");
        RunGit(cloneB, "add", ".");
        RunGit(cloneB, "commit", "-m", "iphone edit");
        RunGit(cloneB, "push");

        // Clone A (simulating Windows Obsidian) edits a different public note locally
        await File.WriteAllTextAsync(Path.Combine(cloneA, "from-windows.md"), "Hello from Windows");

        var res = await _syncService.SyncVaultAsync(new VaultEntry
        {
            Name = "TestVault",
            Path = cloneA,
            CommitMessage = "sync: {timestamp}"
        });

        Assert.True(res.Success, res.ErrorDetails);
        Assert.False(res.HadConflict);
        Assert.True(res.HadChanges);

        // Clone A should now have both its own note AND the iPhone files + intact binary .enc
        Assert.True(File.Exists(Path.Combine(cloneA, "from-windows.md")));
        Assert.True(File.Exists(Path.Combine(cloneA, "from-iphone.md")));
        Assert.Equal(encBytes, await File.ReadAllBytesAsync(Path.Combine(cloneA, ".obsync-vault", "notes", "note-uuid.enc")));

        // Pull on Clone B and verify Windows note reached the bare remote
        RunGit(cloneB, "pull", "--rebase");
        Assert.True(File.Exists(Path.Combine(cloneB, "from-windows.md")));
    }

    [Fact]
    public async Task TwoWaySync_AbortsRebaseCleanlyOnConflict()
    {
        var (_, cloneA, cloneB) = SetupRepoPair();

        await File.WriteAllTextAsync(Path.Combine(cloneB, "shared.md"), "Line 1 from B\n");
        RunGit(cloneB, "add", "shared.md");
        RunGit(cloneB, "commit", "-m", "edit B");
        RunGit(cloneB, "push");

        await File.WriteAllTextAsync(Path.Combine(cloneA, "shared.md"), "Line 1 from A\n");

        var res = await _syncService.SyncVaultAsync(new VaultEntry
        {
            Name = "ConflictVault",
            Path = cloneA
        });

        Assert.False(res.Success);
        Assert.True(res.HadConflict);

        // Repo must NOT be left in a half-rebased state
        Assert.False(Directory.Exists(Path.Combine(cloneA, ".git", "rebase-merge")));
        Assert.False(Directory.Exists(Path.Combine(cloneA, ".git", "rebase-apply")));
    }

    [Fact]
    public async Task TwoWaySync_CleanUpToDateRepo_ReturnsUpToDateWithoutChanges()
    {
        var (_, cloneA, _) = SetupRepoPair();

        var res = await _syncService.SyncVaultAsync(new VaultEntry
        {
            Name = "CleanVault",
            Path = cloneA
        });

        Assert.True(res.Success, res.ErrorDetails);
        Assert.False(res.HadConflict);
        Assert.False(res.HadChanges);
        Assert.Equal("Already up to date.", res.Summary);
    }

    [Fact]
    public void TryValidateRemoteUrl_BlocksArgumentInjectionAndDangerousSchemes()
    {
        Assert.True(GitSyncService.TryValidateRemoteUrl("https://github.com/alice/vault.git", out _));
        Assert.True(GitSyncService.TryValidateRemoteUrl("ssh://git@github.com/alice/vault.git", out _));
        Assert.True(GitSyncService.TryValidateRemoteUrl("git@github.com:alice/vault.git", out _));

        Assert.False(GitSyncService.TryValidateRemoteUrl("--upload-pack=calc.exe", out _));
        Assert.False(GitSyncService.TryValidateRemoteUrl("-u", out _));
        Assert.False(GitSyncService.TryValidateRemoteUrl("ext::sh -c calc", out _));
        Assert.False(GitSyncService.TryValidateRemoteUrl("file:///C:/Windows/System32", out _));
        Assert.False(GitSyncService.TryValidateRemoteUrl("http://insecure.example.com/repo.git", out _));
        Assert.False(GitSyncService.TryValidateRemoteUrl("https://github.com/a b.git", out _));
    }

    [Fact]
    public void RedactCredentials_MasksEmbeddedUrlTokens()
    {
        var raw = "fatal: unable to access 'https://alice:github_pat_secret123@github.com/alice/vault.git/': 403";
        var redacted = GitSyncService.RedactCredentials(raw);
        Assert.DoesNotContain("github_pat_secret123", redacted);
        Assert.Contains("https://***@github.com/alice/vault.git/", redacted);
    }

    [Fact]
    public async Task TwoWaySync_ExcludesRecoveryKeyAndEnvFilesFromAutoCommit()
    {
        var (_, cloneA, cloneB) = SetupRepoPair();

        await File.WriteAllTextAsync(Path.Combine(cloneA, "normal-note.md"), "# Safe Note");
        await File.WriteAllTextAsync(Path.Combine(cloneA, "obsync-recovery-key.txt"), "OBSYNC-SECRET-KEY");
        await File.WriteAllTextAsync(Path.Combine(cloneA, ".env"), "API_KEY=supersecret");

        var res = await _syncService.SyncVaultAsync(new VaultEntry
        {
            Name = "SecretGuardVault",
            Path = cloneA
        });

        Assert.True(res.Success, res.ErrorDetails);
        Assert.True(res.HadChanges);

        // Pull on Clone B: normal note arrived, but recovery key & .env were never committed/pushed
        RunGit(cloneB, "pull", "--rebase");
        Assert.True(File.Exists(Path.Combine(cloneB, "normal-note.md")));
        Assert.False(File.Exists(Path.Combine(cloneB, "obsync-recovery-key.txt")));
        Assert.False(File.Exists(Path.Combine(cloneB, ".env")));
    }

    [Fact]
    public async Task TwoWaySync_RejectsMaliciousRemoteUrlBeforeRunningGit()
    {
        var (_, cloneA, _) = SetupRepoPair();

        var res = await _syncService.SyncVaultAsync(new VaultEntry
        {
            Name = "BadRemoteVault",
            Path = cloneA,
            RemoteUrl = "ext::sh -c echo pwned"
        });

        Assert.False(res.Success);
        Assert.Equal("Invalid git remote URL.", res.Summary);
    }
}
