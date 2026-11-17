'use strict';

// 通道 2 · xinbiapi（www.xinbiapi.com）· gpt-image-2.5-flare
//
// 这个通道是从「视频通道2」改过来的，平台契约和别家生图通道差别很大，必须锁死：
//   · 异步任务：POST /media/tasks 建任务，GET /media/tasks/{taskId} 轮询，
//     再 GET /media/files/{fileId}/download 换取带签名的 downloadUrl；
//   · 分辨率只收 1024*1024 / 1536*1024 / 1024*1536 三个固定像素值，
//     而且是**星号**写法（1024x1024 会被 422 拒掉）；
//   · 参数 schema 里只有 resolution 一个键（additionalProperties: false），
//     outputCount 之类不能塞进 parameters；
//   · taskType 分两种：纯文生 IMAGE_GENERATE、带参考图 IMAGE_EDIT；
//     IMAGE_EDIT 必须带 1–8 张参考图，IMAGE_GENERATE 不收参考图；
//   · 参考图必须先上传拿 fileId，请求体里传 inputFiles:[{role, fileId}]，不接受裸 URL。
//
// 运行：runtime/node.exe tools/tests/image-flare-xinbiapi.test.js

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

const CH_ID = 'ch_28d57084';
const MODEL = 'gpt-image-2.5-flare';
const PLATFORM_SIZES = ['1024*1024', '1536*1024', '1024*1536'];

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
const ch = cfg.channels.find((c) => c.id === CH_ID);
if (!ch) throw new Error('配置里找不到 ' + CH_ID + ' 通道');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+g6wAAAAASUVORK5CYII=',
  'base64'
);

function img(n, fileId) {
  return {
    kind: 'image',
    name: '图' + n,
    ext: '.png',
    mime: 'image/png',
    dataUrl: 'data:image/png;base64,' + PNG.toString('base64'),
    buffer: PNG,
    remoteId: fileId || '',
  };
}

function render(refs, payload) {
  const size = channels.sizeFor(ch, (payload && payload.sizeKey) || '1K', (payload && payload.ratio) || '1:1', 'image');
  const vars = generate.buildVars(
    Object.assign({ prompt: '一只猫坐在窗台上', sizeKey: '1K', ratio: '1:1', count: 1 }, payload),
    ch,
    MODEL,
    size,
    1,
    refs,
    'image'
  );
  return JSON.parse(generate.pruneEmptyMedia(channels.fillTemplate(ch.image.body, vars)));
}

console.log('\nC1 · 通道本身改成图片通道');
check('kinds 只有 image，没有 video', () => {
  eq(JSON.stringify(ch.kinds), JSON.stringify(['image']));
});
check('视频模型已清空（原来的 3 个不用了）', () => {
  eq((ch.models.video || []).length, 0);
  eq(ch.defaults.video, '');
});
check('图片模型就是 gpt-image-2.5-flare，且是默认', () => {
  eq(channels.modelIds(ch.models.image).join(','), MODEL);
  eq(ch.defaults.image, MODEL);
});
check('通道是启用状态', () => {
  eq(ch.enabled, true);
});
check('Base URL / 密钥沿用原来的，没有被动过', () => {
  eq(ch.baseUrl, 'https://www.xinbiapi.com/v1');
  assert(String(ch.apiKey).indexOf('enc:v1:') === 0, '密钥应该仍是密文，不该被写成明文');
});

console.log('\nC2 · 请求路径与轮询契约');
check('提交走 /media/tasks', () => {
  eq(ch.image.path, '/media/tasks');
  eq(ch.image.method, 'POST');
});
check('轮询走 /media/tasks/{{taskId}}，任务号取 taskId', () => {
  eq(ch.image.poll.enabled, true);
  eq(ch.image.poll.path, '/media/tasks/{{taskId}}');
  eq(ch.image.poll.taskIdPath, 'taskId');
  eq(ch.image.poll.statusField, 'status');
});
check('成功状态认 SUCCEEDED', () => {
  assert(ch.image.poll.doneValues.indexOf('SUCCEEDED') >= 0, 'doneValues 里缺少 SUCCEEDED');
});
check('取件走 /media/files/{{fileId}}/download，文件号取 resultFileIds.0', () => {
  eq(ch.image.poll.downloadPath, '/media/files/{{fileId}}/download');
  eq(ch.image.poll.downloadIdPath, 'resultFileIds.0');
  eq(ch.image.poll.downloadUrlField, 'downloadUrl');
});
check('请求头自动带幂等键（平台强制要求）', () => {
  eq(ch.image.headers['Idempotency-Key'], '{{requestId}}');
});

