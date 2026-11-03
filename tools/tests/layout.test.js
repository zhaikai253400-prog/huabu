'use strict';

// 排版算法的隔离测试（清单 38「拆分 canvas.js」第 6 步）。
//
// web/assets/layout.js 是「一键整理排版」的唯一算法出处：分层排布（flowPlan）、
// 网格排布（gridPlan）、整体间连线（unitLinks）。
//
// 这里守的是**排版算错不会报错**这件事。它不抛异常、不写坏数据，只是把卡片摆歪：
//   · 分层方向反了 → 整块画布左右镜像，连线全往左倒；
//   · 环上的连线没挡住 → depthOf 无限递归，整理一次把页面卡死；
//   · 列内顺序没排好 → 连线交叉成蜘蛛网；
//   · 网格列数算错 → 一百张卡片排成一长条或者挤成一坨。
// 这四种都读代码读不出来、也很难肉眼验收（得先有一块连线复杂的画布），
// 所以抽成模块、在这里喂数据断言。
//
// 运行：runtime/node.exe tools/tests/layout.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-layout-'));
require(path.join(__dirname, '_isolate.js'))(box);

const SRC_PATH = path.join(ROOT, 'web', 'assets', 'layout.js');
const layout = require(SRC_PATH);
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

// 造一个整体（一张卡片或一个组合）：units 的每一项都要有 id 和 nodes。
function unit(id, w, h, extra) {
  const one = Object.assign({ id: id, w: w == null ? 200 : w, h: h == null ? 140 : h }, extra || {});
  return { id: id, nodes: [{ id: id, x: one.x || 0, y: one.y || 0 }], w: one.w, h: one.h };
}
function boxesOf(units) {
  const boxes = new Map();
  units.forEach((one) => boxes.set(one.id, { x: one.x || 0, y: one.y || 0, w: one.w, h: one.h }));
  return boxes;
}
function edge(sourceId, targetId) {
  return { id: 'e_' + sourceId + '_' + targetId, sourceId: sourceId, targetId: targetId };
}

console.log('\n【导出面与模块形态】');

check('导出两份间距常量 + 三个算法', () => {
  eq(typeof layout.COL_GAP, 'number', 'COL_GAP 不是数字');
  eq(typeof layout.ROW_GAP, 'number', 'ROW_GAP 不是数字');
  eq(typeof layout.unitLinks, 'function');
  eq(typeof layout.flowPlan, 'function');
  eq(typeof layout.gridPlan, 'function');
});

check('间距沿用原来的值（96 / 56，改了就说明是无意的）', () => {
  eq(layout.COL_GAP, 96, '列间距被改了');
  eq(layout.ROW_GAP, 56, '行间距被改了');
});

