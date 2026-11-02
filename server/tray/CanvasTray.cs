using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

// 画面右下角托盘里的小图标：管着后台那份画布服务。
// 双击图标 = 打开画布；右键 = 打开画布 / 接口通道 / 重启 / 退出。
// 它自己没有窗口，任务栏上不占位置，也不会被顺手关掉。
namespace CanvasTray
{
    static class Program
    {
        const string MutexName = "LocalInfiniteCanvasTray_v1";
        public const string ShowEventName = "LocalInfiniteCanvasTray_Show_v1";

        [STAThread]
        static void Main(string[] args)
        {
            bool created;
            using (var mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    // 已经有一个托盘在跑了：让它把画布打开，自己立刻退出
                    try
                    {
                        using (var ev = EventWaitHandle.OpenExisting(ShowEventName)) ev.Set();
                    }
                    catch { }
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                string root = AppDomain.CurrentDomain.BaseDirectory;
                root = Path.GetFullPath(root);
                // 放在根目录直接双击也能找到画布；从 server\tray 启动则回到项目根
                if (!Directory.Exists(Path.Combine(root, "web")) && File.Exists(Path.Combine(root, "..", "web", "index.html")))
                    root = Path.GetFullPath(Path.Combine(root, "..", ".."));
                Application.Run(new TrayApp(root));
            }
        }
    }

    sealed class TrayApp : ApplicationContext
    {
        readonly string root;
        readonly NotifyIcon icon;
        readonly System.Windows.Forms.Timer poll;
        readonly ToolStripMenuItem openItem;
        readonly ToolStripMenuItem channelsItem;
        readonly ToolStripMenuItem statusItem;
        readonly ToolStripMenuItem restartItem;
        int lastPort;
        bool sawRunning;

        public TrayApp(string root)
        {
            this.root = root;
            var menu = new ContextMenuStrip();
            menu.Font = new Font("Microsoft YaHei UI", 9F);

            statusItem = new ToolStripMenuItem("正在连接本机服务…");
            statusItem.Enabled = false;
            menu.Items.Add(statusItem);
            menu.Items.Add(new ToolStripSeparator());

            openItem = new ToolStripMenuItem("打开画布");
            openItem.Font = new Font(menu.Font, FontStyle.Bold);
            openItem.Click += (s, e) => OpenPath("/");
            menu.Items.Add(openItem);

            channelsItem = new ToolStripMenuItem("接口通道设置");
            channelsItem.Click += (s, e) => OpenPath("/channels", true);
            menu.Items.Add(channelsItem);
            menu.Items.Add(new ToolStripSeparator());

            restartItem = new ToolStripMenuItem("重启服务");
            restartItem.Click += (s, e) => Restart();
            menu.Items.Add(restartItem);

            menu.Items.Add(new ToolStripMenuItem("退出（停止画布服务）", null, (s, e) => Quit()));

            icon = new NotifyIcon();
            icon.Icon = BuildIcon();
            icon.Text = "本地无限画布 · 正在启动";
            icon.ContextMenuStrip = menu;
            icon.Visible = true;
            icon.DoubleClick += (s, e) => OpenPath("/");
            icon.BalloonTipClicked += (s, e) => OpenPath("/");

            poll = new System.Windows.Forms.Timer();
            poll.Interval = 2000;
            poll.Tick += (s, e) => Poll();
            poll.Start();

            // 别的窗口再点一次「启动画布」时，叫醒这里去开网页，不多开程序
            showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowEventName, out showEventCreated);
            ThreadPool.QueueUserWorkItem(_ => WatchShowRequests());

            ThreadPool.QueueUserWorkItem(_ => FirstRun());
        }

        EventWaitHandle showEvent;
        bool showEventCreated;

        void WatchShowRequests()
        {
            try
            {
                while (true)
                {
                    showEvent.WaitOne();
                    var info = Probe();
                    if (info != null)
                    {
                        OpenPath("/");
                    }
                    else
                    {
                        // 服务被停过：这次双击就顺手把它重新拉起来
                        EnsureServer();
                        sawRunning = false;
                        ThreadPool.QueueUserWorkItem(_ => FirstRun());
                    }
                }
            }
            catch { }
        }

        // 第一次启动时等后台服务起来，然后顺手把画布打开
        void FirstRun()
        {
            // 服务没在跑就先在后台把它拉起来
            EnsureServer();
            for (int i = 0; i < 60; i++)
            {
                Thread.Sleep(400);
                var info = Probe();
                if (info != null)
                {
                    Ui(() =>
                    {
                        Apply(info);
                        icon.BalloonTipTitle = "本地无限画布已在后台运行";
                        icon.BalloonTipText = "双击这个图标随时打开画布；右键可以退出服务。";
                        icon.ShowBalloonTip(4000);
                    });
                    Thread.Sleep(300);
                    OpenPath("/");
                    return;
                }
            }
        }

