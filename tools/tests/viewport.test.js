'use strict';

// 坐标映射模块的隔离测试（清单 38「拆分 canvas.js」第 7 步）。
//
// web/assets/viewport.js 是画布屏幕↔世界换算的唯一出处：toWorld / toScreen /
// centerOf / zoomAround / fitTransformOf / centerOn / panTo + 两个缩放常量。
//
// 这里守的是**写反了也不报错**的那一类错。它不抛异常、画面也照画，只是：
//   · 乘写成除 → 缩放方向反了，滚轮越滚越远；
//   · x 与 y 写串、left 与 top 写串 → 画面斜着跑，方向还「看着挺合理」；
//   · 锚点缩放里少减一次平移 → 缩放中心不在鼠标处，鼠标离得越远偏得越多；
//   · 上下限写成同一个数 → 只能缩不能放。
// 这些都能过肉眼验收（你很难盯着一个数字说它错了），只能靠算式对拆。
//
// 核心不变量是**往返一致**：toScreen(toWorld(p)) === p、zoomAround 前后锚点下的
// 世界坐标不动。这两条一旦破了，上面四种错都会露出来。
//
// 运行：runtime/node.exe tools/tests/viewport.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-viewport-'));
require(path.join(__dirname, '_isolate.js'))(box);

const SRC_PATH = path.join(ROOT, 'web', 'assets', 'viewport.js');
const vp = require(SRC_PATH);
const src = fs.readFileSync(SRC_PATH, 'utf8');

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
  const t = tol == null ? 1e-6 : tol;
  if (!(Math.abs(got - want) <= t)) {
    throw new Error((msg || '数值不够接近') + '：拿到 ' + got + '，期望 ' + want);
  }
}
function origin(left, top) {
  return { left: left == null ? 0 : left, top: top == null ? 0 : top };
}

console.log('\n【导出面与模块形态】');

check('导出两个常量 + 八个函数', () => {
  eq(typeof vp.MIN_ZOOM, 'number');
  eq(typeof vp.MAX_ZOOM, 'number');
  ['toWorld', 'toScreen', 'centerOf', 'clampZoom', 'zoomAround', 'fitTransformOf', 'centerOn', 'panTo']
    .forEach((name) => eq(typeof vp[name], 'function', name + ' 不是函数'));
});

check('缩放上下限沿用原来的值（0.1 / 4，改了说明是无意的）', () => {
  eq(vp.MIN_ZOOM, 0.1, 'MIN_ZOOM 被改了');
  eq(vp.MAX_ZOOM, 4, 'MAX_ZOOM 被改了');
});

check('是 UMD：浏览器挂 window.CanvasViewport，Node 走 module.exports', () => {
  assert(src.indexOf('root.CanvasViewport = api') >= 0, '没有给浏览器挂全局名');
  assert(src.indexOf('module.exports = api') >= 0, '没有导出给 Node');
});

check('不依赖浏览器环境（服务端 require 不许炸）', () => {
  const code = src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  ['window.', 'document.', 'navigator.'].forEach((needle) => {
    assert(code.indexOf(needle) < 0, '模块里用了 ' + needle + '，服务端 require 会炸');
  });
});

console.log('\n【toWorld / toScreen：往返必须回到原点】');

check('中心位置：平移 0、缩放 1 时屏幕坐标就是世界坐标', () => {
  const o = origin(0, 0);
  const v = { x: 0, y: 0, zoom: 1 };
  const w = vp.toWorld(o, v, 300, 200);
  eq(w.x, 300);
  eq(w.y, 200);
});

check('页面偏移要减掉（画布不在页面左上角时最容易漏）', () => {
  const o = origin(120, 60);
  const v = { x: 0, y: 0, zoom: 1 };
  const w = vp.toWorld(o, v, 300, 200);
  eq(w.x, 180, 'left 没减掉');
  eq(w.y, 140, 'top 没减掉');
});

check('平移要减掉、缩放要除（乘写成除就是缩放方向反）', () => {
  const o = origin(0, 0);
  const v = { x: 100, y: 50, zoom: 2 };
  const w = vp.toWorld(o, v, 300, 250);
  eq(w.x, 100, '(300 - 100) / 2 = 100');
  eq(w.y, 100, '(250 - 50) / 2 = 100');
});

