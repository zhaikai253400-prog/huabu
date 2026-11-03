'use strict';

// F2 数据版本号的测试（清单 39）。
//
// 要守住的四件事，按重要性排：
//
//   1. **幂等**：迁移跑一次和跑十次，数据必须一字不差。这是最容易被破坏的一条 ——
//      只要某个步骤写成「不管有没有都append一次」，第一次看不出来，
//      用户开关十次画布就会多出十条重复记录。
//   2. **不覆盖用户内容**：老字段搬家只在「新字段是空的」时候发生。
//      用户在新版里改过的提示词，绝不能因为身上还挂着老字段而被旧值覆盖回去。
//   3. **可回退**：迁移只做加法与改名，不删用户内容（除了那一个已经没人读的老字段）。
//      拿迁移前的备份就能原样退回去。
//   4. **前后端同号**：服务端 server/migrate.js 的 CURRENT_VER 与前端 canvas.js 的
//      DATA_VER 必须相等。两边不等会造成「前端以为升级完了、服务端又升一遍」，
//      或者反过来「服务端升了、前端不认识」。这条靠源码级断言，不靠自觉。
//
// 另外用真实库里的那几笔老数据（7 张废弃类型卡片 + 4 处老 prompt 字段）做样本，
// 保证测的不是我编出来的形状。
//
// 运行：runtime/node.exe tools/tests/data-version.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');

// 隔离：本测试只跑纯逻辑，不碰数据库，仍走统一助手保持范式一致
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-dataver-'));
require(path.join(__dirname, '_isolate.js'))(box);

const migrate = require(path.join(ROOT, 'server', 'migrate.js'));

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
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error((msg || '值不相等') + '：拿到 ' + a + '，期望 ' + b);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

// 造一张老卡片。真实库里那些废弃类型卡片的 data 里只有 text 一个字段，
// 这里按同样的样子造，免得测一个根本不存在的形状。
function legacy(type, data) {
  return { id: 'n_' + type, type: type, x: 0, y: 0, w: 260, h: 180, data: data };
}
function fresh(type, data) {
  const node = { id: 'n_new', type: type, x: 0, y: 0, w: 360, h: 203, data: Object.assign({ v: migrate.CURRENT_VER }, data || {}) };
  return node;
}

console.log('数据版本号与迁移（清单 39）');
console.log('');
console.log('【一】版本号与迁移动词');

check('当前版本号是个正整数', () => {
  ok(Number.isInteger(migrate.CURRENT_VER) && migrate.CURRENT_VER > 0, 'CURRENT_VER 不是正整数');
});

check('没有版本号的当成 0（老数据本来就没这个字段）', () => {
  eq(migrate.versionOf({ id: 'a', data: {} }), 0);
  eq(migrate.versionOf({ id: 'a', data: { text: 'x' } }), 0);
});

check('版本号读得回来', () => {
  eq(migrate.versionOf({ id: 'a', data: { v: 1 } }), 1);
});

check('版本号是坏值（字符串/负数/NaN）时按 0 处理，不炸', () => {
  eq(migrate.versionOf({ id: 'a', data: { v: 'x' } }), 0);
  eq(migrate.versionOf({ id: 'a', data: { v: -3 } }), 0);
  eq(migrate.versionOf({ id: 'a', data: { v: NaN } }), 0);
});

check('比当前版本高的数据不认，也不降级', () => {
  eq(migrate.versionOf({ id: 'a', data: { v: 99 } }), 99);
  const node = { id: 'a', type: 'image', data: { v: 99, 未来的字段: '别动我' } };
  eq(migrate.migrateNodeData(node), false, '更高版本不该被改写');
  eq(node.data.v, 99);
  eq(node.data['未来的字段'], '别动我');
});

check('没有 data 的坏节点不炸，补一个空对象', () => {
  const node = { id: 'a', type: 'image' };
  migrate.migrateNodeData(node);
  ok(node.data && typeof node.data === 'object', 'data 没补上');
});

console.log('');
console.log('【二】幂等（跑一次和跑十次必须一字不差）');

