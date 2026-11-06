'use strict';

// 画布 ID / 「检查更新」的服务端半边。
//
// 用户要的是：能看见这块画布的 ID，并且能手动点一下确认「另一台电脑有没有改过」。
// 这件事全靠服务端的一个版本号 rev（每次保存 +1）。所以这里守三件事：
//
//   1. GET /api/canvases/:id/meta 只回版本号那几个字段，**绝不能带 nodes / edges** ——
//      它的全部价值就是「几十字节」，一旦顺手把整份 state 塞进去，
//      以后每点一次检查都要拖几百 KB，功能立刻变成新的卡顿源。
//   2. 保存一次 rev 就得涨一格。前端就是靠「服务端 rev > 我手上 rev」判断有新版本的，
//      版本号不动 = 检查更新永远说「已同步」，等于功能是假的。
//   3. 它必须是只读的：GET 一次不能改库、不能改 rev、不能顺手升级数据。
//
// 跑的是真服务（隔离目录 + 临时库 + 随机端口），不是只测 store。
//
// 运行：runtime/node.exe tools/tests/canvas-meta.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    fail += 1;
    console.log('  ✗ ' + name + ' —— ' + error.message);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    fail += 1;
    console.log('  ✗ ' + name + ' —— ' + error.message);
  }
}
function eq(got, want, msg) {
  if (got !== want) {
    throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
  }
}

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-meta-'));
const boxed = (p) => path.join(box, p);
let PORT = 0;

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function request(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: opts.path,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        setHost: false,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('请求超时')));
    req.end(opts.body == null ? undefined : JSON.stringify(opts.body));
  });
}

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await request({ path: '/api/health', headers: { host: '127.0.0.1:' + PORT } });
      if (r.status === 200) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      resolve();
    }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

