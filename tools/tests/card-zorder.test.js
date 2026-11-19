'use strict';

// 卡片层级：点中的卡片必须画在最上面（2026-11-19 修）
//
// 用户报的 BUG：几张卡片叠在一起时，点中的那张反而沉到最底下。
// 根因是两层叠加：
//   ① 卡片基准层级 = 10 + 卡片序号（序号按加入画布顺序排）
//   ② CSS 里一条 `.node.expanded { z-index: 120 !important }` 把展开的卡硬顶到 120
//      —— 而 !important 又把 canvas.js 里 zIndexOf() 算的加成盖掉了。
// 于是画布一过 110 张卡，序号 111 以后的卡层级就超过 120，点开的那张被压在下面。
//
// 这个文件守三件事：
//   A. zIndexOf 分层：普通 < 选中 < 展开 < 区域/定时组展开，且与卡片数量无关
//   B. CSS 里不许再出现会把 JS 层级顶掉的 !important / 写死小数字
//   C. 端到端：真起服务 + 无头 Chrome，130 张几乎重叠的卡片，点一张看它是否真的在最上面
//
// 运行：runtime/node.exe tools/tests/card-zorder.test.js
//      （没有 Chrome 时跳过 C 段，A/B 仍然执行）

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CANVAS_SRC = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
const CSS_RAW = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'style.css'), 'utf8');
// 注释里会提到「以前的写法」，不能拿来当现行规则判 —— 先剥注释再断言
const CSS_SRC = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

// ---------- 从 canvas.js 里原样抠出 zIndexOf 的真身 ----------
function pickFunction(source, name) {
  const at = source.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('源码里找不到函数 ' + name);
  let depth = 0;
  let started = false;
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error('函数 ' + name + ' 的花括号没配对');
}

function makeSandbox(opts) {
  const state = {
    expandedId: (opts && opts.expandedId) || null,
    selection: new Set((opts && opts.selection) || []),
  };
  const sandbox = {
    __state: state,
    isSchedule: (node) => node.type === 'schedule',
    isZone: (node) => node.type === 'zone',
    scheduleMembersOf: (node) => node.__members || [],
    zoneMembersOf: (node) => node.__members || [],
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      'var expandedId = null;',
      'var selection = __state.selection;',
      // 用 getter 让 expandedId 跟着测试状态走
      'Object.defineProperty(globalThis, "__expanded", { get: function () { return __state.expandedId; } });',
      pickFunction(CANVAS_SRC, 'zIndexOf'),
      'globalThis.__zIndexOf = zIndexOf;',
    ].join('\n'),
    sandbox
  );
  return sandbox;
}