check('往返一致：toScreen(toWorld(p)) === p（一整组随机参数）', () => {
  const cases = [
    [origin(0, 0), { x: 0, y: 0, zoom: 1 }, 300, 200],
    [origin(120, 60), { x: 0, y: 0, zoom: 1 }, 300, 200],
    [origin(0, 0), { x: -420, y: 310, zoom: 0.35 }, 777, 555],
    [origin(33, 77), { x: 1234.5, y: -678.9, zoom: 2.75 }, 10, 900],
    [origin(-40, 25), { x: 0, y: 0, zoom: 0.1 }, 5, 5],
    [origin(0, 0), { x: 0, y: 0, zoom: 4 }, 1600, 1000],
  ];
  cases.forEach((one, index) => {
    const [o, v, cx, cy] = one;
    const w = vp.toWorld(o, v, cx, cy);
    const back = vp.toScreen(o, v, w.x, w.y);
    near(back.x, cx, 1e-9, '第 ' + (index + 1) + ' 组 x 没回到原位');
    near(back.y, cy, 1e-9, '第 ' + (index + 1) + ' 组 y 没回到原位');
  });
});

check('x 与 y 没有写串（把 x 通道单独改，y 结果不该动）', () => {
  const o = origin(0, 0);
  const v = { x: 10, y: 20, zoom: 1.5 };
  const one = vp.toWorld(o, v, 100, 200);
  const two = vp.toWorld(o, v, 999, 200);
  eq(one.y, two.y, '改了 x，y 跟着变了 —— x / y 写串了');
  const three = vp.toScreen(o, v, 50, 60);
  const four = vp.toScreen(o, v, 50, 9999);
  eq(three.x, four.x, '改了 y，x 跟着变了 —— x / y 写串了');
});

check('toScreen 要把页面偏移加回去（往返一致查不出这条）', () => {
  // 往返一致用的是同一个 origin：如果 toWorld 与 toScreen **同时**漏掉 o.left，
  // 往返照样一致，但整个画面会整体偏一格。所以这里单独盯 toScreen 的绝对位置。
  const o = origin(120, 60);
  const v = { x: 0, y: 0, zoom: 1 };
  const s = vp.toScreen(o, v, 300, 200);
  eq(s.x, 420, '没把 left 加回去');
  eq(s.y, 260, '没把 top 加回去');
});

check('toScreen 是「先乘 zoom 再加平移」（顺序反了缩放就错位）', () => {
  const o = origin(0, 0);
  const v = { x: 100, y: 50, zoom: 2 };
  const s = vp.toScreen(o, v, 30, 40);
  eq(s.x, 160, '30 * 2 + 100 = 160');
  eq(s.y, 130, '40 * 2 + 50 = 130');
});

check('传空参数不炸（兜底成屏幕原点 + 1 倍缩放）', () => {
  const w = vp.toWorld(null, null, 100, 200);
  eq(w.x, 100);
  eq(w.y, 200);
  const s = vp.toScreen(null, { x: 0, y: 0, zoom: 0 }, 10, 20);
  // zoom 兜成 1（除以 0 会得到 Infinity，不能让画面消失）
  eq(s.x, 10);
});

console.log('\n【centerOf / clampZoom：视口中心与区间】');

check('视口中心的世界坐标（缩放 1、无平移）', () => {
  const c = vp.centerOf(800, 600, { x: 0, y: 0, zoom: 1 });
  eq(c.x, 400);
  eq(c.y, 300);
});

check('视口中心要减平移、除缩放', () => {
  // y 的平移是 -50，所以是「减 -50」= 加 50；
  // 期望值不能写成「中心减平移」，那是符号没代进去。
  const c = vp.centerOf(800, 600, { x: 100, y: -50, zoom: 2 });
  eq(c.x, 150, '(800/2 - 100) / 2 = 150');
  eq(c.y, 175, '(600/2 - (-50)) / 2 = 175');
});

check('视口中心与 toWorld 结果一致（同一套换算，不许各写一份）', () => {
  const o = origin(60, 30);
  const v = { x: -220, y: 140, zoom: 1.8 };
  const viaCenter = vp.centerOf(800, 600, v);
  // 视口中心在屏幕上的坐标 = 偏移 + 内容尺寸的一半
  const viaWorld = vp.toWorld(o, v, o.left + 400, o.top + 300);
  near(viaCenter.x, viaWorld.x, 1e-9, '两处算出来不一样 —— 说明分头写了两份');
  near(viaCenter.y, viaWorld.y, 1e-9, '两处算出来不一样');
});

