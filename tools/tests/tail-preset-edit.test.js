'use strict';

// 尾部提示词预设「改不动」——根因与回归护栏（2026-11-21）
//
// 用户报的 BUG：预设好的尾部提示词不支持修改。
// 真实根因**不是**保存链路，而是画布的全局快捷键抢走了输入框里的按键：
//
//   canvas.js 的 document keydown 里原来这么判「是否在打字」：
//       const typing = editingId !== null || (target.isContentEditable || target.tagName === 'INPUT');
//   它**不认 TEXTAREA**。而尾部提示词预设的正文框正是 <textarea class="tail-text">。
//   于是：
//     · 退格 / Delete → 走 deleteSelection()，把画布上选中的卡片整张删掉（正文一个字没少）
//     · Ctrl+A        → 走 selectAll()，全选画布卡片（而不是全选这段文字）
//   用户的手感就是「这个预设根本改不了 / 一改就出事」。
//
// 这个文件守四件事：
//   A. 代码层：isTypingTarget 认 textarea / select / 普通 input，不认复选框和按钮
//   B. 代码层：画布 keydown 用的是 isTypingTarget，且弹窗 / 浮层打开时快捷键不穿透
//   C. 端到端：真起服务 + 无头浏览器，在 tail-text 里按退格 / Ctrl+A / Delete
//   D. 端到端：改完正文点保存，服务端读回来确实是改后的（顺便守「未保存浮标」）
//
// 运行：runtime/node.exe tools/tests/tail-preset-edit.test.js
//      （没有 Chrome / Edge 时跳过 C/D，A/B 仍然执行）

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CANVAS_SRC = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'ui.js'), 'utf8');