// canvas.js 里的 zIndexOf 直接闭包引用 expandedId / selection。
// 这里不改源码，而是把函数体里那两个标识符换成可读的代理，等价地跑真逻辑。
function zIndexOfOf(opts) {
  const body = pickFunction(CANVAS_SRC, 'zIndexOf')
    .replace(/node\.id === expandedId/g, 'node.id === __expandedId')
    .replace(/selection\.has\(/g, '__selection.has(');
  const ctx = {
    __expandedId: opts.expandedId || null,
    __selection: new Set(opts.selection || []),
    isSchedule: (node) => node.type === 'schedule',
    isZone: (node) => node.type === 'zone',
    scheduleMembersOf: (node) => node.__members || [],
    zoneMembersOf: (node) => node.__members || [],
  };
  const consts = ['Z_SELECTED', 'Z_EXPANDED', 'Z_BOX_EXPANDED']
    .map((name) => {
      const hit = CANVAS_SRC.match(new RegExp('const ' + name + ' = ([^;]+);'));
      if (!hit) throw new Error('源码里找不到常量 ' + name);
      return 'const ' + name + ' = ' + hit[1].replace(/\/\/.*$/gm, '') + ';';
    })
    .join('\n');
  return new Function(
    'isSchedule',
    'isZone',
    'scheduleMembersOf',
    'zoneMembersOf',
    '__expandedId',
    '__selection',
    consts + '\n' + body + '\nreturn zIndexOf;'
  )(
    ctx.isSchedule,
    ctx.isZone,
    ctx.scheduleMembersOf,
    ctx.zoneMembersOf,
    ctx.__expandedId,
    ctx.__selection
  );
}

console.log('A. zIndexOf 的分层规则（纯函数）');

check('展开的那张 > 画布上任何一张普通卡（哪怕序号排到 5000）', () => {
  const zOf = zIndexOfOf({ expandedId: 'hit' });
  const hit = zOf({ id: 'hit', type: 'image', z: 3 });
  const top = zOf({ id: 'top', type: 'image', z: 5000 });
  assert(hit > top, '展开卡 z=' + hit + '，最大序号卡 z=' + top + '，顺序反了');
});

check('选中的那张 > 画布上任何一张没选中的卡（哪怕序号排到 5000）', () => {
  const zOf = zIndexOfOf({ selection: ['sel'] });
  const sel = zOf({ id: 'sel', type: 'image', z: 2 });
  const top = zOf({ id: 'top', type: 'video', z: 5000 });
  assert(sel > top, '选中卡 z=' + sel + '，最大序号卡 z=' + top + '，顺序反了');
});

check('展开 > 仅选中 > 普通，三档严格递增', () => {
  const plain = zIndexOfOf({});
  const selOf = zIndexOfOf({ selection: ['a'] });
  const expOf = zIndexOfOf({ expandedId: 'a' });
  const p = plain({ id: 'a', type: 'image', z: 1 });
  const s = selOf({ id: 'a', type: 'image', z: 1 });
  const e = expOf({ id: 'a', type: 'image', z: 1 });
  assert(p < s, '普通 ' + p + ' 不小于选中 ' + s);
  assert(s < e, '选中 ' + s + ' 不小于展开 ' + e);
});

check('普通卡片之间仍然按序号排队（没被压成同一层）', () => {
  const zOf = zIndexOfOf({});
  const a = zOf({ id: 'a', type: 'image', z: 1 });
  const b = zOf({ id: 'b', type: 'image', z: 2 });
  const c = zOf({ id: 'c', type: 'image', z: 3 });
  assert(a < b && b < c, '普通卡片顺序不对：' + a + ' / ' + b + ' / ' + c);
});

check('区域 / 定时组没展开时仍垫在成员下面', () => {
  const zOf = zIndexOfOf({ selection: ['zone'] });
  const zone = { id: 'zone', type: 'zone', z: 9, __members: [{ id: 'm1', z: 9 }, { id: 'm2', z: 10 }] };
  const member = zOf({ id: 'm1', type: 'image', z: 9 });
  assert(zOf(zone) < member, '区域 z=' + zOf(zone) + ' 压到了成员 z=' + member);
});

check('区域 / 定时组展开时浮到成员之上（面板与遮罩要盖住成员）', () => {
  const zOf = zIndexOfOf({ expandedId: 'zone' });
  const zone = { id: 'zone', type: 'zone', z: 9, __members: [{ id: 'm1', z: 9 }] };
  const member = zOf({ id: 'm1', type: 'image', z: 9 });
  assert(zOf(zone) > member, '展开的区域 z=' + zOf(zone) + ' 没压过成员 z=' + member);
});

check('层级都在 32 位整数范围内（浏览器 z-index 上限）', () => {
  const zOf = zIndexOfOf({ expandedId: 'x' });
  const worst = Math.max(
    zOf({ id: 'x', type: 'image', z: 99999 }),
    zOf({ id: 'x', type: 'zone', z: 99999, __members: [] }),
    zOf({ id: 'x', type: 'schedule', z: 99999, __members: [] })
  );
  assert(worst < 2147483647, '层级 ' + worst + ' 超出 z-index 上限');
});

console.log('\nB. CSS 不许再把 JS 算的层级顶掉');

check('没有 `.node.expanded { … !important }` 这种写死小数字的规则', () => {
  const bad = /\.node\.expanded\s*\{[^}]*z-index\s*:\s*\d+\s*!important/.test(CSS_SRC);
  assert(!bad, 'style.css 里还有 .node.expanded 的 !important 层级，会把 canvas.js 算的值盖掉');
});

check('没有 `.node[...]expanded { … !important }` 这类同款（定时组那条也在内）', () => {
  const bad = /\.node\[[^\]]*\]\.expanded\s*\{[^}]*z-index\s*:\s*\d+\s*!important/.test(CSS_SRC);
  assert(!bad, 'style.css 里还有带 !important 的卡片层级，会把 canvas.js 算的值盖掉');
});

check('卡片层级只在 canvas.js 一处算（buildNode 写内联样式）', () => {
  assert(/el\.style\.zIndex\s*=\s*String\(zIndexOf\(node\)\)/.test(CANVAS_SRC), 'buildNode 没把 zIndexOf 写到内联样式上');
  assert(/el\.style\.zIndex\s*=\s*String\(zIndexOf\(node\)\)/.test(CANVAS_SRC), 'applyZOrder 没把 zIndexOf 写到内联样式上');
});

// ---------- C. 端到端：真服务 + 无头 Chrome ----------
function findChrome() {
  const list = [
    process.env.CANVAS_BENCH_BROWSER || '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const one of list) {
    if (one && fs.existsSync(one)) return one;
  }
  return '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function localGet(url, method) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('超时')));
    req.end();
  });
}

