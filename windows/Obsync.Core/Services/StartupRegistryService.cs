using System.Runtime.Versioning;
using Microsoft.Win32;

namespace Obsync.Core.Services;

[SupportedOSPlatform("windows")]
public static class StartupRegistryService
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "ObsyncTray";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
        return key?.GetValue(ValueName) is string s && !string.IsNullOrWhiteSpace(s);
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
                key.SetValue(ValueName, $"\"{target}\"");
            }
        }
        else
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
        }
    }
}
