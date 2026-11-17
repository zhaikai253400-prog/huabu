'use strict';

// 通道 9 · Prompt Hubs（console.prompt-hubs.com）的视频请求体契约。
//
// 背景：这个通道最初把参考素材写成扁平的 reference_images / reference_videos /
// reference_audios。平台**校验层**认这些字段（参数不对会回 400），但真正转发给
// 上游生成插件时它们不生效 —— 结果就是「生成成功、但参考图完全没用上」。
//
// 平台自家画布与官方模型目录给出的规范写法是 video.v1 + media_inputs：
//   { version, model, operation, prompt, duration_seconds, resolution,
//     aspect_ratio, media_inputs: [{kind, role, url}] }
// 这个测试锁死这套写法，防止再退回扁平字段。
//
// 运行：runtime/node.exe tools/tests/video-mediainputs.test.js

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const generate = require(path.join(ROOT, 'server', 'generate.js'));
const channels = require(path.join(ROOT, 'server', 'channels.js'));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    failed += 1;
    console.log('  ✗ ' + name + ' — ' + error.message);
  }
}
const eq = (a, b, msg) => assert.strictEqual(a, b, msg || (a + ' !== ' + b));

// 直接读磁盘配置，确认通道模板就是 video.v1 + media_inputs
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
const ch = cfg.channels.find((c) => c.id === 'ch_prompt_hubs');
if (!ch) throw new Error('配置里找不到 ch_prompt_hubs 通道');

const refOf = (kind, n, role) => ({
  kind: kind,
  role: role || null,
  name: kind + n,
  ext: kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : '.mp3',
  dataUrl: 'data:image/png;base64,AAAA',
  remoteUrl: 'https://media.example.com/' + kind + n + (kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : '.mp3'),
});

function render(refs, model, payload) {
  const vars = generate.buildVars(
    Object.assign({ prompt: '一只小猫在走路', duration: 5, resolution: '720p', ratio: '16:9' }, payload),
    ch, model, '1280x720', 1, refs, 'video'
  );
  const filled = channels.fillTemplate(ch.video.body, vars);
  return JSON.parse(generate.pruneEmptyMedia(filled));
}

console.log('\nV1 · 通道模板本身就是 video.v1 契约');
check('模板用 version/operation/media_inputs，不再有扁平素材字段', () => {
  const t = ch.video.body;
  assert(t.indexOf('"version"') >= 0, '模板缺少 version');
  assert(t.indexOf('"operation"') >= 0, '模板缺少 operation');
  assert(t.indexOf('"media_inputs"') >= 0, '模板缺少 media_inputs');
  assert(t.indexOf('reference_images') < 0, '模板里还残留 reference_images');
  assert(t.indexOf('reference_videos') < 0, '模板里还残留 reference_videos');
  assert(t.indexOf('reference_audios') < 0, '模板里还残留 reference_audios');
});

console.log('\nV2 · 素材按 kind/role 折叠进 media_inputs');
check('参考图 → {kind:image, role:reference}', () => {
  const body = render([refOf('image', 1), refOf('image', 2)], 'S-2.5-flash');
  eq(body.media_inputs.length, 2);
  eq(body.media_inputs[0].kind, 'image');
  eq(body.media_inputs[0].role, 'reference');
  eq(body.media_inputs[0].url, 'https://media.example.com/image1.png');
  assert(body.media_inputs.every((m) => m.role === 'reference'), '参考图的 role 应为 reference');
});

check('参考视频 → {kind:video, role:reference}', () => {
  const body = render([refOf('video', 1)], 'S-2.5-满血');
  eq(body.media_inputs[0].kind, 'video');
  eq(body.media_inputs[0].role, 'reference');
});

check('参考音频 → {kind:audio, role:audio_reference}', () => {
  const body = render([refOf('audio', 1)], 'S-2.5-满血');
  eq(body.media_inputs[0].kind, 'audio');
  eq(body.media_inputs[0].role, 'audio_reference');
});

check('三种素材混在一起：顺序与字段都对', () => {
  const body = render([refOf('image', 1), refOf('video', 1), refOf('audio', 1)], 'S-2.5-满血');
  eq(body.media_inputs.map((m) => m.kind).join(','), 'image,video,audio');
  eq(body.media_inputs.map((m) => m.role).join(','), 'reference,reference,audio_reference');
});

console.log('\nV3 · operation 跟着素材类型走');
check('纯文字 → text_to_video', () => {
  eq(render([], 'S-2.5-flash').operation, 'text_to_video');
});
check('只有参考图 → image_to_video', () => {
  eq(render([refOf('image', 1)], 'S-2.5-flash').operation, 'image_to_video');
});
check('带参考视频 → video_to_video', () => {
  eq(render([refOf('image', 1), refOf('video', 1)], 'S-2.5-flash').operation, 'video_to_video');
});

console.log('\nV4 · 空素材要把 media_inputs 整个删掉');
check('没有任何素材时，请求体里不该出现 media_inputs', () => {
  const body = render([], 'S-2.5-flash');
  assert(!('media_inputs' in body), '空数组没有被清掉，平台可能当成无效素材');
});
check('有素材时 media_inputs 就是数组', () => {
  const body = render([refOf('image', 1)], 'S-2.5-flash');
  assert(Array.isArray(body.media_inputs) && body.media_inputs.length === 1, 'media_inputs 不是长度 1 的数组');
});

console.log('\nV5 · 其它字段不受影响');
check('分辨率小写、时长为数字、比例原样', () => {
  const body = render([refOf('image', 1)], 'S-2.5-flash', { duration: 12, ratio: '21:9', resolution: '1080p' });
  eq(body.resolution, '1080p');
  eq(body.duration_seconds, 12);
  eq(body.aspect_ratio, '21:9');
  eq(body.model, 'S-2.5-flash');
  eq(body.version, 'video.v1');
});

console.log('\n────────────────────────────────────────────────────');
if (failed) {
  console.log('失败 ' + failed + ' 项 / 通过 ' + passed + ' 项');
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项');