(async () => {
  console.log('\n画布 ID 与「检查更新」：服务端版本号接口');

  // ---- 静态面：前端确实把这两样东西接上了（源码级，跑得再快也要先有）----
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'web', 'canvas.html'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'api.js'), 'utf8');
  const portalSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'portal.js'), 'utf8');

  check('服务端有 /meta 路由', () => {
    assert(indexSrc.indexOf('const metaMatch') >= 0, 'index.js 里找不到 meta 路由');
  });

  check('/meta 路由只回版本号那几个字段（不许塞 nodes / edges）', () => {
    const at = indexSrc.indexOf('const metaMatch');
    const block = indexSrc.slice(at, at + 900);
    assert(block.indexOf('getCanvas(id)') >= 0, 'meta 应该只读 canvases 行，不该去读整份 state');
    assert(block.indexOf('getState') < 0, 'meta 路由里出现了 getState —— 那就把整份画布读出来了');
    ['rev', 'updatedAt', 'nodeCount', 'name'].forEach((key) => {
      assert(block.indexOf(key) >= 0, 'meta 少回了 ' + key);
    });
  });

  // 画布顶部不再显示 ID（那串字常驻在眼前只是干扰），
  // 但「复制 ID 拿去另一台电脑打开」这个能力不能丢，改放在空白处右键菜单里。
  check('顶部已不显示画布 ID，但右键菜单能复制', () => {
    assert(htmlSrc.indexOf('id="canvas-id"') < 0, 'canvas.html 里还有 #canvas-id 小胶囊');
    assert(canvasSrc.indexOf('idChipEl') < 0, 'canvas.js 里还在用 idChipEl');
    assert(canvasSrc.indexOf('paintCanvasId') < 0, 'canvas.js 里还在调 paintCanvasId');
    assert(canvasSrc.indexOf('function copyCanvasId') >= 0, '没有 copyCanvasId');
    assert(canvasSrc.indexOf('copyText(canvasId)') >= 0, '复制 ID 没有走 copyText');
    assert(canvasSrc.indexOf("label: '复制画布 ID'") >= 0, '右键菜单里没有复制 ID 的入口');
  });

  // ---- 检查更新挪到托盘右键菜单（不常用功能不该常驻在画布上）----
  // 判据：标题栏里不能再有那个按钮；入口只在托盘菜单里；
  // 点开的是一个单独的 /update 页面；那个页面只在打开时读一次，没有轮询。
  const traySrc = fs.readFileSync(path.join(ROOT, 'server', 'tray', 'CanvasTray.cs'), 'utf8');
  const updateHtml = fs.readFileSync(path.join(ROOT, 'web', 'update.html'), 'utf8');
  const updateSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'update.js'), 'utf8');
  const updModSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas-update.js'), 'utf8');

  check('画布标题栏里已经没有「检查更新」按钮了', () => {
    assert(htmlSrc.indexOf('id="canvas-sync"') < 0, 'canvas.html 里还留着 #canvas-sync');
    assert(canvasSrc.indexOf('checkCanvasUpdate') < 0, 'canvas.js 里还留着 checkCanvasUpdate');
    assert(canvasSrc.indexOf('syncPanel') < 0, 'canvas.js 里还留着 syncPanel');
  });

  check('托盘菜单里有「检查画布更新…」，指向 /update 独立窗口', () => {
    assert(traySrc.indexOf('检查画布更新') >= 0, 'CanvasTray.cs 里没有这个菜单项');
    const at = traySrc.indexOf('检查画布更新');
    const block = traySrc.slice(Math.max(0, at - 200), at + 400);
    assert(block.indexOf('OpenPath("/update"') >= 0, '菜单项没指向 /update');
  });

  check('托盘菜单项会随服务状态一起灰掉 / 恢复（不会点了没反应）', () => {
    assert(/updateItem\.Enabled\s*=\s*false/.test(traySrc), '服务停时没禁用 updateItem');
    assert(/updateItem\.Enabled\s*=\s*true/.test(traySrc), '服务起来后没恢复 updateItem');
  });

  check('服务端能回 /update 页面，并注入页面令牌', () => {
    assert(indexSrc.indexOf("'/update'") >= 0, 'index.js 里没有 /update 路由');
    assert(updateHtml.indexOf('__UI_TOKEN__') >= 0, 'update.html 没占位令牌');
    assert(updateHtml.indexOf('canvas-update.js') >= 0, 'update.html 没引 canvas-update.js');
  });

  check('更新页只在打开时读一次（没有轮询 / 定时器）', () => {
    assert(updateSrc.indexOf('setInterval') < 0, 'update.js 里出现了 setInterval');
    assert(!/setTimeout\([^)]*refresh/.test(updateSrc), 'update.js 里出现了自动重新检查');
    assert(updModSrc.indexOf('setInterval') < 0, 'canvas-update.js 里出现了 setInterval');
  });

  check('本机「看过第几版」的记录只在同源内，且只往大里记', () => {
    const Upd = require(path.join(ROOT, 'web', 'assets', 'canvas-update.js'));
    const mem = new Map();
    const store = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
    };
    // 没记录过 → never：这时候说「有新版本」是没有依据的
    const never = Upd.compare('c_a', 7, store);
    eq(never.state, 'never', '没记录过应该是 never');
    eq(never.seen, null, 'never 时 seen 应为 null');
    // 记 7 → 服务端还是 7 → same
    Upd.rememberSeen('c_a', 7, store);
    eq(Upd.compare('c_a', 7, store).state, 'same', '版本一致应判 same');
    // 服务端涨到 9 → new，并且说得出差几版
    const newer = Upd.compare('c_a', 9, store);
    eq(newer.state, 'new', '服务端更新应判 new');
    eq(newer.gap, 2, '差几版要算对');
    assert(Upd.describe(newer).indexOf('2') >= 0, 'describe 没把差几版说出来');
    // 往小里记（撤销 / 载入旧版）不许把记录改小，否则会一直提示有新版本
    Upd.rememberSeen('c_a', 3, store);
    eq(Upd.seenRevOf('c_a', store).rev, 7, '记录被改小了 —— 应该只往大里记');
    // 存坏了也不能抛：这只是提示用的记录
    mem.set(Upd.SEEN_KEY, '{坏掉的 json');
    const recovered = Upd.readAll(store);
    eq(Object.prototype.toString.call(recovered), '[object Object]', '坏数据应退化成空对象');
    eq(Upd.compare('c_a', 9, store).state, 'never', '记录坏了就该回到 never，而不是报错');
  });

  check('api.js 暴露 canvasMeta', () => {
    assert(apiSrc.indexOf('canvasMeta:') >= 0, 'api.js 没有 canvasMeta');
  });

  check('门户页卡片也显示画布 ID', () => {
    assert(portalSrc.indexOf('canvas-id-tag') >= 0, 'portal.js 里没有 ID 行');
    assert(portalSrc.indexOf('copyText(canvas.id)') >= 0, '门户页没有复制 ID 的入口');
  });

  // ---- 真服务：端到端 ----
  console.log('\n真服务（隔离目录 + 随机端口）');

  PORT = await pickFreePort();
  const dataDir = boxed('data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(boxed('素材'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ port: PORT, assetRoot: boxed('素材') }, null, 2),
    'utf8'
  );

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--no-browser'], {
    cwd: box,
    env: Object.assign({}, process.env, {
      http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '',
      CANVAS_DATA_DIR: dataDir,
    }),
    stdio: 'ignore',
  });

  const up = await waitUp();
  if (!up) {
    console.log('  ✗ 隔离服务没起来，端到端检查无法进行');
    fail += 1;
    await stopChild(child);
    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(1);
  }

  const ui = fs.readFileSync(path.join(dataDir, 'ui-token.txt'), 'utf8').trim();
  const H = { host: '127.0.0.1:' + PORT, 'x-local-token': ui, 'content-type': 'application/json' };
  const call = (p, method, body) => request({ path: p, method, headers: H, body });

  const created = await call('/api/canvases', 'POST', { name: 'ID 与检查更新' });
  const canvasId = JSON.parse(created.body).canvas.id;

  await checkAsync('新建画布就有 ID（形如 c_xxx）', async () => {
    eq(created.status, 200, created.body.slice(0, 120));
    assert(/^c_[0-9a-z]+$/.test(canvasId), 'ID 形状不对：' + canvasId);
  });

  await checkAsync('GET /meta 回 200，字段齐全，rev 从 0 开始', async () => {
    const r = await call('/api/canvases/' + encodeURIComponent(canvasId) + '/meta');
    eq(r.status, 200, r.body.slice(0, 160));
    const meta = JSON.parse(r.body);
    eq(meta.id, canvasId, 'id 对不上');
    eq(meta.rev, 0, '新画布 rev 应为 0');
    eq(meta.nodeCount, 0, '新画布没有卡片');
    assert(Number(meta.updatedAt) > 0, '缺 updatedAt');
  });

  await checkAsync('/meta 的响应体很小（这就是它存在的理由）', async () => {
    const r = await call('/api/canvases/' + encodeURIComponent(canvasId) + '/meta');
    assert(r.body.length < 400, 'meta 响应有 ' + r.body.length + ' 字节，不像「只回版本号」');
    assert(r.body.indexOf('"nodes"') < 0, 'meta 里带上了 nodes');
    assert(r.body.indexOf('"edges"') < 0, 'meta 里带上了 edges');
  });

  await checkAsync('存一次 → rev 涨到 1，nodeCount 跟着涨', async () => {
    const put = await call('/api/canvases/' + encodeURIComponent(canvasId), 'PUT', {
      rev: 0,
      nodes: [
        { id: 'n_a', type: 'image', x: 0, y: 0, w: 360, h: 210, z: 0, data: { text: 'A' } },
        { id: 'n_b', type: 'image', x: 400, y: 0, w: 360, h: 210, z: 1, data: { text: 'B' } },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    eq(put.status, 200, put.body.slice(0, 200));
    const r = await call('/api/canvases/' + encodeURIComponent(canvasId) + '/meta');
    const meta = JSON.parse(r.body);
    eq(meta.rev, 1, '保存后 rev 没涨，检查更新就永远说「已同步」');
    eq(meta.nodeCount, 2, '卡片数没跟上');
  });

  await checkAsync('再存一次 → rev 涨到 2（每次保存都 +1）', async () => {
    const put = await call('/api/canvases/' + encodeURIComponent(canvasId), 'PUT', {
      rev: 1,
      nodes: [{ id: 'n_a', type: 'image', x: 0, y: 0, w: 360, h: 210, z: 0, data: { text: 'A' } }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    eq(put.status, 200, put.body.slice(0, 200));
    const meta = JSON.parse((await call('/api/canvases/' + encodeURIComponent(canvasId) + '/meta')).body);
    eq(meta.rev, 2, 'rev 应该是 2');
    eq(meta.nodeCount, 1, '删掉一张后应该是 1');
  });

  await checkAsync('拿旧 rev 去存 → 409，且 meta 的 rev 不被这次失败改动', async () => {
    const put = await call('/api/canvases/' + encodeURIComponent(canvasId), 'PUT', {
      rev: 0,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    eq(put.status, 409, '旧版本号应该被拒收');
    const meta = JSON.parse((await call('/api/canvases/' + encodeURIComponent(canvasId) + '/meta')).body);
    eq(meta.rev, 2, '冲突那次不该改动版本号');
  });

  await checkAsync('/meta 是只读的：连查三次 rev 不变', async () => {
    const first = JSON.parse((await call('/api/canvases/' + encodeURIComponent(canvasId) + '/meta')).body);
    await call('/api/canvases/' + encodeURIComponent(canvasId) + '/meta');
    await call('/api/canvases/' + encodeURIComponent(canvasId) + '/meta');
    const last = JSON.parse((await call('/api/canvases/' + encodeURIComponent(canvasId) + '/meta')).body);
    eq(last.rev, first.rev, 'GET meta 把 rev 改了');
    eq(last.nodeCount, first.nodeCount, 'GET meta 动了卡片');
  });

  await checkAsync('不存在的画布 → 404（不是 500，也不回空对象）', async () => {
    const r = await call('/api/canvases/c_does_not_exist/meta');
    eq(r.status, 404, r.body.slice(0, 120));
  });

  await checkAsync('不带钥匙 → 401（和别的接口同一套门禁）', async () => {
    const r = await request({
      path: '/api/canvases/' + encodeURIComponent(canvasId) + '/meta',
      headers: { host: '127.0.0.1:' + PORT },
    });
    eq(r.status, 401, r.body.slice(0, 120));
  });

  await checkAsync('POST /meta → 405（这是只读接口）', async () => {
    const r = await call('/api/canvases/' + encodeURIComponent(canvasId) + '/meta', 'POST', {});
    eq(r.status, 405, r.body.slice(0, 120));
  });

  await stopChild(child);

  console.log('\n' + '='.repeat(46));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})();