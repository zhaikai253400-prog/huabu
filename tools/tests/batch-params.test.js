'use strict';

// 清单 16 批量统一参数的隔离测试。
//
// 核心是两处「取交集」，它们决定面板上给出什么可选值：
//   1. 共同参数键：不同卡片类型的参数根本不是同一套（生图没有「时长」），
//      只挑选中的卡片全都认识的键才敢统一设。
//   2. 共同可选值：同一个「尺寸」键，A 的模型只开 1K、B 开 1K/2K/4K，
//      统一设只该给 1K —— 给只开 1K 的卡片写 2K 会变成它不认的裸值。
// 再验证「预览行」的算法：只列出真的会变的项，本来就一致的卡片不进改动名单。
//
// 前端是 IIFE，函数取不出来，所以用「源码片段提取 + 在沙箱里跑」的办法测纯函数，
// 再配合源码级约束确认面板与入口都接上了。
//
// 运行：runtime/node.exe tools/tests/batch-params.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

// 隔离：本测试只跑纯函数，不碰数据库，仍走统一助手保持范式一致
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-batchparams-'));
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

// 从源码里抠出纯函数，放进沙箱跑（避免为了测试改动生产代码的结构）
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

// 参数定义：和生产代码里 PARAM_DEFS 的形状一致，但值可以按卡片单独给，
// 好构造「不同模型的可用档位不一样」这类场景
const PARAM_DEFS = {
  image: [
    { key: 'size', label: '尺寸', options: ['1K', '2K', '4K'] },
    { key: 'ratio', label: '比例', options: ['16:9', '9:16', '1:1'] },
    { key: 'count', label: '张数', options: ['1', '2'], texts: ['1 张', '2 张'] },
  ],
  video: [
    { key: 'duration', label: '时长', options: ['5', '10'], texts: ['5 秒', '10 秒'] },
    { key: 'resolution', label: '分辨率', options: ['720p', '1080p'], texts: ['720P', '1080P'] },
    { key: 'ratio', label: '比例', options: ['16:9', '9:16', '1:1'] },
    { key: 'mode', label: '模式', options: ['reference', 'frames'], texts: ['全能参考', '首尾帧'] },
  ],
  quick: [
    { key: 'duration', label: '时长', options: ['5', '10'], texts: ['5 秒', '10 秒'] },
    { key: 'ratio', label: '比例', options: ['16:9', '9:16', '1:1'] },
  ],
};

// 每张卡片的「模型可用档位」：spec 存在就按它削，不存在就给全量
const SPECS = {};

const sandbox = { PARAM_DEFS: PARAM_DEFS, SPECS: SPECS, modelsOf: null };
vm.createContext(sandbox);
vm.runInContext(
  [
    'function nodeData(node) { return node.data; }',
    'function modelSpecOf(type, data) {',
    '  var spec = SPECS[String(data && data.model || "")];',
    '  return spec || null;',
    '}',
    // 真假通的 paramDefsOf：按 spec 削选项，和生产代码同一套规则
    'function paramDefsOf(node, data) {',
    '  var defs = PARAM_DEFS[node.type] || [];',
    '  var spec = modelSpecOf(node.type, data);',
    '  if (!spec) return defs;',
    '  return defs.map(function (def) {',
    '    var options = def.options;',
    '    var texts = def.texts;',
    '    if (def.key === "size" && spec.sizes && spec.sizes.length) { options = spec.sizes.slice(); texts = null; }',
    '    else if (def.key === "resolution" && spec.resolutions && spec.resolutions.length) {',
    '      options = spec.resolutions.slice(); texts = options.map(function (v) { return String(v).toUpperCase(); });',
    '    } else if (def.key === "duration" && spec.durations && spec.durations.length) {',
    '      options = spec.durations.map(String); texts = options.map(function (v) { return v + " 秒"; });',
    '    } else if (def.key === "ratio" && spec.ratios && spec.ratios.length) { options = spec.ratios.slice(); texts = null; }',
    '    if (options === def.options) return def;',
    '    return Object.assign({}, def, { options: options, texts: texts });',
    '  });',
    '}',
    'function paramText(def, value) {',
    '  var index = def.options.indexOf(value);',
    '  if (def.texts && index >= 0) return def.texts[index];',
    '  return value;',
    '}',
    // 模型清单替身：由测试逐个用例设置
    'function modelsFor(type) { return modelsOf(type); }',
    // 卡片没标题时预览用的兜底名（生产代码里读 PRESETS[type].label）
    'function presetOf(type) { return { label: { image: "图片", video: "视频", quick: "快速视频" }[type] || "素材" }; }',
    pickFunction('sharedParamKeys'),
    pickFunction('sharedParamOptions'),
    pickFunction('paramsAgreeOn'),
    pickFunction('sharedModels'),
    pickFunction('batchParamPlan'),
    pickFunction('batchParamRows'),
    'globalThis.__sharedParamKeys = sharedParamKeys;',
    'globalThis.__sharedParamOptions = sharedParamOptions;',
    'globalThis.__paramsAgreeOn = paramsAgreeOn;',
    'globalThis.__sharedModels = sharedModels;',
    'globalThis.__batchParamPlan = batchParamPlan;',
    'globalThis.__batchParamRows = batchParamRows;',
  ].join('\n'),
  sandbox
);

