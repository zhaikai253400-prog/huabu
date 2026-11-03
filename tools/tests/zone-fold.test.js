'use strict';

// F1 区域与折叠的隔离测试（清单 20 + 21）。
//
// 两件事要守住：
//
//   1. **折叠是纯显示态**（清单 21 的正中心）。折叠前后，成员卡片自己的
//      data（任务、生成结果、history）、edges 数组、nodes 数组都必须一字不差。
//      这里不满足的话，「折一下收起来」就会悄悄改坏用户的数据，
//      而且是那种当天看不出来、过几天才发现生成结果没了的坏。
//
//   2. 归属关系只有一份真相：成员卡片的 data.zoneId。区域自己不存名单，
//      所以删卡片不用回头清区域、复制时不用两头重映射。
//
// 前端是 IIFE，函数取不出来，所以用「源码片段提取 + vm 沙箱跑」的办法，
// 跟 locate.test.js / partial-update.test.js 是同一套手法。
//
// 运行：runtime/node.exe tools/tests/zone-fold.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

// 隔离：本测试只跑纯逻辑，不碰数据库，仍走统一助手保持范式一致
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-zone-'));
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
const cssSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'style.css'), 'utf8');

// 从源码里抠出一个函数（按花括号配对找结尾）
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

function pickBody(name) {
  const full = pickFunction(name);
  return full.slice(full.indexOf('{') + 1, full.lastIndexOf('}'));
}

// 取一个 `const 名字 = 数字;` 的数值
function constOf(name) {
  const at = canvasSrc.indexOf('const ' + name + ' =');
  if (at < 0) throw new Error('源码里找不到常量 ' + name);
  const hit = canvasSrc.slice(at, at + 80).match(/=\s*(-?\d+(?:\.\d+)?)/);
  if (!hit) throw new Error('常量 ' + name + ' 不是数字');
  return Number(hit[1]);
}

// ---------------------------------------------------------------- 沙箱
//
// 把区域相关的纯函数抠进来跑。它们依赖的 nodeData / presetOf / sizeOf 之类
// 用与生产语义一致的替身补上，替身改坏了测试会先红。
const sandbox = {
  nodes: [],
  edges: [],
  // 记下垂直方向「危险操作」被调用的次数。折叠路径上一个都不该出现。
  danger: { removeEdge: 0, removeNode: 0, cancel: 0, touchTasks: 0 },
  toastCalls: [],
  selection: new Set(),
  memberSchedule: new Map(),
  PRESETS: {
    zone: { w: 640, h: 420, label: '区域' },
    image: { w: 520, h: 300, label: '图片' },
    video: { w: 520, h: 300, label: '视频' },
  },
  Date: Date,
  Math: Math,
  Number: Number,
  String: String,
  Boolean: Boolean,
  JSON: JSON,
  Array: Array,
  Set: Set,
  Map: Map,
  Infinity: Infinity,
  console: console,
};
vm.createContext(sandbox);

