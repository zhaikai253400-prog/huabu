// ─────────────────────────────────────────────────────────────────────
// 端到端验证脚本（从 .tmp-test/ 挪进来长期保留）
// 用途：复现"版本错配把尾部预设写空"那次事故（10 项断言）
// 跑法：runtime\node.exe tools\e2e\safety-net-e2e.js
// 说明：比 tools/tests 慢（会起真服务 / 真浏览器 / 假 host 或占端口），
//       所以不进 run-all；但能证明"真跑起来是对的"，与源码级断言互补。
// ─────────────────────────────────────────────────────────────────────
'use strict';

// 端到端验证安全网：起一个**新服务**，模拟"新前端发的空预设 body"打过去，
// 确认它被拒绝（409）而**不是**把磁盘上的预设清空。
//
// 用的是真实 config 的副本（含那套刚恢复的 3D国漫风格）。

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_CFG = path.join(ROOT, 'data', 'config.json');
const REAL_DB = path.join(ROOT, 'data', 'canvas.db');
const PORT = 18790;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

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

(async () => {
  const realCfgHash = sha(REAL_CFG);
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-'));
  const dataDir = path.join(box, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(REAL_DB, path.join(dataDir, 'canvas.db'));
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(REAL_DB + ext)) fs.copyFileSync(REAL_DB + ext, path.join(dataDir, 'canvas.db' + ext));
  }
  const secret = path.join(ROOT, 'data', 'secret.key');
  if (fs.existsSync(secret)) fs.copyFileSync(secret, path.join(dataDir, 'secret.key'));
  const cfg = JSON.parse(fs.readFileSync(REAL_CFG, 'utf8'));
  cfg.port = PORT;
  cfg.assetRoot = path.join(ROOT, '素材');
  cfg.assetRootRel = '';
  cfg.lan = { enabled: false };
  fs.writeFileSync(path.join(dataDir, 'config.json'), Buffer.from(JSON.stringify(cfg, null, 2), 'utf8'));

  const cfgCopy = path.join(dataDir, 'config.json');
  console.log('隔离箱 config 的 tailPrompts: ' +
    JSON.stringify(cfg.tailPrompts).slice(0, 110));
  check('隔离箱里带着那套预设', (cfg.tailPrompts.presets || []).length === 1);

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--no-browser'],
    { cwd: ROOT, env: Object.assign({}, process.env, {
      CANVAS_DATA_DIR: dataDir, CANVAS_ASSET_ROOT: path.join(ROOT, '素材'),
      NO_PROXY: '127.0.0.1,localhost',
    }), stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 150; i += 1) {
    try { const r = await req('/api/health'); if (r.status === 200) { up = true; break; } } catch { /* 等 */ }
    await sleep(250);
  }
  check('服务起来了', up);
  if (!up) { server.kill(); process.exit(1); }
  let token = '';
  for (let i = 0; i < 100; i += 1) {
    try { const raw = fs.readFileSync(path.join(dataDir, 'admin-token.txt'), 'utf8').trim(); if (raw.length >= 32) { token = raw; break; } } catch { /* 等 */ }
    await sleep(200);
  }
  const local = { 'x-local-token': token };

  // 服务端应当报出版本号
  const st = JSON.parse((await req('/api/status', { headers: local })).body);
  console.log('');
  console.log('  /api/status 的 tailSchemaVersion = ' + JSON.stringify(st.tailSchemaVersion));
  check('**服务端报出了结构版本号 2**（前端据此判断是否需要重启）',
    Number(st.tailSchemaVersion) === 2, String(st.tailSchemaVersion));

  console.log('');
  console.log('════ 关键场景：模拟旧前端/旧字段发来的"空预设"body ════');
  // 这正是事故里旧服务端会遇到的那种输入：没有顶层 presets、也没有可识别的 groups 内容
  const wipeAttempt = { enabled: true, defaultId: '', presets: [] };
  const r1 = await req('/api/settings', { method: 'POST', headers: local, body: { tailPrompts: wipeAttempt } });
  console.log('  POST /api/settings → HTTP ' + r1.status);
  console.log('  返回: ' + String(r1.body).slice(0, 180));
  check('**被拒绝了（409），没有安静地写空**', r1.status === 409, 'HTTP ' + r1.status);

  // 磁盘上预设必须还在
  const after = JSON.parse(fs.readFileSync(cfgCopy, 'utf8'));
  console.log('');
  console.log('  磁盘上的 tailPrompts: ' + JSON.stringify(after.tailPrompts).slice(0, 130));
  check('**磁盘上的预设仍在**（安全网生效）',
    (after.tailPrompts.presets || []).length === 1,
    String((after.tailPrompts.presets || []).length));

  console.log('');
  console.log('════ 正常保存仍要放行（不能误伤）════');
  const okBody = {
    enabled: true,
    groups: {
      video: { defaultId: 'v1', presets: [{ id: 'v1', name: '3D国漫风格', text: '改过的正文' }] },
      image: { defaultId: '', presets: [] },
    },
  };
  const r2 = await req('/api/settings', { method: 'POST', headers: local, body: { tailPrompts: okBody } });
  console.log('  POST /api/settings → HTTP ' + r2.status);
  check('带内容的保存正常通过', r2.status === 200, 'HTTP ' + r2.status);
  const after2 = JSON.parse(fs.readFileSync(cfgCopy, 'utf8'));
  check('**保存后写成了新结构**，且预设内容正确',
    after2.tailPrompts.groups && after2.tailPrompts.groups.video.presets.length === 1 &&
    after2.tailPrompts.groups.video.presets[0].text === '改过的正文',
    JSON.stringify(after2.tailPrompts).slice(0, 140));
  check('图片池仍是空的（没被误塞）', after2.tailPrompts.groups.image.presets.length === 0);

  console.log('');
  console.log('════ 用户主动清空两组：应当允许 ════');
  const clearBody = { enabled: true, groups: { video: { defaultId: '', presets: [] }, image: { defaultId: '', presets: [] } } };
  const r3 = await req('/api/settings', { method: 'POST', headers: local, body: { tailPrompts: clearBody } });
  console.log('  POST /api/settings → HTTP ' + r3.status + '  ' + String(r3.body).slice(0, 90));
  check('**真正想清空时能清空**（安全网不能把人锁死）', r3.status === 200, 'HTTP ' + r3.status);

  server.kill();
  await sleep(900);
  check('**真实 config.json 一字节未动**', sha(REAL_CFG) === realCfgHash);
  fs.rmSync(box, { recursive: true, force: true });

  console.log('');
  console.log('─'.repeat(52));
  if (fail) { console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项'); process.exit(1); }
  console.log('通过 ' + pass + ' 项，失败 0 项');
})();
