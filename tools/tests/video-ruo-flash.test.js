'use strict';

// 「Base64 内嵌」视频契约 · 自包含夹具（原通道 10 · 520ruo · seedance_2.5_flash）
//
// 夹具不读 data/config.json：通道 10 已于 2026-11-20 改成公网直链契约，
// 这里只守模板机制（refInlineImages 走 dataUrl、audio 走 {base64,mimeType}）。
//
// 这个模型的素材契约和本项目里其它通道都不一样，必须锁死：
//   · images 必填 1–10 张，元素只能是 Base64 / data URI / {base64,mimeType}，**不接受 URL**
//     （文档原文：「本站当前图片URL传入尚未开放」）—— 所以通道关掉「先上传素材」，
//     模板直接吃 {{refInlineImages}}，走的是 prepareRefs 压缩之后的 dataUrl；
//   · audio 可选 0–5 段，写法是 {base64, mimeType} 对象数组，不是 data URI 字符串；
//   · video / video_refs 已关闭，传了会被平台拒 → 模型规格 maxRefVideos: 0；
//   · 只有 480p / 720p，传 1080p / 4k 会被拒且不降级收费 → resolutions 只有这两档；
//   · 4–30 秒整数，默认 5；
//   · 纯文字会被拒（图生视频模型）→ minRefs: 1，modes 里没有 text。
//
// 运行：runtime/node.exe tools/tests/video-ruo-flash.test.js

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const generate = require(path.join(ROOT, 'server', 'generate.js'));
const channels = require(path.join(ROOT, 'server', 'channels.js'));
const modelSpecs = require(path.join(ROOT, 'server', 'model-specs.js'));

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

// 2026-11-20：通道 10 已改用 ruo-seedance-2.5 / seedance-2.5-premium-video（公网直链契约）。
// 本文件守的是「Base64 内嵌」这套模板机制本身，所以改成自包含 fixture：
// 不再读 data/config.json，通道被别人重配也不会误红。
const cfg = { channels: [] };
const ch = {
  id: 'ch_inline_fixture',
  name: '占位通道（Base64 内嵌契约 · 测试夹具）',
  enabled: true,
  kinds: ['video'],
  baseUrl: 'https://example.invalid/v1',
  auth: { style: 'bearer', header: 'Authorization', prefix: 'Bearer ', query: 'key' },
  headers: {},
  query: {},
  models: { image: [], video: ['seedance_2.5_flash'], audio: [] },
  defaults: { image: '', video: 'seedance_2.5_flash', audio: '' },
  lists: { enabled: false, path: '/models', method: 'GET', resultPath: 'data', itemId: 'id' },
  // 关键：关掉「先上传素材」，模板直接吃 {{refInlineImages}}
  upload: { enabled: false, path: '', method: 'POST', contentType: 'form', field: 'file', extra: {}, headers: {}, resultUrl: '', resultId: '', timeoutSec: 180 },
  directRefUrls: false,
  refPromptIndex: true,
  refPromptAt: false,
  refLimits: { image: { maxCount: 10 }, video: { maxCount: 0 }, audio: { maxCount: 5 } },
  video: {
    path: '/videos',
    method: 'POST',
    contentType: 'json',
    // 手写而不是 JSON.stringify：数组/数字占位符不能带引号，
    // 否则会渲染成 "images": "[...]"，JSON 直接解析失败（这正是 2026-11-20 踩过的坑）。
    body: [
      '{',
      '  "model": "{{model}}",',
      '  "prompt": "{{prompt}}",',
      '  "duration": {{duration}},',
      '  "resolution": "{{resolutionLower}}",',
      '  "ratio": "{{ratio}}",',
      '  "images": {{refInlineImages}},',
      '  "audio": {{refInlineAudios}}',
      '}',
    ].join('\n'),
    framesBody: '',
    extra: {},
    headers: {},
    resultUrl: '',
    resultB64: '',
    timeoutSec: 300,
    maxBodyMB: 60,
    poll: { enabled: false, path: '', method: 'GET', taskIdPath: 'id', listField: '', listIdField: 'id', statusField: 'status', doneValues: 'completed', failValues: 'failed', resultUrl: 'url', resultB64: '', errorField: 'message', downloadPath: '', downloadIdPath: '', downloadUrlField: 'url', intervalSec: 10, maxWaitSec: 1800 },
  },
};
cfg.channels.push(ch);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+g6wAAAAASUVORK5CYII=',
  'base64'
);
const MP3 = Buffer.from('SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMCAAAAAAAAAAAAAAAAAAAAAA', 'base64');

