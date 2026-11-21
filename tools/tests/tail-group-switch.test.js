'use strict';

// 尾部提示词：视频 / 图片两组**各自独立的开关**（结构版本 2 → 3）
//
// 用户诉求：视频尾部提示词常用、图片尾部提示词不常用，不该共用一个开关。
//
// 这个文件守五件事：
//   A. 归一化：老配置（2 版一个开关管两组）迁移后**行为不变**，不丢预设
//   B. 服务端 resolveTail 按**自己那一类**判开关，另一类完全不受影响
//   C. 全新安装默认：视频开 / 图片关
//   D. /api/settings 真能存下两组独立开关，并且 reload 后还在
//   E. 前端：左侧浮层两行各自一个开关，点一下只改自己那一组
//
// 运行：runtime/node.exe tools/tests/tail-group-switch.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CANVAS_SRC = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'ui.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'style.css'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'web', 'canvas.html'), 'utf8');
const SERVER = path.join(ROOT, 'server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function report(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }
}
function check(name, fn) {
  try { fn(); report(name, true); }
  catch (error) { report(name, false, error.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); report(name, true); }
  catch (error) { report(name, false, error.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(got, want, msg) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
  }
}

// 隔离数据目录：必须在 require server/*.js 之前建立
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-group-'));
const paths = require(path.join(__dirname, '_isolate.js'))(box);
const configStore = require(path.join(SERVER, 'config.js'));
const generate = require(path.join(SERVER, 'generate.js'));

function freshConfig() {
  // config.js 在模块加载时就算好了 CONFIG_FILE，重载模块即可复用同一隔离目录
  Object.keys(require.cache).forEach((key) => {
    if (key.indexOf(SERVER + path.sep) === 0 && key.indexOf('paths.js') < 0 && key.indexOf('keybox.js') < 0) {
      delete require.cache[key];
    }
  });
  return require(path.join(SERVER, 'config.js'));
}

console.log('\nA. 归一化：老配置迁移后行为不变');

check('2 版扁平结构（开着）：预设全进视频组，两组都开', () => {
  const n = configStore.normalizeTailPrompts({
    enabled: true,
    defaultId: 'old1',
    presets: [{ id: 'old1', name: '3D国漫风格', text: '那套 335 字' }],
  });
  eq(n.groups.video.presets.length, 1, '老预设应当迁进视频组');
  eq(n.groups.image.presets.length, 0, '图片组必须留空');
  eq(n.groups.video.enabled, true, '视频组沿用顶层开关');
  eq(n.groups.image.enabled, true, '图片组也沿用顶层开关 —— 升级不能悄悄关掉它');
});

check('2 版扁平结构（关着）：两组都关', () => {
  const n = configStore.normalizeTailPrompts({
    enabled: false,
    presets: [{ id: 'a', name: 'A', text: 'x' }],
  });
  eq(n.groups.video.enabled, false);
  eq(n.groups.image.enabled, false);
});

check('2 版已分组但缺 enabled：每组都回落到顶层', () => {
  const n = configStore.normalizeTailPrompts({
    enabled: false,
    groups: {
      video: { defaultId: 'v', presets: [{ id: 'v', text: 'vv' }] },
      image: { defaultId: 'i', presets: [{ id: 'i', text: 'ii' }] },
    },
  });
  eq(n.groups.video.enabled, false);
  eq(n.groups.image.enabled, false);
  eq(n.groups.video.presets.length, 1);
  eq(n.groups.image.presets.length, 1);
});

check('混了空 groups 的老配置：预设不能被"空 groups"挤掉', () => {
  const n = configStore.normalizeTailPrompts({
    enabled: true,
    groups: { video: { defaultId: '', presets: [] }, image: { defaultId: '', presets: [] } },
    defaultId: 'old1',
    presets: [{ id: 'old1', name: '3D国漫风格', text: '335 字' }],
  });
  eq(n.groups.video.presets.length, 1, '老预设丢了 —— 那是真实事故的形状');
  eq(n.groups.image.presets.length, 0);
});

check('3 版结构（每组带 enabled）原样保留', () => {
  const n = configStore.normalizeTailPrompts({
    enabled: true,
    groups: {
      video: { enabled: true, presets: [{ id: 'v', text: 'vv' }], defaultId: 'v' },
      image: { enabled: false, presets: [{ id: 'i', text: 'ii' }], defaultId: 'i' },
    },
  });
  eq(n.groups.video.enabled, true);
  eq(n.groups.image.enabled, false);
  eq(n.groups.video.presets.length, 1);
  eq(n.groups.image.presets.length, 1);
});

check('顶层 enabled 只作兼容视图（= 视频组）', () => {
  const n = configStore.normalizeTailPrompts({
    groups: {
      video: { enabled: false, presets: [{ id: 'v', text: 'vv' }], defaultId: 'v' },
      image: { enabled: true, presets: [{ id: 'i', text: 'ii' }], defaultId: 'i' },
    },
  });
  eq(n.enabled, false, '顶层 enabled 应等于视频组开关');
  eq(n.presets.length, 1, '顶层 presets 应是视频组的兼容视图');
});

check('全新安装默认：视频开 / 图片关', () => {
  const d = configStore.defaultConfig();
  eq(d.tailPrompts.groups.video.enabled, true);
  eq(d.tailPrompts.groups.image.enabled, false);
});

check('**load() 不会把新默认值的「图片关」混进老配置**', () => {
  const cfg = freshConfig();
  // 2 版老配置：一个开关管两组，开着
  fs.writeFileSync(paths.CONFIG_FILE, JSON.stringify({
    tailPrompts: { enabled: true, defaultId: 'a', presets: [{ id: 'a', name: 'A', text: '335 字' }] },
  }, null, 2));
  const loaded = cfg.load();
  eq(loaded.tailPrompts.groups.video.presets.length, 1, '预设丢了');
  eq(loaded.tailPrompts.groups.video.enabled, true);
  eq(loaded.tailPrompts.groups.image.enabled, true,
    '图片组被新默认值悄悄关掉了 —— merge(defaultConfig()) 之后归一就会这样');
});

check('load()：全新安装（没有 config.json）才用新默认值', () => {
  try { fs.unlinkSync(paths.CONFIG_FILE); } catch {}
  const cfg = freshConfig();
  const loaded = cfg.load();
  eq(loaded.tailPrompts.groups.video.enabled, true);
  eq(loaded.tailPrompts.groups.image.enabled, false);
});

check('load()：2 版老配置关着时，两组都还是关', () => {
  const cfg = freshConfig();
  fs.writeFileSync(paths.CONFIG_FILE, JSON.stringify({
    tailPrompts: { enabled: false, presets: [{ id: 'a', name: 'A', text: 'x' }] },
  }, null, 2));
  const loaded = cfg.load();
  eq(loaded.tailPrompts.groups.video.enabled, false);
  eq(loaded.tailPrompts.groups.image.enabled, false);
  try { fs.unlinkSync(paths.CONFIG_FILE); } catch {}
});

console.log('\nB. 服务端：按自己那一类判开关');

function cfgOf(videoEnabled, imageEnabled) {
  return {
    tailPrompts: configStore.normalizeTailPrompts({
      groups: {
        video: { enabled: videoEnabled, defaultId: 'v1', presets: [{ id: 'v1', name: 'V', text: 'VIDEO-TAIL' }] },
        image: { enabled: imageEnabled, defaultId: 'i1', presets: [{ id: 'i1', name: 'I', text: 'IMAGE-TAIL' }] },
      },
    }),
  };
}
const asked = { tailPrompt: { enabled: true, presetId: '' } };

check('图片组关：图片卡不追加，视频卡照常', () => {
  const cfg = cfgOf(true, false);
  const v = generate.resolveTail(cfg, asked, 'video');
  const i = generate.resolveTail(cfg, asked, 'image');
  eq(v.enabled, true, '视频卡不该受图片组影响');
  eq(v.text, 'VIDEO-TAIL');
  eq(i.enabled, false, '图片组关着还追加了');
});

check('视频组关：视频卡不追加，图片卡照常', () => {
  const cfg = cfgOf(false, true);
  eq(generate.resolveTail(cfg, asked, 'video').enabled, false);
  const i = generate.resolveTail(cfg, asked, 'image');
  eq(i.enabled, true, '图片卡不该受视频组影响');
  eq(i.text, 'IMAGE-TAIL');
});

check('两组都关：谁都不追加', () => {
  const cfg = cfgOf(false, false);
  eq(generate.resolveTail(cfg, asked, 'video').enabled, false);
  eq(generate.resolveTail(cfg, asked, 'image').enabled, false);
});

check('两组都开：各取各的池子，互不串味', () => {
  const cfg = cfgOf(true, true);
  eq(generate.resolveTail(cfg, asked, 'video').text, 'VIDEO-TAIL');
  eq(generate.resolveTail(cfg, asked, 'image').text, 'IMAGE-TAIL');
});

check('老配置（没有 enabled 字段）仍按顶层走，不炸', () => {
  const legacy = { tailPrompts: { enabled: true, defaultId: 'a', presets: [{ id: 'a', text: 'OLD' }] } };
  eq(generate.resolveTail(legacy, asked, 'video').text, 'OLD');
  const legacyOff = { tailPrompts: { enabled: false, defaultId: 'a', presets: [{ id: 'a', text: 'OLD' }] } };
  eq(generate.resolveTail(legacyOff, asked, 'video').enabled, false);
});

check('composeSubmission：关掉图片组后图片卡只发主提示词', () => {
  const cfg = cfgOf(true, false);
  eq(generate.composeSubmission(cfg, { prompt: '主体', ...asked }, 'image').apiPrompt, '主体');
  eq(generate.composeSubmission(cfg, { prompt: '主体', ...asked }, 'video').apiPrompt, '主体\n\nVIDEO-TAIL');
});

console.log('\nC. 前端：只有一份开关实现，两个点各亮各的');

check('源码里不再有「总开关」写法（enabledEl / toggleTailPrompts）', () => {
  assert(UI_SRC.indexOf('enabledEl') < 0, 'ui.js 里还有 enabledEl 残留');
  assert(CANVAS_SRC.indexOf('function toggleTailPrompts(') < 0, 'canvas.js 里还留着旧的 toggleTailPrompts');
  assert(CANVAS_SRC.indexOf('#tail-enabled') < 0, 'canvas.js 里还引用着已删除的 #tail-enabled');
});

check('左侧按钮有视频 / 图片两个点，各带自己的 id', () => {
  assert(/id="tail-prompts-dot"/.test(HTML_SRC), '缺少视频组的点');
  assert(/id="tail-prompts-dot-image"/.test(HTML_SRC), '缺少图片组的点');
  assert(/rail-dot-video/.test(HTML_SRC) && /rail-dot-image/.test(HTML_SRC), '两个点没有各自的定位类');
});

check('浮层样式齐全（行、开关、滑块、预设按钮）', () => {
  ['.tail-pop', '.tail-pop-row', '.tail-pop-switch', '.tail-pop-knob', '.tail-pop-manage'].forEach((sel) => {
    assert(CSS_SRC.indexOf(sel) >= 0, 'style.css 缺少 ' + sel);
  });
});

check('浮层贴在侧栏**真实右边缘**，双列 / 三列也不会压住图标', () => {
  const at = CANVAS_SRC.indexOf('function openTailPop(');
  assert(at > 0, '找不到 openTailPop');
  const body = CANVAS_SRC.slice(at, at + 1400);
  assert(/rail-group/.test(body), '定位没量侧栏宽度（双列时会压住按钮）');
  assert(/rect\.right/.test(body) || /getBoundingClientRect/.test(body), '定位没用真实位置');
});

check('侧栏收起时浮层一起收（不会悬空留在屏幕上）', () => {
  const at = CANVAS_SRC.indexOf('    const close = () => {');
  assert(at > 0, '找不到侧栏的 close()');
  assert(/closeTailPop\(\)/.test(CANVAS_SRC.slice(at, at + 800)), '侧栏收起时没关浮层');
});

check('在浮层里点开关不会被当成「点了画布别处」', () => {
  const at = CANVAS_SRC.indexOf("// 点画布别处就收起来");
  assert(at > 0, '找不到点画布别处的监听');
  assert(/closest\('\.tail-pop'\)/.test(CANVAS_SRC.slice(at, at + 700)), '点浮层会把侧栏一起收掉');
});

check('鼠标从侧栏移进浮层时不算「离开侧栏」', () => {
  const at = CANVAS_SRC.indexOf("rail.addEventListener('mouseleave'");
  assert(at > 0, '找不到 mouseleave');
  assert(/closest\('\.tail-pop'\)/.test(CANVAS_SRC.slice(at, at + 500)), '移进浮层会被判为离开');
});

check('焦点从侧栏按钮移到浮层开关时，侧栏不能收起', () => {
  const at = CANVAS_SRC.indexOf("rail.addEventListener('focusout'");
  assert(at > 0, '找不到 focusout');
  const body = CANVAS_SRC.slice(at, at + 600);
  assert(/closest\('\.tail-pop'\)/.test(body),
    '焦点移到浮层会被判为离开侧栏 —— 点一下开关侧栏和浮层就一起没了');
});

check('切开关时两组都带上（少传一组会被服务端当默认值）', () => {
  const at = CANVAS_SRC.indexOf('async function toggleTailGroup(');
  assert(at > 0, '找不到 toggleTailGroup');
  const body = CANVAS_SRC.slice(at, at + 1600);
  assert(/video:\s*\{/.test(body) && /image:\s*\{/.test(body), '提交时没带全两组');
  assert(/enabled:/.test(body), '提交里没有 enabled');
});

console.log('\nD. 端到端：真服务 + 真浏览器');

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

async function runE2E() {
  const dataDir = path.join(box, 'e2e-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const cdpPort = 9483;
  const cdp = 'http://127.0.0.1:' + cdpPort;
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--no-browser'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      CANVAS_DATA_DIR: dataDir,
      http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '',
    }),
    stdio: 'ignore',
  });
  const edge = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find((p) => fs.existsSync(p));
  if (!edge) {
    console.log('  · 本机没有 Chrome / Edge，跳过端到端（A~C 已覆盖规则本身）');
    server.kill();
    return;
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-group-chrome-'));
  const chrome = spawn(edge, [
    '--headless=new', '--disable-gpu', '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  let ws = null;
  try {
    let port = 0;
    for (let i = 0; i < 140; i++) {
      try { port = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')).port; } catch { port = 0; }
      if (port) {
        try { if ((await localGet('http://127.0.0.1:' + port + '/api/health')).status === 200) break; } catch {}
      }
      await sleep(250);
    }
    if (!port) throw new Error('隔离服务没起来');
    let token = '';
    for (let i = 0; i < 40 && !token; i++) {
      try { token = fs.readFileSync(path.join(dataDir, 'admin-token.txt'), 'utf8').trim(); } catch { await sleep(150); }
    }

    const api = (method, p, body) => new Promise((resolve, reject) => {
      const data = body == null ? null : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port, path: p, method,
        headers: Object.assign({ 'x-local-token': token }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      }, (res) => {
        let buf = ''; res.setEncoding('utf8'); res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', reject); req.end(data || undefined);
    });

    // ① 先把配置写成「视频开 / 图片关，两边都有预设」
    const preset = (id, text) => ({ id, name: id, text });
    const save1 = await api('POST', '/api/settings', {
      tailPrompts: {
        enabled: true,
        groups: {
          video: { enabled: true, defaultId: 'v1', presets: [preset('v1', 'VIDEO-TAIL')] },
          image: { enabled: false, defaultId: 'i1', presets: [preset('i1', 'IMAGE-TAIL')] },
        },
      },
    });
    report('① /api/settings 收下了两组独立的开关', save1.status === 200, save1.status + ' ' + save1.body.slice(0, 200));

    // ② 重新读一遍，确认落盘的是两个不同值（不是被归成同一个）
    const st = JSON.parse((await api('GET', '/api/status')).body);
    const tp = st.tailPrompts || {};
    report('② /api/status 读回：视频开 / 图片关',
      tp.groups && tp.groups.video && tp.groups.video.enabled === true &&
      tp.groups.image && tp.groups.image.enabled === false,
      JSON.stringify(tp.groups));
    report('③ 结构版本号已经是 3', Number(st.tailSchemaVersion) === 3, String(st.tailSchemaVersion));

    // ④ 只关视频、图片保持关 —— 验证不会互相污染
    await api('POST', '/api/settings', {
      tailPrompts: {
        enabled: false,
        groups: {
          video: { enabled: false, defaultId: 'v1', presets: [preset('v1', 'VIDEO-TAIL')] },
          image: { enabled: true, defaultId: 'i1', presets: [preset('i1', 'IMAGE-TAIL')] },
        },
      },
    });
    const st2 = JSON.parse((await api('GET', '/api/status')).body);
    report('④ 反过来存也成立：视频关 / 图片开',
      st2.tailPrompts.groups.video.enabled === false && st2.tailPrompts.groups.image.enabled === true,
      JSON.stringify(st2.tailPrompts.groups));

    // ⑤ 浏览器里确认左侧按钮弹出浮层、两行各有开关
    const created = JSON.parse((await api('POST', '/api/canvases', { name: '尾部开关' })).body);
    for (let i = 0; i < 60; i++) { try { if ((await localGet(cdp + '/json/version')).status === 200) break; } catch {} await sleep(250); }
    const info = JSON.parse((await localGet(cdp + '/json/new?' + encodeURIComponent('about:blank'), 'PUT')).body);
    ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0; const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
      }
    };
    const send = (m, p) => new Promise((res, rej) => {
      seq += 1; pending.set(seq, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: seq, method: m, params: p || {} }));
    });
    const evalJs = async (e) => {
      const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/canvas?id=' + created.canvas.id });
    for (let i = 0; i < 120; i++) {
      if (await evalJs('document.readyState === "complete" && !!window.UITheme && !!document.getElementById("btn-tail-prompts")')) break;
      await sleep(250);
    }
    await sleep(900);

    // 侧栏平时贴着左边藏着，先把鼠标移到边缘让它滑出
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 450, buttons: 0 });
    await sleep(700);
    const railOpen = await evalJs('document.getElementById("rail").classList.contains("open")');
    report('⑤ 鼠标贴左边缘能滑出侧栏', railOpen === true, String(railOpen));

    await evalJs('document.getElementById("btn-tail-prompts").click()');
    await sleep(400);
    const pop = await evalJs(`(() => {
      const el = document.querySelector('.tail-pop');
      if (!el) return null;
      const rows = Array.from(el.querySelectorAll('.tail-pop-row'));
      const btn = document.getElementById('btn-tail-prompts').getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return {
        rows: rows.map((r) => ({ group: r.dataset.group, on: r.classList.contains('on') })),
        switches: el.querySelectorAll('.tail-pop-switch').length,
        manages: el.querySelectorAll('.tail-pop-manage').length,
        leftGap: Math.round(box.left - btn.right),
      };
    })()`);
    report('⑥ 单击左侧按钮弹出浮层', !!pop, JSON.stringify(pop));
    if (pop) {
      eq(pop.rows.map((r) => r.group), ['video', 'image'], '浮层应当正好两行：视频 / 图片');
      eq(pop.rows.find((r) => r.group === 'video').on, false, '当前是视频关，行状态不对');
      eq(pop.rows.find((r) => r.group === 'image').on, true, '当前是图片开，行状态不对');
      report('⑦ 每行各有一个开关和一个「预设」按钮', pop.switches === 2 && pop.manages === 2, JSON.stringify(pop));
    }

    // 点「视频」那一行的开关：只该翻转视频组
    const beforeImg = JSON.parse((await api('GET', '/api/status')).body).tailPrompts.groups.image.enabled;
    await evalJs(`(() => {
      const row = document.querySelector('.tail-pop-row[data-group="video"]');
      row.querySelector('.tail-pop-switch').click();
      return true;
    })()`);
    await sleep(1200);
    const after = JSON.parse((await api('GET', '/api/status')).body);
    report('⑧ 点视频开关：只有视频组翻转，图片组没动',
      after.tailPrompts.groups.video.enabled === true && after.tailPrompts.groups.image.enabled === beforeImg,
      JSON.stringify(after.tailPrompts.groups));

    // 点图片那一行的开关：反向验证
    await evalJs(`(() => {
      const row = document.querySelector('.tail-pop-row[data-group="image"]');
      row.querySelector('.tail-pop-switch').click();
      return true;
    })()`);
    await sleep(1200);
    const after2 = JSON.parse((await api('GET', '/api/status')).body);
    report('⑨ 点图片开关：只有图片组翻转，视频组没动',
      after2.tailPrompts.groups.video.enabled === true && after2.tailPrompts.groups.image.enabled === false,
      JSON.stringify(after2.tailPrompts.groups));

    // 左侧两个点：都关着才不亮，任何一个开着就亮
    const dots = await evalJs(`(() => {
      const v = document.getElementById('tail-prompts-dot');
      const i = document.getElementById('tail-prompts-dot-image');
      const btn = document.getElementById('btn-tail-prompts');
      return { v: v.hidden, i: i.hidden, lit: btn.classList.contains('on') };
    })()`);
    report('⑩ 视频开 / 图片关：两个点只有视频那个亮',
      dots.v === false && dots.i === true && dots.lit === true, JSON.stringify(dots));

    // ── 真实鼠标：侧栏是「贴边滑出」的浮层，指针进出很容易误判成离开 ──
    // 这里逐条守住：移到浮层上、点浮层里的开关，侧栏和浮层都不能跟着消失。
    const move = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    };
    const clickAt = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(40);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
    };
    const popState = () => evalJs(`(() => ({ pop: !!document.querySelector(".tail-pop"), rail: document.getElementById("rail").classList.contains("open") }))()`);
    const railBtnPoint = () => evalJs(`(() => { const r = document.getElementById("btn-tail-prompts").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);

    // 矮窗口是侧栏最容易出问题的场景（按钮会被压小、位置也会挪）
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 640, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    // 前面几步把浮层留在打开状态了，先移到画布中间让它和侧栏一起收起
    await move(760, 300);
    await sleep(1400);
    report('⑪ 切换窗口尺寸后侧栏与浮层都收起了', (await popState()).pop === false && (await popState()).rail === false, '');
    await move(3, 320);
    await sleep(900);
    const btnPt = await railBtnPoint();
    await move(btnPt.x, btnPt.y);
    await sleep(150);
    await clickAt(btnPt.x, btnPt.y);
    await sleep(450);
    report('⑫ 矮窗口里单击也能弹出浮层', await evalJs('!!document.querySelector(".tail-pop.open")') === true, '');

    const geom = await evalJs(`(() => { const el = document.querySelector(".tail-pop"); if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: innerWidth, h: innerHeight }; })()`);
    report('⑬ 浮层完整落在窗口内（不会被裁到屏幕外）',
      !!geom && geom.bottom <= geom.h && geom.right <= geom.w && geom.top >= 0, JSON.stringify(geom));

    const swPt = await evalJs(`(() => { const el = document.querySelector('.tail-pop-row[data-group="image"] .tail-pop-switch'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (swPt) {
      // 指针按真实路径挪过去（中间经过几个点），不是瞬移
      await move(btnPt.x + 10, btnPt.y);
      await sleep(80);
      await move(Math.round((btnPt.x + swPt.x) / 2), Math.round((btnPt.y + swPt.y) / 2));
      await sleep(80);
      await move(swPt.x, swPt.y);
      await sleep(900);
      let st = await popState();
      report('⑭ 指针移到浮层上：侧栏和浮层都还在', st.pop === true && st.rail === true, JSON.stringify(st));

      const imgBefore = JSON.parse((await api('GET', '/api/status')).body).tailPrompts.groups.image.enabled;
      const vidBefore = JSON.parse((await api('GET', '/api/status')).body).tailPrompts.groups.video.enabled;
      await clickAt(swPt.x, swPt.y);
      await sleep(1500);
      st = await popState();
      report('⑮ 点浮层里的开关后：浮层和侧栏都还开着（焦点移动不算离开）',
        st.pop === true && st.rail === true, JSON.stringify(st));

      const live = JSON.parse((await api('GET', '/api/status')).body).tailPrompts.groups;
      report('⑯ 这一次点击只翻转了图片组，视频组原样',
        live.image.enabled === !imgBefore && live.video.enabled === vidBefore,
        JSON.stringify({ imgBefore: imgBefore, vidBefore: vidBefore, now: live }));
    } else {
      report('⑭ 指针移到浮层上', false, '找不到图片行开关');
    }

    // 指针移回画布：侧栏和浮层都该收，不然浮层会悬空留在屏幕上
    await move(760, 300);
    await sleep(1400);
    const gone = await popState();
    report('⑰ 指针移回画布：侧栏与浮层一起收起', gone.pop === false && gone.rail === false, JSON.stringify(gone));

  } finally {
    try { if (ws) ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { server.kill(); } catch {}
  }
}

(async () => {
  try { await runE2E(); }
  catch (error) { report('端到端没跑完', false, error.message); }
  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('─'.repeat(52));
  process.exit(fail ? 1 : 0);
})();
