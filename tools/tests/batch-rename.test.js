'use strict';

// D2 批量重命名的隔离测试（清单 19）。
//
// 三种改法是纯文本操作，这里按「同一份输入 → 同一份新标题」验证：
//   统一设为 / 前缀加序号 / 查找替换
// 以及序号排序（按画布上从左到右、从上到下）和序号补零。
//
// 前端是 IIFE，函数取不出来，所以用「源码片段提取 + 在沙箱里跑」的办法测纯函数，
// 再配合源码级约束确认面板与入口都接上了。
//
// 运行：runtime/node.exe tools/tests/batch-rename.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

// 隔离：本测试只跑纯函数，不碰数据库，仍走统一助手保持范式一致
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-rename-'));
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
  if (got !== want) throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
}

const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');

// 从源码里抠出几个纯函数，放进沙箱跑（避免为了测试改动生产代码的结构）
function pickFunction(name) {
  const at = canvasSrc.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('源码里找不到函数 ' + name);
  // 从 function 开始，按花括号配对找到函数结尾
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

console.log('\nD2 · 纯函数（从源码里取出来跑）');

// 把 renamePreviewOf / padIndex / renameSortKey 放进一个沙箱，
// 它们依赖的 nodeData 用一个简单替身（卡片数据都在 node.data 上）
const sandbox = {
  nodes: [],
  result: null,
};
vm.createContext(sandbox);
vm.runInContext(
  [
    'function nodeData(node) { return node.data; }',
    pickFunction('padIndex'),
    pickFunction('renameSortKey'),
    pickFunction('renamePreviewOf'),
    'globalThis.__padIndex = padIndex;',
    'globalThis.__renameSortKey = renameSortKey;',
    'globalThis.__renamePreviewOf = renamePreviewOf;',
  ].join('\n'),
  sandbox
);

function card(id, x, y, title) {
  return { id: id, type: 'image', x: x, y: y, w: 300, h: 240, data: { title: title == null ? '' : title } };
}
function names(rows) {
  return rows.map((row) => row.newTitle).join(',');
}

check('递增序号补零（10 张时 1 → 01）', () => {
  eq(sandbox.__padIndex(1, 10), '01');
  eq(sandbox.__padIndex(10, 10), '10');
  eq(sandbox.__padIndex(3, 5), '3', '5 张以内不补零');
});

sandbox.__nodes = null;

console.log('\nD2 · 统一设为');

check('全都改成同一个标题', () => {
  const list = [card('a', 0, 0, '旧甲'), card('b', 400, 0, '旧乙'), card('c', 800, 0, '')];
  const rows = sandbox.__renamePreviewOf(list, 'set', { text: '开场镜头' });
  eq(names(rows), '开场镜头,开场镜头,开场镜头');
});

check('统一设为空文本 = 清空标题', () => {
  const list = [card('a', 0, 0, '旧甲')];
  const rows = sandbox.__renamePreviewOf(list, 'set', { text: '' });
  eq(rows[0].newTitle, '');
  eq(rows[0].oldTitle, '旧甲', '旧标题要留着给预览对比');
});

console.log('\nD2 · 前缀 + 序号');

check('前缀加递增序号', () => {
  const list = [card('a', 0, 0, ''), card('b', 400, 0, ''), card('c', 800, 0, '')];
  const rows = sandbox.__renamePreviewOf(list, 'prefix', { prefix: '镜头_', start: 1 });
  eq(names(rows), '镜头_1,镜头_2,镜头_3');
});

check('起始序号能改', () => {
  const list = [card('a', 0, 0, ''), card('b', 400, 0, '')];
  const rows = sandbox.__renamePreviewOf(list, 'prefix', { prefix: 'P', start: 10 });
  eq(names(rows), 'P10,P11');
});

check('后缀可选', () => {
  const list = [card('a', 0, 0, '')];
  const rows = sandbox.__renamePreviewOf(list, 'prefix', { prefix: 'A', suffix: '_成片', start: 1 });
  eq(rows[0].newTitle, 'A1_成片');
});

check('10 张以上自动补零，排出来更整齐', () => {
  const list = [];
  for (let i = 0; i < 12; i += 1) list.push(card('n' + i, i * 100, 0, ''));
  const rows = sandbox.__renamePreviewOf(list, 'prefix', { prefix: '图-', start: 1 });
  eq(rows[0].newTitle, '图-01');
  eq(rows[9].newTitle, '图-10');
  eq(rows[11].newTitle, '图-12');
});

check('序号基准按「从左到右、从上到下」，不是数组顺序', () => {
  // 排序发生在 orderedRenameTargets 里（它还要读 nodes / selection，不单独抠出来），
  // 这里用同一个比较键复现一遍，确认排序键的规则对
  const list = [card('c', 400, 300, ''), card('a', 0, 0, ''), card('b', 400, 0, '')];
  const sorted = list.slice().sort((x, y) => {
    const kx = sandbox.__renameSortKey(x);
    const ky = sandbox.__renameSortKey(y);
    if (kx[0] !== ky[0]) return kx[0] - ky[0];
    return kx[1] - ky[1];
  });
  eq(sorted.map((node) => node.id).join(','), 'a,b,c', '同一行按 x 排，下一行排后面');
  // 排好之后再套序号，编号才跟视觉顺序对得上
  const rows = sandbox.__renamePreviewOf(sorted, 'prefix', { prefix: 'X', start: 1 });
  eq(names(rows), 'X1,X2,X3');
});

check('两行之间的小高度差不会拆成两行', () => {
  const list = [card('a', 0, 0, ''), card('b', 400, 30, ''), card('c', 800, 0, '')];
  const rows = sandbox.__renamePreviewOf(list, 'prefix', { prefix: 'Y', start: 1 });
  eq(rows.map((row) => row.id).join(','), 'a,b,c');
  // 三张的排序键第一段应该相同（被视为同一行）
  const rows0 = sandbox.__renameSortKey(card('a', 0, 0, ''))[0];
  const rows1 = sandbox.__renameSortKey(card('b', 400, 30, ''))[0];
  eq(rows0, rows1, '30px 的高度差不该被当成另一行');
});

console.log('\nD2 · 查找替换');

check('只替换出现的部分', () => {
  const list = [card('a', 0, 0, '开场镜头'), card('b', 400, 0, '结尾镜头'), card('c', 800, 0, '没有的那段')];
  const rows = sandbox.__renamePreviewOf(list, 'replace', { find: '镜头', to: '大景' });
  eq(names(rows), '开场大景,结尾大景,没有的那段');
});

check('替换成留空 = 删掉那一段', () => {
  const list = [card('a', 0, 0, '镜头_001')];
  const rows = sandbox.__renamePreviewOf(list, 'replace', { find: '镜头_', to: '' });
  eq(rows[0].newTitle, '001');
});

check('一次出现多处也全换（不是只换第一个）', () => {
  const list = [card('a', 0, 0, '甲甲甲')];
  const rows = sandbox.__renamePreviewOf(list, 'replace', { find: '甲', to: '乙' });
  eq(rows[0].newTitle, '乙乙乙');
});

check('「找」为空时不动任何标题（不然会变成乱插字符）', () => {
  const list = [card('a', 0, 0, '保持原样'), card('b', 400, 0, '也不动')];
  const rows = sandbox.__renamePreviewOf(list, 'replace', { find: '', to: 'X' });
  eq(names(rows), '保持原样,也不动');
});

check('特殊字符当普通文本处理（不会当成正则）', () => {
  const list = [card('a', 0, 0, 'a.b.c')];
  const rows = sandbox.__renamePreviewOf(list, 'replace', { find: '.', to: '-' });
  eq(rows[0].newTitle, 'a-b-c');
});

check('前后空白会被去掉', () => {
  const list = [card('a', 0, 0, '')];
  const rows = sandbox.__renamePreviewOf(list, 'prefix', { prefix: '  X  ', start: 1 });
  eq(rows[0].newTitle, 'X1');
});

console.log('\nD2 · 面板与入口（源码级约束）');

check('批量栏里有「批量重命名」按钮', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'canvas.html'), 'utf8');
  assert(html.indexOf('data-batch="rename"') >= 0, 'html 里没有这个按钮');
});

