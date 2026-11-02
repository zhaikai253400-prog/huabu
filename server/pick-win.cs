using System;
using System.Text;
using System.Runtime.InteropServices;

// 让「选择文件夹」窗口压到浏览器上面。
public static class CanvasPickWin
{
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint threadId, EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int index, int value);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);

    public static IntPtr FindOwnDialog(int pid)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner != (uint)pid) return true;
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder name = new StringBuilder(128);
            GetClassName(hWnd, name, 128);
            if (name.ToString() == "#32770") { found = hWnd; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool IsTopMost(IntPtr hWnd) { return (GetWindowLong(hWnd, -20) & 8) != 0; }

    // 真正把窗口抬到最前：先挂到前台线程，绕开 Windows 的前台锁。
    public static bool Raise(IntPtr hWnd)
    {
        int style = GetWindowLong(hWnd, -20);
        if ((style & 8) == 0) SetWindowLong(hWnd, -20, style | 8);

        IntPtr fg = GetForegroundWindow();
        uint fgThread = 0;
        if (fg != IntPtr.Zero)
        {
            uint pid;
            fgThread = GetWindowThreadProcessId(fg, out pid);
        }
        uint myThread = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);

        bool ok = SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, 3);
        ShowWindow(hWnd, 5);
        BringWindowToTop(hWnd);
        SetForegroundWindow(hWnd);

        if (attached) AttachThreadInput(myThread, fgThread, false);
        return ok;
    }
}
