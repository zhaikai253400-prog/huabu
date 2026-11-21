'use strict';

// 提示词「展开大面板」不持久化（2026-11-21 用户要求）
//
// 用户报的问题：点开提示词的大面板后，点别处收起了，但下次再点回同一张卡，
// 它又自动是「已展开」的大面板 —— 因为展开状态被写进了 localStorage。
//
// 用户要的行为：展开是**一次性**的临时状态。点空白 / 点别的卡 / 点工具栏 / Esc
// 收起后，下次再点回这张卡，应该是常规大小的面板。
//
// 这个文件守四件事：
//   A. 展开状态不再写 localStorage（老记录还要清掉，否则升级后照样是大的）
//   B. 收起面板的每条路径都会把展开状态一起作废
//   C. 端到端：真服务 + 无头浏览器，展开 → 点空白 → 点回来 → 必须是常规大小
//   D. 端到端：展开后在面板**内部**操作不会误收起（用户正在写提示词）
//
// 运行：runtime/node.exe tools/tests/prompt-wide-not-persisted.test.js
//      （没有 Chrome 时跳过 C/D 段，A/B 仍然执行）

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CANVAS_SRC = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');

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

// 抠出一个函数体，方便对着真源码断言
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

console.log('\nA. 展开状态不再落盘');

check('promptWide 不再是 localStorage 里的对象', () => {
  assert(!/let\s+promptWide\s*=\s*readPromptWide\(\)/.test(CANVAS_SRC), '还在用「从 localStorage 读出一整份映射」的老结构');
  assert(!/function\s+savePromptWide\s*\(/.test(CANVAS_SRC), '还留着 savePromptWide（说明还会写盘）');
  assert(!/function\s+readPromptWide\s*\(/.test(CANVAS_SRC), '还留着 readPromptWide');
});

check('改成「只记当前这一张」的单个 id', () => {
  assert(/let\s+promptWideId\s*=\s*null/.test(CANVAS_SRC), '没有 promptWideId 这个一次性状态');
});

check('老的 localStorage 记录会被清掉（升级后不会一进来就是大面板）', () => {
  assert(/PROMPT_WIDE_LEGACY_KEY/.test(CANVAS_SRC), '没有老键名常量，升级用户的旧记录清不掉');
  assert(/removeItem\(PROMPT_WIDE_LEGACY_KEY\)/.test(CANVAS_SRC), '没有 removeItem 清理老记录');
});

check('源码里再没有任何地方把展开状态写进 localStorage', () => {
  const bad = /localStorage\.setItem\([^)]*promptWide/i.test(CANVAS_SRC);
  assert(!bad, '还有地方把 promptWide 写进 localStorage');
});

console.log('\nB. 收起面板的每条路径都会作废展开状态');

check('setPromptWide 只认当前这一张（不是任意 id 都能置 true）', () => {
  const body = pickFunction(CANVAS_SRC, 'setPromptWide');
  assert(/promptWideId\s*=\s*on\s*\?/.test(body), 'setPromptWide 没有把状态收敛成「当前这一张」');
});

check('promptWideOn 必须和当前展开的卡对上号', () => {
  const body = pickFunction(CANVAS_SRC, 'promptWideOn');
  assert(/promptWideId/.test(body) && /node\.id\s*===\s*promptWideId/.test(body), 'promptWideOn 没和 promptWideId 比对');
});

check('setExpanded 收起 / 换卡时会作废', () => {
  const body = pickFunction(CANVAS_SRC, 'setExpanded');
  assert(/resetPromptWide\(\)/.test(body), 'setExpanded 里没有 resetPromptWide()');
});

check('clearSelection（点空白、Esc）会作废', () => {
  const body = pickFunction(CANVAS_SRC, 'clearSelection');
  assert(/resetPromptWide\(\)/.test(body), 'clearSelection 没有清展开状态');
});

check('refreshSelection（卡片不再选中 → 收起）会作废', () => {
  const body = pickFunction(CANVAS_SRC, 'refreshSelection');
  const at = body.indexOf('expandedId && !selection.has(expandedId)');
  assert(at >= 0, '找不到「不再选中就收起」那段');
  assert(body.indexOf('resetPromptWide()', at) >= 0, '收起时没顺手作废展开状态');
});

check('resetPromptWide 就是把它置 null', () => {
  const body = pickFunction(CANVAS_SRC, 'resetPromptWide');
  assert(/promptWideId\s*=\s*null/.test(body), 'resetPromptWide 没清空');
});

// ---------- C / D. 端到端 ----------
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
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('超时')));
    req.end();
  });
}

