'use strict';
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const CANVAS_SRC = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function report(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }
}
function pickFunction(name) {
  const at = CANVAS_SRC.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('源码里找不到函数 ' + name);
  let depth = 0; let started = false;
  for (let i = at; i < CANVAS_SRC.length; i += 1) {
    const ch = CANVAS_SRC[i];
    if (ch === '{') { depth += 1; started = true; }
    else if (ch === '}') { depth -= 1; if (started && depth === 0) return CANVAS_SRC.slice(at, i + 1); }
  }
  throw new Error('函数 ' + name + ' 的花括号没配对');
}
function checkSync(name, fn) {
  try { fn(); report(name, true); }
  catch (error) { report(name, false, error.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function localGet(url, method) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET' }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('timeout'))); req.end();
  });
}
async function runBrowser() {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'dbl-'));
  const dataDir = path.join(box, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  const cdpPort = 9488; const cdp = 'http://127.0.0.1:' + cdpPort;
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--no-browser'], { cwd: ROOT, env: Object.assign({}, process.env, { CANVAS_DATA_DIR: dataDir, http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '' }), stdio: 'ignore' });
  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dbl-chrome-'));
  const chrome = spawn(edge, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok, detail }); report(name, ok, detail); };
  try {
    let port = 0, token = '';
    for (let i = 0; i < 120; i++) { try { port = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')).port; } catch { port = 0; } if (port) { try { if ((await localGet('http://127.0.0.1:' + port + '/api/health')).status === 200) break; } catch {} } await sleep(250); }
    token = fs.readFileSync(path.join(dataDir, 'admin-token.txt'), 'utf8').trim();
    const api = (method, p, body) => new Promise((resolve, reject) => {
      const data = body == null ? null : JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'x-local-token': token }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
        let buf = ''; res.setEncoding('utf8'); res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', reject); req.end(data || undefined);
    });
    const created = JSON.parse((await api('POST', '/api/canvases', { name: '双击放大' })).body);
    // 用 /api/assets/import 传一张真实图片，拿回 /media/ 地址
    const pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAF0lEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
    const up = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port,
        path: '/api/assets/import?canvasId=' + created.canvas.id + '&name=pic.png&kind=image&dup=copy',
        method: 'POST',
        headers: { 'x-local-token': token, 'Content-Type': 'application/octet-stream', 'Content-Length': pngBuf.length },
      }, (res) => {
        let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject); req.end(pngBuf);
    });
    console.log('上传素材：' + up.status + ' ' + up.body.slice(0, 160));
    await sleep(300);

    const t = '这是一张图片卡片的提示词内容，用来确认单击能弹出提示词栏、双击只放大。';
    // 先用一张「只有结果地址」的图片卡：直接引用已上传素材
    let assetUrl = '';
    try { assetUrl = JSON.parse(up.body).asset.url; } catch { assetUrl = ''; }
    if (!assetUrl) throw new Error('素材上传失败：' + up.body.slice(0, 200));
    await api('PUT', '/api/canvases/' + created.canvas.id, {
      nodes: [
        { id: 'img1', type: 'image', x: 260, y: 140, w: 420, h: 280, z: 0, createdAt: 1000,
          data: { v: 3, text: t, model: '', params: {}, no: 1, result: { url: assetUrl, kind: 'image' } } },
        { id: 'e1', type: 'image', x: 820, y: 140, w: 420, h: 280, z: 1, createdAt: 1001,
          data: { v: 3, text: '空卡片', model: '', params: {}, no: 2 } },
      ],
      edges: [], viewport: { x: 0, y: 0, zoom: 0.95 },
    });

    for (let i = 0; i < 60; i++) { try { if ((await localGet(cdp + '/json/version')).status === 200) break; } catch {} await sleep(250); }
    const info = JSON.parse((await localGet(cdp + '/json/new?' + encodeURIComponent('about:blank'), 'PUT')).body);
    ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0; const pending = new Map();
    ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result); } };
    const send = (m, p) => new Promise((res, rej) => { seq += 1; pending.set(seq, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: seq, method: m, params: p || {} })); });
    const evalJs = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/canvas?id=' + created.canvas.id });
    for (let i = 0; i < 100; i++) { if ((await evalJs('document.querySelectorAll("#world .node").length')) > 1) break; await sleep(300); }
    await sleep(1800);

    const rectOf = (sel) => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), top: Math.round(r.top), left: Math.round(r.left) }; })()`);
    const state = () => evalJs(`(() => {
      const n = document.querySelector('#world .node[data-id="img1"]');
      return {
        expanded: n.classList.contains('expanded'),
        selected: n.classList.contains('selected'),
        lightbox: !!document.querySelector('.media-lightbox'),
        panelDisplay: (() => { const p = n.querySelector('.node-panel'); return p ? getComputedStyle(p).display : 'none'; })(),
      };
    })()`);
    const single = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(50);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
    };
    const dbl = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(40);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
      await sleep(60);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2, buttons: 1 });
      await sleep(40);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2, buttons: 0 });
      await sleep(500);
    };
    const closeLightbox = async () => {
      await evalJs(`(() => { const b = document.querySelector('.media-lightbox-close'); if (b) b.click(); return true; })()`);
      await sleep(400);
    };

    const cardPoint = async () => { const r = await rectOf('#world .node[data-id="img1"]'); return { x: r.x, y: r.top + 60 }; };
    const blankPoint = () => evalJs(`(() => {
      const w = window.innerWidth, h = window.innerHeight;
      for (const y of [Math.round(h*0.16), Math.round(h*0.24), Math.round(h*0.32), Math.round(h*0.42)]) {
        for (const x of [Math.round(w*0.72), Math.round(w*0.8), Math.round(w*0.88)]) {
          const el = document.elementFromPoint(x, y);
          if (el && (el.id === 'viewport' || el.id === 'world')) return { x, y };
        }
      }
      return null;
    })()`);

    // ① 单击：应该只选中 + 弹出提示词栏，不开放大窗
    let p1 = await cardPoint();
    await single(p1.x, p1.y); await sleep(800);
    let s = await state();
    check('① 单击 → 弹出提示词栏、不放大', s.expanded && !s.lightbox && s.panelDisplay !== 'none', JSON.stringify(s));

    // 点空白收起
    const blank = await blankPoint();
    check('· 找到空白点', !!blank, JSON.stringify(blank));
    await single(blank.x, blank.y); await sleep(700);
    s = await state();
    check('② 点空白 → 面板收起', !s.expanded, JSON.stringify(s));

    // ③ 双击：应该只放大，不弹提示词栏
    let p3 = await cardPoint();
    await dbl(p3.x, p3.y); await sleep(700);
    s = await state();
    check('③ 双击 → 只放大、提示词栏不弹', s.lightbox && !s.expanded, JSON.stringify(s));

    await closeLightbox(); await sleep(500);
    s = await state();
    check('④ 关掉放大窗后 → 提示词栏仍然不弹', !s.lightbox && !s.expanded, JSON.stringify(s));

    // ⑤ 先单击开面板，再双击：面板应收起、只放大
    let p5 = await cardPoint();
    await single(p5.x, p5.y); await sleep(800);
    s = await state();
    check('⑤ 再单击 → 面板又弹出（单击仍然可用）', s.expanded, JSON.stringify(s));
    let p6 = await cardPoint();
    await dbl(p6.x, p6.y); await sleep(700);
    s = await state();
    check('⑥ 面板开着时双击 → 收起面板 + 只放大', s.lightbox && !s.expanded, JSON.stringify(s));
    await closeLightbox(); await sleep(500);

    // ⑦ 空卡片双击：不放大的同时也仍然双击不出菜单（应弹「新建卡片」菜单，因为是卡片上）
    const empty = await rectOf('#world .node[data-id="e1"]');
    await single(empty.x, empty.top + 60); await sleep(800);
    s = await evalJs(`(() => { const n = document.querySelector('#world .node[data-id="e1"]'); return { expanded: n.classList.contains('expanded') }; })()`);
    check('⑦ 没有生成结果的空卡片：单击照样弹提示词栏（不受影响）', s.expanded, JSON.stringify(s));

  } finally {
    try { if (ws) ws.close(); } catch {}
    chrome.kill(); server.kill();
  }
}

console.log('\nA. 源码规则');
checkSync('媒体卡片按下时走 scheduleExpand（不再直接 setExpanded）', () => {
  const body = pickFunction('buildNode');
  const at = body.indexOf("closest('video, audio')");
  assert(at > 0, '找不到「点在视频 / 音频本体上」那段');
  assert(/scheduleExpand\(/.test(body.slice(at, at + 900)), '媒体本体的按下分支没走 scheduleExpand');
});
checkSync('单击（没拖动）分支：能放大的卡片走 scheduleExpand', () => {
  const body = pickFunction('startDrag');
  const at = body.indexOf('点一下（没有拖动）');
  assert(at > 0, '找不到「点一下（没有拖动）」那段');
  assert(/scheduleExpand\(/.test(body.slice(at, at + 700)), '单击分支没走 scheduleExpand');
});
checkSync('双击第一件事是撤掉押后的展开', () => {
  const body = pickFunction('buildNode');
  const at = body.indexOf("addEventListener('dblclick'");
  assert(at > 0, '找不到 dblclick 监听');
  assert(/cancelPendingExpand\(\)/.test(body.slice(at, at + 400)), '双击里没有 cancelPendingExpand()');
});
checkSync('双击时面板开着要一并收起', () => {
  const body = pickFunction('buildNode');
  const at = body.indexOf("addEventListener('dblclick'");
  assert(/if \(expandedId === node\.id\) setExpanded\(null\)/.test(body.slice(at, at + 1800)), '双击里没有收起已开面板');
});
checkSync('canZoomNode 只认有结果的图片 / 视频', () => {
  const body = pickFunction('canZoomNode');
  assert(/result\.url/.test(body), 'canZoomNode 没看 result.url');
  assert(/kind === 'image'/.test(body) && /kind === 'video'/.test(body), 'canZoomNode 没限定 image / video');
});
checkSync('拖动起来了就撤掉押后的展开', () => {
  assert(/cancelPendingExpand\(\)/.test(pickFunction('startDrag')), 'startDrag 里没有 cancelPendingExpand');
});

console.log('\nB. 端到端（真服务 + 无头浏览器 + 真实鼠标）');
(async () => {
  try {
    await runBrowser();
  } catch (error) {
    report('端到端没跑完', false, error.message);
  }
  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
