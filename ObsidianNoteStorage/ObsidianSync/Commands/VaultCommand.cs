using System.CommandLine;
using ObsidianSync.Models;
using ObsidianSync.Services;

namespace ObsidianSync.Commands;

public static class VaultCommand
{
    public static Command Build()
    {
        var cmd = new Command("vault", "Manage vault references.");

        cmd.AddCommand(BuildAdd());
        cmd.AddCommand(BuildList());
        cmd.AddCommand(BuildRemove());

        return cmd;
    }

    private static Command BuildAdd()
    {
        var nameArg = new Argument<string>("name", "Friendly name for the vault.");
        var pathArg = new Argument<string>("path", "Absolute path to the vault directory.");
        var remoteOpt = new Option<string?>("--remote", "Override git remote URL (optional).");
        var folderOpt = new Option<string>("--private-folder", () => "private", "Subfolder for sensitive notes.");

        var add = new Command("add", "Add a vault to the config.") { nameArg, pathArg, remoteOpt, folderOpt };

        add.SetHandler((name, path, remote, folder) =>
        {
            path = Path.GetFullPath(path);
            if (!Directory.Exists(path))
            {
                Console.Error.WriteLine($"Path does not exist: {path}");
                return;
            }

            var config = ConfigService.Load();
            if (config.Vaults.Any(v => v.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
            {
                Console.Error.WriteLine($"Vault '{name}' already exists. Remove it first.");
                return;
            }

            config.Vaults.Add(new VaultConfig
            {
                Name = name,
                Path = path,
                RemoteUrl = remote,
                PrivateFolder = folder
            });

            ConfigService.Save(config);
            Console.WriteLine($"Added vault '{name}' → {path}");
        }, nameArg, pathArg, remoteOpt, folderOpt);

        return add;
    }

    private static Command BuildList()
    {
        var list = new Command("list", "List configured vaults.");

        list.SetHandler(() =>
        {
            var config = ConfigService.Load();
            if (config.Vaults.Count == 0)
            {
                Console.WriteLine("No vaults configured.");
                return;
            }

            foreach (var v in config.Vaults)
            {
                Console.WriteLine($"  [{v.Name}]");
                Console.WriteLine($"    Path   : {v.Path}");
                Console.WriteLine($"    Private: {v.PrivateFolder}/");
                if (v.RemoteUrl is not null)
                    Console.WriteLine($"    Remote : {v.RemoteUrl}");
            }
        });

        return list;
    }

    private static Command BuildRemove()
    {
        var nameArg = new Argument<string>("name", "Name of the vault to remove.");
        var remove = new Command("remove", "Remove a vault from config.") { nameArg };

        remove.SetHandler((name) =>
        {
            var config = ConfigService.Load();
            var removed = config.Vaults.RemoveAll(v =>
                v.Name.Equals(name, StringComparison.OrdinalIgnoreCase));

            if (removed == 0)
            {
                Console.Error.WriteLine($"Vault '{name}' not found.");
                return;
            }

            ConfigService.Save(config);
            Console.WriteLine($"Removed vault '{name}'.");
        }, nameArg);

        return remove;
    }
}