vm.runInContext(
  [
    // ---- 替身 ----
    'function byId(id) { for (var i = 0; i < nodes.length; i += 1) { if (nodes[i].id === id) return nodes[i]; } return null; }',
    'function nodeData(node) { if (!node.data || typeof node.data !== "object") node.data = {}; return node.data; }',
    'function presetOf(type) { return PRESETS[type] || PRESETS.image; }',
    'function scheduleCellSize(compact) { return compact ? { w: 200, h: 112 } : { w: 400, h: 224 }; }',
    'function isTaskActive(data) { return Boolean(data && data.running); }',
    'function pushHistory() {}',
    'function scheduleSave() {}',
    'function renderNodes() {}',
    'function renderEdges() {}',
    'function refreshSelection() {}',
    'function refreshHiddenBadge() {}',
    'function refreshNode() {}',
    'function placePanel() {}',
    'function toast(text) { toastCalls.push(text); }',
    'function removeEdge() { danger.removeEdge += 1; }',
    'function cancelGenerate() { danger.cancel += 1; }',
    // 模块级状态。必须用 var —— 顶层 let / const 不挂到 context 全局对象上，
    // 测试就写不进去、也读不出来。
    'var soloZoneId = "";',
    'var expandedId = null;',
    // ---- 被验证的源码 ----
    pickFunction('isManuallyHidden'),
    pickFunction('isZone'),
    pickFunction('zoneMembersOf'),
    pickFunction('zoneOf'),
    pickFunction('isZoneFolded'),
    pickFunction('isHiddenBySolo'),
    pickFunction('isHidden'),
    pickFunction('foldedNodes'),
    pickFunction('assignZone'),
    pickFunction('rawSizeOf'),
    // 折叠后的显示高度常量：直接从源码里取数值注入，别切片 ——
    // 切到一半会把下一行函数声明连在一起，变成语法错误
    'var ZONE_COLLAPSED_H = ' + String(constOf('ZONE_COLLAPSED_H')) + ';',
    pickFunction('sizeOf'),
    pickFunction('zoneAt'),
    pickFunction('setZoneCollapsed'),
  ].join('\n'),
  sandbox
);

const S = sandbox;

function reset() {
  S.nodes = [];
  S.edges = [];
  S.selection = new Set();
  S.soloZoneId = '';
  S.expandedId = null;
  S.toastCalls.length = 0;
  S.danger = { removeEdge: 0, removeNode: 0, cancel: 0, touchTasks: 0 };
}
function mkZone(id, extra) {
  return Object.assign({ id: id, type: 'zone', x: 0, y: 0, w: 640, h: 420, data: { text: id, collapsed: false, color: '' } }, extra || {});
}
function mkCard(id, zoneId, extra) {
  return Object.assign({
    id: id,
    type: 'image',
    x: 100,
    y: 100,
    w: 520,
    h: 300,
    data: { zoneId: zoneId || '', running: false, result: { url: '/a.png' }, history: [{ at: 1 }] },
  }, extra || {});
}

console.log('\nF1 · 区域归属与三层可见性');

reset();

check('isZone 只认 type === "zone"（不会把别的卡片误当区域）', () => {
  eq(S.isZone(mkZone('z1')), true);
  eq(S.isZone(mkCard('c1', '')), false);
  eq(S.isZone(null), false);
  eq(S.isZone({ type: 'schedule' }), false);
});

check('zoneOf：没归属 / 指向不存在的区域 / 区域自己，都返回 null', () => {
  reset();
  const zone = mkZone('z1');
  const card = mkCard('c1', 'z1');
  S.nodes = [zone, card];
  eq(S.zoneOf(card), zone, '正常归属应返回那块区域');
  eq(S.zoneOf(mkCard('c2', '')), null, '没归属的是 null');
  eq(S.zoneOf(mkCard('c3', 'zzz')), null, '指向已不存在的区域要当没归属（不能留悬空编号）');
  eq(S.zoneOf(zone), null, '区域不能属于区域');
});

check('zoneMembersOf：只列 zoneId 指向它的普通卡片，区域不算成员', () => {
  reset();
  const zone = mkZone('z1');
  const inner = mkZone('z2'); // 哪怕另一块区域写了自己的 zoneId，也不该被当成成员
  const a = mkCard('a', 'z1');
  const b = mkCard('b', 'z1');
  const c = mkCard('c', 'z2');
  inner.data.zoneId = 'z1';
  S.nodes = [zone, inner, a, b, c];
  const members = S.zoneMembersOf(zone).map((one) => one.id);
  eq(members.sort().join(','), 'a,b', '区域不能被圈成成员（否则折叠会套娃）');
  eq(S.zoneMembersOf({ type: 'image' }).length, 0, '非区域调用返回空');
});