        void Poll()
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                var info = Probe();
                Ui(() => Apply(info));
            });
        }

        void Apply(Status info)
        {
            if (info == null)
            {
                if (sawRunning)
                {
                    sawRunning = false;
                    icon.Text = "本地无限画布 · 服务已停止";
                    statusItem.Text = "服务已停止";
                    openItem.Enabled = false;
                    channelsItem.Enabled = false;
                    restartItem.Enabled = true;
                }
                return;
            }
            sawRunning = true;
            lastPort = info.Port;
            icon.Text = "本地无限画布 · 运行中，双击打开";
            statusItem.Text = "运行中 · 127.0.0.1:" + info.Port;
            openItem.Enabled = true;
            channelsItem.Enabled = true;
            restartItem.Enabled = true;
        }

        void Ui(Action action)
        {
            try { icon.ContextMenuStrip.Invoke(action); } catch { }
        }

        void OpenPath(string path) { OpenPath(path, false); }

        void OpenPath(string path, bool appWindow)
        {
            var info = Probe();
            if (info == null)
            {
                MessageBox.Show("画布服务还没起来，稍等一下再点。\n如果一直这样，右键托盘图标点「重启服务」。",
                    "本地无限画布", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            string url = info.Url.TrimEnd('/') + path;
            try
            {
                if (appWindow)
                {
                    // 接口通道要独立的窗口，才拿得到本机钥匙
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "msedge.exe",
                        Arguments = "--app=" + url + " --window-size=1280,920",
                        UseShellExecute = true
                    });
                }
                else
                {
                    Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
                }
            }
            catch
            {
                try { Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true }); } catch { }
            }
        }

        void Restart()
        {
            var info = Probe();
            if (info != null && !Stop(info.Port, info.Token))
            {
                MessageBox.Show("停止服务失败，可能正在生成里保存素材。稍等几秒再试一次。",
                    "本地无限画布", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            Thread.Sleep(600);
            EnsureServer();
            sawRunning = false;
            statusItem.Text = "正在重新启动…";
            ThreadPool.QueueUserWorkItem(_ => FirstRun());
        }

        void Quit()
        {
            var info = Probe();
            if (info != null && !Stop(info.Port, info.Token))
            {
                var yes = MessageBox.Show("服务没能正常停下（可能正在保存素材）。\n要强制结束吗？",
                    "本地无限画布", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (yes != DialogResult.Yes) return;
                try { Process.GetProcessById(info.Pid).Kill(); } catch { }
            }
            poll.Stop();
            icon.Visible = false;
            ExitThread();
        }

        bool Stop(int port, string token)
        {
            try
            {
                using (var client = new HttpClient())
                {
                    client.Timeout = TimeSpan.FromSeconds(6);
                    var req = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:" + port + "/api/local/shutdown");
                    if (!string.IsNullOrEmpty(token)) req.Headers.Add("x-local-token", token);
                    using (var res = client.SendAsync(req).GetAwaiter().GetResult()) { /* 等服务自己退 */ }
                }
            }
            catch { }
            for (int i = 0; i < 40; i++)
            {
                Thread.Sleep(250);
                if (Probe() == null) return true;
            }
            return false;
        }

        readonly object startLock = new object();
        bool startInFlight;

        // 同一时刻只允许拉起一个服务进程，否则会起两份、抢同一批任务
        void EnsureServer()
        {
            lock (startLock)
            {
                if (startInFlight) return;
                if (Probe() != null) return;
                startInFlight = true;
            }
            try { StartServer(); }
            finally { lock (startLock) { startInFlight = false; } }
        }

        void StartServer()
        {
            string node = Path.Combine(root, "runtime", "node.exe");
            string script = Path.Combine(root, "server", "index.js");
            if (!File.Exists(node)) node = "node.exe";
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = node,
                    Arguments = "\"" + script + "\" --background",
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show("启动服务失败：" + ex.Message, "本地无限画布");
            }
        }

        sealed class Status
        {
            public int Port;
            public int Pid;
            public string Url;
            public string Token;
        }

        Status Probe()
        {
            // 端口从 runtime.json 读，钥匙从 admin-token.txt 读，都是本机文件
            int port = 0;
            int pid = 0;
            string url = "";
            try
            {
                string file = Path.Combine(root, "data", "runtime.json");
                if (!File.Exists(file)) return null;
                string raw = File.ReadAllText(file);
                port = (int)Grab(raw, "port");
                pid = (int)Grab(raw, "pid");
                url = GrabText(raw, "url");
                if (port <= 0) return null;
            }
            catch { return null; }

            string token = "";
            try
            {
                string tf = Path.Combine(root, "data", "admin-token.txt");
                if (File.Exists(tf)) token = File.ReadAllText(tf).Trim();
            }
            catch { }

            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/status");
                req.Timeout = 1200;
                req.ReadWriteTimeout = 1200;
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    string body = reader.ReadToEnd();
                    if (body.IndexOf("\"root\"", StringComparison.Ordinal) < 0) return null;
                }
            }
            catch { return null; }

            if (string.IsNullOrEmpty(url)) url = "http://127.0.0.1:" + port;
            return new Status { Port = port, Pid = pid, Url = url, Token = token };
        }

        static double Grab(string raw, string key)
        {
            var m = System.Text.RegularExpressions.Regex.Match(raw, "\"" + key + "\"\\s*:\\s*(\\d+)");
            return m.Success ? double.Parse(m.Groups[1].Value) : 0;
        }

        static string GrabText(string raw, string key)
        {
            var m = System.Text.RegularExpressions.Regex.Match(raw, "\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
            return m.Success ? m.Groups[1].Value : "";
        }

        // 自己画一个干净的图标：深蓝圆角方块 + 两道白色画布线条
        static Icon BuildIcon()
        {
            // 用根目录的小狗图标；读不到再用程序自带的
            try
            {
                string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
                string icoPath = Path.Combine(root, "dog.ico");
                if (!File.Exists(icoPath)) icoPath = Path.Combine(root, "..", "..", "dog.ico");
                if (!File.Exists(icoPath)) icoPath = Path.Combine(root, "..", "dog.ico");
                if (File.Exists(icoPath)) return new Icon(icoPath, 32, 32);
            }
            catch { }
            return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }

        static GraphicsPath RoundRect(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            int d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
