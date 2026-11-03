'use strict';

// F5 · 参考素材编号变化专项测试（清单 41 第四项）。
//
// 素材号（图1 / 视频2 / 音频1 / 快速视频1）是这块画布上最容易出错、又最难发现
// 的一处：号本身只是显示，但提示词里的 @[图3]、快速视频的 quickRefs、
// 定时组快照里冻着的文字，全都靠这个号互相指认。号一乱，画面上看不出异常，
// 用户下次生成才发现「用的不是这张图」。
//
// 这个文件守五件事：
//
//   1. **连续不留空号**：同类素材按建卡先后排成 1..N。删掉中间一张，后面的往前补。
//   2. **连环换号不许边算边写**：图2→图1、图3→图2 这种换法，如果边算边写回，
//      会出现「一张图被换两次」。必须先算完所有新旧号，再整体替换。
//   3. **@ 引用跟着素材走**：换号时提示词里的 @[旧号] 要改成新号，
//      这样用户写的「照着 @[图2] 做」始终指着原来那张图。
//   4. **快速视频单独一套号**，不与普通「视频N」混用；它的 quickRefs 是
//      「编号 → 卡片」的映射，换号时钥匙要跟着换。
//   5. **定时组快照里冻着的文字也要换**：不然下次到点跑的还是旧号那批素材。
//
// 手法：renumberAll / stripRemovedRefs 是纯函数（只碰 nodes），用 vm 沙箱跑真实实现。
//
// 运行：runtime/node.exe tools/tests/material-number.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-number-'));
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
  log: { badges: [] },
  PRESETS: {
    image: { w: 360, h: 203, label: '图片' },
    video: { w: 480, h: 270, label: '视频' },
    audio: { w: 360, h: 120, label: '音频' },
    quick: { w: 300, h: 170, label: '快速视频' },
    schedule: { w: 640, h: 420, label: '定时生成' },
  },
};
vm.createContext(sandbox);

vm.runInContext(
  [
    'var nodes = [];',
    // ---- 替身 ----
    'function isSchedule(node) { return Boolean(node && node.type === "schedule"); }',
    'function presetOf(type) { return PRESETS[type] || PRESETS.image; }',
    'function paintIndexBadge(node) { log.badges.push(node.id); }',
    // ---- 被验证的源码 ----
    "var KIND_LABEL = { image: '图', video: '视频', audio: '音频', quick: '快速视频' };",
  ].join('\n'),
  sandbox
);

// nodeData：源码里那份会顺带补很多字段，这里只要「拿到一个对象」的语义就够
vm.runInContext(
  'function nodeData(node) { if (!node.data || typeof node.data !== "object") node.data = {}; return node.data; }',
  sandbox
);
vm.runInContext(
  [
    pickFunction('materialKindOf'),
    pickFunction('numberKindOf'),
    pickFunction('mediaKindOf'),
    pickFunction('tagOf'),
    pickFunction('renumberAll'),
    pickFunction('stripRemovedRefs'),
  ].join('\n'),
  sandbox
);

const S = sandbox;

function mk(id, type, opts) {
  const o = opts || {};
  return {
    id: id,
    type: type,
    x: 0,
    y: 0,
    w: 360,
    h: 203,
    data: { text: o.text || '', no: o.no === undefined ? 0 : o.no, v: 1 },
    createdAt: o.at === undefined ? 100 : o.at,
  };
}

function nos() {
  const out = {};
  S.nodes.forEach((node) => {
    const tag = S.tagOf(node);
    if (tag) out[node.id] = tag;
  });
  return out;
}

function textOf(id) {
  return S.nodes.find((node) => node.id === id).data.text;
}

console.log('\nF5 · 参考素材编号变化');

console.log('\n[1] 种类判定：快速视频自己一类');

check('materialKindOf 只认 image / video / audio', () => {
  eq(S.materialKindOf(mk('a', 'image')), 'image');
  eq(S.materialKindOf(mk('b', 'video')), 'video');
  eq(S.materialKindOf(mk('c', 'audio')), 'audio');
  eq(S.materialKindOf(mk('d', 'group')), '', '组合不是素材');
  eq(S.materialKindOf(mk('e', 'schedule')), '', '定时组不是素材');
  eq(S.materialKindOf(null), '');
});