check('按钮的显示与计数跟着选中走', () => {
  assert(canvasSrc.indexOf('batchRenameCandidates') >= 0, '缺少候选函数');
  const at = canvasSrc.indexOf('function paintBatchButtons()');
  const body = canvasSrc.slice(at, at + 2400);
  assert(body.indexOf('renameCount') >= 0, '计数没接上');
  assert(body.indexOf("'批量重命名'") >= 0, '按钮文案没接上');
});

check('点按钮会打开重命名面板', () => {
  const at = canvasSrc.indexOf("batch === 'retry') runBatchGenerate('retry')");
  assert(at >= 0, '找不到批量按钮的分派');
  const around = canvasSrc.slice(at, at + 200);
  assert(around.indexOf("batch === 'rename'") >= 0 && around.indexOf('openBatchRename') >= 0, '没接到面板');
});

check('面板三种模式都在', () => {
  const at = canvasSrc.indexOf('async function openBatchRename()');
  assert(at >= 0, '缺少面板函数');
  const body = canvasSrc.slice(at, at + 8000);
  ["'prefix'", "'set'", "'replace'"].forEach((mode) => {
    assert(body.indexOf(mode) >= 0, '缺少模式 ' + mode);
  });
  assert(body.indexOf('前缀 + 序号') >= 0, '缺少「前缀 + 序号」标签');
  assert(body.indexOf('统一设为') >= 0, '缺少「统一设为」标签');
  assert(body.indexOf('查找替换') >= 0, '缺少「查找替换」标签');
});

check('面板给出旧名 → 新名对照预览', () => {
  assert(canvasSrc.indexOf('rename-preview-old') >= 0, '缺少旧名');
  assert(canvasSrc.indexOf('rename-preview-new') >= 0, '缺少新名');
  assert(canvasSrc.indexOf('rename-preview-arrow') >= 0, '缺少箭头');
});

check('确认后走 pushHistory（能撤销）', () => {
  const at = canvasSrc.indexOf('function applyBatchRename(');
  assert(at >= 0, '缺少应用函数');
  const body = canvasSrc.slice(at, at + 900);
  assert(body.indexOf('pushHistory()') >= 0, '改之前没有留档，撤不回来');
  assert(body.indexOf('scheduleSave()') >= 0, '没安排保存');
});

check('批量改标题时跳过锁定与隐藏的卡片', () => {
  const at = canvasSrc.indexOf('function batchRenameCandidates()');
  const body = canvasSrc.slice(at, at + 400);
  assert(body.indexOf('isLocked(node)') >= 0, '没排除锁定的');
  assert(body.indexOf('isHidden(node)') >= 0, '没排除隐藏的');
});

check('样式补齐（面板 + 预览行）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'style.css'), 'utf8');
  ['.modal-rename', '.rename-tab', '.rename-preview-row', '.rename-preview-arrow'].forEach((sel) => {
    assert(css.indexOf(sel) >= 0, '缺少样式 ' + sel);
  });
});

console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
