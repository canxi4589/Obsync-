using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.RegularExpressions;
using Obsync.Core.Models;

namespace Obsync.Core.Services;

public sealed partial class GitSyncService
{
    private readonly string _gitExe;
    private readonly ConcurrentDictionary<string, DateTime> _checkedGitIgnoreCache = new(StringComparer.OrdinalIgnoreCase);

    [GeneratedRegex(@"://[^/\s@]+@", RegexOptions.Compiled)]
    private static partial Regex UrlCredentialsRegex();

    [GeneratedRegex(@"^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:.+$", RegexOptions.Compiled)]
    private static partial Regex ScpRemoteRegex();

    private static readonly string[] SecretExcludePathspecs =
    [
        ":(exclude)obsync-recovery-key*.txt",
        ":(exclude)**/obsync-recovery-key*.txt",
        ":(exclude).env",
        ":(exclude)**/.env",
        ":(exclude).env.*",
        ":(exclude)**/.env.*"
    ];

    public GitSyncService(string? gitExecutable = null)
    {
        _gitExe = gitExecutable ?? ResolveGitExecutable();
    }

    public static string ResolveGitExecutable()
    {
        var winDefault = @"C:\Program Files\Git\cmd\git.exe";
        if (File.Exists(winDefault)) return winDefault;
        var winX86 = @"C:\Program Files (x86)\Git\cmd\git.exe";
        if (File.Exists(winX86)) return winX86;
        return "git";
    }

    /// <summary>
    /// Validates a user-configured Git remote URL to prevent Git argument injection
    /// and dangerous transport protocols (e.g. ext::, file://).
    /// </summary>
    public static bool TryValidateRemoteUrl(string? remoteUrl, out string error)
    {
        if (string.IsNullOrWhiteSpace(remoteUrl))
        {
            error = string.Empty;
            return true;
        }

        var trimmed = remoteUrl.Trim();
        if (trimmed.StartsWith('-'))
        {
            error = "Remote URL cannot start with '-'.";
            return false;
        }
        if (trimmed.Any(c => char.IsControl(c) || char.IsWhiteSpace(c)))
        {
            error = "Remote URL cannot contain whitespace or control characters.";
            return false;
        }

        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
        {
            if (uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase) ||
                uri.Scheme.Equals("ssh", StringComparison.OrdinalIgnoreCase))
            {
                if (string.IsNullOrWhiteSpace(uri.Host))
                {
                    error = "Remote URL must include a valid hostname.";
                    return false;
                }
                error = string.Empty;
                return true;
            }

            error = $"Unsupported remote URL scheme '{uri.Scheme}'. Use https:// or ssh:// (or git@host:path).";
            return false;
        }

        if (ScpRemoteRegex().IsMatch(trimmed))
        {
            error = string.Empty;
            return true;
        }

