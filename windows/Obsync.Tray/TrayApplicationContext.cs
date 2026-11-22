using System.Diagnostics;
using Obsync.Core.Models;
using Obsync.Core.Services;

namespace Obsync.Tray;

internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly TrayConfigService _configService = new();
    private readonly GitSyncService _gitSyncService = new();
    private readonly SemaphoreSlim _syncLock = new(1, 1);

    private readonly Icon _idleIcon;
    private readonly Icon _syncingIcon;
    private readonly Icon _errorIcon;

    private readonly NotifyIcon _notifyIcon;
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _vaultsMenu;
    private readonly ToolStripMenuItem _startupItem;
    private readonly System.Windows.Forms.Timer _periodicTimer;
    private readonly System.Windows.Forms.Timer _debounceTimer;

    private readonly List<FileSystemWatcher> _watchers = [];
    private readonly List<string> _logs = [];
    private readonly object _logLock = new();
    private readonly SynchronizationContext _uiContext;
    private readonly CancellationTokenSource _shutdownCts = new();

    private TrayConfig _config;
    private SettingsForm? _settingsForm;
    private bool _hasError;
    private bool _disposed;

    public event Action<string>? LogAppended;
    public event Action? ConfigOrStatusUpdated;

    public TrayApplicationContext()
    {
        _uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        _config = _configService.Load();

        _idleIcon = TrayIconFactory.CreateStatusIcon(TrayState.Idle);
        _syncingIcon = TrayIconFactory.CreateStatusIcon(TrayState.Syncing);
        _errorIcon = TrayIconFactory.CreateStatusIcon(TrayState.Error);

        _statusItem = new ToolStripMenuItem("Status: Idle") { Enabled = false };
        _vaultsMenu = new ToolStripMenuItem("Vaults");
        _startupItem = new ToolStripMenuItem("Start with Windows")
        {
            CheckOnClick = false
        };
        _startupItem.Click += (_, _) => ToggleStartup();

        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Sync Now", null, async (_, _) => await RunSafeAsync(() => SyncAllAsync("Manual sync"), "Manual sync"));
        menu.Items.Add(_vaultsMenu);
        menu.Items.Add("Settings...", null, (_, _) => OpenSettings());
        menu.Items.Add(_startupItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitThread());

        _notifyIcon = new NotifyIcon
        {
            Icon = _idleIcon,
            Text = "Obsync — Idle",
            ContextMenuStrip = menu,
            Visible = true
        };
        _notifyIcon.DoubleClick += (_, _) => OpenSettings();

        _periodicTimer = new System.Windows.Forms.Timer();
        _periodicTimer.Tick += async (_, _) => await RunSafeAsync(() => SyncAllAsync("Scheduled sync"), "Scheduled sync");

        _debounceTimer = new System.Windows.Forms.Timer { Interval = 15_000 };
        _debounceTimer.Tick += async (_, _) =>
        {
            _debounceTimer.Stop();
            await RunSafeAsync(() => SyncAllAsync("File change detected"), "Auto sync");
        };

        ApplyConfigRuntime();
        AppendLog($"Obsync Tray started ({_config.Vaults.Count} vault(s) configured).");
    }

    public TrayConfig CurrentConfig => _config;

    public IReadOnlyList<string> GetLogsSnapshot()
    {
        lock (_logLock)
        {
            return _logs.ToList();
        }
    }

    public void ClearLogs()
    {
        lock (_logLock)
        {
            _logs.Clear();
        }
    }

    public void UpdateConfig(TrayConfig updated)
    {
        _config = updated;
        _configService.Save(_config);
        StartupRegistryService.SetEnabled(_config.StartWithWindows);
        ApplyConfigRuntime();
        AppendLog("Configuration saved.");
    }

    private void ToggleStartup()
    {
        _config.StartWithWindows = !StartupRegistryService.IsEnabled();
        StartupRegistryService.SetEnabled(_config.StartWithWindows);
        _configService.Save(_config);
        _startupItem.Checked = _config.StartWithWindows;
    }

    private void ApplyConfigRuntime()
    {
        RebuildVaultsMenu();
        var actualStartup = StartupRegistryService.IsEnabled();
        _config.StartWithWindows = actualStartup;
        _startupItem.Checked = actualStartup;

        _periodicTimer.Stop();
        if (_config.AutoSyncIntervalMinutes > 0)
        {
            _periodicTimer.Interval = Math.Max(1, _config.AutoSyncIntervalMinutes) * 60_000;
            _periodicTimer.Start();
        }

        RebuildWatchers();
        UpdateTrayVisual(TrayState.Idle, $"Idle ({_config.Vaults.Count} vault(s))");
        ConfigOrStatusUpdated?.Invoke();
    }

    private void RebuildVaultsMenu()
    {
        _vaultsMenu.DropDownItems.Clear();
        if (_config.Vaults.Count == 0)
        {
            _vaultsMenu.DropDownItems.Add(new ToolStripMenuItem("(No vaults configured)") { Enabled = false });
            return;
        }

        foreach (var v in _config.Vaults)
        {
            var item = new ToolStripMenuItem($"{v.Name}{(v.Enabled ? "" : " (disabled)")}");
            var vaultPath = v.Path;
            item.Click += (_, _) =>
            {
                if (Directory.Exists(vaultPath))
                {
                    var psi = new ProcessStartInfo("explorer.exe") { UseShellExecute = false };
                    psi.ArgumentList.Add(vaultPath);
                    Process.Start(psi);
                }
            };
            _vaultsMenu.DropDownItems.Add(item);
        }
    }

    private void RebuildWatchers()
    {
        foreach (var w in _watchers)
        {
            w.EnableRaisingEvents = false;
            w.Dispose();
        }
        _watchers.Clear();

        if (!_config.WatchFileChanges) return;

        foreach (var vault in _config.Vaults.Where(v => v.Enabled && Directory.Exists(v.Path)))
        {
            try
            {
                var watcher = new FileSystemWatcher(vault.Path)
                {
                    IncludeSubdirectories = true,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.DirectoryName,
                    EnableRaisingEvents = true
                };

                FileSystemEventHandler onChange = (_, e) => OnVaultFileEvent(e.FullPath);
                RenamedEventHandler onRename = (_, e) => OnVaultFileEvent(e.FullPath);

                watcher.Changed += onChange;
                watcher.Created += onChange;
                watcher.Deleted += onChange;
                watcher.Renamed += onRename;
                _watchers.Add(watcher);
            }
            catch (Exception ex)
            {
                AppendLog($"Watcher error for [{vault.Name}]: {ex.Message}");
            }
        }
    }

    private void OnVaultFileEvent(string fullPath)
    {
        if (_disposed) return;
        if (fullPath.Contains(@"\.git\", StringComparison.OrdinalIgnoreCase) ||
            fullPath.EndsWith(@"\.git", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        _uiContext.Post(_ =>
        {
            if (_disposed) return;
            _debounceTimer.Stop();
            _debounceTimer.Start();
        }, null);
    }

    private async Task RunSafeAsync(Func<Task> action, string contextName)
    {
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            _hasError = true;
            AppendLog($"{contextName} failed: {ex.Message}");
            if (!_disposed)
            {
                UpdateTrayVisual(TrayState.Error, $"{contextName} error");
            }
        }
    }

    public async Task SyncAllAsync(string trigger)
    {
        if (_disposed) return;
        bool acquired;
        try
        {
            acquired = await _syncLock.WaitAsync(0);
        }
        catch (ObjectDisposedException)
        {
            return;
        }
        if (!acquired) return;

        try
        {
            var enabledVaults = _config.Vaults.Where(v => v.Enabled).ToList();
            if (enabledVaults.Count == 0)
            {
                AppendLog($"{trigger}: no enabled vaults.");
                return;
            }

            UpdateTrayVisual(TrayState.Syncing, "Syncing...");
            AppendLog($"=== {trigger} ({enabledVaults.Count} vault(s)) ===");

            _hasError = false;
            foreach (var vault in enabledVaults)
            {
                if (_disposed) return;
                var result = await _gitSyncService.SyncVaultAsync(vault, _shutdownCts.Token);
                vault.LastSyncUtc = DateTime.UtcNow;
                vault.LastStatus = result.Success ? result.Summary : $"ERROR: {result.Summary}";

                AppendLog($"[{vault.Name}] {result.Summary}");
                if (!string.IsNullOrWhiteSpace(result.ErrorDetails))
                {
                    AppendLog($"  {result.ErrorDetails}");
                }

                if (!result.Success && !_disposed)
                {
                    _hasError = true;
                    _notifyIcon.ShowBalloonTip(
                        5000,
                        $"Obsync — {vault.Name}",
                        result.HadConflict
                            ? "Merge conflict detected (rebase aborted safely). Open Settings log."
                            : result.Summary,
                        ToolTipIcon.Warning);
                }
            }

            _configService.Save(_config);
            if (!_disposed)
            {
                UpdateTrayVisual(
                    _hasError ? TrayState.Error : TrayState.Idle,
                    _hasError ? "Last sync had errors" : $"Last sync {DateTime.Now:HH:mm}");
                ConfigOrStatusUpdated?.Invoke();
            }
        }
        catch (OperationCanceledException) when (_shutdownCts.IsCancellationRequested)
        {
            // App shutting down cleanly
        }
        finally
        {
            if (!_disposed)
            {
                try { _syncLock.Release(); } catch (ObjectDisposedException) { }
            }
        }
    }

    public async Task SyncSingleVaultAsync(VaultEntry vault)
    {
        if (_disposed) return;
        bool acquired;
        try
        {
            acquired = await _syncLock.WaitAsync(0);
        }
        catch (ObjectDisposedException)
        {
            return;
        }
        if (!acquired) return;

        try
        {
            UpdateTrayVisual(TrayState.Syncing, $"Syncing {vault.Name}...");
            var result = await _gitSyncService.SyncVaultAsync(vault, _shutdownCts.Token);
            vault.LastSyncUtc = DateTime.UtcNow;
            vault.LastStatus = result.Success ? result.Summary : $"ERROR: {result.Summary}";
            AppendLog($"[{vault.Name}] {result.Summary}");
            if (!string.IsNullOrWhiteSpace(result.ErrorDetails))
            {
                AppendLog($"  {result.ErrorDetails}");
            }
            _configService.Save(_config);
            if (!_disposed)
            {
                UpdateTrayVisual(
                    result.Success ? TrayState.Idle : TrayState.Error,
                    result.Success ? $"Synced {vault.Name}" : $"Error on {vault.Name}");
                ConfigOrStatusUpdated?.Invoke();
            }
        }
        catch (OperationCanceledException) when (_shutdownCts.IsCancellationRequested)
        {
            // App shutting down cleanly
        }
        finally
        {
            if (!_disposed)
            {
                try { _syncLock.Release(); } catch (ObjectDisposedException) { }
            }
        }
    }

    private void UpdateTrayVisual(TrayState state, string statusText)
    {
        if (_disposed) return;
        _notifyIcon.Icon = state switch
        {
            TrayState.Syncing => _syncingIcon,
            TrayState.Error => _errorIcon,
            _ => _idleIcon,
        };
        var tooltip = $"Obsync — {statusText}";
        _notifyIcon.Text = tooltip.Length > 63 ? tooltip[..63] : tooltip;
        _statusItem.Text = $"Status: {statusText}";
    }

    private void AppendLog(string message)
    {
        var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}";
        lock (_logLock)
        {
            _logs.Add(line);
            if (_logs.Count > 200)
            {
                _logs.RemoveAt(0);
            }
        }
        LogAppended?.Invoke(line);
    }

    private void OpenSettings()
    {
        if (_settingsForm is { IsDisposed: false })
        {
            _settingsForm.WindowState = FormWindowState.Normal;
            _settingsForm.BringToFront();
            _settingsForm.Activate();
            return;
        }

        _settingsForm = new SettingsForm(this);
        _settingsForm.Show();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _disposed = true;
            _shutdownCts.Cancel();
            _periodicTimer.Dispose();
            _debounceTimer.Dispose();
            foreach (var w in _watchers) w.Dispose();
            _watchers.Clear();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            _idleIcon.Dispose();
            _syncingIcon.Dispose();
            _errorIcon.Dispose();
            _shutdownCts.Dispose();
            if (_syncLock.CurrentCount > 0)
            {
                _syncLock.Dispose();
            }
        }
        base.Dispose(disposing);
    }
}
