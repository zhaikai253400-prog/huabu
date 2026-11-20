'use strict';

// 新建卡片默认值：设置里指定「A 模型 2K / 16:9」，新建卡片就得照这个来。
//
// 这条链路跨三处，任何一处掉链子用户都会看到「设了没用」：
//   ① 共享规则（web/assets/card-defaults.js）：优先级、收敛、quick 跟随 video
//   ② 服务端：/api/settings 收得下、/api/status 发得出、模型被删时不清空用户参数
//   ③ 前端：addNode 把模型 + 通道 + 参数都写进新卡片，盒子按默认比例摆
//
// 用户踩过的两个坑，这里逐条守住：
//   · 只记模型名不记通道 → 同一模型名挂在两个渠道上时选错平台（尺寸契约完全不同）
//   · 模型自己声明的默认盖掉用户设置 → 设了 2K 建出来还是 1K
//
// 运行：runtime/node.exe tools/tests/card-defaults.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-carddefaults-'));
require(path.join(__dirname, '_isolate.js'))(box);

const rules = require(path.join(ROOT, 'web', 'assets', 'card-defaults.js'));
const configStore = require(path.join(ROOT, 'server', 'config.js'));
const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function eq(got, want, msg) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
  }
}

// 图片 / 视频模型的规格（照 server/model-specs.js 里真实那几条的形状写）
const FULL_IMAGE_SPEC = { sizes: ['1K', '2K', '4K'], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'], defaultResolution: '1K' };
const LITE_IMAGE_SPEC = { sizes: ['1K'], ratios: ['16:9', '9:16', '1:1'], defaultResolution: '1K' };
const VIDEO_SPEC = { resolutions: ['720p', '1080p'], durations: ['5', '10', '15', '30'], ratios: ['16:9', '9:16', '1:1'], modes: ['reference', 'frames'], defaultResolution: '1080P', defaultDuration: 5 };

console.log('A. 共享规则：结构与默认值');

check('三类卡片的参数键各自受限，串味的键会被丢掉', () => {
  const got = rules.normalize({
    image: { model: 'a', params: { size: '4K', duration: '30', mode: 'text', 乱写: 'x' } },
  });
  eq(Object.keys(got.image.params).sort(), ['size'], '图片卡只该留下 size');
});

check('手改 config.json 把参数平铺在同层也认（不用记嵌套结构）', () => {
  const got = rules.normalizeOne('video', { model: 'v', duration: 10, resolution: '1080p' });
  eq(got.params, { duration: '10', resolution: '1080p' });
});

check('快速视频没单独设时跟随视频（含模型、通道、参数，且不带「模式」）', () => {
  const got = rules.normalize({
    video: { model: 'v1', channelId: 'ch1', params: { duration: '10', resolution: '1080p', ratio: '9:16', mode: 'frames' } },
  });
  eq(got.quick.model, 'v1');
  eq(got.quick.channelId, 'ch1');
  eq(got.quick.params, { duration: '10', resolution: '1080p', ratio: '9:16' }, '快速视频不该带 mode');
});

check('快速视频自己设了就独立，不再被视频覆盖', () => {
  const got = rules.normalize({
    video: { model: 'v1', params: { duration: '10' } },
    quick: { model: 'v2', params: { duration: '5' } },
  });
  eq(got.quick.model, 'v2');
  eq(got.quick.params, { duration: '5' });
});

check('三类都不认识的值（例如音频）不会凭空长出一类', () => {
  const got = rules.normalize({ audio: { model: 'x' } });
  eq(Object.keys(got).sort(), ['image', 'quick', 'video']);
});

console.log('\nB. 共享规则：优先级与收敛');

check('用户设的 2K 压过模型自己声明的 1K 默认（这是用户明确的意思）', () => {
  const seeded = rules.seedParams('image', { model: 'a', params: { size: '2K' } }, FULL_IMAGE_SPEC);
  eq(seeded.params.size, '2K');
  eq(seeded.adjusted.length, 0, '模型支持 2K 就不该有调整');
});

check('用户设的 2K 在只开 1K 的模型上会收敛成 1K，并如实报出来', () => {
  const seeded = rules.seedParams('image', { model: 'lite', params: { size: '2K' } }, LITE_IMAGE_SPEC);
  eq(seeded.params.size, '1K');
  eq(seeded.adjusted, [{ key: 'size', want: '2K', got: '1K' }]);
});

check('视频：用户设 10 秒 / 1080P，在支持它的模型上原样保留', () => {
  const seeded = rules.seedParams('video', { model: 'v', params: { duration: '10', resolution: '1080p' } }, VIDEO_SPEC);
  eq(seeded.params.duration, '10');
  eq(seeded.params.resolution, '1080p');
});

check('视频：用户设 30 秒，模型只到 10 秒时收敛到它能接受的一档', () => {
  const short = Object.assign({}, VIDEO_SPEC, { durations: ['5', '10'] });
  const seeded = rules.seedParams('video', { model: 'v', params: { duration: '30' } }, short);
  assert(['5', '10'].indexOf(seeded.params.duration) >= 0, '30 秒没被收敛：' + seeded.params.duration);
  eq(seeded.adjusted[0].key, 'duration');
});

check('用户什么都没设时，模型声明的默认照旧生效（SD2.5 Flash 5 秒 / 1080P）', () => {
  const seeded = rules.seedParams('video', { model: 'v', params: {} }, VIDEO_SPEC);
  eq(seeded.params.duration, '5');
  eq(seeded.params.resolution, '1080p');
});

check('没有模型规格（模型没登记）时不收敛，用户设什么就是什么', () => {
  const seeded = rules.seedParams('image', { model: 'whatever', params: { size: '4K' } }, null);
  eq(seeded.params.size, '4K');
  eq(seeded.adjusted.length, 0);
});

check('张数只认 1–4（乱填 9 会被夹回 4，0 会被夹回 1）', () => {
  eq(rules.seedParams('image', { params: { count: '9' } }, null).params.count, '4');
  eq(rules.seedParams('image', { params: { count: '0' } }, null).params.count, '1');
});

console.log('\nC. 与服务端配置接线');

check('默认配置里有 cardDefaults 三类，且模型为空（= 跟随渠道默认）', () => {
  const one = configStore.defaultConfig();
  eq(Object.keys(one.cardDefaults).sort(), ['image', 'quick', 'video']);
  eq(one.cardDefaults.image.model, '');
  eq(one.cardDefaults.video.params, {});
});

check('normalizeCardDefaults 走的是共享规则（不是服务端另写一套）', () => {
  const got = configStore.normalizeCardDefaults({ image: { model: 'a', size: '2K', duration: '30' } });
  eq(got.image.params, { size: '2K' }, '图片卡不该收下 duration');
});

check('CARD_DEFAULT_TYPES 暴露给 index.js 用', () => {
  eq(configStore.CARD_DEFAULT_TYPES, ['image', 'video', 'quick']);
});

console.log('\nD. 前端接入（源码级：这几处掉链子就是「设了没用」）');

check('pickDefaultModel 里用户的默认模型排第一（压过「上次用过的」）', () => {
  const body = canvasSrc.slice(canvasSrc.indexOf('function pickDefaultModel('));
  const presetAt = body.indexOf('defaultModelEntryOf(type)');
  const memoAt = body.indexOf('readModelMemo()');
  assert(presetAt > 0 && memoAt > 0, '两个来源都得在');
  assert(presetAt < memoAt, '用户显式默认必须排在「上次用过的」之前');
});

check('新卡片会把 channelId 一起写进去（同名模型挂两个渠道时靠它选对）', () => {
  const addNode = canvasSrc.slice(canvasSrc.indexOf('function addNode('), canvasSrc.indexOf('function copySelection('));
  assert(/channelId:\s*seedChannel/.test(addNode), 'addNode 没写 channelId');
  assert(/seedChannel\s*=\s*pickDefaultChannelId\(/.test(addNode), '没有按默认值取通道');
});

check('新卡片的盒子按默认参数里的比例算（设了 9:16 就该是竖的）', () => {
  const addNode = canvasSrc.slice(canvasSrc.indexOf('function addNode('), canvasSrc.indexOf('function copySelection('));
  assert(/defaultSize\(type,\s*seedParams\)/.test(addNode), '盒子还在用全局默认比例');
});

check('seedParamsOf 走共享规则，并且用户设置压在模型默认之上', () => {
  const body = canvasSrc.slice(canvasSrc.indexOf('function seedParamsOf('));
  assert(body.indexOf('cardDefaultsRules.seedParams') > 0, '没有走共享规则');
  assert(body.indexOf('defaultPresetOf(type)') > 0, '没有读取用户默认值');
});

check('设置面板里选的档位模型不支持时，不能默默显示成「跟随默认」（否则用户以为没存上）', () => {
  const uiSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'ui.js'), 'utf8');
  assert(uiSrc.includes('该模型不支持'), '面板没有把不支持的那一档单独列出来');
  assert(/ghost\.value\s*=\s*current/.test(uiSrc), '没有保留用户原值的那一项');
});