check('是 UMD：浏览器挂 window.CanvasLayout，Node 走 module.exports', () => {
  assert(src.indexOf('root.CanvasLayout = api') >= 0, '没有给浏览器挂全局名');
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

console.log('\n【unitLinks：只算整体之间】');

check('整体内部的连线不算（组合里素材连素材，不能把整组撑开）', () => {
  const units = [
    { id: 'g1', nodes: [{ id: 'a' }, { id: 'b' }] },
    { id: 'c', nodes: [{ id: 'c' }] },
  ];
  const links = layout.unitLinks(units, [edge('a', 'b'), edge('b', 'a')]);
  eq(links.outs.get('g1').length, 0, '组合内部的线被算成了整体间的连接');
  eq(links.ins.get('g1').length, 0, '组合内部的线被算成了整体间的连接');
});

check('整体之间的连线双向记录（outs 正查、ins 反查）', () => {
  const units = [{ id: 'a', nodes: [{ id: 'a' }] }, { id: 'b', nodes: [{ id: 'b' }] }];
  const links = layout.unitLinks(units, [edge('a', 'b')]);
  eq(links.outs.get('a').join(), 'b', '出边没记上');
  eq(links.ins.get('b').join(), 'a', '入边没记上');
  eq(links.ins.get('a').length, 0, '没有入边却记了');
});

check('重复连线只记一次（两张卡连两条线不该排出两个位置）', () => {
  const units = [{ id: 'a', nodes: [{ id: 'a' }] }, { id: 'b', nodes: [{ id: 'b' }] }];
  const links = layout.unitLinks(units, [edge('a', 'b'), edge('a', 'b'), edge('a', 'b')]);
  eq(links.outs.get('a').length, 1, '重复边被记了多份');
});

check('连到不存在的整体上的线被忽略（删了卡片留下的残线）', () => {
  const units = [{ id: 'a', nodes: [{ id: 'a' }] }];
  const links = layout.unitLinks(units, [edge('a', 'ghost'), edge('ghost', 'a')]);
  eq(links.outs.get('a').length, 0);
  eq(links.ins.get('a').length, 0);
});

check('edges 传空 / 不传都不炸（兜底成一张没有连线的画布）', () => {
  const units = [{ id: 'a', nodes: [{ id: 'a' }] }];
  assert(layout.unitLinks(units, []) instanceof Object);
  assert(layout.unitLinks(units) instanceof Object, '不传 edges 就炸了');
});

console.log('\n【flowPlan：按连线分层】');

check('没接线的整体排在同一列（都是源头）', () => {
  const units = [unit('a'), unit('b'), unit('c')];
  const plan = layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, []);
  const xs = ['a', 'b', 'c'].map((id) => plan.get(id).x);
  eq(new Set(xs).size, 1, '没有连线的三张被分到了不同列：' + xs.join());
});

check('方向是左→右：被引用的排在前一列（反了就是整块画布镜像）', () => {
  // b 用 a 当素材 → a 在左、b 在右
  const units = [unit('a'), unit('b')];
  const plan = layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, [edge('a', 'b')]);
  assert(plan.get('a').x < plan.get('b').x, 'a 应该排在 b 左边，实际 a=' + plan.get('a').x + ' b=' + plan.get('b').x);
});

check('三层链条排成三列（a → b → c 各占一列）', () => {
  const units = [unit('a'), unit('b'), unit('c')];
  const plan = layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, [edge('a', 'b'), edge('b', 'c')]);
  const xs = ['a', 'b', 'c'].map((id) => plan.get(id).x);
  eq(new Set(xs).size, 3, '三层链条只排出 ' + new Set(xs).size + ' 列：' + xs.join());
  assert(xs[0] < xs[1] && xs[1] < xs[2], '三层的左右顺序不对：' + xs.join());
});

check('分叉：一个源头带两个下游，下游同列', () => {
  const units = [unit('a'), unit('b'), unit('c')];
  const plan = layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, [edge('a', 'b'), edge('a', 'c')]);
  eq(plan.get('b').x, plan.get('c').x, '两个下游没排在同一列');
  assert(plan.get('a').x < plan.get('b').x, '源头没排在左边');
});

check('汇合：两个源头喂一个下游，取最长的那个路径（不是最短）', () => {
  // a 单独；x → y 两级；z 同时被 y 和 a 喂
  const units = [unit('a'), unit('x'), unit('y'), unit('z')];
  const plan = layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, [
    edge('x', 'y'),
    edge('y', 'z'),
    edge('a', 'z'),
  ]);
  // z 的层数应该跟着更长的 y 走，不能跟着 a（否则 z 会和 x 挤在同一列）
  assert(plan.get('z').x > plan.get('y').x, 'z 没排到 y 后面，说明取了最短路径');
  assert(plan.get('z').x > plan.get('a').x, 'z 排到了 a 左边');
});

check('有环不死循环（A→B→A，这条要是错了页面会卡死）', () => {
  const units = [unit('a'), unit('b')];
  let plan = null;
  const started = Date.now();
  plan = layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, [edge('a', 'b'), edge('b', 'a')]);
  const cost = Date.now() - started;
  assert(plan instanceof Map, '没返回 plan');
  eq(plan.size, 2, '环上的整体漏掉了');
  assert(cost < 1000, '算了两张卡的环花了 ' + cost + 'ms，像是退化成指数递归了');
});

check('自环（自己连自己）不死循环也不算连线', () => {
  const units = [unit('a')];
  const plan = layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, [edge('a', 'a')]);
  eq(plan.size, 1);
  eq(plan.get('a').x, 0);
});