let pass = 0;
let fail = 0;
function report(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }
}
function check(name, fn) {
  try { fn(); report(name, true); } catch (error) { report(name, false, error.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); report(name, true); } catch (error) { report(name, false, error.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

// 从源码里抠出一个函数（花括号配对）
function pickFunction(source, name) {
  const at = source.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('源码里找不到函数 ' + name);
  let depth = 0;
  let started = false;
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') { depth += 1; started = true; }
    else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error('函数 ' + name + ' 的花括号没配对');
}

console.log('A. isTypingTarget：哪些控件算「在打字」');

check('函数存在（原来根本没有这一层判断）', () => {
  assert(CANVAS_SRC.indexOf('function isTypingTarget(') >= 0, '找不到 isTypingTarget，说明「认不认 textarea」还是散在监听里');
});

check('textarea 算打字（尾部预设正文档就是它）', () => {
  const fn = pickFunction(CANVAS_SRC, 'isTypingTarget');
  // 直接在 Node 里跑真身：只需要 tagName / isContentEditable / type 三个字段
  const run = new Function('target', fn + '; return isTypingTarget(target);');
  assert(run({ tagName: 'TEXTAREA', isContentEditable: false }) === true, 'textarea 被判成「不在打字」—— 退格会去删卡片');
});

check('普通 input 算打字，复选框 / 单选框 / 按钮不算', () => {
  const fn = pickFunction(CANVAS_SRC, 'isTypingTarget');
  const run = new Function('target', fn + '; return isTypingTarget(target);');
  assert(run({ tagName: 'INPUT', type: 'text' }) === true, 'text input 不算打字');
  assert(run({ tagName: 'INPUT', type: 'search' }) === true, 'search input 不算打字');
  assert(run({ tagName: 'INPUT', type: 'checkbox' }) === false, '复选框不该算打字（点完勾选再按 Delete 是常见操作）');
  assert(run({ tagName: 'INPUT', type: 'radio' }) === false, '单选框不该算打字');
  assert(run({ tagName: 'INPUT', type: 'button' }) === false, '按钮不该算打字');
});

check('下拉框、可编辑区、普通元素', () => {
  const fn = pickFunction(CANVAS_SRC, 'isTypingTarget');
  const run = new Function('target', fn + '; return isTypingTarget(target);');
  assert(run({ tagName: 'SELECT' }) === true, 'select 不算打字');
  assert(run({ tagName: 'DIV', isContentEditable: true }) === true, 'contenteditable 不算打字（提示词框就是它）');
  assert(run({ tagName: 'DIV' }) === false, '普通 div 被判成在打字，画布快捷键会失灵');
  assert(run(null) === false, 'null 不该抛错');
});

console.log('\nB. 画布 keydown：真的用上了这层判断，而且弹窗不吃穿透');

check('typing 用的是 isTypingTarget（不是只认 INPUT 的老写法）', () => {
  assert(/const typing = editingId !== null \|\| isTypingTarget\(event\.target\)/.test(CANVAS_SRC),
    '画布 keydown 里还在用只认 INPUT 的老判断');
  assert(!/const typing = editingId !== null \|\| \(event\.target && \(event\.target\.isContentEditable \|\| event\.target\.tagName === 'INPUT'\)\)/.test(CANVAS_SRC),
    '老写法还在，textarea 会被漏掉');
});

check('弹窗 / 浮层打开时画布快捷键不穿透', () => {
  assert(CANVAS_SRC.indexOf('function canvasShortcutsBlocked(') >= 0, '缺少 canvasShortcutsBlocked');
  assert(/const blocked = canvasShortcutsBlocked\(event\.target\)/.test(CANVAS_SRC), 'keydown 没算 blocked');
  assert(/if \(blocked\) return;/.test(CANVAS_SRC), '算出了 blocked 却没用它拦住');
  const fn = pickFunction(CANVAS_SRC, 'canvasShortcutsBlocked');
  assert(/modal-mask/.test(fn), '没把弹窗算进去');
  assert(/tail-pop/.test(fn), '没把侧栏浮层算进去');
});

check('尾部预设的正文确实是 textarea（这就是当初被漏掉的原因）', () => {
  const at = UI_SRC.indexOf("const text = document.createElement('textarea');");
  assert(at >= 0, '正文框不是 textarea 了？那这条 BUG 的成因要重新看');
  assert(UI_SRC.slice(at, at + 400).indexOf("text.className = 'tail-text'") >= 0, '正文框 class 不是 tail-text');
});

check('未保存时要拦一下：点关闭 / 点遮罩 / 按 Esc 都先问一句', () => {
  assert(/function closeTailPanel\(force\)/.test(UI_SRC), 'closeTailPanel 没有 force 参数，没法区分「确认过再关」');
  assert(/if \(!force && tailPanelIsDirty && tailPanelIsDirty\(\)\)/.test(UI_SRC), '关面板前没检查未保存的修改');
  // 关键细节：click 事件是 truthy，直接把它当 force 会**绕过确认**
  assert(!/addEventListener\('click', closeTailPanel\)/.test(UI_SRC), '把事件对象当 force 传进去了，确认会被跳过');
  assert(/document\.addEventListener\('keydown', tailPanelEsc, true\)/.test(UI_SRC), '面板没自己处理 Esc（画布的 Esc 已经被弹窗拦掉了）');
});

check('未保存浮标：草稿一改就亮，保存后熄灭', () => {
  assert(UI_SRC.indexOf('id="tail-dirty"') >= 0, '面板里没有「有未保存的修改」浮标');
  assert(/const markDirty = \(\) => \{/.test(UI_SRC), '缺少 markDirty');
  assert(/savedSignature = draftSignature\(\);/.test(UI_SRC), '保存成功后没把签名对齐，浮标不会消失');
  assert(/preset\.text = text\.value; paintCount\(\); markDirty\(\);/.test(UI_SRC), '改正文没点亮浮标');
  assert(/preset\.name = name\.value; markDirty\(\);/.test(UI_SRC), '改名字没点亮浮标');
});

// ---------- C / D. 端到端：真键盘 ----------
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
    req.setTimeout(15000, () => req.destroy(new Error('超时')));
    req.end();
  });
}

async function runBrowser() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('  · 本机没有 Chrome / Edge，跳过（A/B 已覆盖规则本身）');
    return;
  }
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-edit-e2e-'));
  const dataDir = path.join(box, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // 拿用户真实的预设做底：335 字那套、图片组 3 套，才测得出「改完真的变了」
  const realData = path.join(ROOT, 'data');
  ['config.json', 'secret.key'].forEach((f) => {
    const src = path.join(realData, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dataDir, f));
  });
  const cdpPort = 9535;
  const cdp = 'http://127.0.0.1:' + cdpPort;
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--no-browser'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      CANVAS_DATA_DIR: dataDir,
      http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '',
    }),
    stdio: 'ignore',
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-edit-chrome-'));
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let port = 0;
    for (let i = 0; i < 140; i += 1) {
      try { port = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')).port; } catch { port = 0; }
      if (port) {
        try { if ((await localGet('http://127.0.0.1:' + port + '/api/health')).status === 200) break; } catch { /* 还在起 */ }
      }
      await sleep(250);
    }
    if (!port) throw new Error('隔离服务没起来');
    let token = '';
    for (let i = 0; i < 40 && !token; i += 1) {
      try { token = fs.readFileSync(path.join(dataDir, 'admin-token.txt'), 'utf8').trim(); } catch { await sleep(150); }
    }
    const api = (method, urlPath, body) => new Promise((resolve, reject) => {
      const data = body == null ? null : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port, path: urlPath, method,
        headers: Object.assign({ 'x-local-token': token }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', reject);
      req.end(data || undefined);
    });
    const created = JSON.parse((await api('POST', '/api/canvases', { name: '预设可改' })).body);
    const nodes = [
      { id: 'e1', type: 'image', x: 200, y: 200, w: 320, h: 200, z: 0, createdAt: 1, data: { v: 3, text: '卡片一', model: '', params: {} } },
      { id: 'e2', type: 'image', x: 620, y: 200, w: 320, h: 200, z: 1, createdAt: 2, data: { v: 3, text: '卡片二', model: '', params: {} } },
    ];
    await api('PUT', '/api/canvases/' + created.canvas.id, { nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } });

    for (let i = 0; i < 60; i += 1) {
      try { if ((await localGet(cdp + '/json/version')).status === 200) break; } catch { /* 还没起 */ }
      await sleep(250);
    }
    const info = JSON.parse((await localGet(cdp + '/json/new?' + encodeURIComponent('about:blank'), 'PUT')).body);
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
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
    const send = (method, params) => new Promise((resolve, reject) => {
      seq += 1;
      pending.set(seq, { resolve, reject });
      ws.send(JSON.stringify({ id: seq, method, params: params || {} }));
    });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };
    const ptOf = (sel) => evalJs('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
    const clickAt = async (p) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(60);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 0 });
      await sleep(150);
    };
    const keyPress = async (key, code, vk, mods) => {
      const m = mods || 0;
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: m });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: m });
      await sleep(150);
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/canvas?id=' + created.canvas.id });
    for (let i = 0; i < 120; i += 1) {
      if (await evalJs('document.readyState === "complete" && !!window.UITheme')) break;
      await sleep(250);
    }
    await sleep(1500);

    // 走界面打开：左侧工具栏 → 尾部提示词 → 视频组「预设」
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 450, buttons: 0 });
    await sleep(900);
    await clickAt(await ptOf('#btn-tail-prompts'));
    await sleep(500);
    await clickAt(await ptOf('.tail-pop-row[data-group="video"] .tail-pop-manage'));
    await sleep(900);
    await checkAsync('C1. 预设面板能打开', async () => {
      assert(await evalJs('!!document.querySelector(".modal-tail")') === true, '面板没打开');
    });

    const cardsBefore = await evalJs('document.querySelectorAll("#world .node").length');
    await clickAt(await ptOf('.tail-text'));
    await sleep(200);
    const lenBefore = await evalJs('(() => { const t = document.querySelector(".modal-tail .tail-text"); t.setSelectionRange(t.value.length, t.value.length); return t.value.length; })()');

    await keyPress('Backspace', 'Backspace', 8);
    await checkAsync('C2. 正文框里按退格：只删正文一个字，不删卡片', async () => {
      const state = await evalJs('(() => ({ len: document.querySelector(".modal-tail .tail-text").value.length, cards: document.querySelectorAll("#world .node").length }))()');
      assert(state.len === lenBefore - 1, '正文长度 ' + lenBefore + ' → ' + state.len + '，退格没进到正文框');
      assert(state.cards === cardsBefore, '卡片被误删了：' + cardsBefore + ' → ' + state.cards);
    });

    await checkAsync('C3. 正文框里按 Ctrl+A：全选的是正文，不是画布卡片', async () => {
      await keyPress('a', 'KeyA', 65, 2);
      const state = await evalJs('(() => { const t = document.querySelector(".modal-tail .tail-text"); return { selLen: t.value.slice(t.selectionStart, t.selectionEnd).length, total: t.value.length, selCards: document.querySelectorAll("#world .node.selected").length }; })()');
      assert(state.selLen === state.total && state.total > 0, '没选中正文全部：' + JSON.stringify(state));
      assert(state.selCards === 0, '把画布卡片全选了：' + JSON.stringify(state));
    });

    await checkAsync('C4. 正文框里按 Delete：清空正文，卡片还在', async () => {
      await keyPress('Delete', 'Delete', 46);
      const state = await evalJs('(() => ({ len: document.querySelector(".modal-tail .tail-text").value.length, cards: document.querySelectorAll("#world .node").length, modal: !!document.querySelector(".modal-tail") }))()');
      assert(state.len === 0, '正文没清空：' + JSON.stringify(state));
      assert(state.cards === cardsBefore, '卡片被误删了：' + JSON.stringify(state));
      assert(state.modal === true, '面板被误关了');
    });

    await checkAsync('C5. 改正文时「有未保存的修改」浮标亮起', async () => {
      await send('Input.insertText', { text: '改后的正文 AAA' });
      await sleep(250);
      const hidden = await evalJs('document.getElementById("tail-dirty") ? document.getElementById("tail-dirty").hidden : null');
      assert(hidden === false, '浮标没亮（hidden=' + hidden + '），用户会以为已经存上了');
    });

    await checkAsync('C6. 词条名字也能真实输入', async () => {
      await clickAt(await ptOf('.tail-name'));
      await sleep(150);
      await evalJs('(() => { const el = document.querySelector(".tail-name"); el.select(); return true; })()');
      await send('Input.insertText', { text: '新名字 XZ' });
      await sleep(200);
      const value = await evalJs('document.querySelector(".tail-name").value');
      assert(value === '新名字 XZ', '名字没换成期望值：' + JSON.stringify(value));
    });

    await checkAsync('C7. 点保存后服务端就是改后的名字与正文', async () => {
      await clickAt(await ptOf('#tail-save'));
      await sleep(1800);
      const status = JSON.parse((await api('GET', '/api/status')).body);
      const preset = status.tailPrompts.groups.video.presets[0];
      assert(preset.name === '新名字 XZ', '名字没存上：' + JSON.stringify(preset.name));
      assert(preset.text === '改后的正文 AAA', '正文没存上：' + JSON.stringify(preset.text));
    });

    await checkAsync('C8. 保存后浮标熄灭', async () => {
      const hidden = await evalJs('document.getElementById("tail-dirty") ? document.getElementById("tail-dirty").hidden : null');
      assert(hidden === true, '保存后浮标还亮着（hidden=' + hidden + '）');
    });

    await checkAsync('C9. 关掉再打开，显示的是改后的（不是又变回去了）', async () => {
      await clickAt(await ptOf('.modal-tail .modal-foot [data-close]'));
      await sleep(500);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 450, buttons: 0 });
      await sleep(900);
      await clickAt(await ptOf('#btn-tail-prompts'));
      await sleep(500);
      await clickAt(await ptOf('.tail-pop-row[data-group="video"] .tail-pop-manage'));
      await sleep(900);
      const shown = await evalJs('(() => { const t = document.querySelector(".modal-tail .tail-text"); const n = document.querySelector(".modal-tail .tail-name"); return { text: t ? t.value : null, name: n ? n.value : null }; })()');
      assert(shown.text === '改后的正文 AAA', '重新打开正文又变回去了：' + JSON.stringify(shown));
      assert(shown.name === '新名字 XZ', '重新打开名字又变回去了：' + JSON.stringify(shown));
    });

    // E 段：关闭 / 取消 / Esc 的行为。页面里把 confirm 换成可编排的假函数，
    // 用真正的事件链（click / keydown）走，不是直接调内部函数。
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__confirmCount = 0; window.__confirmAnswer = true; window.confirm = function (m) { window.__confirmCount += 1; window.__lastConfirm = m || ""; return window.__confirmAnswer !== false; };' });
    await send('Page.reload', { ignoreCache: true });
    for (let i = 0; i < 120; i += 1) {
      if (await evalJs('document.readyState === "complete" && !!window.UITheme')) break;
      await sleep(250);
    }
    await sleep(1200);
    const openPanel = async () => {
      await evalJs('window.UITheme.openTailPromptsPanel("video")');
      await sleep(700);
    };
    const nudge = async () => {
      await evalJs('(() => { const t = document.querySelector(".tail-text"); t.value = t.value + "X"; t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
      await sleep(250);
    };

    await checkAsync('E1. 没改动时按 Esc 直接关面板，不打扰', async () => {
      await openPanel();
      await evalJs('window.__confirmCount = 0');
      await keyPress('Escape', 'Escape', 27);
      await sleep(400);
      const state = await evalJs('(() => ({ modal: !!document.querySelector(".modal-tail"), confirms: window.__confirmCount }))()');
      assert(state.modal === false, 'Esc 没关掉面板');
      assert(state.confirms === 0, '什么都没改却弹了确认');
    });

    await checkAsync('E2. 有改动时点「关闭」先确认；选取消则面板留着', async () => {
      await openPanel();
      await nudge();
      await evalJs('window.__confirmAnswer = false; window.__confirmCount = 0');
      await evalJs('document.querySelector(".modal-tail .modal-foot [data-close]").click()');
      await sleep(400);
      const state = await evalJs('(() => ({ modal: !!document.querySelector(".modal-tail"), confirms: window.__confirmCount, msg: window.__lastConfirm || "" }))()');
      assert(state.confirms === 1, '没弹确认（改完一关就丢，正是用户报的「改不了」）');
      assert(state.modal === true, '选了取消面板却关掉了');
      assert(state.msg.indexOf('保存') >= 0, '确认文案没提「要点保存才生效」：' + state.msg);
    });

    await checkAsync('E3. 确认放弃后关掉，服务端数据没被改写', async () => {
      const before = JSON.parse((await api('GET', '/api/status')).body).tailPrompts.groups.video.presets[0].text;
      await evalJs('window.__confirmAnswer = true; document.querySelector(".modal-tail .modal-foot [data-close]").click()');
      await sleep(500);
      const after = JSON.parse((await api('GET', '/api/status')).body).tailPrompts.groups.video.presets[0].text;
      assert(await evalJs('!!document.querySelector(".modal-tail")') === false, '面板没关掉');
      assert(after === before, '放弃修改后服务端却被改写了');
    });

    await checkAsync('E4. 保存之后再关闭，不再弹确认', async () => {
      await openPanel();
      await evalJs('window.__confirmCount = 0');
      await evalJs('(() => { const t = document.querySelector(".tail-text"); t.value = "存过的 ZZ"; t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
      await sleep(200);
      await evalJs('document.getElementById("tail-save").click()');
      await sleep(1800);
      await evalJs('document.querySelector(".modal-tail .modal-foot [data-close]").click()');
      await sleep(500);
      const state = await evalJs('(() => ({ modal: !!document.querySelector(".modal-tail"), confirms: window.__confirmCount }))()');
      assert(state.modal === false, '保存后关闭不了');
      assert(state.confirms === 0, '已经保存过了，关闭时还在问');
    });

    ws.close();
  } finally {
    chrome.kill();
    server.kill();
  }
}

console.log('\nC/D. 端到端：真键盘改预设');
runBrowser()
  .catch((error) => report('端到端跑完', false, error.message))
  .then(() => {
    console.log('\n' + (fail ? '有 ' + fail + ' 项失败' : '全部通过') + '（' + pass + ' 项）');
    process.exit(fail ? 1 : 0);
  });
