'use strict';

// D3 快速定位的隔离测试（清单 22）。
//
// 这里测两类东西：
//  1. 纯函数 —— 缩放算得对不对、挑「最新那张」挑得对不对、时间文案对不对。
//     前端是 IIFE，函数取不出来，所以用「源码片段提取 + 在沙箱里跑」的办法，
//     跟 batch-rename.test.js 是同一套手法。
//  2. 源码级约束 —— 三个入口都接上了、没得跳的时候是置灰而不是静默失败、
//     按钮和计数徽章都在、样式补齐。
//
// 运行：runtime/node.exe tools/tests/locate.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

// 隔离：本测试只跑纯函数，不碰数据库，仍走统一助手保持范式一致
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-locate-'));
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
function near(got, want, tol, msg) {
  if (Math.abs(got - want) > (tol || 0.001)) {
    throw new Error((msg || '值不够接近') + '：拿到 ' + got + '，期望约 ' + want);
  }
}

const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'web', 'canvas.html'), 'utf8');
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

// ---------------------------------------------------------------- 沙箱
//
// 把定位相关的纯函数放进一个沙箱跑。它们依赖的 nodeData / clamp / 常量
// 用简单替身补上 —— 替身跟生产代码的语义保持一致，改坏了测试会先红。
const sandbox = {
  nodes: [],
  toastCalls: [],
  timeTextOf: (ms) => new Date(ms).toISOString().slice(0, 10),
  // 每张卡片的显示尺寸由卡片自己说（测试里显式给），默认 100x100
  sizeOf: (node) => ({ w: Number(node.w) || 100, h: Number(node.h) || 100 }),
  MIN_ZOOM: 0.1,
  MAX_ZOOM: 4,
  Date: Date,
  Math: Math,
  Number: Number,
  String: String,
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
    'function nodeData(node) { return node.data || (node.data = {}); }',
    'function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }',
    pickFunction('boundsOfNodes'),
    pickFunction('fitTransformOf'),
    pickFunction('newestBy'),
    pickFunction('touchedAtOf'),
    pickFunction('finishedAtOf'),
    pickFunction('cardSignature'),
    pickFunction('stampTouchedCards'),
    pickFunction('sinceTextOf'),
    pickFunction('clipText'),
    // stampTouchedCards 依赖模块级的这两个变量。这里必须用 var ——
    // 顶层 let 不会挂到 context 的全局对象上，测试就取不到了。
    'var touchSignatures = new Map();',
    'var touchBaselineReady = false;',
  ].join('\n'),
  sandbox
);

const S = sandbox;

console.log('\nD3 · 外接矩形与缩放（从源码里取出来跑）');

check('空列表返回 null（调用方据此 fallback，而不是算出个 NaN）', () => {
  eq(S.boundsOfNodes([]), null);
  eq(S.boundsOfNodes(null), null);
  eq(S.boundsOfNodes([null, undefined]), null);
});

check('单张卡片的外接矩形就是它自己', () => {
  const b = S.boundsOfNodes([{ x: 10, y: 20, w: 200, h: 120 }]);
  eq(b.minX, 10);
  eq(b.minY, 20);
  eq(b.maxX, 210);
  eq(b.maxY, 140);
  eq(b.w, 200);
  eq(b.h, 120);
});

check('多张卡片取并集（含负坐标，画布左侧/上方是负的）', () => {
  const b = S.boundsOfNodes([
    { x: -300, y: -50, w: 100, h: 100 },
    { x: 500, y: 400, w: 100, h: 100 },
  ]);
  eq(b.minX, -300);
  eq(b.minY, -50);
  eq(b.maxX, 600);
  eq(b.maxY, 500);
  eq(b.w, 900);
  eq(b.h, 550);
});

check('尺寸为 0 的卡片不把矩形搞成 0 宽（w/h 保底为 1）', () => {
  // 替身 sizeOf 对 0 会兜底成 100，这里用 measure 直接喂 0 才试得到那个保底
  const b = S.boundsOfNodes([{ x: 0, y: 0 }], () => ({ w: 0, h: 0 }));
  eq(b.w, 1);
  eq(b.h, 1);
});

check('measure 可替换（测试替身用它注入尺寸）', () => {
  const b = S.boundsOfNodes([{ x: 0, y: 0 }], () => ({ w: 40, h: 30 }));
  eq(b.w, 40);
  eq(b.h, 30);
});

