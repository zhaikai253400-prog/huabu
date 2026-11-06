'use strict';

// 吸附计算（computeSnap）的等价性测试。
//
// computeSnap 是拖拽时每帧都要跑的路径。优化它（预计算边界、去掉内层临时数组）
// 的风险在于「看起来一样，实际判定顺序变了」—— 同样近的两条线，先命中的那条会赢，
// 顺序一变，吸附位置就会跟着变。所以这里把旧实现原样留一份当参照，
// 用固定种子随机生成一堆卡片与位移，逐条比对 dx / dy / guides。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-snap-'));
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

const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');

function pickFunction(name) {
  const at = canvasSrc.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('源码里找不到函数 ' + name);
  let depth = 0;
  let started = false;
  for (let i = at; i < canvasSrc.length; i += 1) {
    const ch = canvasSrc[i];
    if (ch === '{') { depth += 1; started = true; }
    else if (ch === '}') { depth -= 1; if (started && depth === 0) return canvasSrc.slice(at, i + 1); }
  }
  throw new Error('函数 ' + name + ' 的花括号没配对');
}

// ---------- 旧实现（优化前，原样保留） ----------
// 旧实现读的是模块级环境变量，这里也给测试侧一份，与沙箱里的保持一致。
let SNAP_PX = 6;
let GRID = 10;
let viewport = { x: 0, y: 0, zoom: 1 };
const sizeOf = (node) => ({ w: node.w, h: node.h });
const OLD = function computeSnap(origin, dx, dy, statics) {
  const threshold = SNAP_PX / viewport.zoom;
  let bestX = null;
  let bestY = null;
  origin.forEach((item, index) => {
    const bounds = {
      left: item.x + dx,
      right: item.x + dx + item.node.w,
      centerX: item.x + dx + item.node.w / 2,
      top: item.y + dy,
      bottom: item.y + dy + item.node.h,
      centerY: item.y + dy + item.node.h / 2,
    };
    const selfBounds = origin.map((other) => ({
      left: other.x + dx,
      right: other.x + dx + other.node.w,
      centerX: other.x + dx + other.node.w / 2,
      top: other.y + dy,
      bottom: other.y + dy + other.node.h,
      centerY: other.y + dy + other.node.h / 2,
    }));
    statics.forEach((other) => {
      const size = sizeOf(other);
      const targets = {
        left: other.x,
        right: other.x + size.w,
        centerX: other.x + size.w / 2,
        top: other.y,
        bottom: other.y + size.h,
        centerY: other.y + size.h / 2,
      };
      const xPairs = [
        [bounds.left, targets.left], [bounds.left, targets.right], [bounds.left, targets.centerX],
        [bounds.right, targets.left], [bounds.right, targets.right], [bounds.right, targets.centerX],
        [bounds.centerX, targets.left], [bounds.centerX, targets.right], [bounds.centerX, targets.centerX],
      ];
      xPairs.forEach((pair) => {
        const diff = pair[1] - pair[0];
        if (Math.abs(diff) <= threshold && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) {
          if (selfBounds.some((box) => pair[1] > box.left - 0.5 && pair[1] < box.right + 0.5 && bounds.top < box.bottom && bounds.bottom > box.top && box !== selfBounds[index])) return;
          bestX = { diff: diff, pos: pair[1] };
        }
      });
      const yPairs = [
        [bounds.top, targets.top], [bounds.top, targets.bottom], [bounds.top, targets.centerY],
        [bounds.bottom, targets.top], [bounds.bottom, targets.bottom], [bounds.bottom, targets.centerY],
        [bounds.centerY, targets.top], [bounds.centerY, targets.bottom], [bounds.centerY, targets.centerY],
      ];
      yPairs.forEach((pair) => {
        const diff = pair[1] - pair[0];
        if (Math.abs(diff) <= threshold && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) {
          bestY = { diff: diff, pos: pair[1] };
        }
      });
    });
  });
  const guides = [];
  let finalX = dx;
  let finalY = dy;
  if (bestX) {
    finalX = dx + bestX.diff;
    guides.push({ axis: 'x', pos: bestX.pos });
  } else {
    const base = origin[0];
    finalX = Math.round((base.x + dx) / GRID) * GRID - base.x;
  }
  if (bestY) {
    finalY = dy + bestY.diff;
    guides.push({ axis: 'y', pos: bestY.pos });
  } else {
    const base = origin[0];
    finalY = Math.round((base.y + dy) / GRID) * GRID - base.y;
  }
  return { dx: finalX, dy: finalY, guides: guides };
};

const sandbox = { console: console, Array: Array, Object: Object, Math: Math, Number: Number };
vm.createContext(sandbox);
sandbox.SNAP_PX = SNAP_PX;
sandbox.GRID = GRID;
sandbox.viewport = viewport;
sandbox.sizeOf = sizeOf;
function setZoom(z) {
  viewport.zoom = z;
  sandbox.viewport = viewport;
}
vm.runInContext(pickFunction('computeSnap') + '\nglobalThis.__computeSnap = computeSnap;', sandbox);
const computeSnap = sandbox.__computeSnap;

