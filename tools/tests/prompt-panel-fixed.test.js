'use strict';

// 提示词框固定高度 + 编辑面板永远向下（不再自适应翻转）。
//
// 三条都是用户明确要求的「不要自适应」：
//   · 提示词框点进去不高、点出去不矮，永远从 220px 起步；
//   · 编辑面板永远贴在卡片正下方，**绝不翻到卡片上方** ——
//     翻上去以后同一个按钮时上时下，用起来要重新找；
//   · **点开卡片时画布一点都不许动**。以前面板放不下会把 viewport.y 顶走
//     几百像素（实测贴底卡片点一下跳 402px），视角被打乱、怎么点都回不到原位。
//     卡片贴着屏幕底边时，超出屏幕的面板部分就不管，用户自己平移画布看。
//
// 前端是 IIFE，函数拿不出来，所以这里用「源码片段抽取 + vm 沙箱」直接跑真函数：
// 改坏了（比如有人把焦点判断又加回 promptHeightFor）测试会立刻红。
//
// 运行：runtime/node.exe tools/tests/prompt-panel-fixed.test.js

const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'style.css'), 'utf8');

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
function eq(got, want, msg) {
  if (got !== want) {
    throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
  }
}

function pickFunction(name) {
  const at = canvasSrc.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('源码里找不到函数 ' + name);
  let depth = 0;
  let started = false;
  for (let i = at; i < canvasSrc.length; i += 1) {
    const ch = canvasSrc[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return canvasSrc.slice(at, i + 1);
    }
  }
  throw new Error('函数 ' + name + ' 的花括号没配对');
}
function pickConst(name) {
  const hit = canvasSrc.match(new RegExp('const ' + name + ' = ([^;]+);'));
  if (!hit) throw new Error('源码里找不到常量 ' + name);
  return 'const ' + name + ' = ' + hit[1] + ';';
}

// ---------- 沙箱：只放纯计算要用的依赖 ----------
function makePromptSandbox(innerHeight) {
  const sandbox = {
    window: { innerHeight: innerHeight || 900 },
    promptHeights: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      'function clamp(v, min, max) { return Math.min(max, Math.max(min, Number(v) || 0)); }',
      pickConst('PROMPT_FIXED_H'),
      pickConst('PROMPT_TALL_H'),
      pickConst('PROMPT_MIN_H'),
      pickFunction('promptHeightLimit'),
      pickFunction('promptCustomHeight'),
      pickFunction('promptHeightFor'),
      'globalThis.__promptHeightFor = promptHeightFor;',
      'globalThis.__promptHeightLimit = promptHeightLimit;',
      'globalThis.__promptHeights = promptHeights;',
    ].join('\n'),
    sandbox
  );
  return sandbox;
}

console.log('\n一、提示词框高度固定');

check('没手动调过：900 高窗口里恒为 220，点不点进去都一样', () => {
  const S = makePromptSandbox(900);
  const node = { id: 'n1' };
  eq(S.__promptHeightFor(node), 220);
  // 同一个框连续问几次（模拟 focus / blur 反复触发）结果必须一样
  eq(S.__promptHeightFor(node), 220);
  eq(S.__promptHeightFor(node), 220);
});

check('promptHeightFor 不再吃焦点参数（源码里没有 focus 判断）', () => {
  const body = pickFunction('promptHeightFor');
  assert(!/focus/i.test(body), 'promptHeightFor 里又出现了焦点判断，高度会随点进点出变化');
  assert(!/activeElement/.test(body), 'promptHeightFor 里读了 activeElement');
});

check('buildPrompt 的 focus / blur 不改高度', () => {
  const body = pickFunction('buildPrompt');
  const focusAt = body.indexOf("addEventListener('focus'");
  const blurAt = body.indexOf("addEventListener('blur'");
  assert(focusAt > 0 && blurAt > focusAt, '找不到 focus / blur 监听');
  const focusBody = body.slice(focusAt, blurAt);
  const blurBody = body.slice(blurAt, body.indexOf("addEventListener('input'"));
  assert(!/applyPromptHeight/.test(focusBody), 'focus 时还在重算高度');
  assert(!/applyPromptHeight/.test(blurBody), 'blur 时还在重算高度');
});