        error = "Remote URL must be a valid https://, ssh://, or git@host:repo URL.";
        return false;
    }

    /// <summary>
    /// Masks embedded user:token@ credentials in URLs before displaying or logging.
    /// </summary>
    public static string RedactCredentials(string? text)
    {
        if (string.IsNullOrEmpty(text)) return string.Empty;
        return UrlCredentialsRegex().Replace(text, "://***@");
    }

    public async Task<SyncResult> SyncVaultAsync(VaultEntry vault, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(vault.Path) || !Directory.Exists(vault.Path))
        {
            return new SyncResult(
                vault.Name,
                Success: false,
                HadChanges: false,
                HadConflict: false,
                Summary: "Vault directory does not exist.",
                ErrorDetails: vault.Path);
        }

        if (!string.IsNullOrWhiteSpace(vault.RemoteUrl))
        {
            if (!TryValidateRemoteUrl(vault.RemoteUrl, out var urlError))
            {
                return new SyncResult(
                    vault.Name,
                    Success: false,
                    HadChanges: false,
                    HadConflict: false,
                    Summary: "Invalid git remote URL.",
                    ErrorDetails: urlError);
            }
        }

        await EnsureEncryptedVaultNotIgnoredAsync(vault.Path, ct);

        // Single git call returns repo validity, branch, HEAD OID, upstream, ahead/behind, and working tree status
        var statusRes = await RunGitAsync(vault.Path, ct, "status", "--porcelain=v2", "--branch");
        if (statusRes.ExitCode != 0)
        {
            var err = RedactCredentials(CombineOutput(statusRes));
            var notRepo = err.Contains("not a git repository", StringComparison.OrdinalIgnoreCase);
            return new SyncResult(
                vault.Name,
                Success: false,
                HadChanges: false,
                HadConflict: false,
                Summary: notRepo ? "Folder is not a git repository." : "git status failed.",
                ErrorDetails: err);
        }

        var parsedStatus = ParseStatusV2(statusRes.StdOut);

        if (!string.IsNullOrWhiteSpace(vault.RemoteUrl))
        {
            var remoteResult = await EnsureRemoteUrlAsync(vault.Path, vault.RemoteUrl.Trim(), ct);
            if (remoteResult.ExitCode != 0)
            {
                return new SyncResult(
                    vault.Name,
                    Success: false,
                    HadChanges: false,
                    HadConflict: false,
                    Summary: "Failed to configure git remote 'origin'.",
                    ErrorDetails: RedactCredentials(CombineOutput(remoteResult)));
            }
        }

        bool committedLocal = false;
        string headBeforePull = parsedStatus.HeadOid;
        bool hasCommits = parsedStatus.HasCommits;
        int aheadCount = parsedStatus.AheadCount;

        if (parsedStatus.HasDirtyFiles)
        {
            var addArgs = new List<string>(2 + 2 + SecretExcludePathspecs.Length)
            {
                "add", "-A", "--", "."
            };
            addArgs.AddRange(SecretExcludePathspecs);

            var add = await RunGitAsync(vault.Path, ct, [.. addArgs]);
            if (add.ExitCode != 0)
            {
                return new SyncResult(
                    vault.Name,
                    Success: false,
                    HadChanges: false,
                    HadConflict: false,
                    Summary: "git add failed.",
                    ErrorDetails: RedactCredentials(CombineOutput(add)));
            }

            // Exit code 1 means there are staged changes; 0 means nothing staged
            var stagedCheck = await RunGitAsync(vault.Path, ct, "diff", "--cached", "--quiet");
            if (stagedCheck.ExitCode == 1)
            {
                var template = string.IsNullOrWhiteSpace(vault.CommitMessage)
                    ? "sync: {timestamp}"
                    : vault.CommitMessage;
                var msg = template.Replace("{timestamp}", DateTime.Now.ToString("yyyy-MM-dd HH:mm"));

                var commit = await RunGitAsync(vault.Path, ct, "commit", "-m", msg);
                if (commit.ExitCode != 0)
                {
                    return new SyncResult(
                        vault.Name,
                        Success: false,
                        HadChanges: false,
                        HadConflict: false,
                        Summary: "git commit failed.",
                        ErrorDetails: RedactCredentials(CombineOutput(commit)));
                }
                committedLocal = true;
                hasCommits = true;
                aheadCount++;
            }
        }

        var branch = !string.IsNullOrWhiteSpace(parsedStatus.BranchHead) &&
                     !parsedStatus.BranchHead.Equals("(detached)", StringComparison.Ordinal)
            ? parsedStatus.BranchHead
            : "main";
        if (branch.StartsWith('-'))
        {
            return new SyncResult(
                vault.Name,
                Success: false,
                HadChanges: committedLocal,
                HadConflict: false,
                Summary: "Invalid git branch name.",
                ErrorDetails: $"Refusing to sync branch starting with '-': {branch}");
        }

        bool hasUpstream = !string.IsNullOrWhiteSpace(parsedStatus.Upstream);
        string remoteName;

        if (hasUpstream)
        {
            var slash = parsedStatus.Upstream!.IndexOf('/');
            remoteName = slash > 0 ? parsedStatus.Upstream[..slash] : "origin";
        }
        else
        {
            var remotes = await RunGitAsync(vault.Path, ct, "remote");
            if (string.IsNullOrWhiteSpace(remotes.StdOut))
            {
                return new SyncResult(
                    vault.Name,
                    Success: true,
                    HadChanges: committedLocal,
                    HadConflict: false,
                    Summary: committedLocal
                        ? "Committed locally (no git remote configured)."
                        : "Local repository clean (no remote).");
            }
            remoteName = SelectRemoteName(remotes.StdOut);
        }

        if (remoteName.StartsWith('-'))
        {
            return new SyncResult(
                vault.Name,
                Success: false,
                HadChanges: committedLocal,
                HadConflict: false,
                Summary: "Invalid git remote name.",
                ErrorDetails: $"Refusing to use remote starting with '-': {remoteName}");
        }

        bool remoteBranchExists = hasUpstream;
        if (!remoteBranchExists)
        {
            var lsRemote = await RunGitAsync(vault.Path, ct, "ls-remote", "--heads", "--", remoteName, branch);
            if (lsRemote.ExitCode != 0)
            {
                return new SyncResult(
                    vault.Name,
                    Success: false,
                    HadChanges: committedLocal,
                    HadConflict: false,
                    Summary: "Cannot reach remote repository.",
                    ErrorDetails: RedactCredentials(CombineOutput(lsRemote)));
            }
            remoteBranchExists = !string.IsNullOrWhiteSpace(lsRemote.StdOut);
        }

        // Capture exact post-commit HEAD OID only when we created a new local commit
        if (committedLocal && remoteBranchExists)
        {
            headBeforePull = (await RunGitAsync(vault.Path, ct, "rev-parse", "--verify", "HEAD")).StdOut.Trim();
        }

        bool pulledRemote = false;
        if (remoteBranchExists)
        {
            var pull = hasUpstream
                ? await RunGitAsync(vault.Path, ct, "pull", "--rebase", "--autostash")
                : await RunGitAsync(vault.Path, ct, "pull", "--rebase", "--autostash", "--", remoteName, branch);

            if (pull.ExitCode != 0)
            {
                var combined = RedactCredentials(CombineOutput(pull));
                bool rebaseActive = await IsRebaseInProgressAsync(vault.Path, ct);
                bool isConflict =
                    rebaseActive ||
                    combined.Contains("CONFLICT", StringComparison.OrdinalIgnoreCase) ||
                    combined.Contains("could not apply", StringComparison.OrdinalIgnoreCase);

                if (rebaseActive)
                {
                    await RunGitAsync(vault.Path, ct, "rebase", "--abort");
                }

                return new SyncResult(
                    vault.Name,
                    Success: false,
                    HadChanges: committedLocal,
                    HadConflict: isConflict,
                    Summary: isConflict
                        ? "Sync conflict detected — rebase aborted cleanly."
                        : "git pull --rebase failed.",
                    ErrorDetails: combined);
            }

            var headAfterRes = await RunGitAsync(vault.Path, ct, "rev-parse", "--verify", "HEAD");
            if (headAfterRes.ExitCode == 0)
            {
                hasCommits = true;
                var headAfterPull = headAfterRes.StdOut.Trim();
                pulledRemote = !string.Equals(headBeforePull, headAfterPull, StringComparison.Ordinal);
            }
        }

        if (!hasCommits)
        {
            return new SyncResult(
                vault.Name,
                Success: true,
                HadChanges: false,
                HadConflict: false,
                Summary: "Repository initialized (no commits yet).");
        }

        bool shouldPush = !hasUpstream || committedLocal || aheadCount > 0;
        bool pushedLocal = false;

        if (shouldPush)
        {
            var push = hasUpstream
                ? await RunGitAsync(vault.Path, ct, "push")
                : await RunGitAsync(vault.Path, ct, "push", "-u", "--", remoteName, branch);

            if (push.ExitCode != 0)
            {
                return new SyncResult(
                    vault.Name,
                    Success: false,
                    HadChanges: committedLocal || pulledRemote,
                    HadConflict: false,
                    Summary: "git push failed.",
                    ErrorDetails: RedactCredentials(CombineOutput(push)));
            }
            pushedLocal = committedLocal || !hasUpstream || !push.StdErr.Contains("Everything up-to-date", StringComparison.OrdinalIgnoreCase);
        }

        bool hadChanges = committedLocal || pulledRemote;

        string summary;
        if (committedLocal && pulledRemote)
            summary = "Committed local changes, pulled updates, and pushed.";
        else if (committedLocal)
            summary = "Committed and pushed local changes.";
        else if (pulledRemote)
            summary = "Pulled updates from remote.";
        else if (pushedLocal && !hasUpstream)
            summary = "Pushed initial branch to remote.";
        else
            summary = "Already up to date.";

        return new SyncResult(
            vault.Name,
            Success: true,
            HadChanges: hadChanges,
            HadConflict: false,
            Summary: summary);
    }

    internal readonly record struct StatusV2Info(
        string HeadOid,
        bool HasCommits,
        string BranchHead,
        string? Upstream,
        int AheadCount,
        int BehindCount,
        bool HasDirtyFiles);

    internal static StatusV2Info ParseStatusV2(string stdOut)
    {
        string headOid = string.Empty;
        bool hasCommits = false;
        string branchHead = string.Empty;
        string? upstream = null;
        int ahead = 0;
        int behind = 0;
        bool hasDirty = false;

        foreach (var rawLine in stdOut.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            if (rawLine.StartsWith("# branch.oid ", StringComparison.Ordinal))
            {
                var oid = rawLine["# branch.oid ".Length..].Trim();
                if (!oid.Equals("(initial)", StringComparison.Ordinal))
                {
                    headOid = oid;
                    hasCommits = true;
                }
            }
            else if (rawLine.StartsWith("# branch.head ", StringComparison.Ordinal))
            {
                branchHead = rawLine["# branch.head ".Length..].Trim();
            }
            else if (rawLine.StartsWith("# branch.upstream ", StringComparison.Ordinal))
            {
                upstream = rawLine["# branch.upstream ".Length..].Trim();
            }
            else if (rawLine.StartsWith("# branch.ab ", StringComparison.Ordinal))
            {
                var parts = rawLine["# branch.ab ".Length..].Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                foreach (var p in parts)
                {
                    if (p.StartsWith('+') && int.TryParse(p[1..], out int a)) ahead = a;
                    else if (p.StartsWith('-') && int.TryParse(p[1..], out int b)) behind = b;
                }
            }
            else if (!rawLine.StartsWith('#'))
            {
                hasDirty = true;
            }
        }

        return new StatusV2Info(headOid, hasCommits, branchHead, upstream, ahead, behind, hasDirty);
    }

    private async Task<GitCommandResult> EnsureRemoteUrlAsync(string workingDir, string remoteUrl, CancellationToken ct)
    {
        var current = await RunGitAsync(workingDir, ct, "remote", "get-url", "origin");
        if (current.ExitCode != 0)
        {
            return await RunGitAsync(workingDir, ct, "remote", "add", "origin", remoteUrl);
        }
        if (!string.Equals(current.StdOut.Trim(), remoteUrl, StringComparison.Ordinal))
        {
            return await RunGitAsync(workingDir, ct, "remote", "set-url", "origin", remoteUrl);
        }
        return current;
    }

    private async Task EnsureEncryptedVaultNotIgnoredAsync(string workingDir, CancellationToken ct)
    {
        var vaultDir = Path.Combine(workingDir, ".obsync-vault");
        if (!Directory.Exists(vaultDir)) return;

        var gitignorePath = Path.Combine(workingDir, ".gitignore");
        var gitignoreMtime = File.Exists(gitignorePath)
            ? File.GetLastWriteTimeUtc(gitignorePath)
            : DateTime.MinValue;

        if (_checkedGitIgnoreCache.TryGetValue(workingDir, out var cachedMtime) &&
            cachedMtime == gitignoreMtime)
        {
            return;
        }

        var check = await RunGitAsync(workingDir, ct, "check-ignore", "-q", ".obsync-vault/vault.json");
        if (check.ExitCode != 0)
        {
            _checkedGitIgnoreCache[workingDir] = gitignoreMtime;
            return;
        }

        var lines = File.Exists(gitignorePath)
            ? File.ReadAllLines(gitignorePath).ToList()
            : [];

        if (!lines.Contains("!.obsync-vault/")) lines.Add("!.obsync-vault/");
        if (!lines.Contains("!.obsync-vault/**")) lines.Add("!.obsync-vault/**");
        File.WriteAllLines(gitignorePath, lines);
        _checkedGitIgnoreCache[workingDir] = File.GetLastWriteTimeUtc(gitignorePath);
    }

    private static string SelectRemoteName(string remotesStdOut)
    {
        var list = remotesStdOut
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
            .Select(r => r.Trim())
            .ToList();
        return list.Contains("origin", StringComparer.Ordinal) ? "origin" : list[0];
    }

    private async Task<bool> IsRebaseInProgressAsync(string workingDir, CancellationToken ct)
    {
        // Fast filesystem check for standard .git directory without spawning git.exe
        var defaultGitDir = Path.Combine(workingDir, ".git");
        if (Directory.Exists(defaultGitDir))
        {
            return Directory.Exists(Path.Combine(defaultGitDir, "rebase-merge")) ||
                   Directory.Exists(Path.Combine(defaultGitDir, "rebase-apply"));
        }

        var gitDirRes = await RunGitAsync(workingDir, ct, "rev-parse", "--git-dir");
        var gitDir = gitDirRes.ExitCode == 0 && !string.IsNullOrWhiteSpace(gitDirRes.StdOut)
            ? gitDirRes.StdOut.Trim()
            : ".git";
        var fullGitDir = Path.IsPathRooted(gitDir)
            ? gitDir
            : Path.GetFullPath(Path.Combine(workingDir, gitDir));

        return Directory.Exists(Path.Combine(fullGitDir, "rebase-merge")) ||
               Directory.Exists(Path.Combine(fullGitDir, "rebase-apply"));
    }

    private static string CombineOutput(GitCommandResult r)
    {
        var parts = new[] { r.StdErr.Trim(), r.StdOut.Trim() }.Where(s => !string.IsNullOrEmpty(s));
        return string.Join(Environment.NewLine, parts);
    }

    internal async Task<GitCommandResult> RunGitAsync(string workingDir, CancellationToken ct, params string[] args)
    {
        var psi = new ProcessStartInfo(_gitExe)
        {
            WorkingDirectory = workingDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0";
        psi.Environment["GCM_INTERACTIVE"] = "never";

        // Defense-in-depth: never permit arbitrary command execution via ext:: transport
        psi.ArgumentList.Add("-c");
        psi.ArgumentList.Add("protocol.ext.allow=never");
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"Failed to start git executable '{_gitExe}'.");

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromMinutes(2));

        var stdoutTask = proc.StandardOutput.ReadToEndAsync(timeoutCts.Token);
        var stderrTask = proc.StandardError.ReadToEndAsync(timeoutCts.Token);

        try
        {
            await Task.WhenAll(stdoutTask, stderrTask, proc.WaitForExitAsync(timeoutCts.Token));
            return new GitCommandResult(proc.ExitCode, stdoutTask.Result, stderrTask.Result);
        }
        catch (OperationCanceledException)
        {
            try
            {
                if (!proc.HasExited) proc.Kill(entireProcessTree: true);
            }
            catch
            {
            }

            // Observe faulted/canceled reader tasks cleanly
            _ = stdoutTask.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
            _ = stderrTask.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);

            if (ct.IsCancellationRequested)
            {
                throw;
            }
            return new GitCommandResult(-1, string.Empty, "git command timed out after 120 seconds.");
        }
    }

    internal readonly record struct GitCommandResult(int ExitCode, string StdOut, string StdErr);
}