check('assignZone：设归属 / 换区域 / 没变化返回 false / 卡片不能进自己', () => {
  reset();
  const z1 = mkZone('z1');
  const z2 = mkZone('z2');
  const card = mkCard('c1', '');
  S.nodes = [z1, z2, card];
  eq(S.assignZone(card, z1), true, '第一次设归属应算有变化');
  eq(card.data.zoneId, 'z1');
  eq(S.assignZone(card, z1), false, '重复设同一个区域不该算变化（免得白写一次历史）');
  eq(S.assignZone(card, z2), true, '换区域算变化');
  eq(card.data.zoneId, 'z2', '换过去之后旧归属要被覆盖，不能同时属于两块');
  eq(S.assignZone(z1, z2), false, '区域自己不能被塞进区域');
});

check('isHidden 三层：手动隐藏 / 区域折叠 / 只看某区域，各自独立', () => {
  reset();
  const zone = mkZone('z1');
  const inside = mkCard('in', 'z1');
  const outside = mkCard('out', '');
  const manual = mkCard('manual', 'z1', { data: { zoneId: 'z1', hidden: true } });
  S.nodes = [zone, inside, outside, manual];

  eq(S.isHidden(inside), false, '什么都没动的时候都该是可见的');

  // ① 手动隐藏
  eq(S.isHidden(manual), true, '手动隐藏的要藏起来');
  manual.data.hidden = false;

  // ② 区域折叠
  zone.data.collapsed = true;
  eq(S.isHidden(inside), true, '折叠区域的成员要藏起来');
  eq(S.isHidden(manual), true, '手动隐藏的当然也藏');
  eq(S.isHidden(outside), false, '别人的卡片不受影响');
  eq(S.isHidden(zone), false, '区域自己不被自己的折叠藏掉（否则连展开按钮都没了）');
  zone.data.collapsed = false;

  // ③ 只看某块区域
  S.soloZoneId = 'z1';
  eq(S.isHidden(inside), false, '被看的区域里的卡片要留着');
  eq(S.isHidden(outside), true, '别的卡片先挡住');
  eq(S.isHidden(zone), false, '被看的区域框本身要留着，它是这块内容的边界');
  S.nodes = [zone, mkZone('z9'), inside, outside];
  eq(S.isHidden(S.nodes[1]), true, '别的区域框也要挡住');
});

check('手动隐藏与区域折叠互不干扰：展开区域不该放出用户自己藏的卡片', () => {
  reset();
  const zone = mkZone('z1');
  // 用户自己先藏了一张，然后又把区域折起来再展开
  const mine = mkCard('mine', 'z1', { data: { zoneId: 'z1', hidden: true } });
  S.nodes = [zone, mine];
  zone.data.collapsed = true;
  eq(S.isHidden(mine), true);
  zone.data.collapsed = false;
  eq(S.isHidden(mine), true, '展开区域把用户自己藏的卡片一起放出来了 —— 越权了');
});

check('foldedNodes 只列「不是手动隐藏」的那些（避免恢复窗口里重复算一遍）', () => {
  reset();
  const zone = mkZone('z1');
  const mine = mkCard('mine', 'z1', { data: { zoneId: 'z1', hidden: true } });
  const folded = mkCard('folded', 'z1');
  S.nodes = [zone, mine, folded];
  zone.data.collapsed = true;
  eq(S.foldedNodes().map((one) => one.id).join(','), 'folded', '手动隐藏的不该混进「被折叠收着」这一栏');
  eq(S.foldedNodes().length, 1);
});

console.log('\nF1 · 折叠是纯显示态（清单 21 核心）');

