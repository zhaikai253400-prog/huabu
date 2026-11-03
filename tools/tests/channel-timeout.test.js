'use strict';

// F5 · 通道超时专项测试（清单 41 第六项，对应清单 12 / 13）。
//
// 超时是这类「本机守着平台慢慢出片」的应用里最容易把人耗死的一处：
// 设太短，视频还没出片就被判死；设太长或设成 0，页面一直转圈、用户不知道
// 是该等还是该重来。这个文件守四件事：
//
//   1. **归一有上下界**：通道里手填的超时 / 轮询间隔 / 最长等待都夹在合理区间内，
//      写坏了也不会变成「等 0 秒」或「每毫秒问一次」。
//   2. **体检要提醒没设超时的地方**，并且说清「已自动补上默认值」，
//      而不是静默替用户做决定。
//   3. **真超时要能被认出来**：请求没走到平台（连不上 / 被中止）归到 NETWORK，
//      这一类的语义是「会自动重试，别急着判死」。
//   4. **要等一下的地方真的会等**（起本地 mock server 验），
//      而且要等的那一侧「平台说不行」时不许重试。
//
// 这个文件里唯一的网络行为指向本机 127.0.0.1 上临时起的 mock server，
// 不碰任何外网。
//
// 运行：runtime/node.exe tools/tests/channel-timeout.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-timeout-'));
require(path.join(__dirname, '_isolate.js'))(box);

const channels = require(path.join(SERVER, 'channels.js'));
const errorKinds = require(path.join(SERVER, 'error-kinds.js'));
const assets = require(path.join(SERVER, 'assets.js'));

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
  if (got !== want) {
    throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
  }
}

console.log('\nF5 · 通道超时');

console.log('\n[1] 归一：上下界都夹住');

check('上传超时夹在 10..3600 秒（写坏了也不会变成 0）', () => {
  const up = (value) => channels.normalizeUpload({ timeoutSec: value }).timeoutSec;
  eq(up(0), 300, '0 应落回默认');
  eq(up(1), 10, '低于下限应抬到 10');
  eq(up(99999), 3600, '高于上限应压到 3600');
  eq(up(120), 120, '区间内的应原样保留');
  eq(up('乱写'), 300, '非数字应落回默认');
});

check('负数超时被抬到下限（不是照抄一个过不去的负数）', () => {
  const up = (value) => channels.normalizeUpload({ timeoutSec: value }).timeoutSec;
  eq(up(-5), 10, '负数应被下限夹住');
});

check('图片接口的超时同样夹住（走 normalizeChannel 取真实路径）', () => {
  const t = (value) =>
    channels.normalizeChannel({ id: 'c', name: 'x', baseUrl: 'http://127.0.0.1:1', image: { timeoutSec: value } }).image
      .timeoutSec;
  eq(t(0), 300, '0 应落回默认');
  eq(t(1), 10, '低于下限应抬到 10');
  eq(t(99999), 3600, '高于上限应压到 3600');
  eq(t(120), 120);
});

check('视频接口的默认超时更长（出片本来就慢）', () => {
  const v = channels.defaultApiSpec('video').timeoutSec;
  const i = channels.defaultApiSpec('image').timeoutSec;
  assert(v > i, '视频默认超时应长于图片：' + v + ' vs ' + i);
  eq(v, 600);
});

check('轮询间隔夹在 1..600 秒', () => {
  const iv = (value) =>
    channels.normalizeChannel({
      id: 'c',
      name: 'x',
      baseUrl: 'http://127.0.0.1:1',
      image: { poll: { intervalSec: value } },
    }).image.poll.intervalSec;
  eq(iv(0), channels.defaultPoll('image').intervalSec, '0 应落回默认');
  eq(iv(0.1), 1, '低于下限应抬到 1');
  eq(iv(99999), 600, '高于上限应压到 600');
  eq(iv(5), 5);
});