check('numberKindOf：快速视频算 quick 一类（不跟视频混号）', () => {
  eq(S.numberKindOf(mk('a', 'quick')), 'quick');
  eq(S.numberKindOf(mk('b', 'video')), 'video');
});

check('mediaKindOf：送去接口时快速视频按视频处理', () => {
  eq(S.mediaKindOf(mk('a', 'quick')), 'video', '快速视频送接口时应算视频');
  eq(S.numberKindOf(mk('a', 'quick')), 'quick', '但编号仍算自己一类');
});

check('tagOf 用「种类简称 + 号」拼出显示名', () => {
  eq(S.tagOf(mk('a', 'image', { no: 1 })), '图1');
  eq(S.tagOf(mk('b', 'video', { no: 2 })), '视频2');
  eq(S.tagOf(mk('c', 'audio', { no: 3 })), '音频3');
  eq(S.tagOf(mk('d', 'quick', { no: 4 })), '快速视频4');
});

check('号是 0 / 没设 / 坏值时不给出显示名（不许显示「图0」）', () => {
  eq(S.tagOf(mk('a', 'image', { no: 0 })), '');
  eq(S.tagOf(mk('a', 'image', { no: -1 })), '');
  eq(S.tagOf({ id: 'x', type: 'image', data: { no: '乱写' } }), '');
  eq(S.tagOf(mk('a', 'group', { no: 1 })), '', '不是素材就不该有号');
});

console.log('\n[2] 连续不留空号');

check('同类按建卡先后排成 1..N', () => {
  S.nodes = [mk('a', 'image', { at: 300 }), mk('b', 'image', { at: 100 }), mk('c', 'image', { at: 200 })];
  S.renumberAll();
  eq(S.nodes.find((n) => n.id === 'b').data.no, 1, '最早建的应是 1');
  eq(S.nodes.find((n) => n.id === 'c').data.no, 2);
  eq(S.nodes.find((n) => n.id === 'a').data.no, 3, '最晚建的应是 3');
});

check('不同种类各排各的（图1 与 视频1 可以同时存在）', () => {
  S.nodes = [mk('a', 'image', { at: 100 }), mk('b', 'video', { at: 200 }), mk('c', 'image', { at: 300 })];
  S.renumberAll();
  eq(S.tagOf(S.nodes[0]), '图1');
  eq(S.tagOf(S.nodes[1]), '视频1');
  eq(S.tagOf(S.nodes[2]), '图2');
});

check('删掉中间一张后，后面的号往前补（不留空号）', () => {
  S.nodes = [mk('a', 'image', { at: 100, no: 1 }), mk('b', 'image', { at: 200, no: 2 }), mk('c', 'image', { at: 300, no: 3 })];
  S.nodes = S.nodes.filter((node) => node.id !== 'b'); // 删中间的
  S.renumberAll();
  eq(S.nodes[0].data.no, 1);
  eq(S.nodes[1].data.no, 2, '原来的图3应补成图2');
});

check('建卡时间一样时按画布里的顺序决定先后（不许出现并列号）', () => {
  S.nodes = [mk('a', 'image', { at: 100, no: 9 }), mk('b', 'image', { at: 100, no: 9 }), mk('c', 'image', { at: 100, no: 9 })];
  S.renumberAll();
  const seen = S.nodes.map((node) => node.data.no).sort();
  eq(seen.join(','), '1,2,3', '时间相同时应按数组顺序排开');
});

check('没号的卡片（新建的）会被排上号', () => {
  S.nodes = [mk('a', 'image', { at: 100 })];
  S.renumberAll();
  eq(S.nodes[0].data.no, 1);
});

console.log('\n[3] 连环换号：先算完再写，不许换两次');

