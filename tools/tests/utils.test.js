'use strict';

// 共用小工具的测试（清单 38「拆分 canvas.js」第 1 步）。
//
// 这一层是纯函数，所以用最直接的方式验：喂进去、比出来。
// 另外单独守两条「拆分本身」的约束：
//   · 每个使用点都得有兜底 —— 老页面缓存里可能还没有 utils.js，
//     缺了不能让整个画布打不开；
//   · 各家页面都得真的加载了 utils.js，否则那个 window.CanvasUtils 永远是 undefined，
//     兜底一路兜到底，拆了等于没拆。
//
// 运行：runtime/node.exe tools/tests/utils.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-utils-'));
require(path.join(__dirname, '_isolate.js'))(box);

const utils = require(path.join(ROOT, 'web', 'assets', 'utils.js'));

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
function eq(got, want, msg) {
  if (got !== want) {
    throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

console.log('共用小工具（清单 38 第 1 步）');
console.log('');
console.log('【一】pad2：原来散在 8 个文件里的同一个函数');

check('个位数补零', () => {
  eq(utils.pad2(0), '00');
  eq(utils.pad2(3), '03');
  eq(utils.pad2(9), '09');
});

check('两位数原样', () => {
  eq(utils.pad2(10), '10');
  eq(utils.pad2(42), '42');
  eq(utils.pad2(99), '99');
});

check('只补不截：大数不砍（有人拿它补毫秒，必须保持三位）', () => {
  eq(utils.pad2(100), '100');
  eq(utils.pad2(999), '999');
  eq(utils.pad2(1234), '1234');
});

check('负数不截断（月份算错之类要能一眼看出来，不能悄悄变成两位）', () => {
  eq(utils.pad2(-1), '-1');
});

check('字符串进来也照办', () => {
  eq(utils.pad2('7'), '07');
});

console.log('');
console.log('【二】clamp：canvas.js 与 director.js 原来各一份');

check('区间内原样', () => {
  eq(utils.clamp(5, 0, 10), 5);
});

check('低于下界取下界', () => {
  eq(utils.clamp(-3, 0, 10), 0);
});

check('高于上界取上界', () => {
  eq(utils.clamp(99, 0, 10), 10);
});

check('上下界相等时恒等于那个值', () => {
  eq(utils.clamp(5, 7, 7), 7);
  eq(utils.clamp(9, 7, 7), 7);
});

check('NaN 原样穿出（不兜住，调用方要自己先 num()）', () => {
  // 把这条行为写下来：Math.min(10, Math.max(0, NaN)) 就是 NaN。
  // 用 clamp 的地方都是坐标与尺寸，调用方必须先走 num()/int() 兜底。
  // 断言在这里是为了让下一个用它的人知道别指望 clamp 挡 NaN。
  ok(Number.isNaN(utils.clamp(NaN, 0, 10)), 'clamp 对 NaN 的行为变了');
  eq(utils.clamp(utils.num(NaN, 0), 0, 10), 0, '先 num() 再 clamp 就该是安全的');
});

console.log('');
console.log('【三】num / int：坐标与尺寸的兜底');

check('num 取不到有限数就用兜底值', () => {
  eq(utils.num('12', 0), 12);
  eq(utils.num('abc', -1), -1);
  eq(utils.num(null, 5), 5);
  eq(utils.num(Infinity, 7), 7);
  eq(utils.num(NaN, 3), 3);
});

check('int 四舍五入后兜底', () => {
  eq(utils.int(12.4, 0), 12);
  eq(utils.int(12.6, 0), 13);
  eq(utils.int(-12.6, 0), -13);
  eq(utils.int('x', 9), 9);
  eq(utils.int(Infinity, 4), 4);
});

console.log('');
console.log('【四】时间格式化：原来 8 处各写各的');

// 用固定的本地时间去比，避免时区/夏令时把测试搞成随机失败
const at = (y, mo, d, h, mi, s, ms) => new Date(y, mo - 1, d, h, mi, s, ms || 0);

check('clockTime 是 时:分:秒', () => {
  eq(utils.clockTime(at(2026, 11, 3, 9, 5, 7)), '09:05:07');
});

check('shortStamp 是 月-日 时:分', () => {
  eq(utils.shortStamp(at(2026, 11, 3, 9, 5, 7)), '11-03 09:05');
});

check('fullStamp 是 年-月-日 时:分', () => {
  eq(utils.fullStamp(at(2026, 11, 3, 9, 5, 7)), '2026-11-03 09:05');
});

check('stamp 默认只给时间，带日期时用下划线连', () => {
  eq(utils.stamp(at(2026, 11, 3, 9, 5, 7, 123)), '09-05-07');
  eq(utils.stamp(at(2026, 11, 3, 9, 5, 7, 123), false, true), '2026-11-03_09-05-07');
});

check('stamp 补毫秒时是三位（同一秒内连写两份不撞名）', () => {
  eq(utils.stamp(at(2026, 11, 3, 9, 5, 7, 7), true), '09-05-07-007');
  eq(utils.stamp(at(2026, 11, 3, 9, 5, 7, 123), true), '09-05-07-123');
});

check('坏时间给出空串，不给 Invalid Date，也不假装成「现在」', () => {
  // 这条是真发现问题的地方。第一版写成 new Date(Number(value) || Date.now())：
  //   · 空串的 Number() 是 0 → 变成 1970 年
  //   · 坏字符串的 Number() 是 NaN → 被 || 兜成「现在」
  // 两种都会把「这份数据的时间是坏的」伪装成一个看着正常的时间。
  // 历史版本列表如果拿到假时间，用户会以为某份备份是刚生成的。
  eq(utils.clockTime('这不是时间'), '');
  eq(utils.shortStamp('这不是时间'), '');
  eq(utils.fullStamp('这不是时间'), '');
  eq(utils.stamp('这不是时间'), '');
  eq(utils.clockTime(''), '', '空串不该变成 1970 年');
  eq(utils.shortStamp(''), '');
  eq(utils.clockTime(new Date('坏')), '');
  eq(utils.clockTime({}), '');
});

check('时间戳认得像样的输入（数字、数字串、Date）', () => {
  const base = at(2026, 11, 3, 9, 5, 7).getTime();
  eq(utils.clockTime(base), '09:05:07');
  eq(utils.clockTime(String(base)), '09:05:07');
  eq(utils.clockTime(at(2026, 11, 3, 9, 5, 7)), '09:05:07');
});

check('不传参数用「现在」，且不会抛出', () => {
  ['clockTime', 'shortStamp', 'fullStamp', 'stamp'].forEach((name) => {
    const out = utils[name]();
    ok(typeof out === 'string' && out.length > 0, name + ' 没给出结果');
  });
});

console.log('');
console.log('【五】humanSize / clip');

check('humanSize 分级', () => {
  eq(utils.humanSize(0), '0 B');
  eq(utils.humanSize(512), '512 B');
  eq(utils.humanSize(1024), '1.0 KB');
  eq(utils.humanSize(1536), '1.5 KB');
  eq(utils.humanSize(1024 * 1024), '1.0 MB');
  eq(utils.humanSize(1024 * 1024 * 1024), '1.00 GB');
});

check('clip 不超长时原样，超长补省略号', () => {
  eq(utils.clip('一二三', 5), '一二三');
  eq(utils.clip('一二三四五', 3), '一二三…');
  eq(utils.clip('', 3), '');
});

check('clip 的 max 是坏值时不当场截光', () => {
  eq(utils.clip('一二三', 0), '一二三');
  eq(utils.clip('一二三', -1), '一二三');
  eq(utils.clip('一二三', 'x'), '一二三');
});

check('textWidth：中文算 2、英文算 1', () => {
  eq(utils.textWidth('abc'), 3);
  eq(utils.textWidth('中文'), 4);
  eq(utils.textWidth('a中'), 3);
  eq(utils.textWidth(''), 0);
});

check('clipByWidth 按显示宽度截，不把中文从中间劈开', () => {
  eq(utils.clipByWidth('abcde', 3), 'abc…');
  eq(utils.clipByWidth('中文字', 4), '中文…');
  // 宽度 3 放不下一个中文（要 2），能放一个英文（要 1）
  eq(utils.clipByWidth('中', 1), '…');
  eq(utils.clipByWidth('a中', 3), 'a中');
});

console.log('');
console.log('【六】debounce / throttle');

// 计时器类的验证统一走 async 段，避免「check 是同步的、里面的断言其实没跑到」

console.log('');
console.log('【七】拆分本身的两条约束');

const htmlFiles = ['canvas.html', 'index.html', 'channels.html', 'launcher.html'];
htmlFiles.forEach((name) => {
  check(name + ' 加载了 utils.js，且排在 api.js 之前', () => {
    const src = fs.readFileSync(path.join(ROOT, 'web', name), 'utf8');
    const utilsAt = src.indexOf('/assets/utils.js');
    const apiAt = src.indexOf('/assets/api.js');
    ok(utilsAt >= 0, name + ' 没有引入 utils.js');
    ok(apiAt < 0 || utilsAt < apiAt, name + ' 里 utils.js 排在 api.js 之后（它是最底层，应该更早）');
  });
});

const consumers = ['canvas.js', 'director.js', 'channels.js', 'chstatus.js', 'library.js', 'portal.js', 'tasks.js'];
consumers.forEach((name) => {
  check(name + ' 引用了共用模块且留了兜底', () => {
    const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', name), 'utf8');
    ok(src.indexOf('CanvasUtils') >= 0, name + ' 没有引用 window.CanvasUtils');
    // 兜底的样子：`|| {` 或 `? util.xxx :` 这类显式回落。只要有 CanvasUtils 出现在
    // 一个逻辑或/条件里，就说明它没把「脚本没加载」当成不可能。
    const hasFallback =
      /\|\|\s*\{/.test(src.slice(src.indexOf('CanvasUtils'), src.indexOf('CanvasUtils') + 200)) ||
      /CanvasUtils\s*\|\|/.test(src) ||
      /&&\s*window\.CanvasUtils/.test(src) ||
      /util\s*\?/.test(src);
    ok(hasFallback, name + ' 没有兜底实现：老页面缓存里还没有 utils.js 时会整块打不开');
  });
});

check('canvas.js 里已经不再自己写 pad 实现', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const own = src.match(/const pad = \([a-z]+\) => String\([a-z]+\)\.padStart\(2, '0'\)/g) || [];
  eq(own.length, 0, '还有 ' + own.length + ' 处自己写的 pad 实现');
});

check('各页面脚本里已没有第二种 pad 写法', () => {
  const offenders = [];
  ['channels.js', 'chstatus.js', 'library.js', 'portal.js', 'tasks.js', 'canvas.js'].forEach((name) => {
    const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', name), 'utf8');
    if (/\(n < 10 \? '0' \+ n : String\(n\)\)/.test(src)) offenders.push(name);
    if (/[a-z] = \([a-z]+\) => String\([a-z]+\)\.padStart\(2, '0'\)/.test(src)) offenders.push(name);
  });
  eq(offenders.join(','), '', '这些文件里还留着各自的 pad 实现：' + offenders.join('、'));
});

console.log('');

// ---- 计时器相关的验证必须等真实的时间过去，所以放在最后单独跑 ----
function report() {
  console.log('');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

(async () => {
  console.log('【六】debounce / throttle（这几条要等真实时间）');

  await new Promise((resolve) => {
    const seen = [];
    const fn = utils.debounce((v) => seen.push(v), 10);
    fn(1);
    fn(2);
    fn(3);
    check('debounce 连续调用时处于等待状态', () => ok(fn.pending(), '应该还在等待中'));
    setTimeout(() => {
      check('debounce 只跑最后一次，且用最后一次的参数', () => {
        eq(seen.length, 1, '应该只跑一次');
        eq(seen[0], 3, '应该用最后一次的参数');
        ok(!fn.pending(), '跑完不该还挂着等待');
      });
      resolve();
    }, 60);
  });

  await new Promise((resolve) => {
    const seen = [];
    const fn = utils.debounce((v) => seen.push(v), 10);
    fn(1);
    check('debounce 的 cancel 报告真的取消了', () => eq(fn.cancel(), true));
    check('没有待执行时 cancel 给 false', () => eq(fn.cancel(), false));
    setTimeout(() => {
      check('取消之后不该再跑', () => eq(seen.length, 0));
      resolve();
    }, 60);
  });

  check('throttle 第一次立刻跑，间隔内不再跑', () => {
    const seen = [];
    const fn = utils.throttle((v) => seen.push(v), 1000);
    eq(fn(1), true);
    eq(fn(2), false);
    eq(fn(3), false);
    eq(seen.length, 1);
    eq(seen[0], 1);
  });

  await new Promise((resolve) => {
    const seen = [];
    const fn = utils.throttle((v) => seen.push(v), 20);
    fn('a');
    setTimeout(() => {
      const second = fn('b');
      check('throttle 过了间隔后放行下一次', () => {
        eq(second, true, '过了间隔该放行了');
        eq(seen.join(','), 'a,b');
      });
      resolve();
    }, 60);
  });

  report();
})();

