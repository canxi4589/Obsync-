using System.CommandLine;
using ObsidianSync.Models;
using ObsidianSync.Services;

namespace ObsidianSync.Commands;

public static class VaultCommand
{
    public static Command Build()
    {
        var cmd = new Command("vault", "Manage vault references.");

        cmd.Subcommands.Add(BuildAdd());
        cmd.Subcommands.Add(BuildList());
        cmd.Subcommands.Add(BuildRemove());

        return cmd;
    }

    private static Command BuildAdd()
    {
        var nameArg = new Argument<string>("name") { Description = "Friendly name for the vault." };
        var pathArg = new Argument<string>("path") { Description = "Absolute path to the vault directory." };
        var remoteOpt = new Option<string?>("--remote") { Description = "Override git remote URL (optional)." };
        var folderOpt = new Option<string?>("--private-folder")
        {
            Description = "Subfolder for sensitive notes.",
            DefaultValueFactory = _ => "private"
        };

        var add = new Command("add", "Add a vault to the config.");
        add.Arguments.Add(nameArg);
        add.Arguments.Add(pathArg);
        add.Options.Add(remoteOpt);
        add.Options.Add(folderOpt);

        add.SetAction((ParseResult r) =>
        {
            var name = r.GetValue(nameArg);
            var path = r.GetValue(pathArg);
            var remote = r.GetValue(remoteOpt);
            var folder = r.GetValue(folderOpt);

            path = Path.GetFullPath(path!);
            if (!Directory.Exists(path))
            {
                Console.Error.WriteLine($"Path does not exist: {path}");
                return 1;
            }

            var config = ConfigService.Load();
            if (config.Vaults.Any(v => v.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
            {
                Console.Error.WriteLine($"Vault '{name}' already exists. Remove it first.");
                return 1;
            }

            config.Vaults.Add(new VaultConfig
            {
                Name = name!,
                Path = path,
                RemoteUrl = remote,
                PrivateFolder = folder ?? "private"
            });

            ConfigService.Save(config);
            Console.WriteLine($"Added vault '{name}' → {path}");
            return 0;
        });

        return add;
    }

    private static Command BuildList()
    {
        var list = new Command("list", "List configured vaults.");

        list.SetAction((ParseResult _) =>
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
        var nameArg = new Argument<string>("name") { Description = "Name of the vault to remove." };
        var remove = new Command("remove", "Remove a vault from config.");
        remove.Arguments.Add(nameArg);

        remove.SetAction((ParseResult r) =>
        {
            var name = r.GetValue(nameArg);
            var config = ConfigService.Load();
            var removed = config.Vaults.RemoveAll(v =>
                v.Name.Equals(name, StringComparison.OrdinalIgnoreCase));

            if (removed == 0)
            {
                Console.Error.WriteLine($"Vault '{name}' not found.");
                return 1;
            }

            ConfigService.Save(config);
            Console.WriteLine($"Removed vault '{name}'.");
            return 0;
        });

        return remove;
    }
}