check('刚好框住：宽扁的一批卡片，缩放由宽度决定', () => {
  // 1000x100 的矩形放进 800x600 可视区（padding 50）
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 100, w: 1000, h: 100 };
  const t = S.fitTransformOf(bounds, { w: 800, h: 600 }, 50);
  // 可用宽 = 800-100 = 700，可用高 = 600-100 = 500
  // 宽需要 0.7，高需要 5 → 取小的 0.7
  near(t.zoom, 0.7, 0.0001, '缩放应为 0.7');
});

check('刚好框住：瘦高的一批卡片，缩放由高度决定', () => {
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 1000, w: 100, h: 1000 };
  const t = S.fitTransformOf(bounds, { w: 800, h: 600 }, 50);
  near(t.zoom, 0.5, 0.0001, '缩放应为 0.5');
});

check('刚好框住之后，内容居中（左右留白相等）', () => {
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 100, w: 1000, h: 100 };
  const t = S.fitTransformOf(bounds, { w: 800, h: 600 }, 50);
  // 屏幕坐标 = 世界坐标 * zoom + x
  const left = bounds.minX * t.zoom + t.x;
  const right = bounds.maxX * t.zoom + t.x;
  near(left, 50, 0.0001, '左边距应为 padding');
  near(800 - right, 50, 0.0001, '右边距应为 padding');
  const top = bounds.minY * t.zoom + t.y;
  const bottom = bounds.maxY * t.zoom + t.y;
  near((top + bottom) / 2, 300, 0.0001, '垂直方向应居中');
});

check('缩放不会越过上下限（卡片特别小/特别大时）', () => {
  const tiny = S.fitTransformOf({ minX: 0, minY: 0, maxX: 0.1, maxY: 0.1, w: 0.1, h: 0.1 }, { w: 800, h: 600 }, 50);
  eq(tiny.zoom, 4, '极小的一批最多放大到 4 倍');
  const huge = S.fitTransformOf({ minX: 0, minY: 0, maxX: 100000, maxY: 100000, w: 100000, h: 100000 }, { w: 800, h: 600 }, 50);
  eq(huge.zoom, 0.1, '极大的一批最多缩到 0.1 倍');
});

check('可视区小得离谱时不会算出负宽或除零', () => {
  const t = S.fitTransformOf({ minX: 0, minY: 0, maxX: 10, maxY: 10, w: 10, h: 10 }, { w: 0, h: 0 }, 70);
  assert(Number.isFinite(t.zoom) && t.zoom > 0, '缩放必须是正数，拿到 ' + t.zoom);
  assert(Number.isFinite(t.x) && Number.isFinite(t.y), '平移必须是有限数');
});

check('padding 有下限（传 0 也不会贴着边）', () => {
  const t = S.fitTransformOf({ minX: 0, minY: 0, maxX: 100, maxY: 100, w: 100, h: 100 }, { w: 800, h: 600 }, 0);
  // 下限 24：可用宽 800-48=752 → 缩放 4 被上限截住；关键看左边距
  const left = 0 * t.zoom + t.x;
  assert(left >= 23.9, '左边距至少有 24，拿到 ' + left);
});

console.log('\nD3 · 挑「最新那张」');

check('空列表 / 全是 null 时返回 null', () => {
  eq(S.newestBy([], () => 1), null);
  eq(S.newestBy([null, undefined], () => 1), null);
});

check('时间戳全是 0 时返回 null（当作「没有」而不是「碰巧挑了第一张」）', () => {
  eq(S.newestBy([{ id: 'a' }, { id: 'b' }], () => 0), null);
});

check('挑出时间戳最大的那张，并把时间一起带回来', () => {
  const older = { id: 'old' };
  const newer = { id: 'new' };
  const hit = S.newestBy([older, newer], (node) => (node.id === 'new' ? 200 : 100));
  eq(hit.node.id, 'new');
  eq(hit.at, 200);
});

check('时间戳乱序、有坏值时按数值比，坏值当 0', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };
  const hit = S.newestBy([a, b, c], (node) => ({ a: 'abc', b: 500, c: null })[node.id]);
  eq(hit.node.id, 'b', '字符串和 null 都不该被当成有效时间');
});

console.log('\nD3 · 时间戳取值（最近修改 / 最近完成）');

check('最近完成只看生成结果的时间', () => {
  eq(S.finishedAtOf({ data: { result: { at: 1234 } } }), 1234);
  eq(S.finishedAtOf({ data: {} }), 0);
  eq(S.finishedAtOf({ data: { result: {} } }), 0);
});