check('三张卡的三角环也能算完（三个节点互相连）', () => {
  const units = [unit('a'), unit('b'), unit('c')];
  const plan = layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, [
    edge('a', 'b'),
    edge('b', 'c'),
    edge('c', 'a'),
  ]);
  eq(plan.size, 3, '三角环漏了卡片');
});

check('长的环（20 个节点首尾相接）不卡死', () => {
  const units = [];
  const links = [];
  for (let i = 0; i < 20; i += 1) {
    units.push(unit('n' + i));
    links.push(edge('n' + i, 'n' + ((i + 1) % 20)));
  }
  const started = Date.now();
  const plan = layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, links);
  const cost = Date.now() - started;
  eq(plan.size, 20, '长环漏了节点');
  assert(cost < 2000, '20 节点的环花了 ' + cost + 'ms');
});

check('起点 follow origin（整理完不该把整块甩到别处）', () => {
  const units = [unit('a'), unit('b')];
  const plan = layout.flowPlan(units, boxesOf(units), { x: 500, y: 300 }, []);
  const xs = ['a', 'b'].map((id) => plan.get(id).x);
  const ys = ['a', 'b'].map((id) => plan.get(id).y);
  assert(Math.min.apply(null, xs) >= 500, '左边越过了 origin：' + xs.join());
  assert(Math.min.apply(null, ys) >= 300, '上边越过了 origin：' + ys.join());
});

check('同列里上下不重叠（矮的那几张不能叠在一起）', () => {
  const units = [unit('a', 200, 140), unit('b', 200, 140), unit('c', 200, 140)];
  const plan = layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, []);
  const ys = ['a', 'b', 'c'].map((id) => plan.get(id).y).sort((x, y) => x - y);
  assert(ys[1] - ys[0] >= 140, '前两张叠了：' + ys.join());
  assert(ys[2] - ys[1] >= 140, '后两张叠了：' + ys.join());
});

check('列间距与行间距确实用上了（相邻两列差 = 列宽 + 96）', () => {
  const units = [unit('a', 200, 140), unit('b', 200, 140)];
  const plan = layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, [edge('a', 'b')]);
  const gap = plan.get('b').x - plan.get('a').x;
  eq(gap, 200 + layout.COL_GAP, '两列之间的距离不对');
});

check('宽窄不一的卡片在自己那一列里水平居中', () => {
  // a 宽 100、b 宽 300，两列；列宽各自 = 自己的宽，所以两列左边界差 100+96
  const units = [unit('a', 100, 140), unit('b', 300, 140)];
  const plan = layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, [edge('a', 'b')]);
  eq(plan.get('a').x, 0, '单卡一列时不该有额外偏移');
  eq(plan.get('b').x, 100 + layout.COL_GAP, '宽卡在列里的位置不对');
});

check('空输入返回空 plan（画布上一张卡都没有）', () => {
  const plan = layout.flowPlan([], new Map(), { x: 0, y: 0 }, []);
  eq(plan.size, 0);
});

console.log('\n【gridPlan：排成网格】');

check('四张方卡排成 2×2（不是一行四个）', () => {
  const units = [unit('a', 200, 140), unit('b', 200, 140), unit('c', 200, 140), unit('d', 200, 140)];
  const plan = layout.gridPlan(units, boxesOf(units), { x: 0, y: 0 });
  const xs = new Set(['a', 'b', 'c', 'd'].map((id) => plan.get(id).x));
  const ys = new Set(['a', 'b', 'c', 'd'].map((id) => plan.get(id).y));
  assert(xs.size <= 2, '排出了 ' + xs.size + ' 列，四张卡应该不超过 2 列');
  assert(ys.size <= 2, '排出了 ' + ys.size + ' 行，四张卡应该不超过 2 行');
});

check('列数不超过卡片数（三张卡不能排出四列）', () => {
  const units = [unit('a'), unit('b'), unit('c')];
  const plan = layout.gridPlan(units, boxesOf(units), { x: 0, y: 0 });
  const xs = new Set(['a', 'b', 'c'].map((id) => plan.get(id).x));
  assert(xs.size <= 3, '三张卡排出了 ' + xs.size + ' 列');
});