check('最长等待夹在 30..86400 秒', () => {
  const mw = (value) =>
    channels.normalizeChannel({
      id: 'c',
      name: 'x',
      baseUrl: 'http://127.0.0.1:1',
      video: { poll: { maxWaitSec: value } },
    }).video.poll.maxWaitSec;
  eq(mw(0), channels.defaultPoll('video').maxWaitSec, '0 应落回默认');
  eq(mw(1), 30, '低于下限应抬到 30');
  eq(mw(999999), 86400, '高于上限应压到 24 小时');
});

check('归一后的通道整体可用（不是把配置改坏）', () => {
  const ch = channels.normalizeChannel({ id: 'c1', name: '测试', baseUrl: 'http://127.0.0.1:1' });
  ['image', 'video', 'audio'].forEach((kind) => {
    const spec = ch[kind];
    assert(spec && Number(spec.timeoutSec) >= 10, kind + ' 的超时没归一好');
    assert(Number(spec.poll.intervalSec) >= 1, kind + ' 的轮询间隔没归一好');
    assert(Number(spec.poll.maxWaitSec) >= 30, kind + ' 的最长等待没归一好');
  });
});

console.log('\n[2] 体检：没设超时要提醒，并说清已补默认值');

function inspectOne(channelInput) {
  return channels.inspectChannel(channels.normalizeChannel(channelInput));
}

check('超时设成 0 → 提示「已自动补上默认值」', () => {
  // 体检读的是「用户填进来的原始形状」，所以这里不先归一
  const raw = {
    id: 'c1',
    name: '测试',
    kinds: ['image'],
    baseUrl: 'http://127.0.0.1:1',
    image: channels.defaultApiSpec('image'),
  };
  raw.image.timeoutSec = 0;
  const out = channels.inspectChannel(raw);
  const hit = out.notices.find((item) => item.field === 'image.timeoutSec');
  assert(hit, '没有为缺超时报警：' + JSON.stringify(out.notices));
  assert(hit.detail.indexOf('默认值') >= 0, '没说清已经补了默认值：' + hit.detail);
});

check('超时设了正常值 → 不提醒', () => {
  const raw = {
    id: 'c1',
    name: '测试',
    kinds: ['image'],
    baseUrl: 'http://127.0.0.1:1',
    image: channels.defaultApiSpec('image'),
  };
  raw.image.timeoutSec = 120;
  const out = channels.inspectChannel(raw);
  assert(!out.notices.find((item) => item.field === 'image.timeoutSec'), '不该提醒');
});

check('超时提示不算「问题」，只算「值得看一眼」（不挡用户保存）', () => {
  // 这条是给未来的改动立规矩：缺超时是「能跑但值得看一眼」，
  // 一旦把它算成 problem，用户填完通道会被拦住保存，改动本身没错却存不下去。
  const raw = {
    id: 'c1',
    name: '测试',
    kinds: ['image'],
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'sk-test',
    auth: { style: 'bearer' },
    models: { image: ['m1'] },
    image: channels.defaultApiSpec('image'),
  };
  raw.image.timeoutSec = 0;
  const out = channels.inspectChannels([raw]);
  eq(out.problemCount, 0, '超时没设不该算成问题，否则用户会被拦住保存');
  assert(out.noticeCount > 0, '也没提醒，用户就不知道发生了什么');
});

check('异步出片却关了轮询 → 提醒（这类平台会一直拿不到结果）', () => {
  const raw = {
    id: 'c1',
    name: '测试',
    kinds: ['video'],
    baseUrl: 'http://127.0.0.1:1',
    models: { video: ['v1'] },
    video: channels.defaultApiSpec('video'),
  };
  raw.video.poll.enabled = false;
  const out = channels.inspectChannel(raw);
  const hit = out.notices.find((item) => item.field === 'video.poll');
  assert(hit, '没有为「视频关了轮询」提醒');
  assert(hit.detail.indexOf('异步') >= 0, '没说清为什么该开：' + hit.detail);
});

