'use strict';

// 清单 38 第 4 步 · @ 引用语法模块专项测试。
//
// material-number.test.js 测的是「换号 / 删素材」这条业务路走不走得通；
// 这个文件只测**语法本身**：两种写法怎么互转、怎么认、怎么摘、送接口前怎么收拾。
//
// 为什么值得单独一个文件：这块代码原来是**同一个正则抄了 12 遍**
// （canvas.js 11 处 + server/generate.js 1 处），抄错的地方不报错，只在某些数据上悄悄算错。
// 两个最容易抄错的点，就是这里要盯死的：
//
//   1. 「快速视频」必须排在「视频」前面。写成 /@(视频|快速视频)(\d+)/ 的话，
//      「@快速视频1」会先撞上「视频」→ 认成「视频1」→ 用户引的是快速视频，
//      系统却去找一张普通视频卡。**在只有普通视频的画布上永远复现不了**。
//   2. retag 遇到「没有新号的标签」要返回非字符串（null）才能保留原文。
//      返回 '' 会被 mapRaw 当成「替换成空」，引用直接消失 —— 而 mapRaw 的
//      空值语义又恰好是 strip 需要的，两处共用一条路，很容易改坏一头。
//
// 运行：runtime/node.exe tools/tests/refs.test.js

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const mod = require(path.join(ROOT, 'web', 'assets', 'refs.js'));

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
function eqList(got, want, msg) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error((msg || '列表不相等') + '：拿到 ' + a + '，期望 ' + b);
}

console.log('\n清单 38 第 4 步 · @ 引用语法（refs.js）');

console.log('\n[1] 导出与基本形状');

check('导出清单完整', () => {
  const want = [
    'broken',
    'dropAll',
    'eachRaw',
    'forApi',
    'mapRaw',
    'parse',
    'rawPattern',
    'retag',
    'retagShown',
    'startsWithTag',
    'strip',
    'tagsOf',
    'tidy',
    'toRaw',
    'toShown',
  ].sort().join(',');
  eq(Object.keys(mod).sort().join(','), want, '导出项多了或少了');
});