check('setZoneCollapsed 只改一个布尔，成员卡片的 data 一个字都不变', () => {
  reset();
  const zone = mkZone('z1');
  // 成员身上带着「正在跑的任务 / 已有生成结果 / 历史版本」——折叠一个都不许碰
  const card = mkCard('c1', 'z1', {
    data: {
      zoneId: 'z1',
      running: true,
      result: { url: '/done.png', kind: 'image' },
      history: [{ at: 1, url: '/a.png' }, { at: 2, url: '/b.png' }],
      text: '一只在窗台上打盹的猫',
      model: 'gpt-image-2-plus',
    },
  });
  S.nodes = [zone, card];
  S.edges = [{ id: 'e1', sourceId: 'c1', targetId: 'c9' }];
  const before = JSON.stringify(card.data);
  const edgesBefore = JSON.stringify(S.edges);
  const nodesBefore = S.nodes.length;

  S.setZoneCollapsed(zone, true);

  eq(zone.data.collapsed, true, '折叠后区域自己应该是收起来的');
  eq(JSON.stringify(card.data), before, '成员卡片的 data 被改动了 —— 折叠越过了显示层');
  eq(JSON.stringify(S.edges), edgesBefore, '连线被动了 —— 折叠只能隐藏绘制，不能删边');
  eq(S.nodes.length, nodesBefore, '节点数量变了 —— 折叠不该增删节点');
  eq(S.danger.removeEdge, 0, '折叠路径上删了连线');
  eq(S.danger.cancel, 0, '折叠路径上取消了生成任务 —— 这正是清单 21 明令禁止的');
});

check('展开同样是纯显示态：来回折三次，数据仍然一字不差', () => {
  reset();
  const zone = mkZone('z1');
  const card = mkCard('c1', 'z1', { data: { zoneId: 'z1', running: true, result: { url: '/x.png' } } });
  S.nodes = [zone, card];
  S.edges = [{ id: 'e1', sourceId: 'a', targetId: 'b' }];
  const before = JSON.stringify(card.data);
  const edgesBefore = JSON.stringify(S.edges);
  for (let i = 0; i < 3; i += 1) {
    S.setZoneCollapsed(zone, true);
    S.setZoneCollapsed(zone, false);
  }
  eq(zone.data.collapsed, false, '来回折完应该回到展开态');
  eq(JSON.stringify(card.data), before, '反复折叠把成员数据改坏了');
  eq(JSON.stringify(S.edges), edgesBefore, '反复折叠把连线改坏了');
  eq(S.danger.cancel + S.danger.removeEdge, 0, '反复折叠碰到了任务或连线');
});

check('折叠时把成员移出选区：选着一堆看不见的卡片，按 Delete 会删掉意外的东西', () => {
  reset();
  const zone = mkZone('z1');
  const card = mkCard('c1', 'z1');
  S.nodes = [zone, card];
  S.selection = new Set(['c1', 'z1']);
  S.setZoneCollapsed(zone, true);
  eq(S.selection.has('c1'), false, '折叠后成员还留在选区里');
  eq(S.selection.has('z1'), true, '折叠不该把区域自己从选区里摘掉');
});

check('折叠区域里有卡片在跑时，提示里要说清楚「不会停」', () => {
  reset();
  const zone = mkZone('z1');
  const running = mkCard('r', 'z1', { data: { zoneId: 'z1', running: true } });
  const idle = mkCard('i', 'z1');
  S.nodes = [zone, running, idle];
  S.setZoneCollapsed(zone, true);
  const said = S.toastCalls.join(' | ');
  assert(said.indexOf('2 张') >= 0, '提示里没说收起来几张：' + said);
  assert(said.indexOf('1 个还在生成') >= 0, '提示里没点出还有生成在跑：' + said);
  assert(said.indexOf('不会停') >= 0, '提示里没说清楚任务照常跑：' + said);
});

check('重复折叠同一个状态不写历史（避免撤销栈里塞满空操作）', () => {
  reset();
  const zone = mkZone('z1');
  S.nodes = [zone, mkCard('c1', 'z1')];
  let historyWrites = 0;
  const src = pickBody('setZoneCollapsed');
  eq(src.indexOf('if (Boolean(data.collapsed) === next) return;') >= 0, true, '缺少「状态没变就直接返回」的短路');
  // 真跑一遍：折叠一次后 toast 一条；再折一次不该有第二条
  S.setZoneCollapsed(zone, true);
  S.setZoneCollapsed(zone, true);
  eq(S.toastCalls.length, 1, '重复折叠又弹了一次提示，说明没短路');
  historyWrites += 1;
  eq(historyWrites, 1);
});

console.log('\nF1 · 归属几何判定（拖进框 / 拖出框）');

