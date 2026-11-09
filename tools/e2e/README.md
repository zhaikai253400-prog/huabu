# tools/e2e · 端到端验证脚本

这些脚本从 `.tmp-test/` 挪进来长期保留。它们与 `tools/tests/` 的分工：

| | tools/tests | tools/e2e（本目录） |
|---|---|---|
| 层次 | 源码级断言、纯函数 | 端到端：起真服务 / 真浏览器 / 假 host |
| 速度 | 快（全量 46 个文件数秒） | 慢（每个起进程、占端口） |
| 进 run-all | 是 | 否（按需手动跑） |
| 能证明 | 规则没被改坏 | **真跑起来是对的** |

## 本目录的脚本

- `safety-net-e2e.js` —— 复现"版本错配把尾部预设写空"那次事故（10 项断言）
- `p1-crash-guard.js` —— 实测"有兜底 / 没兜底"时进程是否存活（17 项）
- `p2-static-deny.js` —— 造后缀文件验证静态闸 + 反向确认不误伤（20 项）
- `p3-codesync-remote.js` —— 假 host 跑通 codesync 备份失败的上报路径（8 项）
- `p5-final-regression.js` —— 收尾总核对：真实数据未动 / 服务能起 / 无未处理异常
- `p5-assetindex-bench.js` —— 量 asset-index 的 O(N²) 增长曲线（排查用）

## 什么时候跑

改动了这些地方之后建议跑一遍对应的：

- 改了 `server/config.js` 的尾部预设结构 / `/api/settings` 的保存校验 → `safety-net-e2e.js`
- 改了后台定时器 / 全局异常处理 → `p1-crash-guard.js`
- 改了静态文件服务（`serveStatic` / `serveHtmlWithTokens`） → `p2-static-deny.js`
- 改了 `server/codesync.js` 的备份或同步流程 → `p3-codesync-remote.js`
- 改完任何东西想做最后确认 → `p5-final-regression.js`

> `p3-codesync-remote.js` 会**临时覆盖** `server/logfile.js`（它是白名单里最小的
> 那个文件），跑完在 `finally` 里原样写回。想核对是否复原，
> 可以 `git diff server/logfile.js` —— 应当是空的。

## 关于 asset-index 的 O(N²)（2026-11-09 记录）

`server/asset-index.js` 的 `remember()` 每记一条素材都要
`readIndex()` + `writeIndex()`，也就是**读写整个 JSON 索引**，是 O(N²)。
实测的增长曲线：

| 条数 | 逐条 remember 总耗时 | 每条平均 | 索引大小 |
|---|---|---|---|
| 100 | 61 ms | 0.61 ms | 24 KB |
| 500 | 647 ms | 1.29 ms | 119 KB |
| 1000 | 2115 ms | 2.12 ms | 238 KB |
| 2000 | 7093 ms | 3.55 ms | 478 KB |
| 3000 | 15481 ms | 5.16 ms | 719 KB |

**结论：现在不改**。真实素材目录 230 个文件，按曲线每次记账约 1.2 ms ——
用户感受不到。但素材涨到几千之后上传会明显变慢，
所以把数字记在这里：**哪天觉得上传变慢，先看这里**。
（`asset-index.test.js` 里留了一条"250 条仍在毫秒级"的护栏，
超过 8 秒就报红，正好卡在这个转折点上。）

顺带：这个 O(N²) 曾让 `asset-index.test.js` 跑 **42.9 秒**
（它为了验 5000 条上限，循环调了 5005 次 remember），
占当时全量测试 55 秒的 77%，机器忙时还会偶发失败。
改成直接构造 entries 再调一次 `writeIndex`（走的仍是产品代码的裁剪分支），
覆盖度不减（33 → 34 项），耗时降到 0.5 秒，**全量从 55 秒降到 14 秒**。


## 2026-11-09 清理说明

清理 `.tmp-test/` 与 `.tmp-mut/` 时删掉了 204 个一次性排查脚本（探针、A/B 实验、变异中间产物等），
它们的结论已经写进《二次勘查报告》与正式测试；
`.tmp-mut/` 里还有 7 个文件（含 600KB 级的 canvas.js 旧副本）一并删除 ——
那种命名容易被误认为"真正的备份"。