check('图片关轮询不提醒（同步接口是常态）', () => {
  const raw = {
    id: 'c1',
    name: '测试',
    kinds: ['image'],
    baseUrl: 'http://127.0.0.1:1',
    models: { image: ['m1'] },
    image: channels.defaultApiSpec('image'),
  };
  raw.image.poll.enabled = false;
  const out = channels.inspectChannel(raw);
  assert(!out.notices.find((item) => item.field === 'image.poll'), '图片关轮询不该提醒');
});

check('体检不判死：有提醒的通道 ok 仍为 true（能跑，只是值得看一眼）', () => {
  const raw = {
    id: 'c1',
    name: '测试',
    kinds: ['image'],
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'sk-test',
    auth: { style: 'bearer' },
    models: { image: ['m1'] },
    image: channels.defaultApiSpec('image'),
  };
  raw.image.timeoutSec = 0;
  const out = channels.inspectChannel(raw);
  eq(out.problems.length, 0, '不该有真问题：' + JSON.stringify(out.problems));
  eq(out.ok, true, '只有提醒不该判死');
});

console.log('\n[3] 真超时：分类与提示');

check('被中止 / 超时归到 NETWORK（会自动重试的那一类）', () => {
  const error = new Error('The operation was aborted due to timeout');
  const info = errorKinds.classify(error, { where: 'poll' });
  eq(info.kind, 'NETWORK');
  eq(info.retryable, true, '网络类应当可重试');
  eq(info.failFast, false, '网络类不该立刻判死');
});

check('连不上平台也归 NETWORK，并提示去看 Base URL', () => {
  const error = new Error('connect ECONNREFUSED 127.0.0.1:1');
  const info = errorKinds.classify(error, { where: 'submit' });
  eq(info.kind, 'NETWORK');
  assert(info.advice.indexOf('Base URL') >= 0, '没告诉用户去哪儿查：' + info.advice);
});

check('NETWORK 不记连击（网络抖动不该累计成判死）', () => {
  eq(errorKinds.KINDS.NETWORK.strikes, 0);
  eq(errorKinds.KINDS.NETWORK.failFast, false);
});

check('等满最长等待时间 → PLATFORM_TIMEOUT，提示「稍后重试或调小参数」', () => {
  const info = errorKinds.meta('PLATFORM_TIMEOUT');
  assert(info.title.indexOf('太久') >= 0, '标题没点明是等太久：' + info.title);
  assert(info.advice.indexOf('调小') >= 0, '没给出可操作的建议：' + info.advice);
  eq(info.retryable, true);
  eq(info.strikes, 0, '等超时不该累计判死');
});

check('平台在排队 → PLATFORM_QUEUE，语义是「继续等就行」', () => {
  const info = errorKinds.meta('PLATFORM_QUEUE');
  eq(info.retryable, true);
  eq(info.strikes, 0);
  assert(info.advice.indexOf('等') >= 0);
});

check('makeError 造出的超时错误带齐 kind / advice / retryable', () => {
  const error = errorKinds.makeError('PLATFORM_TIMEOUT', '已等 1800 秒');
  eq(error.kind, 'PLATFORM_TIMEOUT');
  eq(error.retryable, true);
  eq(error.detail, '已等 1800 秒');
  assert(error.advice.length > 0);
});

console.log('\n[4] 真实等待：本地 mock server');

// 起一个最小 HTTP server，按路径决定行为
function startMock() {
  return new Promise((resolve) => {
    const hits = { slow: 0, notfound: 0, ok: 0, list: 0 };
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      if (url.indexOf('/slow') === 0) {
        hits.slow += 1;
        // 永不回应：用来验证超时真的会触发（比 sleep 更干净，不留定时器）
        return;
      }
      if (url.indexOf('/notfound') === 0) {
        hits.notfound += 1;
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      if (url.indexOf('/client-err') === 0) {
        hits.notfound += 1;
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('bad request');
        return;
      }
      hits.ok += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { url: 'http://127.0.0.1/x.png' } }));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server: server, port: server.address().port, hits: hits });
    });
  });
}