check('clampZoom 收进 0.1 ~ 4', () => {
  eq(vp.clampZoom(0.01), 0.1);
  eq(vp.clampZoom(99), 4);
  eq(vp.clampZoom(1.5), 1.5);
});

check('clampZoom 遇到坏值兜成 1（NaN / 0 / 负数都不能让画面消失）', () => {
  eq(vp.clampZoom(NaN), 1);
  eq(vp.clampZoom(undefined), 1);
  eq(vp.clampZoom('abc'), 1);
  eq(vp.clampZoom(0), 0.1, '0 应该被夹到下限');
  eq(vp.clampZoom(-3), 0.1);
});

console.log('\n【zoomAround：锚点下的世界坐标必须不动】');

check('锚点缩放后，鼠标底下的世界坐标原地不动（滚轮手感的核心）', () => {
  const v = { x: -300, y: 120, zoom: 0.8 };
  const anchorX = 420;
  const anchorY = 260;
  const before = vp.toWorld(origin(0, 0), v, anchorX, anchorY);
  const next = vp.zoomAround(v, anchorX, anchorY, 1.25);
  const after = vp.toWorld(origin(0, 0), next, anchorX, anchorY);
  near(after.x, before.x, 1e-9, '缩放后锚点下面的世界坐标跑了（x）');
  near(after.y, before.y, 1e-9, '缩放后锚点下面的世界坐标跑了（y）');
});

check('放大时 zoom 变大、缩小时变小（反了就是滚轮方向错）', () => {
  const v = { x: 0, y: 0, zoom: 1 };
  assert(vp.zoomAround(v, 100, 100, 1.2).zoom > 1, '放大却变小了');
  assert(vp.zoomAround(v, 100, 100, 0.8).zoom < 1, '缩小却变大了');
});

check('连续缩放多步，锚点始终不动（累积误差不能跑偏）', () => {
  let v = { x: -150, y: 80, zoom: 1 };
  const anchorX = 500;
  const anchorY = 400;
  const before = vp.toWorld(origin(0, 0), v, anchorX, anchorY);
  for (let i = 0; i < 20; i += 1) v = vp.zoomAround(v, anchorX, anchorY, i % 2 ? 1.1 : 0.95);
  const after = vp.toWorld(origin(0, 0), v, anchorX, anchorY);
  near(after.x, before.x, 1e-6, '20 步之后锚点偏了（x）');
  near(after.y, before.y, 1e-6, '20 步之后锚点偏了（y）');
});

check('缩放会被上下限夹住（滚到 4 倍就不该再大）', () => {
  const v = { x: 0, y: 0, zoom: 3.5 };
  eq(vp.zoomAround(v, 100, 100, 2).zoom, 4, '超过上限没夹住');
  eq(vp.zoomAround({ x: 0, y: 0, zoom: 0.15 }, 100, 100, 0.1).zoom, 0.1, '低于下限没夹住');
});

check('夹住之后锚点仍然不动（这是最容易漏的一条）', () => {
  // 已经在上限，再放大：zoom 不变，那么平移也不该变
  const v = { x: 123, y: -45, zoom: 4 };
  const next = vp.zoomAround(v, 300, 200, 3);
  eq(next.zoom, 4);
  eq(next.x, 123, 'zoom 没变，平移却动了 —— 画面会无故漂移');
  eq(next.y, -45, 'zoom 没变，平移却动了');
});

check('锚点在画面原点 (0,0) 时也不出错', () => {
  const v = { x: 50, y: 50, zoom: 1 };
  // 锚点 (0,0) 落在世界坐标 (-50,-50) 上。放大 2 倍后要让它留在原地：
  // x = 0 - (-50) * 2 = 100
  const next = vp.zoomAround(v, 0, 0, 2);
  eq(next.zoom, 2);
  eq(next.x, 100, '锚点没留在原位');
  eq(next.y, 100, '锚点没留在原位');
  // 用 toWorld 复查一遍：锚点下的世界坐标前后一致
  const before = vp.toWorld(origin(0, 0), v, 0, 0);
  const after = vp.toWorld(origin(0, 0), next, 0, 0);
  near(after.x, before.x, 1e-9, '锚点下的世界坐标动了');
  near(after.y, before.y, 1e-9, '锚点下的世界坐标动了');
});