check('保持原来的上下左右顺序（第一张在上/左）', () => {
  const units = [];
  for (let i = 0; i < 4; i += 1) {
    units.push(Object.assign(unit('n' + i, 200, 140), { x: i * 300, y: 0 }));
  }
  const plan = layout.gridPlan(units, boxesOf(units), { x: 0, y: 0 });
  // 按原 x 从左到右排 → n0 在最左
  assert(plan.get('n0').x <= plan.get('n1').x, 'n0 没排在 n1 左边');
});

check('扁长卡（很宽很矮）不会排成一长条', () => {
  const units = [];
  for (let i = 0; i < 12; i += 1) units.push(unit('n' + i, 400, 60));
  const plan = layout.gridPlan(units, boxesOf(units), { x: 0, y: 0 });
  const cols = new Set(units.map((one) => plan.get(one.id).x)).size;
  const rows = new Set(units.map((one) => plan.get(one.id).y)).size;
  assert(cols > 1, '扁长卡排成了一列（12 张竖着排）');
  assert(rows > 1, '扁长卡排成了一行（12 张横着排）');
});

check('竖高卡（很窄很高）也不会排成一条线', () => {
  const units = [];
  for (let i = 0; i < 12; i += 1) units.push(unit('n' + i, 120, 400));
  const plan = layout.gridPlan(units, boxesOf(units), { x: 0, y: 0 });
  const cols = new Set(units.map((one) => plan.get(one.id).x)).size;
  const rows = new Set(units.map((one) => plan.get(one.id).y)).size;
  assert(cols > 1 && rows > 1, '竖高卡排成一条线了：' + cols + ' 列 ' + rows + ' 行');
});

check('格子不重叠（相邻两张的间距不小于各自尺寸）', () => {
  const units = [];
  for (let i = 0; i < 6; i += 1) units.push(unit('n' + i, 200, 140));
  const plan = layout.gridPlan(units, boxesOf(units), { x: 0, y: 0 });
  const seen = {};
  units.forEach((one) => {
    const spot = plan.get(one.id);
    const key = spot.x + ',' + spot.y;
    assert(!seen[key], '两张卡被摆到了同一个位置：' + key);
    seen[key] = true;
  });
});

check('单张卡排在自己位置（origin 上）', () => {
  const units = [unit('only', 200, 140)];
  const plan = layout.gridPlan(units, boxesOf(units), { x: 40, y: 60 });
  eq(plan.get('only').x, 40);
  eq(plan.get('only').y, 60);
});

check('空输入返回空 plan（total=0 不能算出 NaN 列）', () => {
  const plan = layout.gridPlan([], new Map(), { x: 0, y: 0 });
  eq(plan.size, 0);
});

check('不会产出 NaN 坐标（shape = 0 之类的除零）', () => {
  const units = [unit('a', 200, 140), unit('b', 200, 140)];
  const plan = layout.gridPlan(units, boxesOf(units), { x: 0, y: 0 });
  units.forEach((one) => {
    const spot = plan.get(one.id);
    assert(Number.isFinite(spot.x), one.id + ' 的 x 是 ' + spot.x);
    assert(Number.isFinite(spot.y), one.id + ' 的 y 是 ' + spot.y);
  });
});

console.log('\n【两个算法共同守的规矩】');

check('flowPlan 与 gridPlan 都不改调用方传进来的 units / boxes', () => {
  const units = [unit('a'), unit('b')];
  const boxes = boxesOf(units);
  const before = JSON.stringify(Array.from(boxes.entries()));
  layout.flowPlan(units, boxes, { x: 0, y: 0 }, [edge('a', 'b')]);
  layout.gridPlan(units, boxes, { x: 0, y: 0 });
  eq(JSON.stringify(Array.from(boxes.entries())), before, 'boxes 被改了');
  eq(units.length, 2, 'units 被改了');
});

check('都不碰 edges 数组（排版不该把连线顺序搞乱）', () => {
  const units = [unit('a'), unit('b')];
  const links = [edge('a', 'b'), edge('b', 'a')];
  const snapshot = JSON.stringify(links);
  layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, links);
  eq(JSON.stringify(links), snapshot, 'edges 被改了');
});

