using System.CommandLine;
using ObsidianSync.Commands;
using ObsidianSync.Services;

Console.ForegroundColor = ConsoleColor.DarkGray;
Console.WriteLine($"Config: {ConfigService.ConfigPath}");
Console.ResetColor();

// Check for config before running any command that requires it.
// Skip when: no args, any help flag present, or first-run setup commands.
var hasHelpFlag   = args.Any(a => a is "--help" or "-h" or "-?");
var isSetupCmd    = args.Length > 0 && args[0] == "init"
                 || args.Length > 1 && args[0] == "vault" && args[1] == "add";

if (!hasHelpFlag && !isSetupCmd && args.Length > 0)
    ConfigService.AssertExists();

if (hasHelpFlag && !ConfigService.ConfigExists)
{
    Console.ForegroundColor = ConsoleColor.Yellow;
    Console.WriteLine($"  No config found at: {ConfigService.ConfigPath}");
    Console.WriteLine("  To get started:");
    Console.WriteLine("    1. obsync init              — set your master password");
    Console.WriteLine("    2. obsync vault add <name> <path>  — register a vault");
    Console.WriteLine();
    Console.WriteLine("  Expected config file: config.json");
    Console.WriteLine("  Sample contents:");
    Console.ForegroundColor = ConsoleColor.DarkGray;
    Console.WriteLine("    {");
    Console.WriteLine("      \"vaults\": [");
    Console.WriteLine("        {");
    Console.WriteLine("          \"name\": \"my-vault\",");
    Console.WriteLine("          \"path\": \"C:/Users/you/Documents/MyVault\",");
    Console.WriteLine("          \"remoteUrl\": \"https://github.com/you/my-vault.git\",");
    Console.WriteLine("          \"privateFolder\": \"private\",");
    Console.WriteLine("          \"commitMessage\": \"sync: {timestamp}\"");
    Console.WriteLine("        }");
    Console.WriteLine("      ]");
    Console.WriteLine("    }");
    Console.ResetColor();
    Console.WriteLine();
}

var root = new RootCommand("ObsidianSync — encrypt private notes and push Obsidian vaults to GitHub.");

root.Subcommands.Add(InitCommand.Build());
root.Subcommands.Add(SyncCommand.Build());
root.Subcommands.Add(DecryptCommand.Build());
root.Subcommands.Add(VaultCommand.Build());
root.Subcommands.Add(StatusCommand.Build());
root.Subcommands.Add(ListCommand.Build());

return await root.Parse(args).InvokeAsync();