check('手动加高仍然有效：380，且不超过窗口允许的上限', () => {
  const S = makePromptSandbox(900);
  const node = { id: 'n2' };
  S.__promptHeights.n2 = 380;
  eq(S.__promptHeightFor(node), 380);
  // 窗口只有 300 高时上限是 186（0.62 屏高），不能顶出屏幕
  const small = makePromptSandbox(300);
  small.__promptHeights.n2 = 380;
  eq(small.__promptHeightFor({ id: 'n2' }), small.__promptHeightLimit());
});

check('窗口很矮时固定高度自动收到上限，不会超过屏高', () => {
  const S = makePromptSandbox(200);
  const limit = S.__promptHeightLimit();
  const h = S.__promptHeightFor({ id: 'n3' });
  eq(h, limit);
  assert(h <= 200, '高度 ' + h + ' 超过了 200 高的窗口');
});

check('「加高」按钮的档位是 380（PROMPT_TALL_H）', () => {
  const body = pickFunction('buildPromptBlock');
  assert(/setPromptCustomHeight\(node, PROMPT_TALL_H\)/.test(body), '加高按钮没接到 PROMPT_TALL_H');
  const hit = canvasSrc.match(/const PROMPT_TALL_H = (\d+);/);
  assert(hit && Number(hit[1]) === 380, 'PROMPT_TALL_H 不是 380');
});

check('展开大面板不会偷偷写进「自定义高度」（否则收起后回不到 220）', () => {
  const body = pickFunction('buildPromptBlock');
  const expandAt = body.indexOf("expand.addEventListener('click'");
  assert(expandAt > 0, '找不到展开按钮的点击处理');
  const seg = body.slice(expandAt, body.indexOf('const box = buildPrompt('));
  assert(!/setPromptCustomHeight/.test(seg), '展开时还在写自定义高度，收起大面板后框会停在很高');
});

console.log('\n二、面板永远向下');

check('源码里彻底没有 panel-up（翻转类）', () => {
  assert(!canvasSrc.includes('panel-up'), 'canvas.js 里还有 panel-up');
  assert(!cssSrc.includes('panel-up'), 'style.css 里还有 .panel-up 样式');
});

check('style.css 里 .node-panel 仍然是 top:100% 的向下定位', () => {
  const at = cssSrc.indexOf('.node-panel {');
  assert(at > 0, '找不到 .node-panel 规则');
  const rule = cssSrc.slice(at, cssSrc.indexOf('}', at));
  assert(/top:\s*100%/.test(rule), '.node-panel 不再是 top:100%，面板不会贴着卡片下边');
  assert(!/bottom:\s*100%/.test(rule), '.node-panel 里出现了 bottom:100%（往上翻）');
});

check('普通卡片的面板不再改 panel.style.top（会和 CSS 的 margin-top 叠成双份）', () => {
  const body = pickFunction('placePanelInner');
  // 定时组那条分支用的是 translate(-50%,-50%) 居中，top:'50%' 是它的正常写法，先切掉
  const upperAt = body.indexOf('if (isSchedule(hostNode))');
  const lowerAt = body.indexOf('const view = viewportBox();');
  assert(upperAt > 0 && lowerAt > upperAt, '找不到定时组分支的边界');
  const plain = body.slice(lowerAt) + pickFunction('placePanelVertical');
  const bad = plain.split('\n').filter((line) => /panel\.style\.top\s*=/.test(line) && !/=\s*''/.test(line));
  eq(bad.length, 0, '又在给 panel.style.top 赋非空值：' + bad.join(' | '));
});

// 用户 2026-11-21 的原话：
//   「卡片贴到屏幕最底边的时候，面板超出的部分不用管，我会自行移动画布来查看。」
// 所以这一条从「一次算完的位移」反转成「一个像素都不许动」。
check('**点开卡片绝不平移画布**：placePanel 相关的函数里没有一处写 viewport', () => {
  const vertical = pickFunction('placePanelVertical');
  const inner = pickFunction('placePanelInner');
  const both = vertical + '\n' + inner;
  assert(!/viewport\.[xy]\s*(\+=|-=|=)/.test(both),
    '贴面板的代码又在改 viewport 了 —— 点一下卡片画布就会跳走');
  assert(!/applyViewport\(\)/.test(vertical), 'placePanelVertical 里还调 applyViewport（说明还在挪画布）');
  assert(!/autoShift|shiftCap|maxUp|maxDown/.test(both), '还留着旧的「让位」位移逻辑（autoShift / shiftCap / maxUp）');
});

