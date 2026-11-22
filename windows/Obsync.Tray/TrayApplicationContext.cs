using System.Collections.Concurrent;
using System.Diagnostics;
using Obsync.Core.Models;
using Obsync.Core.Services;

namespace Obsync.Tray;

internal sealed class TrayApplicationContext : ApplicationContext
{
    private const int MaxLogEntries = 200;
    private const int MaxConcurrentVaultSyncs = 3;
    private static readonly TimeSpan PostSyncWatcherCooldown = TimeSpan.FromSeconds(3);

    private readonly TrayConfigService _configService = new();
    private readonly GitSyncService _gitSyncService = new();
    private readonly SemaphoreSlim _concurrencyGate = new(MaxConcurrentVaultSyncs, MaxConcurrentVaultSyncs);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _vaultLocks = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, byte> _activeSyncVaults = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, DateTime> _suppressWatchUntilUtc = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, byte> _dirtyVaultPaths = new(StringComparer.OrdinalIgnoreCase);

    private readonly Icon _idleIcon;
    private readonly Icon _syncingIcon;
    private readonly Icon _errorIcon;

    private readonly ContextMenuStrip _contextMenu;
    private readonly NotifyIcon _notifyIcon;
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _vaultsMenu;
    private readonly ToolStripMenuItem _startupItem;
    private readonly System.Windows.Forms.Timer _periodicTimer;
    private readonly System.Windows.Forms.Timer _debounceTimer;

    private readonly List<FileSystemWatcher> _watchers = [];
    private readonly Queue<string> _logs = new(MaxLogEntries + 1);
    private readonly object _logLock = new();
    private readonly SynchronizationContext _uiContext;
    private readonly CancellationTokenSource _shutdownCts = new();

    private TrayConfig _config;
    private SettingsForm? _settingsForm;
    private int _activeSyncCount;
    private int _debouncePostPending;
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

        _contextMenu = new ContextMenuStrip();
        _contextMenu.Items.Add(_statusItem);
        _contextMenu.Items.Add(new ToolStripSeparator());
        _contextMenu.Items.Add("Sync Now", null, async (_, _) => await RunSafeAsync(() => SyncAllAsync("Manual sync"), "Manual sync"));
        _contextMenu.Items.Add(_vaultsMenu);
        _contextMenu.Items.Add("Settings...", null, (_, _) => OpenSettings());
        _contextMenu.Items.Add(_startupItem);
        _contextMenu.Items.Add(new ToolStripSeparator());
        _contextMenu.Items.Add("Exit", null, (_, _) => ExitThread());

        _notifyIcon = new NotifyIcon
        {
            Icon = _idleIcon,
            Text = "Obsync — Idle",
            ContextMenuStrip = _contextMenu,
            Visible = true
        };
        _notifyIcon.DoubleClick += (_, _) => OpenSettings();

        _periodicTimer = new System.Windows.Forms.Timer();
        _periodicTimer.Tick += async (_, _) => await RunSafeAsync(() => SyncAllAsync("Scheduled sync"), "Scheduled sync");

        _debounceTimer = new System.Windows.Forms.Timer { Interval = 15_000 };
        _debounceTimer.Tick += async (_, _) =>
        {
            _debounceTimer.Stop();
            await RunSafeAsync(SyncDirtyVaultsAsync, "Auto sync");
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
        var oldItems = _vaultsMenu.DropDownItems.Cast<ToolStripItem>().ToList();
        _vaultsMenu.DropDownItems.Clear();
        foreach (var old in oldItems)
        {
            old.Dispose();
        }

        if (_config.Vaults.Count == 0)
        {
            _vaultsMenu.DropDownItems.Add(new ToolStripMenuItem("(No vaults configured)") { Enabled = false });
            return;
        }

        var explorerPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "explorer.exe");

        foreach (var v in _config.Vaults)
        {
            var item = new ToolStripMenuItem($"{v.Name}{(v.Enabled ? "" : " (disabled)")}");
            var vaultPath = v.Path;
            item.Click += (_, _) =>
            {
                if (Directory.Exists(vaultPath))
                {
                    var psi = new ProcessStartInfo(explorerPath) { UseShellExecute = false };
                    psi.ArgumentList.Add(vaultPath);
                    using var proc = Process.Start(psi);
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
                var vaultKey = NormalizeVaultKey(vault.Path);
                var vaultName = vault.Name;
                var watcher = new FileSystemWatcher(vault.Path)
                {
                    IncludeSubdirectories = true,
                    InternalBufferSize = 32_768,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.DirectoryName,
                    EnableRaisingEvents = true
                };

                FileSystemEventHandler onChange = (_, e) => OnVaultFileEvent(vaultKey, e.FullPath);
                RenamedEventHandler onRename = (_, e) => OnVaultFileEvent(vaultKey, e.FullPath);
                ErrorEventHandler onError = (_, e) =>
                {
                    AppendLog($"Watcher buffer warning for [{vaultName}]: {e.GetException().Message}");
                    MarkVaultDirtyAndSchedule(vaultKey);
                };

                watcher.Changed += onChange;
                watcher.Created += onChange;
                watcher.Deleted += onChange;
                watcher.Renamed += onRename;
                watcher.Error += onError;
                _watchers.Add(watcher);
            }
            catch (Exception ex)
            {
                AppendLog($"Watcher error for [{vault.Name}]: {ex.Message}");
            }
        }
    }