// 可复现的伪随机（xorshift32）
let seed = 20261104;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
}
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

// 被拖动的卡片在真实代码里是 { node, x, y }：x / y 是按下时的原始位置
function makeOrigin(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      node: { id: 'o' + i, w: pick([120, 240, 360, 480]), h: pick([90, 160, 240, 320]) },
      x: Math.round(rnd() * 1200),
      y: Math.round(rnd() * 900),
    });
  }
  return out;
}
// 静止卡片就是节点本身（x / y 直接挂在节点上），与 statics 的实际形状一致
function makeStatics(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: 's' + i,
      w: pick([120, 240, 360, 480]),
      h: pick([90, 160, 240, 320]),
      x: Math.round(rnd() * 1200),
      y: Math.round(rnd() * 900),
    });
  }
  return out;
}

check('随机 300 组输入：dx / dy / guides 与旧实现完全一致', () => {
  let compared = 0;
  for (let round = 0; round < 300; round += 1) {
    const origin = makeOrigin(1 + Math.floor(rnd() * 3));
    const statics = makeStatics(1 + Math.floor(rnd() * 12));
    // 位移故意取得很小，才会频繁落进 6px 阈值里
    const dx = (rnd() - 0.5) * 12;
    const dy = (rnd() - 0.5) * 12;
    const a = OLD(origin, dx, dy, statics);
    const b = computeSnap(origin, dx, dy, statics);
    assert(a.dx === b.dx, 'dx 不一致（第 ' + round + ' 组）：旧 ' + a.dx + ' / 新 ' + b.dx);
    assert(a.dy === b.dy, 'dy 不一致（第 ' + round + ' 组）：旧 ' + a.dy + ' / 新 ' + b.dy);
    assert(JSON.stringify(a.guides) === JSON.stringify(b.guides),
      'guides 不一致（第 ' + round + ' 组）：旧 ' + JSON.stringify(a.guides) + ' / 新 ' + JSON.stringify(b.guides));
    compared += 1;
  }
  assert(compared === 300, '该比对 300 组');
});

check('缩放后阈值变化时也一致（zoom = 0.35 / 1.8）', () => {
  [0.35, 1.8].forEach((zoom) => {
    setZoom(zoom);
    for (let round = 0; round < 60; round += 1) {
      const origin = makeOrigin(1 + Math.floor(rnd() * 2));
      const statics = makeStatics(1 + Math.floor(rnd() * 8));
      const dx = (rnd() - 0.5) * 30;
      const dy = (rnd() - 0.5) * 30;
      const a = OLD(origin, dx, dy, statics);
      const b = computeSnap(origin, dx, dy, statics);
      assert(a.dx === b.dx && a.dy === b.dy && JSON.stringify(a.guides) === JSON.stringify(b.guides),
        'zoom=' + zoom + ' 第 ' + round + ' 组不一致');
    }
  });
  setZoom(1);
});

check('没有可吸附目标时回落到网格（与旧实现一致）', () => {
  setZoom(1);
  const origin = [{ node: { w: 360, h: 240 }, x: 103, y: 207 }];
  const a = OLD(origin, 3.7, -2.2, []);
  const b = computeSnap(origin, 3.7, -2.2, []);
  assert(a.dx === b.dx && a.dy === b.dy, '网格回落不一致：旧 ' + JSON.stringify(a) + ' / 新 ' + JSON.stringify(b));
  assert(b.guides.length === 0, '没有目标就不该有辅助线');
});

check('重叠保护：落点压在另一张被拖动的卡上时不吸附', () => {
  setZoom(1);
  // 两张卡一上一下叠着，目标线正好落在同伴身上
  const origin = [
    { node: { w: 200, h: 100 }, x: 0, y: 0 },
    { node: { w: 200, h: 100 }, x: 0, y: 60 },
  ];
  const statics = [{ w: 200, h: 100, x: 4, y: 400 }];
  const a = OLD(origin, 0, 0, statics);
  const b = computeSnap(origin, 0, 0, statics);
  assert(a.dx === b.dx && a.dy === b.dy, '重叠保护分支结果不一致');
});

check('生产实现里不再有内层 map / pairs 重建', () => {
  const body = pickFunction('computeSnap');
  assert(body.indexOf('origin.map(') < 0, '不该在循环里 origin.map 重算 selfBounds');
  assert(body.indexOf('const xPairs') < 0, '不该每对目标都重建 xPairs');
  assert(body.indexOf('const yPairs') < 0, '不该每对目标都重建 yPairs');
  assert(body.indexOf('selfBounds = new Array(count)') >= 0, '该预计算移动集合边界');
  assert(body.indexOf('targets = new Array(targetCount)') >= 0, '该预计算静止集合目标线');
});

console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