check('图2→图1、图3→图2 的连环换号结果正确', () => {
  // 删掉图1 后，原来的图2 / 图3 要整体前移
  S.nodes = [mk('b', 'image', { at: 200, no: 2 }), mk('c', 'image', { at: 300, no: 3 })];
  S.renumberAll();
  eq(S.nodes[0].data.no, 1, '原来的图2 应变成图1');
  eq(S.nodes[1].data.no, 2, '原来的图3 应变成图2');
});

check('三张一起前移也不会互相踩（不许出现两张同号）', () => {
  S.nodes = [
    mk('b', 'image', { at: 200, no: 2 }),
    mk('c', 'image', { at: 300, no: 3 }),
    mk('d', 'image', { at: 400, no: 4 }),
  ];
  S.renumberAll();
  const seen = S.nodes.map((node) => node.data.no).sort();
  eq(seen.join(','), '1,2,3', '出现了重号或漏号：' + seen.join(','));
});

check('已经排好的再排一次不变（幂等，删除只改标记不闪图）', () => {
  // 两张都没号：第一次会排上 1 / 2
  S.nodes = [mk('a', 'image', { at: 100 }), mk('b', 'image', { at: 200 })];
  const first = S.renumberAll();
  eq(first.tagged.size, 2, '第一次应把两张都排上号');
  eq(S.nodes.map((node) => node.data.no).join(','), '1,2');
  const second = S.renumberAll();
  eq(second.tagged.size, 0, '第二次不该再有变化');
});

check('号没变时不重画序号牌（避免无谓的界面抖动）', () => {
  S.nodes = [mk('a', 'image', { at: 100, no: 1 })];
  const out = S.renumberAll();
  eq(out.tagged.size, 0, '号本来就对，不该报告成变化');
});

check('报告回来的 tagged 只含真正换过号的卡片', () => {
  S.nodes = [mk('a', 'image', { at: 100, no: 1 }), mk('b', 'image', { at: 200, no: 9 })];
  const out = S.renumberAll();
  eq(out.tagged.size, 1, '只该有一张换号');
  assert(out.tagged.has('b'), '换号的应是 b');
});

console.log('\n[4] @ 引用跟着素材走');

check('提示词里的 @[旧号] 跟着改成新号', () => {
  S.nodes = [
    mk('p', 'group', { at: 50, text: '照着 @[图2] 做一张' }),
    mk('b', 'image', { at: 200, no: 2 }),
  ];
  S.renumberAll();
  eq(textOf('p'), '照着 @[图1] 做一张', '@ 没跟着换号');
  eq(S.nodes[1].data.no, 1);
});

check('@ 一次扫完统一换（不出现改了又改）', () => {
  S.nodes = [
    mk('p', 'group', { at: 50, text: '@[图2] 和 @[图3] 各来一张' }),
    mk('b', 'image', { at: 200, no: 2 }),
    mk('c', 'image', { at: 300, no: 3 }),
  ];
  S.renumberAll();
  eq(textOf('p'), '@[图1] 和 @[图2] 各来一张');
});

check('指向没换号的素材的 @ 原样不动', () => {
  S.nodes = [
    mk('p', 'group', { at: 50, text: '照着 @[图1] 做' }),
    mk('b', 'image', { at: 200, no: 1 }),
  ];
  const out = S.renumberAll();
  eq(textOf('p'), '照着 @[图1] 做');
  eq(out.retagged.size, 0, '没换号却报告改了提示词');
});

check('换过 @ 的卡片被报在 retagged 里（调用方据此只重画这几张）', () => {
  S.nodes = [
    mk('p', 'group', { at: 50, text: '@[图2] 来做' }),
    mk('b', 'image', { at: 200, no: 2 }),
  ];
  const out = S.renumberAll();
  assert(out.retagged.has('p'), 'retagged 没报出提示词被改的卡片');
});

check('不同种类的 @ 不会串（@[视频1] 不会被图1 的换号影响）', () => {
  S.nodes = [
    mk('p', 'group', { at: 50, text: '@[视频1] 和 @[图2]' }),
    mk('b', 'image', { at: 200, no: 2 }),
    mk('v', 'video', { at: 300, no: 1 }),
  ];
  S.renumberAll();
  eq(textOf('p'), '@[视频1] 和 @[图1]', '视频号不该被图的换号带跑');
});

