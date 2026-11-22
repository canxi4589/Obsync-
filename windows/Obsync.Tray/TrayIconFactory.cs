using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace Obsync.Tray;

internal enum TrayState
{
    Idle,
    Syncing,
    Error
}

internal static class TrayIconFactory
{
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    public static Icon CreateStatusIcon(TrayState state)
    {
        using var bmp = new Bitmap(16, 16);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Color.Transparent);

        var bg = state switch
        {
            TrayState.Syncing => Color.FromArgb(245, 158, 11),
            TrayState.Error => Color.FromArgb(239, 68, 68),
            _ => Color.FromArgb(99, 102, 241),
        };

        using var bgBrush = new SolidBrush(bg);
        g.FillEllipse(bgBrush, 1, 1, 14, 14);

        using var borderPen = new Pen(Color.FromArgb(224, 231, 255), 1.2f);
        g.DrawEllipse(borderPen, 1, 1, 14, 14);

        using var innerBrush = new SolidBrush(Color.White);
        if (state == TrayState.Error)
        {
            g.FillRectangle(innerBrush, 7, 4, 2, 5);
            g.FillRectangle(innerBrush, 7, 10, 2, 2);
        }
        else if (state == TrayState.Syncing)
        {
            using var arcPen = new Pen(Color.White, 1.8f);
            g.DrawArc(arcPen, 4, 4, 8, 8, 25, 250);
        }
        else
        {
            using var checkPen = new Pen(Color.White, 1.8f);
            g.DrawLines(checkPen, [new Point(4, 8), new Point(7, 11), new Point(12, 5)]);
        }

        IntPtr hIcon = bmp.GetHicon();
        try
        {
            using var temp = Icon.FromHandle(hIcon);
            return (Icon)temp.Clone();
        }
        finally
        {
            DestroyIcon(hIcon);
        }
    }
}
