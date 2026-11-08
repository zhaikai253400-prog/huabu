'use strict';

// C5 三入口参数统一的隔离测试（清单 42）。
//
// 背景：同一张卡片有三条提交路径 —— 单卡 / 批量（前端 buildGeneratePayload）、
// 定时组（服务端 scheduler 从快照重建）。改造前三条路各写各的默认值，
// 典型漂移是 mode：单卡没选模式时传空串，定时组快照写死 'reference'，
// 于是同一张卡片在通道模板里拿到的 {{mode}} 会忽空忽有。
//
// 现在规则收在 web/assets/payload-rules.js，前后端共用同一份源码。
// 本测试就盯着「同一份输入、三条路必须产出同一份 payload」这件事。
//
// 运行：runtime/node.exe tools/tests/payload-rules.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');

// 隔离：本测试只调纯函数，不碰数据库，但仍走统一助手保持范式一致
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-payload-'));
require(path.join(__dirname, '_isolate.js'))(box);

const rules = require(path.join(ROOT, 'web', 'assets', 'payload-rules.js'));
const generate = require(path.join(SERVER, 'generate.js'));

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

console.log('\nC5 · 共享规则模块（web/assets/payload-rules.js）');

check('服务端能 require 这个模块（UMD 双端可用）', () => {
  assert(rules && typeof rules.assemble === 'function', 'assemble 没有导出');
  assert(Array.isArray(rules.MODES), 'MODES 没有导出');
  assert(rules.TAIL_KINDS && rules.TAIL_KINDS.video === 1, 'TAIL_KINDS 没有导出');
});

check('模块不依赖任何运行时：源码里不出现 require / window / document', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'payload-rules.js'), 'utf8');
  const body = src.split('function () {')[1] || '';
  ['require(', 'window.', 'document.', 'process.'].forEach((bad) => {
    assert(body.indexOf(bad) < 0, '模块内部不该出现 ' + bad);
  });
});

console.log('\nC5 · 模式归一（本次统一的核心）');

check('视频卡没选模式 -> reference', () => {
  eq(rules.normalizeMode('video', ''), 'reference');
  eq(rules.normalizeMode('video', null), 'reference');
});

check('视频卡选了合法模式 -> 保持原样', () => {
  eq(rules.normalizeMode('video', 'frames'), 'frames');
  eq(rules.normalizeMode('video', 'text'), 'text');
  eq(rules.normalizeMode('video', 'reference'), 'reference');
});

check('视频卡塞了不认识的值 -> 回落到 reference（不把脏值递给接口）', () => {
  eq(rules.normalizeMode('video', 'xxx'), 'reference');
  eq(rules.normalizeMode('video', 123), 'reference');
});

check('快速视频固定 reference（卡片上没这个选项）', () => {
  eq(rules.normalizeMode('quick', ''), 'reference');
  eq(rules.normalizeMode('quick', 'frames'), 'reference');
});

check('图片 / 音频不接受模式 -> 空串（硬塞值会让通道模板判断走偏）', () => {
  eq(rules.normalizeMode('image', ''), '');
  eq(rules.normalizeMode('image', 'reference'), '');
  eq(rules.normalizeMode('image', 'frames'), '');
  eq(rules.normalizeMode('image', 'text'), '');
  eq(rules.normalizeMode('image', undefined), '');
  eq(rules.normalizeMode('audio', 'reference'), '');
  eq(rules.normalizeMode('audio', 'frames'), '');
  eq(rules.normalizeMode('audio', undefined), '');
});

