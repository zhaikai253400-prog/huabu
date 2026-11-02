using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Collections.Generic;

static class DogIcon
{
    const float S = 1024f;

    static GraphicsPath RR(RectangleF r, float rad)
    {
        var p = new GraphicsPath();
        float d = rad * 2f;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    static GraphicsPath Ellipse(float x, float y, float w, float h)
    {
        var p = new GraphicsPath();
        p.AddEllipse(x, y, w, h);
        return p;
    }

    static void DrawEar(Graphics g, float cx, float cy, float angle, bool flip)
    {
        var st = g.Save();
        g.TranslateTransform(cx, cy);
        g.RotateTransform(angle * (flip ? -1f : 1f));
        using (var b = new LinearGradientBrush(new RectangleF(-150, -230, 300, 460),
            Color.FromArgb(150, 96, 52), Color.FromArgb(96, 57, 28), 90f))
            g.FillEllipse(b, -150, -230, 300, 460);
        using (var b2 = new SolidBrush(Color.FromArgb(110, 190, 136, 88)))
            g.FillEllipse(b2, -86, -156, 172, 312);
        g.Restore(st);
    }

    static Bitmap Render(int size)
    {
        var big = new Bitmap(S > 0 ? 1024 : 1024, 1024, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(big))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);

            // 底板：深可可色圆角方块，狗头才跳得出来
            using (var bg = new GraphicsPath())
            {
                bg.AddPath(RR(new RectangleF(16, 16, 992, 992), 226), true);
                using (var br = new LinearGradientBrush(new RectangleF(0, 0, 1024, 1024),
                    Color.FromArgb(126, 82, 46), Color.FromArgb(58, 36, 21), 58f))
                    g.FillPath(br, bg);
                using (var sheen = new LinearGradientBrush(new RectangleF(0, 0, 1024, 620),
                    Color.FromArgb(70, 255, 231, 200), Color.FromArgb(0, 255, 231, 200), 90f))
                    g.FillPath(sheen, bg);
            }

            // 耳朵（画在头后面）
            DrawEar(g, 296, 468, 34f, false);
            DrawEar(g, 728, 468, 34f, true);

            // 头
            using (var head = Ellipse(272, 322, 480, 452))
            using (var hb = new LinearGradientBrush(new RectangleF(272, 322, 480, 452),
                Color.FromArgb(219, 165, 108), Color.FromArgb(178, 116, 65), 62f))
                g.FillPath(hb, head);

            // 头顶高光
            using (var gloss = new GraphicsPath())
            {
                gloss.AddEllipse(392, 352, 240, 132);
                using (var gb = new PathGradientBrush(gloss))
                {
                    gb.CenterColor = Color.FromArgb(96, 255, 236, 208);
                    gb.SurroundColors = new[] { Color.FromArgb(0, 255, 236, 208) };
                    g.FillPath(gb, gloss);
                }
            }

            // 嘴套
            using (var muz = Ellipse(372, 556, 280, 216))
            using (var mb = new LinearGradientBrush(new RectangleF(372, 556, 280, 216),
                Color.FromArgb(252, 240, 224), Color.FromArgb(230, 209, 184), 90f))
                g.FillPath(mb, muz);

            // 鼻子
            using (var nose = new GraphicsPath())
            {
                nose.AddBezier(462, 566, 492, 552, 532, 552, 562, 566);
                nose.AddBezier(562, 566, 578, 606, 552, 646, 512, 646);
                nose.AddBezier(512, 646, 472, 646, 446, 606, 462, 566);
                nose.CloseFigure();
                using (var nb = new LinearGradientBrush(new RectangleF(446, 552, 132, 96),
                    Color.FromArgb(66, 47, 37), Color.FromArgb(34, 23, 17), 90f))
                    g.FillPath(nb, nose);
                using (var hl = new SolidBrush(Color.FromArgb(70, 255, 255, 255)))
                    g.FillEllipse(hl, 486, 572, 40, 22);
            }

            // 嘴
            using (var pen = new Pen(Color.FromArgb(58, 38, 26), 13f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                g.DrawBezier(pen, 512, 640, 512, 668, 484, 684, 462, 676);
                g.DrawBezier(pen, 512, 640, 512, 668, 540, 684, 562, 676);
            }

            // 眼睛
            foreach (float ex in new float[] { 424f, 600f })
            {
                using (var eb = new SolidBrush(Color.FromArgb(38, 26, 19)))
                    g.FillEllipse(eb, ex - 33, 480, 66, 74);
                using (var h1 = new SolidBrush(Color.FromArgb(235, 255, 255, 255)))
                    g.FillEllipse(h1, ex - 20, 494, 26, 26);
                using (var h2 = new SolidBrush(Color.FromArgb(120, 255, 255, 255)))
                    g.FillEllipse(h2, ex + 4, 520, 13, 13);
            }

            // 腮红一点点
            foreach (float ex in new float[] { 352f, 672f })
            {
                using (var rb = new SolidBrush(Color.FromArgb(52, 232, 130, 104)))
                    g.FillEllipse(rb, ex - 46, 596, 92, 62);
            }
        }

        if (size >= 1024) return big;
        var small = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(small))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.Clear(Color.Transparent);
            using (var attrs = new ImageAttributes())
            {
                attrs.SetWrapMode(WrapMode.TileFlipXY);
                g.DrawImage(big, new Rectangle(0, 0, size, size),
                    0, 0, 1024, 1024, GraphicsUnit.Pixel, attrs);
            }
        }
        big.Dispose();
        return small;
    }

    // ---- ICO 写入：小尺寸用 BMP 帧，256 用 PNG 帧（Windows 全版本都认） ----
    static byte[] DibBytes(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        var ms = new MemoryStream();
        var bw = new BinaryWriter(ms);
        int maskRow = ((w + 31) / 32) * 4;
        int xorSize = w * h * 4;
        int andSize = maskRow * h;
        bw.Write(40);
        bw.Write(w);
        bw.Write(h * 2);
        bw.Write((short)1);
        bw.Write((short)32);
        bw.Write(0);
        bw.Write(xorSize + andSize);
        bw.Write(0); bw.Write(0); bw.Write(0); bw.Write(0);
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var row = new byte[w * 4];
            for (int y = h - 1; y >= 0; y--)
            {
                IntPtr p = IntPtr.Add(data.Scan0, y * data.Stride);
                System.Runtime.InteropServices.Marshal.Copy(p, row, 0, w * 4);
                bw.Write(row);
            }
        }
        finally { bmp.UnlockBits(data); }
        bw.Write(new byte[andSize]);
        bw.Flush();
        return ms.ToArray();
    }

    static byte[] PngBytes(Bitmap bmp)
    {
        var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return ms.ToArray();
    }

    static void WriteIco(string path, int[] sizes)
    {
        var frames = new List<byte[]>();
        var dims = new List<int>();
        foreach (int s in sizes)
        {
            using (var bmp = Render(s))
                frames.Add(s >= 256 ? PngBytes(bmp) : DibBytes(bmp));
            dims.Add(s);
        }
        using (var fs = new FileStream(path, FileMode.Create, FileAccess.Write))
        using (var bw = new BinaryWriter(fs))
        {
            bw.Write((short)0); bw.Write((short)1); bw.Write((short)frames.Count);
            int offset = 6 + 16 * frames.Count;
            for (int i = 0; i < frames.Count; i++)
            {
                int s = dims[i];
                bw.Write((byte)(s >= 256 ? 0 : s));
                bw.Write((byte)(s >= 256 ? 0 : s));
                bw.Write((byte)0); bw.Write((byte)0);
                bw.Write((short)1); bw.Write((short)32);
                bw.Write(frames[i].Length);
                bw.Write(offset);
                offset += frames[i].Length;
            }
            foreach (var f in frames) bw.Write(f);
        }
    }

    static void Main(string[] args)
    {
        string outDir = args.Length > 0 ? args[0] : ".";
        Directory.CreateDirectory(outDir);
        WriteIco(Path.Combine(outDir, "dog.ico"), new int[] { 16, 20, 24, 32, 40, 48, 64, 96, 128, 256 });
        foreach (int s in new int[] { 256, 64, 32, 16 })
        {
            using (var b = Render(s)) b.Save(Path.Combine(outDir, "preview-" + s + ".png"), ImageFormat.Png);
        }
        // 放大的小尺寸预览，方便肉眼判断 16px 是否还认得出
        using (var b16 = Render(16))
        using (var zoom = new Bitmap(256, 256, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(zoom))
            {
                g.Clear(Color.FromArgb(32, 32, 34));
                g.InterpolationMode = InterpolationMode.NearestNeighbor;
                g.PixelOffsetMode = PixelOffsetMode.Half;
                g.DrawImage(b16, new Rectangle(0, 0, 256, 256));
            }
            zoom.Save(Path.Combine(outDir, "preview-16-zoom.png"), ImageFormat.Png);
        }
        Console.WriteLine("OK");
    }
}