function card(id, type, model, params) {
  return { id: id, type: type, data: { model: model || '', params: params || {} } };
}
function keysOf(plan) {
  return plan.defs.map((def) => def.key).join(',');
}

// 默认：所有模型都支持全量档位
sandbox.modelsOf = function () {
  return [
    { key: 'a::m1', id: 'm1', label: '模型一', channelId: 'a' },
    { key: 'a::m2', id: 'm2', label: '模型二', channelId: 'a' },
    { key: 'b::m3', id: 'm3', label: '模型三', channelId: 'b' },
  ];
};

console.log('\n清单16 · 共同参数键');

check('同类型的卡片：取全部参数键', () => {
  const list = [card('a', 'image', 'm1', { size: '2K' }), card('b', 'image', 'm1', { size: '1K' })];
  eq(sandbox.__sharedParamKeys(list).join(','), 'size,ratio,count');
});

check('生图 + 生视频：只留两边都有的键', () => {
  const list = [card('a', 'image', 'm1', {}), card('b', 'video', 'm1', {})];
  // 生图没有 duration / mode，生视频没有 size / count，只剩 ratio
  eq(sandbox.__sharedParamKeys(list).join(','), 'ratio');
});

check('生图 + 生视频 + 快速视频：只剩三者共有的', () => {
  const list = [card('a', 'image', 'm1', {}), card('b', 'video', 'm1', {}), card('c', 'quick', 'm1', {})];
  eq(sandbox.__sharedParamKeys(list).join(','), 'ratio', '快速视频既没有 size 也没有 mode');
});

check('单张卡片：等于它自己的参数键', () => {
  const list = [card('a', 'quick', 'm1', {})];
  eq(sandbox.__sharedParamKeys(list).join(','), 'duration,ratio');
});

check('空列表返回空（不能让面板以为什么都能设）', () => {
  eq(sandbox.__sharedParamKeys([]).length, 0);
});

console.log('\n清单16 · 共同可选值（取交集）');

check('两张卡片档位一样时给全量', () => {
  const list = [card('a', 'image', 'm1', {}), card('b', 'image', 'm1', {})];
  eq(sandbox.__sharedParamOptions(list, 'size').join(','), '1K,2K,4K');
});

check('A 的模型只开 1K、B 开 1K/2K/4K：只给 1K', () => {
  sandbox.SPECS.lite = { sizes: ['1K'] };
  const list = [card('a', 'image', 'lite', {}), card('b', 'image', 'm1', {})];
  eq(sandbox.__sharedParamOptions(list, 'size').join(','), '1K', '只该给两边都能用的值');
});

check('两边完全不相交时给空（面板要说清「没有共同可选的值」）', () => {
  sandbox.SPECS.only768 = { resolutions: ['720p'] };
  const list = [card('a', 'video', 'only768', {}), card('b', 'video', 'mk1080', {})];
  sandbox.SPECS.mk1080 = { resolutions: ['1080p'] };
  eq(sandbox.__sharedParamOptions(list, 'resolution').length, 0);
});

check('选项顺序跟着第一张卡片走', () => {
  sandbox.SPECS.rev = { sizes: ['4K', '2K', '1K'] };
  const list = [card('a', 'image', 'rev', {}), card('b', 'image', 'm1', {})];
  eq(sandbox.__sharedParamOptions(list, 'size').join(','), '4K,2K,1K', '用户看到的顺序该跟第一张一致');
});