check('没有挂着浏览器 / Node 的宿主对象（纯模块）', () => {
  const src = fs
    .readFileSync(path.join(ROOT, 'web', 'assets', 'refs.js'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  ['window.', 'document.', 'navigator.', 'setTimeout', 'setInterval', 'fetch('].forEach((token) => {
    assert(src.indexOf(token) < 0, '源码里出现了宿主 API：' + token);
  });
});

check('rawPattern 每次给的是新实例（带 /g 的正则有 lastIndex）', () => {
  const a = mod.rawPattern();
  const b = mod.rawPattern();
  assert(a !== b, '两次拿到同一个正则实例，交替调用会漏匹配');
  assert(a.global, '应该是带 /g 的');
});

check('rawPattern 之间互不干扰：交替 exec 不丢匹配', () => {
  const text = '@[图1] 和 @[图2]';
  const a = mod.rawPattern();
  const b = mod.rawPattern();
  eq(a.exec(text)[1], '图1');
  eq(b.exec(text)[1], '图1', '另一个实例被上一个的 lastIndex 影响了');
  eq(a.exec(text)[1], '图2');
});

console.log('\n[2] 内部写法 @[图1] ⇄ 给人看的 @图1');

check('toShown：@[图1] → @图1', () => {
  eq(mod.toShown('把 @[图1] 和 @[视频1] 合成'), '把 @图1 和 @视频1 合成');
});

check('toShown 不会把已有的一段文字搞坏（无引用时原样返回）', () => {
  eq(mod.toShown('普通一句话'), '普通一句话');
});

check('toShown 空值安全', () => {
  eq(mod.toShown(null), '');
  eq(mod.toShown(undefined), '');
  eq(mod.toShown(''), '');
});

check('toRaw：只认 known 里真实存在的标签', () => {
  eq(mod.toRaw('用 @图1 和 @图2 合成', ['图1']), '用 @[图1] 和 @图2 合成', '不存在的 @图2 不该被转成引用');
});

check('toRaw 认 Set 也认数组', () => {
  eq(mod.toRaw('用 @图1 合成', new Set(['图1'])), '用 @[图1] 合成');
});

check('toRaw 空 known：什么也不转（不许把用户随手写的 @ 变成引用）', () => {
  eq(mod.toRaw('@图1 你好', []), '@图1 你好');
  eq(mod.toRaw('@图1 你好', null), '@图1 你好');
});

check('toRaw 幂等：已经是内部写法的不会被再包一层', () => {
  eq(mod.toRaw('用 @[图1] 合成', ['图1']), '用 @[图1] 合成');
});

console.log('\n[3] 「快速视频」必须排在「视频」前面（抄错就静默认错卡片）');

check('toRaw 认的是「快速视频1」而不是「视频1」', () => {
  eq(mod.toRaw('用 @快速视频1', ['快速视频1']), '用 @[快速视频1]');
});

check('toRaw：@快速视频1 绝不能被认成 @视频1', () => {
  // 只把「视频1」标成存在、「快速视频1」不存在 —— 抄错顺序的话这里会错误地转成引用
  eq(mod.toRaw('用 @快速视频1', ['视频1']), '用 @快速视频1', '把快速视频1 认成了 视频1');
});

check('parse：@快速视频1 给出的标签是「快速视频1」', () => {
  eqList(mod.parse('用 @快速视频1', ['快速视频1']), ['快速视频1']);
});

check('parse：@视频1 不受影响（长短词并存）', () => {
  eqList(mod.parse('用 @视频1 和 @快速视频1', ['视频1', '快速视频1']), ['视频1', '快速视频1']);
});

check('strip 按给人看的写法摘，也不会把「快速视频1」错认成「视频1」', () => {
  eq(mod.strip('用 @快速视频1 合成', ['视频1'], 'shown'), null, '把快速视频1 误当成 视频1 摘了');
  eq(mod.strip('用 @快速视频1 合成', ['快速视频1'], 'shown'), '用 合成');
});

check('retagShown 同样按长词优先', () => {
  eq(
    mod.retagShown('用 @快速视频2', new Map([['快速视频2', '快速视频1']])),
    '用 @快速视频1',
    '快速视频被当成了普通视频换号'
  );
});

console.log('\n[4] mapRaw / eachRaw / tagsOf 三个底座');

check('eachRaw：没有 @[ 时先跳过，回调一次也不进', () => {
  let calls = 0;
  const hit = mod.eachRaw('普通一句话', () => {
    calls += 1;
  });
  eq(hit, false, '应报告「没命中」');
  eq(calls, 0, '不该进回调');
});

check('eachRaw 把标签、整段、下标都给出来', () => {
  const seen = [];
  mod.eachRaw('A @[图1] B @[视频2]', (tag, whole, index) => {
    seen.push([tag, whole, index]);
  });
  eqList(seen, [
    ['图1', '@[图1]', 2],
    ['视频2', '@[视频2]', 10],
  ]);
});

check('eachRaw 遇到空壳 @[] 不认（里面至少要一个字）', () => {
  eqList(mod.tagsOf('空的 @[] 不算'), []);
});

check('tagsOf 按出现顺序、去重', () => {
  eqList(mod.tagsOf('@[图2] @[图1] @[图2]'), ['图2', '图1']);
});

check('mapRaw 回调返回字符串就替换，返回假值就保留原样', () => {
  eq(
    mod.mapRaw('@[图1] @[图2]', (tag) => (tag === '图1' ? '@X' : null)),
    '@X @[图2]'
  );
});

check('mapRaw 回调返回空串**也是**「替换成空」（这是 strip 依赖的行为）', () => {
  eq(mod.mapRaw('A @[图1] B', () => ''), 'A  B');
});

check('tagsOf 能处理 null / undefined / 数字', () => {
  eqList(mod.tagsOf(null), []);
  eqList(mod.tagsOf(undefined), []);
  eqList(mod.tagsOf(123), []);
});

console.log('\n[5] retag：换号时「没有新号的标签」必须原样留着');

check('retag 把旧号换成新号', () => {
  eq(
    mod.retag('用 @[图2] 和 @[图3] 合成', new Map([['图2', '图1'], ['图3', '图2']])),
    '用 @[图1] 和 @[图2] 合成'
  );
});

check('retag：映射表里没有的标签**原样保留**（不能凭空消失）', () => {
  eq(mod.retag('用 @[图1] 和 @[图9] 合成', new Map([['图1', '图2']])), '用 @[图2] 和 @[图9] 合成');
});

check('retag 认普通对象当映射表', () => {
  eq(mod.retag('用 @[图1]', { 图1: '图2' }), '用 @[图2]');
});

check('retag 空映射表：原样返回', () => {
  eq(mod.retag('用 @[图1]', new Map()), '用 @[图1]');
  eq(mod.retag('用 @[图1]', {}), '用 @[图1]');
});

check('retag 连环换号不会踩自己（先算完再写）', () => {
  // 图2→图1、图3→图2：一次扫完，图3 不会被刚换好的「图1」影响
  eq(
    mod.retag('@[图2] @[图3]', new Map([['图2', '图1'], ['图3', '图2']])),
    '@[图1] @[图2]'
  );
});

check('retagShown 换给人看的写法', () => {
  eq(mod.retagShown('用 @图2 合成', new Map([['图2', '图1']])), '用 @图1 合成');
});

check('retagShown：没有新号的保持原样', () => {
  eq(mod.retagShown('用 @图2 和 @图9', new Map([['图2', '图1']])), '用 @图1 和 @图9');
});

check('retagShown 空映射表 / 没有 @ 时原样返回', () => {
  eq(mod.retagShown('用 @图1', new Map()), '用 @图1');
  eq(mod.retagShown('普通一句话', new Map([['图1', '图2']])), '普通一句话');
});

console.log('\n[6] strip：摘掉失效引用，没摘到要如实说「没摘」');

check('strip 摘内部写法', () => {
  eq(mod.strip('用 @[图1] 和 @[图2] 合成', ['图1'], 'raw'), '用 和 @[图2] 合成');
});

check('strip 摘给人看的写法', () => {
  eq(mod.strip('用 @图1 和 @图2 合成', ['图1'], 'shown'), '用 和 @图2 合成');
});

check('strip 没摘掉任何东西时返回 null（调用方据此跳过写回）', () => {
  eq(mod.strip('用 @[图2] 合成', ['图1'], 'raw'), null);
  eq(mod.strip('普通一句话', ['图1'], 'raw'), null);
});

check('strip 要摘的集合为空时直接返回 null', () => {
  eq(mod.strip('用 @[图1] 合成', [], 'raw'), null);
  eq(mod.strip('用 @[图1] 合成', null, 'raw'), null);
});

check('strip 只收「两个及以上空格」，单个空格是用户排版', () => {
  eq(mod.strip('用 @[图1] 合成', ['图1'], 'raw'), '用 合成');
  eq(mod.strip('a @[图1] b', ['图1'], 'raw'), 'a b', '摘掉后两边各一个空格，应收成一个');
});

check('strip 收完顺手去掉首尾空白', () => {
  eq(mod.strip('@[图1] 开头', ['图1'], 'raw'), '开头');
  eq(mod.strip('结尾 @[图1]', ['图1'], 'raw'), '结尾');
});

check('strip 不误伤没被删的号', () => {
  eq(mod.strip('@[图1] @[图2] @[图3]', ['图2'], 'raw'), '@[图1] @[图3]');
});

check('strip 默认按内部写法处理（style 不填 = raw）', () => {
  eq(mod.strip('用 @[图1] 合成', ['图1']), '用 合成');
});

check('strip 一次摘掉重复出现的同一个号', () => {
  eq(mod.strip('@[图1] 和 @[图1] 都摘', ['图1'], 'raw'), '和 都摘');
});

check('tidy：只收两个及以上空格，单个不动', () => {
  eq(mod.tidy('  a  b c  '), 'a b c');
  eq(mod.tidy('a\t\tb'), 'a b');
  eq(mod.tidy('a b'), 'a b');
});

check('tidy 空值安全', () => {
  eq(mod.tidy(null), '');
  eq(mod.tidy(undefined), '');
});

console.log('\n[7] dropAll：导出文件名那种「整段抹掉」');

check('dropAll 把引用整段抹掉', () => {
  eq(mod.dropAll('一只猫 @[图1] 在跑', ' '), '一只猫   在跑');
});

check('dropAll 连空壳 @[] 一起抹（正则用 * 不用 +）', () => {
  eq(mod.dropAll('a @[] b', ''), 'a  b');
});

check('dropAll 没有引用时原样返回', () => {
  eq(mod.dropAll('普通一句话', ' '), '普通一句话');
});

console.log('\n[8] broken：报出提示词里已经失效的引用');

check('broken 返回失效标签（去重、按出现顺序）', () => {
  eqList(mod.broken('用 @[图1] 和 @[图9] 还有 @[图1]', ['图1']), ['图9']);
});

check('broken 全都在时返回空数组', () => {
  eqList(mod.broken('用 @[图1]', ['图1']), []);
});

check('broken 没有引用时返回空数组', () => {
  eqList(mod.broken('普通一句话', ['图1']), []);
});

console.log('\n[9] parse：手打的 @图1 也要能认出来');

check('parse 优先认内部写法', () => {
  eqList(mod.parse('用 @[图1]', ['图1']), ['图1']);
});

check('parse 找不到内部写法再按给人看的写法找', () => {
  eqList(mod.parse('用 @图1', ['图1']), ['图1']);
});

check('parse：known 非空时不认不存在的号', () => {
  eqList(mod.parse('用 @图9', ['图1']), []);
});

check('parse：known 为空时不设限（快速视频卡片走这条）', () => {
  eqList(mod.parse('用 @图1', []), ['图1']);
  eqList(mod.parse('用 @图1'), ['图1']);
});

check('parse 去重', () => {
  eqList(mod.parse('@图1 和 @图1', ['图1']), ['图1']);
});

console.log('\n[10] forApi：送接口前收拾');

check('forApi 把 @[图1] 变成「图1」', () => {
  eq(mod.forApi('用 @[图1] 合成'), '用 图1 合成');
});

check('forApi 把半截的 @图 去掉那个 @（不容许平台看见孤零零的 @）', () => {
  eq(mod.forApi('用 @图 合成'), '用 图 合成');
  eq(mod.forApi('@视频'), '视频');
});

check('forApi 不管普通文字里的 @（只在后面跟着类型词时才动）', () => {
  eq(mod.forApi('邮箱 a@b.com'), '邮箱 a@b.com');
  eq(mod.forApi('@ 单独一个'), '@ 单独一个');
});

check('forApi 保留没有方括号的完整引用写法（平台认「图1」这样的名字）', () => {
  eq(mod.forApi('用 @图1 合成'), '用 图1 合成');
});

check('forApi 空值安全', () => {
  eq(mod.forApi(null), '');
  eq(mod.forApi(undefined), '');
});

console.log('\n[11] startsWithTag：@ 菜单筛半截类型');

check('空 token 全放行', () => {
  eq(mod.startsWithTag('图1', ''), true);
  eq(mod.startsWithTag('图1', null), true);
});

check('按前缀比', () => {
  eq(mod.startsWithTag('图1', '图'), true);
  eq(mod.startsWithTag('快速视频1', '快'), true);
  eq(mod.startsWithTag('视频1', '图'), false);
});

check('后缀不算前缀', () => {
  eq(mod.startsWithTag('图1', '1'), false);
});

console.log('\n[12] 源码级约束：不要再抄第 13 份正则');

check('canvas.js 里的 @ 引用正则只剩兜底那一块', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const hits = src.match(/\/@\\\[/g) || [];
  // 兜底块（REFS_FALLBACK）里有 6 处，dropAll 用 * 单独算一处，共 7 处
  assert(hits.length <= 8, 'canvas.js 里还散着 ' + hits.length + ' 处 @[ 正则，应该收敛到模块里');
});

check('server/generate.js 走 refs.forApi，不再自己抄一份', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'generate.js'), 'utf8');
  assert(src.indexOf("require('../web/assets/refs.js')") >= 0, '服务端没有引用共用的 refs 模块');
  assert(src.indexOf('refs.forApi(text)') >= 0, 'promptForApi 没有走共用实现');
  assert(!/\.replace\(\/@\\\[/.test(src), '服务端还留着自己的 @[ 正则');
});

check('canvas.html 在 canvas.js 之前加载 refs.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'canvas.html'), 'utf8');
  const refsAt = html.indexOf('/assets/refs.js');
  const canvasAt = html.indexOf('/assets/canvas.js');
  assert(refsAt > 0, 'canvas.html 里没有加载 refs.js');
  assert(refsAt < canvasAt, 'refs.js 必须在 canvas.js 之前加载，否则兜底分支会被走满');
  // history.js 也在前（第 3 步的约定），顺序保持稳定
  assert(html.indexOf('/assets/history.js') < refsAt, 'history.js 应排在 refs.js 前面');
});

check('canvas.js 用的是 window.CanvasRefs，并且句柄不叫 refs（防误读）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  assert(src.indexOf('window.CanvasRefs || REFS_FALLBACK') >= 0, '没接上模块或没留兜底');
  assert(!/const refs = window\.CanvasRefs/.test(src), '句柄叫 refs 会和「参考素材数组」混在一起');
});

// ---------------------------------------------------------------- 汇总
console.log('\n' + '─'.repeat(52));
if (fail) {
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exitCode = 1;
} else {
  console.log('全部通过：共 ' + pass + ' 项');
}
