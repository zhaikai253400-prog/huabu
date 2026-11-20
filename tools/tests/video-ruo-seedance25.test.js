'use strict';

// 通道 10 · 520ruo · ruo-seedance-2.5 / seedance-2.5-premium-video（2026-11-20 重配）
//
// 这两个模型和同通道原来的 seedance_2.5_flash 是**两套相反**的契约，配置时最容易踩的就是照抄：
//   · 旧 flash：images / audio 收 Base64 内嵌，明确「不收 URL」；
//   · 新两个：image_refs / video_refs / audio_refs 只收**公网 HTTP(S) 直链**，不收上传文件。
// 所以本通道必须开「先上传素材」（借 picui 图床换公网地址），而 flash 那次是关着的。
//
// 这里守四件事：
//   R1 模板字段名正确、不再残留旧字段；
//   R2 参考素材渲染成公网 https 地址而不是 data URI；
//   R3 各模型的上限（视频参考 ruo 是 0、premium 是 10）与比例档位；
//   R4 轮询与结果下载路径。
//
// 运行：runtime/node.exe tools/tests/video-ruo-seedance25.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-ruo25-'));
require(path.join(__dirname, '_isolate.js'))(box);

const configStore = require(path.join(ROOT, 'server', 'config.js'));
const generate = require(path.join(ROOT, 'server', 'generate.js'));
const channels = require(path.join(ROOT, 'server', 'channels.js'));
const modelSpecs = require(path.join(ROOT, 'server', 'model-specs.js'));

// 用**真实配置**跑，而不是手搓一份：通道被人改坏了，这里立刻红。
const realCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
const ch = (realCfg.channels || []).find((c) => c.id === 'ch_ruo_520');
if (!ch) throw new Error('真实配置里找不到 ch_ruo_520');

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
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
  }
}

// 造一张参考素材：remoteUrl 是 uploadRefs 之后拿到的公网地址
function img(n, remoteUrl) {
  return {
    kind: 'image',
    name: '参考' + n + '.png',
    role: 'reference_image',
    mime: 'image/png',
    ext: '.png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    remoteUrl: remoteUrl || 'https://picui.ogmua.cn/s1/2026/11/13/ref' + n + '.webp',
    remoteId: '',
  };
}
function vid(n) {
  const one = img(n, 'https://picui.ogmua.cn/s1/2026/11/13/ref' + n + '.mp4');
  one.kind = 'video';
  one.mime = 'video/mp4';
  one.ext = '.mp4';
  one.name = '参考视频' + n + '.mp4';
  return one;
}
function aud(n) {
  const one = img(n, 'https://picui.ogmua.cn/s1/2026/11/13/ref' + n + '.mp3');
  one.kind = 'audio';
  one.mime = 'audio/mpeg';
  one.ext = '.mp3';
  one.name = '参考音频' + n + '.mp3';
  return one;
}

function render(refs, payload, model) {
  const vars = generate.buildVars(
    Object.assign({ prompt: '晨光中的湖面', duration: 5, resolution: '720p', ratio: '16:9' }, payload || {}),
    ch,
    model || 'ruo-seedance-2.5',
    '1280x720',
    1,
    refs || [],
    'video'
  );
  return JSON.parse(generate.pruneEmptyMedia(channels.fillTemplate(ch.video.body, vars)));
}

console.log('R1 · 通道基本设置');

check('通道是开着的、只做视频、地址是 520ruo', () => {
  eq(ch.enabled, true);
  eq(ch.kinds, ['video']);
  eq(ch.baseUrl, 'https://api.520ruo.com/v1');
});

check('模型清单就是用户点名的两个，且没有残留旧模型', () => {
  const ids = ch.models.video.map((one) => String(one).split('|')[0].trim());
  eq(ids, ['ruo-seedance-2.5', 'seedance-2.5-premium-video']);
  assert(ch.models.video.indexOf('seedance_2.5_flash') < 0, '旧的 seedance_2.5_flash 还在（它是 Base64 契约，和本模板不兼容）');
});

check('默认模型是 ruo-seedance-2.5', () => {
  eq(ch.defaults.video, 'ruo-seedance-2.5');
});