console.log('\n【fitTransformOf：刚好框住】');

check('外接矩形居中（框住之后左右留白一样多）', () => {
  const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 200, w: 400, h: 200 };
  const view = { w: 800, h: 600 };
  const gap = 70;
  const t = vp.fitTransformOf(bounds, view, gap);
  // 缩放取「哪一边先碰到边距」的那个比例：可用 660×460，min(660/400, 460/200) = 1.65
  near(t.zoom, Math.min(660 / 400, 460 / 200), 1e-9, '缩放没取限制边');
  near(t.zoom, 1.65, 1e-9, '缩放值应该是 1.65（宽度是限制边）');
  // 居中：内容左右留白一样多
  const availW = view.w - gap * 2;
  const leftGap = gap + (availW - bounds.w * t.zoom) / 2 - bounds.minX * t.zoom;
  const rightGap = view.w - (leftGap + bounds.w * t.zoom);
  near(leftGap, rightGap, 1e-6, '左右留白不一样 —— 没居中');
  // 居中：上下留白一样多
  const availH = view.h - gap * 2;
  const topGap = gap + (availH - bounds.h * t.zoom) / 2 - bounds.minY * t.zoom;
  const bottomGap = view.h - (topGap + bounds.h * t.zoom);
  near(topGap, bottomGap, 1e-6, '上下留白不一样 —— 没居中');
});

check('超大内容被夹到下限、超小内容被夹到上限', () => {
  const huge = vp.fitTransformOf({ minX: 0, minY: 0, maxX: 1e6, maxY: 1e6, w: 1e6, h: 1e6 }, { w: 800, h: 600 }, 70);
  eq(huge.zoom, 0.1, '超大内容没夹到下限');
  const tiny = vp.fitTransformOf({ minX: 0, minY: 0, maxX: 0.01, maxY: 0.01, w: 0.01, h: 0.01 }, { w: 800, h: 600 }, 70);
  eq(tiny.zoom, 4, '超小内容没夹到上限');
});

check('最小留白 24px（pad 传得很小时不能变成 0 边距）', () => {
  // 用一个「不会撞上 MAX_ZOOM 上限」的内容尺寸，才验得出 gap 到底取了多少。
  // 内容 600×400：gap 取 24 → 可用 752×552 → min(752/600, 552/400) = 1.2533…（宽度是限制边）
  // 若 gap 错误地取了 1 → 可用 798×598 → min(798/600, 598/400) = 1.33，两者能区分开
  const t = vp.fitTransformOf({ minX: 0, minY: 0, maxX: 600, maxY: 400, w: 600, h: 400 }, { w: 800, h: 600 }, 1);
  near(t.zoom, Math.min(752 / 600, 552 / 400), 1e-9, '小 pad 没兜成 24');
  near(t.zoom, 752 / 600, 1e-9, '缩放值不对');
  assert(t.zoom < 4, '这个用例不该撞上上限，否则验不出 gap');
});

check('可视区尺寸为 0 时不产出 Infinity（最小 60px 兜底）', () => {
  const t = vp.fitTransformOf({ minX: 0, minY: 0, maxX: 10, maxY: 10, w: 10, h: 10 }, { w: 0, h: 0 }, 70);
  assert(Number.isFinite(t.zoom), 'zoom 不是有限数：' + t.zoom);
  assert(Number.isFinite(t.x), 'x 不是有限数：' + t.x);
  assert(Number.isFinite(t.y), 'y 不是有限数：' + t.y);
});

check('计算结果能真的把 bounds 框在视口里（拿 toScreen 验一遍）', () => {
  const bounds = { minX: -300, minY: 120, maxX: 900, maxY: 640, w: 1200, h: 520 };
  const view = { w: 1000, h: 700 };
  const t = vp.fitTransformOf(bounds, view, 70);
  const v = { x: t.x, y: t.y, zoom: t.zoom };
  const o = origin(0, 0);
  const topLeft = vp.toScreen(o, v, bounds.minX, bounds.minY);
  const bottomRight = vp.toScreen(o, v, bounds.maxX, bounds.maxY);
  assert(topLeft.x >= -0.001, '左边框跑到视口外了：' + topLeft.x);
  assert(topLeft.y >= -0.001, '上边框跑到视口外了：' + topLeft.y);
  assert(bottomRight.x <= view.w + 0.001, '右边框跑到视口外了：' + bottomRight.x);
  assert(bottomRight.y <= view.h + 0.001, '下边框跑到视口外了：' + bottomRight.y);
});

