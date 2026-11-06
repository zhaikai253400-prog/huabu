'use strict';

// 默认尺寸（横 360×210 / 竖 210×360 / 音频 210×100）与「按默认尺寸重排」的隔离测试。
//
// 两件事要守住：
//   1. 新卡片的默认盒子：16:9 与 9:16 直接给满，其它比例在同一个盒子里收放、不变形。
//   2. 批量重排只碰「没手动调过大小」的卡片：手动拉过、素材缩略图、定时组成员、
//      锁定 / 隐藏的一律不入选，否则用户精心调过的排版会被一键抹平。
//
// 前端是 IIFE，函数取不出来，所以用「源码片段提取 + 沙箱跑」的办法测纯函数，
// 再配合源码级断言确认按钮、右键项和点击分发都接上了。
//
// 运行：runtime/node.exe tools/tests/default-size.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-defaultsize-'));
require(path.join(__dirname, '_isolate.js'))(box);

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

const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'web', 'canvas.html'), 'utf8');

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

// 生产代码里的常量按原样搬进沙箱（值改了测试会立刻发现）
function pickConst(name) {
  const hit = canvasSrc.match(new RegExp('const ' + name + ' = ([^;]+);'));
  if (!hit) throw new Error('源码里找不到常量 ' + name);
  return 'const ' + name + ' = ' + hit[1] + ';';
}

// ---------- 沙箱：只放纯计算需要的依赖 ----------
const state = {
  nodes: [],
  selection: new Set(),
  locked: new Set(),
  hidden: new Set(),
  scheduleIds: new Set(),
  presets: {
    image: { w: 360, h: 210 },
    video: { w: 360, h: 210 },
    quick: { w: 360, h: 210 },
    audio: { w: 210, h: 100 },
    group: { w: 320, h: 184 },
    schedule: { w: 400, h: 300 },
    zone: { w: 400, h: 300 },
    director: { w: 400, h: 300 },
  },
};

const sandbox = { state: state };
vm.createContext(sandbox);
vm.runInContext(
  [
    'const RATIO_VALUE = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4 };',
    pickConst('CARD_BOX'),
    pickConst('CARD_BASE_LANDSCAPE'),
    pickConst('CARD_BASE_PORTRAIT'),
    pickConst('CARD_MIN_EDGE'),
    // 每一类卡片的固定形状（组合 / 定时组 / 区域 / 导演台不套媒体盒子）
    'const PRESET_SIZE = state.presets;',
    pickConst('RESIZABLE_TYPES'),
    'function presetOf(type) { return PRESET_SIZE[type] || PRESET_SIZE.image; }',
    pickFunction('ratioValueOf'),
    pickFunction('defaultBoxSize'),
    pickFunction('defaultSize'),
    // batchResizeCandidates 依赖的几个判据，用 state 里的集合替身
    'function nodeData(node) { return node.data; }',
    'function isLocked(node) { return state.locked.has(node.id); }',
    'function isHidden(node) { return state.hidden.has(node.id); }',
    'const memberSchedule = { get: function (id) { return state.scheduleIds.has(id) ? { scheduleId: "s" } : null; } };',
    'const nodes = { get filter() { return state.nodes.filter.bind(state.nodes); } };',
    'const selection = state.selection;',
    pickFunction('defaultBoxGapOf'),
    pickFunction('batchResizeCandidates'),
    'globalThis.__ratioValueOf = ratioValueOf;',
    'globalThis.__defaultBoxSize = defaultBoxSize;',
    'globalThis.__defaultSize = defaultSize;',
    'globalThis.__batchResizeCandidates = batchResizeCandidates;',
    'globalThis.__defaultBoxGapOf = defaultBoxGapOf;',
  ].join('\n'),
  sandbox
);

function sizeOf(type, ratio) {
  return sandbox.__defaultSize(type, { ratio: ratio });
}
function eqSize(type, ratio, w, h) {
  const size = sizeOf(type, ratio);
  eq(size.w + 'x' + size.h, w + 'x' + h, type + ' ' + ratio);
}

function card(id, type, w, h, extra) {
  return {
    id: id,
    type: type,
    x: 0,
    y: 0,
    w: w,
    h: h,
    data: Object.assign({ params: {}, sized: false, thumb: false }, extra || {}),
  };
}
function selectAll(list) {
  state.nodes.length = 0;
  state.selection.clear();
  state.locked.clear();
  state.hidden.clear();
  state.scheduleIds.clear();
  list.forEach((node) => {
    state.nodes.push(node);
    state.selection.add(node.id);
  });
}
function idsOf(list) {
  return list.map((node) => node.id).join(',');
}

console.log('\n默认尺寸 · 盒子尺寸');

check('16:9 给满 360×210', () => {
  eqSize('image', '16:9', 360, 210);
  eqSize('video', '16:9', 360, 210);
  eqSize('quick', '16:9', 360, 210);
});

check('9:16 竖屏是 210×360', () => {
  eqSize('image', '9:16', 210, 360);
  eqSize('video', '9:16', 210, 360);
});

check('1:1 是 210×210（短边贴 210）', () => {
  eqSize('image', '1:1', 210, 210);
});

check('4:3 是 280×210', () => {
  eqSize('image', '4:3', 280, 210);
});

check('3:4 是 210×280', () => {
  eqSize('video', '3:4', 210, 280);
});

check('21:9 锁宽 360，高度压到 154', () => {
  eqSize('image', '21:9', 360, 154);
});

