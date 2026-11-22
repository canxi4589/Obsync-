namespace Obsync.Tray;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(
            initiallyOwned: true,
            name: @"Local\ObsyncTray_SingleInstance_Mutex",
            createdNew: out bool isNewInstance);

        if (!isNewInstance)
        {
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplicationContext());
    }
}
