using System.Diagnostics;
using Obsync.Core.Models;

namespace Obsync.Core.Services;

public sealed class GitSyncService
{
    private readonly string _gitExe;

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

        var insideCheck = await RunGitAsync(vault.Path, ct, "rev-parse", "--is-inside-work-tree");
        if (insideCheck.ExitCode != 0)
        {
            return new SyncResult(
                vault.Name,
                Success: false,
                HadChanges: false,
                HadConflict: false,
                Summary: "Folder is not a git repository.",
                ErrorDetails: CombineOutput(insideCheck));
        }

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
                    ErrorDetails: CombineOutput(remoteResult));
            }
        }

        await EnsureEncryptedVaultNotIgnoredAsync(vault.Path, ct);

        bool committedLocal = false;
        var status = await RunGitAsync(vault.Path, ct, "status", "--porcelain");
        if (status.ExitCode != 0)
        {
            return new SyncResult(
                vault.Name,
                Success: false,
                HadChanges: false,
                HadConflict: false,
                Summary: "git status failed.",
                ErrorDetails: CombineOutput(status));
        }

        if (!string.IsNullOrWhiteSpace(status.StdOut))
        {
            var add = await RunGitAsync(vault.Path, ct, "add", "-A");
            if (add.ExitCode != 0)
            {
                return new SyncResult(
                    vault.Name,
                    Success: false,
                    HadChanges: false,
                    HadConflict: false,
                    Summary: "git add failed.",
                    ErrorDetails: CombineOutput(add));
            }

            var staged = await RunGitAsync(vault.Path, ct, "diff", "--cached", "--name-only");
            if (!string.IsNullOrWhiteSpace(staged.StdOut))
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
                        ErrorDetails: CombineOutput(commit));
                }
                committedLocal = true;
            }
        }

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

        var branchRes = await RunGitAsync(vault.Path, ct, "rev-parse", "--abbrev-ref", "HEAD");
        var branch = branchRes.ExitCode == 0 && !string.IsNullOrWhiteSpace(branchRes.StdOut)
            ? branchRes.StdOut.Trim()
            : "main";
        var remoteName = SelectRemoteName(remotes.StdOut);

        var headBeforePull = (await RunGitAsync(vault.Path, ct, "rev-parse", "--verify", "HEAD")).StdOut.Trim();

        // Pull with rebase if remote branch exists
        var upstreamCheck = await RunGitAsync(
            vault.Path,
            ct,
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}");
        bool hasUpstream = upstreamCheck.ExitCode == 0;

        bool remoteBranchExists = hasUpstream;
        if (!remoteBranchExists)
        {
            var lsRemote = await RunGitAsync(vault.Path, ct, "ls-remote", "--heads", remoteName, branch);
            remoteBranchExists = lsRemote.ExitCode == 0 && !string.IsNullOrWhiteSpace(lsRemote.StdOut);
        }

        bool pulledRemote = false;
        if (remoteBranchExists)
        {
            var pull = hasUpstream
                ? await RunGitAsync(vault.Path, ct, "pull", "--rebase", "--autostash")
                : await RunGitAsync(vault.Path, ct, "pull", "--rebase", "--autostash", remoteName, branch);

            if (pull.ExitCode != 0)
            {
                var combined = CombineOutput(pull);
                bool isConflict =
                    IsRebaseInProgress(vault.Path) ||
                    combined.Contains("CONFLICT", StringComparison.OrdinalIgnoreCase) ||
                    combined.Contains("could not apply", StringComparison.OrdinalIgnoreCase);

                if (IsRebaseInProgress(vault.Path))
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

            var headAfterPull = (await RunGitAsync(vault.Path, ct, "rev-parse", "--verify", "HEAD")).StdOut.Trim();
            pulledRemote = !string.Equals(headBeforePull, headAfterPull, StringComparison.Ordinal);
        }

        // Push if HEAD exists
        var headCheck = await RunGitAsync(vault.Path, ct, "rev-parse", "--verify", "HEAD");
        if (headCheck.ExitCode != 0)
        {
            return new SyncResult(
                vault.Name,
                Success: true,
                HadChanges: false,
                HadConflict: false,
                Summary: "Repository initialized (no commits yet).");
        }

        var push = hasUpstream
            ? await RunGitAsync(vault.Path, ct, "push")
            : await RunGitAsync(vault.Path, ct, "push", "-u", remoteName, branch);

        if (push.ExitCode != 0)
        {
            return new SyncResult(
                vault.Name,
                Success: false,
                HadChanges: committedLocal || pulledRemote,
                HadConflict: false,
                Summary: "git push failed.",
                ErrorDetails: CombineOutput(push));
        }

        bool pushedLocal = committedLocal || !hasUpstream || !push.StdErr.Contains("Everything up-to-date", StringComparison.OrdinalIgnoreCase);
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

        var check = await RunGitAsync(workingDir, ct, "check-ignore", "-q", ".obsync-vault/vault.json");
        if (check.ExitCode != 0) return;

        var gitignorePath = Path.Combine(workingDir, ".gitignore");
        var lines = File.Exists(gitignorePath)
            ? File.ReadAllLines(gitignorePath).ToList()
            : [];

        if (!lines.Contains("!.obsync-vault/")) lines.Add("!.obsync-vault/");
        if (!lines.Contains("!.obsync-vault/**")) lines.Add("!.obsync-vault/**");
        File.WriteAllLines(gitignorePath, lines);
    }

    private static string SelectRemoteName(string remotesStdOut)
    {
        var list = remotesStdOut
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
            .Select(r => r.Trim())
            .ToList();
        return list.Contains("origin", StringComparer.Ordinal) ? "origin" : list[0];
    }

    private static bool IsRebaseInProgress(string workingDir)
    {
        var gitDir = Path.Combine(workingDir, ".git");
        return Directory.Exists(Path.Combine(gitDir, "rebase-merge")) ||
               Directory.Exists(Path.Combine(gitDir, "rebase-apply"));
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
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"Failed to start git executable '{_gitExe}'.");

        var stdoutTask = proc.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = proc.StandardError.ReadToEndAsync(ct);

        await Task.WhenAll(stdoutTask, stderrTask, proc.WaitForExitAsync(ct));

        return new GitCommandResult(proc.ExitCode, stdoutTask.Result, stderrTask.Result);
    }

    internal readonly record struct GitCommandResult(int ExitCode, string StdOut, string StdErr);
}