function img(n) {
  return {
    kind: 'image',
    name: '图' + n,
    ext: '.png',
    mime: 'image/png',
    dataUrl: 'data:image/png;base64,' + PNG.toString('base64'),
    buffer: PNG,
  };
}
function audio(n) {
  return {
    kind: 'audio',
    name: '配音' + n,
    ext: '.mp3',
    mime: 'audio/mpeg',
    dataUrl: 'data:audio/mpeg;base64,' + MP3.toString('base64'),
    buffer: MP3,
  };
}
function video(n) {
  return { kind: 'video', name: '视频' + n, ext: '.mp4', mime: 'video/mp4', dataUrl: 'data:video/mp4;base64,AAAA', buffer: Buffer.from('AAAA') };
}

function render(refs, payload) {
  const vars = generate.buildVars(
    Object.assign({ prompt: '参考图1的人物向镜头挥手', duration: 5, resolution: '480p', ratio: '9:16' }, payload),
    ch,
    'seedance_2.5_flash',
    '854x480',
    1,
    refs,
    'video'
  );
  return JSON.parse(generate.pruneEmptyMedia(channels.fillTemplate(ch.video.body, vars)));
}

console.log('\nR1 · 通道模板：内嵌 Base64，不走 URL');
check('模板用 images / audio，且用 refInline* 变量', () => {
  const t = ch.video.body;
  assert(t.indexOf('{{refInlineImages}}') >= 0, '缺少 refInlineImages');
  assert(t.indexOf('{{refInlineAudios}}') >= 0, '缺少 refInlineAudios');
  assert(t.indexOf('refImages') < 0, '模板里不该再出现 URL 数组 refImages');
  assert(t.indexOf('video_refs') < 0, '模板里不该出现 video_refs（平台已关闭视频参考）');
});
check('通道关掉图床、不允许直连 URL', () => {
  eq(ch.upload.enabled, false, '图床应该关着：这个模型不吃 URL，传了也是白传');
  eq(ch.directRefUrls, false, '不该把公网地址直接透传给这个模型');
});
check('通道级的参考视频上限就是 0', () => {
  eq(ch.refLimits.video.maxCount, 0);
});

console.log('\nR2 · 参考图渲染成 data URI');
check('两张图 → images 是两条 data URI', () => {
  const body = render([img(42), img(43)]);
  eq(body.images.length, 2);
  assert(body.images.every((s) => s.indexOf('data:image/png;base64,') === 0), '不是 data URI');
  assert(body.images.every((s) => s.indexOf('http') < 0), '里面混进了 URL');
});
check('图片顺序和卡片上的顺序一致', () => {
  const a = img(42);
  const b = Object.assign(img(43), { dataUrl: 'data:image/png;base64,QUJD' });
  const body = render([b, a]);
  eq(body.images[0], b.dataUrl);
  eq(body.images[1], a.dataUrl);
});
check('没有音频时不带 audio 字段（空数组会被平台当成无效素材）', () => {
  const body = render([img(42)]);
  assert(!('audio' in body), '空 audio 没有被清掉');
});

console.log('\nR3 · 音频渲染成 {base64, mimeType}');
check('一段音频 → 对象数组', () => {
  const body = render([img(42), audio(1)]);
  eq(Array.isArray(body.audio), true);
  eq(body.audio.length, 1);
  eq(body.audio[0].mimeType, 'audio/mpeg');
  assert(!/^data:/.test(body.audio[0].base64), 'base64 字段里不该带 data: 前缀');
  eq(body.audio[0].base64, MP3.toString('base64'));
});

console.log('\nR4 · 参数原样进请求体');
check('model / duration / resolution / ratio', () => {
  const body = render([img(42)], { duration: 30, resolution: '720p', ratio: '16:9' });
  eq(body.model, 'seedance_2.5_flash');
  eq(body.duration, 30);
  eq(body.resolution, '720p');
  eq(body.ratio, '16:9');
});
check('分辨率只认小写（模板用 resolutionLower）', () => {
  const body = render([img(42)], { resolution: '480P' });
  eq(body.resolution, '480p');
});

console.log('\nR5 · 模型规格与收费相关的边界');
check('只有 480p / 720p（1080p、4k 平台会拒）', () => {
  const spec = modelSpecs.forModel('seedance_2.5_flash');
  eq(spec.resolutions.join(','), '480p,720p');
});
check('时长 4–30 秒整数', () => {
  const spec = modelSpecs.forModel('seedance_2.5_flash');
  eq(spec.minDurationSec, 4);
  eq(spec.maxDurationSec, 30);
  eq(spec.durations.length, 27);
});
check('必须带参考图，且不收视频、最多 5 段音频', () => {
  const spec = modelSpecs.forModel('seedance_2.5_flash');
  eq(spec.minRefs, 1);
  eq(spec.maxRefs, 10);
  eq(spec.maxRefVideos, 0);
  eq(spec.maxRefAudios, 5);
  eq(spec.modes.join(','), 'reference');
});