check('同一份老数据跑两次，结果完全相同', () => {
  const a = legacy('prompt', { text: '测试一' });
  const b = legacy('prompt', { text: '测试一' });
  migrate.migrateNodeData(a);
  migrate.migrateNodeData(b);
  eq(a, b);
});

check('跑过一次之后再跑，返回 false 且数据不变', () => {
  const node = legacy('prompt', { text: '测试一' });
  migrate.migrateNodeData(node);
  const snapshot = JSON.stringify(node);
  eq(migrate.migrateNodeData(node), false, '第二次不该再报改动');
  eq(JSON.stringify(node), snapshot, '数据被改了');
  eq(migrate.migrateNodeData(node), false);
  eq(JSON.stringify(node), snapshot);
  eq(migrate.migrateNodeData(node), false);
  eq(JSON.stringify(node), snapshot);
});

check('干净的新版数据零改动（这条路径要在每次保存时都便宜）', () => {
  const node = fresh('image', { text: '正文', sized: false, locked: false, hidden: false });
  eq(migrate.migrateNodeData(node), false);
  eq(node.data.v, migrate.CURRENT_VER);
});

check('整块画布跑两次，统计与内容都一致', () => {
  const seed = () => [
    legacy('prompt', { text: '甲' }),
    legacy('material', { text: '乙' }),
    legacy('generate', { text: '丙' }),
    legacy('image', { prompt: '丁' }),
    fresh('video', { text: '戊' }),
  ];
  const first = seed();
  const second = seed();
  const r1 = migrate.migrateCanvasData(first);
  const r2 = migrate.migrateCanvasData(second);
  eq(r1.changes, r2.changes, '两次统计不一致');
  eq(r1.nodes, r2.nodes, '两次结果不一致');
  // 再跑第三遍：这次一张都不该动
  const again = migrated => migrate.migrateCanvasData(migrated);
  const r3 = again(r1.nodes);
  eq(r3.changed, false, '第三遍不该有改动');
});

console.log('');
console.log('【三】不覆盖用户内容（老字段只在「新字段为空」时搬家）');

check('新字段已经有值：保留新值，只把老字段摘掉', () => {
  const node = { id: 'a', type: 'image', data: { prompt: '旧提示词', text: '用户后来改的' } };
  migrate.migrateNodeData(node);
  eq(node.data.text, '用户后来改的', '用户改过的内容被老值覆盖了');
  ok(!Object.prototype.hasOwnProperty.call(node.data, 'prompt'), '老字段没摘掉');
});

check('新字段是空串：把老字段搬过去（这正是真实库里那 4 处的情形）', () => {
  const node = { id: 'a', type: 'image', data: { prompt: '测试一', text: '' } };
  migrate.migrateNodeData(node);
  eq(node.data.text, '测试一', '老提示词没搬过来');
  ok(!Object.prototype.hasOwnProperty.call(node.data, 'prompt'), '老字段没摘掉');
});

check('新字段压根没有：把老字段搬过去', () => {
  const node = { id: 'a', type: 'video', data: { prompt: '测试二' } };
  migrate.migrateNodeData(node);
  eq(node.data.text, '测试二');
});

check('老字段是空值：不该凭空造出一个 text 来污染数据', () => {
  const node = { id: 'a', type: 'prompt', data: { prompt: '' } };
  migrate.migrateNodeData(node);
  ok(!Object.prototype.hasOwnProperty.call(node.data, 'text'), '空老值不该生出 text');
});

check('老字段已经盖了最新版本号的，也要被清掉（这条曾经是漏洞）', () => {
  // 前端读到卡片的瞬间就会盖版本号；如果废字段清理挂在版本号后面，
  // 就会出现「号是最新的、脏字段永远留着」——库里那 4 处正是这么躺着的。
  const node = { id: 'a', type: 'image', data: { prompt: '测试一', text: '', v: migrate.CURRENT_VER } };
  eq(migrate.migrateNodeData(node), true, '挂着老字段就该报改动');
  eq(node.data.text, '测试一');
  ok(!Object.prototype.hasOwnProperty.call(node.data, 'prompt'), '老字段没清掉');
});