check('最近修改按「改过的 / 提交过 / 生成过 / 有历史」取最大的那个', () => {
  eq(S.touchedAtOf({ data: { editedAt: 900 } }), 900, '改过的时间优先');
  eq(S.touchedAtOf({ data: { lastSubmission: { at: 800 } } }), 800, '提交过的也算');
  eq(S.touchedAtOf({ data: { result: { at: 700 } } }), 700, '生成完成的也算');
  eq(S.touchedAtOf({ data: { history: [{ at: 600 }] } }), 600, '有历史版本的也算');
  eq(
    S.touchedAtOf({ data: { editedAt: 900, lastSubmission: { at: 800 }, result: { at: 700 } } }),
    900,
    '多个都有时取最大'
  );
  eq(S.touchedAtOf({ data: {} }), 0, '什么都没有就是 0');
});

check('历史版本为空数组时不炸', () => {
  eq(S.touchedAtOf({ data: { history: [] } }), 0);
});

console.log('\nD3 · 「改过没有」的签名比对');

check('第一次跑只建基线，不把满屏卡片都盖成「刚刚」', () => {
  S.nodes = [
    { id: 'a', x: 0, y: 0, w: 100, h: 100, data: {} },
    { id: 'b', x: 200, y: 0, w: 100, h: 100, data: {} },
  ];
  S.touchSignatures = new Map();
  S.touchBaselineReady = false;
  const changed = S.stampTouchedCards();
  eq(changed, 0, '首次调用不该算作改过');
  assert(S.touchBaselineReady === true, '基线应该建好了');
  eq(S.touchSignatures.size, 2, '两张卡片的签名都该记下来');
});

check('什么都没动 → 一张都算不上改过', () => {
  const changed = S.stampTouchedCards();
  eq(changed, 0);
});

check('改了提示词 → 只有那张算改过，并且盖上时间', () => {
  S.nodes[1].data.text = '换了提示词';
  const before = Date.now();
  const changed = S.stampTouchedCards();
  eq(changed, 1, '只该有一张');
  const stamped = Number(S.nodes[1].data.editedAt) || 0;
  assert(stamped >= before - 5, '修改时间该是此刻');
  eq(Number(S.nodes[0].data.editedAt) || 0, 0, '没动的那张不该被盖章');
});

check('只是平移了画面（卡片坐标没变）不算改卡片', () => {
  // 坐标没动 = 签名没变
  const changed = S.stampTouchedCards();
  eq(changed, 0);
});

check('拖动卡片会算改过（位置进了签名）', () => {
  S.nodes[0].x = 40;
  const changed = S.stampTouchedCards();
  eq(changed, 1);
});

check('折叠/隐藏切换会算改过（可见性进了签名）', () => {
  S.nodes[0].data.hidden = true;
  const changed = S.stampTouchedCards();
  eq(changed, 1);
});

check('生成完成会算改过（结果 URL 进了签名）', () => {
  S.nodes[0].data.result = { url: '/assets/a.png' };
  const changed = S.stampTouchedCards();
  eq(changed, 1);
});

check('签名能区分不同卡片（不是所有卡片共用一个值）', () => {
  const a = S.cardSignature({ id: 'a', x: 0, y: 0, w: 100, h: 100, data: { text: '甲' } });
  const b = S.cardSignature({ id: 'b', x: 0, y: 0, w: 100, h: 100, data: { text: '乙' } });
  assert(a !== b, '不同提示词不该算出同一个签名');
});

console.log('\nD3 · 文案');

check('时间文案分档：刚刚 / 分钟 / 小时 / 天', () => {
  const now = Date.now();
  eq(S.sinceTextOf(now - 10 * 1000), '刚刚');
  eq(S.sinceTextOf(now - 5 * 60 * 1000), '5 分钟前');
  eq(S.sinceTextOf(now - 3 * 3600 * 1000), '3 小时前');
  eq(S.sinceTextOf(now - 2 * 86400 * 1000), '2 天前');
});

check('没有时间（0）时文案是空的，不显示「刚刚」骗人', () => {
  eq(S.sinceTextOf(0), '');
  eq(S.sinceTextOf(null), '');
  eq(S.sinceTextOf(undefined), '');
});

check('超过 30 天改用具体日期', () => {
  const old = Date.now() - 40 * 86400 * 1000;
  eq(S.sinceTextOf(old), new Date(old).toISOString().slice(0, 10));
});