check('有卡片不认识这个键时，这个键不该出现在计划里', () => {
  const list = [card('a', 'image', 'm1', {}), card('b', 'quick', 'm1', {})];
  const plan = sandbox.__batchParamPlan(list);
  keysOf(plan).split(',').forEach((key) => {
    assert(key !== 'size' && key !== 'count' && key !== 'duration', '不该出现不合法的键 ' + key);
  });
});

console.log('\n清单16 · 值是否本来就一致');

check('全都一样算一致', () => {
  const list = [card('a', 'image', 'm1', { ratio: '16:9' }), card('b', 'image', 'm1', { ratio: '16:9' })];
  eq(sandbox.__paramsAgreeOn(list, 'ratio'), true);
});

check('有一张不一样就算不一致', () => {
  const list = [card('a', 'image', 'm1', { ratio: '16:9' }), card('b', 'image', 'm1', { ratio: '9:16' })];
  eq(sandbox.__paramsAgreeOn(list, 'ratio'), false);
});

check('数字与字符串同值算一致（面板上存的是字符串）', () => {
  const list = [card('a', 'image', 'm1', { count: 2 }), card('b', 'image', 'm1', { count: '2' })];
  eq(sandbox.__paramsAgreeOn(list, 'count'), true, '2 与 "2" 是同一个值');
});

console.log('\n清单16 · 共同模型');

check('两张卡片的清单一致时，取交集保留顺序', () => {
  const list = [card('a', 'image', 'm1', {}), card('b', 'image', 'm2', {})];
  eq(sandbox.__sharedModels(list).join(','), 'a::m1,a::m2,b::m3');
});

check('跨类型时按类型各自的清单取交集', () => {
  sandbox.modelsOf = function (type) {
    if (type === 'quick') return [{ key: 'v::x', id: 'x', label: '视频X', channelId: 'v' }];
    return [{ key: 'v::x', id: 'x', label: '视频X', channelId: 'v' }, { key: 'v::y', id: 'y', label: '视频Y', channelId: 'v' }];
  };
  const list = [card('a', 'video', 'x', {}), card('b', 'quick', 'x', {})];
  eq(sandbox.__sharedModels(list).join(','), 'v::x', '快速视频只有 x，那就只给 x');
  sandbox.modelsOf = function () {
    return [
      { key: 'a::m1', id: 'm1', label: '模型一', channelId: 'a' },
      { key: 'a::m2', id: 'm2', label: '模型二', channelId: 'a' },
      { key: 'b::m3', id: 'm3', label: '模型三', channelId: 'b' },
    ];
  };
});

check('没有共同模型时给空', () => {
  sandbox.modelsOf = function (type) {
    return type === 'image' ? [{ key: 'i::only', id: 'only', label: '只有它', channelId: 'i' }] : [];
  };
  const list = [card('a', 'image', 'only', {}), card('b', 'video', '', {})];
  eq(sandbox.__sharedModels(list).length, 0);
  sandbox.modelsOf = function () {
    return [
      { key: 'a::m1', id: 'm1', label: '模型一', channelId: 'a' },
      { key: 'a::m2', id: 'm2', label: '模型二', channelId: 'a' },
      { key: 'b::m3', id: 'm3', label: '模型三', channelId: 'b' },
    ];
  };
});

console.log('\n清单16 · 预览行（只列真的会变的）');

check('选中「尺寸 2K」：本来 2K 的卡片不进改动名单', () => {
  const list = [card('a', 'image', 'm1', { size: '2K', ratio: '16:9' }), card('b', 'image', 'm1', { size: '1K', ratio: '16:9' })];
  const rows = sandbox.__batchParamRows(list, { params: { size: '2K' } });
  eq(rows.length, 2);
  eq(rows[0].changed, false, '本来就是 2K，不用改');
  eq(rows[1].changed, true);
  eq(rows[1].changes[0].before, '1K');
  eq(rows[1].changes[0].after, '2K');
});

check('一个项都没选时，没有卡片算「会变」', () => {
  const list = [card('a', 'image', 'm1', { size: '2K' }), card('b', 'image', 'm1', { size: '1K' })];
  const rows = sandbox.__batchParamRows(list, { params: {} });
  eq(rows.filter((row) => row.changed).length, 0);
});

