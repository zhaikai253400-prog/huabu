'use strict';

// 提示词框固定高度 + 编辑面板永远向下（不再自适应翻转）。
//
// 这两条是用户明确要求的「不要自适应」：
//   · 提示词框点进去不高、点出去不矮，永远从 220px 起步；
//   · 编辑面板永远贴在卡片正下方，下面放不下就把画布往上让一点，
//     而不是翻到卡片上方 —— 翻上去以后同一个按钮时上时下，用起来要重新找。
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

check('竖直方向只有一份「一次算完」的位移逻辑，且有向下/向上的上限', () => {
  const body = pickFunction('placePanelVertical');
  assert(/viewport\.y \+= dy;/.test(body), '没有把算出来的 dy 落到 viewport.y 上');
  // 只允许出现一次 applyViewport（多份位移会互相抵消 → 面板抖）
  eq((body.match(/applyViewport\(\)/g) || []).length, 1, 'placePanelVertical 里出现了多次 applyViewport');
  assert(/maxUp/.test(body) && /maxDown/.test(body), '缺少向上 / 向下的位移上限，画布会把卡片推出视野');
});

check('缩放触发重贴时不允许动画布（否则边缩边被顶走）', () => {
  const body = pickFunction('applyViewport');
  assert(/placePanel\(false\)/.test(body), 'applyViewport 里重贴面板没有传 false');
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

check('面板放不下时兜底压高度，且下限不低于底栏高度', () => {
  const body = pickFunction('placePanelVertical');
  assert(/maxHeight/.test(body), '兜底没有压 maxHeight');
  assert(/node-footer/.test(body), '下限没有按底栏高度算，压太矮时「生成」按钮会丢');
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

console.log('\n共 ' + (pass + fail) + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
