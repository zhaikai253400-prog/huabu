using System;
using System.IO;
using System.Security.Cryptography;

// 给 Node 侧调用的最小 DPAPI 外壳：读 stdin 的字节，保护/解封后写 stdout。
//
// 为什么单独做一个小程序：
//   · Node 没有内置 DPAPI，项目又不引第三方依赖；
//   · 走 PowerShell 每次要 1.4 秒，而这里只要 30~110 毫秒 —— 启动时解一次主密钥，
//     这个差距直接体现在「双击图标到页面能开」的等待上。
// 用途只有一个：保护 data/secret.key 里的那把 AES 主密钥，别的文件一律不碰。
internal static class KeyBoxHelper
{
    private static int Main(string[] args)
    {
        if (args.Length != 1)
        {
            Console.Error.WriteLine("usage: KeyBoxHelper protect|unprotect  (stdin -> stdout)");
            return 2;
        }

        byte[] data;
        using (var buffer = new MemoryStream())
        {
            using (var stdin = Console.OpenStandardInput()) stdin.CopyTo(buffer);
            data = buffer.ToArray();
        }
        if (data.Length == 0)
        {
            Console.Error.WriteLine("stdin 是空的");
            return 3;
        }

        byte[] result;
        try
        {
            if (args[0] == "protect")
                result = ProtectedData.Protect(data, null, DataProtectionScope.CurrentUser);
            else if (args[0] == "unprotect")
                result = ProtectedData.Unprotect(data, null, DataProtectionScope.CurrentUser);
            else
            {
                Console.Error.WriteLine("未知模式：" + args[0]);
                return 2;
            }
        }
        catch (Exception error)
        {
            // 换了 Windows 用户或换了电脑，解不开就走这里。原因交给 Node 侧去告警，不要静默吞掉。
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 4;
        }

        using (var stdout = Console.OpenStandardOutput())
        {
            stdout.Write(result, 0, result.Length);
            stdout.Flush();
        }
        return 0;
    }
}