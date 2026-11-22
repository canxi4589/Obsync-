using System.Drawing;
using Obsync.Core.Models;

namespace Obsync.Tray;

internal sealed class SettingsForm : Form
{
    private readonly TrayApplicationContext _ctx;
    private readonly ListView _vaultList;
    private readonly NumericUpDown _intervalBox;
    private readonly CheckBox _watchBox;
    private readonly CheckBox _startupBox;
    private readonly TextBox _logBox;

    public SettingsForm(TrayApplicationContext ctx)
    {
        _ctx = ctx;

        Text = "Obsync Tray — Settings & Sync Status";
        Size = new Size(760, 500);
        MinimumSize = new Size(640, 420);
        StartPosition = FormStartPosition.CenterScreen;

        var tabs = new TabControl { Dock = DockStyle.Fill };

        // ── Tab 1: Vaults ───────────────────────────────────────────────────
        var vaultsPage = new TabPage("Vaults");
        _vaultList = new ListView
        {
            Dock = DockStyle.Fill,
            View = View.Details,
            FullRowSelect = true,
            GridLines = true,
            MultiSelect = false
        };
        _vaultList.Columns.Add("Name", 120);
        _vaultList.Columns.Add("Path", 230);
        _vaultList.Columns.Add("Remote", 160);
        _vaultList.Columns.Add("Enabled", 65);
        _vaultList.Columns.Add("Last Status", 160);

        var vaultBtnBar = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 44,
            Padding = new Padding(8, 6, 8, 6)
        };
        var btnAdd = new Button { Text = "Add Vault...", AutoSize = true };
        var btnEdit = new Button { Text = "Edit...", AutoSize = true };
        var btnRemove = new Button { Text = "Remove", AutoSize = true };
        var btnSyncOne = new Button { Text = "Sync Selected", AutoSize = true };
        var btnSyncAll1 = new Button { Text = "Sync All Now", AutoSize = true };

        btnAdd.Click += (_, _) => AddVault();
        btnEdit.Click += (_, _) => EditSelectedVault();
        btnRemove.Click += (_, _) => RemoveSelectedVault();
        btnSyncOne.Click += async (_, _) => await RunSafeUiAsync(SyncSelectedVaultAsync);
        btnSyncAll1.Click += async (_, _) => await RunSafeUiAsync(() => _ctx.SyncAllAsync("Manual sync"));

        vaultBtnBar.Controls.AddRange([btnAdd, btnEdit, btnRemove, btnSyncOne, btnSyncAll1]);
        vaultsPage.Controls.Add(_vaultList);
        vaultsPage.Controls.Add(vaultBtnBar);

