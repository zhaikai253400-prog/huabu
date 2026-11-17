'use strict';

// 通道 9 · Prompt Hubs：提示词素材引用规范化
//
// 背景（这是「生成成功但参考图没生效」的真正原因之一）：
// 平台按 media_inputs 里图片的**出现顺序**理解参考图，文档原话是
// 「提示词里用『图片1、视频1』按类型加序号引用素材，不要把素材 ID 写进提示词」。
// 而画布上的素材名是「图42」「图45」这种全局编号，跟本次提交顺序毫无关系。
// 模型看到「图42 是林振南」不知道指第几张图，所以画面里完全没用上。
//
// 这个测试锁死三条：
//   1. 名字到序号的映射必须与 refs 顺序一致；
//   2. 没带上的素材名绝不替换（避免把用户写别的编号误改）；
//   3. 关闭开关的通道，提示词必须原样不动。

const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const generate = require(path.join(ROOT, 'server', 'generate.js'));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (e) { failed += 1; console.log('  ✗ ' + name + ' — ' + e.message); }
}
const eq = (a, b, m) => assert.strictEqual(a, b, m || (JSON.stringify(a) + ' !== ' + JSON.stringify(b)));

const refs = [
  { name: '图45', kind: 'image' },
  { name: '图42', kind: 'image' },
  { name: '图41', kind: 'image' },
  { name: '图43', kind: 'image' },
  { name: '图44', kind: 'image' },
  { name: '图50', kind: 'image' },
];
const map = (t) => generate.remapRefNamesInPrompt(t, refs);

console.log('\nI1 · 名字 → 序号');
check('按 refs 顺序编号（图45 是第 1 张 → 图片1）', () => {
  eq(map('图45 是荒废祠堂'), '图片1 是荒废祠堂');
});
check('第 2 张图42 → 图片2', () => {
  eq(map('图42 是林振南'), '图片2 是林振南');
});
check('一处提示词里多个名字全部换掉', () => {
  eq(map('图45 与 图42 与 图43'), '图片1 与 图片2 与 图片4');
});
check('同一个名字出现多次，全部换掉', () => {
  eq(map('图42 走，图42 停'), '图片2 走，图片2 停');
});
check('名字紧跟中文标点也能换', () => {
  eq(map('图45是荒废祠堂（白天·内）'), '图片1是荒废祠堂（白天·内）');
});

console.log('\nI2 · 保守性：不许误伤');
check('本次没带上的素材名原样保留', () => {
  eq(map('图42 是林振南，图99 是路人'), '图片2 是林振南，图99 是路人');
});
check('「图4」不会吃掉「图45」的开头', () => {
  const out = generate.remapRefNamesInPrompt('图45 是祠堂', [{ name: '图4', kind: 'image' }, { name: '图45', kind: 'image' }]);
  eq(out, '图片2 是祠堂');
});
check('不带素材名的提示词完全不变', () => {
  eq(map('一个人在雨中奔跑'), '一个人在雨中奔跑');
});
check('没有参考素材时完全不变', () => {
  eq(generate.remapRefNamesInPrompt('图42 是林振南', []), '图42 是林振南');
});
check('空提示词不炸', () => {
  eq(generate.remapRefNamesInPrompt('', refs), '');
  eq(generate.remapRefNamesInPrompt(null, refs), '');
});
check('不带空格的「图45是…」必须能换（中文提示词最常见写法）', () => {
  eq(map('图45是荒废祠堂（白天·内）'), '图片1是荒废祠堂（白天·内）');
});
check('不在本次列表里的编号原样保留（图42 有带，图46 没带）', () => {
  eq(map('图42 是林振南，图46 是路人'), '图片2 是林振南，图46 是路人');
});

console.log('\nI3 · 图片 / 视频 / 音频分开计数');
check('三类各自从 1 开始', () => {
  const mixed = [
    { name: '图1', kind: 'image' },
    { name: '图2', kind: 'image' },
    { name: '视频7', kind: 'video' },
    { name: '音频3', kind: 'audio' },
  ];
  eq(generate.remapRefNamesInPrompt('图1 和 图2，视频7，音频3', mixed), '图片1 和 图片2，视频1，音频1');
});

console.log('\nI4 · 通道开关');
check('通道 9 已开启 refPromptIndex', () => {
  const fs = require('node:fs');
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
  const ch = cfg.channels.find((c) => c.id === 'ch_prompt_hubs');
  eq(ch.refPromptIndex, true, '通道 9 的 refPromptIndex 应该是 true');
});
check('其它通道默认关闭（不影响它们）', () => {
  const fs = require('node:fs');
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
  // ch_yuanmeng_station（通道4）也开了：元梦要求提示词里用 @图片1 引用素材，
  // 不开这个开关「图42」会原样发出去，参考图等于没接上。
  const WITH_INDEX = ['ch_prompt_hubs', 'ch_ruo_520', 'ch_yuanmeng_station'];
  const others = cfg.channels.filter((c) => !WITH_INDEX.includes(c.id));
  assert(others.every((c) => !c.refPromptIndex), '有其它通道被误开');
});

console.log('\nI5 · 图床走平台自家接口（保留原图，不做二次转码）');
check('上传路径是同源的 /media/uploads', () => {
  const fs = require('node:fs');
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
  const ch = cfg.channels.find((c) => c.id === 'ch_prompt_hubs');
  eq(ch.upload.path, '/media/uploads', '应该走平台自家上传（同源、带鉴权、保留原图格式）');
  eq(ch.upload.resultUrl, 'url', '结果地址取值路径应为 url');
});

console.log('\n────────────────────────────────────────────────────');
if (failed) { console.log('失败 ' + failed + ' 项，通过 ' + passed + ' 项'); process.exit(1); }
console.log('全部通过（' + passed + ' 项）');
