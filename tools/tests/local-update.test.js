'use strict';

// 第 5 步的**永久护栏**：那 4 条高频路径不能再退回 renderAll()。
//
// 为什么需要它：验收脚本在 `.tmp-test/`，而那个目录是 gitignore 的 ——
// 就是说真浏览器里那些证据**不会跟着仓库走**，将来谁（包括我自己）顺手把
// `hideSelection` 改回 `renderAll()`，没有任何测试会红。
// 而这类退化的代价很实在：300 张卡时按一次 Ctrl+L 会重建 300 个节点、
// 所有图片视频重新解码、整片闪一下。所以把「不许退回」写成可执行的断言。
//
// 这里只做**源码级**判断（结构性的、确定性的），跑得快、零依赖。
// 「改完之后 UI 对不对」由浏览器验收脚本负责，两者互补。
//
// 运行：runtime/node.exe tools/tests/local-update.test.js

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');

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

// 剥注释：**只剥整行注释**，不做通用词法分析。
//
// 为什么不上正则/词法器：canvas.js 的字符串里就带着 `/*` 与 `//`
// —— 例如文件选择框的 accept 是 `'image/*,video/*,audio/*'`，
// 于是一个 `/\/\*[\s\S]*?\*\//` 会从那里一路吃到下一个 `*/`，
// 把几万字符的真实代码整段吞掉（我第一版就是这样，函数"凭空消失"、测试自己报了 7 个假失败）。
// 自己写状态机也不行：还要区分"正则字面量"与"除法"，那是另一个坑。
//
// 用一条简单且**可验证**的规则：只看「整行注释」。
// 本文件里所有提到 renderAll 的注释都是独占一行的（实测 6 处全是），
// 所以这条规则足够。为了让规则失效时能立刻发现，下面有一条自检：
// 如果哪天出现"行内注释里带 renderAll()"，自检会红，提示换更严谨的做法。
function stripFullLineComments(text) {
  return text
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}
const CODE = stripFullLineComments(SRC);
const CODE_LINES = CODE.split('\n');

// 自检：剥完之后，还有没有"行内注释里的 renderAll(" 会被误判？
// （整行注释已剥，剩下的若还有 renderAll 出现在 // 之后，说明规则不够用了）
(function selfCheck() {
  const suspicious = CODE_LINES.filter((l) => {
    const at = l.indexOf('//');
    return at >= 0 && l.indexOf('renderAll(', at) >= 0;
  });
  if (suspicious.length) {
    console.log('  ! 自检失败：有 ' + suspicious.length + ' 行在行内注释里带 renderAll(');
    suspicious.slice(0, 3).forEach((l) => console.log('      ' + l.trim()));
    console.log('    → 只剥整行注释的规则已不够用，这个测试需要改成更严谨的解析方式');
  }
}());

function bodyOf(name) {
  const start = CODE_LINES.findIndex((l) => l.indexOf('function ' + name + '(') >= 0);
  if (start < 0) return null;
  let depth = 0;
  let seen = false;
  const out = [];
  for (let i = start; i < CODE_LINES.length; i += 1) {
    depth += (CODE_LINES[i].match(/\{/g) || []).length - (CODE_LINES[i].match(/\}/g) || []).length;
    if (depth > 0) seen = true;
    out.push(CODE_LINES[i]);
    if (seen && depth <= 0) break;
  }
  return { line: start + 1, text: out.join('\n') };
}

console.log('L1 · 4 条高频路径不许退回全量重建');

const SITES = [
  ['setLocked', ['syncLockMark', 'paintFilter', 'refreshSelection', 'scheduleSave']],
  ['hideSelection', ['unmountNode', 'updateEdgePaths', 'refreshHiddenBadge', 'scheduleSave']],
  ['pasteClipboard', ['mountNode', 'renderEdges', 'refreshSelection', 'scheduleSave']],
  ['startZoneResize', ['refreshNode', 'updateEdgePaths', 'scheduleSave']],
];