        // ── Tab 2: Sync & Startup ───────────────────────────────────────────
        var syncPage = new TabPage("Sync & Startup") { Padding = new Padding(16) };
        var syncLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 2
        };

        var lblInterval = new Label
        {
            Text = "Auto-sync interval (minutes, 0 = manual only):",
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(0, 8, 12, 8)
        };
        _intervalBox = new NumericUpDown
        {
            Minimum = 0,
            Maximum = 1440,
            Value = Math.Clamp(_ctx.CurrentConfig.AutoSyncIntervalMinutes, 0, 1440),
            Width = 90
        };

        _watchBox = new CheckBox
        {
            Text = "Auto-sync 15s after saving files inside vaults",
            Checked = _ctx.CurrentConfig.WatchFileChanges,
            AutoSize = true,
            Margin = new Padding(0, 8, 0, 8)
        };

        _startupBox = new CheckBox
        {
            Text = "Start Obsync Tray automatically with Windows",
            Checked = _ctx.CurrentConfig.StartWithWindows,
            AutoSize = true,
            Margin = new Padding(0, 8, 0, 8)
        };

        var btnSaveSync = new Button
        {
            Text = "Save Settings",
            AutoSize = true,
            Margin = new Padding(0, 14, 0, 0)
        };
        btnSaveSync.Click += (_, _) => SaveSyncSettings();

        syncLayout.Controls.Add(lblInterval, 0, 0);
        syncLayout.Controls.Add(_intervalBox, 1, 0);
        syncLayout.SetColumnSpan(_watchBox, 2);
        syncLayout.Controls.Add(_watchBox, 0, 1);
        syncLayout.SetColumnSpan(_startupBox, 2);
        syncLayout.Controls.Add(_startupBox, 0, 2);
        syncLayout.Controls.Add(btnSaveSync, 0, 3);
        syncPage.Controls.Add(syncLayout);

        // ── Tab 3: Activity Log ─────────────────────────────────────────────
        var logPage = new TabPage("Activity Log");
        _logBox = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Both,
            WordWrap = false,
            Font = new Font("Consolas", 9.5f),
            BackColor = Color.FromArgb(15, 23, 42),
            ForeColor = Color.FromArgb(226, 232, 240)
        };

        var logBtnBar = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 44,
            Padding = new Padding(8, 6, 8, 6)
        };
        var btnSyncAll2 = new Button { Text = "Sync All Now", AutoSize = true };
        var btnClearLog = new Button { Text = "Clear Log", AutoSize = true };
        btnSyncAll2.Click += async (_, _) => await RunSafeUiAsync(() => _ctx.SyncAllAsync("Manual sync"));
        btnClearLog.Click += (_, _) =>
        {
            _ctx.ClearLogs();
            _logBox.Clear();
        };
        logBtnBar.Controls.AddRange([btnSyncAll2, btnClearLog]);
        logPage.Controls.Add(_logBox);
        logPage.Controls.Add(logBtnBar);

        tabs.TabPages.AddRange([vaultsPage, syncPage, logPage]);
        Controls.Add(tabs);

        RefreshVaultList();
        _logBox.Lines = _ctx.GetLogsSnapshot().ToArray();

        _ctx.LogAppended += OnLogAppended;
        _ctx.ConfigOrStatusUpdated += OnConfigOrStatusUpdated;
    }

    private void OnLogAppended(string line)
    {
        if (IsDisposed || !IsHandleCreated) return;
        BeginInvoke(() =>
        {
            _logBox.AppendText(line + Environment.NewLine);
        });
    }

    private void OnConfigOrStatusUpdated()
    {
        if (IsDisposed || !IsHandleCreated) return;
        BeginInvoke(RefreshVaultList);
    }

    private void RefreshVaultList()
    {
        _vaultList.Items.Clear();
        foreach (var v in _ctx.CurrentConfig.Vaults)
        {
            var item = new ListViewItem(v.Name);
            item.SubItems.Add(v.Path);
            item.SubItems.Add(string.IsNullOrWhiteSpace(v.RemoteUrl) ? "(existing)" : v.RemoteUrl);
            item.SubItems.Add(v.Enabled ? "Yes" : "No");
            item.SubItems.Add(v.LastStatus ?? "Never synced");
            item.Tag = v;
            _vaultList.Items.Add(item);
        }
    }

    private void AddVault()
    {
        using var dlg = new VaultEditorDialog(null);
        if (dlg.ShowDialog(this) != DialogResult.OK) return;

        var cfg = _ctx.CurrentConfig;
        cfg.Vaults.Add(dlg.Vault);
        _ctx.UpdateConfig(cfg);
    }

    private void EditSelectedVault()
    {
        if (_vaultList.SelectedItems.Count == 0) return;
        var selected = (VaultEntry)_vaultList.SelectedItems[0].Tag!;
        using var dlg = new VaultEditorDialog(selected);
        if (dlg.ShowDialog(this) != DialogResult.OK) return;

        selected.Name = dlg.Vault.Name;
        selected.Path = dlg.Vault.Path;
        selected.RemoteUrl = dlg.Vault.RemoteUrl;
        selected.CommitMessage = dlg.Vault.CommitMessage;
        selected.Enabled = dlg.Vault.Enabled;
        _ctx.UpdateConfig(_ctx.CurrentConfig);
    }

    private void RemoveSelectedVault()
    {
        if (_vaultList.SelectedItems.Count == 0) return;
        var selected = (VaultEntry)_vaultList.SelectedItems[0].Tag!;
        if (MessageBox.Show(
            $"Remove vault '{selected.Name}' from Obsync Tray? (Files on disk will NOT be deleted.)",
            "Remove Vault",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question) != DialogResult.Yes)
        {
            return;
        }

        _ctx.CurrentConfig.Vaults.Remove(selected);
        _ctx.UpdateConfig(_ctx.CurrentConfig);
    }

    private async Task SyncSelectedVaultAsync()
    {
        if (_vaultList.SelectedItems.Count == 0) return;
        var selected = (VaultEntry)_vaultList.SelectedItems[0].Tag!;
        await _ctx.SyncSingleVaultAsync(selected);
    }

    private async Task RunSafeUiAsync(Func<Task> action)
    {
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "Obsync Sync Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void SaveSyncSettings()
    {
        var cfg = _ctx.CurrentConfig;
        cfg.AutoSyncIntervalMinutes = (int)_intervalBox.Value;
        cfg.WatchFileChanges = _watchBox.Checked;
        cfg.StartWithWindows = _startupBox.Checked;
        _ctx.UpdateConfig(cfg);
        MessageBox.Show("Settings saved.", "Obsync Tray", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _ctx.LogAppended -= OnLogAppended;
            _ctx.ConfigOrStatusUpdated -= OnConfigOrStatusUpdated;
        }
        base.Dispose(disposing);
    }

    private sealed class VaultEditorDialog : Form
    {
        private readonly TextBox _nameBox;
        private readonly TextBox _pathBox;
        private readonly TextBox _remoteBox;
        private readonly TextBox _commitBox;
        private readonly CheckBox _enabledBox;

        public VaultEntry Vault { get; }

        public VaultEditorDialog(VaultEntry? existing)
        {
            Text = existing is null ? "Add Obsidian Vault" : "Edit Vault";
            Size = new Size(490, 290);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterParent;

            Vault = new VaultEntry
            {
                Name = existing?.Name ?? string.Empty,
                Path = existing?.Path ?? string.Empty,
                RemoteUrl = existing?.RemoteUrl,
                CommitMessage = existing?.CommitMessage ?? "sync: {timestamp}",
                Enabled = existing?.Enabled ?? true
            };

            var table = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(14),
                ColumnCount = 3
            };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            _nameBox = new TextBox { Text = Vault.Name, Dock = DockStyle.Fill };
            _pathBox = new TextBox { Text = Vault.Path, Dock = DockStyle.Fill };
            var browseBtn = new Button { Text = "Browse...", AutoSize = true };
            browseBtn.Click += (_, _) =>
            {
                using var fbd = new FolderBrowserDialog();
                if (Directory.Exists(_pathBox.Text)) fbd.InitialDirectory = _pathBox.Text;
                if (fbd.ShowDialog(this) == DialogResult.OK)
                {
                    _pathBox.Text = fbd.SelectedPath;
                    if (string.IsNullOrWhiteSpace(_nameBox.Text))
                        _nameBox.Text = Path.GetFileName(fbd.SelectedPath);
                }
            };

            _remoteBox = new TextBox
            {
                Text = Vault.RemoteUrl ?? string.Empty,
                PlaceholderText = "Optional — leave blank to use existing git origin",
                Dock = DockStyle.Fill
            };
            _commitBox = new TextBox { Text = Vault.CommitMessage, Dock = DockStyle.Fill };
            _enabledBox = new CheckBox { Text = "Enable auto-sync for this vault", Checked = Vault.Enabled, AutoSize = true };

            table.Controls.Add(new Label { Text = "Name:", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0);
            table.Controls.Add(_nameBox, 1, 0);
            table.SetColumnSpan(_nameBox, 2);

            table.Controls.Add(new Label { Text = "Folder:", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 1);
            table.Controls.Add(_pathBox, 1, 1);
            table.Controls.Add(browseBtn, 2, 1);

            table.Controls.Add(new Label { Text = "Remote URL:", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 2);
            table.Controls.Add(_remoteBox, 1, 2);
            table.SetColumnSpan(_remoteBox, 2);

            table.Controls.Add(new Label { Text = "Commit Msg:", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 3);
            table.Controls.Add(_commitBox, 1, 3);
            table.SetColumnSpan(_commitBox, 2);

            table.Controls.Add(_enabledBox, 1, 4);
            table.SetColumnSpan(_enabledBox, 2);

            var okBtn = new Button { Text = "Save", DialogResult = DialogResult.None, AutoSize = true };
            var cancelBtn = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };
            okBtn.Click += (_, _) =>
            {
                if (string.IsNullOrWhiteSpace(_nameBox.Text) || !Directory.Exists(_pathBox.Text))
                {
                    MessageBox.Show("Enter a vault name and an existing folder path.", "Validation", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                Vault.Name = _nameBox.Text.Trim();
                Vault.Path = Path.GetFullPath(_pathBox.Text.Trim());
                Vault.RemoteUrl = string.IsNullOrWhiteSpace(_remoteBox.Text) ? null : _remoteBox.Text.Trim();
                Vault.CommitMessage = string.IsNullOrWhiteSpace(_commitBox.Text) ? "sync: {timestamp}" : _commitBox.Text.Trim();
                Vault.Enabled = _enabledBox.Checked;
                DialogResult = DialogResult.OK;
                Close();
            };

            var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 42, Padding = new Padding(10, 6, 10, 6) };
            bottom.Controls.AddRange([cancelBtn, okBtn]);

            AcceptButton = okBtn;
            CancelButton = cancelBtn;
            Controls.Add(table);
            Controls.Add(bottom);
        }
    }
}