// 这一条是**反向断言**，守着一个很容易再次踩进去的坑：
// normalizeMode 原来拿 isTailKind（"支持不支持尾部提示词"）当判据来决定
// "接不接受 mode"，两件本来无关的事被绑在一起。给图片卡加上尾部提示词之后，
// isTailKind('image') 变成 true，图片的 mode 就会被填成 'reference'（本该为空串）。
// 所以这里**不看 TAIL_KINDS 里有没有 image**，而是直接断言行为：
// 不管尾部提示词支持哪些类型，图片 / 音频的 mode 永远必须是空串。
check('反向断言：尾部提示词的支持范围与"接不接受 mode"必须解耦', () => {
  // 模拟"图片也被算作支持尾部提示词"的情形：判据若仍借用 isTailKind 就会在这里露馅
  const fakeRules = fs.readFileSync(
    path.join(__dirname, '..', '..', 'web', 'assets', 'payload-rules.js'), 'utf8');
  const modeFn = /function normalizeMode\(nodeType, rawMode\) \{[\s\S]*?\n  \}/.exec(fakeRules);
  assert(modeFn, '抽不出 normalizeMode');
  assert(!/isTailKind\(nodeType\)/.test(modeFn[0]),
    'normalizeMode 又在借用 isTailKind 当判据了 —— 图片卡一旦支持尾部提示词，' +
    '它的 mode 就会被填成 reference，通道模板里的 {{mode}} 判断会走偏');
  assert(/kind !== 'video'/.test(modeFn[0]),
    'normalizeMode 应当用「是不是视频这一类」来判断，而不是「支不支持尾部提示词」');

  // 行为层面再确认一次：图片 + 任意 mode 都必须是空串
  ['', 'reference', 'frames', 'text', undefined, null, 0].forEach((m) => {
    eq(rules.normalizeMode('image', m), '', 'image 传 ' + JSON.stringify(m));
  });
});

console.log('\nC5 · 张数 / 参考素材归一');

check('张数卡在 1~4', () => {
  eq(rules.clampCount(0), 1);
  eq(rules.clampCount(-3), 1);
  eq(rules.clampCount(''), 1);
  eq(rules.clampCount('abc'), 1);
  eq(rules.clampCount('2'), 2);
  eq(rules.clampCount(4), 4);
  eq(rules.clampCount(9), 4);
});

check('参考素材只留接口要的四个字段，并剔掉没有地址的', () => {
  const out = rules.normalizeRefs([
    { src: '/media/a.png', kind: 'image', name: '甲', role: 'reference', extra: '丢掉' },
    { url: '/media/b.mp4', kind: 'video', name: '乙', role: 'first_frame' },
    { name: '没有地址' },
    null,
  ]);
  eq(out.length, 2, '条数');
  eq(out[0].url, '/media/a.png');
  eq(Object.keys(out[0]).sort().join(','), 'kind,name,role,url');
  eq(out[1].role, 'first_frame');
});

check('参考素材不是数组时安全返回空表', () => {
  eq(rules.normalizeRefs(null).length, 0);
  eq(rules.normalizeRefs('nope').length, 0);
});

console.log('\nC5 · 尾部提示词归一（前后端曾各写一份）');

check('true / 对象 / 其它值三种写法都归一', () => {
  eq(rules.normalizeTailChoice(true).enabled, true);
  eq(rules.normalizeTailChoice(false).enabled, false);
  eq(rules.normalizeTailChoice(null).enabled, false);
  eq(rules.normalizeTailChoice('随便').enabled, false);
  eq(rules.normalizeTailChoice({ enabled: true, presetId: 7 }).presetId, '7');
  eq(rules.normalizeTailChoice({ enabled: false }).enabled, false);
});

check('服务端 generate 的 normalizeTailChoice 就是共享这份', () => {
  const cases = [true, false, null, 'x', { enabled: true, presetId: 'a' }, { presetId: 3 }];
  cases.forEach((value) => {
    eq(
      JSON.stringify(generate.normalizeTailChoice(value)),
      JSON.stringify(rules.normalizeTailChoice(value)),
      '入参 ' + JSON.stringify(value)
    );
  });
});

console.log('\nC5 · assemble 装配（三条入口都走它）');

check('params 写法与平铺写法等价', () => {
  const a = rules.assemble({ nodeType: 'video', params: { size: '2K', ratio: '16:9', count: '3', mode: 'frames' } });
  const b = rules.assemble({ nodeType: 'video', sizeKey: '2K', ratio: '16:9', count: '3', mode: 'frames' });
  eq(a.sizeKey, b.sizeKey);
  eq(a.ratio, b.ratio);
  eq(a.count, b.count);
  eq(a.mode, b.mode);
});

check('平铺值优先于 params 里的同名值', () => {
  const out = rules.assemble({ nodeType: 'video', sizeKey: '4K', params: { size: '1K' } });
  eq(out.sizeKey, '4K');
});