console.log('\n【centerOn / panTo：居中与平移】');

check('centerOn 把卡片中心摆到视口正中', () => {
  const node = { x: 1000, y: 500 };
  const box2 = { w: 260, h: 180 };
  const t = vp.centerOn(box2, node, 1000, 700, { x: 0, y: 0, zoom: 1 });
  const center = vp.toScreen(origin(0, 0), { x: t.x, y: t.y, zoom: t.zoom }, node.x + box2.w / 2, node.y + box2.h / 2);
  near(center.x, 500, 1e-9, '卡片中心没落在视口正中（x）');
  near(center.y, 350, 1e-9, '卡片中心没落在视口正中（y）');
});

check('centerOn 不改缩放（单张跳转时不该硬拉近拉远）', () => {
  const t = vp.centerOn({ w: 260, h: 180 }, { x: 0, y: 0 }, 1000, 700, { x: 0, y: 0, zoom: 1.75 });
  eq(t.zoom, 1.75, '缩放被动了');
});

check('centerOn 遇到坏 zoom 兜成 1（不能让画面消失）', () => {
  const t = vp.centerOn({ w: 100, h: 100 }, { x: 0, y: 0 }, 800, 600, { x: 0, y: 0, zoom: 0 });
  eq(t.zoom, 1);
  assert(Number.isFinite(t.x) && Number.isFinite(t.y), '算出了非有限数');
});

check('panTo 把指定世界点摆到视口正中', () => {
  const t = vp.panTo(640, 480, 1000, 700, 2);
  const at = vp.toScreen(origin(0, 0), { x: t.x, y: t.y, zoom: 2 }, 640, 480);
  near(at.x, 500, 1e-9, '没落在正中（x）');
  near(at.y, 350, 1e-9, '没落在正中（y）');
});

check('panTo 与 centerOn 在「把卡片中心摆正中」上结果一致', () => {
  const node = { x: 300, y: 400 };
  const box2 = { w: 200, h: 100 };
  const one = vp.centerOn(box2, node, 900, 600, { x: 0, y: 0, zoom: 1.5 });
  const two = vp.panTo(node.x + box2.w / 2, node.y + box2.h / 2, 900, 600, 1.5);
  near(one.x, two.x, 1e-9, '两个函数对同一件事算出了不同结果');
  near(one.y, two.y, 1e-9, '两个函数对同一件事算出了不同结果');
});

console.log('\n【与 canvas.js 的接线】');

check('canvas.js 用了 viewport.js，并且每个使用点都留了兜底', () => {
  const canvas = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  assert(canvas.indexOf('window.CanvasViewport') >= 0, 'canvas.js 没接 viewport.js');
  assert(/viewMath \? viewMath\.MIN_ZOOM : 0\.1/.test(canvas), 'MIN_ZOOM 没有兜底值');
  assert(/viewMath \? viewMath\.MAX_ZOOM : 4/.test(canvas), 'MAX_ZOOM 没有兜底值');
  ['toWorld', 'toScreen', 'centerOf', 'zoomAround', 'fitTransformOf', 'centerOn', 'panTo']
    .forEach((name) => {
      assert(canvas.indexOf('viewMath.' + name + '(') >= 0, name + ' 没有转发给模块');
    });
});

check('canvas.js 的缩放上下限来自模块，不是自己另立一份', () => {
  const canvas = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  assert(/const MIN_ZOOM = viewMath \? viewMath\.MIN_ZOOM : [\d.]+;/.test(canvas),
    'MIN_ZOOM 不是从 viewMath 取的');
  assert(/const MAX_ZOOM = viewMath \? viewMath\.MAX_ZOOM : [\d.]+;/.test(canvas),
    'MAX_ZOOM 不是从 viewMath 取的');
  // 不许再有「独立写死」的那一种（没有 viewMath 分支、直接就等于一个字面量）
  assert(!/const MIN_ZOOM = [\d.]+;/.test(canvas), 'canvas.js 里还有独立写死的 MIN_ZOOM');
  assert(!/const MAX_ZOOM = [\d.]+;/.test(canvas), 'canvas.js 里还有独立写死的 MAX_ZOOM');
});