SITES.forEach(([name, needed]) => {
  check(name + '：不再调用 renderAll()', () => {
    const b = bodyOf(name);
    assert.ok(b, '没找到函数 ' + name + '（被改名或删掉了？）');
    assert.ok(
      !/renderAll\s*\(\s*\)/.test(b.text),
      name + ' 又走回 renderAll() 了（第 ' + b.line + ' 行起）——' +
        '这会让每次操作重建全画布所有卡片，几百张卡时所有图片视频重新解码、整片闪一下'
    );
  });
  check(name + '：收尾工作齐全', () => {
    const b = bodyOf(name);
    assert.ok(b, '没找到函数 ' + name);
    const missing = needed.filter((n) => b.text.indexOf(n) < 0);
    assert.deepStrictEqual(missing, [],
      name + ' 少了收尾调用：' + missing.join(', ') + ' —— 局部更新最容易漏刷，漏了不报错、只会悄悄不对');
  });
});

console.log('\nL2 · 局部更新的两个新入口必须成对存在');

check('mountNode / unmountNode 都定义了', () => {
  assert.ok(bodyOf('mountNode'), 'mountNode 没了');
  assert.ok(bodyOf('unmountNode'), 'unmountNode 没了');
});

check('mountNode 会登记到 elements（否则后续刷新找不到这张卡）', () => {
  const b = bodyOf('mountNode');
  assert.ok(/elements\.set\(/.test(b.text), 'mountNode 没有把新元素写进 elements 映射');
  assert.ok(/worldEl\.appendChild\(/.test(b.text), 'mountNode 没有把元素挂到画布上');
});

check('mountNode 不挂隐藏的卡片（与 renderNodes 的判断一致）', () => {
  const b = bodyOf('mountNode');
  assert.ok(/isHidden\(/.test(b.text),
    'mountNode 没有跳过隐藏卡片 —— 隐藏的卡片会被重新画到画布上');
});

check('unmountNode 会从 elements 里摘掉（否则留下悬空引用）', () => {
  const b = bodyOf('unmountNode');
  assert.ok(/elements\.delete\(/.test(b.text), 'unmountNode 没有清 elements 映射');
  assert.ok(/\.remove\(\)/.test(b.text), 'unmountNode 没有把元素从 DOM 上摘掉');
});

console.log('\nL3 · 层叠顺序不依赖 DOM 插入顺序（local 更新才能安全 append）');

check('buildNode 里给每张卡写了显式 z-index', () => {
  // 必须**限定在 buildNode 的函数体里**判断。
  // 我第一版图省事用了全文件正则，结果 applyZOrder 里也有同样一行，
  // 于是"把 buildNode 那份删掉"这种退化测不出来（变异检验 M11 抓到过这个洞）。
  const b = bodyOf('buildNode');
  assert.ok(b, '没找到 buildNode');
  assert.ok(/el\.style\.zIndex\s*=\s*String\(zIndexOf\(/.test(b.text),
    'buildNode 不再写 style.zIndex —— 那么 appendChild 的顺序就会决定层叠，' +
    '局部更新挂到末尾的卡片会盖住别人');
});

check('refreshSelection 里会重排 z（粘贴后新卡片要靠它回到最上层）', () => {
  const b = bodyOf('refreshSelection');
  assert.ok(b, '没找到 refreshSelection');
  assert.ok(/applyZOrder\s*\(/.test(b.text),
    'refreshSelection 不再调 applyZOrder —— 粘贴/锁定后新卡片的 z 可能停在旧值');
});

console.log('\nL4 · 锁形图标只有一个来源（避免两处各画一份、将来改一处忘一处）');

check('buildLockMark 定义了', () => {
  assert.ok(bodyOf('buildLockMark'), 'buildLockMark 没了');
});

check('创建 .node-lock 的地方只有 buildLockMark 一处', () => {
  // 注意：'node-lock' 正常会出现两次 —— 一次在 buildLockMark 里**创建**（className =），
  // 一次在 syncLockMark 里**查找**（directChildOf）。所以判据是
  // 「只允许这一对，且创建的那个必须在 buildLockMark 里」，
  // 而不是「整个文件只出现一次」（我第一版就是这么写的，把自己写对了的代码判成失败）。
  const createHits = (SRC.match(/className\s*=\s*['"]node-lock['"]/g) || []).length;
  assert.strictEqual(createHits, 1,
    "canvas.js 里有 " + createHits + " 处用 className 创建 'node-lock' —— 应当只有 buildLockMark 一处，" +
    '否则将来改图标会漏掉一份');
  const b = bodyOf('buildLockMark');
  assert.ok(b, '没找到 buildLockMark');
  assert.ok(/className\s*=\s*['"]node-lock['"]/.test(b.text),
    "唯一创建 'node-lock' 的地方不在 buildLockMark 里");
  // 查找也应当只有一处，且落在 syncLockMark 里
  const lookupHits = (SRC.match(/directChildOf\([^)]*['"]node-lock['"]\)/g) || []).length;
  assert.strictEqual(lookupHits, 1,
    '查找 node-lock 的地方有 ' + lookupHits + ' 处（应该只有 syncLockMark 里那一处）');
  const s = bodyOf('syncLockMark');
  assert.ok(s && /directChildOf\([^)]*['"]node-lock['"]\)/.test(s.text),
    '查找 node-lock 的那一处不在 syncLockMark 里');
});

check('buildNode 走 buildLockMark（不是又抄了一份内联元素）', () => {
  const b = bodyOf('buildNode');
  assert.ok(b, '没找到 buildNode');
  assert.ok(/buildLockMark\s*\(/.test(b.text), 'buildNode 没有用 buildLockMark');
});

check('syncLockMark 同时管类名与图标', () => {
  const b = bodyOf('syncLockMark');
  assert.ok(b, '没找到 syncLockMark');
  assert.ok(/classList\.toggle\(\s*'is-locked'/.test(b.text), 'syncLockMark 没有切换 is-locked 类');
  assert.ok(/buildLockMark|remove\(\)/.test(b.text), 'syncLockMark 没有增删锁形图标');
});

console.log('\nL7 · 撤销要真的能撤销：pushHistory() 必须在改数据之前');

// 这里的由来：第 5 步验往返时发现「藏 2 张 → Ctrl+Z」卡片回不来。
// 根因是 hideSelection() 里 pushHistory() 写在 `data.hidden = true` **之后**，
// 压进撤销栈的快照已经是"藏好了"的状态，撤销等于把同一状态再应用一遍。
// 已用三组对照实验证实（baseline 不恢复 / HEAD 不恢复 / 把 pushHistory 提前后恢复），
// 并确认改动前就存在、不是第 5 步引入的。
check('hideSelection 先 pushHistory 再改 data.hidden', () => {
  const b = bodyOf('hideSelection');
  assert.ok(b, '没找到 hideSelection');
  const pushAt = b.text.indexOf('pushHistory(');
  const writeAt = b.text.indexOf('hidden = true');
  assert.ok(pushAt >= 0, 'hideSelection 里没有 pushHistory()');
  assert.ok(writeAt >= 0, 'hideSelection 里没有把 hidden 置为 true');
  assert.ok(pushAt < writeAt,
    'hideSelection 又在改完数据之后才 pushHistory() —— 撤销栈里存的会是"已经藏好了"的状态，' +
    '按 Ctrl+Z 不会把卡片恢复回来（这正是之前修掉的那个既有缺陷）');
});

check('hideSelection 保留「一张都不用变就什么都不做」的语义', () => {
  const b = bodyOf('hideSelection');
  // 不能因为重排顺序就丢掉「没有变化不留空撤销步」这条：先筛出待处理的，空就直接返回
  assert.ok(/pending\s*\.\s*length\s*\)\s*return/.test(b.text) || /if\s*\(!pending\.length\)\s*return/.test(b.text),
    'hideSelection 没有"没有变化就提前返回"的分支 —— 全选已隐藏的卡片会压进一个空的撤销步骤');
});

check('其它会改数据的函数也普遍遵循「先拍快照」的顺序', () => {
  // 抽查几个**已知会拍快照**的函数，防止以后有人在别处把顺序写反。
  // 名单里这几个都必须有 pushHistory —— 缺了也算错
  //（我第一版写成 "没有 pushHistory 就跳过"，于是"把 pushHistory 整个删掉"
  // 这种退化反而测不出来，变异检验 M16 抓到了这个洞）。
  const probes = ['deleteSelection', 'pasteClipboard', 'createZone', 'removeEdge'];
  const missing = [];
  const bad = [];
  for (const name of probes) {
    const b = bodyOf(name);
    if (!b) { missing.push(name + '(函数不存在)'); continue; }
    const pushAt = b.text.indexOf('pushHistory(');
    if (pushAt < 0) { missing.push(name); continue; }
    const m = /(data\.[A-Za-z]+\s*=|nodes\.(push|splice|unshift)|\.hidden\s*=\s*true)/.exec(b.text);
    if (m && m.index < pushAt) bad.push(name);
  }
  assert.deepStrictEqual(missing, [],
    '这些函数本该 pushHistory() 却没有：' + missing.join(', ') + ' —— 它们的改动将无法撤销');
  assert.deepStrictEqual(bad, [],
    '这些函数在改数据之后才 pushHistory()：' + bad.join(', ') +
    ' —— 顺序反了会让撤销退回到"已经改完"的状态，等于撤销无效');
});

console.log('\nL5 · 视频封面必须带 lazy（图片卡一直都有，别再漏）');
check("视频封面设置了 loading='lazy'", () => {
  assert.ok(/poster\.loading\s*=\s*'lazy'/.test(SRC),
    "视频封面没有 loading='lazy' —— 几百张视频卡一打开就会同时去拉封面");
});

check("视频封面同时保留 decoding='async'", () => {
  assert.ok(/poster\.decoding\s*=\s*'async'/.test(SRC), "视频封面丢了 decoding='async'");
});

console.log('\nL6 · 不该被顺手改掉的东西');

check('renderAll 仍然存在且仍然用 renderNodes + renderEdges', () => {
  const b = bodyOf('renderAll');
  assert.ok(b, 'renderAll 被删了 —— 结构性变更（增删区域/组/定时组、撤销）仍然需要它');
  assert.ok(/renderNodes\s*\(/.test(b.text) && /renderEdges\s*\(/.test(b.text),
    'renderAll 不再同时重建节点与连线');
});

check('renderAll 的调用点没有被压低到不合理的地步（结构变更仍需全量）', () => {
  const n = (CODE.match(/renderAll\s*\(\s*\);/g) || []).length;
  // 第 5 步之后是 22 处。留一点余量：少于 15 说明有人把结构变更也改成局部了，
  // 那种改动风险高得多，应当先有浏览器等价性证据。
  assert.ok(n >= 15,
    'renderAll 只剩 ' + n + ' 处调用 —— 结构变更（区域/组/定时组/撤销）可能被误改成局部更新，' +
    '这几条路径没有等价性验证前不要动');
});

check('undo/restoreState 仍走 renderAll（撤销必须是完整还原）', () => {
  const b = bodyOf('restoreState');
  assert.ok(b, '没找到 restoreState');
  assert.ok(/renderAll\s*\(/.test(b.text),
    'restoreState 不再全量重建 —— 撤销后容易出现残留的旧元素');
});

// ── 拖动性能：进入「交互态」的时机 ──────────────────────────────────
//
// 这一组守的是一个**实测出来的**性能回归（不是纸上推演）：
//
// `startDrag` 原来在 **pointerdown** 就调用 `beginInteraction()`，
// 而那时代码还不知道用户是要拖、还是只想点一下（要等 |dx|+|dy| > 1）。
// 而 `is-interacting` 会让 .world 提成合成层，并把卡片的端口 / 连线热区 /
// 流光伪元素成批从渲染树里摘掉 —— 这一整套切换要**重新布局 + 重新栅格化
// 屏幕上所有可见卡片**，代价随卡片数增长；松手撤销时还要再来一次。
//
// 实测（300+ 张卡的真实画布，**只点击、完全不拖动**，6 次取一致值）：
//   改前：6 次最差帧 263.9 / 145.8 / 173.6 / 138.8 / 118.1 / 132.1 ms，
//        每次点击 3 帧超标、合计 319ms
//   改后：最差帧 215.3 / 118 / 97.1 / 118 / 118 / 138.8 ms，
//        每次点击 2 帧超标、合计 212ms
// 而且改后**点击时 0/6 次进入交互态**（改前 6/6）——
// 同时确认：点击仍能选中卡片（6/6）、拖动仍会进入交互态且真的位移（3/3）。
//
// 注意：**这里不断言拖动帧率**。实测同一配置重复 10 轮，拖动 p95 波动达 201%
// （中位从 7ms 到 41.6ms），且 100% 的帧精确落在 6.94ms（144Hz vsync）整数倍上 ——
// 那种量化噪声下无法判读小差异。所以拖动只断言"功能正确 + 确实进入交互态"。
console.log('\nD8 · 拖动性能：进入交互态的时机（实测过的回归）');

check('startDrag 里 beginInteraction 不再紧跟 beginTransaction（已推迟）', () => {
  const b = bodyOf('startDrag');
  assert.ok(b, '没找到 startDrag');
  assert.ok(!/beginTransaction\(\);\s*\n\s*beginInteraction\(\);/.test(b.text),
    'startDrag 又变成"按下就进交互态"了 —— 只想点一下的用户会白付一次' +
    '"重绘所有可见卡片"的代价（300 张卡时每次点击多出约 100ms 的卡顿）');
});

check('startDrag 里改成"真的移动了才进交互态"（beginOnce 存在且被调用）', () => {
  const b = bodyOf('startDrag');
  assert.ok(b, '没找到 startDrag');
  assert.ok(/const\s+beginOnce\s*=/.test(b.text), '缺少 beginOnce —— 交互态没有延迟入口');
  assert.ok(/beginOnce\(\)/.test(b.text), 'beginOnce 定义了但没有被调用');
  // 它必须在"判定已经移动"的那一段里被调用，而不是在开头
  const movedAt = b.text.indexOf('moved = true');
  const callAt = b.text.indexOf('beginOnce()');
  assert.ok(movedAt >= 0 && callAt > movedAt,
    'beginOnce() 没有出现在 moved = true 之后 —— 又提前进交互态了');
});

check('beginInteraction / endInteraction 成对（松手时不能多退一次）', () => {
  const b = bodyOf('startDrag');
  assert.ok(b, '没找到 startDrag');
  // endInteraction 必须受 began 保护，否则计数会变成负数、is-interacting 永远摘不掉
  assert.ok(/if\s*\(began\)\s*endInteraction\(\);/.test(b.text),
    'endInteraction 没有用 began 守卫 —— 没进过交互态也去撤销，' +
    '会把 interactingCount 减到 0 以下，is-interacting 可能永远留在页面上');
});

check('平移（startPan）仍然按下就进交互态（那条路本来就该进）', () => {
  const b = bodyOf('startPan');
  assert.ok(b, '没找到 startPan');
  assert.ok(/beginInteraction\(\)/.test(b.text),
    'startPan 不再调用 beginInteraction —— 平移时重特效不会被关掉，反而更卡');
  // 平移是"按下即开始"，不该被延迟
  assert.ok(!/beginOnce/.test(b.text), 'startPan 不该用延迟版入口（按下就是平移）');
});

// ── 小地图绘制开销（实测：一次拖动要付约 2900~3300 次绘制调用）──────────
//
// 挖这个的原因是用户反馈「快速拖动时特别卡、卡片跟不上鼠标」。
// 定位过程中我**先做了一个无效的对照实验**（给 drawMinimap 装了个
// `if (window.__skipMM) return;` 的开关，却从没把 __skipMM 设为 true，
// 于是"对照组"其实也在照常画小地图，得出的"无改善"是假结论）。
// 后来改成给 canvas 2D 上下文打桩计数，才看到真实数字：
//   · 一次 45 帧拖动，小地图绘制调用 **2900~3300 次**
//   · 交替配对测量：把它空转掉，GPUTask 中位少 **79ms**，4/5 轮更快
// 优化后绘制调用降到 **1491**（约 45%），整屏像素对比**差异 0%**。
//
// 这两条护栏守的就是那两个具体改法，防止以后被改回去。
console.log('\nD9 · 小地图绘制开销（实测过的热点）');

check('drawMinimap 的连线是"攒成一个路径只 stroke 一次"', () => {
  const b = bodyOf('drawMinimap');
  assert.ok(b, '没找到 drawMinimap');
  // 旧写法：在 edges.forEach 内部 beginPath + stroke
  const inLoop = /edges\.forEach\(\(edge\) => \{[\s\S]*?ctx\.beginPath\(\)[\s\S]*?ctx\.stroke\(\);[\s\S]*?\}\);/.test(b.text);
  assert.ok(!inLoop,
    'drawMinimap 又变成"每条连线各来一次 beginPath + stroke"了 —— ' +
    '54 张卡的画布上那是 70~90 次独立描边，而小地图在拖动中会反复重画');
  // 新写法：一次 beginPath 覆盖所有连线
  assert.ok(/ctx\.beginPath\(\);[\s\S]{0,200}?edges\.forEach/.test(b.text),
    'drawMinimap 没有把连线合并到同一个路径里');
});

check('drawMinimap 的卡片是按颜色分组填充（不是每张卡写一次 fillStyle）', () => {
  const b = bodyOf('drawMinimap');
  assert.ok(b, '没找到 drawMinimap');
  assert.ok(/byTint/.test(b.text),
    'drawMinimap 不再按颜色分桶 —— 每张卡写一次 ctx.fillStyle 会多出几十次状态切换');
  // 旧写法：shown.forEach 里直接写 fillStyle
  assert.ok(!/shown\.forEach\(\(node\) => \{[\s\S]{0,300}?ctx\.fillStyle = MM_TINTS/.test(b.text),
    'drawMinimap 又在逐张卡里直接写 ctx.fillStyle 了');
});

check('拖动中放宽了小地图重画间隔（松手仍会补画一次）', () => {
  const b = bodyOf('scheduleMinimap');
  assert.ok(b, '没找到 scheduleMinimap');
  const m = /interactingCount > 0 && performance\.now\(\) - mmLastDraw < (\d+)/.exec(b.text);
  assert.ok(m, 'scheduleMinimap 里找不到"交互中节流"的判断');
  assert.ok(Number(m[1]) >= 200,
    '拖动中的小地图节流间隔被调回 ' + m[1] + 'ms 了 —— 太密会让拖动反复付这笔开销');
  // 松手必须补画，否则小地图会停在拖动中途的状态
  const e = bodyOf('endInteraction');
  assert.ok(e && /scheduleMinimap\(\)/.test(e.text),
    'endInteraction 不再补画小地图 —— 松手后小地图会停在中途状态');
});

// ── 图片卡的尾部提示词：卡片 UI 必须按类型取池 ──────────────────────
//
// 需求：图片卡也支持尾部提示词，但**图片和视频的预设互不相通**。
// 服务端侧的护栏在 payload-rules.test.js；这里守前端卡片面板这一侧：
//   面板下拉框必须只列"自己那一类"的预设，否则就成了"互通"。
// 实测（真实浏览器）：图片卡的下拉里只有图片池的项，看不到视频那套「3D国漫风格」。
console.log('\nD10 · 图片卡尾部提示词：前端按类型取池');

check('TAIL_KINDS 里包含 image（否则图片卡根本不会出现这个模块）', () => {
  const rules = require(path.join(ROOT, 'web', 'assets', 'payload-rules.js'));
  assert(rules.TAIL_KINDS.image, 'TAIL_KINDS 里没有 image —— 图片卡上不会出现尾部提示词模块');
});

check('前端有按类型分池的取用函数（tailGroupOf / tailPoolOf）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  assert(/function tailGroupOf\(/.test(src), '缺少 tailGroupOf —— 没法判断一张卡属于哪个池');
  assert(/function tailPoolOf\(/.test(src), '缺少 tailPoolOf —— 没法按类型取池');
  // 图片归 image、其余归 video
  const fn = /function tailGroupOf\([\s\S]*?\n  \}/.exec(src);
  assert(fn, '抽不出 tailGroupOf');
  assert(/'image'/.test(fn[0]) && /'video'/.test(fn[0]),
    'tailGroupOf 没有把 image 和 video 分开');
});

check('卡片下拉框列的是**自己池子**的预设，不是全部预设', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const block = /function buildTailCardBlock\([\s\S]*?\n  \}/.exec(src);
  assert(block, '抽不出 buildTailCardBlock');
  // 关键：遍历的是 pool.presets，不能是"全部预设"
  assert(/pool\.presets\.forEach/.test(block[0]),
    'buildTailCardBlock 不再遍历 pool.presets —— 会把另一类的预设也列出来，等于互通了');
  assert(!/cfg\.presets\.forEach/.test(block[0]),
    'buildTailCardBlock 又在遍历全部预设了 —— 图片卡会看到视频那套');
  // 默认预设也要按池取
  assert(/tailPresetById\(node, pool\.defaultId\)/.test(block[0]),
    '下拉里的"跟随默认"没有按类型取默认预设');
});

check('新卡片按自己的类型拿默认尾巴（图片卡不会拿到视频的默认）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  assert(/defaultTailChoice\(node\)/.test(src),
    '新建卡片时没有把 node 传给 defaultTailChoice —— 会拿到另一类的默认预设');
});

check('设置面板分成「视频 / 图片」两组，且保存时两组都带上', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'ui.js'), 'utf8');
  assert(/data-group="video"/.test(src) && /data-group="image"/.test(src),
    '设置面板没有视频 / 图片两个分页');
  assert(/TAIL_GROUP_META/.test(src), '缺少分组文案');
  const save = /#tail-save'\)\.addEventListener[\s\S]*?\n    \}\);/.exec(src);
  assert(save, '抽不出保存处理');
  assert(/groups:\s*\{/.test(save[0]), '保存时没有带上 groups（会把分组结构写丢）');
  // 只有两组都空才拦 —— 否则"只建了视频组"就无法保存了
  assert(/anyText/.test(save[0]),
    '保存校验没有改成"两组都空才拦" —— 只建了视频组时会不让保存');
});

check('设置面板能读懂老结构（扁平 presets → 视频池）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'ui.js'), 'utf8');
  const fn = /function normalizeTailPresets\([\s\S]*?\n  \}/.exec(src);
  assert(fn, '抽不出 normalizeTailPresets');
  assert(/raw\.groups/.test(fn[0]), '前端归一没有处理 groups 结构');
  assert(/groups\.video = one\(raw\)/.test(fn[0]),
    '前端归一没有把老结构迁进 video 池 —— 服务端还没保存过时面板会显示空');
});

console.log('\n' + '─'.repeat(52));
if (fail) {
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(1);
}
console.log('通过 ' + pass + ' 项，失败 0 项');
