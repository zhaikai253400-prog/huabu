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
  eq(rules.normalizeMode('audio', 'reference'), '');
  eq(rules.normalizeMode('audio', 'frames'), '');
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

check('图片卡：mode 为空串，且不带尾部选择', () => {
  const out = rules.assemble({ nodeType: 'image', params: { mode: 'reference' }, tailPrompt: { enabled: true } });
  eq(out.kind, 'image');
  eq(out.mode, '');
  eq(out.tailPrompt.enabled, false, '图片卡不该带尾部选择');
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

console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
