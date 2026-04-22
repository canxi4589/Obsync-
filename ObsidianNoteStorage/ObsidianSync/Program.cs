using System.CommandLine;
using ObsidianSync.Commands;

var root = new RootCommand("ObsidianSync — encrypt private notes and push Obsidian vaults to GitHub.");

root.AddCommand(InitCommand.Build());
root.AddCommand(SyncCommand.Build());
root.AddCommand(DecryptCommand.Build());
root.AddCommand(VaultCommand.Build());
root.AddCommand(StatusCommand.Build());

return await root.InvokeAsync(args);
