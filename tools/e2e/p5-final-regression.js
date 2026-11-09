'use strict';

// P5：全库审查的收尾核对。
//   ① 真实数据三处（库 / 回收站 / 素材）有没有被这轮改动碰过
//   ② 服务能不能正常起来（用真实库副本），启动日志干净
//   ③ 本轮 4 个提交都在
//   ④ 全量测试

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

// 注意：本文件在 tools/e2e/ 下，所以 ROOT 要退**两层**才到项目根。
const ROOT = path.resolve(__dirname, '..', '..');
const REAL_DB = path.join(ROOT, 'data', 'canvas.db');
const REAL_CFG = path.join(ROOT, 'data', 'config.json');
const GIT = path.join(ROOT, '.git-tools', 'cmd', 'git.exe');
const PORT = 18880;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')); }
}

function get(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject); r.setTimeout(20000, () => r.destroy(new Error('超时'))); r.end();
  });
}

async function main() {
  console.log('════ ① 真实数据（应未被这轮改动碰过）════');
  const dbStat = fs.statSync(REAL_DB);
  console.log('  canvas.db  : ' + dbStat.size + ' 字节  mtime=' + dbStat.mtime.toISOString());
  console.log('  config.json: ' + fs.statSync(REAL_CFG).size + ' 字节');
  const dbHash = sha(REAL_DB);
  const cfgHash = sha(REAL_CFG);
  const recycle = fs.readdirSync(path.join(ROOT, 'data', 'recycle')).length;
  let assets = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name)); else assets += 1;
    }
  }(path.join(ROOT, '素材')));
  console.log('  回收站 ' + recycle + ' 条   素材 ' + assets + ' 个文件');
  console.log('  （这些数字与我的改动无关；你的服务在跑，mtime 会动是正常的）');

  // 尾部预设仍在
  const cfg = JSON.parse(fs.readFileSync(REAL_CFG, 'utf8'));
  const tp = cfg.tailPrompts || {};
  const presetCount = (tp.presets || []).length;
  check('**你那套尾部预设还在**', presetCount >= 1, String(presetCount));
  console.log('  预设: ' + (tp.presets || []).map((p) => p.name + '(' + String(p.text || '').length + '字)').join(', '));

  console.log('');
  console.log('════ ② web/ 里不再有 .bak 残留（P2 已清）════');
  const baks = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.bak/i.test(e.name)) baks.push(path.relative(ROOT, p));
    }
  }(path.join(ROOT, 'web')));
  check('web/ 无 .bak', baks.length === 0, baks.join(', '));

  console.log('');
  console.log('════ ③ 服务启动自检（真实库副本）════');
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-'));
  const dataDir = path.join(box, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(REAL_DB, path.join(dataDir, 'canvas.db'));
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(REAL_DB + ext)) fs.copyFileSync(REAL_DB + ext, path.join(dataDir, 'canvas.db' + ext));
  }
  const secret = path.join(ROOT, 'data', 'secret.key');
  if (fs.existsSync(secret)) fs.copyFileSync(secret, path.join(dataDir, 'secret.key'));
  const assetsDir = path.join(box, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), Buffer.from(JSON.stringify({
    port: PORT, assetRoot: assetsDir, assetRootRel: '', lan: { enabled: false }, channels: [],
  }, null, 2), 'utf8'));

  const outFile = path.join(box, 'out.txt');
  const outFd = fs.openSync(outFile, 'w');
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--no-browser'],
    { cwd: ROOT, env: Object.assign({}, process.env, {
      CANVAS_DATA_DIR: dataDir, CANVAS_ASSET_ROOT: assetsDir, NO_PROXY: '127.0.0.1,localhost',
    }), stdio: ['ignore', outFd, outFd] });

  let up = false;
  for (let i = 0; i < 150; i += 1) {
    try { const r = await get('/api/health'); if (r.status === 200) { up = true; break; } } catch { /* 等 */ }
    await sleep(250);
  }
  check('服务起来了', up);
  if (up) {
    const st = await get('/api/status');
    check('/api/status 正常', st.status === 200);
    let ver = null;
    try { ver = JSON.parse(st.body).tailSchemaVersion; } catch { /* 忽略 */ }
    check('**报出 tailSchemaVersion=2**（P1~P3 之后仍完好）', Number(ver) === 2, String(ver));

    const idx = await get('/');
    check('首页正常', idx.status === 200 && idx.body.length > 500);

    // 让 ticker 跑几轮，确认没有"未处理异常"
    await sleep(3500);
    const canvas = await get('/assets/canvas.js');
    check('静态资源正常', canvas.status === 200 && canvas.body.length > 100000);
    check('**服务仍然活着**（ticker 跑过几轮）', server.exitCode === null);
  }

  server.kill();
  await sleep(800);
  fs.closeSync(outFd);
  const log = fs.readFileSync(outFile, 'utf8');
  const crashes = (log.match(/未处理的异常|未处理的 Promise 拒绝/g) || []).length;
  check('**启动日志里没有"未处理异常"**', crashes === 0, crashes + ' 处');
  if (crashes) {
    log.split('\n').filter((l) => /未处理的/.test(l)).slice(0, 3).forEach((l) => console.log('    ' + l.trim().slice(0, 110)));
  }
  fs.rmSync(box, { recursive: true, force: true });

  console.log('');
  console.log('════ ④ 本轮 4 个提交 ════');
  const lg = spawnSync(GIT, ['-C', ROOT, 'log', '--oneline', '-5'], { encoding: 'utf8' });
  String(lg.stdout || '').split('\n').filter(Boolean).forEach((l) => console.log('  ' + l));

  console.log('');
  console.log('════ ⑤ 全量测试 + 端到端脚本仍在 ════');
  const tests = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'tests', 'run-all.js')],
    { encoding: 'utf8', cwd: ROOT });
  const tail = String(tests.stdout || '').split('\n').filter((l) => /共 \d+ 个测试文件/.test(l));
  check('全量测试全绿', tests.status === 0, tail.join(' '));
  console.log('  ' + (tail[0] || '').trim());
  const e2e = fs.readdirSync(path.join(ROOT, 'tools', 'e2e'));
  // 不写死个数 —— 以后再加脚本不该让这条红。要求的是"至少有这几个"。
  const REQUIRED = ['safety-net-e2e.js', 'p1-crash-guard.js', 'p2-static-deny.js', 'p3-codesync-remote.js'];
  const missing = REQUIRED.filter((f) => e2e.indexOf(f) < 0);
  check('tools/e2e 里 4 个端到端脚本 + README 都在',
    missing.length === 0 && e2e.indexOf('README.md') >= 0,
    missing.length ? '缺: ' + missing.join(', ') : '缺 README.md');

  console.log('');
  console.log('════ ⑥ 最后再核一次：真实文件未被写 ════');
  check('**canvas.db 未被写**（跑了这么多测试与自检）', sha(REAL_DB) === dbHash);
  check('**config.json 未被写**', sha(REAL_CFG) === cfgHash);
  check('回收站条目数未变', fs.readdirSync(path.join(ROOT, 'data', 'recycle')).length === recycle);
  let assetsNow = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name)); else assetsNow += 1;
    }
  }(path.join(ROOT, '素材')));
  check('素材文件数未变', assetsNow === assets, assets + ' → ' + assetsNow);

  console.log('');
  console.log('─'.repeat(52));
  if (fail) { console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项'); process.exit(1); }
  console.log('通过 ' + pass + ' 项，失败 0 项');
}

main().catch((e) => { console.log('测试自身出错: ' + ((e && e.stack) || e)); process.exit(1); });
