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
        readonly ToolStripMenuItem updateItem;
        readonly ToolStripMenuItem codesyncItem;
        readonly ToolStripMenuItem statusItem;
        readonly ToolStripMenuItem restartItem;
        readonly ToolStripMenuItem officeItem;
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

            // 「检查画布更新」放在打开画布下面：它是画布相关的事，但只是偶尔用一次，
            // 所以放托盘里，不占画布界面。点开才查，平时完全不存在。
            updateItem = new ToolStripMenuItem("检查画布更新…");
            updateItem.Click += (s, e) => OpenPath("/update", true);
            menu.Items.Add(updateItem);

            // 「同步程序代码…」：另一台电脑上点这个，从主机拉取最新的程序文件。
            // 只搬 web/server/tools/runtime 这些程序本身，画布库和素材库各存各的，永不传输。
            // 和「检查画布更新」一样不常用，所以只放在托盘里。
            codesyncItem = new ToolStripMenuItem("同步程序代码…");
            codesyncItem.Click += (s, e) => OpenPath("/codesync", true);
            menu.Items.Add(codesyncItem);

            channelsItem = new ToolStripMenuItem("接口通道设置");
            channelsItem.Click += (s, e) => OpenPath("/channels", true);
            menu.Items.Add(channelsItem);

            // Agent Office：派活给 Codex / DeepSeek，以及"分镜 → 资产图 → 视频"流水线。
            // 放在画布入口旁边是有意的 —— 这两件事本来就是一前一后：
            // 在办公室派活生产，素材落到画布上，人再回画布看/改。
            officeItem = new ToolStripMenuItem("Agent Office 派活");
            officeItem.Click += (s, e) => OpenOffice();
            menu.Items.Add(officeItem);

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
                        ApplyOffice(OfficeUp());
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
                bool office = OfficeUp();
                Ui(() => { Apply(info); ApplyOffice(office); });
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
                    updateItem.Enabled = false;
                    codesyncItem.Enabled = false;
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
            updateItem.Enabled = true;
            codesyncItem.Enabled = true;
            channelsItem.Enabled = true;
            restartItem.Enabled = true;
        }

        // Office 的可用性单独探查：它是另一个进程、另一个端口。
        // 画布在跑不代表 Office 在跑，所以不能共用一份状态。
        void ApplyOffice(bool up)
        {
            if (officeItem == null) return;
            officeItem.Enabled = true;   // 不在跑也能点 —— 点了会把它拉起来
            officeItem.Text = up ? "Agent Office 派活 · 运行中" : "Agent Office 派活";
        }

        void Ui(Action action)
        {
            try { icon.ContextMenuStrip.Invoke(action); } catch { }
        }

        void OpenPath(string path) { OpenPath(path, false); }

        // ---- Agent Office ----
        //
        // 独立于画布服务：Office 是另一个程序（本仓库之外），有自己的端口。
        // 找不到它时给出可操作的提示，而不是静默什么都不发生 ——
        // 点了菜单没反应是最让人困惑的失败方式。
        const int OfficePort = 8848;

        static string OfficeDir()
        {
            // 默认路径放在环境变量里可覆盖，换机器不用改这份代码。
            string env = Environment.GetEnvironmentVariable("AGENT_OFFICE_DIR");
            if (!string.IsNullOrEmpty(env) && Directory.Exists(env)) return env;

            string fallback = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "deepseek-harness", "default-workspace", "agent-office");
            return fallback;
        }

        static bool OfficeUp()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(
                    "http://127.0.0.1:" + OfficePort + "/api/health");
                req.Timeout = 1200;
                req.ReadWriteTimeout = 1200;
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    string body = reader.ReadToEnd();
                    // 核对身份：8848 上可能是别的程序，别把它当 Office 打开
                    return body.IndexOf("\"pipeline_running\"", StringComparison.Ordinal) >= 0
                        || body.IndexOf("\"subscribers\"", StringComparison.Ordinal) >= 0;
                }
            }
            catch { return false; }
        }

        void OpenOffice()
        {
            if (!OfficeUp() && !StartOffice())
            {
                MessageBox.Show(
                    "没找到 Agent Office，也没能把它启动起来。\n\n"
                    + "期望的目录：\n" + OfficeDir() + "\n\n"
                    + "如果它装在别处，设一个环境变量 AGENT_OFFICE_DIR 指向那个目录即可。",
                    "Agent Office", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            // 服务刚起来要几秒，等它响应再开页面，否则开出来是错误页
            for (int i = 0; i < 25; i++)
            {
                if (OfficeUp()) break;
                Thread.Sleep(300);
            }

            string url = "http://127.0.0.1:" + OfficePort + "/";
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "msedge.exe",
                    Arguments = "--app=" + url + " --window-size=1280,920",
                    UseShellExecute = true
                });
            }
            catch
            {
                try { Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true }); }
                catch { }
            }
        }

        bool StartOffice()
        {
            string dir = OfficeDir();
            if (!Directory.Exists(dir)) return false;

            // 优先用 office.bat —— 它会自己挑 Python 并做版本检查
            string bat = Path.Combine(dir, "office.bat");
            try
            {
                if (File.Exists(bat))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = bat,
                        Arguments = "--serve",
                        WorkingDirectory = dir,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    });
                    return true;
                }

                string py = Path.Combine(dir, "python.exe");
                Process.Start(new ProcessStartInfo
                {
                    FileName = File.Exists(py) ? py : "python",
                    Arguments = "-m office --serve",
                    WorkingDirectory = dir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                });
                return true;
            }
            catch
            {
                return false;
            }
        }

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
