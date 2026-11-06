'use strict';

// 性能基准（清单 36）：固定 30 / 100 / 300 张三档，量四件事——
//   1. 打开耗时（从导航到画布画完）
//   2. 平移 / 缩放时的帧率
//   3. 改一张卡片参数后的重排耗时
//   4. 展开面板耗时
//
// 为什么要有它：E1（卡片局部更新）这类改动的收益肉眼看不出来（「好像顺一点」），
// 没说清数字就没法判断值不值得，也没法防回退。跑一遍这个脚本，
// 结果写成 tools/bench/result-<日期>.json，下次改完再跑一遍对比即可。
//
// 用法：
//   runtime/node.exe tools/bench/run.js                 # 跑 30/100/300 三档
//   runtime/node.exe tools/bench/run.js --sizes=30      # 只跑 30 张（改代码时快速看）
//   runtime/node.exe tools/bench/run.js --sizes=30,100  # 跑指定几档
//
// 隔离：数据目录用临时副本（CANVAS_DATA_DIR），端口独立，绝不碰真实 data/canvas.db。
// 需要本机有 Chrome（无头模式）与项目自带的 runtime/node.exe。

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = __dirname;
const PORT = 17995;
// 服务启动后会把本次的访问钥匙写到这里；api() 每次都现读，避免读到上一轮的旧值
let TOKEN_FILE = '';
function adminToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}
const CDP = 'http://127.0.0.1:9354';

// 优先用 Chrome；没有 Chrome 时回退到 Edge（同为 Chromium 内核，CDP 行为一致）。
// 可用 CANVAS_BENCH_BROWSER 环境变量指定任意 Chromium 浏览器可执行文件。
const CHROME_CANDIDATES = [
  process.env.CANVAS_BENCH_BROWSER || '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function localGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body: body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 20000, () => req.destroy(new Error('超时')));
  });
}

function api(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: port,
        path: urlPath,
        method: method,
        headers: Object.assign(
          { 'x-local-token': adminToken() },
          data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
        ),
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    req.end(data || undefined);
  });
}