    private static string NormalizeVaultKey(string path) =>
        Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    private static bool IsIgnoredWatcherPath(string fullPath)
    {
        if (fullPath.Contains(@"\.git\", StringComparison.OrdinalIgnoreCase) ||
            fullPath.EndsWith(@"\.git", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (fullPath.Contains(@"\.trash\", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        // Ignore high-churn Obsidian UI layout/workspace files
        if (fullPath.EndsWith(@"\.obsidian\workspace.json", StringComparison.OrdinalIgnoreCase) ||
            fullPath.EndsWith(@"\.obsidian\workspace-mobile.json", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var fileName = Path.GetFileName(fullPath);
        if (string.IsNullOrEmpty(fileName)) return true;

        if (fileName.StartsWith('~') ||
            fileName.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase) ||
            fileName.EndsWith(".swp", StringComparison.OrdinalIgnoreCase) ||
            fileName.StartsWith("obsync-recovery-key", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return false;
    }

    private void OnVaultFileEvent(string vaultKey, string fullPath)
    {
        if (_disposed) return;
        if (IsIgnoredWatcherPath(fullPath)) return;

        // Suppress self-triggered events caused by git pull / .gitignore writes
        if (_activeSyncVaults.ContainsKey(vaultKey)) return;
        if (_suppressWatchUntilUtc.TryGetValue(vaultKey, out var untilUtc) && DateTime.UtcNow < untilUtc)
        {
            return;
        }

        MarkVaultDirtyAndSchedule(vaultKey);
    }

    private void MarkVaultDirtyAndSchedule(string vaultKey)
    {
        _dirtyVaultPaths[vaultKey] = 0;

        // Coalesce bursts of filesystem events into a single UI-thread timer reset
        if (Interlocked.Exchange(ref _debouncePostPending, 1) == 0)
        {
            _uiContext.Post(_ =>
            {
                Interlocked.Exchange(ref _debouncePostPending, 0);
                if (_disposed) return;
                _debounceTimer.Stop();
                _debounceTimer.Start();
            }, null);
        }
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

    private async Task SyncDirtyVaultsAsync()
    {
        if (_disposed) return;
        var dirtyKeys = _dirtyVaultPaths.Keys.ToList();
        foreach (var k in dirtyKeys)
        {
            _dirtyVaultPaths.TryRemove(k, out _);
        }
        if (dirtyKeys.Count == 0) return;

        var dirtySet = new HashSet<string>(dirtyKeys, StringComparer.OrdinalIgnoreCase);
        var targets = _config.Vaults
            .Where(v => v.Enabled && !string.IsNullOrWhiteSpace(v.Path) && dirtySet.Contains(NormalizeVaultKey(v.Path)))
            .ToList();

        if (targets.Count == 0) return;
        await SyncVaultSetAsync(targets, "File change detected");
    }

    public async Task SyncAllAsync(string trigger)
    {
        if (_disposed) return;
        var enabledVaults = _config.Vaults.Where(v => v.Enabled).ToList();
        if (enabledVaults.Count == 0)
        {
            AppendLog($"{trigger}: no enabled vaults.");
            return;
        }
        await SyncVaultSetAsync(enabledVaults, trigger);
    }

    private async Task SyncVaultSetAsync(List<VaultEntry> vaults, string trigger)
    {
        if (_disposed) return;
        Interlocked.Increment(ref _activeSyncCount);
        UpdateTrayVisual(TrayState.Syncing, "Syncing...");
        AppendLog($"=== {trigger} ({vaults.Count} vault(s)) ===");

        try
        {
            var results = await Task.WhenAll(vaults.Select(v => SyncVaultInternalAsync(v)));
            bool batchError = false;

            foreach (var (vault, result) in results)
            {
                if (result is null) continue;
                vault.LastSyncUtc = DateTime.UtcNow;
                vault.LastStatus = result.Success ? result.Summary : $"ERROR: {result.Summary}";

                AppendLog($"[{vault.Name}] {result.Summary}");
                if (!string.IsNullOrWhiteSpace(result.ErrorDetails))
                {
                    AppendLog($"  {result.ErrorDetails}");
                }

                if (!result.Success && !_disposed)
                {
                    batchError = true;
                    _notifyIcon.ShowBalloonTip(
                        5000,
                        $"Obsync — {vault.Name}",
                        result.HadConflict
                            ? "Merge conflict detected (rebase aborted safely). Open Settings log."
                            : result.Summary,
                        ToolTipIcon.Warning);
                }
            }

            _hasError = batchError;
            _configService.Save(_config);
            if (!_disposed)
            {
                ConfigOrStatusUpdated?.Invoke();
            }
        }
        catch (OperationCanceledException) when (_shutdownCts.IsCancellationRequested)
        {
            // App shutting down cleanly
        }
        finally
        {
            int remaining = Interlocked.Decrement(ref _activeSyncCount);
            if (remaining <= 0 && !_disposed)
            {
                UpdateTrayVisual(
                    _hasError ? TrayState.Error : TrayState.Idle,
                    _hasError ? "Last sync had errors" : $"Last sync {DateTime.Now:HH:mm}");
            }
        }
    }

    public async Task SyncSingleVaultAsync(VaultEntry vault)
    {
        if (_disposed) return;
        Interlocked.Increment(ref _activeSyncCount);
        UpdateTrayVisual(TrayState.Syncing, $"Syncing {vault.Name}...");

        try
        {
            var (_, result) = await SyncVaultInternalAsync(vault);
            if (result is null) return;

            vault.LastSyncUtc = DateTime.UtcNow;
            vault.LastStatus = result.Success ? result.Summary : $"ERROR: {result.Summary}";
            AppendLog($"[{vault.Name}] {result.Summary}");
            if (!string.IsNullOrWhiteSpace(result.ErrorDetails))
            {
                AppendLog($"  {result.ErrorDetails}");
            }
            _hasError = !result.Success;
            _configService.Save(_config);
            if (!_disposed)
            {
                ConfigOrStatusUpdated?.Invoke();
            }
        }
        catch (OperationCanceledException) when (_shutdownCts.IsCancellationRequested)
        {
            // App shutting down cleanly
        }
        finally
        {
            int remaining = Interlocked.Decrement(ref _activeSyncCount);
            if (remaining <= 0 && !_disposed)
            {
                UpdateTrayVisual(
                    _hasError ? TrayState.Error : TrayState.Idle,
                    _hasError ? $"Error on {vault.Name}" : $"Synced {vault.Name}");
            }
        }
    }

    private async Task<(VaultEntry Vault, SyncResult? Result)> SyncVaultInternalAsync(VaultEntry vault)
    {
        if (_disposed) return (vault, null);
        var vaultKey = string.IsNullOrWhiteSpace(vault.Path) ? vault.Name : NormalizeVaultKey(vault.Path);
        var vaultLock = _vaultLocks.GetOrAdd(vaultKey, _ => new SemaphoreSlim(1, 1));

        bool lockAcquired;
        try
        {
            lockAcquired = await vaultLock.WaitAsync(0);
        }
        catch (ObjectDisposedException)
        {
            return (vault, null);
        }
        if (!lockAcquired) return (vault, null);

        bool gateAcquired = false;
        try
        {
            await _concurrencyGate.WaitAsync(_shutdownCts.Token);
            gateAcquired = true;
            _activeSyncVaults[vaultKey] = 0;

            var result = await _gitSyncService.SyncVaultAsync(vault, _shutdownCts.Token);
            return (vault, result);
        }
        finally
        {
            _suppressWatchUntilUtc[vaultKey] = DateTime.UtcNow.Add(PostSyncWatcherCooldown);
            _activeSyncVaults.TryRemove(vaultKey, out _);
            if (gateAcquired && !_disposed)
            {
                try { _concurrencyGate.Release(); } catch (ObjectDisposedException) { }
            }
            if (!_disposed)
            {
                try { vaultLock.Release(); } catch (ObjectDisposedException) { }
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
            _logs.Enqueue(line);
            while (_logs.Count > MaxLogEntries)
            {
                _logs.Dequeue();
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
            if (_settingsForm is { IsDisposed: false })
            {
                _settingsForm.Close();
                _settingsForm.Dispose();
            }
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            _contextMenu.Dispose();
            _idleIcon.Dispose();
            _syncingIcon.Dispose();
            _errorIcon.Dispose();
            _shutdownCts.Dispose();
            if (_concurrencyGate.CurrentCount == MaxConcurrentVaultSyncs)
            {
                _concurrencyGate.Dispose();
            }
            foreach (var sem in _vaultLocks.Values)
            {
                if (sem.CurrentCount > 0) sem.Dispose();
            }
            _vaultLocks.Clear();
        }
        base.Dispose(disposing);
    }
}