async function runBrowser() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('  · 本机没有 Chrome / Edge，跳过 C/D（A/B 已覆盖规则本身）');
    return;
  }
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'promptwide-e2e-'));
  const dataDir = path.join(box, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const cdpPort = 9391;
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'promptwide-chrome-'));
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--remote-debugging-port=' + cdpPort,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  let ws = null;
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

    const api = (method, urlPath, body) =>
      new Promise((resolve, reject) => {
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

    const created = JSON.parse((await api('POST', '/api/canvases', { name: '展开不持久化' })).body);
    await api('PUT', '/api/canvases/' + created.canvas.id, {
      nodes: [
        {
          id: 'a1',
          type: 'image',
          x: 320,
          y: 260,
          w: 420,
          h: 280,
          z: 0,
          createdAt: 1000,
          data: { v: 3, text: '第一张卡的提示词', model: '', params: {}, no: 1 },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 0.9 },
    });

    for (let i = 0; i < 60; i += 1) {
      try {
        if ((await localGet(cdp + '/json/version')).status === 200) break;
      } catch {
        /* 还没起 */
      }
      await sleep(250);
    }
    const info = JSON.parse((await localGet(cdp + '/json/new?' + encodeURIComponent('about:blank'), 'PUT')).body);
    ws = new WebSocket(info.webSocketDebuggerUrl);
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
    // 真实鼠标事件：dispatchEvent 造的合成 PointerEvent 会绕过命中测试（elementFromPoint），
    // 掩盖「点到的其实是卡片内部空隙」这类问题。用户报的就是这种场景，必须用真事件。
    const clickAt = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(60);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
      await sleep(450);
    };
    const rectOf = (sel) =>
      evalJs(
        '(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) return null;' +
          ' const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2),' +
          ' y: Math.round(r.top + Math.min(24, r.height / 2)), left: Math.round(r.left),' +
          ' right: Math.round(r.right), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()'
      );
    const findBlankPoint = () =>
      evalJs(
        '(() => { for (const y of [120, 200, 320, 460, 620]) { for (const x of [120, 240, 380]) {' +
          ' const el = document.elementFromPoint(x, y); if (el && (el.id === "viewport" || el.id === "world")) return { x, y }; } }' +
          ' return { x: 20, y: 20 }; })()'
      );
    const measurePanel = () =>
      evalJs(`(() => {
        const node = document.querySelector('#world .node[data-id="a1"]');
        if (!node) return null;
        const panel = node.querySelector('.node-panel');
        const boxEl = node.querySelector('.node-prompt');
        return {
          expanded: node.classList.contains('expanded'),
          wide: node.classList.contains('wide'),
          panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
          panelH: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
          boxH: boxEl ? Math.round(boxEl.getBoundingClientRect().height) : 0,
          boxInlineH: boxEl ? boxEl.style.height : '',
        };
      })()`);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/canvas?id=' + created.canvas.id });
    for (let i = 0; i < 100; i += 1) {
      if ((await evalJs('document.querySelectorAll("#world .node").length')) > 0) break;
      await sleep(300);
    }
    await sleep(1200);

    // 先把卡片点亮（点一下卡片本体）
    // 点一下卡片本体（会选中并展开编辑面板）。
    // 写成自执行函数：后面几段都在同一个 eval 表达式里，裸声明会撞名。
    const openCard = `(() => {
      const s = (ms) => new Promise((r) => setTimeout(r, ms));
      const target = document.querySelector('#world .node[data-id="a1"]');
      const rect = target.getBoundingClientRect();
      const px = Math.round(rect.left + rect.width / 2);
      const py = Math.round(rect.top + 30);
      const fire = (el, type, buttons) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: px, clientY: py, button: 0, buttons: buttons, pointerId: 1, isPrimary: true }));
      fire(target, 'pointerdown', 1);
      fire(target, 'pointerup', 0);
      return s(600);
    })();`;

    const cardRect = await rectOf('#world .node[data-id="a1"]');
    await clickAt(cardRect.x, cardRect.top + 24);
    const state = await measurePanel();

    await checkAsync('C1 · 点卡片能展开编辑面板', async () => {
      assert(state.expanded, '点卡片后没有展开');
      assert(state.panelW > 400, '没有出现编辑面板');
      assert(!state.wide, '一打开就是大面板（说明展开状态被持久化了）');
    });

    // 点「展开」按钮 → 应该变大（真实鼠标）
    const btnRect = await rectOf('#world .node[data-id="a1"] .prompt-expand');
    await clickAt(btnRect.x, btnRect.y);
    const afterExpand = await measurePanel();
    const pressedNow = await evalJs('document.querySelector(\'#world .node[data-id="a1"] .prompt-expand\').getAttribute("aria-pressed")');
    afterExpand.pressed = pressedNow;

    await checkAsync('C2 · 点「展开」后确实变成大面板', async () => {
      assert(afterExpand.wide, '点了展开但 wide 没加上');
      assert(String(afterExpand.pressed) === 'true', '展开按钮的 aria-pressed 没变 true');
      assert(afterExpand.panelW > 700, '面板没变宽：' + afterExpand.panelW);
    });

    // 点画布空白 → 收起；再点回卡片 → 必须是常规大小（全程真实鼠标）
    const blank = await findBlankPoint();
    await clickAt(blank.x, blank.y);
    const collapsedState = await measurePanel();
    const cardRect2 = await rectOf('#world .node[data-id="a1"]');
    await clickAt(cardRect2.x, cardRect2.top + 24);
    const backAgain = await measurePanel();
    backAgain.collapsedState = collapsedState;

    await checkAsync('C3 · 点空白后面板收起', async () => {
      assert(!backAgain.collapsedState.expanded, '点空白后面板还开着');
    });

    await checkAsync('C4 · 再点回同一张卡是常规大小（核心要求）', async () => {
      assert(backAgain.expanded, '点回来没有展开');
      assert(!backAgain.wide, '点回来还是大面板 —— 展开状态被记住了');
      assert(backAgain.panelW < 640, '面板仍是宽面板：' + backAgain.panelW);
    });

    // 用户第二轮反馈「没有收回，而是收缩了宽度」：
    // 面板 DOM 是复用的，宽度每次贴面板时重算，但提示词框的内联高度是上一次写死的。
    // 只把 .wide 去掉，框还停在 532px —— 看着就是「只变窄、没收起」。
    await checkAsync('C6 · 点回来后提示词框高度也回到初始（不能只收宽度）', async () => {
      assert(typeof state.boxH === 'number' && state.boxH > 0, '没量到初始框高');
      assert(typeof backAgain.boxH === 'number', '没量到点回来后的框高');
      assert(
        Math.abs(backAgain.boxH - state.boxH) <= 12,
        '框高没回到初始：初始 ' + state.boxH + 'px，现在 ' + backAgain.boxH + 'px（内联 ' + backAgain.boxInlineH + '）'
      );
    });

    // D：面板内部操作不应误收起
    const inside = await evalJs(
      `(async () => {${openCard}
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const node = document.querySelector('#world .node[data-id="a1"]');
        const r = node.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + 30);
        const fire = (target, type, buttons) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: buttons, pointerId: 5, isPrimary: true }));
        fire(node, 'pointerdown', 1);
        fire(node, 'pointerup', 0);
        await sleep(600);
        const n2 = document.querySelector('#world .node[data-id="a1"]');
        const btn = n2.querySelector('.prompt-expand');
        btn.click();
        await sleep(400);
        // 面板内部：提示词框里按下
        const box = n2.querySelector('.node-prompt');
        const br = box.getBoundingClientRect();
        box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: Math.round(br.left + 20), clientY: Math.round(br.top + 20), button: 0, buttons: 1, pointerId: 6, isPrimary: true }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, buttons: 0, pointerId: 6, isPrimary: true }));
        await sleep(500);
        const after = document.querySelector('#world .node[data-id="a1"]');
        return { expanded: after.classList.contains('expanded'), wide: after.classList.contains('wide') };
      })()`
    );

    await checkAsync('D1 · 在展开的面板里操作不会误收起', async () => {
      assert(inside.expanded, '在面板内点一下就被收起了');
      assert(inside.wide, '在面板内点一下大面板就没了');
    });

    // E：展开状态下拖框底改高度，只影响这次显示，不能写进这张卡的自定义高度
    //    （写了以后收起大面板，框会停在 500+px 下不来 —— 还是「只变窄没收起」）
    const dragState = await evalJs(
      `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const node = document.querySelector('#world .node[data-id="a1"]');
        const btn = node.querySelector('.prompt-expand');
        if (btn.getAttribute('aria-pressed') !== 'true') btn.click();
        await sleep(500);
        const box = node.querySelector('.node-prompt');
        const before = Math.round(box.getBoundingClientRect().height);
        const g = node.querySelector('.prompt-grip');
        const r = g.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const fire = (el, type, cx, cy, buttons) =>
          el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: buttons, pointerId: 21, isPrimary: true }));
        fire(g, 'pointerdown', x, y, 1);
        fire(g, 'pointermove', x, y - 50, 1);
        fire(g, 'pointerup', x, y - 50, 0);
        await sleep(400);
        const key = 'canvas.promptHeights.' + new URLSearchParams(location.search).get('id');
        let saved = null;
        try { saved = localStorage.getItem(key); } catch { saved = 'err'; }
        return { before, after: Math.round(box.getBoundingClientRect().height), saved };
      })()`
    );

    await checkAsync('E1 · 大面板里拖框底不会把高度写进这张卡（否则收起后下不来）', async () => {
      const saved = dragState.saved;
      const polluted = Boolean(saved) && Object.prototype.hasOwnProperty.call(JSON.parse(saved), 'a1');
      assert(!polluted, '大面板拖出来的高度被记成本卡长期高度了：' + saved);
    });

    // 刷新页面后也不该是展开的（不持久化的另一半）
    const afterReload = await evalJs(
      `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        return 'ok';
      })()`
    );
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/canvas?id=' + created.canvas.id });
    for (let i = 0; i < 100; i += 1) {
      if ((await evalJs('document.querySelectorAll("#world .node").length')) > 0) break;
      await sleep(300);
    }
    await sleep(1200);
    const cardRect3 = await rectOf('#world .node[data-id="a1"]');
    await clickAt(cardRect3.x, cardRect3.top + 24);
    const reloadState = await measurePanel();

    await checkAsync('C5 · 刷新页面后再打开卡片，仍是常规大小', async () => {
      assert(!afterReload ? false : true, '');
      assert(reloadState.expanded, '刷新后点卡片没展开');
      assert(!reloadState.wide, '刷新后又是大面板 —— 状态落盘了');
    });
  } finally {
    try {
      if (ws) ws.close();
    } catch {
      /* 关不掉就算了 */
    }
    chrome.kill();
    server.kill();
  }
}

(async () => {
  console.log('\nC / D. 端到端（真服务 + 无头浏览器）');
  try {
    await runBrowser();
  } catch (error) {
    fail += 1;
    console.log('  ✗ 端到端没跑完 —— ' + error.message);
  }
  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();