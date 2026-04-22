using System.Diagnostics;

namespace ObsidianSync.Services;

public static class GitService
{
    public static bool HasChanges(string vaultPath)
    {
        var output = Run("status --porcelain", vaultPath);
        return !string.IsNullOrWhiteSpace(output);
    }

    public static void CommitAndPush(string vaultPath, string message, string? remoteUrl = null)
    {
        if (remoteUrl is not null)
        {
            Run($"remote set-url origin {remoteUrl}", vaultPath);
        }

        Run("add .", vaultPath);

        var hasStaged = !string.IsNullOrWhiteSpace(Run("diff --cached --name-only", vaultPath));
        if (!hasStaged)
        {
            Console.WriteLine("  No changes to commit.");
            return;
        }

        Run($"commit -m \"{message}\"", vaultPath);
        Run("push", vaultPath);
        Console.WriteLine("  Committed and pushed.");
    }

    public static void EnsureGitignoreEntry(string vaultPath, string privateFolder)
    {
        var gitignorePath = Path.Combine(vaultPath, ".gitignore");
        var lines = File.Exists(gitignorePath)
            ? File.ReadAllLines(gitignorePath).ToList()
            : [];

        var encDir = $"{privateFolder}/.encrypted/";
        var privateGlob = $"{privateFolder}/*.md";
        bool dirty = false;

        // Ignore plaintext private notes
        if (!lines.Contains(privateGlob))
        {
            lines.Add(privateGlob);
            dirty = true;
        }
        // But DO track .encrypted subfolder
        if (!lines.Contains($"!{encDir}") && !lines.Contains($"!{encDir}**"))
        {
            lines.Add($"!{encDir}");
            lines.Add($"!{encDir}**");
            dirty = true;
        }

        if (dirty)
            File.WriteAllLines(gitignorePath, lines);
    }

    private static string Run(string args, string workingDir)
    {
        var psi = new ProcessStartInfo("git", args)
        {
            WorkingDirectory = workingDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var proc = Process.Start(psi)!;
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit();

        if (proc.ExitCode != 0 && !string.IsNullOrWhiteSpace(stderr))
        {
            // "nothing to commit" is not a real error
            if (!stderr.Contains("nothing to commit") && !stderr.Contains("up-to-date"))
                Console.Error.WriteLine($"  git: {stderr.Trim()}");
        }

        return stdout;
    }
}