check('「设为新建默认」不把模型自己的默认值写死进用户设置', () => {
  const body = canvasSrc.slice(canvasSrc.indexOf('function saveAsCardDefault('), canvasSrc.indexOf('// 定时组「同时生成」'));
  assert(body.includes('modelDefaults'), '没有区分模型默认与用户选择');
  assert(/delete params\[key\]/.test(body), '没有把与模型默认相同的项剔掉');
});

check('设置面板保存后会通知画布，不用刷新页面就生效', () => {
  assert(canvasSrc.includes("addEventListener('card-defaults-changed', syncUserDefaults)"), '画布没订阅变更事件');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'ui.js'), 'utf8');
  assert(uiSrc.includes("dispatchEvent(new CustomEvent('card-defaults-changed'))"), '设置面板没广播变更');
});

check('右键菜单里有「设为新建默认」', () => {
  assert(canvasSrc.includes('设为新建默认（'), '右键菜单缺这一项');
  assert(canvasSrc.includes('function saveAsCardDefault('), '没有实现');
});

check('两个页面都加载了共享规则脚本（且排在 ui.js 之前）', () => {
  ['canvas.html', 'index.html'].forEach((name) => {
    const html = fs.readFileSync(path.join(ROOT, 'web', name), 'utf8');
    const ruleAt = html.indexOf('/assets/card-defaults.js');
    assert(ruleAt > 0, name + ' 没加载 card-defaults.js');
    const uiAt = html.indexOf('/assets/ui.js');
    if (uiAt > 0) assert(ruleAt < uiAt, name + ' 里 card-defaults.js 必须排在 ui.js 之前');
  });
});
console.log('\nE. 真服务：设置保存 → 状态回读 → 模型校验');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function requestJson(port, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: port,
        path: urlPath,
        method: method,
        headers: Object.assign(
          { 'x-local-token': token },
          data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
        ),
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    req.end(data || undefined);
  });
}

