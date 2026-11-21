
'use strict';

// 参考素材「按类型分别上传」· 自包含测试
//
// 背景（2026-11-21 用户实测）：通道 11（星光 seedance2.5）配的上传图床是 picui.cn。
// 它只收图片 —— 上传 mp3 / mp4 会返回 HTTP 200 + {"status":false,"message":"不支持的文件类型"}，
// 画布只看到「没拿到素材地址」，报错指向「检查上传结果取值路径」，完全误导。
//
// 这个文件守四件事：
//   1. 每种素材按自己的类型挑上传设置（图片一个图床、音视频另一个）；
//   2. 类型没单独配时，原样跟随通用设置（不能因为新增字段就改变老行为）；
//   3. 图床 200 但 JSON 里写着失败时，报错必须把图床原文带出来；
//   4. 体检要提前提醒「这个图床只收图片」；
//   5. 主图床不收音频 / 视频时，自动换备用图床重试（代码级兜底，另一台电脑同步代码就生效）。
//
// 网络只打本机 127.0.0.1 上临时起的 mock 图床，不碰外网。
//
// 运行：runtime/node.exe tools/tests/upload-by-kind.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-upload-kind-'));
require(path.join(__dirname, '_isolate.js'))(box);

const channels = require(path.join(SERVER, 'channels.js'));
const generate = require(path.join(SERVER, 'generate.js'));

// --- 本机 mock 图床 -------------------------------------------------------
const seen = [];
const server = http.createServer(function (req, res) {
  const chunks = [];
  req.on('data', function (one) { chunks.push(one); });
  req.on('end', function () {
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ url: req.url, type: String(req.headers['content-type'] || ''), body: body });
    if (req.url.indexOf('/image-only') === 0) {
      // 复刻 picui.cn：HTTP 200，但 JSON 里说失败
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: false, message: '不支持的文件类型', data: {} }));
      return;
    }
    if (req.url.indexOf('/no-ext') === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ link: 'http://127.0.0.1:' + port + '/f/abc' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ link: 'http://127.0.0.1:' + port + '/f/ok.bin' }));
  });
});
let port = 0;

function channelWith(upload) {
  return channels.normalizeChannel({
    id: 'ch_fixture',
    name: '夹具通道',
    kinds: ['video'],
    baseUrl: 'http://127.0.0.1:' + port + '/v1',
    apiKey: 'sk-test',
    upload: upload,
  });
}

