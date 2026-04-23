using System.CommandLine;
using ObsidianSync.Services;

namespace ObsidianSync.Commands;

public static class InitCommand
{
    public static Command Build()
    {
        var cmd = new Command("init", "Set or update the master encryption password.");

        cmd.SetAction((ParseResult _) =>
        {
            Console.Write("Enter new master password: ");
            var password = ReadPassword();

            Console.Write("Confirm password: ");
            var confirm = ReadPassword();

            if (password != confirm)
            {
                Console.Error.WriteLine("Passwords do not match.");
                return 1;
            }

            EncryptionService.SetPassword(password);

            // Ensure config.json exists on disk so subsequent commands can load it.
            var config = ConfigService.Load();
            ConfigService.Save(config);

            Console.WriteLine("Password saved (protected by Windows DPAPI).");
            Console.WriteLine($"Config written to: {ConfigService.ConfigPath}");
            return 0;
        });

        return cmd;
    }

    internal static string ReadPassword()
    {
        var sb = new System.Text.StringBuilder();
        while (true)
        {
            var k = Console.ReadKey(intercept: true);
            if (k.Key == ConsoleKey.Enter) break;
            if (k.Key == ConsoleKey.Backspace)
            {
                if (sb.Length > 0)
                {
                    sb.Length--;
                    Console.Write("\b \b");
                }
            }
            else
            {
                sb.Append(k.KeyChar);
                Console.Write('*');
            }
        }
        Console.WriteLine();
        return sb.ToString();
    }
}