console.log('');
console.log('【四】类型归一（真实库里有 7 张这样的卡片）');

check('prompt / material → image，generate → video', () => {
  const cases = [['prompt', 'image'], ['material', 'image'], ['generate', 'video']];
  cases.forEach((pair) => {
    const node = legacy(pair[0], { text: '内容' });
    migrate.migrateNodeData(node);
    eq(node.type, pair[1], pair[0] + ' 应该变成 ' + pair[1]);
  });
});

check('类型归一不动内容：text 原样保留', () => {
  const node = legacy('prompt', { text: '我的提示词' });
  migrate.migrateNodeData(node);
  eq(node.data.text, '我的提示词');
});

check('现有的类型一个都不动（image/video/audio/group/quick/schedule/director/zone）', () => {
  ['image', 'video', 'audio', 'group', 'quick', 'schedule', 'director', 'zone'].forEach((type) => {
    const node = { id: 'x', type: type, data: { text: '内容' } };
    migrate.migrateNodeData(node);
    eq(node.type, type, type + ' 被改成了 ' + node.type);
  });
});

check('完全不认识的类型不猜（交给前端既有的兜底逻辑）', () => {
  const node = { id: 'x', type: '某个将来才会有的类型', data: {} };
  migrate.migrateNodeData(node);
  eq(node.type, '某个将来才会有的类型', '不该替用户猜类型');
});

console.log('');
console.log('【五】补齐字段的默认值');

check('缺 sized / locked / hidden 时补上 false', () => {
  const node = legacy('image', { text: 'x' });
  migrate.migrateNodeData(node);
  eq(node.data.sized, false);
  eq(node.data.locked, false);
  eq(node.data.hidden, false);
});

check('已经是布尔值的不动（true 不能被改回 false）', () => {
  const node = legacy('image', { text: 'x', sized: true, locked: true, hidden: true });
  migrate.migrateNodeData(node);
  eq(node.data.sized, true);
  eq(node.data.locked, true);
  eq(node.data.hidden, true);
});

check('补字段不碰别的字段', () => {
  const node = legacy('image', { text: 'x', no: 3, model: 'some-model', params: { ratio: '16:9' } });
  migrate.migrateNodeData(node);
  eq(node.data.no, 3);
  eq(node.data.model, 'some-model');
  eq(node.data.params, { ratio: '16:9' });
});

console.log('');
console.log('【六】可回退（迁移只做加法与改名）');

check('迁移只增不减：除老字段外，原有字段一个不少', () => {
  const node = legacy('prompt', { text: 'x', no: 2, model: 'm', params: { a: 1 }, result: '结果', history: ['旧1', '旧2'] });
  const before = Object.keys(node.data).filter((key) => key !== 'prompt');
  migrate.migrateNodeData(node);
  before.forEach((key) => {
    ok(Object.prototype.hasOwnProperty.call(node.data, key), '丢了字段 ' + key);
  });
  eq(node.data.result, '结果', '生成结果被动了');
  eq(node.data.history, ['旧1', '旧2'], '历史记录被动了');
});

check('整块画布迁移：节点数、id、位置尺寸都不变', () => {
  const nodes = [
    { id: 'n1', type: 'prompt', x: 10, y: 20, w: 340, h: 440, data: { text: '甲' } },
    { id: 'n2', type: 'generate', x: 30, y: 40, w: 360, h: 510, data: { text: '乙' } },
  ];
  const geo = nodes.map((n) => [n.id, n.x, n.y]);
  migrate.migrateCanvasData(nodes);
  eq(nodes.length, 2);
  eq(nodes.map((n) => [n.id, n.x, n.y]), geo, '位置或编号被改了');
});

console.log('');
console.log('【七】真实库样本（按取证到的真实数据造）');

