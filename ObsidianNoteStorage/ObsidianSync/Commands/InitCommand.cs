using System.CommandLine;
using ObsidianSync.Services;

namespace ObsidianSync.Commands;

public static class InitCommand
{
    public static Command Build()
    {
        var cmd = new Command("init", "Set or update the master encryption password.");

        cmd.SetHandler(() =>
        {
            Console.Write("Enter new master password: ");
            var password = ReadPassword();

            Console.Write("Confirm password: ");
            var confirm = ReadPassword();

            if (password != confirm)
            {
                Console.Error.WriteLine("Passwords do not match.");
                return;
            }

            EncryptionService.SetPassword(password);
            Console.WriteLine("Password saved (protected by Windows DPAPI).");
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
                if (sb.Length > 0) sb.Length--;
            }
            else
            {
                sb.Append(k.KeyChar);
            }
        }
        Console.WriteLine();
        return sb.ToString();
    }
}