check('坐标都是整数（半像素会让卡片发虚）', () => {
  const units = [unit('a', 201, 141), unit('b', 203, 143), unit('c', 199, 139)];
  [layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, [edge('a', 'b')]),
   layout.gridPlan(units, boxesOf(units), { x: 0, y: 0 })].forEach((plan, index) => {
    units.forEach((one) => {
      const spot = plan.get(one.id);
      assert(Number.isInteger(spot.x), '第 ' + (index + 1) + ' 个算法产出的小数 x：' + spot.x);
      assert(Number.isInteger(spot.y), '第 ' + (index + 1) + ' 个算法产出的小数 y：' + spot.y);
    });
  });
});

check('同一张画布算两次结果一致（不能带随机 / 依赖遍历顺序）', () => {
  const units = [];
  for (let i = 0; i < 8; i += 1) units.push(Object.assign(unit('n' + i, 200, 140), { x: (i % 3) * 250, y: i * 100 }));
  const links = [edge('n0', 'n1'), edge('n1', 'n2'), edge('n2', 'n3'), edge('n4', 'n5')];
  const one = JSON.stringify(Array.from(layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, links).entries()));
  const two = JSON.stringify(Array.from(layout.flowPlan(units, boxesOf(units), { x: 0, y: 0 }, links).entries()));
  eq(one, two, '两次结果不一样');
});

console.log('\n【与 canvas.js 的接线】');

check('canvas.js 用了 layout.js，并且留了等价兜底', () => {
  const canvas = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  assert(canvas.indexOf('window.CanvasLayout') >= 0, 'canvas.js 没接 layout.js');
  assert(/layoutKit \? layoutKit\.COL_GAP : 96/.test(canvas), '列间距没有兜底值');
  assert(/layoutKit \? layoutKit\.ROW_GAP : 56/.test(canvas), '行间距没有兜底值');
  assert(canvas.indexOf('return layoutKit.flowPlan(') >= 0, 'flowPlan 没转发');
  assert(canvas.indexOf('return layoutKit.gridPlan(') >= 0, 'gridPlan 没转发');
  assert(canvas.indexOf('return layoutKit.unitLinks(') >= 0, 'unitLinks 没转发');
});

check('flowPlan 转发时把 edges 传进去了（不传就等于没有连线）', () => {
  const canvas = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  assert(canvas.indexOf('layoutKit.flowPlan(units, boxes, origin, edges)') >= 0,
    'flowPlan 转发漏了 edges —— 排版会当成一张没有连线的画布，全部挤成一列');
});

check('canvas.html 在 canvas.js 之前加载 layout.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'canvas.html'), 'utf8');
  const at = html.indexOf('/assets/layout.js');
  const canvasAt = html.indexOf('/assets/canvas.js');
  assert(at >= 0, 'canvas.html 没引入 layout.js');
  assert(at < canvasAt, 'layout.js 排在 canvas.js 后面，加载时会取不到');
});

check('canvas.js 里不再自己实现一份（否则等于没抽）', () => {
  const canvas = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  // 兜底实现只允许出现在转发函数的 return 之后
  const forwards = (canvas.match(/return layoutKit\.(flowPlan|gridPlan|unitLinks)\(/g) || []).length;
  eq(forwards, 3, '三个转发函数没写全');
});

check('整理什么都不用动时不压历史（否则 Ctrl+Z 像坏了）', () => {
  const canvas = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const start = canvas.indexOf('function tidyLayout(');
  assert(start > 0, '找不到 tidyLayout');
  const body = canvas.slice(start, start + 3000);
  const movesAt = body.indexOf('const moves = []');
  const pushAt = body.indexOf('pushHistory()');
  const guardAt = body.indexOf('if (!moves.length)');
  assert(movesAt > 0, '没有先把位移算出来（moves）');
  assert(guardAt > 0, '缺少「一张都不用动就直接返回」的判断');
  assert(pushAt > 0, '找不到 pushHistory');
  assert(movesAt < guardAt, 'moves 应该在判断之前算好');
  assert(guardAt < pushAt,
    'pushHistory 排在「需要动吗」的判断之前 —— 空整理会往撤销栈塞一条空记录，' +
    '用户按 Ctrl+Z 会「按了没反应」');
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);