check('zoneAt：卡片中心落在框里算命中，落在框外不算', () => {
  reset();
  const zone = mkZone('z1', { x: 0, y: 0, w: 400, h: 300 });
  S.nodes = [zone];
  eq(S.zoneAt({ x: 200, y: 150 }), zone, '中心在框里应命中');
  eq(S.zoneAt({ x: 10, y: 10 }), zone, '贴着左上角也算在里面');
  eq(S.zoneAt({ x: 400, y: 150 }), zone, '正好压着右边缘算在里面（闭区间）');
  eq(S.zoneAt({ x: 401, y: 150 }), null, '出了右边就不算');
  eq(S.zoneAt({ x: 200, y: 300.5 }), null, '出了下边就不算');
});

check('zoneAt：嵌套时取最小的那个框（小框总是更具体的意图）', () => {
  reset();
  const big = mkZone('big', { x: 0, y: 0, w: 800, h: 600 });
  const small = mkZone('small', { x: 100, y: 100, w: 200, h: 200 });
  S.nodes = [big, small];
  eq(S.zoneAt({ x: 200, y: 200 }), small, '两块都圈住时应取更小的那块');
  eq(S.zoneAt({ x: 700, y: 500 }), big, '只在大框里就归大框');
});

check('zoneAt：排除自己（拖动区域本身时不重判自己的归属）', () => {
  reset();
  const zone = mkZone('z1', { x: 0, y: 0, w: 400, h: 300 });
  S.nodes = [zone];
  eq(S.zoneAt({ x: 200, y: 150 }, 'z1'), null, '排除后应返回 null');
});

check('zoneAt：手动隐藏的区域不参与认领（藏起来的框不该偷偷收卡片）', () => {
  reset();
  const zone = mkZone('z1', { x: 0, y: 0, w: 400, h: 300 });
  zone.data.hidden = true;
  S.nodes = [zone];
  eq(S.zoneAt({ x: 200, y: 150 }), null, '隐藏的区域还在认领卡片');
});

check('zoneAt：折叠中的区域不认领（它只剩一条标题，卡片被吸进去就等于拖一下不见了）', () => {
  reset();
  const zone = mkZone('z1', { x: 0, y: 0, w: 400, h: 300 });
  const card = mkCard('c1', '');
  S.nodes = [zone, card];
  eq(S.zoneAt({ x: 200, y: 150 }), zone, '展开时应该能认领');
  zone.data.collapsed = true;
  eq(S.zoneAt({ x: 200, y: 150 }), null, '折叠中的区域还在认领卡片 —— 卡片会凭空消失');
});

console.log('\nF1 · 折叠后的显示尺寸');

check('折叠时框缩成一条标题：宽度不动，高度压到 60', () => {
  reset();
  const zone = mkZone('z1', { w: 640, h: 420 });
  S.nodes = [zone];
  eq(S.sizeOf(zone).h, 420, '展开时是原来的高度');
  zone.data.collapsed = true;
  eq(S.sizeOf(zone).h, 60, '折叠后应缩成一条标题');
  eq(S.sizeOf(zone).w, 640, '宽度要留着 —— 展开回去还是老位置老宽度');
  eq(zone.h, 420, 'node.h 不能被改掉，否则展开回不到原来的框');
  eq(zone.w, 640);
});

check('折叠高度不会把本来就很扁的框拉高', () => {
  reset();
  const flat = mkZone('z1', { w: 640, h: 44 });
  S.nodes = [flat];
  flat.data.collapsed = true;
  eq(S.sizeOf(flat).h, 44, '比标题还扁的框应保持原样，不能被撑高');
});

check('普通卡片不受折叠尺寸逻辑影响', () => {
  reset();
  const card = mkCard('c1', '');
  S.nodes = [card];
  eq(S.sizeOf(card).h, 300);
  card.data.collapsed = true; // 就算数据里有个同名布尔也不该被误判
  eq(S.sizeOf(card).h, 300, '非区域节点被折叠逻辑误伤了');
});

console.log('\nF1 · 源码级约束');