// 【需求变更】原来是"图片卡不带尾部选择"，现在图片卡也要有尾部提示词了。
// 注意 `mode` 那一行**必须保留** —— 它是"图片不接受 mode"的护栏，
// 而且 normalizeMode 曾经错误地借用 isTailKind 当判据，正是这条断言把那事挡住的。
check('图片卡：mode 仍为空串，且**现在可以**带尾部选择', () => {
  const out = rules.assemble({ nodeType: 'image', params: { mode: 'reference' }, tailPrompt: { enabled: true } });
  eq(out.kind, 'image');
  eq(out.mode, '', '图片卡的 mode 必须永远是空串');
  eq(out.tailPrompt.enabled, true, '图片卡现在应当可以带尾部选择');
  // 反过来也要守住：不支持的类型仍然必须被关掉
  const audio = rules.assemble({ nodeType: 'audio', tailPrompt: { enabled: true } });
  eq(audio.tailPrompt.enabled, false, '音频卡不该带尾部选择');
});

check('视频卡：保留尾部选择；快速卡也算支持尾部', () => {
  const v = rules.assemble({ nodeType: 'video', tailPrompt: true });
  eq(v.kind, 'video');
  eq(v.tailPrompt.enabled, true);
  const q = rules.assemble({ nodeType: 'quick', tailPrompt: { enabled: true, presetId: 'p1' } });
  eq(q.kind, 'video', '快速视频在接口眼里就是视频');
  eq(q.tailPrompt.presetId, 'p1');
});

check('没给 channelName 就不塞这个字段（单卡提交靠 channelId 找通道）', () => {
  const out = rules.assemble({ nodeType: 'video' });
  assert(!('channelName' in out), '不该凭空多出 channelName');
  const withName = rules.assemble({ nodeType: 'video', channelName: '主线' });
  eq(withName.channelName, '主线');
});

console.log('\nC5 · 三条入口产出一致（本次要解决的核心问题）');

// 同一张视频卡的三份输入：前端读卡片、定时组快照、服务端收到的请求体
function videoCardInputs() {
  const shared = {
    canvasId: 'c1',
    nodeId: 'n1',
    model: 'veo-3',
    prompt: '一只猫',
    promptRaw: '一只猫',
    params: { size: '', ratio: '16:9', count: '1', duration: 5, resolution: '720p', mode: '' },
    refs: [{ url: '/media/a.png', kind: 'image', name: '参考图', role: 'reference' }],
  };
  return {
    // 单卡 / 批量：前端 buildGeneratePayload 把 params 整块喂进 assemble
    single: rules.assemble(Object.assign({ nodeType: 'video' }, shared)),
    // 定时组：快照里也是 params，服务端 scheduler 同样喂进 assemble
    schedule: rules.assemble(Object.assign({ nodeType: 'video' }, shared)),
    // 服务端收敛点：请求体已经是平铺结构，再过一次 normalizePayload
    server: generate.normalizePayload(Object.assign({ kind: 'video' }, shared)),
  };
}

check('mode 三条路一致（改造前：单卡空串 / 定时组 reference）', () => {
  const { single, schedule, server } = videoCardInputs();
  eq(single.mode, 'reference');
  eq(schedule.mode, single.mode, '定时组与单卡');
  eq(server.mode, single.mode, '服务端收敛点与单卡');
});

check('张数、参考素材也三条路一致', () => {
  const { single, schedule, server } = videoCardInputs();
  eq(schedule.count, single.count);
  eq(server.count, single.count);
  eq(server.refs.length, single.refs.length);
  eq(server.refs[0].url, '/media/a.png');
});

check('服务端 normalizePayload 与共享规则同源（mode / count / refs 逐项对齐）', () => {
  const cases = [
    { kind: 'video', nodeType: 'video', mode: '', count: 9, refs: [{ src: '/m/a.png', kind: 'image' }] },
    { kind: 'video', nodeType: 'quick', mode: 'frames', count: 0, refs: [] },
    { kind: 'image', mode: 'reference', count: '2', refs: [{ name: '无地址' }] },
  ];
  cases.forEach((item) => {
    const viaServer = generate.normalizePayload(item, item.kind);
    eq(viaServer.mode, rules.normalizeMode(item.nodeType, item.mode), 'mode');
    eq(viaServer.count, rules.clampCount(item.count), 'count');
    eq(viaServer.refs.length, rules.normalizeRefs(item.refs).length, 'refs');
    eq(viaServer.kind, item.kind, 'kind 保持');
  });
});

check('服务端归一不动提示词相关字段（resumeTask 要靠它接续）', () => {
  const out = generate.normalizePayload(
    { kind: 'video', prompt: '甲', promptRaw: '乙', frozenTail: { enabled: true, text: '尾巴' }, apiPrompt: '甲\n尾巴' },
    'video'
  );
  eq(out.prompt, '甲');
  eq(out.promptRaw, '乙');
  eq(out.apiPrompt, '甲\n尾巴');
  eq(out.frozenTail.text, '尾巴', '冻结的尾部提示词不能被归一冲掉');
});