check('真实库里那 7 张废弃类型卡片都能归一到现存类型', () => {
  // 取证：prompt×5 / generate×1 / material×1，data 里只有 text
  const samples = [
    legacy('prompt', { text: '' }), legacy('prompt', { text: '' }),
    legacy('prompt', { text: '' }), legacy('prompt', { text: '' }),
    legacy('prompt', { text: '' }), legacy('generate', { text: '' }),
    legacy('material', { text: '' }),
  ];
  const result = migrate.migrateCanvasData(samples);
  eq(result.changed, true);
  eq(result.changes.type, 7, '7 张都该被归一');
  samples.forEach((node) => {
    ok(['image', 'video'].indexOf(node.type) >= 0, '还剩废弃类型 ' + node.type);
  });
});

check('真实库里那 4 处老 prompt 字段都能搬到 text', () => {
  // 取证：image/video 各 2 处，prompt 有值、text 是空串
  const samples = [
    { id: 'a', type: 'image', data: { prompt: '测试一', text: '' } },
    { id: 'b', type: 'video', data: { prompt: '测试二', text: '' } },
    { id: 'c', type: 'image', data: { prompt: '测试一', text: '' } },
    { id: 'd', type: 'video', data: { prompt: '测试二', text: '' } },
  ];
  const result = migrate.migrateCanvasData(samples);
  eq(result.changed, true);
  samples.forEach((node) => {
    ok(node.data.text !== '', '提示词没搬过来：' + node.id);
    ok(!Object.prototype.hasOwnProperty.call(node.data, 'prompt'), '老字段没清掉：' + node.id);
  });
});

check('真实库那 88 个节点整体过一遍，跑两次结果一致', () => {
  // 按取证到的类型分布造等价规模：image 39 / video 30 / audio 10 /
  // prompt 5 / quick 2 / material 1 / generate 1
  const build = () => {
    const list = [];
    const add = (type, count, data) => {
      for (let i = 0; i < count; i += 1) {
        list.push({ id: 'n_' + type + i, type: type, x: i, y: i, w: 260, h: 180, data: Object.assign({}, data) });
      }
    };
    add('image', 39, { text: 'x' });
    add('video', 30, { text: 'x' });
    add('audio', 10, { text: 'x' });
    add('prompt', 5, { text: '' });
    add('quick', 2, { text: 'x' });
    add('material', 1, { text: '' });
    add('generate', 1, { text: '' });
    return list;
  };
  eq(build().length, 88, '样本规模对不上真实库');
  const a = build();
  const b = build();
  migrate.migrateCanvasData(a);
  migrate.migrateCanvasData(b);
  eq(a, b, '两遍结果不一致');
  const abandoned = a.filter((n) => ['prompt', 'material', 'generate'].indexOf(n.type) >= 0);
  eq(abandoned.length, 0, '还有废弃类型没归一');
  a.forEach((node) => eq(node.data.v, migrate.CURRENT_VER, '漏了版本号：' + node.id));
});

console.log('');
console.log('【八】前后端同号（源码级约束）');

const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');

function constOf(source, name) {
  const at = source.indexOf('const ' + name + ' =');
  if (at < 0) throw new Error('源码里找不到常量 ' + name);
  const hit = source.slice(at, at + 80).match(/=\s*(-?\d+)/);
  if (!hit) throw new Error('常量 ' + name + ' 不是整数');
  return Number(hit[1]);
}

check('前端 DATA_VER 与后端 CURRENT_VER 相等', () => {
  const front = constOf(canvasSrc, 'DATA_VER');
  eq(front, migrate.CURRENT_VER, '前后端版本号不一致，会出现重复升级或互不认识');
});

check('前端 REFS_VER 与后端 SUB_VERS 的值一致', () => {
  const front = constOf(canvasSrc, 'REFS_VER');
  const back = migrate.SUB_VERS;
  ok(back && typeof back === 'object', '后端缺 SUB_VERS');
  const values = Object.keys(back).map((key) => back[key]);
  ok(values.indexOf(front) >= 0, '前端的 REFS_VER=' + front + ' 在后端 SUB_VERS 里找不到对应');
});