check('开了「先上传素材」并指向可用图床（这两个模型只收公网直链）', () => {
  eq(ch.upload.enabled, true, '图床关着的话，本地素材会被当成 data URI 发出去，平台不认');
  assert(/^https:\/\//.test(ch.upload.path), '上传地址不是公网地址');
  eq(ch.upload.resultUrl, 'data.links.url');
});

console.log('\nR2 · 请求体字段名（这批模型的关键差异）');

check('模板用 image_refs / video_refs / audio_refs', () => {
  const t = ch.video.body;
  assert(t.indexOf('{{refImages}}') >= 0, '缺少 image_refs 用的 refImages');
  assert(t.indexOf('image_refs') >= 0, '缺少 image_refs 字段');
  assert(t.indexOf('video_refs') >= 0, '缺少 video_refs 字段');
  assert(t.indexOf('audio_refs') >= 0, '缺少 audio_refs 字段');
});

check('不再残留旧 flash 的 images / audio / refInline* 字段', () => {
  const t = ch.video.body;
  assert(t.indexOf('{{refInlineImages}}') < 0, '还在用 refInlineImages（Base64 那套）');
  assert(t.indexOf('{{refInlineAudios}}') < 0, '还在用 refInlineAudios（Base64 那套）');
});

check('请求方法 / 路径是 POST /videos', () => {
  eq(ch.video.method, 'POST');
  eq(ch.video.path, '/videos');
});

console.log('\nR3 · 参考素材渲染成公网地址');

check('两张图 → image_refs 是两条 https 地址，不是 data URI', () => {
  const body = render([img(1), img(2)]);
  eq(body.image_refs.length, 2);
  assert(body.image_refs.every((u) => /^https:\/\//.test(u)), '里面混进了非 https 地址');
  assert(body.image_refs.every((u) => u.indexOf('data:') < 0), '还在发 data URI（平台不收）');
});

check('图片顺序与卡片一致', () => {
  const a = img(1, 'https://picui.ogmua.cn/s1/a.webp');
  const b = img(2, 'https://picui.ogmua.cn/s1/b.webp');
  const body = render([b, a]);
  eq(body.image_refs, ['https://picui.ogmua.cn/s1/b.webp', 'https://picui.ogmua.cn/s1/a.webp']);
});

check('有视频参考时进 video_refs，有音频时进 audio_refs', () => {
  const body = render([img(1), vid(2), aud(3)]);
  eq(body.image_refs.length, 1);
  eq(body.video_refs.length, 1);
  eq(body.audio_refs.length, 1);
  assert(body.video_refs[0].indexOf('.mp4') > 0, 'video_refs 里不是视频');
  assert(body.audio_refs[0].indexOf('.mp3') > 0, 'audio_refs 里不是音频');
});

check('纯文生：不带参考素材时三个数组都为空且被清掉', () => {
  const body = render([]);
  assert(!('image_refs' in body), '空的 image_refs 没被清掉');
  assert(!('video_refs' in body), '空的 video_refs 没被清掉');
  assert(!('audio_refs' in body), '空的 audio_refs 没被清掉');
});

check('基础字段齐全：model / prompt / duration / resolution / ratio', () => {
  const body = render([]);
  eq(body.model, 'ruo-seedance-2.5');
  eq(body.prompt, '晨光中的湖面');
  eq(body.duration, 5);
  eq(body.resolution, '720p');
  eq(body.ratio, '16:9');
});

console.log('\nR4 · 两个模型的规格差异');

check('ruo-seedance-2.5：不收参考视频（上限 0）、能收音频、有 adaptive 比例', () => {
  const spec = modelSpecs.forModel('ruo-seedance-2.5', 'ch_ruo_520');
  assert(spec, '没有登记规格');
  eq(spec.maxRefVideos, 0, '这个模型明确不收参考视频');
  eq(spec.maxRefAudios, 10);
  eq(spec.maxRefs, 30);
  assert(spec.ratios.indexOf('adaptive') >= 0, '少了 adaptive 比例');
  eq(spec.defaultDuration, 5, '文档：默认 5 秒');
});

check('seedance-2.5-premium-video：图片 30 / 视频 10 / 音频 10，默认 30 秒', () => {
  const spec = modelSpecs.forModel('seedance-2.5-premium-video', 'ch_ruo_520');
  assert(spec, '没有登记规格');
  eq(spec.maxRefs, 30);
  eq(spec.maxRefVideos, 10);
  eq(spec.maxRefAudios, 10);
  eq(spec.defaultDuration, 30, '文档：2.5 默认 30 秒');
});

check('两个模型都不支持首尾帧，都能纯文生', () => {
  ['ruo-seedance-2.5', 'seedance-2.5-premium-video'].forEach((id) => {
    const spec = modelSpecs.forModel(id, 'ch_ruo_520');
    eq(spec.frames, false, id + ' 不该开首尾帧');
    assert(spec.modes.indexOf('text') >= 0, id + ' 应当支持纯文生');
    assert(spec.modes.indexOf('reference') >= 0, id + ' 应当支持参考');
  });
});

check('分辨率只开 480p / 720p / 1080p（文档明确不支持 4K）', () => {
  ['ruo-seedance-2.5', 'seedance-2.5-premium-video'].forEach((id) => {
    eq(modelSpecs.forModel(id, 'ch_ruo_520').resolutions, ['480p', '720p', '1080p']);
  });
});

console.log('\nR5 · 轮询与结果下载');

check('轮询 GET /videos/{taskId}，任务号取 id', () => {
  eq(ch.video.poll.enabled, true);
  eq(ch.video.poll.method, 'GET');
  eq(ch.video.poll.path, '/videos/{{taskId}}');
  eq(ch.video.poll.taskIdPath, 'id');
});

check('完成状态与结果地址：completed / url', () => {
  assert(ch.video.poll.doneValues.indexOf('completed') >= 0);
  eq(ch.video.poll.resultUrl, 'url');
});

check('兜底下载走 /videos/{taskId}/content（文档给的下载端点）', () => {
  eq(ch.video.poll.downloadPath, '/videos/{{taskId}}/content');
});

check('失败原因取 message 字段', () => {
  eq(ch.video.poll.errorField, 'message');
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