function cdpNewTab() {
  return new Promise((resolve, reject) => {
    const u = new URL(CDP + '/json/new?' + encodeURIComponent('about:blank'));
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function openTab() {
  const info = await cdpNewTab();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      errors.push(d.text || '脚本异常');
    }
  };
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve: resolve, reject: reject });
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  return {
    errors: errors,
    close: () => ws.close(),
    send: send,
    async eval(expression, timeoutMs) {
      const r = await send('Runtime.evaluate', {
        expression: expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: timeoutMs || 60000,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本错误');
      // 表达式算出来是函数（忘了写结尾的调用括号）时，返回的会是 undefined。
      // 这类错误以前被静默吞成「测量值 undefined」，排查了半天，这里显式拦住。
      if (r.result && r.result.type === 'function') {
        throw new Error('测量表达式只算出了一个函数，没执行——检查结尾是不是漏了 ()');
      }
      return r.result.value;
    },
  };
}

// ---------- 造卡片状态 ----------
// 全部用 data URL 的 1×1 PNG，避免基准跑起来要真读磁盘上的图片。
// 这里不追求画面好看，只求 DOM 结构与真实卡片一致（媒体区 / 状态区 / 标题 / 编号）。
//
// 注意 id 要带档位前缀（tag）：三档画布都存在同一个库里，而 store.saveState 对
// 「已被别的画布占用的节点 id」会当场改名。都用 n0/n1… 的话，第二档开始
// id 就全被打乱，后面按 id 找卡片的测量会全部落空（这个坑已经被踩过一次）。
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function buildState(count, tag) {
  const prefix = (tag || 'b') + '_';
  const nodes = [];
  const edges = [];
  const cols = Math.max(1, Math.round(Math.sqrt(count)));
  for (let i = 0; i < count; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    nodes.push({
      id: prefix + 'n' + i,
      type: 'image',
      x: col * 400,
      y: row * 300,
      w: 360,
      h: 240,
      z: i,
      data: {
        params: { size: '2K', ratio: '16:9', count: '1' },
        model: '',
        text: '基准卡片 ' + i,
        result: { url: TINY_PNG, file: '', kind: 'image', width: 1, height: 1, at: Date.now() },
        history: [],
      },
    });
    // 每三张连一条线，让渲染时连线的开销也计入
    if (i > 0 && i % 3 === 0) {
      edges.push({ id: prefix + 'e' + i, sourceId: prefix + 'n' + (i - 3), targetId: prefix + 'n' + i, role: '' });
    }
  }
  return { nodes: nodes, edges: edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

function findChrome() {
  for (const one of CHROME_CANDIDATES) {
    try { if (one && fs.statSync(one).isFile()) return one; } catch { /* 下一项 */ }
  }
  return null;
}

// ---------- 打开耗时的采集 ----------
// 关键：计时必须在导航之前就装好，否则「页面都画完了才去测」量到的必然接近 0。
// 用 Page.addScriptToEvaluateOnNewDocument 在文档最开始注入一段观察脚本：
// 它从 performance.now() 起点开始逐帧观察，记下卡片数量首次达到目标（从 URL 的
// __bench 参数读）的时刻。卡片画完那一刻的 performance.now() 就是「从导航到画完」。
const OPEN_WATCHER = `
(function () {
  var target = Number((location.search.match(/[?&]__bench=(\\d+)/) || [])[1]) || 0;
  window.__benchOpen = { target: target, readyMs: null, paintedMs: null, saw: 0 };
  if (!target) return;
  var readyAt = null;
  var framesAfterReady = 0;
  function look() {
    var n = document.querySelectorAll('.node').length;
    window.__benchOpen.saw = n;
    if (readyAt === null) {
      if (n >= target) readyAt = performance.now();
    } else {
      framesAfterReady += 1;
      if (framesAfterReady >= 2) {
        window.__benchOpen.readyMs = Math.round(readyAt * 100) / 100;
        window.__benchOpen.paintedMs = Math.round(performance.now() * 100) / 100;
        return;
      }
    }
    requestAnimationFrame(look);
  }
  requestAnimationFrame(look);
})();
`;

const MEASURE_OPEN = `
(async function () {
  var o = window.__benchOpen || null;
  // watcher 是在卡片出现后「再等两帧」才把 readyMs 写进去的，
  // 外层轮询一看到有卡片就进来取值，这时它是 null。这里自己等它落地（最多 60 帧）。
  if (o) {
    for (var i = 0; i < 60 && o.readyMs === null; i += 1) {
      await new Promise(function (r) { requestAnimationFrame(r); });
    }
  }
  var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
  return {
    nodes: document.querySelectorAll('.node').length,
    watcherSaw: o ? o.saw : null,
    readyMs: o ? o.readyMs : null,
    paintedMs: o ? o.paintedMs : null,
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd * 100) / 100 : null,
    loadMs: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd * 100) / 100 : null,
  };
})()`;

// 平移 / 缩放帧率：连续派发 wheel 事件（缩放）与 pointermove（平移），
// 用 rAF 统计这一段时间内的帧间隔。frameMs 越小越顺，fps 越大越顺。
const MEASURE_FRAMES = `
(async function (rounds) {
  var viewport = document.querySelector('.viewport') || document.body;
  var frames = [];
  var last = 0;
  var stop = false;
  function tick(now) {
    if (last) frames.push(now - last);
    last = now;
    if (!stop) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  for (var i = 0; i < rounds; i += 1) {
    var delta = i % 2 === 0 ? 120 : -120;
    viewport.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: delta, clientX: 400, clientY: 300,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 400 + i, clientY: 300 + i }));
    await new Promise(function (r) { requestAnimationFrame(r); });
  }
  stop = true;
  await new Promise(function (r) { setTimeout(r, 120); });
  if (!frames.length) return { frameCount: 0, avgMs: null, p95Ms: null, fps: null };
  var sorted = frames.slice().sort(function (a, b) { return a - b; });
  var sum = frames.reduce(function (a, b) { return a + b; }, 0);
  var avg = sum / frames.length;
  var p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return {
    frameCount: frames.length,
    avgMs: Math.round(avg * 100) / 100,
    p95Ms: Math.round(p95 * 100) / 100,
    fps: Math.round((1000 / avg) * 10) / 10,
  };
})`;

// 改一张卡参数的重排耗时：点开再收起，走的是卡片展开 / 参数区重建这条最重的路径。
// 用 performance.now() 夹住，量的是同步耗时；跑 5 轮取平均，避免单次被 GC 抖动带偏。
const MEASURE_REPARAM = `
(function (prefix) {
  var el = document.querySelector('.node[data-id="' + prefix + 'n0"]');
  if (!el) return { ok: false, reason: '找不到 ' + prefix + 'n0' };
  var total = 0;
  for (var i = 0; i < 5; i += 1) {
    var box = el.getBoundingClientRect();
    var a = performance.now();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: box.left + 10, clientY: box.top + 10 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: box.left + 10, clientY: box.top + 10 }));
    total += performance.now() - a;
    // 收起：点空白处
    var vp = document.querySelector('.viewport') || document.body;
    var vb = vp.getBoundingClientRect();
    vp.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: vb.right - 5, clientY: vb.bottom - 5 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: vb.right - 5, clientY: vb.bottom - 5 }));
  }
  return { ok: true, reparamMs: Math.round((total / 5) * 100) / 100 };
})`;

// 展开面板耗时：点开一张卡片，量到面板真的出现在 DOM 里（.node.expanded + .node-panel）
const MEASURE_EXPAND = `
(async function (prefix) {
  var id = prefix + 'n1';
  var el = document.querySelector('.node[data-id="' + id + '"]');
  if (!el) return { ok: false, reason: '找不到 ' + id };
  var box = el.getBoundingClientRect();
  var t0 = performance.now();
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: box.left + 10, clientY: box.top + 10 }));
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: box.left + 10, clientY: box.top + 10 }));
  var expanded = false;
  for (var i = 0; i < 60; i += 1) {
    await new Promise(function (r) { requestAnimationFrame(r); });
    var now = document.querySelector('.node[data-id="' + id + '"]');
    if (now && now.classList.contains('expanded') && now.querySelector('.node-panel')) { expanded = true; break; }
  }
  var ms = performance.now() - t0;
  return { ok: expanded, expandMs: Math.round(ms * 100) / 100 };
})`;

async function measureOne(tab, url, count, prefix) {
  const t0 = Date.now();
  await tab.send('Page.navigate', { url: url });
  // 等页面把卡片画出来（最多 90 秒，300 张冷启动 + 无头模式可能慢）
  let saw = 0;
  for (let i = 0; i < 900; i += 1) {
    saw = await tab.eval('document.querySelectorAll(".node").length').catch(() => 0);
    if (saw > 0) break;
    await sleep(100);
  }
  const wallOpenMs = Date.now() - t0;
  const open = await tab.eval(MEASURE_OPEN);
  const frames = await tab.eval(MEASURE_FRAMES + '(40)');
  const reparam = await tab.eval(MEASURE_REPARAM + '("' + prefix + '")');
  const expand = await tab.eval(MEASURE_EXPAND + '("' + prefix + '")');
  return {
    count: count,
    renderedNodes: open.nodes,
    openReadyMs: open.readyMs,
    openPaintedMs: open.paintedMs,
    openWallMs: wallOpenMs,
    domContentLoadedMs: open.domContentLoadedMs,
    loadMs: open.loadMs,
    frames: frames,
    reparamMs: reparam.ok ? reparam.reparamMs : null,
    expandMs: expand.ok ? expand.expandMs : null,
    notes: [
      saw !== count ? '实际渲染 ' + saw + ' 张（期望 ' + count + '）' : '',
      reparam.reason || '',
      expand.reason || '',
    ].filter(Boolean).join(' / '),
  };
}

(async () => {
  const arg = process.argv.find((one) => one.indexOf('--sizes=') === 0) || '';
  const sizes = (arg ? arg.slice('--sizes='.length) : '30,100,300')
    .split(',')
    .map((one) => Number(one.trim()))
    .filter((one) => one > 0);

  if (!sizes.length) {
    console.log('没有有效的档位。用法：--sizes=30,100,300');
    process.exit(1);
  }
  // 从大到小先跑小档还是大档？从小到大跑，中途出问题至少前面的数据能用
  sizes.sort((a, b) => a - b);

  const chromePath = findChrome();
  if (!chromePath) {
    console.log('没找到 Chrome 或 Edge，无法跑基准。装了 Chromium 内核浏览器再来，或用 CANVAS_BENCH_BROWSER 指定路径。');
    process.exit(1);
  }

  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-bench-'));
  const chromeDir = path.join(box, 'chrome');
  const appDir = path.join(box, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(chromeDir, { recursive: true });
  for (const sub of ['web', 'server']) {
    fs.cpSync(path.join(ROOT, sub), path.join(appDir, sub), { recursive: true });
  }
  const dataDir = path.join(appDir, 'data');
  // api() 要读它：守卫要求每个接口请求带钥匙
  TOKEN_FILE = path.join(dataDir, 'admin-token.txt');
  fs.mkdirSync(dataDir, { recursive: true });
  const assetRoot = path.join(appDir, '素材');
  fs.mkdirSync(assetRoot, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ port: PORT, assetRoot: assetRoot }, null, 2),
    'utf8'
  );

  console.log('数据目录（隔离）：' + dataDir);
  const server = spawn(process.execPath, [path.join(appDir, 'server', 'index.js'), '--no-browser'], {
    cwd: appDir,
    env: Object.assign({}, process.env, {
      http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '',
      CANVAS_DATA_DIR: dataDir,
    }),
    stdio: 'ignore',
  });

  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await localGet('http://127.0.0.1:' + PORT + '/api/health', 3000);
      if (r.status === 200) { up = true; break; }
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  if (!up) {
    console.log('服务没起来');
    server.kill();
    process.exit(1);
  }

  const chrome = spawn(
    chromePath,
    ['--headless=new', '--disable-gpu', '--remote-debugging-port=9354',
      '--user-data-dir=' + chromeDir, '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate', 'about:blank'],
    { stdio: 'ignore', detached: false }
  );
  let cdpReady = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await localGet(CDP + '/json/version', 3000);
      if (r.status === 200) { cdpReady = true; break; }
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  if (!cdpReady) {
    console.log('浏览器没起来（CDP 端口无响应）');
    chrome.kill(); server.kill();
    process.exit(1);
  }

  const tab = await openTab();
  // 打开耗时的观察脚本必须在文档最开始注入，否则会漏掉加载过程
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: OPEN_WATCHER });
  const results = [];

  for (const count of sizes) {
    process.stdout.write('跑 ' + count + ' 张……');
    const prefix = 'b' + count + '_';
    const created = JSON.parse((await api(PORT, 'POST', '/api/canvases', { name: '基准 ' + count })).body);
    const canvasId = created.canvas.id;
    const state = buildState(count, 'b' + count);
    const saved = await api(PORT, 'PUT', '/api/canvases/' + canvasId, state);
    if (saved.status !== 200) {
      console.log(' 写测试数据失败：' + saved.body.slice(0, 160));
      continue;
    }
    const url = 'http://127.0.0.1:' + PORT + '/canvas.html?id=' + canvasId + '&__bench=' + count;
    const one = await measureOne(tab, url, count, prefix);
    const bad = tab.errors.filter((one2) => one2 && one2.indexOf('favicon') < 0);
    one.pageErrors = bad.length;
    results.push(one);
    console.log(
      ' 打开 ' + (one.openReadyMs === null ? 'n/a' : one.openReadyMs + 'ms') +
      '（绘制完成 ' + (one.openPaintedMs === null ? 'n/a' : one.openPaintedMs + 'ms') + '，墙钟 ' + one.openWallMs + 'ms）｜' +
      '帧 ' + (one.frames.fps === null ? 'n/a' : one.frames.fps + 'fps / 均 ' + one.frames.avgMs + 'ms / p95 ' + one.frames.p95Ms + 'ms') + '｜' +
      '改参数 ' + one.reparamMs + 'ms｜展开 ' + one.expandMs + 'ms' +
      (one.notes ? '  [' + one.notes + ']' : '')
    );
  }

  tab.close();
  chrome.kill();
  server.kill();
  await sleep(400);

  const stamp = new Date();
  const ymd =
    stamp.getFullYear() + '-' +
    String(stamp.getMonth() + 1).padStart(2, '0') + '-' +
    String(stamp.getDate()).padStart(2, '0');
  const outFile = path.join(OUT_DIR, 'result-' + ymd + '.json');
  const payload = {
    at: stamp.toISOString(),
    platform: process.platform + ' ' + process.arch,
    node: process.version,
    note: '固定 30/100/300 张三档；数值随机器波动，只用于同机对比',
    results: results,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  console.log('\n结果已写入：' + outFile);
  console.log('（同机再跑一次对比即可看出改动是否真的更快；跨机器数值不可比）');

  try { fs.rmSync(box, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  process.exit(0);
})().catch((error) => {
  console.log('基准脚本异常：' + (error && error.message));
  process.exit(1);
});