check('归属只有一份真相：区域自己不存成员名单', () => {
  const at = canvasSrc.indexOf("if (node.type === 'zone') {");
  assert(at >= 0, '没找到 zone 的 nodeData 初始化');
  const body = canvasSrc.slice(at, at + 320);
  assert(body.indexOf('collapsed') >= 0, 'zone 的 data 里应有 collapsed');
  assert(body.indexOf('members') < 0, '区域自己存了 members —— 两份名单迟早对不上');
  assert(body.indexOf('order') < 0, '区域自己存了 order');
});

check('折叠只改显示：setZoneCollapsed 里不出现删边 / 删节点 / 取消任务', () => {
  const body = pickBody('setZoneCollapsed');
  assert(body.indexOf('removeEdge') < 0, '折叠路径里出现了 removeEdge');
  assert(body.indexOf('cancelGenerate') < 0, '折叠路径里出现了取消生成');
  assert(body.indexOf('splice') < 0, '折叠路径里动了 nodes 数组');
  assert(body.indexOf('.result') < 0, '折叠路径里碰了生成结果');
  assert(body.indexOf('history') < 0, '折叠路径里碰了历史版本');
  assert(body.indexOf('schedule_runs') < 0, '折叠路径里碰了定时任务表');
  // 唯一的写入必须是 collapsed 本身
  const writes = body.match(/data\.[A-Za-z]+ =/g) || [];
  eq(writes.join(','), 'data.collapsed =', '折叠函数里除了 collapsed 还写了别的字段：' + writes.join(','));
});

check('区域折叠时同步「挡住的卡片都移出选区」，但不动它们的数据', () => {
  const body = pickBody('setZoneCollapsed');
  assert(body.indexOf('selection.delete(') >= 0, '折叠时没把成员移出选区');
  assert(body.indexOf('zoneMembersOf(zone)') >= 0, '没有按归属取成员');
});

check('renderNodes 靠 isHidden 跳过，而不是把节点从数组里删掉', () => {
  const at = canvasSrc.indexOf('function renderNodes()');
  const body = canvasSrc.slice(at, at + 900);
  assert(body.indexOf('if (isHidden(node)) return;') >= 0, 'renderNodes 没有按 isHidden 跳过');
  assert(body.indexOf('nodes.splice') < 0, 'renderNodes 里删了节点 —— 数据层与显示层混在一起了');
});

check('renderEdges 对隐藏端点只是 display:none，不删连线', () => {
  const at = canvasSrc.indexOf('function updateEdgePaths(');
  const body = canvasSrc.slice(at, at + 1400);
  assert(body.indexOf("item.group.style.display = 'none'") >= 0, '隐藏端点的连线应只是不画');
  assert(body.indexOf('removeEdge') < 0, '更新连线路径时删了边');
  assert(body.indexOf("item.group.style.display = ''") >= 0, '可见时应恢复绘制');
});

check('区域不是连线端点：不给端口，也不参与 addEdge', () => {
  assert(canvasSrc.indexOf('if (!isSchedule(node) && !isZone(node)) {') >= 0, '区域没被排除在端口之外');
});

check('关页面保存带上的仍是原始 w/h，不是折叠后的显示尺寸', () => {
  const at = canvasSrc.indexOf('function collectNodes()');
  const body = canvasSrc.slice(at, at + 500);
  assert(body.indexOf('w: Math.round(node.w)') >= 0, '保存用了显示尺寸 —— 折叠一次会把框永久压扁');
  assert(body.indexOf('sizeOf(') < 0, '保存路径里用了 sizeOf');
});

check('样式补齐：区域框与设置面板的类名都有对应规则', () => {
  const need = [
    '.node[data-type="zone"]',
    '.zone-head',
    '.zone-fold',
    '.zone-title',
    '.zone-count',
    '.zone-folded-note',
    '.zone-folded-note.hot',
    '.zone-panel',
    '.zone-member-list',
    '.zone-member-row',
    '.zone-member-name',
    '.zone-member-hot',
    '.zone-actions',
    '.zone-hint',
  ];
  const missing = need.filter((one) => cssSrc.indexOf(one) < 0);
  eq(missing.join(', '), '', '样式里缺这些选择器');
});

