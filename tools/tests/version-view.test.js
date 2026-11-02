'use strict';

// D4 生成来源视图的隔离测试（清单 23）。
//
// 这里测的是「把历史摊开给人看」这条路里最容易出错的一环：**参数搬家的键名对齐**。
//
// 历史里存的 params 是「接口形状」（sizeKey / 数字），卡片上的是「面板形状」（size / 字符串）。
// 直接把这坨盖回卡片，会多出 sizeKey 这种面板不认的键，参数芯片就显示错 —— 而且是那种
// 「看着像能用、实际生成参数不对」的错，不测根本发现不了。
//
// 前端是 IIFE，函数取不出来，所以用「源码片段提取 + 在沙箱里跑」的办法，
// 跟 batch-rename.test.js / locate.test.js 是同一套手法。
//
// 运行：runtime/node.exe tools/tests/version-view.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

// 隔离：本测试只跑纯函数，不碰数据库，仍走统一助手保持范式一致
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-version-'));
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

// 从源码里抠出一个 `const NAME = ...;` 常量（对象字面量 / 数组 / 数字都行）
function pickConst(name) {
  const at = canvasSrc.indexOf('const ' + name + ' =');
  if (at < 0) throw new Error('源码里找不到常量 ' + name);
  const eq1 = canvasSrc.indexOf('=', at);
  let i = eq1 + 1;
  let depth = 0;
  let started = false;
  let inStr = null;
  for (; i < canvasSrc.length; i += 1) {
    const ch = canvasSrc[i];
    if (inStr) {
      if (ch === '\\') i += 1;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') { depth += 1; started = true; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth -= 1; continue; }
    if (ch === ';' && started && depth === 0) break;
    if (!started && ch === '\n') break;
  }
  return 'const ' + name + ' =' + canvasSrc.slice(eq1 + 1, i) + ';';
}

// ---------------------------------------------------------------- 沙箱
const sandbox = {
  touched: [],
  toasts: [],
  pushHistory: function () { sandbox.touched.push('history'); },
  toast: function (msg) { sandbox.toasts.push(String(msg)); },
  refreshNode: function () {},
  normalizeParams: function () {},
  scheduleSave: function () {},
  // 尾部块只有 video / quick 支持；沙箱里没有真实卡片，用它给个开关
  supportsTail: function (node) { return node.type === 'video' || node.type === 'quick'; },
  tailPresetById: function (id) { return String(id) === 'tail-missing' ? null : { id: String(id), name: '预设' + id }; },
  // 测试模式下没有渠道配置，modelSpecOf 返回 null —— 这也是真实代码在没有渠道时的行为
  modelSpecOf: function () { return null; },
  console: console,
  Date: Date,
  Math: Math,
  Number: Number,
  String: String,
  Boolean: Boolean,
  JSON: JSON,
  Array: Array,
  Object: Object,
  Set: Set,
  Infinity: Infinity,
};
vm.createContext(sandbox);
vm.runInContext(
  [
    'function nodeData(node) { if (!node.data) node.data = {}; return node.data; }',
    pickConst('PARAM_DEFS'),
    pickConst('CARD_HISTORY_LIMIT'),
    pickFunction('paramText'),
    pickFunction('paramDefsOf'),
    pickFunction('versionEntryId'),
    pickFunction('cleanVersionResult'),
    pickFunction('submissionMetaOf'),
    pickFunction('currentSubmissionMeta'),
    pickFunction('versionEntriesOf'),
    pickFunction('cardParamsFromEntry'),
    pickFunction('sameParams'),
    pickFunction('versionSummaryOf'),
    pickFunction('versionParamsDiffer'),
    pickFunction('applyVersionParams'),
    // 键名别名表：从源码里照抄，改坏了测试会跟着红
    pickConst('PARAM_KEY_ALIAS'),
  ].join('\n'),
  sandbox
);

const S = sandbox;

// openVersionPanel 有七千多字符，按固定长度切片容易切不到后半段 —— 
// 按函数结尾切，断言不受函数变长变短影响。
function panelBody() {
  const at = canvasSrc.indexOf('function openVersionPanel(');
  const end = canvasSrc.indexOf('function versionTimeText', at);
  return canvasSrc.slice(at, end > at ? end : at + 9000);
}

function mkImage(over) {
  return Object.assign(
    {
      id: 'n1',
      type: 'image',
      data: {
        text: '一只猫',
        model: 'gpt-image-2',
        params: { size: '2K', ratio: '16:9', count: '1' },
      },
    },
    over || {}
  );
}

console.log('\nD4 · 参数搬家（历史里是接口形状，卡片上是面板形状）');

check('sizeKey → size：接口形状的参数搬回面板', () => {
  const got = S.cardParamsFromEntry({ params: { sizeKey: '2K', ratio: '16:9', count: 1 } }, mkImage());
  eq(got.size, '2K', 'sizeKey 该落到 size 上');
  eq(got.ratio, '16:9');
  eq(got.count, '1', '数字该转成字符串');
});

check('不留下面板不认的键（sizeKey 不能原样带出来）', () => {
  const got = S.cardParamsFromEntry({ params: { sizeKey: '2K', ratio: '16:9', count: 1 } }, mkImage());
  assert(!('sizeKey' in got), 'sizeKey 不该出现在面板参数里');
  assert(!('duration' in got), '图片卡片没有 duration，不该凭空补上');
  assert(!('mode' in got), '图片卡片没有 mode，不该凭空补上');
});

check('只保留这张卡片真有的参数键', () => {
  // 视频历史里带着 duration/resolution；搬到图片卡片上就该被过滤掉
  const got = S.cardParamsFromEntry(
    { params: { duration: 5, resolution: '768p', ratio: '16:9' } },
    mkImage()
  );
  assert(!('duration' in got), '图片卡片不该拿到 duration');
  assert(!('resolution' in got), '图片卡片不该拿到 resolution');
  eq(got.ratio, '16:9', '共有的键该留下');
});

check('视频卡片搬家：数字时长保留（面板值本身就是字符串）', () => {
  const node = { id: 'v1', type: 'video', data: { model: 'MiniMax-H3', params: { duration: '5', resolution: '768p', ratio: '16:9', mode: 'reference' } } };
  const got = S.cardParamsFromEntry({ params: { sizeKey: '', ratio: '16:9', count: 1, duration: 5, resolution: '768p', mode: 'reference' } }, node);
  eq(got.duration, '5');
  eq(got.resolution, '768p');
  eq(got.mode, 'reference');
  assert(!('sizeKey' in got), 'sizeKey 是空的，不该落进来');
});

check('面板形状的参数也能直接喂（老数据 / 新数据都认）', () => {
  const got = S.cardParamsFromEntry({ params: { size: '4K', ratio: '1:1', count: '2' } }, mkImage());
  eq(got.size, '4K', '本来就叫 size 的也该认');
  eq(got.count, '2');
});

check('参数缺失 / 坏值时安全返回空表', () => {
  eq(JSON.stringify(S.cardParamsFromEntry(null, mkImage())), '{}');
  eq(JSON.stringify(S.cardParamsFromEntry({}, mkImage())), '{}');
  eq(JSON.stringify(S.cardParamsFromEntry({ params: null }, mkImage())), '{}');
  eq(JSON.stringify(S.cardParamsFromEntry({ params: 'not-an-object' }, mkImage())), '{}');
});

console.log('\nD4 · 参数比较（决定要不要给「照这版改回来」按钮）');

check('一样就是一样', () => {
  assert(S.sameParams({ size: '2K', ratio: '16:9' }, { size: '2K', ratio: '16:9' }) === true);
});

check('值不同算不一样', () => {
  assert(S.sameParams({ size: '2K' }, { size: '4K' }) === false);
});

check('键的个数不同算不一样（少了也算）', () => {
  assert(S.sameParams({ size: '2K', ratio: '16:9' }, { size: '2K' }) === false);
  assert(S.sameParams({ size: '2K' }, { size: '2K', ratio: '16:9' }) === false);
});

check('缺失的键与空串视为同一个空值', () => {
  // 语义：比较的是「每个键的值」，缺失 / undefined / null / 空串都当同一个空值。
  // 之所以敢这么宽松：真正调它的 versionParamsDiffer 里，now 是照着 want 的键
  // 一个个取的，两边键集天然对齐，不会出现「一边有一边没有」影响判断的情况。
  assert(S.sameParams({ size: '2K' }, { size: '2K', ratio: '' }) === true, '缺失与空串该当同一个空值');
  assert(S.sameParams({ size: '2K', ratio: undefined }, { size: '2K', ratio: '' }) === true);
  assert(S.sameParams({ size: '2K', ratio: null }, { size: '2K', ratio: '' }) === true);
  // 但真有值 vs 空值，仍然不一样
  assert(S.sameParams({ size: '2K', ratio: '16:9' }, { size: '2K', ratio: '' }) === false, '有值与空值不该算一样');
});

check('参数与现在一致时不给「改回来」按钮', () => {
  const node = mkImage({ data: { text: '一只猫', model: 'gpt-image-2', params: { size: '2K', ratio: '16:9', count: '1' } } });
  const entry = { model: 'gpt-image-2', params: { sizeKey: '2K', ratio: '16:9', count: 1 } };
  assert(S.versionParamsDiffer(entry, node) === false, '参数一样却说要改');
});

check('参数不一致时给「改回来」按钮', () => {
  const node = mkImage({ data: { text: '一只猫', model: 'gpt-image-2', params: { size: '4K', ratio: '16:9', count: '1' } } });
  const entry = { model: 'gpt-image-2', params: { sizeKey: '2K', ratio: '16:9', count: 1 } };
  assert(S.versionParamsDiffer(entry, node) === true, '尺寸不一样却没发现');
});

check('模型不同也算不一致（历史里记着当时的模型）', () => {
  const node = mkImage({ data: { text: '一只猫', model: 'gpt-image-2-plus', params: { size: '2K', ratio: '16:9', count: '1' } } });
  const entry = { model: 'gpt-image-2', params: { sizeKey: '2K', ratio: '16:9', count: 1 } };
  assert(S.versionParamsDiffer(entry, node) === true, '换了模型却没发现');
});

check('历史没记模型时不拿它当差异（老数据缺字段）', () => {
  const node = mkImage({ data: { text: '一只猫', model: 'gpt-image-2', params: { size: '2K', ratio: '16:9', count: '1' } } });
  const entry = { model: '', params: { sizeKey: '2K', ratio: '16:9', count: 1 } };
  assert(S.versionParamsDiffer(entry, node) === false, '没记模型不该算差异');
});

console.log('\nD4 · 一版怎么描述给人看');

check('摘要里带上模型、各项参数、参考素材数、尾部预设', () => {
  const node = mkImage();
  const parts = S.versionSummaryOf(
    { model: 'gpt-image-2', params: { sizeKey: '2K', ratio: '16:9', count: 2 }, refs: [{}, {}, {}], tailPresetName: '3D国漫' },
    node
  );
  const text = parts.join(' | ');
  assert(text.indexOf('模型 gpt-image-2') >= 0, text);
  assert(text.indexOf('尺寸 2K') >= 0, '参数该用面板上的标签（尺寸）而不是 sizeKey：' + text);
  assert(text.indexOf('张数 2 张') >= 0, '张数该用中文文案：' + text);
  assert(text.indexOf('3 个参考素材') >= 0, text);
  assert(text.indexOf('尾部：3D国漫') >= 0, text);
});

check('参数取值用面板的显示文案（2 张而不是 2）', () => {
  const parts = S.versionSummaryOf({ params: { count: '2' } }, mkImage());
  assert(parts.join(' ').indexOf('2 张') >= 0, parts.join(' '));
});

check('什么都没记时返回空表（调用方显示「没有留下参数记录」）', () => {
  const parts = S.versionSummaryOf({ params: {} }, mkImage());
  eq(parts.length, 0);
});

check('参考素材没有时不写「0 个参考素材」', () => {
  const parts = S.versionSummaryOf({ model: 'm', params: { sizeKey: '2K' } }, mkImage());
  assert(parts.join(' ').indexOf('参考素材') < 0, parts.join(' '));
});

console.log('\nD4 · 照这版参数改回来');

check('参数、模型都真的写回卡片', () => {
  const node = mkImage({ data: { text: '一只猫', model: 'gpt-image-2-plus', params: { size: '4K', ratio: '9:16', count: '3' } } });
  const entry = { model: 'gpt-image-2', params: { sizeKey: '2K', ratio: '16:9', count: 1 } };
  S.touched = [];
  const changed = S.applyVersionParams(node, entry);
  eq(node.data.params.size, '2K');
  eq(node.data.params.ratio, '16:9');
  eq(node.data.params.count, '1');
  eq(node.data.model, 'gpt-image-2');
  assert(changed.length >= 4, '改了四项该都报出来，实报 ' + changed.length);
});

check('改之前留档（能撤销）', () => {
  const node = mkImage();
  S.touched = [];
  S.applyVersionParams(node, { model: 'x', params: { sizeKey: '4K' } });
  assert(S.touched.indexOf('history') >= 0, '没有 pushHistory，撤不回来');
});

check('参数一模一样时不乱改也不留档', () => {
  const node = mkImage({ data: { text: '一只猫', model: 'gpt-image-2', params: { size: '2K', ratio: '16:9', count: '1' } } });
  S.touched = [];
  S.toasts = [];
  const changed = S.applyVersionParams(node, { model: 'gpt-image-2', params: { sizeKey: '2K', ratio: '16:9', count: 1 } });
  eq(changed, 0);
  eq(S.touched.length, 0, '没改动就不该留档');
  assert(S.toasts.length > 0, '该告诉用户「没什么要改的」');
});

check('尾部提示词一起换过去（那一版的预设还在的话）', () => {
  const node = { id: 'v1', type: 'video', data: { text: '一段', model: 'MiniMax-H3', params: { duration: '5', resolution: '768p', ratio: '16:9', mode: 'reference' }, tailPrompt: { enabled: true, presetId: 'tail-old' } } };
  const entry = { model: 'MiniMax-H3', params: { duration: 5, resolution: '768p', ratio: '16:9', mode: 'reference' }, tailPresetId: 'tail-new', tailPresetName: '新风格' };
  S.applyVersionParams(node, entry);
  eq(node.data.tailPrompt.presetId, 'tail-new', '尾部预设该换过去');
});

check('那一版的尾部预设已经被删了 → 保留现在的，不改成空', () => {
  const node = { id: 'v1', type: 'video', data: { text: '一段', model: 'MiniMax-H3', params: { duration: '5', resolution: '768p', ratio: '16:9', mode: 'reference' }, tailPrompt: { enabled: true, presetId: 'tail-keep' } } };
  const entry = { model: 'MiniMax-H3', params: { duration: 5, resolution: '768p', ratio: '16:9', mode: 'reference' }, tailPresetId: 'tail-missing' };
  S.applyVersionParams(node, entry);
  eq(node.data.tailPrompt.presetId, 'tail-keep', '预设没了就不该动，不能把用户的设置清掉');
});

console.log('\nD4 · 版本列表本身');

check('当前显示的那一版排在最前，且标出来', () => {
  const data = {
    text: '一只猫',
    model: 'gpt-image-2',
    result: { url: '/a.png', kind: 'image', at: 300 },
    history: [{ id: 'h1', result: { url: '/b.png', kind: 'image', at: 200 }, params: {} }],
  };
  const entries = S.versionEntriesOf(data);
  eq(entries.length, 2);
  eq(entries[0].result.url, '/a.png', '当前那版该排第一');
  eq(entries[0].id, 'current', '当前那版该带 current 标记');
  eq(entries[1].result.url, '/b.png');
});

check('同一张图出现两次时只留一条（按 URL 去重）', () => {
  const data = {
    text: '一只猫',
    model: 'm',
    result: { url: '/a.png', kind: 'image', at: 300 },
    history: [
      { id: 'h1', result: { url: '/a.png', kind: 'image', at: 300 }, params: {} },
      { id: 'h2', result: { url: '/b.png', kind: 'image', at: 200 }, params: {} },
    ],
  };
  const entries = S.versionEntriesOf(data);
  eq(entries.length, 2, 'a 出现在当前与历史里，只该算一条');
  eq(entries.map((one) => one.result.url).join(','), '/a.png,/b.png');
});

check('历史里保留参考素材清单（C3 补的字段能一路带到面板）', () => {
  const entry = S.submissionMetaOf({ refs: [{ name: '图1', kind: 'image', role: 'ref', src: '/r.png' }] }, {});
  eq(entry.refs.length, 1);
  eq(entry.refs[0].name, '图1');
  eq(entry.refCount, 1, 'refCount 该跟着算出来');
});

console.log('\nD4 · 源码级约束');

check('面板从历史数据取版本，不另建一套存储', () => {
  const at = canvasSrc.indexOf('function openVersionPanel(');
  assert(at >= 0, '缺少 openVersionPanel');
  const body = canvasSrc.slice(at, at + 600);
  assert(body.indexOf('versionEntriesOf(') >= 0, '没走 versionEntriesOf，可能自己拼了一套');
});

check('「切到这一版」复用既有的 switchCardVersion（不另写切换逻辑）', () => {
  const at = canvasSrc.indexOf('function openVersionPanel(');
  const body = panelBody();
  assert(body.indexOf('switchCardVersion(') >= 0, '没复用切换版本的实现');
});

check('「照这版参数改回来」明确不动已生成的结果', () => {
  const at = canvasSrc.indexOf('function applyVersionParams(');
  assert(at >= 0, '缺少 applyVersionParams');
  const body = canvasSrc.slice(at, at + 2000);
  assert(body.indexOf('data.result') < 0, '不该碰 result（换结果是「切换版本」的事）');
  assert(body.indexOf('data.params[one.key] = one.value') >= 0, '没写回参数');
  assert(body.indexOf('refreshNode(') >= 0, '改完没重画卡片');
  assert(body.indexOf('scheduleSave()') >= 0, '改完没安排保存');
});

check('参数没变化时不往撤销栈里压一条空档', () => {
  // pushHistory 拍的是改动前的样子。要是先拍照再判断有没有改动，
  // 参数本来就一样时也会压一条与当前完全相同的快照 —— 用户按「撤销」会像没反应。
  const at = canvasSrc.indexOf('function applyVersionParams(');
  const body = canvasSrc.slice(at, at + 2000);
  const guardAt = body.indexOf('if (!changed.length)');
  const pushAt = body.indexOf('pushHistory();');
  assert(guardAt >= 0 && pushAt >= 0, '缺少「无改动」判断或 pushHistory');
  assert(guardAt < pushAt, '先拍照再判断：无改动时也会留一条空档');
});

check('当前那一版不给「切到这一版」（避免点了没反应）', () => {
  const at = canvasSrc.indexOf('function openVersionPanel(');
  const body = panelBody();
  assert(body.indexOf('if (!isCurrent)') >= 0, '没按「是不是当前版」分叉');
  assert(body.indexOf('现在用的就是这一版') >= 0, '当前版该明说一句，而不是留个空位');
});

check('只生成过一版时给一句人话，而不是空面板', () => {
  const at = canvasSrc.indexOf('function openVersionPanel(');
  const body = panelBody();
  assert(body.indexOf('只生成过一版') >= 0, '缺少只有一版时的提示');
});

check('展开的卡片面板里挂上了入口', () => {
  const at = canvasSrc.indexOf('function buildVersionStrip(');
  assert(at >= 0, '缺少 buildVersionStrip');
  const body = canvasSrc.slice(at, at + 2200);
  assert(body.indexOf('openVersionPanel(node)') >= 0, '版本条上没有打开来源面板的入口');
  assert(body.indexOf('生成来源') >= 0, '入口没有可见文字');
});

check('右键菜单里也有入口（展开卡片之外的第二条路）', () => {
  const at = canvasSrc.indexOf('function openNodeMenu(');
  assert(at >= 0, '缺少 openNodeMenu');
  const body = canvasSrc.slice(at, at + 3000);
  assert(body.indexOf('生成来源…') >= 0, '右键菜单里没有「生成来源」');
  assert(body.indexOf('openVersionPanel(node)') >= 0, '菜单项没接上面板');
});

check('没生成过的卡片不给这一项（点了只会弹「没有可看的」）', () => {
  const at = canvasSrc.indexOf("label: '生成来源…'");
  assert(at >= 0, '没找到菜单项');
  const before = canvasSrc.slice(Math.max(0, at - 260), at);
  assert(before.indexOf('versionEntriesOf(data).length >= 1') >= 0, '菜单项没有前置条件');
});

check('样式补齐（面板 + 时间线 + 按钮）', () => {
  ['.modal-version', '.version-timeline', '.version-row', '.version-dot', '.version-thumb', '.version-actions', '.version-source-btn'].forEach((sel) => {
    assert(cssSrc.indexOf(sel) >= 0, '缺少样式 ' + sel);
  });
});

check('时间线上能看出「哪版是当前」「哪版最近」', () => {
  const at = canvasSrc.indexOf('function openVersionPanel(');
  const body = panelBody();
  assert(body.indexOf('当前显示') >= 0, '没标出当前版');
  assert(body.indexOf('最近一版') >= 0, '没标出最近一版');
});

check('脚注统计「有几版参数与现在不同」（不用一版版自己数）', () => {
  const at = canvasSrc.indexOf('function openVersionPanel(');
  const body = panelBody();
  assert(body.indexOf('版的参数与现在不一样') >= 0, '没有差异统计');
});

console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