async function runBrowserCheck() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('  · 本机没有 Chrome / Edge，跳过（A/B 已覆盖规则本身）');
    return;
  }
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'zorder-e2e-'));
  const dataDir = path.join(box, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const cdpPort = 9371;
  const cdp = 'http://127.0.0.1:' + cdpPort;
  let port = 0;
  let token = '';
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--no-browser'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      CANVAS_DATA_DIR: dataDir,
      http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '',
    }),
    stdio: 'ignore',
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zorder-chrome-'));
  const chrome = spawn(
    chromePath,
    ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile,
      '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { stdio: 'ignore' }
  );
  try {
    for (let i = 0; i < 120; i += 1) {
      try {
        port = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')).port;
      } catch {
        port = 0;
      }
      if (port) {
        try {
          if ((await localGet('http://127.0.0.1:' + port + '/api/health')).status === 200) break;
        } catch {
          /* 还在起 */
        }
      }
      await sleep(250);
    }
    if (!port) throw new Error('隔离服务没起来');
    token = (() => {
      try {
        return fs.readFileSync(path.join(dataDir, 'admin-token.txt'), 'utf8').trim();
      } catch {
        return '';
      }
    })();

    function api(method, urlPath, body) {
      return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: urlPath,
            method,
            headers: Object.assign(
              { 'x-local-token': token },
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

    const COUNT = 130; // 必须 > 110：老版本正是从 111 张开始出问题
    const nodes = [];
    for (let i = 0; i < COUNT; i += 1) {
      nodes.push({
        id: 'p' + i,
        type: 'image',
        // 每张只错开 10px：模拟「一叠卡片」
        x: 300 + (i % 10) * 10,
        y: 250 + Math.floor(i / 10) * 10,
        w: 400,
        h: 260,
        z: i,
        createdAt: 1000 + i,
        data: { v: 3, text: 'card ' + i, model: '', params: {}, no: i + 1 },
      });
    }
    const created = JSON.parse((await api('POST', '/api/canvases', { name: '层级回归' })).body);
    await api('PUT', '/api/canvases/' + created.canvas.id, { nodes, edges: [], viewport: { x: 0, y: 0, zoom: 0.9 } });

    for (let i = 0; i < 60; i += 1) {
      try {
        if ((await localGet(cdp + '/json/version')).status === 200) break;
      } catch {
        /* 还没起 */
      }
      await sleep(250);
    }
    const info = JSON.parse((await localGet(cdp + '/json/new?' + encodeURIComponent('about:blank'), 'PUT')).body);
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    };
    const send = (method, params) =>
      new Promise((resolve, reject) => {
        seq += 1;
        pending.set(seq, { resolve, reject });
        ws.send(JSON.stringify({ id: seq, method, params: params || {} }));
      });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/canvas?id=' + created.canvas.id });
    for (let i = 0; i < 100; i += 1) {
      if ((await evalJs('document.querySelectorAll("#world .node").length')) > 0) break;
      await sleep(300);
    }
    await sleep(1200);

    // 点最上层那张（序号最大）——老版本最典型的翻车场景：它本来是顶层，点开反而沉底
    const top = await evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const list = [...document.querySelectorAll('#world .node')];
      const target = list[list.length - 1];
      const r = target.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, isPrimary: true }));
      await sleep(40);
      target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 0, pointerId: 1, isPrimary: true }));
      await sleep(600);
      const el = document.querySelector('#world .node[data-id="' + target.dataset.id + '"]');
      const rr = el.getBoundingClientRect();
      const probe = (fx, fy) => {
        const hit = document.elementFromPoint(Math.round(rr.left + rr.width * fx), Math.round(rr.top + rr.height * fy));
        const owner = hit ? hit.closest('.node') : null;
        return owner ? owner.dataset.id : '';
      };
      const owners = [];
      for (const fy of [0.2, 0.4, 0.5, 0.6, 0.75]) for (const fx of [0.3, 0.5, 0.7]) owners.push(probe(fx, fy));
      const all = [...document.querySelectorAll('#world .node')].map((e) => Number(getComputedStyle(e).zIndex));
      return {
        id: el.dataset.id,
        z: Number(getComputedStyle(el).zIndex),
        maxOther: Math.max(...all.filter((v) => v !== Number(getComputedStyle(el).zIndex))),
        selected: el.classList.contains('selected'),
        expanded: el.classList.contains('expanded'),
        owners,
      };
    })()`);

    check('端到端：130 张叠在一起时，点中的那张的层级高于其余所有卡片', () => {
      assert(top.selected && top.expanded, '点完没有选中 / 没有展开');
      assert(top.z > top.maxOther, '选中卡 z=' + top.z + '，其余最高 z=' + top.maxOther);
    });
    check('端到端：点中的那张在画面上真的画在最上面（elementFromPoint 全落在它身上）', () => {
      const strays = top.owners.filter((one) => one !== top.id);
      assert(strays.length === 0, '有 ' + strays.length + ' / ' + top.owners.length + ' 个采样点被别的卡盖住：' + strays.join(','));
    });
    try {
      ws.close();
    } catch {
      /* 关不掉就算了 */
    }
  } finally {
    chrome.kill();
    server.kill();
  }
}

(async () => {
  console.log('\nC. 端到端（真服务 + 无头浏览器，130 张卡）');
  try {
    await runBrowserCheck();
  } catch (error) {
    fail += 1;
    console.log('  ✗ 端到端没跑完 —— ' + error.message);
  }
  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