console.log('\nC3 · 分辨率只落在平台认的三个值上');
check('sizeMap 的取值与平台 enum 完全一致', () => {
  const mine = Object.keys(ch.sizeMap).map((k) => ch.sizeMap[k]).sort();
  eq(JSON.stringify(mine), JSON.stringify(PLATFORM_SIZES.slice().sort()));
});
check('卡片给的任意 sizeKey 都收敛到合法值', () => {
  ['1K', '2K', '4K', '', '不存在的档位'].forEach((sk) => {
    const got = channels.sizeFor(ch, sk, '1:1', 'image');
    assert(PLATFORM_SIZES.indexOf(got) >= 0, 'sizeKey=' + sk + ' 得到了平台不认的值 ' + got);
  });
});
check('任意比例也收敛到合法值（平台没有 16:9）', () => {
  ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'].forEach((r) => {
    const got = channels.sizeFor(ch, '2K', r, 'image');
    assert(PLATFORM_SIZES.indexOf(got) >= 0, 'ratio=' + r + ' 得到了平台不认的值 ' + got);
  });
});
check('请求体里的 resolution 用星号写法', () => {
  const body = render([], { sizeKey: '1K', ratio: '1:1' });
  eq(body.parameters.resolution, '1024*1024');
  assert(body.parameters.resolution.indexOf('x') < 0, '不该出现 x 写法');
});

console.log('\nC4 · taskType 按有没有参考图自动切换');
check('纯文生 → IMAGE_GENERATE', () => {
  const body = render([], {});
  eq(body.taskType, 'IMAGE_GENERATE');
});
check('带参考图 → IMAGE_EDIT', () => {
  const body = render([img(1, 'mrf_' + 'a'.repeat(32))], {});
  eq(body.taskType, 'IMAGE_EDIT');
});
check('IMAGE_GENERATE 时 inputFiles 是空数组', () => {
  const body = render([], {});
  eq(JSON.stringify(body.inputFiles), '[]');
});

console.log('\nC5 · 参考图走 fileId，不走 URL');
check('参考图渲染成 {role, fileId}', () => {
  const fid = 'mrf_' + 'b'.repeat(32);
  const body = render([img(42, fid)], {});
  eq(body.inputFiles.length, 1);
  eq(body.inputFiles[0].role, 'reference_image');
  eq(body.inputFiles[0].fileId, fid);
});
check('没有 fileId 的参考图不会混进 inputFiles', () => {
  const body = render([img(42)], {});
  eq(JSON.stringify(body.inputFiles), '[]');
});
check('通道开了「先上传素材」，且走 session 分片上传', () => {
  eq(ch.upload.enabled, true);
  eq(ch.upload.contentType, 'session');
  eq(ch.upload.path, '/media/uploads');
  eq(ch.upload.resultId, 'fileId');
});
check('请求体里不出现裸 URL 数组', () => {
  const text = ch.image.body;
  ['refImages', 'image_urls', 'images', 'reference_images'].forEach((key) => {
    assert(text.indexOf(key) < 0, '模板里不该出现 URL 字段 ' + key);
  });
});

console.log('\nC6 · 模型规格：按通道覆盖，不污染同名模型');
check('通道 2 的 flare 规格是三个固定像素', () => {
  const spec = modelSpecs.forModel(MODEL, CH_ID);
  eq(JSON.stringify(spec.sizes), JSON.stringify(PLATFORM_SIZES));
});
check('通道 2 的 flare 最多 8 张参考图', () => {
  eq(modelSpecs.forModel(MODEL, CH_ID).maxRefs, 8);
});
check('parameters 只允许 resolution（平台 additionalProperties:false）', () => {
  eq(JSON.stringify(modelSpecs.forModel(MODEL, CH_ID).paramKeys), JSON.stringify(['resolution']));
});
check('aicopy / visionary 的同名模型不受影响（仍是 1K/2K/4K）', () => {
  eq(JSON.stringify(modelSpecs.forModel(MODEL, 'ch_aicopy_img').sizes), JSON.stringify(['1K', '2K', '4K']));
  eq(JSON.stringify(modelSpecs.forModel(MODEL, 'ch_visionary_img').sizes), JSON.stringify(['1K', '2K', '4K']));
});
check('不传 channelId 时仍按模型名查（老调用点不受影响）', () => {
  eq(JSON.stringify(modelSpecs.forModel(MODEL).sizes), JSON.stringify(['1K', '2K', '4K']));
});
check('pruneUnsupportedParams 会剔掉 parameters 里的多余键', () => {
  const raw = JSON.stringify({ parameters: { resolution: '1024*1024', outputCount: 1, duration: 5 } });
  const out = JSON.parse(generate.pruneUnsupportedParams(raw, MODEL, CH_ID));
  eq(Object.keys(out.parameters).join(','), 'resolution');
});

console.log('\n────────────────────────────────────────────────────');
if (failed) {
  console.log('失败 ' + failed + ' 项，通过 ' + passed + ' 项');
  process.exit(1);
}
console.log('全部通过（' + passed + ' 项）');