check('服务端归一不丢未知字段（通道名、附加参数等仍要能传到下游）', () => {
  const out = generate.normalizePayload(
    { kind: 'video', channelName: '主线', tailOverride: { mode: 'none' }, 自定义: 1 },
    'video'
  );
  eq(out.channelName, '主线');
  eq(out.tailOverride.mode, 'none');
  eq(out['自定义'], 1);
});

check('preflight 也用同一套归一（预览看到的 = 实际提交的）', () => {
  // preflight 是 async，这里只校验它内部调用的归一函数已导出且同源
  assert(typeof generate.normalizePayload === 'function', 'normalizePayload 没有导出');
  const src = fs.readFileSync(path.join(SERVER, 'generate.js'), 'utf8');
  const body = src.split('async function preflight')[1] || '';
  assert(body.indexOf('normalizePayload(payload') >= 0, 'preflight 里没有走归一');
});

console.log('\nC5 · 前端不再自己判默认值（源码级约束）');

check('前端 buildGeneratePayload 走共享 assemble，不再自己写 mode 默认值', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const body = src.split('function buildGeneratePayload(node) {')[1] || '';
  const fn = body.split('\n  }\n')[0] || '';
  assert(fn.indexOf('rules.assemble') >= 0, 'buildGeneratePayload 没有调共享装配');
  assert(fn.indexOf("'reference'") < 0, 'buildGeneratePayload 里还残留写死的 reference');
});

check('定时组快照不再把空 mode 写死成 reference', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const body = src.split('function snapshotOfMember(member) {')[1] || '';
  const fn = body.split('\n  }\n')[0] || '';
  assert(fn.indexOf("params.mode || 'reference'") < 0, '快照里还在写死 reference');
});

check('canvas.html 引了共享规则脚本，且在 canvas.js 之前', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'canvas.html'), 'utf8');
  const rulesAt = html.indexOf('/assets/payload-rules.js');
  const canvasAt = html.indexOf('/assets/canvas.js');
  assert(rulesAt >= 0, 'html 里没有引 payload-rules.js');
  assert(canvasAt < 0 || rulesAt < canvasAt, 'payload-rules.js 必须排在 canvas.js 之前');
});

// ── 图片卡尾部提示词 + 两个池子互不相通 ─────────────────────────────
//
// 需求：给图片卡也加尾部提示词，但**图片和视频的预设互不相通**
//（视频那套会写「无 BGM、嘴型不动」，塞进图片请求是噪声）。
//
// 这里守三件事：
//   ① 图片卡确实进了"支持尾部"的清单
//   ② 图片的 mode 仍然永远是空串（与①解耦，见上面那条反向断言）
//   ③ 服务端按 kind 取到的是**不同的池子**
console.log('\nC5 · 图片卡尾部提示词与"两个池子不互通"');

check('图片卡进了支持尾部的清单，音频 / 其他类型没有', () => {
  assert(rules.isTailKind('image'), '图片卡应当支持尾部提示词');
  assert(rules.isTailKind('video'), '视频卡应当支持尾部提示词');
  assert(rules.isTailKind('quick'), '快速视频应当支持尾部提示词');
  assert(!rules.isTailKind('audio'), '音频卡不该支持尾部提示词');
  assert(!rules.isTailKind('zone'), '区域不该支持尾部提示词');
  assert(!rules.isTailKind('generate'), '生成组不该支持尾部提示词');
});

check('assemble 对图片卡保留尾部选择，且不影响 mode', () => {
  const on = rules.assemble({ nodeType: 'image', tailPrompt: { enabled: true, presetId: 'p-img' } });
  eq(on.tailPrompt.enabled, true);
  eq(on.tailPrompt.presetId, 'p-img');
  eq(on.mode, '', '图片的 mode 必须仍是空串');
  const off = rules.assemble({ nodeType: 'image', tailPrompt: { enabled: false } });
  eq(off.tailPrompt.enabled, false);
  eq(off.tailPrompt.presetId, '');
});