const MP3 = Buffer.from('ID3demo-audio-bytes');
function audioRef(name) {
  return { kind: 'audio', name: name || '配音.mp3', ext: '.mp3', mime: 'audio/mpeg', buffer: MP3, dataUrl: '' };
}
function videoRef() {
  return { kind: 'video', name: '参考.mp4', ext: '.mp4', mime: 'video/mp4', buffer: Buffer.from('mp4demo'), dataUrl: '' };
}
function imageRef() {
  return { kind: 'image', name: '参考.png', ext: '.png', mime: 'image/png', buffer: Buffer.from('pngdemo'), dataUrl: '' };
}

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
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    fail += 1;
    console.log('  ✗ ' + name + ' —— ' + error.message);
  }
}
function eq(got, want, msg) {
  if (got !== want) throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

(async function main() {
  await new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      port = server.address().port;
      resolve();
    });
  });
  const base = 'http://127.0.0.1:' + port;

  console.log('\nU1 · 按类型挑上传设置');

  check('三种素材各走各的路径', () => {
    const ch = channelWith({
      enabled: true,
      path: base + '/image',
      contentType: 'form',
      field: 'file',
      resultUrl: 'link',
      audio: { path: base + '/audio', resultUrl: 'link' },
      video: { path: base + '/video', resultUrl: 'link' },
    });
    eq(channels.uploadSpecFor(ch, 'image').path, base + '/image');
    eq(channels.uploadSpecFor(ch, 'audio').path, base + '/audio');
    eq(channels.uploadSpecFor(ch, 'video').path, base + '/video');
  });

  check('类型没配路径时整套跟随通用设置（老配置行为不变）', () => {
    const ch = channelWith({ enabled: true, path: base + '/image', contentType: 'form', field: 'file', resultUrl: 'link' });
    const spec = channels.uploadSpecFor(ch, 'audio');
    eq(spec.path, base + '/image');
    eq(spec.field, 'file');
    eq(spec.resultUrl, 'link');
  });

  check('只配了路径，没配的字段从通用设置补上', () => {
    const ch = channelWith({
      enabled: true,
      path: base + '/image',
      contentType: 'form',
      field: 'upfile',
      resultUrl: 'data.links.url',
      timeoutSec: 180,
      audio: { path: base + '/audio', resultUrl: 'link' },
    });
    const spec = channels.uploadSpecFor(ch, 'audio');
    eq(spec.path, base + '/audio', '路径用单独的');
    eq(spec.field, 'upfile', '字段名应跟随通用');
    eq(spec.resultUrl, 'link', '取值路径用单独的');
    eq(spec.timeoutSec, 180, '超时跟随通用');
  });

  check('开关关着时一律返回通用设置（不会凭空去上传）', () => {
    const ch = channelWith({ enabled: false, path: base + '/image', audio: { path: base + '/audio' } });
    eq(channels.uploadSpecFor(ch, 'audio').enabled, false);
  });

  console.log('\nU2 · 真的按类型传出去');

  await checkAsync('音频进 /audio，图片进 /image', async () => {
    seen.length = 0;
    const ch = channelWith({
      enabled: true,
      path: base + '/image',
      contentType: 'form',
      field: 'file',
      resultUrl: 'link',
      audio: { path: base + '/audio', resultUrl: 'link' },
    });
    await generate.uploadRefs(ch, [imageRef(), audioRef()], null, function () {});
    const urls = seen.map(function (one) { return one.url; });
    eq(urls.length, 2);
    assert(urls[0].indexOf('/image') === 0, '第一张图应进 /image，实际 ' + urls[0]);
    assert(urls[1].indexOf('/audio') === 0, '音频应进 /audio，实际 ' + urls[1]);
  });

  await checkAsync('上传成功后 remoteUrl 写回素材上', async () => {
    seen.length = 0;
    const ch = channelWith({
      enabled: true,
      path: base + '/image',
      contentType: 'form',
      field: 'file',
      resultUrl: 'link',
      audio: { path: base + '/audio', resultUrl: 'link' },
    });
    const refs = [audioRef()];
    await generate.uploadRefs(ch, refs, null, function () {});
    assert(refs[0].remoteUrl.indexOf('/f/ok.bin') > 0, '没写回地址：' + refs[0].remoteUrl);
  });

  await checkAsync('appendExt：地址没扩展名时按真实后缀补上', async () => {
    seen.length = 0;
    const ch = channelWith({
      enabled: true,
      path: base + '/no-ext',
      contentType: 'form',
      field: 'file',
      resultUrl: 'link',
      audio: { path: base + '/no-ext', resultUrl: 'link', appendExt: true },
    });
    const refs = [audioRef()];
    await generate.uploadRefs(ch, refs, null, function () {});
    assert(refs[0].remoteUrl.endsWith('/abc.mp3'), '没补扩展名：' + refs[0].remoteUrl);
  });

  console.log('\nU3 · 图床 200 但拒绝时，报错要说人话');

  await checkAsync('报错里带图床原文，并点明是图床的问题', async () => {
    seen.length = 0;
    const ch = channelWith({
      enabled: true,
      path: base + '/image-only',
      contentType: 'form',
      field: 'file',
      resultUrl: 'data.links.url',
    });
    let caught = null;
    try {
      await generate.uploadRefs(ch, [audioRef()], null, function () {});
    } catch (error) {
      caught = error;
    }
    assert(caught, '本该报错却成功了');
    assert(caught.message.indexOf('上传音频') === 0, '标题应点明是音频：' + caught.message);
    assert(caught.message.indexOf('不支持的文件类型') > 0, '标题里没带图床原文：' + caught.message);
    assert((caught.detail || '').indexOf('不是生成平台报的错') > 0, '详情没说清是谁的错：' + caught.detail);
    assert((caught.detail || '').indexOf('单独填') > 0, '详情没给出怎么办：' + caught.detail);
  });

  await checkAsync('视频失败时标题说的是视频', async () => {
    const ch = channelWith({
      enabled: true,
      path: base + '/image-only',
      contentType: 'form',
      field: 'file',
      resultUrl: 'data.links.url',
    });
    let caught = null;
    try {
      await generate.uploadRefs(ch, [videoRef()], null, function () {});
    } catch (error) {
      caught = error;
    }
    assert(caught && caught.message.indexOf('上传视频') === 0, '标题不对：' + (caught && caught.message));
  });

  console.log('\nU4 · 体检提前提醒');

  check('兜底关掉时，警示要明确说「一带音频就会失败」', () => {
    const ch = channels.normalizeChannel({
      id: 'c1b',
      name: '星光视频',
      kinds: ['video'],
      baseUrl: 'https://xingapi.top/v1',
      apiKey: 'sk-x',
      models: { video: ['seedance2.5-M'] },
      upload: { enabled: true, path: 'https://picui.cn/api/v1/upload', resultUrl: 'data.links.url', fallback: false },
      refLimits: { audio: { maxCount: 10 }, video: { maxCount: 10 } },
    });
    const one = channels.inspectChannel(ch);
    const hit = (one.notices || []).filter(function (it) { return it.field === 'upload.path'; });
    assert(hit.length === 1, '应该有 1 条提示，实际 ' + hit.length);
    assert(hit[0].detail.indexOf('已关掉') > 0, '没说明兜底已关：' + hit[0].detail);
    assert(hit[0].detail.indexOf('就会失败') > 0, '没说清后果：' + hit[0].detail);
  });

  check('只收图片的图床 + 要传音频 → 有提示', () => {
    const ch = channels.normalizeChannel({
      id: 'c1',
      name: '星光视频',
      kinds: ['video'],
      baseUrl: 'https://xingapi.top/v1',
      apiKey: 'sk-x',
      models: { video: ['seedance2.5-M'] },
      upload: { enabled: true, path: 'https://picui.cn/api/v1/upload', resultUrl: 'data.links.url' },
      refLimits: { audio: { maxCount: 10 }, video: { maxCount: 10 } },
    });
    const one = channels.inspectChannel(ch);
    const hit = (one.notices || []).filter(function (it) { return it.field === 'upload.path'; });
    assert(hit.length === 1, '应该有 1 条图床提示，实际 ' + hit.length);
    assert(hit[0].detail.indexOf('只收图片') > 0, '提示没说原因：' + hit[0].detail);
    assert(hit[0].detail.indexOf('自动') > 0, '兜底开着时应说明会自动换图床：' + hit[0].detail);
  });

  check('音频已经单独配了能收的地址 → 不再提示', () => {
    const ch = channels.normalizeChannel({
      id: 'c2',
      name: '星光视频',
      kinds: ['video'],
      baseUrl: 'https://xingapi.top/v1',
      apiKey: 'sk-x',
      models: { video: ['seedance2.5-M'] },
      upload: {
        enabled: true,
        path: 'https://picui.cn/api/v1/upload',
        resultUrl: 'data.links.url',
        audio: { path: 'https://kappa.lol/api/upload', resultUrl: 'link' },
        video: { path: 'https://kappa.lol/api/upload', resultUrl: 'link' },
      },
      refLimits: { audio: { maxCount: 10 }, video: { maxCount: 10 } },
    });
    const one = channels.inspectChannel(ch);
    const hit = (one.notices || []).filter(function (it) { return it.field === 'upload.path'; });
    eq(hit.length, 0, '不该再提示');
  });

  check('通道根本不收音频（maxCount = 0）→ 不提示', () => {
    const ch = channels.normalizeChannel({
      id: 'c3',
      name: '只图',
      kinds: ['video'],
      baseUrl: 'https://xingapi.top/v1',
      apiKey: 'sk-x',
      models: { video: ['m'] },
      upload: { enabled: true, path: 'https://picui.cn/api/v1/upload', resultUrl: 'data.links.url' },
      refLimits: { audio: { maxCount: 0 }, video: { maxCount: 0 } },
    });
    const one = channels.inspectChannel(ch);
    const hit = (one.notices || []).filter(function (it) { return it.field === 'upload.path'; });
    eq(hit.length, 0, '不收音频就不该提示');
  });

  check('非图片图床（本机地址）不提示', () => {
    const ch = channels.normalizeChannel({
      id: 'c4',
      name: '普通',
      kinds: ['video'],
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      models: { video: ['m'] },
      upload: { enabled: true, path: 'http://127.0.0.1:9/upload', resultUrl: 'link' },
    });
    const one = channels.inspectChannel(ch);
    const hit = (one.notices || []).filter(function (it) { return it.field === 'upload.path'; });
    eq(hit.length, 0);
  });

  console.log('\nU5 · 归一化不吃掉未知字段');

  check('audio / video 子配置能存能读', () => {
    const ch = channels.normalizeChannel({
      id: 'c5',
      name: 'x',
      baseUrl: 'https://x.example/v1',
      apiKey: 'sk',
      upload: {
        enabled: true,
        path: 'https://picui.cn/api/v1/upload',
        audio: { path: ' https://kappa.lol/api/upload ', resultUrl: 'link', appendExt: true, extra: { a: 1 } },
        video: {},
      },
    });
    eq(ch.upload.audio.path, 'https://kappa.lol/api/upload', '路径应去掉首尾空格');
    eq(ch.upload.audio.appendExt, true);
    eq(ch.upload.audio.extra.a, '1');
    eq(ch.upload.video.path, '');
    eq(ch.upload.appendExt, false, '通用 appendExt 默认 false');
  });

  check('老配置（没有 audio/video 字段）读出来是空壳而不是 undefined', () => {
    const ch = channels.normalizeChannel({ id: 'c6', name: 'x', baseUrl: 'https://x.example/v1', apiKey: 'sk', upload: { enabled: true, path: '/files/upload' } });
    eq(typeof ch.upload.audio, 'object');
    eq(ch.upload.audio.path, '');
    eq(typeof ch.upload.video, 'object');
  });

  console.log('\nU6 · 主图床不收时自动换备用图床');

  check('picui + 音频、没单独配 → 给出 kappa.lol 备用规格', () => {
    const ch = channels.normalizeChannel({
      id: 'c7',
      name: '星光视频',
      kinds: ['video'],
      baseUrl: 'https://xingapi.top/v1',
      apiKey: 'sk-x',
      upload: { enabled: true, path: 'https://picui.cn/api/v1/upload', field: 'file', resultUrl: 'data.links.url' },
    });
    const spare = channels.fallbackUploadSpec(ch, 'audio');
    assert(spare, '应该给出备用规格');
    eq(spare.path, 'https://kappa.lol/api/upload');
    eq(spare.field, 'file');
    eq(spare.resultUrl, 'link');
    eq(spare.appendExt, true);
  });

  check('备用规格不带主图床的任何请求头 / 附加参数（防泄露 token）', () => {
    const ch = channels.normalizeChannel({
      id: 'c8',
      name: 'x',
      baseUrl: 'https://xingapi.top/v1',
      apiKey: 'sk-x',
      upload: {
        enabled: true,
        path: 'https://picui.cn/api/v1/upload',
        resultUrl: 'data.links.url',
        headers: { Authorization: 'Bearer picui-token' },
        extra: { token: 'picui-extra' },
      },
    });
    const spare = channels.fallbackUploadSpec(ch, 'video');
    eq(Object.keys(spare.headers).length, 0, '不该带请求头');
    eq(Object.keys(spare.extra).length, 0, '不该带附加参数');
  });

  check('图片永远不换备用图床', () => {
    const ch = channels.normalizeChannel({
      id: 'c9',
      name: 'x',
      baseUrl: 'https://xingapi.top/v1',
      apiKey: 'sk-x',
      upload: { enabled: true, path: 'https://picui.cn/api/v1/upload', resultUrl: 'data.links.url' },
    });
    eq(channels.fallbackUploadSpec(ch, 'image'), null);
  });

  check('用户关了兜底开关就不换', () => {
    const ch = channels.normalizeChannel({
      id: 'c10',
      name: 'x',
      baseUrl: 'https://xingapi.top/v1',
      apiKey: 'sk-x',
      upload: { enabled: true, path: 'https://picui.cn/api/v1/upload', resultUrl: 'data.links.url', fallback: false },
    });
    eq(ch.upload.fallback, false);
    eq(channels.fallbackUploadSpec(ch, 'audio'), null);
  });

  check('老配置没写 fallback 字段时默认开着', () => {
    const ch = channels.normalizeChannel({
      id: 'c11',
      name: 'x',
      baseUrl: 'https://xingapi.top/v1',
      apiKey: 'sk-x',
      upload: { enabled: true, path: 'https://picui.cn/api/v1/upload', resultUrl: 'data.links.url' },
    });
    eq(ch.upload.fallback, true);
  });

  check('非纯图片图床不换（不乱改用户配好的图床）', () => {
    const ch = channels.normalizeChannel({
      id: 'c12',
      name: 'x',
      baseUrl: 'https://xingapi.top/v1',
      apiKey: 'sk-x',
      upload: { enabled: true, path: base + '/audio', resultUrl: 'link' },
    });
    eq(channels.fallbackUploadSpec(ch, 'audio'), null);
  });

  await checkAsync('真的会自动重传，并把地址写回素材', async () => {
    // 借用本机 mock：主图床 /image-only 拒收，备用图床 /spare 收
    const spareHost = 'http://127.0.0.1:' + port + '/spare';
    const FALLBACK = channels.fallbackUploadSpec;
    channels.fallbackUploadSpec = function (channel, kind) {
      if (kind !== 'audio' && kind !== 'video') return null;
      return { enabled: true, path: spareHost, method: 'POST', contentType: 'form', field: 'file', resultUrl: 'link', resultId: '', appendExt: true, timeoutSec: 60, extra: {}, headers: {} };
    };
    try {
      seen.length = 0;
      const ch = channelWith({
        enabled: true,
        path: base + '/image-only',
        contentType: 'form',
        field: 'file',
        resultUrl: 'data.links.url',
      });
      const refs = [audioRef()];
      await generate.uploadRefs(ch, refs, null, function () {});
      const urls = seen.map(function (one) { return one.url; });
      eq(urls.length, 2, '应该传两次（主 + 备用）');
      assert(urls[0].indexOf('/image-only') === 0, '第一次应走主图床，实际 ' + urls[0]);
      assert(urls[1].indexOf('/spare') === 0, '第二次应走备用图床，实际 ' + urls[1]);
      assert(refs[0].remoteUrl.indexOf('/f/ok.bin') > 0, '没写回地址：' + refs[0].remoteUrl);
    } finally {
      channels.fallbackUploadSpec = FALLBACK;
    }
  });

  await checkAsync('备用图床也拒时，报错说的是备用图床', async () => {
    const FALLBACK = channels.fallbackUploadSpec;
    channels.fallbackUploadSpec = function () {
      return { enabled: true, path: base + '/image-only', method: 'POST', contentType: 'form', field: 'file', resultUrl: 'link', resultId: '', appendExt: true, timeoutSec: 60, extra: {}, headers: {} };
    };
    try {
      const ch = channelWith({ enabled: true, path: base + '/image-only', contentType: 'form', field: 'file', resultUrl: 'data.links.url' });
      let caught = null;
      try {
        await generate.uploadRefs(ch, [audioRef()], null, function () {});
      } catch (error) {
        caught = error;
      }
      assert(caught, '本该报错却成功了');
      assert(caught.message.indexOf('不支持的文件类型') > 0, '报错没带图床原文：' + caught.message);
    } finally {
      channels.fallbackUploadSpec = FALLBACK;
    }
  });

  console.log('\n────────────────────────────────────────────────────');
  server.close();
  if (fail) {
    console.log('失败 ' + fail + ' 项，通过 ' + pass + ' 项');
    process.exit(1);
  }
  console.log('全部通过（' + pass + ' 项）');
})().catch(function (error) {
  console.error(error);
  server.close();
  process.exit(1);
});
