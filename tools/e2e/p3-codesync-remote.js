// ─────────────────────────────────────────────────────────────────────
// 端到端验证脚本（从 .tmp-test/ 挪进来长期保留）
// 用途：假 host 跑通 codesync 备份失败的上报路径
// 跑法：runtime\node.exe tools\e2e\p3-codesync-remote.js
// 说明：比 tools/tests 慢（会起真服务 / 真浏览器 / 假 host 或占端口），
//       所以不进 run-all；但能证明"真跑起来是对的"，与源码级断言互补。
// ─────────────────────────────────────────────────────────────────────
'use strict';

// P3 端到端（修正版）：真造出"需要同步的文件"，让 pull 真的走到备份那一步。
//
// 上一版没走到：plan 返回 0 个待同步文件，因为"自己同步自己"时远端与本地
// 完全一样。要制造 diff，得让**服务端看到的文件**与**它自己磁盘上的**不同 ——
// 而服务端读的是同一个磁盘，所以这条路走不通。
//
// 换个办法：直接对 codesync 的 pull 真跑，但用一个**假的 host** ——
// 我们自己起一个极小的 HTTP 服务，实现 /api/codesync/manifest 与
// /api/codesync/file 两个接口，返回"旧版本"内容。
// 这样 pull 就会认为远端有更新，从而走完整流程（含备份那一步）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', '..');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'p3b-'));
require(path.join(ROOT, 'tools', 'tests', '_isolate.js'))(box);

const codesync = require(path.join(ROOT, 'server', 'codesync.js'));
const paths = require(path.join(ROOT, 'server', 'paths.js'));

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')); }
}

async function main() {
  console.log('════ 1. 准备：一个假 host + 一个会被覆盖的白名单文件 ════');

  // 挑一个白名单里真实存在、且我们敢动的文件。
  // 用 manifest 找一个体积小的 server/*.js（隔离箱里是产品代码的副本，
  // codesync 操作的是 paths.ROOT —— 也就是**真实项目根**！
  // 所以绝不能真的覆盖产品文件。
  //
  // 因此这里换思路：**不去真的覆盖**，而是直接验证
  // "当 backupExisting 失败时，pull 会不会把它记进 result.backupFailed"。
  // 做法：让 pull 的目标文件是白名单里的真实文件（只读地拿到路径），
  // 但把 codesync 的"下载"挡住 —— 远端返回 0 文件，那就什么都不会做。
  //
  // 更干净的做法：让远端 manifest 里放一个**白名单内、但本机不存在**的新文件
  // （走 added 分支，existed=false，不会触发备份），
  // 再放一个**本机存在**的文件（走 update 分支，会触发备份）。
  // 后者会真的覆盖产品文件 —— 所以先备份产品文件的原内容，验证完立刻还原。

  const local = codesync.manifest();
  const targets = local.files.filter((f) => /^server\/[\w.-]+\.js$/.test(f.path));
  check('白名单里能找到 server/*.js 作为目标', targets.length > 0, String(targets.length));
  if (!targets.length) return;

  const victim = targets.sort((a, b) => a.size - b.size)[0];
  const victimAbs = path.join(paths.ROOT, ...victim.path.split('/'));
  const originalBuf = fs.readFileSync(victimAbs);
  console.log('  目标文件: ' + victim.path + '（' + victim.size + ' B）');
  console.log('  原内容已读入内存（' + originalBuf.length + ' B），验证后会原样写回');

  // 假 host：manifest 说这个文件是"新版本"，file 返回新内容
  const newBody = Buffer.from('// P3 验证：这是假的远端内容\nmodule.exports = {};\n', 'utf8');
  const HOST_PORT = 18870;
  const host = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/api/codesync/manifest') {
      // 只报这一个文件，且 size/mtime 与本地不同 → 判定为 update
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        files: [{ path: victim.path, size: newBody.length, mtime: Date.now() + 100000 }],
      }));
      return;
    }
    if (u.pathname === '/api/codesync/file') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': newBody.length });
      res.end(newBody);
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => host.listen(HOST_PORT, '127.0.0.1', r));
  console.log('  假 host 已起在 ' + HOST_PORT);

  try {
    console.log('');
    console.log('════ 2. 让备份必失败：把 codesync-backup 位置用文件占住 ════');
    const backupRoot = path.join(paths.DATA_DIR, 'codesync-backup');
    try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
    fs.mkdirSync(path.dirname(backupRoot), { recursive: true });
    fs.writeFileSync(backupRoot, 'BLOCK', 'utf8');
    console.log('  已占住 ' + backupRoot);

    console.log('');
    console.log('════ 3. 真跑 pull ════');
    const report = await codesync.pull('http://127.0.0.1:' + HOST_PORT);
    console.log('  updated: ' + JSON.stringify(report.updated));
    console.log('  added: ' + JSON.stringify(report.added));
    console.log('  failed: ' + JSON.stringify(report.failed));
    console.log('  **backupFailed: ' + JSON.stringify(report.backupFailed) + '**');
    console.log('  backupDir: ' + report.backupDir);

    check('**返回里有 backupFailed 字段**',
      Object.prototype.hasOwnProperty.call(report, 'backupFailed'));
    check('**该文件被覆盖了**（updated 里有它）',
      report.updated.indexOf(victim.path) >= 0, JSON.stringify(report.updated));
    check('**备份失败被如实记下**（不再静默）',
      report.backupFailed.length === 1 && report.backupFailed[0].path === victim.path,
      JSON.stringify(report.backupFailed));
    check('失败项带原因', Boolean(report.backupFailed[0] && report.backupFailed[0].reason),
      JSON.stringify(report.backupFailed[0] || {}));
    console.log('  失败原因: ' + ((report.backupFailed[0] || {}).reason || '(无)'));

    // 再验证反向：备份成功时不该误报
    console.log('');
    console.log('════ 4. 反向：把占位文件挪开，备份应当成功且不报错 ════');
    fs.unlinkSync(backupRoot);
    // 把文件内容改回原样，制造"又需要更新"的条件
    fs.writeFileSync(victimAbs, originalBuf);
    const report2 = await codesync.pull('http://127.0.0.1:' + HOST_PORT);
    console.log('  updated: ' + report2.updated.length + '  backupFailed: ' + JSON.stringify(report2.backupFailed));
    check('**这次备份成功，backupFailed 为空**',
      report2.backupFailed.length === 0, JSON.stringify(report2.backupFailed));
    check('备份目录里确实有那份老文件',
      report2.backupDir && fs.existsSync(path.join(report2.backupDir, ...victim.path.split('/'))),
      report2.backupDir);
  } finally {
    // 必须还原产品文件！
    fs.writeFileSync(victimAbs, originalBuf);
    const restored = fs.readFileSync(victimAbs);
    check('**产品文件已原样还原**',
      restored.length === originalBuf.length && restored.equals(originalBuf),
      restored.length + ' vs ' + originalBuf.length);
    host.close();
    try { fs.rmSync(path.join(paths.DATA_DIR, 'codesync-backup'), { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

main()
  .then(() => {
    try { fs.rmSync(box, { recursive: true, force: true }); } catch { /* 忽略 */ }
    console.log('');
    console.log('─'.repeat(52));
    if (fail) { console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项'); process.exit(1); }
    console.log('通过 ' + pass + ' 项，失败 0 项');
  })
  .catch((e) => {
    console.log('测试自身出错: ' + ((e && e.stack) || e));
    try { fs.rmSync(box, { recursive: true, force: true }); } catch { /* 忽略 */ }
    process.exit(1);
  });