check('贴底卡片：空间不够时保持自然高度、允许溢出，不压成小缝', () => {
  const body = pickFunction('placePanelVertical');
  // 关键：只在「空间够用」时才收高度；不够就完全不动 maxHeight
  assert(/minUsable/.test(body), '没有「够不够用」的阈值判断');
  // 直接盯语句本身，别在注释里找（注释里先出现这个词，会误判）
  assert(/if \(space >= minUsable &&/.test(body),
    '空间够用的判断不是 space >= minUsable（贴底时会被误判成够用）');
});

check('「够用」的下限按底栏真实高度算（不能写死一个数）', () => {
  const body = pickFunction('placePanelVertical');
  // 不同卡片底栏高度差很多（参考素材 / 版本条），写死数值会出现按钮被挤出面板
  assert(/node-footer/.test(body), '没有量底栏高度');
  assert(/footerH/.test(body) && /minUsable/.test(body), '下限没有参与判断');
  // 但绝不能再出现旧那种「按底栏高度硬压 maxHeight」的写法
  const compressAt = body.indexOf('panel.style.maxHeight = toCssPx');
  assert(compressAt > 0, '找不到收高度的语句');
  const compressLine = body.slice(compressAt, body.indexOf('\n', compressAt));
  assert(/toCssPx\(space\)/.test(compressLine),
    '收高度不是按剩余空间算的（会压成一条窄缝）：' + compressLine.trim());
});

check('空间够用时收到刚好贴住屏幕下沿（不等于放任溢出）', () => {
  const body = pickFunction('placePanelVertical');
  assert(/panel\.style\.maxHeight = toCssPx\(space\)/.test(body), '没有按剩余空间收高度');
});

check('缩放触发重贴时也不会动画布（贴面板本身已不挪视口）', () => {
  const body = pickFunction('applyViewport');
  assert(/placePanel\(/.test(body), 'applyViewport 里没有重贴面板');
  const at = body.indexOf('placePanel(');
  const seg = body.slice(at, at + 40);
  assert(!/viewport\.y\s*(\+=|=)/.test(body), 'applyViewport 里不该写 viewport.y（那是平移的活儿）');
  assert(seg.length > 0, '取不到 placePanel 调用');
});

check('拖动途中完全不动面板（只写 transform），松手后才落位一次', () => {
  const body = pickFunction('startDrag');
  const paintAt = body.indexOf('const paintDrag = () => {');
  assert(paintAt > 0, '找不到 paintDrag');
  const paintBody = body.slice(paintAt, body.indexOf('const commitDrag = () => {'));
  assert(!/placePanel\(/.test(paintBody), '拖动途中还在贴面板：会量尺寸 + 推画布，卡片会落后于鼠标');
  // 松手后必须落位一次（不然卡片落到屏幕底部时面板被切掉没人管）
  const commitAt = body.indexOf('const commitDrag = () => {');
  const commitBody = body.slice(commitAt, body.indexOf('const onMove = (moveEvent) => {'));
  assert(/placePanel\(/.test(commitBody), '松手后没有重贴面板');
});

check('平移画布松手时不推画布（用户刚挪的视角不能再被推回去）', () => {
  const body = pickFunction('startPan');
  assert(/placePanel\(false\)/.test(body), 'startPan 松手时重贴面板没传 false');
});

check('贴面板期间有重入保护（placePanel 内部会调 applyViewport）', () => {
  const outer = pickFunction('placePanel');
  assert(/placingPanel/.test(outer), 'placePanel 没有重入保护');
  const viewportFn = pickFunction('applyViewport');
  assert(/!placingPanel/.test(viewportFn), 'applyViewport 没有跳过 placingPanel 期间的回调');
});

console.log('\n三、提示词框右上角图标不被滚动条压住');

// 取某条 CSS 规则的完整声明块
function cssRule(selector, from) {
  // 前面加换行：'.node-prompt {' 会被 '.node.expanded.wide .node-prompt {' 抢先匹配
  const at = cssSrc.indexOf('\n' + selector, from || 0) + 1;
  if (at <= 0) return null;
  if (at < 0) return null;
  const open = cssSrc.indexOf('{', at);
  const close = cssSrc.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  return { selector: selector, at: at, body: cssSrc.slice(open + 1, close) };
}
function cssPx(body, prop) {
  const m = body.match(new RegExp(prop + '\\s*:\\s*(-?[\\d.]+)px'));
  return m ? Number(m[1]) : null;
}

check('输入框给滚动条留了固定车道（scrollbar-gutter: stable）', () => {
  const rule = cssRule('.node-prompt {');
  assert(rule, '找不到 .node-prompt 规则');
  assert(/scrollbar-gutter:\s*stable/.test(rule.body), '没有 scrollbar-gutter: stable：长提示词一出滚动条，正文会横着抖一下');
});

check('滚动条宽度是写死的 10px（系统默认 15~17px 会把图标压住）', () => {
  const rule = cssRule('.node-prompt::-webkit-scrollbar');
  assert(rule, '找不到 .node-prompt::-webkit-scrollbar');
  eq(cssPx(rule.body, 'width'), 10);
});

check('没有把 scrollbar-width 写给 Chromium（它会让 10px 车道失效，实测变成 5px）', () => {
  const rule = cssRule('.node-prompt {');
  assert(!/scrollbar-width/.test(rule.body), '.node-prompt 里出现了 scrollbar-width：Chromium 会忽略 ::-webkit-scrollbar 的宽度');
  // 只允许写在只对 Firefox 生效的 @supports 块里
  const supportAt = cssSrc.indexOf('@supports (-moz-appearance: none)');
  assert(supportAt > 0, 'Firefox 的兜底块没了');
  const block = cssSrc.slice(supportAt, cssSrc.indexOf('}', cssSrc.indexOf('.node-prompt {', supportAt)));
  assert(/scrollbar-width/.test(block), 'Firefox 兜底块里没有 scrollbar-width');
});

check('图标条 right 让开了 10px 车道（不是原来的 4px）', () => {
  const rule = cssRule('.prompt-bar {');
  assert(rule, '找不到 .prompt-bar 规则');
  const right = cssPx(rule.body, 'right');
  assert(right !== null, '.prompt-bar 没有 right');
  assert(right >= 14, 'right=' + right + 'px 太小：滚动条宽 10px，图标会压上去');
});

check('图标条本身不压在车道里：right + 图标总宽 ≤ 输入框右侧留白', () => {
  const promptRule = cssRule('.node-prompt {');
  const barRule = cssRule('.prompt-bar {');
  // 右内边距写在 padding 简写里：padding: 上 右 下 左
  const padRight = cssPx(promptRule.body, 'padding-right')
    || Number((promptRule.body.match(/padding:\s*[\d.]+px\s+([\d.]+)px/) || [])[1]);
  assert(padRight, '.node-prompt 的右内边距读不出来');
  const right = cssPx(barRule.body, 'right');
  // 两个 21px 图标 + 2px 间距 = 44px
  const BTN = 21;
  const GAP = 2;
  const iconSpan = BTN * 2 + GAP;
  assert(right + iconSpan <= padRight, '图标条右边界 ' + (right + iconSpan) + 'px 超过了输入框右内边距 ' + padRight + 'px：正文会跑到图标底下');
});

console.log('\n四、没有留下死代码');

check('refreshPanelFlip / lastPlacedHost 已彻底删除', () => {
  assert(!canvasSrc.includes('refreshPanelFlip'), 'refreshPanelFlip 还在（面板不再翻转，这函数是死代码）');
  assert(!canvasSrc.includes('lastPlacedHost'), 'lastPlacedHost 还在（已经没人读它）');
});

check('提示词高度的死参数 focusedOverride 已删除', () => {
  assert(!canvasSrc.includes('focusedOverride'), 'focusedOverride 还留着');
  assert(!canvasSrc.includes('PROMPT_SHORT_H'), 'PROMPT_SHORT_H 还留着');
});

// check() 是同步的；这里包一层，好在端到端里 await 真正的断言结果
async function checkAsync(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (error) { fail += 1; console.log('  ✗ ' + name + ' —— ' + error.message); }
}
console.log('\n五、端到端：贴底卡片点开时，画布一个像素都不动');

// 这一段守的是用户真正看到的那一下：真实鼠标点卡片，真实浏览器量 transform。
// 只查源码不够 —— 位移是运行时算出来的，注释写得再好也可能算错。
async function runE2E() {
  const os = require('node:os');
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const edge = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find((x) => fs.existsSync(x));
  if (!edge) { console.log('  · 本机没有 Chrome / Edge，跳过端到端（上面的源码断言已覆盖规则）'); return; }

  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'panelpos-'));
  const dataDir = path.join(box, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const cdpPort = 9511;
  const cdp = 'http://127.0.0.1:' + cdpPort;
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--no-browser'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { CANVAS_DATA_DIR: dataDir, http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '' }),
    stdio: 'ignore',
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'panelpos-chrome-'));
  const chrome = spawn(edge, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  try {
    let port = 0;
    for (let i = 0; i < 140; i += 1) {
      try { port = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')).port; } catch { port = 0; }
      if (port) { try { if ((await localGet('http://127.0.0.1:' + port + '/api/health')).status === 200) break; } catch {} }
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
        let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject); req.end(data || undefined);
    });

    const longText = ('## 视频编号 02 | 望穿秋水\n\n场景：破败药店内（白日｜四向空景）\n\n出场人物：\n- 虞里月\n- 徐青\n\n').repeat(12);
    const created = JSON.parse((await api('POST', '/api/canvases', { name: '贴底卡片' })).body);
    await api('PUT', '/api/canvases/' + created.canvas.id, {
      nodes: [
        // 竖直摆在屏幕最底边：视口高 900，卡片 h=280，viewport.y=320 → 卡片下沿正好在 900
        { id: 'bot', type: 'image', x: 300, y: 300, w: 420, h: 280, z: 0, createdAt: 1000, data: { v: 3, text: longText, model: '', params: {}, no: 1 } },
      ],
      edges: [],
      viewport: { x: 0, y: 320, zoom: 1 },
    });

    for (let i = 0; i < 60; i += 1) { try { if ((await localGet(cdp + '/json/version')).status === 200) break; } catch {} await sleep(250); }
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
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/canvas?id=' + created.canvas.id });
    for (let i = 0; i < 120; i += 1) {
      if (await evalJs('document.querySelectorAll("#world .node").length > 0')) break;
      await sleep(250);
    }
    await sleep(1600);

    const SNAP = '(() => { const n = document.querySelector(\'#world .node[data-id="bot"]\'); const r = n.getBoundingClientRect(); const p = n.querySelector(".node-panel"); const pr = (p && n.classList.contains("expanded")) ? p.getBoundingClientRect() : null; return { world: document.getElementById("world").style.transform, nodeTop: Math.round(r.top), vh: innerHeight, expanded: n.classList.contains("expanded"), panel: pr ? { top: Math.round(pr.top), bottom: Math.round(pr.bottom), h: Math.round(pr.height) } : null, maxH: p ? p.style.maxHeight : null }; })()';
    const snap = () => evalJs(SNAP);
    const clickCard = async () => {
      const pt = await evalJs('(() => { const n = document.querySelector(\'#world .node[data-id="bot"]\'); const r = n.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(Math.max(4, Math.min(innerHeight - 4, r.top + 40))) }; })()');
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(50);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 0 });
      await sleep(1400);
    };

    const before = await snap();
    await clickCard();
    const after = await snap();
    await checkAsync('① 贴底卡片点开：画布 transform 完全没变', () => assert(before.world === after.world, before.world + ' -> ' + after.world));

    await checkAsync('② 卡片本身也没被挪动', () => assert(before.nodeTop === after.nodeTop, before.nodeTop + ' -> ' + after.nodeTop));

    await checkAsync('③ 面板保持自然高度（不被压成窄缝，超出屏幕就让它超出）', () => assert(!!after.panel && after.panel.h > 280, JSON.stringify(after.panel)));

    // 再开合两次，确认不会累积漂移
    await clickCard();
    await clickCard();
    const third = await snap();
    await checkAsync('④ 反复开合后画布仍没有漂移', () => assert(third.world === before.world, before.world + ' -> ' + third.world));
  } finally {
    try { if (ws) ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { server.kill(); } catch {}
  }
}

(async () => {
  try { await runE2E(); }
  catch (error) { console.log('  ✗ 端到端没跑完 —— ' + error.message); fail += 1; }
  console.log('\n共 ' + (pass + fail) + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