check('标题栏高度：canvas.js 的常量与 CSS 里写死的 34px 对得上', () => {
  const jsAt = canvasSrc.indexOf('const ZONE_HEAD_FALLBACK =');
  assert(jsAt >= 0, '没找到 ZONE_HEAD_FALLBACK');
  const num = Number((canvasSrc.slice(jsAt, jsAt + 60).match(/-?\d+/) || [])[0]);
  const cssAt = cssSrc.indexOf('.zone-head {');
  assert(cssAt >= 0, '没找到 .zone-head 样式');
  const cssNum = Number((cssSrc.slice(cssAt, cssAt + 200).match(/height:\s*(\d+)px/) || [])[1]);
  eq(num, cssNum, '两边的高度对不上，卡片会压住区域名或者留一条空档');
  assert(num >= 24 && num <= 48, '标题栏高度 ' + num + ' 看着不像一条标题栏');
});

check('折叠后的显示高度容得下标题栏 + 那行说明', () => {
  const at = canvasSrc.indexOf('const ZONE_COLLAPSED_H =');
  const collapsedH = Number((canvasSrc.slice(at, at + 40).match(/\d+/) || [])[0]);
  const headH = Number((canvasSrc.slice(canvasSrc.indexOf('const ZONE_HEAD_FALLBACK =')).match(/-?\d+/) || [])[0]);
  assert(collapsedH > headH, '折叠高度比标题栏还矮，说明那行「已收起 N 张」会被切掉');
  assert(collapsedH - headH >= 18, '留给说明行的高度不到 18px，字会挤在一起');
});

check('区域右键菜单四件事齐全：设置 / 折叠 / 只看 / 解散', () => {
  const at = canvasSrc.indexOf("} else if (node.type === 'zone') {");
  assert(at >= 0, '右键菜单里没有区域分支');
  const body = canvasSrc.slice(at, at + 900);
  ['区域设置…', '只看这块区域'].forEach((label) => {
    assert(body.indexOf(label) >= 0, '菜单里缺少「' + label + '」');
  });
  assert(body.indexOf('setZoneCollapsed') >= 0, '菜单里没有折叠项');
  assert(body.indexOf('dissolveZone') >= 0, '菜单里没有解散项');
});

check('空白处右键能新建区域、也能从「只看某区域」里退出来', () => {
  const at = canvasSrc.indexOf('function openCanvasMenu(');
  const body = canvasSrc.slice(at, at + 1200);
  assert(body.indexOf("createZone([], center)") >= 0, '空白右键缺少「新建区域」');
  assert(body.indexOf('soloZoneId') >= 0, '空白右键没有退出「只看某区域」的入口');
});

check('拖动落定时按中心重判归属，拖区域本身时不重判', () => {
  const at = canvasSrc.indexOf('function rezoneAfterMove(');
  assert(at >= 0, '缺少 rezoneAfterMove');
  const callAt = canvasSrc.indexOf('if (!isZone(node)) rezoneAfterMove(');
  assert(callAt >= 0, '拖动落定时没有重判归属');
  const body = canvasSrc.slice(at, at + 1200);
  assert(body.indexOf('zoneAt(') >= 0, '重判没有走几何判定');
  assert(body.indexOf('isLocked(node)') >= 0, '重判把锁定的卡片也改了归属');
});

check('删除 / 复制都把指向区域的引用一起清掉或重映射', () => {
  assert(canvasSrc.indexOf('function removeFromZone(') >= 0, '缺少「移出区域」');
  const delAt = canvasSrc.indexOf("if (host && ids.has(host)) {");
  assert(delAt >= 0, '删除卡片 / 区域时没清 zoneId，会留下指向不存在区域的编号');
  assert(canvasSrc.indexOf('function remapZoneRefs(') >= 0, '复制时没有重映射 zoneId');
});

console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