check('后端每个迁移步骤都登记在案且是函数', () => {
  const keys = Object.keys(migrate.MIGRATIONS);
  ok(keys.length > 0, '迁移表是空的');
  keys.forEach((key) => {
    ok(typeof migrate.MIGRATIONS[key] === 'function', '步骤 ' + key + ' 不是函数');
    const from = Number(key);
    ok(Number.isInteger(from) && from >= 0, '步骤 ' + key + ' 的起点不是非负整数');
    ok(from < migrate.CURRENT_VER, '步骤 ' + key + ' 的起点已经不低于当前版本，永远不会被执行');
  });
});

check('迁移表从 0 连续铺到 CURRENT_VER-1，中间不留空洞', () => {
  for (let v = 0; v < migrate.CURRENT_VER; v += 1) {
    ok(typeof migrate.MIGRATIONS[v] === 'function', '缺了 ' + v + ' → ' + (v + 1) + ' 这一步');
  }
});

check('前端新建卡片时就带上版本号（不用等迁移补）', () => {
  ok(canvasSrc.indexOf('v: DATA_VER') >= 0, 'addNode 里没有盖版本号');
});

check('前端读到老卡片时会盖版本号', () => {
  // nodeData 是「保证字段齐全」的入口，所有读卡片的地方都会经过它
  const at = canvasSrc.indexOf('function nodeData(');
  ok(at > 0, '找不到 nodeData');
  const body = canvasSrc.slice(at, at + 3000);
  ok(body.indexOf('data.v = DATA_VER') >= 0, 'nodeData 里没有盖版本号');
});

check('前端 migrateNode 会清掉老 prompt 字段', () => {
  const at = canvasSrc.indexOf('function migrateNode(');
  ok(at > 0, '找不到 migrateNode');
  // 取到下一个顶层函数声明为止
  const rest = canvasSrc.slice(at);
  const nextFn = rest.indexOf('\n  function ', 10);
  const body = nextFn > 0 ? rest.slice(0, nextFn) : rest.slice(0, 4000);
  ok(body.indexOf("delete data.prompt") >= 0, 'migrateNode 没有清掉老字段');
  ok(body.indexOf('v: DATA_VER') >= 0 || body.indexOf('data.v = DATA_VER') >= 0, 'migrateNode 没有盖版本号');
});

console.log('');
console.log('【九】保存路径的留档（源码级约束）');

const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(ROOT, 'server', 'store.js'), 'utf8');

check('保存前会先探测库里有没有老数据，有就先留档', () => {
  ok(indexSrc.indexOf('store.scanCanvasMigration') >= 0, '保存路径没有探测迁移');
  ok(indexSrc.indexOf("forceSnapshot(id, before, '数据升级前')") >= 0, '没有留「数据升级前」的档');
  // 顺序必须是「先留档、再保存」，反了留的就是新数据
  const scanAt = indexSrc.indexOf('store.scanCanvasMigration');
  const saveAt = indexSrc.indexOf('store.saveState(id, body, body.rev)', scanAt);
  ok(saveAt > scanAt, '留档的位置在保存之后，留到的是升级后的数据');
});

check('写库前的迁移挂在 saveState 里（所有数据进库的唯一漏斗）', () => {
  const at = storeSrc.indexOf('function saveState(');
  ok(at > 0, '找不到 saveState');
  const end = storeSrc.indexOf('\nfunction ', at + 10);
  const body = storeSrc.slice(at, end > 0 ? end : storeSrc.length);
  ok(body.indexOf('migrate.migrateCanvasData') >= 0, 'saveState 没有走迁移');
});

check('迁移统计只在真的改了东西时才出现在返回里', () => {
  const at = storeSrc.indexOf('function saveState(');
  const end = storeSrc.indexOf('\nfunction ', at + 10);
  const body = storeSrc.slice(at, end > 0 ? end : storeSrc.length);
  ok(body.indexOf('stampResult.changed') >= 0, '没有按 changed 判断，会把「没改动」也报成迁移');
});

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