check('引用者自己也在换号时，它的 @ 按新号处理（连环场景）', () => {
  // 真实里很常见：一张图片卡的提示词里引用了另一张图，而它自己也在换号队列里。
  // b 排在前面拿到 1，p 从图1 变成图2；p 里写的 @[图2] 指的是 b，
  // 应跟着 b 的新号改成 @[图1]，而不是因为 p 自己变成了图2 就误判。
  S.nodes = [mk('b', 'image', { at: 200, no: 2 }), mk('p', 'image', { at: 500, no: 1, text: '照着 @[图2] 画' })];
  S.renumberAll();
  eq(S.nodes[0].data.no, 1, 'b 应排到 1');
  eq(S.nodes[1].data.no, 2, 'p 应排到 2');
  eq(textOf('p'), '照着 @[图1] 画', '@ 没跟着被引用的那张换号');
});

console.log('\n[5] 快速视频的 quickRefs：换钥匙');

check('quickRefs 的钥匙跟着素材的新号换', () => {
  S.nodes = [
    mk('q', 'quick', { at: 50 }),
    mk('b', 'image', { at: 200, no: 2 }),
  ];
  S.nodes[0].data.quickRefs = { 图2: 'b' };
  const out = S.renumberAll();
  eq(JSON.stringify(S.nodes[0].data.quickRefs), JSON.stringify({ 图1: 'b' }), '钥匙没换过来');
  assert(out.rebound.has('q'), 'rebound 没报出绑定关系变了的卡片');
});

check('quickRefs 指向已删卡片时顺手清掉（不留死键）', () => {
  S.nodes = [mk('q', 'quick', { at: 50 })];
  S.nodes[0].data.quickRefs = { 图1: '已经删掉的卡片' };
  S.renumberAll();
  eq(S.nodes[0].data.quickRefs, undefined, '死键没清掉');
});

check('清空之后把 quickRefs 整个删掉（不留一个空对象）', () => {
  S.nodes = [mk('q', 'quick', { at: 50 })];
  S.nodes[0].data.quickRefs = { 图1: '不在了', 图2: '也不在了' };
  S.renumberAll();
  assert(!Object.prototype.hasOwnProperty.call(S.nodes[0].data, 'quickRefs'), '留了个空对象');
});

check('绑定关系没变时不报告 rebound（避免无谓重画）', () => {
  S.nodes = [mk('q', 'quick', { at: 50 }), mk('b', 'image', { at: 200, no: 1 })];
  S.nodes[0].data.quickRefs = { 图1: 'b' };
  const out = S.renumberAll();
  eq(out.rebound.size, 0, '关系没变却报成了变化');
});

check('快速视频不掺和普通视频的号（各排各的）', () => {
  S.nodes = [mk('q1', 'quick', { at: 100 }), mk('v1', 'video', { at: 200 }), mk('q2', 'quick', { at: 300 })];
  S.renumberAll();
  eq(S.tagOf(S.nodes[0]), '快速视频1');
  eq(S.tagOf(S.nodes[1]), '视频1', '普通视频该是视频1，不是视频2');
  eq(S.tagOf(S.nodes[2]), '快速视频2');
});

console.log('\n[6] 定时组快照里冻着的文字也要换号');

check('快照的 prompt 里 @图2 跟着换', () => {
  S.nodes = [
    mk('s', 'schedule', { at: 50 }),
    mk('b', 'image', { at: 200, no: 2 }),
  ];
  S.nodes[0].data.members = ['b'];
  S.nodes[0].data.schedule = { snapshots: { b: { prompt: '照着 @图2 做一段', promptRaw: '照着 @[图2] 做一段' } } };
  const out = S.renumberAll();
  const snap = S.nodes[0].data.schedule.snapshots[S.nodes[1].id];
  eq(snap.prompt, '照着 @图1 做一段', '给人看的写法没换号');
  eq(snap.promptRaw, '照着 @[图1] 做一段', '内部写法没换号');
  assert(out.rescheduled.has('s'), 'rescheduled 没报出定时组');
});