check('改模型也算改动，并记下目标通道', () => {
  const list = [card('a', 'image', 'm1', {}), card('b', 'image', 'm1', {})];
  const rows = sandbox.__batchParamRows(list, { model: 'b::m3' });
  eq(rows[0].changed, true);
  eq(rows[0].modelChange.id, 'm3');
  eq(rows[0].modelChange.channelId, 'b', '换通道要一起换，否则查不到模型');
});

check('已经是这个模型时不重复改（避免白写一次、白留一次档）', () => {
  const list = [card('a', 'image', 'm1', {})];
  const rows = sandbox.__batchParamRows(list, { model: 'a::m1' });
  eq(rows[0].modelChange, null);
  eq(rows[0].changed, false);
});

check('卡片没记通道（老卡片）时，同名模型算「已经是它了」', () => {
  const list = [card('a', 'image', 'm1', {})];
  list[0].data.channelId = '';
  const rows = sandbox.__batchParamRows(list, { model: 'a::m1' });
  eq(rows[0].modelChange, null, '卡片没记通道时，下拉里本来就是选中状态，不该说「会改」');
  eq(rows[0].changed, false);
});

check('卡片记了通道时，换通道算是真改动', () => {
  const list = [card('a', 'image', 'm1', {})];
  list[0].data.channelId = 'a';
  const rows = sandbox.__batchParamRows(list, { model: 'a::m1' });
  eq(rows[0].modelChange, null, '同一个通道同一个模型，不用改');
  const rows2 = sandbox.__batchParamRows(list, { model: 'b::m3' });
  eq(rows2[0].modelChange.channelId, 'b', '换到另一个通道的模型要跟着换通道');
});

check('这张卡片没有那个模型时跳过它，不硬写', () => {
  // m3 只在别的类型里有，生图这张卡片拿不到
  sandbox.modelsOf = function (type) {
    return type === 'image'
      ? [{ key: 'a::m1', id: 'm1', label: '模型一', channelId: 'a' }]
      : [{ key: 'b::m3', id: 'm3', label: '模型三', channelId: 'b' }];
  };
  const list = [card('a', 'image', 'm1', {}), card('b', 'video', 'other', {})];
  const rows = sandbox.__batchParamRows(list, { model: 'b::m3' });
  eq(rows[0].changed, false, '生图卡片没有 m3，就该原样放着');
  eq(rows[1].changed, true, '视频卡片本来用的不是 m3，该改成 m3');
  eq(rows[1].modelChange.id, 'm3');
  sandbox.modelsOf = function () {
    return [
      { key: 'a::m1', id: 'm1', label: '模型一', channelId: 'a' },
      { key: 'a::m2', id: 'm2', label: '模型二', channelId: 'a' },
      { key: 'b::m3', id: 'm3', label: '模型三', channelId: 'b' },
    ];
  };
});

check('参数与模型一起改时，两个改动都记上', () => {
  const list = [card('a', 'image', 'm1', { size: '1K' })];
  list[0].data.channelId = 'a';
  const rows = sandbox.__batchParamRows(list, { params: { size: '2K' }, model: 'a::m2' });
  eq(rows[0].changes.length, 1);
  assert(rows[0].modelChange, '模型改动该一起记');
  eq(rows[0].changed, true);
});

check('卡片没标题时用类型名兜底（预览里不能空白一片）', () => {
  const list = [card('a', 'image', 'm1', {})];
  const rows = sandbox.__batchParamRows(list, { params: { size: '1K' } });
  assert(rows[0].title.length > 0, '该有兜底名');
});

check('文字型选项在预览里显示人话（5 秒而不是 5）', () => {
  const list = [card('a', 'video', 'm1', { duration: '5' })];
  const rows = sandbox.__batchParamRows(list, { params: { duration: '10' } });
  eq(rows[0].changes[0].before, '5 秒');
  eq(rows[0].changes[0].after, '10 秒');
});

console.log('\n清单16 · 面板与入口（源码级约束）');

check('批量栏里有「批量参数」按钮', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'canvas.html'), 'utf8');
  assert(html.indexOf('data-batch="params"') >= 0, 'html 里没有这个按钮');
});