check('超长名字截断并加省略号', () => {
  eq(S.clipText('短名字', 10), '短名字', '没超就不用动');
  eq(S.clipText('一二三四五六七八九十', 5), '一二三四…', '截到 limit-1 再补省略号');
  eq(S.clipText('', 5), '');
  eq(S.clipText(null, 5), '', 'null 当空串处理');
});

check('截断长度有下限（传 0 也不会切出空串）', () => {
  assert(S.clipText('abcdefg', 0).length >= 2, '至少留 2 个字符位');
});

console.log('\nD3 · 源码级约束');

check('三个入口都在：正在生成 / 最近完成 / 最近修改', () => {
  const at = canvasSrc.indexOf('function openLocateMenu(');
  assert(at >= 0, '缺少 openLocateMenu');
  const body = canvasSrc.slice(at, at + 1600);
  assert(body.indexOf('只看正在生成') >= 0, '缺少「只看正在生成」');
  assert(body.indexOf('跳到最近完成') >= 0, '缺少「跳到最近完成」');
  assert(body.indexOf('跳到最近修改') >= 0, '缺少「跳到最近修改」');
});

check('没得跳的时候置灰，不是点下去什么都不发生', () => {
  const at = canvasSrc.indexOf('function openLocateMenu(');
  const body = canvasSrc.slice(at, at + 1600);
  assert(body.indexOf('disabled:') >= 0, '菜单项没有 disabled');
  assert(body.indexOf('disabledHint') >= 0, '置灰时该说明为什么点不动');
  // openMenu 真的认这个字段
  const menuAt = canvasSrc.indexOf('function openMenu(');
  const menuBody = canvasSrc.slice(menuAt, menuAt + 1400);
  assert(menuBody.indexOf('item.disabled') >= 0, 'openMenu 没处理 disabled');
  assert(menuBody.indexOf("classList.add('disabled-item')") >= 0, '没加上置灰样式类');
  assert(menuBody.indexOf('if (item.disabled) return;') >= 0, '置灰的项还能点下去');
});

check('「正在生成」把定时组里在跑的那几张也算上', () => {
  const at = canvasSrc.indexOf('function runningTargets(');
  assert(at >= 0, '缺少 runningTargets');
  const body = canvasSrc.slice(at, at + 900);
  assert(body.indexOf('scheduleRuns') >= 0, '没读定时组的运行状态');
  assert(body.indexOf("status === 'running'") >= 0, '没按 running 状态筛');
  assert(body.indexOf('includeHidden') >= 0, '没区分「没有」和「有但被藏起来了」');
});

check('被藏起来的卡片会提示先放出来，而不是谎报「没有」', () => {
  const at = canvasSrc.indexOf('function locateRunning(');
  const body = canvasSrc.slice(at, at + 900);
  assert(body.indexOf('藏起来') >= 0, '缺少「被藏起来了」的提示');
  assert(body.indexOf('includeHidden: true') >= 0, '没查隐藏的有没有在跑');
});

check('单选跳转保持当前缩放（不硬拉近拉远）', () => {
  const at = canvasSrc.indexOf('function locateNodes(');
  const body = canvasSrc.slice(at, at + 700);
  assert(body.indexOf('arr.length === 1') >= 0, '没区分单选');
  assert(body.indexOf('viewportEl.clientWidth / 2') >= 0, '单选时该居中而不是缩放');
});

check('定位结果会同步保存视口（刷新后还在同一个位置）', () => {
  const at = canvasSrc.indexOf('function locateNodes(');
  const body = canvasSrc.slice(at, at + 800);
  assert(body.indexOf('scheduleSave()') >= 0, '跳完没安排保存');
});

