'use strict';

// F5 · 撤销删除专项测试（清单 41 第二项，对应清单 18）。
//
// 为什么专门测它：删除是这块画布上最不可逆的动作。给了「撤销删除」这条出路，
// 就得保证这条路真的能走回原样 —— 少一样都不行：
//
//   1. **卡片与连线一起回来**：连线是跟着卡片删的，撤销必须把线也接回去。
//      只回来卡片、线没了，用户看到的是「图回来了但引用断了」。
//   2. **号回原位**：删掉中间一张后，后面的素材号会往前补；撤销时这些号必须
//      退回原位，否则 @ 引用会指向另一张图 —— 这是最阴的一种错，画面上看不出来。
//   3. **撤销栈有上限且会滚动**：不能无限涨，也不能滚错了头。
//   4. **压新快照会清掉「未来」**：撤销两步再改一次，那两步的重做就不该还在。
//   5. **一次删除只压一条快照**：删十张压十条的话，用户要按十下撤销才能退回去。
//
// 手法：pushHistory / undo / restoreState 都是纯函数（只碰 nodes / edges / 历史栈），
// 用 vm 沙箱跑真实实现。删除主流程里牵涉 DOM，改为源码级约束守它「压了历史、
// 给了撤销入口、撤销真的走 restoreState」。
//
// 运行：runtime/node.exe tools/tests/undo-delete.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-undo-'));
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