check('1:3 锁高 360，宽度压到 120', () => {
  eqSize('image', '1:3', 120, 360);
});

check('音频固定 210×100，不随比例变', () => {
  eqSize('audio', '16:9', 210, 100);
  eqSize('audio', '9:16', 210, 100);
});

check('组合 / 定时组 / 区域 / 导演台走自己的固定形状', () => {
  eqSize('group', '16:9', 320, 184);
  eqSize('zone', '16:9', 400, 300);
  eqSize('schedule', '16:9', 400, 300);
  eqSize('director', '16:9', 400, 300);
});

check('比例缺失或非法时按 16:9 兜底', () => {
  eqSize('image', '', 360, 210);
  eqSize('image', 'anamorphic', 360, 210);
  eqSize('image', '0:0', 360, 210);
});

console.log('\n按默认尺寸 · 候选过滤');

check('老尺寸的图片 / 视频 / 音频都入选', () => {
  selectAll([
    card('a', 'image', 310, 140),
    card('b', 'video', 140, 310),
    card('c', 'audio', 240, 70),
  ]);
  eq(idsOf(sandbox.__batchResizeCandidates()), 'a,b,c');
  assert(sandbox.__defaultBoxGapOf(state.nodes[0]) >= 1, '老尺寸的差距应当大于 1px');
});

check('已经是默认尺寸的不入选（不白计数）', () => {
  selectAll([card('a', 'image', 360, 210), card('b', 'audio', 210, 100)]);
  eq(idsOf(sandbox.__batchResizeCandidates()), '');
});

check('手动拉过大小（sized）的不入选', () => {
  selectAll([card('a', 'image', 500, 280, { sized: true }), card('b', 'image', 310, 140)]);
  eq(idsOf(sandbox.__batchResizeCandidates()), 'b');
});

check('素材缩略图（thumb）不入选', () => {
  selectAll([card('a', 'image', 140, 88, { thumb: true }), card('b', 'image', 310, 140)]);
  eq(idsOf(sandbox.__batchResizeCandidates()), 'b');
});

check('锁定 / 隐藏的不入选', () => {
  selectAll([card('a', 'image', 310, 140), card('b', 'image', 310, 140), card('c', 'image', 310, 140)]);
  state.locked.add('a');
  state.hidden.add('b');
  eq(idsOf(sandbox.__batchResizeCandidates()), 'c');
});

check('定时组成员不入选（组内统一排版）', () => {
  selectAll([card('a', 'video', 140, 310), card('b', 'video', 140, 310)]);
  state.scheduleIds.add('a');
  eq(idsOf(sandbox.__batchResizeCandidates()), 'b');
});

check('组合 / 定时组 / 区域 / 导演台不入选', () => {
  selectAll([
    card('a', 'group', 320, 184),
    card('b', 'schedule', 400, 300),
    card('c', 'zone', 400, 300),
    card('d', 'director', 400, 300),
  ]);
  eq(idsOf(sandbox.__batchResizeCandidates()), '');
});

check('没被选中的不入选', () => {
  selectAll([card('a', 'image', 310, 140), card('b', 'image', 310, 140)]);
  state.selection.delete('b');
  eq(idsOf(sandbox.__batchResizeCandidates()), 'a');
});

console.log('\n按默认尺寸 · 入口接线');

check('多选操作栏里有「按默认尺寸」按钮', () => {
  assert(htmlSrc.indexOf('data-batch="resize"') >= 0, 'canvas.html 里没有 resize 按钮');
});

check('paintBatchButtons 会算出 resize 数量并管分隔线', () => {
  const body = pickFunction('paintBatchButtons');
  assert(body.indexOf("batchResizeCandidates().length") >= 0, '没算 resizeCount');
  assert(body.indexOf("data-batch=\"resize\"") >= 0, '没取 resize 按钮');
  assert(body.indexOf('resizeCount <= 0') >= 0, '分隔线判断没带上 resizeCount');
});

check('点击分发接上了 runBatchResize', () => {
  assert(canvasSrc.indexOf("batch === 'resize'") >= 0, '没有 resize 的点击分支');
  assert(canvasSrc.indexOf('function runBatchResize(') >= 0, '没有 runBatchResize');
});

check('右键菜单里有单卡「按默认尺寸」', () => {
  const body = pickFunction('openNodeMenu');
  assert(body.indexOf('按默认尺寸（') >= 0, '右键菜单没有这项');
  assert(body.indexOf('resizeOneToDefault') >= 0, '右键项没接到 resizeOneToDefault');
});

check('重排保持中心点不动', () => {
  const body = pickFunction('resizeNodeToDefaultBox');
  assert(body.indexOf('cx - size.w / 2') >= 0, '没有按中心点反算 x');
  assert(body.indexOf('cy - size.h / 2') >= 0, '没有按中心点反算 y');
});

check('重排不整卡重建（不打断正在播放的视频）', () => {
  const body = pickFunction('runBatchResize');
  assert(body.indexOf('renderAll()') < 0, 'runBatchResize 仍在整卡重建');
  assert(body.indexOf('paintBoxStyle') >= 0, '没有就地更新样式');
  assert(pickFunction('resizeOneToDefault').indexOf('renderAll()') < 0, '单卡重排仍在整卡重建');
});

console.log('\n' + (fail ? '失败 ' + fail + ' 项' : '全部通过') + '（通过 ' + pass + ' 项）');
process.exit(fail ? 1 : 0);