check('**服务端按 kind 取到不同的池子**（图片 / 视频不互通）', () => {
  const configStore = require(path.join(SERVER, 'config.js'));
  const cfg = configStore.normalizeTailPrompts({
    enabled: true,
    groups: {
      video: { defaultId: 'v1', presets: [{ id: 'v1', name: '视频风', text: '视频专用尾部' }] },
      image: { defaultId: 'i1', presets: [{ id: 'i1', name: '图片风', text: '图片专用尾部' }] },
    },
  });
  const vPool = configStore.tailPoolOfConfig(cfg, 'video');
  const iPool = configStore.tailPoolOfConfig(cfg, 'image');
  eq(vPool.defaultId, 'v1');
  eq(iPool.defaultId, 'i1');
  eq(vPool.presets.length, 1);
  eq(iPool.presets.length, 1);
  // 内容必须真的不同 —— 否则"不互通"没法验证
  assert(vPool.presets[0].text !== iPool.presets[0].text, '两个池子内容相同，测不出互通与否');
  // 快速视频算视频
  eq(configStore.tailPoolOfConfig(cfg, 'quick').defaultId, 'v1');
  // 给错值退回视频池，不返回 undefined
  eq(configStore.tailPoolOfConfig(cfg, 'nonsense').defaultId, 'v1');
  eq(configStore.tailPoolOfConfig(null, 'image').presets.length, 0);
});

check('**老配置（扁平 presets）读时迁进视频池，图片池留空**', () => {
  const configStore = require(path.join(SERVER, 'config.js'));
  const migrated = configStore.normalizeTailPrompts({
    enabled: true,
    defaultId: 'old1',
    presets: [{ id: 'old1', name: '3D国漫风格', text: '音频规则：无 BGM…' }],
  });
  eq(migrated.groups.video.presets.length, 1, '老预设应当迁进视频池');
  eq(migrated.groups.video.defaultId, 'old1');
  eq(migrated.groups.image.presets.length, 0, '图片池必须留空');
  // 顶层兼容视图 = video 池（老读写路径行为不变）
  eq(migrated.presets.length, 1);
  eq(migrated.defaultId, 'old1');
});

// 这一条守的是一个**很隐蔽、差点让用户丢掉预设**的坑：
// `config.load()` 是 `merge(defaultConfig(), 磁盘配置)` 之后再归一的。
// 新默认值里已经有空的 groups，而磁盘上还是老结构（只有 presets）——
// merge 出来的对象**同时**带"空 groups"和"有内容的 presets"。
// 若只判断 `raw.groups` 在不在，就会走"已分组"分支、把老预设整个丢掉。
check('反向断言：混了空 groups 的老配置，预设不能被丢掉', () => {
  const configStore = require(path.join(SERVER, 'config.js'));
  const merged = configStore.normalizeTailPrompts({
    enabled: true,
    // 这两项来自新的 defaultConfig()（空的）
    groups: { video: { defaultId: '', presets: [] }, image: { defaultId: '', presets: [] } },
    // 这两项来自磁盘上的老配置（有内容）
    defaultId: 'old1',
    presets: [{ id: 'old1', name: '3D国漫风格', text: '音频规则：无 BGM…' }],
  });
  eq(merged.groups.video.presets.length, 1,
    '老预设被"空 groups"挤掉了 —— load() 会因此丢掉用户已有的尾部提示词');
  eq(merged.groups.video.defaultId, 'old1');
  eq(merged.groups.image.presets.length, 0);
});

check('服务端 composeSubmission 按 kind 拼各自的尾部', () => {
  const generate = require(path.join(SERVER, 'generate.js'));
  const configStore = require(path.join(SERVER, 'config.js'));
  const cfg = configStore.normalizeTailPrompts({
    enabled: true,
    groups: {
      video: { defaultId: 'v1', presets: [{ id: 'v1', name: '视频风', text: '视频尾部' }] },
      image: { defaultId: 'i1', presets: [{ id: 'i1', name: '图片风', text: '图片尾部' }] },
    },
  });
  const payload = { prompt: '主体', tailPrompt: { enabled: true, presetId: '' } };
  eq(generate.composeSubmission(cfg, payload, 'video').apiPrompt, '主体\n\n视频尾部');
  eq(generate.composeSubmission(cfg, payload, 'image').apiPrompt, '主体\n\n图片尾部');
  // 图片卡引用视频池的预设 → 必须报错，不能静默用错池
  let threw = '';
  try {
    generate.resolveTail(cfg, { tailPrompt: { enabled: true, presetId: 'v1' } }, 'image');
  } catch (e) { threw = e.message; }
  assert(/已删除|重新选/.test(threw), '图片卡引用视频池预设时应当报错，实际：' + threw);
});

