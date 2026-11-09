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
- `p1-crash-guard.js` —— 实测"有兜底 / 没兜底"时进程是否存活
- `p2-static-deny.js` —— 造后缀文件验证静态闸 + 反向确认不误伤
- `p3-codesync-remote.js` —— 假 host 跑通 codesync 备份失败的上报路径

## 什么时候跑

改动了这些地方之后建议跑一遍对应的：

- 改了 `server/config.js` 的尾部预设结构 / `/api/settings` 的保存校验 → `safety-net-e2e.js`
- 改了后台定时器 / 全局异常处理 → `p1-crash-guard.js`
- 改了静态文件服务（`serveStatic` / `serveHtmlWithTokens`） → `p2-static-deny.js`
- 改了 `server/codesync.js` 的备份或同步流程 → `p3-codesync-remote.js`

## 2026-11-09 清理说明

清理 `.tmp-test/` 与 `.tmp-mut/` 时删掉了 204 个一次性排查脚本（探针、A/B 实验、变异中间产物等），
它们的结论已经写进《二次勘查报告》与正式测试；
`.tmp-mut/` 里还有 7 个文件（含 600KB 级的 canvas.js 旧副本）一并删除 ——
那种命名容易被误认为"真正的备份"。