check('快照里没有 @ 时不动它（也不报告变化）', () => {
  S.nodes = [mk('s', 'schedule', { at: 50 }), mk('b', 'image', { at: 200, no: 9 })];
  S.nodes[0].data.schedule = { snapshots: { b: { prompt: '就是一段普通文字', promptRaw: '就是一段普通文字' } } };
  const out = S.renumberAll();
  eq(S.nodes[0].data.schedule.snapshots.b.prompt, '就是一段普通文字');
  eq(out.rescheduled.size, 0, '没 @ 却报成了变化');
});

console.log('\n[7] 删素材：先摘引用，再重排');

check('stripRemovedRefs 把指向已删素材的 @[图1] 摘干净', () => {
  S.nodes = [mk('p', 'group', { at: 50, text: '用 @[图1] 和 @[图2] 合成' })];
  const changed = S.stripRemovedRefs(new Set(['图1']));
  // 摘掉 @[图1] 后原位留下两个空格，tidy 把「两个及以上」收成一个
  eq(textOf('p'), '用 和 @[图2] 合成', '没摘干净');
  assert(changed.has('p'), '没报告哪张改过');
});

check('摘掉 @ 后残留的多余空格收成一个，首尾也去掉', () => {
  S.nodes = [mk('p', 'group', { at: 50, text: '  用  @[图1]  做  ' })];
  S.stripRemovedRefs(new Set(['图1']));
  eq(textOf('p'), '用 做', '空格没收好：' + JSON.stringify(textOf('p')));
});

check('给人看的写法 @图1 也一起摘（定时组快照里存的是这种）', () => {
  S.nodes = [mk('s', 'schedule', { at: 50 })];
  S.nodes[0].data.schedule = { snapshots: { m: { prompt: '照着 @图1 做', promptRaw: '照着 @[图1] 做' } } };
  S.stripRemovedRefs(new Set(['图1']));
  // 两侧空格收成一个后还剩一个（tidy 只合并「两个及以上」）
  eq(S.nodes[0].data.schedule.snapshots.m.prompt, '照着 做');
  eq(S.nodes[0].data.schedule.snapshots.m.promptRaw, '照着 做');
});

check('没被删的号不受影响（不许误伤）', () => {
  S.nodes = [mk('p', 'group', { at: 50, text: '@[图1] 和 @[图2]' })];
  const changed = S.stripRemovedRefs(new Set(['图3']));
  eq(textOf('p'), '@[图1] 和 @[图2]');
  eq(changed.size, 0, '没删任何相关的号却报告了变化');
});

check('要摘的号为空时直接返回（不做无用的全画布扫描）', () => {
  S.nodes = [mk('p', 'group', { at: 50, text: '@[图1]' })];
  const changed = S.stripRemovedRefs(new Set());
  eq(changed.size, 0);
  eq(textOf('p'), '@[图1]', '空集合不该改任何东西');
});

check('摘引用发生在重排之前（顺序反了 @ 会跳到别的图上）', () => {
  const at = canvasSrc.indexOf('function deleteSelection()');
  const body = canvasSrc.slice(at, at + 8000);
  const stripAt = body.indexOf('stripRemovedRefs(removedTags)');
  const renumberAt = body.indexOf('renumberAll()');
  assert(stripAt >= 0, '删除里没有摘引用');
  assert(renumberAt >= 0, '删除里没有重排');
  assert(stripAt < renumberAt, '顺序反了');
});

check('被删素材的原号在重排前先收集起来（不然摘不到）', () => {
  const at = canvasSrc.indexOf('function deleteSelection()');
  const body = canvasSrc.slice(at, at + 8000);
  assert(body.indexOf('removedTags') >= 0, '没有收集被删素材的号');
  const collectAt = body.indexOf('removedTags');
  const stripAt = body.indexOf('stripRemovedRefs(removedTags)');
  assert(collectAt < stripAt, '收集跑在摘引用之后了');
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
