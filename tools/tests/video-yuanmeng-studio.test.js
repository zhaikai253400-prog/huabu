'use strict';

// 通道 4 · 元梦「源梦创作工作室」（yuanmengstudio.com/vr/api/studio）
// 模型：seedance2.5-480 / seedance2.5-720 / seedance2.5-flash-480 / seedance2.5-flash-720
//
// 这套契约和通道里原来的「拼车」接口完全不同，必须锁死：
//   · Base URL 前缀还是 /vr，但生成接口在 /vr/api/studio/* 下（拼车余额 / 发车仍走 /vr/api/*）；
//   · POST /jobs 必须带 Idempotency-Key（8–120 位），同键不同内容回 409；
//   · 请求体是 {action, prompt, options:{model,seconds,resolution,ratio}, references, videos, audios}，
//     参考素材传的是**上传得到的 job.id**，不是 URL；
//   · 提交返回批次：{group:{id, jobs:[{id}]}} → 任务号取值路径 group.jobs.0.id；
//   · 查询 GET /jobs/:id → {job:{status, mediaUrl}}，status: queued/running/done/failed；
//   · 这四个模型都**必须至少 1 张参考图**（/catalog 的 minImages:1），纯文字会被 400 拒；
//   · 每个模型只对应一个分辨率，卡片传别的档也不能漏出去；
//   · 提示词里要用 @图片1 引用素材（带 @）。

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
  try { fn(); passed += 1; console.log('  [OK] ' + name); }
  catch (error) { failed += 1; console.log('  [FAIL] ' + name + ' - ' + error.message); }
}
const eq = (a, b, msg) => assert.strictEqual(a, b, msg || (a + ' !== ' + b));

const CH_ID = 'ch_yuanmeng_station';
const MODELS = ['seedance2.5-480', 'seedance2.5-720', 'seedance2.5-flash-480', 'seedance2.5-flash-720'];

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
const ch = cfg.channels.find((c) => c.id === CH_ID);
if (!ch) throw new Error('config 里找不到 ' + CH_ID);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+g6wAAAAASUVORK5CYII=', 'base64');

function img(n, fileId) {
  return {
    kind: 'image',
    name: '图' + n,
    ext: '.png',
    mime: 'image/png',
    dataUrl: 'data:image/png;base64,' + PNG.toString('base64'),
    buffer: PNG,
    remoteId: fileId || ('upload_ref' + n),
  };
}

function render(model, refs, payload) {
  const p = payload || {};
  const res = p.resolution || '480p';
  const size = channels.sizeFor(ch, res, p.ratio || '16:9', 'video');
  const vars = generate.buildVars(
    Object.assign({ prompt: '[图42] 中的人物向镜头挥手', duration: 5, resolution: res, ratio: '16:9' }, p),
    ch, model, size, 1, refs, 'video'
  );
  return { vars, body: JSON.parse(generate.pruneEmptyMedia(channels.fillTemplate(ch.video.body, vars))) };
}

console.log('U1 - 四个模型都在清单里');
MODELS.forEach((id) => check('清单含 ' + id, () => assert(channels.modelIds(ch.models.video).indexOf(id) >= 0)));
check('默认模型在四个之内', () => assert(MODELS.indexOf(ch.defaults.video) >= 0));
check('通道只做视频', () => eq(JSON.stringify(ch.kinds), JSON.stringify(['video'])));
check('通道已启用', () => eq(ch.enabled, true));

console.log('U2 - 生成走 /api/studio，拼车功能不受影响');
check('建任务路径 /api/studio/jobs', () => { eq(ch.video.path, '/api/studio/jobs'); eq(ch.video.method, 'POST'); });
check('Base URL 仍是 /vr', () => eq(ch.baseUrl, 'https://yuanmengstudio.com/vr'));
check('余额仍走 /api/balance', () => { eq(ch.balance.enabled, true); eq(ch.balance.path, '/api/balance'); });
check('发车仍走 /api/ride', () => { eq(ch.ride.enabled, true); eq(ch.ride.path, '/api/ride'); });
check('清单从 /api/studio/catalog 拉', () => { eq(ch.lists.path, '/api/studio/catalog'); eq(ch.lists.resultPath, 'videos'); });