// ── 事故回归：版本错配时**不能把用户预设写空**（2026-11-08 真实事故）────
//
// 经过：服务进程 17:53 启动（改动前的代码），浏览器刷新拿到**新前端**
//（静态文件现读磁盘）。新前端保存时发 {enabled, groups:{video,image}}，
// 而旧服务端的 normalizeTailPrompts 只认扁平的 raw.presets ——
// 于是把用户的预设读成空并落盘，那套 **335 字的「3D国漫风格」被清空**。
//
// 加固两条，这里都守住：
//   ① 服务端有 tailPromptsShapeOf() 能分辨提交的形状（groups / flat / none）
//   ② 有 TAIL_SCHEMA_VERSION 供前端判断"是否需要重启服务"
// 真正的写盘拦截在 index.js 的 /api/settings 里（见 .tmp-test/safety-net-e2e.js 的端到端验证）。
console.log('\nC5 · 事故回归：版本错配不得清空用户预设');

check('能分辨尾部预设提交的形状（groups / flat / none）', () => {
  const configStore = require(path.join(SERVER, 'config.js'));
  const shape = configStore.tailPromptsShapeOf;
  assert(typeof shape === 'function', '缺少 tailPromptsShapeOf —— 无法识别旧形状的提交');
  eq(shape({ groups: { video: { presets: [] } } }), 'groups', '新结构');
  eq(shape({ presets: [] }), 'flat', '老结构');
  eq(shape({ enabled: true, defaultId: '', presets: [] }), 'flat', '旧代码写出来的空对象');
  eq(shape(undefined), 'none', '没这个字段');
  eq(shape('nonsense'), 'none', '垃圾值');
});

check('导出了尾部预设的结构版本号（前端据此提示重启）', () => {
  const configStore = require(path.join(SERVER, 'config.js'));
  const v = configStore.TAIL_SCHEMA_VERSION;
  assert(Number.isFinite(v) && v >= 2,
    'TAIL_SCHEMA_VERSION 应当是 ≥2 的数字，实际 ' + JSON.stringify(v));
});

check('**旧形状 + 空内容，命中"会被当作清空"的判据**（安全网的条件）', () => {
  const configStore = require(path.join(SERVER, 'config.js'));
  // index.js 的拦截条件是：磁盘上有预设 && 提交归一后为空 && 形状不是 groups
  const incoming = configStore.tailPromptsShapeOf({ enabled: true, defaultId: '', presets: [] });
  const normalized = configStore.normalizeTailPrompts({ enabled: true, defaultId: '', presets: [] });
  const afterCount = normalized.groups.video.presets.length + normalized.groups.image.presets.length;
  assert(incoming !== 'groups', '旧形状应当不是 groups');
  eq(afterCount, 0, '旧形状空提交归一后确实是 0 套');
  // 三个条件同时成立 → index.js 会返回 409 拒绝保存
});

check('**新形状即使为空也不算"清空式保存"**（用户真心清空要放行）', () => {
  const configStore = require(path.join(SERVER, 'config.js'));
  const clearBody = {
    enabled: true,
    groups: { video: { defaultId: '', presets: [] }, image: { defaultId: '', presets: [] } },
  };
  const incoming = configStore.tailPromptsShapeOf(clearBody);
  eq(incoming, 'groups', '新前端一律发 groups —— 所以它清空是真心想清空');
  const normalized = configStore.normalizeTailPrompts(clearBody);
  eq(normalized.groups.video.presets.length, 0);
  eq(normalized.groups.image.presets.length, 0);
  // 形状是 groups → index.js 不会拦，用户能正常清空（安全网不把人锁死）
});

check('服务端 /api/status 会报出结构版本号', () => {
  const src = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
  assert(/tailSchemaVersion:\s*configStore\.TAIL_SCHEMA_VERSION/.test(src),
    '/api/status 没有报 tailSchemaVersion —— 前端无法判断是否需要重启服务');
});

check('/api/settings 对"旧形状空提交"有拒绝分支', () => {
  const src = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
  assert(/incoming !== 'groups'/.test(src),
    '/api/settings 缺少"旧形状 + 空内容"的拒绝分支 —— 事故会重演');
  assert(/409/.test(src), '拒绝时应当返回 409');
});

console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