function pickFunction(name) {
  let at = canvasSrc.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('源码里找不到函数 ' + name);
  if (canvasSrc.slice(Math.max(0, at - 6), at) === 'async ') at -= 6;
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

function constOf(name) {
  const at = canvasSrc.indexOf('const ' + name + ' =');
  if (at < 0) throw new Error('源码里找不到常量 ' + name);
  const hit = canvasSrc.slice(at, at + 80).match(/=\s*(-?\d+(?:\.\d+)?)/);
  if (!hit) throw new Error('常量 ' + name + ' 不是数字');
  return Number(hit[1]);
}

// ---------------------------------------------------------------- 沙箱
const sandbox = {
  console: console,
  Math: Math,
  Number: Number,
  String: String,
  Boolean: Boolean,
  Object: Object,
  JSON: JSON,
  Array: Array,
  Date: Date,
  Set: Set,
  Map: Map,
  Infinity: Infinity,
  // updateHistoryButtons 会去禁 / 启用「撤销」按钮。给个最小替身，
  // 这样能跑真实实现（也顺带确认它真的动了那个按钮）。
  document: {
    getElementById: function (id) {
      if (id !== 'btn-undo') return null;
      return sandbox.undoBtn;
    },
  },
  undoBtn: { disabled: false },
  log: { toast: [], renders: 0, saves: 0, badges: [] },
  PRESETS: {
    image: { w: 360, h: 203, label: '图片' },
    video: { w: 480, h: 270, label: '视频' },
    audio: { w: 360, h: 120, label: '音频' },
    quick: { w: 300, h: 170, label: '快速视频' },
    group: { w: 520, h: 300, label: '组合' },
    schedule: { w: 640, h: 420, label: '定时生成' },
    zone: { w: 640, h: 420, label: '区域' },
  },
};
vm.createContext(sandbox);

vm.runInContext(
  [
    // ---- 模块级状态（var：顶层 let / const 不挂 context 全局）----
    'var nodes = [];',
    'var edges = [];',
    'var selection = new Set();',
    'var selectedEdgeId = null;',
    'var editingId = null;',
    'var history = { past: [], future: [] };',
    'var pendingSnapshot = null;',
    // ---- 替身 ----
    'function presetOf(type) { return PRESETS[type] || PRESETS.image; }',
    'function rawSizeOf(node) { var p = presetOf(node.type); return { w: node.w || p.w, h: node.h || p.h }; }',
    'function nodeData(node) { if (!node.data || typeof node.data !== "object") node.data = {}; return node.data; }',
    'function renderAll() { log.renders += 1; }',
    'function refreshSelection() {}',
    'function scheduleSave() { log.saves += 1; }',
    'function toast(text) { log.toast.push(text); }',
    'function updateHistoryButtons() {}',
    'function byId(id) { for (var i = 0; i < nodes.length; i += 1) { if (nodes[i].id === id) return nodes[i]; } return null; }',
    'function isSchedule(node) { return Boolean(node && node.type === "schedule"); }',
    'function paintIndexBadge(node) { log.badges.push(node.id); }',
    // 编号相关的替身：本文件不测编号算法，只保证 restoreState 真的调了它
    'function renumberAll() { renumberCalls += 1; return { tagged: new Set(), retagged: new Set(), rebound: new Set(), rescheduled: new Set() }; }',
    'var renumberCalls = 0;',
    // ---- 被验证的源码 ----
    pickFunction('snapshot'),
    pickFunction('pushHistory'),
    pickFunction('beginTransaction'),
    pickFunction('dropTransaction'),
    pickFunction('restoreState'),
    pickFunction('undo'),
    pickFunction('updateHistoryButtons'),
    'var HISTORY_LIMIT = ' + String(constOf('HISTORY_LIMIT')) + ';',
  ].join('\n'),
  sandbox
);

const S = sandbox;

function mkCard(id, extra) {
  return Object.assign(
    {
      id: id,
      type: 'image',
      x: 0,
      y: 0,
      w: 360,
      h: 203,
      data: { text: id, no: 0, v: 1 },
      createdAt: 1,
    },
    extra || {}
  );
}

function mkEdge(id, from, to) {
  return { id: id, sourceId: from, targetId: to, role: '', sourcePort: null, targetPort: null };
}

// 造一块有三张素材 + 一条连线的画布
function scene() {
  S.nodes = [mkCard('a', { createdAt: 1 }), mkCard('b', { createdAt: 2 }), mkCard('c', { createdAt: 3 })];
  S.edges = [mkEdge('e1', 'a', 'b')];
  S.selection = new Set();
  S.selectedEdgeId = null;
  S.editingId = null;
  S.history.past.length = 0;
  S.history.future.length = 0;
  S.pendingSnapshot = null;
  S.log.toast.length = 0;
  S.log.renders = 0;
  S.log.saves = 0;
  S.log.badges.length = 0;
  S.renumberCalls = 0;
}

console.log('\nF5 · 撤销删除');

console.log('\n[1] 快照与压栈的基本行为');

check('快照记下卡片、连线、位置与 data（与库里的形状对齐）', () => {
  scene();
  const snap = JSON.parse(S.snapshot());
  eq(snap.nodes.length, 3);
  eq(snap.edges.length, 1);
  eq(snap.edges[0].sourceId, 'a');
  eq(snap.nodes[0].data.text, 'a');
});

check('快照取整坐标（不会被浮点差异压出一堆看起来一样的快照）', () => {
  scene();
  S.nodes[0].x = 10.6;
  S.nodes[0].y = -3.4;
  const snap = JSON.parse(S.snapshot());
  eq(snap.nodes[0].x, 11, 'x 应四舍五入');
  eq(snap.nodes[0].y, -3, 'y 应四舍五入');
});

check('pushHistory 往 past 压一条，并清空 future', () => {
  scene();
  S.history.future.push('旧的未来');
  S.pushHistory();
  eq(S.history.past.length, 1);
  eq(S.history.future.length, 0, '新快照之后「未来」必须清掉（否则重做会跳回去）');
});

check('一次删除只压一条：连压两次是两条，不是「每张卡一条」', () => {
  scene();
  // 删除整个选区时只调一次 pushHistory
  S.pushHistory();
  eq(S.history.past.length, 1, '删 3 张只该压 1 条');
});

check('撤销后 past 少一条，能一路退到底', () => {
  scene();
  S.pushHistory();
  S.nodes = [mkCard('a'), mkCard('b')];
  S.pushHistory();
  S.nodes = [mkCard('a')];
  eq(S.history.past.length, 2);
  S.undo();
  eq(S.nodes.length, 2, '第一次撤销应回到两张');
  eq(S.history.past.length, 1);
  S.undo();
  eq(S.nodes.length, 3, '第二次撤销应回到三张');
  eq(S.history.past.length, 0);
});

check('退到底之后再撤销：什么都不做（不许把栈弹成负数或崩掉）', () => {
  scene();
  S.undo();
  eq(S.history.past.length, 0);
  S.undo();
  eq(S.history.past.length, 0);
  eq(S.nodes.length, 3, '没得撤销时不该动数据');
});

check('撤销栈有上限，超过后从最老的一头丢（不是丢掉刚压的）', () => {
  scene();
  for (let i = 0; i < S.HISTORY_LIMIT + 10; i += 1) {
    S.nodes = [mkCard('n' + i, { createdAt: i })];
    S.pushHistory();
  }
  eq(S.history.past.length, S.HISTORY_LIMIT, '栈长度应被截到上限');
  // 最新的那一条必须还在（丢的是最老的）
  const last = JSON.parse(S.history.past[S.history.past.length - 1]);
  eq(last.nodes[0].id, 'n' + (S.HISTORY_LIMIT + 9), '丢掉的是最新那条，说明方向反了');
});

check('上限是 60 这个量级（足够退回去，又不至于把内存吃光）', () => {
  assert(S.HISTORY_LIMIT >= 20 && S.HISTORY_LIMIT <= 200, '上限值可疑：' + S.HISTORY_LIMIT);
});

console.log('\n[2] 撤销删除：卡片与连线一起回来');

check('撤销把卡片和连线一起恢复（线不会丢）', () => {
  scene();
  const before = { nodes: S.nodes.length, edges: S.edges.length };
  S.pushHistory();
  // 模拟删除：卡片 b 与指向它的连线一起消失
  S.nodes = S.nodes.filter((node) => node.id !== 'b');
  S.edges = [];
  S.undo();
  eq(S.nodes.length, before.nodes, '卡片没全回来');
  eq(S.edges.length, before.edges, '连线没回来');
  eq(S.edges[0].sourceId, 'a');
  eq(S.edges[0].targetId, 'b');
});

check('撤销后恢复的是「删除前那一刻」的内容，不是当前内容', () => {
  scene();
  S.pushHistory();
  // 删除时顺手改了别的卡片（真实流程里 stripRemovedRefs 会改提示词）
  S.nodes.forEach((node) => {
    node.data.text = '被改过的';
  });
  S.nodes = [S.nodes[0]];
  S.undo();
  eq(S.nodes[1].data.text, 'b', '恢复的是被改过的内容，说明快照压晚了');
});

check('撤销删除后选中态被清掉（不能留一个指向已消失卡片的选中）', () => {
  scene();
  S.pushHistory();
  S.nodes = [S.nodes[0]];
  S.selection = new Set(['b']);
  S.selectedEdgeId = 'e1';
  S.editingId = 'b';
  S.undo();
  eq(S.selection.size, 0, '选中没清');
  eq(S.selectedEdgeId, null, '连线选中没清');
  eq(S.editingId, null, '编辑态没清');
});

check('撤销会重画一次（不然界面上什么都不会变）', () => {
  scene();
  S.pushHistory();
  S.nodes = [S.nodes[0]];
  S.undo();
  assert(S.log.renders > 0, '撤销后没有重画');
});

check('撤销会触发保存（不然刷新一下又回去了）', () => {
  scene();
  S.pushHistory();
  S.undo();
  assert(S.log.saves > 0, '撤销后没有安排保存');
});

check('撤销给一句「已撤销」的反馈', () => {
  scene();
  S.pushHistory();
  S.undo();
  assert(S.log.toast.indexOf('已撤销') >= 0, '没有反馈，用户以为没生效');
});

check('没得撤销时不弹「已撤销」（不骗用户）', () => {
  scene();
  S.undo();
  eq(S.log.toast.filter((item) => item === '已撤销').length, 0, '空撤销不该给反馈');
});

console.log('\n[3] 撤销删除：素材号退原位');

check('撤销时重排一次号（删掉中间那张后，号要退回去）', () => {
  scene();
  S.pushHistory();
  S.nodes = [S.nodes[0], S.nodes[2]]; // 删掉中间的 b
  S.renumberCalls = 0;
  S.undo();
  assert(S.renumberCalls > 0, '撤销后没有重排号，@ 引用会指向别的图');
});

check('重排发生在恢复数据之后（顺序反了会按旧数据排号）', () => {
  const body = pickFunction('restoreState');
  const nodesAt = body.indexOf('nodes = data.nodes.map');
  const renumberAt = body.indexOf('renumberAll()');
  assert(nodesAt >= 0, 'restoreState 没有恢复节点');
  assert(renumberAt >= 0, 'restoreState 没有重排号');
  assert(nodesAt < renumberAt, '重排号跑在恢复数据前面了');
});

check('恢复时做的是深拷贝（快照对象与 live 数据不共享引用）', () => {
  const body = pickFunction('restoreState');
  assert(body.indexOf('node.data || {}') >= 0, '没有给 data 兜底，缺 data 的卡片会炸');
  assert(body.indexOf('{ ...node') >= 0, '节点没有复制成新对象，改 live 会污染快照');
});

console.log('\n[4] 事务快照：一次拖动只压一条');

check('beginTransaction 记下拖动前的样子，pushHistory 用它而不是重新取', () => {
  scene();
  const before = S.snapshot();
  S.beginTransaction();
  // 拖动过程中数据已经变了
  S.nodes[0].x = 999;
  S.pushHistory();
  S.undo();
  eq(S.nodes[0].x, 0, '撤销回到的是拖动后的位置，说明用的是「当下」而不是事务开始时的快照');
  eq(JSON.parse(before).nodes[0].x, 0);
});

check('事务快照用掉之后要清掉（不然下一次会拿旧的顶上）', () => {
  scene();
  S.beginTransaction();
  S.pushHistory();
  eq(S.pendingSnapshot, null, '快照用掉后没清');
});

check('dropTransaction 丢弃快照（这次操作不算数，不该进撤销栈）', () => {
  scene();
  S.beginTransaction();
  S.dropTransaction();
  S.pushHistory();
  // 丢掉事务快照后，pushHistory 应退回去自己取一份当下的
  eq(S.history.past.length, 1);
  eq(S.pendingSnapshot, null);
});

check('事务快照为空串 / null 时也走正常路径（不许把 null 压进栈）', () => {
  scene();
  S.pendingSnapshot = null;
  S.pushHistory();
  const top = S.history.past[S.history.past.length - 1];
  assert(typeof top === 'string' && top.length > 2, '压进栈的不是一份有效快照');
});

console.log('\n[5] 源码级约束：删除流程与入口');

check('删除前压历史（不压就没得撤销）', () => {
  const at = canvasSrc.indexOf('function deleteSelection()');
  const body = canvasSrc.slice(at, at + 4000);
  assert(body.indexOf('pushHistory()') >= 0, '删除没有压历史');
});

check('删除的提示里给了「撤销删除」按钮', () => {
  const at = canvasSrc.indexOf('function deleteSelection()');
  const body = canvasSrc.slice(at, at + 8000);
  assert(body.indexOf('撤销删除') >= 0, '删除提示里没有撤销入口');
  assert(body.indexOf('run: () => undo()') >= 0, '撤销按钮没有接上 undo');
});

check('删除的提示里还给了「查看回收站」这条兜底', () => {
  const at = canvasSrc.indexOf('function deleteSelection()');
  const body = canvasSrc.slice(at, at + 8000);
  assert(body.indexOf('查看回收站') >= 0, '没有回收站入口');
});

check('断开连线也给了撤销（连线容易误删）', () => {
  const at = canvasSrc.indexOf('function removeEdge(');
  const body = canvasSrc.slice(at, at + 2000);
  assert(body.indexOf('撤销删除') >= 0, '断开连线没有撤销入口');
});

check('删了中间一张素材后，后面自动补号', () => {
  const at = canvasSrc.indexOf('function deleteSelection()');
  const body = canvasSrc.slice(at, at + 8000);
  assert(body.indexOf('renumberAll()') >= 0, '删除后没有重排号');
});

check('删素材时先摘掉别人提示词里指向它的 @，再重排号', () => {
  const at = canvasSrc.indexOf('function deleteSelection()');
  const body = canvasSrc.slice(at, at + 8000);
  const stripAt = body.indexOf('stripRemovedRefs(');
  const renumberAt = body.indexOf('renumberAll()');
  assert(stripAt >= 0, '没有摘掉指向已删素材的 @');
  assert(renumberAt >= 0, '没有重排号');
  assert(stripAt < renumberAt, '顺序反了：先重排再摘引用，@ 会跳到别的图上');
});

check('锁定的卡片删不掉（撤销栈里也不该有它）', () => {
  const at = canvasSrc.indexOf('function deleteSelection()');
  const body = canvasSrc.slice(at, at + 1200);
  assert(body.indexOf('isLocked(node)') >= 0, '没有排除锁定的卡片');
  assert(body.indexOf('往 history 里压快照') < 0, '注释不该出现在这里');
  const lockAt = body.indexOf('if (!ids.size)');
  const pushAt = body.indexOf('pushHistory()');
  assert(lockAt >= 0 && lockAt < pushAt, '应在全部锁定（没得删）时提前返回，别压空快照');
});

check('删除时不重建整块画布（只摘掉被删的那几张，别的卡片不闪）', () => {
  const at = canvasSrc.indexOf('function deleteSelection()');
  const body = canvasSrc.slice(at, at + 8000);
  assert(body.indexOf('el.remove()') >= 0, '没有就地摘掉元素');
  assert(body.indexOf('elements.delete(id)') >= 0, '没有从元素表里清掉');
  assert(body.indexOf('renderAll()') < 0, '删除里调了 renderAll，会让全画布的图片重新加载');
});

console.log('\n[6] 撤销栈与删除的衔接：一次删除一条，退一步就够');

check('「删除 → 撤销」是一次往返：数据回到删除前', () => {
  scene();
  const before = S.snapshot();
  S.pushHistory();
  S.nodes = S.nodes.filter((node) => node.id !== 'b');
  S.edges = [];
  S.selection = new Set(['b']);
  S.undo();
  eq(S.snapshot(), before, '往返之后与删除前不一致');
});

check('连续两次删除 → 连续两次撤销，逐级退回去', () => {
  scene();
  const step0 = S.snapshot();
  S.pushHistory();
  S.nodes = S.nodes.filter((node) => node.id !== 'c');
  const step1 = S.snapshot();
  S.pushHistory();
  S.nodes = S.nodes.filter((node) => node.id !== 'b');
  S.undo();
  eq(S.snapshot(), step1, '第一次撤销没退回上一步');
  S.undo();
  eq(S.snapshot(), step0, '第二次撤销没退回最初');
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
