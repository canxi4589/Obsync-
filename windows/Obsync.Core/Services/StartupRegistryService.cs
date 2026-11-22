using System.Runtime.Versioning;
using Microsoft.Win32;

namespace Obsync.Core.Services;

[SupportedOSPlatform("windows")]
public static class StartupRegistryService
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "ObsyncTray";

    public static bool IsEnabled(string? expectedExePath = null)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
        if (key?.GetValue(ValueName) is not string raw || string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        var unquoted = raw.Trim().Trim('"');
        if (!File.Exists(unquoted))
        {
            return false;
        }

        var expected = expectedExePath ?? Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(expected))
        {
            return string.Equals(
                Path.GetFullPath(unquoted),
                Path.GetFullPath(expected),
                StringComparison.OrdinalIgnoreCase);
        }

        return true;
    }

    public static void SetEnabled(bool enabled, string? exePath = null)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true)
            ?? Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);

        if (enabled)
        {
            var target = exePath ?? Environment.ProcessPath;
            if (!string.IsNullOrWhiteSpace(target))
            {
                var fullPath = Path.GetFullPath(target).Replace("\"", string.Empty);
                key.SetValue(ValueName, $"\"{fullPath}\"");
            }
        }
        else
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
        }
    }
}
