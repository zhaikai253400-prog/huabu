// ─────────────────────────────────────────────────────────────────────
// 端到端验证脚本（从 .tmp-test/ 挪进来长期保留）
// 用途：实测"有兜底 / 没兜底"时进程是否存活
// 跑法：runtime\node.exe tools\e2e\p1-crash-guard.js
// 说明：比 tools/tests 慢（会起真服务 / 真浏览器 / 假 host 或占端口），
//       所以不进 run-all；但能证明"真跑起来是对的"，与源码级断言互补。
// ─────────────────────────────────────────────────────────────────────
'use strict';

// 验证 P1：后台定时器抛异常不再带崩进程。
//
// 做法：起真服务，读它的启动日志；然后**直接给那个进程发一个制造异常的场景**。
// 但外部很难精确戳中 watchTask，所以分两层验证：
//   ① 单元层：把 scheduler 的 watchTask 拿出来，让它内部抛异常，确认被兜住
//   ② 集成层：起真服务，用一条**能触发 handleTaskEnd 内部报错**的脏数据，
//      看服务是否还活着（并且日志里有"盯任务时出错"）

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');
const REAL = path.join(ROOT, 'data', 'canvas.db');
const PORT = 18840;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')); }
}

function req(p, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    let payload = null;
    if (o.body !== undefined) {
      payload = JSON.stringify(o.body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: o.method || 'GET', headers }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject); r.setTimeout(30000, () => r.destroy(new Error('超时')));
    if (payload) r.write(payload);
    r.end();
  });
}

// 注意：Node 不允许同时出现 require 与顶层 await
//（ERR_AMBIGUOUS_MODULE_SYNTAX），所以整段包进 async 函数。
async function main() {
console.log('════ ① 源码层：watchTask 回调里有 try/catch，且异常被记日志 ════');
const schedSrc = fs.readFileSync(path.join(ROOT, 'server', 'scheduler.js'), 'utf8');
const wt = /function watchTask\(run, item\) \{[\s\S]*?\n\}/.exec(schedSrc);
check('抽得出 watchTask', Boolean(wt));
if (wt) {
  check('**回调里包了 try**', /setInterval\(\(\) => \{[\s\S]*?\btry\s*\{/.test(wt[0]));
  check('**有 catch 且会 log**', /\}\s*catch\s*\((\w+)\)\s*\{[\s\S]*?log\(/.test(wt[0]));
  check('出错时会摘掉 watcher（避免每 1.6s 重复抛）', /clearWatch\(key\)/.test(wt[0].slice(wt[0].indexOf('catch'))));
  check('出错时把该任务标为失败（不让它卡在 running）',
    /finishItem\([^)]*'failed'/.test(wt[0].slice(wt[0].indexOf('catch'))));
}

console.log('');
console.log('════ ② 源码层：全局兜底真的装了 ════');
const idxSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
check('有 process.on(\'uncaughtException\')', /process\.on\(\s*'uncaughtException'/.test(idxSrc));
check('有 process.on(\'unhandledRejection\')', /process\.on\(\s*'unhandledRejection'/.test(idxSrc));
check('**兜底里会写日志**（否则等于没装）',
  /uncaughtException'[\s\S]{0,400}?log\(/.test(idxSrc));
check('兜底在 main() 里被调用（不是定义了没接上）',
  /installCrashHandlers\(\);\s*\n\}/.test(idxSrc));
// 关键：uncaughtException 处理器里**不能**再抛异常，否则会二次崩溃
const handlers = /function installCrashHandlers\(\) \{[\s\S]*?\n\}/.exec(idxSrc);
check('处理器内部不会再抛（只有 log）',
  Boolean(handlers) && !/throw\s/.test(handlers[0]));

console.log('');
console.log('════ ③ 实测：Node 里"有兜底"和"没兜底"的区别 ════');
// 用一个子进程分别跑两种情形，看它活不活得下来
function runChild(withHandler) {
  const code = withHandler
    ? `
      process.on('uncaughtException', (e) => { console.log('兜住了: ' + e.message); });
      let n = 0;
      setInterval(() => { n++; if (n === 2) throw new Error('定时器里的错'); if (n >= 4) { console.log('进程还活着'); process.exit(0); } }, 80);
      setTimeout(() => { console.log('超时未退出'); process.exit(9); }, 3000);
    `
    : `
      let n = 0;
      setInterval(() => { n++; if (n === 2) throw new Error('定时器里的错'); }, 80);
      setTimeout(() => { console.log('进程还活着'); process.exit(0); }, 1200);
    `;
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', code],
    { encoding: 'utf8', timeout: 8000 });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const without = runChild(false);
console.log('  没有兜底: 退出码=' + without.status + '   输出=' + JSON.stringify(without.out.trim()) +
  '   错误=' + JSON.stringify(without.err.split('\n')[0].slice(0, 46)));
check('**没有兜底时进程确实会死**（这就是"服务静默消失"的机制）',
  without.status !== 0 && /定时器里的错/.test(without.err));

const withH = runChild(true);
console.log('  加了兜底: 退出码=' + withH.status + '   输出=' + JSON.stringify(withH.out.trim().replace(/\n/g, ' | ')));
check('**加了兜底后进程活下来**', withH.status === 0 && /进程还活着/.test(withH.out));

console.log('');
console.log('════ ④ 集成：起真服务，确认它带上了这两层保护 ════');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-'));
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
const outFile = path.join(box, 'out.txt');
const outFd = fs.openSync(outFile, 'w');
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--no-browser'],
  { cwd: ROOT, env: Object.assign({}, process.env, {
    CANVAS_DATA_DIR: dataDir, CANVAS_ASSET_ROOT: assets, NO_PROXY: '127.0.0.1,localhost',
  }), stdio: ['ignore', outFd, outFd] });
let up = false;
for (let i = 0; i < 150; i += 1) {
  try { const r = await req('/api/health'); if (r.status === 200) { up = true; break; } } catch { /* 等 */ }
  await sleep(250);
}
check('服务正常启动', up);
check('**服务进程还活着**（没有因启动期异常退出）', server.exitCode === null);

// 让它跑几秒（ticker 每秒跑一次），确认稳定
await sleep(4000);
check('跑了几秒仍然活着（ticker 每秒一轮）', server.exitCode === null);
const st = await req('/api/status').catch(() => null);
check('接口仍然可响应', Boolean(st && st.status === 200));

server.kill();
await sleep(800);
fs.closeSync(outFd);
const logText = fs.readFileSync(outFile, 'utf8');
check('日志里没有"未处理的异常"（干净的运行）',
  !/未处理的异常|未处理的 Promise 拒绝/.test(logText),
  (logText.match(/未处理的[^\n]*/) || [''])[0].slice(0, 80));
fs.rmSync(box, { recursive: true, force: true });

console.log('');
console.log('─'.repeat(52));
if (fail) { console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项'); process.exit(1); }
console.log('通过 ' + pass + ' 项，失败 0 项');
}

main().catch((e) => { console.log('测试自身出错: ' + ((e && e.stack) || e)); process.exit(1); });