console.log('\nR6 · 非法组合在本地就拦住（不花钱）');
function expectError(fn, needle) {
  try {
    fn();
  } catch (error) {
    assert(error.message.indexOf(needle) >= 0, '报错内容不对：' + error.message);
    return;
  }
  throw new Error('没有拦住，期望报错包含「' + needle + '」');
}
check('纯文字（不带图）', () => {
  expectError(() => generate.checkModelRefs('seedance_2.5_flash', [], 'video'), '至少带 1 张参考图');
});
check('带参考视频', () => {
  expectError(
    () => generate.checkModelRefs('seedance_2.5_flash', [img(42), video(1)], 'video'),
    '不收参考视频'
  );
});
check('超过 10 张图', () => {
  const many = new Array(11).fill(0).map((_, i) => img(i));
  expectError(() => generate.checkModelRefs('seedance_2.5_flash', many, 'video'), '最多接 10 张');
});
check('超过 5 段音频', () => {
  const list = [img(42)].concat(new Array(6).fill(0).map((_, i) => audio(i)));
  expectError(() => generate.checkModelRefs('seedance_2.5_flash', list, 'video'), '最多接 5 个参考音频');
});
check('3 秒 / 31 秒越界', () => {
  expectError(() => generate.checkModelParams('seedance_2.5_flash', 'video', { duration: 3 }), '不支持 3 秒');
  expectError(() => generate.checkModelParams('seedance_2.5_flash', 'video', { duration: 31 }), '不支持 31 秒');
});
check('不支持的比例', () => {
  expectError(
    () => generate.checkModelParams('seedance_2.5_flash', 'video', { duration: 5, ratio: '2:1' }),
    '不支持 2:1'
  );
});
check('非法分辨率收敛成模型支持的档位，不会原样发出去', () => {
  const vars = generate.buildVars(
    { prompt: 'x', duration: 5, resolution: '1080p', ratio: '16:9' },
    ch,
    'seedance_2.5_flash',
    '854x480',
    1,
    [img(42)],
    'video'
  );
  assert(['480p', '720p'].indexOf(vars.resolutionLower) >= 0, '收敛结果不是 480p/720p：' + vars.resolutionLower);
});

console.log('\nR7 · 请求体体积护栏（平台 64 MB 网关上限）');
check('夹具照样带 60 MB 护栏（模板机制不变）', () => {
  eq(ch.video.maxBodyMB, 60, 'maxBodyMB 应该是 60');
});

console.log('\nR8 · 提示词素材名映射（图45 → 图片1）');
check('通道 10 已开启 refPromptIndex', () => {
  eq(ch.refPromptIndex, true, '通道 10 也要做名字→序号映射，否则「图45」平台认不出来');
});
check('素材名按 refs 顺序换成「图片N」', () => {
  const vars = generate.buildVars(
    { prompt: '图45 是祠堂，图42 是林振南', duration: 5, resolution: '480p', ratio: '9:16' },
    ch,
    'seedance_2.5_flash',
    '854x480',
    1,
    [img(45), img(42)],
    'video'
  );
  eq(vars.prompt, '图片1 是祠堂，图片2 是林振南');
});
check('没带上的素材名原样保留', () => {
  const vars = generate.buildVars(
    { prompt: '图45 是祠堂，图99 是路人', duration: 5, resolution: '480p', ratio: '9:16' },
    ch,
    'seedance_2.5_flash',
    '854x480',
    1,
    [img(45)],
    'video'
  );
  eq(vars.prompt, '图片1 是祠堂，图99 是路人');
});

console.log('\nR9 · 不误伤其它模型');
check('Prompt Hubs 的 S-2.5-满血 仍然允许纯文字', () => {
  generate.checkModelRefs('S-2.5-满血', [], 'video');
});
check('没有登记在 model-specs 里的模型不受 minRefs 影响', () => {
  generate.checkModelRefs('某个还没登记的模型', [], 'video');
});

console.log('\n────────────────────────────────────────────────────');
if (failed) {
  console.log('失败 ' + failed + ' 项，通过 ' + passed + ' 项');
  process.exit(1);
}
console.log('全部通过（' + passed + ' 项）');