check('按钮的显示与计数跟着选中走', () => {
  assert(canvasSrc.indexOf('batchParamCandidates') >= 0, '缺少候选函数');
  const at = canvasSrc.indexOf('function paintBatchButtons()');
  const body = canvasSrc.slice(at, at + 3000);
  assert(body.indexOf('paramsCount') >= 0, '计数没接上');
  assert(body.indexOf("'批量参数'") >= 0, '按钮文案没接上');
  assert(body.indexOf('paramsCount <= 0') >= 0, '分隔线的显隐没把新按钮算进去');
});

check('点按钮会打开批量参数面板', () => {
  const at = canvasSrc.indexOf("batch === 'rename') openBatchRename()");
  assert(at >= 0, '找不到批量按钮的分派');
  const around = canvasSrc.slice(at, at + 200);
  assert(around.indexOf("batch === 'params'") >= 0 && around.indexOf('openBatchParams') >= 0, '没接到面板');
});

check('候选只收有参数面板的卡片（导演台 / 组合 / 定时组没有）', () => {
  const at = canvasSrc.indexOf('function batchParamCandidates()');
  const body = canvasSrc.slice(at, at + 700);
  assert(body.indexOf("['image', 'video', 'quick']") >= 0, '没按类型过滤');
  assert(body.indexOf('isLocked(node)') >= 0, '没排除锁定的');
  assert(body.indexOf('isHidden(node)') >= 0, '没排除隐藏的');
  assert(body.indexOf('paramDefsOf(') >= 0, '没排除压根没有参数的卡片');
});

check('确认后走 pushHistory（能撤销）', () => {
  const at = canvasSrc.indexOf('function applyBatchParams(');
  assert(at >= 0, '缺少应用函数');
  const body = canvasSrc.slice(at, at + 2400);
  assert(body.indexOf('pushHistory()') >= 0, '改之前没有留档，撤不回来');
  assert(body.indexOf('scheduleSave()') >= 0, '没安排保存');
  assert(body.indexOf('refreshNode(') >= 0, '改完没重画卡片');
});

check('没有任何改动时不写档也不动卡片', () => {
  const at = canvasSrc.indexOf('function applyBatchParams(');
  const body = canvasSrc.slice(at, at + 500);
  const guardAt = body.indexOf('if (!changed.length)');
  const pushAt = body.indexOf('pushHistory()');
  assert(guardAt >= 0, '缺少「没有改动就退出」的判断');
  assert(guardAt < pushAt, '该先判断再留档，否则会压一条与当前相同的快照');
});

check('换模型排在改参数之前（否则 normalizeParams 会把刚设的值收回默认）', () => {
  const at = canvasSrc.indexOf('function applyBatchParams(');
  const body = canvasSrc.slice(at, at + 2400);
  const modelAt = body.indexOf('data.model = row.modelChange.id');
  const paramAt = body.indexOf('data.params[one.key] = one.value');
  assert(modelAt >= 0 && paramAt > 0, '缺少这两段');
  assert(modelAt < paramAt, '模型要先定下来');
});

check('比例变了、卡片没被手动拉过时要跟着变形状', () => {
  const at = canvasSrc.indexOf('function applyBatchParams(');
  const body = canvasSrc.slice(at, at + 4000);
  assert(body.indexOf("one.key === 'ratio'") >= 0, '没处理比例');
  assert(body.indexOf('.sized') >= 0, '没判断是否被手动拉过大小');
  assert(body.indexOf('updateEdgePaths') >= 0, '卡片尺寸变了要跟着重画连线');
});

check('共同键 / 共同值的求法都在（两处取交集）', () => {
  assert(canvasSrc.indexOf('function sharedParamKeys(') >= 0, '缺少共同参数键');
  assert(canvasSrc.indexOf('function sharedParamOptions(') >= 0, '缺少共同可选值');
  const at = canvasSrc.indexOf('function sharedParamOptions(');
  const body = canvasSrc.slice(at, at + 600);
  assert(body.indexOf('filter(') >= 0, '共同可选值该是按交集过滤出来的');
});

check('样式补齐（面板 + 选项行 + 预览行）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'style.css'), 'utf8');
  ['.modal-params', '.params-field', '.params-preview-row', '.params-preview-detail'].forEach((sel) => {
    assert(css.indexOf(sel) >= 0, '缺少样式 ' + sel);
  });
});

console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