(async () => {
  const mock = await startMock();
  const base = 'http://127.0.0.1:' + mock.port;

  await checkAsync('callApi 能拿到正常响应', async () => {
    const out = await channels.callApi(
      { baseUrl: base, auth: { style: 'none' }, query: {}, headers: {} },
      { path: '/ok', method: 'GET', contentType: 'none', timeoutSec: 10, where: 'api' }
    );
    assert(out && out.json, '没有拿到 JSON');
    eq(out.json.data.url, 'http://127.0.0.1/x.png');
    eq(mock.hits.ok, 1, 'mock 没被请求到');
  });

  await checkAsync('超时会真的中止（不会一直挂着）', async () => {
    const started = Date.now();
    let caught = null;
    try {
      await channels.callApi(
        { baseUrl: base, auth: { style: 'none' }, query: {}, headers: {} },
        // 下限是 10 秒，这里用一个短的 AbortSignal 代替，验证的是「中止能透出来」
        { path: '/slow', method: 'GET', contentType: 'none', timeoutSec: 10, where: 'poll', signal: AbortSignal.timeout(60) }
      );
    } catch (error) {
      caught = error;
    }
    const took = Date.now() - started;
    assert(caught, '请求没被中止');
    assert(took < 5000, '中止得太慢：' + took + 'ms');
    eq(mock.hits.slow, 1, '请求应该真的发出去了');
  });

  await checkAsync('中止后错误带上了分类（前端能据此显示人话）', async () => {
    let caught = null;
    try {
      await channels.callApi(
        { baseUrl: base, auth: { style: 'none' }, query: {}, headers: {} },
        { path: '/slow', method: 'GET', contentType: 'none', timeoutSec: 10, where: 'poll', signal: AbortSignal.timeout(50) }
      );
    } catch (error) {
      caught = error;
    }
    assert(caught, '没有报错');
    assert(caught.kind, '错误上没有挂分类：' + JSON.stringify(Object.keys(caught)));
    eq(caught.kind, 'NETWORK', '中止应归到网络类');
    eq(caught.retryable, true);
  });

  await checkAsync('平台返回 404 时带出状态码（供上层按场景判含义）', async () => {
    let caught = null;
    try {
      await channels.callApi(
        { baseUrl: base, auth: { style: 'none' }, query: {}, headers: {} },
        { path: '/notfound', method: 'GET', contentType: 'none', timeoutSec: 10, where: 'poll' }
      );
    } catch (error) {
      caught = error;
    }
    assert(caught, '404 没有报错');
    eq(caught.status, 404, '没有带出状态码');
  });

  await checkAsync('轮询时 404 = 任务号失效（NOT_FOUND），不是模型不存在', async () => {
    let caught = null;
    try {
      await channels.callApi(
        { baseUrl: base, auth: { style: 'none' }, query: {}, headers: {} },
        { path: '/notfound', method: 'GET', contentType: 'none', timeoutSec: 10, where: 'poll' }
      );
    } catch (error) {
      caught = error;
    }
    eq(caught.kind, 'NOT_FOUND');
    eq(errorKinds.KINDS.NOT_FOUND.strikes, 3, '单次 404 可能只是抽风，要连击 3 次才判死');
  });

  await checkAsync('拉模型时同样的 404 = 模型不存在（同一个码，含义不同）', async () => {
    let caught = null;
    try {
      await channels.callApi(
        { baseUrl: base, auth: { style: 'none' }, query: {}, headers: {} },
        { path: '/notfound', method: 'GET', contentType: 'none', timeoutSec: 10, where: 'models' }
      );
    } catch (error) {
      caught = error;
    }
    eq(caught.kind, 'NO_MODEL', '拉模型时的 404 该归到 NO_MODEL');
    eq(errorKinds.meta(caught.kind).failFast, true, '模型不存在该立刻判死，不用等');
  });

  await checkAsync('下载素材：连不上会重试（网络抖动不该一次就放弃）', async () => {
    // 指向一个没人监听的端口
    let caught = null;
    const started = Date.now();
    try {
      await assets.fetchBuffer('http://127.0.0.1:1/none.png', {}, 200);
    } catch (error) {
      caught = error;
    }
    assert(caught, '连不上却没报错');
    const took = Date.now() - started;
    // 三次尝试之间各等 800ms / 1600ms，合计应超过 2 秒
    assert(took >= 2000, '看起来没有重试（只用了 ' + took + 'ms）');
    assert(caught.message.indexOf('连不上') >= 0, '错误提示不清：' + caught.message);
  });

  await checkAsync('下载素材：平台明确说 4xx 时不重试（再试也一样）', async () => {
    let caught = null;
    const started = Date.now();
    try {
      await assets.fetchBuffer(base + '/client-err', {}, 5000);
    } catch (error) {
      caught = error;
    }
    assert(caught, '4xx 却没报错');
    const took = Date.now() - started;
    assert(took < 2000, '4xx 还重试了（用了 ' + took + 'ms），纯属白等');
    assert(caught.message.indexOf('400') >= 0, '错误里没有带出状态码：' + caught.message);
  });

  await checkAsync('下载素材：空地址直接报错（不去请求）', async () => {
    let caught = null;
    try {
      await assets.fetchBuffer('', {}, 200);
    } catch (error) {
      caught = error;
    }
    assert(caught, '空地址却没报错');
    assert(caught.message.indexOf('空的') >= 0, '提示不清：' + caught.message);
  });

  mock.server.close();

  console.log('\n[5] 源码级约束：超时值不许被写死或漏掉');

  const channelsSrc = fs.readFileSync(path.join(SERVER, 'channels.js'), 'utf8');

  check('所有 fetch 都带了超时（不许有裸 fetch 一直挂着）', () => {
    const lines = channelsSrc.split('\n');
    const bare = [];
    lines.forEach((line, index) => {
      if (!/fetch\(/.test(line)) return;
      if (/^\s*\/\//.test(line)) return;
      // 调用点是 `fetch(url, init)`，超时挂在 init.signal 上 ——
      // 往上找 40 行，确认这段里出现过 signal / AbortSignal。
      const block = lines.slice(Math.max(0, index - 40), index + 1).join(' ');
      if (block.indexOf('signal') < 0 && block.indexOf('AbortSignal') < 0) bare.push(index + 1);
    });
    assert(bare.length === 0, '这些 fetch 没有超时：第 ' + bare.join(', ') + ' 行');
  });

  check('超时都经过 Math.max 下限保护（配置成 0 也不会变成「立刻超时」）', () => {
    const hits = channelsSrc.match(/Math\.max\(\d+, \(Number\([^)]*\) \|\| \d+\) \* 1000\)/g) || [];
    assert(hits.length >= 2, '带下限保护的超时点太少：' + hits.length);
  });

  check('assets.js 下载也带超时与重试', () => {
    const assetsSrc = fs.readFileSync(path.join(SERVER, 'assets.js'), 'utf8');
    assert(assetsSrc.indexOf('AbortSignal.timeout') >= 0, '下载没有超时');
    assert(assetsSrc.indexOf('const attempts = 3') >= 0, '下载没有重试次数');
    assert(/response\.status >= 400 && response\.status < 500/.test(assetsSrc), '没有区分「4xx 不必重试」');
  });

  check('「等校验超时」这类死等都有截止时间（不许 for(;;) 里没有出口）', () => {
    const at = channelsSrc.indexOf('素材传完了，但等校验超时');
    assert(at >= 0, '找不到等校验的地方');
    const before = channelsSrc.slice(Math.max(0, at - 1200), at);
    assert(before.indexOf('deadline') >= 0, '等校验的循环没有截止时间');
    assert(before.indexOf('Date.now() >= deadline') >= 0, '没有检查是否已到截止时间');
  });

  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