check('兜底字面量与模块里的值一致（改了一边忘了另一边就是真漂移）', () => {
  const canvas = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const minHit = canvas.match(/const MIN_ZOOM = viewMath \? viewMath\.MIN_ZOOM : ([\d.]+);/);
  const maxHit = canvas.match(/const MAX_ZOOM = viewMath \? viewMath\.MAX_ZOOM : ([\d.]+);/);
  assert(minHit, '找不到 MIN_ZOOM 的兜底字面量');
  assert(maxHit, '找不到 MAX_ZOOM 的兜底字面量');
  eq(Number(minHit[1]), vp.MIN_ZOOM,
    'canvas.js 兜底 MIN_ZOOM 是 ' + minHit[1] + '，模块里是 ' + vp.MIN_ZOOM +
    ' —— 老页面缓存取不到模块时会用兜底值，两边必须一致');
  eq(Number(maxHit[1]), vp.MAX_ZOOM,
    'canvas.js 兜底 MAX_ZOOM 是 ' + maxHit[1] + '，模块里是 ' + vp.MAX_ZOOM);
});

check('锚点缩放只留一份实现（原来是 zoomAt 与 applyZoomStep 各抄一遍）', () => {
  const canvas = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  // 「先算世界坐标再乘新 zoom」这个模式只应该出现在 zoomAroundPoint 的兜底分支里
  const hits = (canvas.match(/\(anchorX - viewport\.x\) \/ /g) || []).length;
  eq(hits, 1, '锚点缩放被抄了 ' + hits + ' 份，应该只剩 1 份');
});

check('视口中心换算只留一处（不再到处内联 clientWidth / 2）', () => {
  const canvas = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const inline = (canvas.match(/\(viewportEl\.clientWidth \/ 2 - viewport\.x\)/g) || []).length;
  eq(inline, 1, '还有 ' + inline + ' 处内联的视口中心换算，应该只剩 centerOfView 里那一处兜底');
});

check('canvas.html 在 canvas.js 之前加载 viewport.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'canvas.html'), 'utf8');
  const at = html.indexOf('/assets/viewport.js');
  const canvasAt = html.indexOf('/assets/canvas.js');
  assert(at >= 0, 'canvas.html 没引入 viewport.js');
  assert(at < canvasAt, 'viewport.js 排在 canvas.js 后面，加载时会取不到');
});

console.log('\n【与旧实现的等价性】');

check('与 canvas.js 里那份兜底实现逐项一致', () => {
  const canvas = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  // 兜底的 fitTransformOf 算式要与模块一致（同一串数字跑出来必须相同）
  const sandbox = {};
  const fnSrc = canvas.slice(
    canvas.indexOf('function fitTransformOf('),
    canvas.indexOf('// 把画面缩放到「刚好框住这一批卡片」')
  );
  // 把模块调用剥掉，只留兜底分支
  const fallback = fnSrc
    .replace(/if \(viewMath\) return viewMath\.fitTransformOf\(bounds, view, pad\);/, '')
    .replace('function fitTransformOf(bounds, view, pad) {', 'sandbox.fit = function (bounds, view, pad) {');
  const clampSrc = 'function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }';
  const consts = 'var MIN_ZOOM = ' + vp.MIN_ZOOM + '; var MAX_ZOOM = ' + vp.MAX_ZOOM + ';';
  // eslint-disable-next-line no-new-func
  new Function('sandbox', consts + clampSrc + '\n' + fallback + '\nreturn sandbox;')(sandbox);
  const bounds = { minX: -120, minY: 40, maxX: 880, maxY: 460, w: 1000, h: 420 };
  const view = { w: 1200, h: 800 };
  const one = sandbox.fit(bounds, view, 70);
  const two = vp.fitTransformOf(bounds, view, 70);
  near(one.zoom, two.zoom, 1e-9, '兜底与模块的 zoom 不一致');
  near(one.x, two.x, 1e-9, '兜底与模块的 x 不一致');
  near(one.y, two.y, 1e-9, '兜底与模块的 y 不一致');
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);