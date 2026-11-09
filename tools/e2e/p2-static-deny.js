// ─────────────────────────────────────────────────────────────────────
// 端到端验证脚本（从 .tmp-test/ 挪进来长期保留）
// 用途：造后缀文件验证静态闸 + 反向确认不误伤
// 跑法：runtime\node.exe tools\e2e\p2-static-deny.js
// 说明：比 tools/tests 慢（会起真服务 / 真浏览器 / 假 host 或占端口），
//       所以不进 run-all；但能证明"真跑起来是对的"，与源码级断言互补。
// ─────────────────────────────────────────────────────────────────────
'use strict';

// 验证 P2 的两件事：
//   ① 后缀黑名单真的挡住了（.bak / .tmp / .key …）
//   ② **没有误伤**：正常的 js / css / html / 图片仍然正常返回
//
// 做法：在一个隔离副本里**故意造几个假的后缀文件**，然后真实请求。
// 这样即使真实目录已经清干净了，也能验证闸门本身有效。

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REAL = path.join(ROOT, 'data', 'canvas.db');
const PORT = 18850;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')); }
}

function get(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => {
      let n = 0; let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { n += Buffer.byteLength(c); body += c; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n, body }));
    });
    r.on('error', reject); r.setTimeout(20000, () => r.destroy(new Error('超时'))); r.end();
  });
}

(async () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'staticdeny-'));
  const dataDir = path.join(box, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(REAL, path.join(dataDir, 'canvas.db'));
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(REAL + ext)) fs.copyFileSync(REAL + ext, path.join(dataDir, 'canvas.db' + ext));
  }
  const assets = path.join(box, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), Buffer.from(JSON.stringify({
    port: PORT, assetRoot: assets, assetRootRel: '', lan: { enabled: false }, channels: [],
  }, null, 2), 'utf8'));

  // 在真实 web/ 里造几个"临时/备份/密钥"文件来验证闸门。
  // 注意：这是**产品目录**，所以用完必须删干净 —— 用 finally 保证。
  const WEB = path.join(ROOT, 'web');
  const fakes = [
    'assets/__deny_probe.js.bak',
    'assets/__deny_probe.js.tmp',
    'assets/__deny_probe.js.orig',
    'assets/__deny_probe.js.old',
    '__deny_probe.key',
    'assets/__deny_probe.db',
  ];
  fakes.forEach((f) => fs.writeFileSync(path.join(WEB, ...f.split('/')), 'SECRET-OLD-CODE', 'utf8'));

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--no-browser'],
    { cwd: ROOT, env: Object.assign({}, process.env, {
      CANVAS_DATA_DIR: dataDir, CANVAS_ASSET_ROOT: assets, NO_PROXY: '127.0.0.1,localhost',
    }), stdio: 'ignore' });
  let up = false;
  try {
    for (let i = 0; i < 150; i += 1) {
      try { const r = await get('/api/health'); if (r.status === 200) { up = true; break; } } catch { /* 等 */ }
      await sleep(250);
    }
    check('服务起来了', up);

    console.log('');
    console.log('════ ① 后缀黑名单：这些必须 404 且不吐源码 ════');
    for (const f of fakes) {
      const r = await get('/' + f);
      // 注意：404 的**正文**是那句"找不到页面：xxx"的提示文字（约 30~40 字节），
      // 这是正常的 —— 关键是不能把**文件内容**发出来。
      // （一开始我断言 bytes===0，太严了；真正要守的是"没吐出 SECRET-OLD-CODE"。）
      const blocked = r.status === 404 && r.body.indexOf('SECRET-OLD-CODE') < 0;
      check('/' + f + ' 被挡（404 且不返回文件内容）', blocked,
        'HTTP ' + r.status + ' ' + r.bytes + ' B' + (r.body.indexOf('SECRET') >= 0 ? ' **吐内容了**' : ''));
    }

    console.log('');
    console.log('════ ② 反向：正常资源必须照常返回（不能误伤）════');
    const keeps = [
      ['/assets/canvas.js', 100000],
      ['/assets/style.css', 100000],
      ['/canvas.html', 10000],
      ['/assets/payload-rules.js', 1000],
      ['/assets/utils.js', 1000],
    ];
    for (const [p, minBytes] of keeps) {
      const r = await get(p);
      check(p + ' 正常（HTTP 200 且体积合理）',
        r.status === 200 && r.bytes >= minBytes, 'HTTP ' + r.status + ' ' + r.bytes + ' B');
    }
    const pages = ['/', '/canvas', '/channels', '/launcher'];
    for (const p of pages) {
      const r = await get(p);
      check(p + ' 页面正常', r.status === 200 && r.bytes > 500, 'HTTP ' + r.status + ' ' + r.bytes + ' B');
    }

    console.log('');
    console.log('════ ③ 路径穿越仍然被挡（不能因为新闸门而放松）════');
    for (const p of ['/../server/index.js', '/assets/../../data/config.json', '/../data/canvas.db']) {
      const r = await get(p);
      check(p + ' 仍被挡', r.status === 404 || r.status === 403, 'HTTP ' + r.status);
    }
  } finally {
    server.kill();
    await sleep(700);
    // 清掉探测文件（必须做干净）
    fakes.forEach((f) => {
      try { fs.unlinkSync(path.join(WEB, ...f.split('/'))); } catch { /* 忽略 */ }
    });
    const left = fakes.filter((f) => fs.existsSync(path.join(WEB, ...f.split('/'))));
    check('探测文件已清理干净', left.length === 0, left.join(', '));
    fs.rmSync(box, { recursive: true, force: true });
  }

  console.log('');
  console.log('─'.repeat(52));
  if (fail) { console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项'); process.exit(1); }
  console.log('通过 ' + pass + ' 项，失败 0 项');
})();