check('fitView 复用同一套几何计算，没有第二份缩放规则', () => {
  const at = canvasSrc.indexOf('function fitView()');
  assert(at >= 0, '缺少 fitView');
  const body = canvasSrc.slice(at, at + 400);
  assert(body.indexOf('fitToNodes(') >= 0, 'fitView 没有复用 fitToNodes');
  // 全局只该有一处 min/max 求包围盒
  const boxCount = (canvasSrc.match(/function boundsOfNodes\(/g) || []).length;
  eq(boxCount, 1, '包围盒计算出现了 ' + boxCount + ' 份');
  const fitCount = (canvasSrc.match(/function fitTransformOf\(/g) || []).length;
  eq(fitCount, 1, '缩放计算出现了 ' + fitCount + ' 份');
});

check('菜单里写了「会跳到哪张、多久以前」', () => {
  const at = canvasSrc.indexOf('function openLocateMenu(');
  const body = canvasSrc.slice(at, at + 1600);
  assert(body.indexOf('locateLabelOf(') >= 0, '没显示卡片名字');
  assert(body.indexOf('sinceTextOf(') >= 0, '没显示「多久以前」');
});

check('卡片称呼有兜底：标题 → 序号 → 类型名', () => {
  const at = canvasSrc.indexOf('function locateLabelOf(');
  const body = canvasSrc.slice(at, at + 400);
  assert(body.indexOf('data.title') >= 0, '没先看标题');
  assert(body.indexOf('tagOf(') >= 0, '没有序号兜底');
  assert(body.indexOf('presetOf(') >= 0, '没有类型名兜底');
});

check('按钮与计数徽章都在工具栏里', () => {
  assert(htmlSrc.indexOf('id="btn-locate"') >= 0, '缺少定位按钮');
  assert(htmlSrc.indexOf('id="locate-badge"') >= 0, '缺少计数徽章');
  const btnAt = htmlSrc.indexOf('id="btn-locate"');
  const btn2 = htmlSrc.slice(btnAt, btnAt + 500);
  assert(btn2.indexOf('rail-text') >= 0, '按钮缺少文字标签');
  assert(btn2.indexOf('快速定位') >= 0, '按钮缺少「快速定位」文案');
});

check('徽章会随生成状态刷新（不是打开时算一次就不管了）', () => {
  assert(canvasSrc.indexOf('function paintLocateBadge()') >= 0, '缺少徽章刷新函数');
  // 刷新点挂在 applyZOrder 里 —— 那是项目既有的「状态变了就重排」枢纽，
  // 从任务进度、提交结果到定时组轮询都汇到这里，一处挂上就全覆盖。
  const at = canvasSrc.indexOf('function applyZOrder()');
  assert(at >= 0, '缺少 applyZOrder');
  const body = canvasSrc.slice(at, at + 900);
  assert(body.indexOf('paintLocateBadge()') >= 0, '徽章刷新没挂进 applyZOrder');
  // 反向确认 applyZOrder 真的是被多处调用的枢纽，而不是个死函数
  const callCount = (canvasSrc.match(/applyZOrder\(\);/g) || []).length;
  assert(callCount >= 3, 'applyZOrder 只有 ' + callCount + ' 个调用点，不算枢纽');
});

check('按钮点击弹出定位菜单（不是个没接线的装饰）', () => {
  const at = canvasSrc.indexOf("const locateBtn = document.getElementById('btn-locate')");
  assert(at >= 0, '没找到按钮绑定');
  const body = canvasSrc.slice(at, at + 400);
  assert(body.indexOf("addEventListener('click'") >= 0, '按钮没绑点击');
  assert(body.indexOf('openLocateMenu(') >= 0, '点击没打开定位菜单');
});

check('样式补齐（置灰项 + 徽章）', () => {
  assert(cssSrc.indexOf('disabled-item') >= 0, '缺少置灰样式 .disabled-item');
  assert(cssSrc.indexOf('.rail-badge') >= 0, '缺少徽章样式 .rail-badge');
});

check('「最近修改」不依赖库里那个「整块画布一个值」的时间戳', () => {
  // nodes.updated_at 是整块保存时统一盖的，比不出卡片之间的先后 ——
  // 所以 touchedAtOf 不能读它。这个断言是防止以后有人「顺手简化」回去。
  const at = canvasSrc.indexOf('function touchedAtOf(');
  const body = canvasSrc.slice(at, at + 500);
  assert(body.indexOf('updatedAt') < 0, '最近修改又回去读 updatedAt 了，它比不出先后');
  assert(body.indexOf('editedAt') >= 0, '缺少自己记的 editedAt');
});

check('打扰最小的实现：只在保存前算一次签名，不在几十处编辑点各插一行', () => {
  const callCount = (canvasSrc.match(/stampTouchedCards\(\);?/g) || []).length;
  assert(callCount >= 2, '没有任何调用点');
  // 定义 1 处 + 调用点若干，但调用点应该集中在保存路径，不超过 4 处
  assert(callCount <= 5, '调用点有 ' + callCount + ' 处，太散了，容易漏');
});

console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