console.log('U3 - 请求体结构');
check('action=video 且 options 嵌套', () => {
  const { body } = render('seedance2.5-flash-480', [img(42)]);
  eq(body.action, 'video'); eq(body.options.model, 'seedance2.5-flash-480');
  eq(body.options.seconds, 5); eq(body.options.ratio, '16:9');
});
check('参考素材传 job.id', () => {
  const { body } = render('seedance2.5-480', [img(42, 'upload_aaa'), img(43, 'upload_bbb')]);
  eq(JSON.stringify(body.references), JSON.stringify(['upload_aaa', 'upload_bbb']));
});
check('空 videos/audios 被清掉', () => {
  const { body } = render('seedance2.5-480', [img(42)]);
  assert(!('videos' in body), '不该出现空 videos');
  assert(!('audios' in body), '不该出现空 audios');
});
check('请求头带幂等键模板', () => eq(ch.video.headers['Idempotency-Key'], '{{requestId}}'));

console.log('U4 - 任务号与轮询');
check('任务号取 group.jobs.0.id', () => eq(ch.video.poll.taskIdPath, 'group.jobs.0.id'));
check('轮询 /api/studio/jobs/{{taskId}}', () => {
  eq(ch.video.poll.enabled, true); eq(ch.video.poll.path, '/api/studio/jobs/{{taskId}}');
  eq(ch.video.poll.statusField, 'job.status');
});
check('done + job.mediaUrl', () => {
  assert(ch.video.poll.doneValues.indexOf('done') >= 0); eq(ch.video.poll.resultUrl, 'job.mediaUrl');
});

console.log('U5 - 每个模型一档分辨率');
check('480 只认 480p，720 只认 720p', () => {
  eq(JSON.stringify(modelSpecs.forModel('seedance2.5-480').resolutions), JSON.stringify(['480p']));
  eq(JSON.stringify(modelSpecs.forModel('seedance2.5-720').resolutions), JSON.stringify(['720p']));
  eq(JSON.stringify(modelSpecs.forModel('seedance2.5-flash-480').resolutions), JSON.stringify(['480p']));
  eq(JSON.stringify(modelSpecs.forModel('seedance2.5-flash-720').resolutions), JSON.stringify(['720p']));
});
check('传错分辨率会收敛', () => {
  eq(render('seedance2.5-480', [img(1)], { resolution: '720p' }).body.options.resolution, '480p');
  eq(render('seedance2.5-flash-720', [img(1)], { resolution: '480p' }).body.options.resolution, '720p');
});

console.log('U6 - 必须带参考图');
check('四个模型 minRefs 都是 1', () => MODELS.forEach((id) => eq(Number(modelSpecs.forModel(id).minRefs), 1)));
check('不带参考图本地就拦住', () => {
  MODELS.forEach((id) => {
    let threw = false;
    try { generate.checkModelRefs(id, [], 'video', CH_ID); } catch (e) { threw = true; }
    assert(threw, id + ' 应该报错');
  });
});
check('带 1 张能通过', () => generate.checkModelRefs('seedance2.5-flash-480', [img(1)], 'video', CH_ID));
check('合计上限按 catalog 分开', () => {
  eq(Number(modelSpecs.forModel('seedance2.5-480').maxRefTotal), 30);
  eq(Number(modelSpecs.forModel('seedance2.5-flash-480').maxRefTotal), 20);
});

console.log('U7 - 提示词用 @图片N');
check('refPromptIndex + refPromptAt 都开着', () => { eq(ch.refPromptIndex, true); eq(ch.refPromptAt, true); });
check('图42 映射成 @图片1', () => {
  const { vars } = render('seedance2.5-flash-480', [img(42), img(43)]);
  assert(vars.prompt.indexOf('@图片1') >= 0, '实际：' + vars.prompt);
  assert(vars.prompt.indexOf('图42') < 0, '不该残留 图42');
});
check('不带 atPrefix 的通道仍输出 图片1', () => {
  eq(generate.remapRefNamesInPrompt('图42 在这里', [{ name: '图42', kind: 'image' }]), '图片1 在这里');
  eq(generate.remapRefNamesInPrompt('图42 在这里', [{ name: '图42', kind: 'image' }], { atPrefix: true }), '@图片1 在这里');
});

console.log('U8 - 上传素材');
check('上传走 /api/studio/uploads，取 job.id', () => {
  eq(ch.upload.enabled, true); eq(ch.upload.path, '/api/studio/uploads');
  eq(ch.upload.contentType, 'form'); eq(ch.upload.field, 'file'); eq(ch.upload.resultId, 'job.id');
});

console.log('---');
if (failed) { console.log('失败 ' + failed + ' 项，通过 ' + passed + ' 项'); process.exit(1); }
console.log('全部通过（' + passed + ' 项）');
