using System.CommandLine;
using ObsidianSync.Models;
using ObsidianSync.Services;

namespace ObsidianSync.Commands;

public static class ListCommand
{
    public static Command Build()
    {
        var vaultOpt = new Option<string?>("--vault") { Description = "Limit to a specific vault." };
        var allOpt   = new Option<bool>("--all") { Description = "Show all files, not just private folder." };

        var cmd = new Command("list", "Show vault contents and per-file sync status.");
        cmd.Options.Add(vaultOpt);
        cmd.Options.Add(allOpt);

        cmd.SetAction((ParseResult r) =>
        {
            var vaultName = r.GetValue(vaultOpt);
            var showAll = r.GetValue(allOpt);

            var config = ConfigService.Load();
            var vaults = vaultName is null
                ? config.Vaults
                : config.Vaults
                    .Where(v => v.Name.Equals(vaultName, StringComparison.OrdinalIgnoreCase))
                    .ToList();

            if (vaults.Count == 0)
            {
                Console.Error.WriteLine(vaultName is null
                    ? "No vaults configured. Run: obsync vault add"
                    : $"Vault '{vaultName}' not found.");
                return 1;
            }

            foreach (var vault in vaults)
                PrintVault(vault, showAll);

            return 0;
        });

        return cmd;
    }

    private static void PrintVault(VaultConfig vault, bool showAll)
    {
        if (!Directory.Exists(vault.Path))
        {
            Console.WriteLine($"[{vault.Name}]  ✗ path missing: {vault.Path}");
            return;
        }

        var gitStatus  = GitService.GetStatusLines(vault.Path);
        var dirtyFiles = gitStatus.ToHashSet(StringComparer.OrdinalIgnoreCase);

        Console.WriteLine();
        Console.WriteLine($"┌─ [{vault.Name}]");
        Console.WriteLine($"│  {vault.Path}");
        Console.WriteLine($"│  Git dirty files: {dirtyFiles.Count}");
        Console.WriteLine("│");

        var entries = Directory.GetFileSystemEntries(vault.Path)
            .OrderBy(e => Directory.Exists(e) ? 0 : 1)   // folders first
            .ThenBy(Path.GetFileName);

        var entryList = entries
            .Where(e =>
            {
                var name = Path.GetFileName(e);
                // always hide .git internals and the encrypted subfolder from top level
                return name != ".git";
            })
            .ToList();

        for (int i = 0; i < entryList.Count; i++)
        {
            var entry    = entryList[i];
            var isLast   = i == entryList.Count - 1;
            var name     = Path.GetFileName(entry);
            var isDir    = Directory.Exists(entry);
            var connector = isLast ? "└──" : "├──";
            var indent    = isLast ? "    " : "│   ";

            bool isPrivate = name.Equals(vault.PrivateFolder, StringComparison.OrdinalIgnoreCase);

            if (isDir)
            {
                Console.WriteLine($"│  {connector} 📁 {name}/");
                if (isPrivate)
                    PrintPrivateFolder(entry, vault, indent);
                else if (showAll)
                    PrintSubfolder(entry, indent, dirtyFiles, depth: 1);
            }
            else
            {
                var status = GetFileStatus(entry, vault.Path, dirtyFiles);
                Console.WriteLine($"│  {connector} 📄 {name}  {status}");
            }
        }

        Console.WriteLine("└─────────────────────────────────────────");
    }

    private static void PrintPrivateFolder(string privateDir, VaultConfig vault, string indent)
    {
        var encDir = Path.Combine(privateDir, ".encrypted");

        var notes = Directory.Exists(privateDir)
            ? Directory.GetFiles(privateDir, "*.md", SearchOption.TopDirectoryOnly)
                       .OrderBy(Path.GetFileName)
                       .ToList()
            : [];

        var encFiles = Directory.Exists(encDir)
            ? Directory.GetFiles(encDir, "*.enc")
                       .Select(f => Path.GetFileNameWithoutExtension(f)) // strips .enc → keeps .md
                       .ToHashSet(StringComparer.OrdinalIgnoreCase)
            : [];

        // Notes that have an .enc but no local plaintext (committed from another machine)
        var remoteOnly = encFiles
            .Where(e => !notes.Any(n =>
                Path.GetFileName(n).Equals(e, StringComparison.OrdinalIgnoreCase)))
            .ToList();

        if (notes.Count == 0 && remoteOnly.Count == 0)
        {
            Console.WriteLine($"│  {indent}(empty)");
            return;
        }

        var allItems = notes.Select(n => (Name: Path.GetFileName(n), IsLocal: true))
            .Concat(remoteOnly.Select(r => (Name: r, IsLocal: false)))
            .OrderBy(x => x.Name)
            .ToList();

        for (int i = 0; i < allItems.Count; i++)
        {
            var (name, isLocal) = allItems[i];
            var isLast    = i == allItems.Count - 1;
            var connector = isLast ? "└──" : "├──";

            string syncStatus;
            if (!isLocal)
            {
                syncStatus = "☁  encrypted-only (run: obsync decrypt to restore locally)";
            }
            else
            {
                var encPath = Path.Combine(encDir, name + ".enc");
                if (!File.Exists(encPath))
                {
                    syncStatus = "⚠  NOT ENCRYPTED — run: obsync sync";
                }
                else
                {
                    var srcTime = File.GetLastWriteTimeUtc(
                        Path.Combine(privateDir, name));
                    var encTime = File.GetLastWriteTimeUtc(encPath);

                    syncStatus = srcTime > encTime
                        ? "⚠  MODIFIED since last encrypt — run: obsync sync"
                        : "✓  encrypted";
                }
            }

            var icon = isLocal ? "🔒" : "☁ ";
            Console.WriteLine($"│  {indent}{connector} {icon} {name}  {syncStatus}");
        }

        // Show .encrypted subfolder info
        Console.WriteLine($"│  {indent}");
        Console.WriteLine($"│  {indent}└── 📁 .encrypted/  ({encFiles.Count} file(s) committed to git)");
    }

    private static void PrintSubfolder(string dir, string indent, HashSet<string> dirtyFiles, int depth)
    {
        if (depth > 2) return; // don't recurse too deep

        var entries = Directory.GetFileSystemEntries(dir)
            .Where(e => Path.GetFileName(e) != ".git")
            .OrderBy(e => Directory.Exists(e) ? 0 : 1)
            .ThenBy(Path.GetFileName)
            .ToList();

        for (int i = 0; i < entries.Count; i++)
        {
            var entry     = entries[i];
            var isLast    = i == entries.Count - 1;
            var name      = Path.GetFileName(entry);
            var connector = isLast ? "└──" : "├──";
            var nextIndent = indent + (isLast ? "    " : "│   ");

            if (Directory.Exists(entry))
            {
                Console.WriteLine($"│  {indent}{connector} 📁 {name}/");
                PrintSubfolder(entry, nextIndent, dirtyFiles, depth + 1);
            }
            else
            {
                var status = GetFileStatus(entry, dir, dirtyFiles);
                Console.WriteLine($"│  {indent}{connector} 📄 {name}  {status}");
            }
        }
    }

    private static string GetFileStatus(string filePath, string vaultRoot, HashSet<string> dirtyFiles)
    {
        var rel = Path.GetRelativePath(vaultRoot, filePath).Replace('\\', '/');
        return dirtyFiles.Contains(rel) ? "[modified]" : "";
    }
}