async function withServer(fn) {
  const dataDir = path.join(box, 'data-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(dataDir, { recursive: true });
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--no-browser'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      CANVAS_DATA_DIR: dataDir,
      http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '',
    }),
    stdio: 'ignore',
  });
  let port = 0;
  try {
    for (let i = 0; i < 200; i += 1) {
      try {
        port = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')).port;
      } catch {
        port = 0;
      }
      if (port) {
        try {
          const r = await requestJson(port, 'GET', '/api/health', '', null);
          if (r.status === 200) break;
        } catch {
          /* 还在起 */
        }
      }
      await sleep(200);
    }
    if (!port) throw new Error('隔离服务没起来');
    const token = (() => {
      try {
        return fs.readFileSync(path.join(dataDir, 'admin-token.txt'), 'utf8').trim();
      } catch {
        return '';
      }
    })();
    await fn({ port, token, dataDir });
  } finally {
    try {
      server.kill();
    } catch {
      /* 已经退了 */
    }
  }
}

(async () => {
  await checkAsync('设置保存后 /api/status 能读回来，并且真的落盘了（换电脑 / 重启后还在）', async () => {
    await withServer(async ({ port, token, dataDir }) => {
      const saved = await requestJson(port, 'POST', '/api/settings', token, {
        cardDefaults: {
          image: { model: 'gpt-image-2', channelId: 'ch_x', params: { size: '4K', ratio: '9:16', count: '2' } },
          video: { model: '', channelId: '', params: {} },
        },
      });
      eq(saved.status, 200, '保存失败：' + saved.body);
      const status = JSON.parse((await requestJson(port, 'GET', '/api/status', token, null)).body);
      eq(status.cardDefaults.image.model, 'gpt-image-2');
      eq(status.cardDefaults.image.channelId, 'ch_x');
      eq(status.cardDefaults.image.params, { size: '4K', ratio: '9:16', count: '2' });
      const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      eq(onDisk.cardDefaults.image.params.size, '4K', '没写进磁盘');
    });
  });

  await checkAsync('没有任何渠道时也不拦保存（还没配模型的人不该被挡住）', async () => {
    await withServer(async ({ port, token }) => {
      const saved = await requestJson(port, 'POST', '/api/settings', token, {
        cardDefaults: { image: { model: 'gpt-image-2', params: { size: '2K' } } },
      });
      eq(saved.status, 200, '被拦了：' + saved.body);
    });
  });

  await checkAsync('参数里混进来的无关键在落盘时就被清掉', async () => {
    await withServer(async ({ port, token, dataDir }) => {
      await requestJson(port, 'POST', '/api/settings', token, {
        cardDefaults: { image: { model: '', params: { size: '4K', duration: '30', mode: 'text' } } },
      });
      const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      eq(onDisk.cardDefaults.image.params, { size: '4K' });
    });
  });

  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
