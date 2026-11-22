'use strict';

// 接口通道「导入 / 导出」的回归测试。
//
// 这件事最容易出的错不是「JSON 拼不圆」，而是三类静默事故：
//   1) 说好「带密钥导出」，结果带出去的是解不开的密文（对面一片 401，却看不出为什么）；
//   2) 说好「不含密钥导出」，结果漏了一个字段（例如 image.headers 里的 token），
//      文件夹发出去就等于把密钥发出去了；
//   3) 导入时把「同一批通道」导成两份（换电脑同步一次，通道列表翻倍）。
// 所以下面的用例全部围着这三件事，而不是围着函数返回值好不好看。
//
// 运行：runtime/node.exe tools/tests/channel-transfer.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-chtransfer-'));
require(path.join(__dirname, '_isolate.js'))(box);

const keybox = require(path.join(ROOT, 'server', 'keybox.js'));
const channels = require(path.join(ROOT, 'server', 'channels.js'));
const transfer = require(path.join(ROOT, 'server', 'channel-transfer.js'));
const configStore = require(path.join(ROOT, 'server', 'config.js'));

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
  if (got !== want) {
    throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
  }
}
function deep(got, want, msg) {
  eq(JSON.stringify(got), JSON.stringify(want), msg || '深层内容不一致');
}

// 一份「每个能藏密钥的地方都填了值」的通道。
// 把字段铺满是关键：只填 apiKey 的测试永远发现不了「某一路 headers 漏剥离」。
function fullChannel(id, name) {
  const rid = id || 'ch_full';
  return {
    id: rid,
    name: name || '全字段通道',
    enabled: true,
    kinds: ['image', 'video', 'audio'],
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-' + rid,
    auth: { style: 'bearer', header: 'Authorization', prefix: 'Bearer ', query: 'key' },
    headers: { 'X-Global': 'header-secret-1' },
    query: { token: 'query-secret-1' },
    models: { image: ['img-a'], video: ['vid-a'], audio: ['aud-a'] },
    defaults: { image: 'img-a', video: 'vid-a', audio: 'aud-a' },
    image: { path: '/images', headers: { 'X-Image': 'image-secret-1' }, timeoutSec: 300, poll: { enabled: false } },
    video: { path: '/videos', headers: { 'X-Video': 'video-secret-1' }, timeoutSec: 600, poll: { enabled: true } },
    audio: { path: '/audio', headers: { 'X-Audio': 'audio-secret-1' }, timeoutSec: 300, poll: { enabled: true } },
    upload: {
      path: '/upload',
      headers: { 'X-Upload': 'upload-secret-1' },
      audio: { path: '/upload/audio', headers: { 'X-UploadAudio': 'upload-audio-secret-1' } },
      video: { path: '/upload/video', headers: { 'X-UploadVideo': 'upload-video-secret-1' } },
    },
  };
}

// 把所有密钥值摊平成一张表，比较时一眼能看出是哪一处漏了
function secretValues(channel) {
  const out = [];
  const push = (where, value) => {
    if (typeof value === 'string' && value) out.push(where + '=' + value);
  };
  push('apiKey', channel.apiKey);
  transfer.SECRET_PATHS.forEach((dotted) => {
    let node = channel;
    dotted.split('.').forEach((part) => { node = node && node[part]; });
    if (!node || typeof node !== 'object') return;
    Object.keys(node).forEach((field) => push(dotted + '.' + field, node[field]));
  });
  return out.sort();
}

console.log('通道导入 / 导出 · 密钥字段清单');

check('剥离清单和加密清单是同一份（keybox.SECRET_MAPS），不是各写一遍', () => {
  deep(transfer.SECRET_PATHS, keybox.SECRET_MAPS, '导入导出用的清单和落盘加密用的清单分叉了');
  // keybox 那份必须真的管用：剥完以后磁盘上不该再有任何一处密文
  ['headers', 'query', 'image.headers', 'video.headers', 'audio.headers', 'upload.headers',
    'upload.audio.headers', 'upload.video.headers'].forEach((one) => {
    assert(transfer.SECRET_PATHS.indexOf(one) >= 0, '清单里缺 ' + one);
  });
});

console.log('');
console.log('导出 · 带密钥（默认，也是换电脑要用的那条）');

check('带密钥导出给出的是明文，绝不是 enc:v1: 密文', () => {
  const sealed = keybox.encryptChannels([fullChannel()]).list;
  assert(sealed[0].apiKey.indexOf(keybox.PREFIX) === 0, '前提不成立：这份通道的密钥没被加密');
  const bundle = transfer.buildBundle(sealed, { withKeys: true });
  eq(bundle.withKeys, true);
  eq(bundle.count, 1);
  const one = bundle.channels[0];
  eq(one.apiKey, 'sk-ch_full');
  eq(one.headers['X-Global'], 'header-secret-1');
  eq(one.upload.video.headers['X-UploadVideo'], 'upload-video-secret-1');
  assert(JSON.stringify(bundle.channels).indexOf(keybox.PREFIX) < 0, '导出包里还有密文');
  eq(bundle.problems.length, 0, '本机解不开的通道不该出现在干净导出的问题清单里');
});

check('导出全是明文：连 headers / query / 各用途 / 上传都逐个还原', () => {
  const original = fullChannel();
  const bundle = transfer.buildBundle(keybox.encryptChannels([original]).list, { withKeys: true });
  deep(secretValues(bundle.channels[0]), secretValues(original));
});

check('只导出指定的几个通道（ids 过滤），顺序和数量都对', () => {
  const list = [fullChannel('ch_a', 'A'), fullChannel('ch_b', 'B'), fullChannel('ch_c', 'C')];
  const bundle = transfer.buildBundle(list, { withKeys: true, onlyIds: ['ch_a', 'ch_c'] });
  eq(bundle.count, 2);
  deep(bundle.channels.map((one) => one.id), ['ch_a', 'ch_c']);
});

check('导出不会改动内存里的通道（只动副本）', () => {
  const list = [fullChannel()];
  const before = JSON.stringify(list);
  transfer.buildBundle(keybox.encryptChannels(list).list, { withKeys: true });
  eq(JSON.stringify(list), before, '导出把调用方手里的配置改了');
});

console.log('');
console.log('导出 · 不含密钥');

check('不勾「包含密钥」时，所有密钥位置都被清空（一处都不许漏）', () => {
  const bundle = transfer.buildBundle([fullChannel()], { withKeys: false });
  eq(bundle.withKeys, false);
  deep(secretValues(bundle.channels[0]), [], '还有密钥没剥掉：' + secretValues(bundle.channels[0]).join(' / '));
});

check('剥离不影响非密钥配置（地址、模型、请求体都原样）', () => {
  const bundle = transfer.buildBundle([fullChannel()], { withKeys: false });
  const one = bundle.channels[0];
  eq(one.baseUrl, 'https://api.example.com/v1');
  deep(one.models.image, ['img-a']);
  eq(one.video.path, '/videos');
  eq(one.upload.audio.path, '/upload/audio');
});

check('占位符（{{requestId}} 这类）不是密钥，不能被当成值剥掉', () => {
  const one = fullChannel();
  one.headers['X-Trace'] = '{{requestId}}';
  one.query.sig = '{{signature}}';
  const bundle = transfer.buildBundle([one], { withKeys: false });
  eq(bundle.channels[0].headers['X-Trace'], '{{requestId}}');
  eq(bundle.channels[0].query.sig, '{{signature}}');
  // 真密钥仍然被剥掉
  eq(bundle.channels[0].headers['X-Global'], '');
});

console.log('');
console.log('导出 · 密钥解不开时要明说');

check('本机解不开的密文：进 problems，且不假装导出了明文', () => {
  const sealed = keybox.seal('will-be-broken');
  const raw = Buffer.from(sealed.slice(keybox.PREFIX.length), 'base64');
  raw[raw.length - 1] ^= 0xff;
  const broken = keybox.PREFIX + raw.toString('base64');
  const one = fullChannel('ch_bad', '坏密钥通道');
  one.apiKey = broken;
  const bundle = transfer.buildBundle([one], { withKeys: true });
  eq(bundle.problems.length, 1, '没报出解不开的通道');
  eq(bundle.problems[0].id, 'ch_bad');
  assert(bundle.problems[0].message.indexOf('解不开') >= 0, '提示里没说清解不开');
  eq(bundle.channels[0].apiKey, '', '解不开时字段应当是空的（不导出乱码也不导出密文）');
});

check('统计里能看出「几处明文 / 几处解开了密文 / 几处坏了」', () => {
  const sealed = keybox.encryptChannels([fullChannel()]).list;
  const bundle = transfer.buildBundle(sealed, { withKeys: true });
  const row = bundle.audit.find((one) => one.id === 'ch_full');
  assert(row, '审计里没有这条通道');
  eq(row.broken.length, 0);
  assert(row.sealed > 5, '密文处数不对：' + row.sealed);
  eq(row.plain, 0, '加密过的通道不该数出明文');
});

console.log('');
console.log('导入 · 解析三种写法');

check('认自己的导出包', () => {
  const bundle = transfer.buildBundle([fullChannel()], { withKeys: true });
  const parsed = transfer.parseBundle(JSON.stringify(bundle));
  eq(parsed.source, 'bundle');
  eq(parsed.channels.length, 1);
  eq(parsed.withKeys, true);
  eq(parsed.channels[0].apiKey, 'sk-ch_full');
});

check('认裸数组（手写的 / 别处导出的）', () => {
  const parsed = transfer.parseBundle(JSON.stringify([fullChannel('ch_x')]));
  eq(parsed.source, 'array');
  eq(parsed.channels.length, 1);
  eq(parsed.channels[0].id, 'ch_x');
});

check('认单个通道对象', () => {
  const parsed = transfer.parseBundle(JSON.stringify(fullChannel('ch_solo')));
  eq(parsed.source, 'single');
  eq(parsed.channels.length, 1);
});

check('不认识的 JSON / 空内容给出人话报错，不是 TypeError', () => {
  let message = '';
  try { transfer.parseBundle('{"a":1}'); } catch (error) { message = error.message; }
  assert(message.indexOf('没有通道配置') >= 0, '报错文案不对：' + message);
  message = '';
  try { transfer.parseBundle('不是 JSON'); } catch (error) { message = error.message; }
  assert(message.indexOf('JSON') >= 0, '解析失败没提 JSON：' + message);
  message = '';
  try { transfer.parseBundle('   '); } catch (error) { message = error.message; }
  assert(message.length > 0, '空内容应当报错');
});

console.log('');
console.log('导入 · 落盘仍然是密文（对面机器自己重新加密）');

check('导出带明文 → 新机器保存 → 磁盘上只有密文，回读仍是原文', () => {
  const source = [fullChannel('ch_move_a', '搬迁 A'), fullChannel('ch_move_b', '搬迁 B')];
  const bundle = transfer.buildBundle(source, { withKeys: true });
  const text = JSON.stringify(bundle);
  // 模拟「另一台电脑」：解析 → normalize → 保存（保存时会用本机的 secret.key 重新加密）
  const parsed = transfer.parseBundle(text);
  const incoming = channels.normalizeChannels(parsed.channels);
  const cfg = configStore.defaultConfig();
  cfg.channels = incoming;
  configStore.save(cfg);

  const disk = fs.readFileSync(path.join(box, 'config.json'), 'utf8');
  ['sk-ch_move_a', 'sk-ch_move_b', 'header-secret-1', 'query-secret-1',
    'image-secret-1', 'upload-video-secret-1'].forEach((value) => {
    assert(disk.indexOf(value) < 0, '磁盘上还有明文：' + value);
  });
  assert(disk.indexOf(keybox.PREFIX) >= 0, '磁盘上没看到密文');

  const back = configStore.load();
  eq(back.channels.length, 2);
  deep(secretValues(back.channels[0]), secretValues(source[0]));
  deep(secretValues(back.channels[1]), secretValues(source[1]));
});

check('再把新机器这份导出一次，内容与最初完全一致（来回不掉字段）', () => {
  const first = transfer.buildBundle([fullChannel('ch_rt', '往返')], { withKeys: true });
  const incoming = channels.normalizeChannels(transfer.parseBundle(JSON.stringify(first)).channels);
  const cfg = configStore.defaultConfig();
  cfg.channels = incoming;
  configStore.save(cfg);
  const again = transfer.buildBundle(configStore.load().channels, { withKeys: true });
  deep(secretValues(again.channels[0]), secretValues(first.channels[0]));
});

console.log('');
console.log('导入 · 有三种模式，别把同一批通道导成两份');

// 直接对着「导入」这段逻辑验：它现在长在 index.js 的路由里，
// 但规则本身能独立成立，所以在这里复刻一遍走真实 normalize + save，
// 再把 index.js 里的关键分支用源码断言钉住（防止哪天被改回去）。
function importInto(existing, incoming, mode) {
  const cfg = configStore.defaultConfig();
  cfg.channels = existing;
  const next = (cfg.channels || []).slice();
  let added = 0;
  let replaced = 0;
  if (mode === 'replace') {
    cfg.channels = incoming;
    added = incoming.length;
  } else {
    incoming.forEach((one) => {
      if (mode === 'append') {
        const copy = Object.assign({}, one);
        if (!copy.id || next.some((old) => old && String(old.id) === String(copy.id))) {
          copy.id = 'ch_dup_' + Math.random().toString(16).slice(2, 8);
        }
        next.push(copy);
        added += 1;
        return;
      }
      const byId = next.findIndex((old) => old && String(old.id) === String(one.id));
      if (byId >= 0) { next[byId] = one; replaced += 1; return; }
      // 同名也当同一条（跨电脑 id 天然不同），覆盖时保留本地 id —— 卡片里存的是 channelId
      const name = String(one.name || '').trim();
      const countName = (list) => {
        const m = new Map();
        (list || []).forEach((item) => {
          const k = String((item && item.name) || '').trim();
          if (k) m.set(k, (m.get(k) || 0) + 1);
        });
        return m;
      };
      const localNames = countName(next);
      const incomingNames = countName(incoming);
      const byName = name && localNames.get(name) === 1 && incomingNames.get(name) === 1
        ? next.findIndex((old) => old && String(old.name || '').trim() === name)
        : -1;
      if (byName >= 0) {
        next[byName] = Object.assign({}, one, { id: next[byName].id });
        replaced += 1;
        return;
      }
      next.push(one);
      added += 1;
    });
    cfg.channels = next;
  }
  configStore.save(cfg);
  return { added: added, replaced: replaced, total: cfg.channels.length, channels: cfg.channels };
}

check('merge：同一批通道再导一次，是覆盖而不是翻倍', () => {
  const original = channels.normalizeChannels([fullChannel('ch_m', '通道 M')]);
  const first = importInto([], original, 'merge');
  eq(first.total, 1);
  eq(first.added, 1);
  const bundle = transfer.buildBundle(configStore.load().channels, { withKeys: true });
  const again = channels.normalizeChannels(transfer.parseBundle(JSON.stringify(bundle)).channels);
  const second = importInto(configStore.load().channels, again, 'merge');
  eq(second.total, 1, '同一批通道导了两次变成了 ' + second.total + ' 份');
  eq(second.replaced, 1);
  eq(second.added, 0);
});

check('merge：两台电脑各建了一条同名通道（id 不同），导入后仍只有一份，且保本地 id', () => {
  // 这是换电脑最常见的样子：另一台电脑上用户自己重建过同样的通道，
  // id 是那边随机生成的，名字却一模一样。只按 id 合并就会变成两条一样的通道。
  const local = channels.normalizeChannels([fullChannel('ch_local_1', '小裴生图通道')]);
  importInto([], local, 'merge');
  const remote = channels.normalizeChannels([fullChannel('ch_remote_9', '小裴生图通道')]);
  const res = importInto(configStore.load().channels, remote, 'merge');
  eq(res.total, 1, '同名通道导进来变成了 ' + res.total + ' 条');
  eq(res.replaced, 1);
  eq(res.added, 0);
  eq(res.channels[0].id, 'ch_local_1', '覆盖时把本地 id 换掉了，卡片里的 channelId 会对不上');
  eq(res.channels[0].apiKey, 'sk-ch_remote_9', '密钥没换成新导入的那份');
});

check('本地有两条同名通道时，不按名字猜（宁可新增也不覆盖错）', () => {
  const local = channels.normalizeChannels([
    fullChannel('ch_dup_1', '同名通道'),
    fullChannel('ch_dup_2', '同名通道'),
  ]);
  importInto([], local, 'merge');
  const remote = channels.normalizeChannels([fullChannel('ch_remote_dup', '同名通道')]);
  const res = importInto(configStore.load().channels, remote, 'merge');
  eq(res.total, 3, '本地重名时不该按名字合并，应当新增一条');
  eq(res.replaced, 0);
});

check('append：想并排放两套时，撞 id 的会给新 id，不会互相顶掉', () => {
  const original = channels.normalizeChannels([fullChannel('ch_a', '通道 A')]);
  importInto([], original, 'merge');
  const before = configStore.load().channels;
  const res = importInto(before, channels.normalizeChannels([fullChannel('ch_a', '通道 A')]), 'append');
  eq(res.total, 2);
  eq(res.added, 1);
  const ids = res.channels.map((one) => one.id);
  eq(new Set(ids).size, 2, '两条通道 id 撞了，保存时会被顶掉一条');
});

check('replace：整份替换，原来的不留', () => {
  importInto([], channels.normalizeChannels([fullChannel('ch_old', '旧')]), 'merge');
  const res = importInto(configStore.load().channels, channels.normalizeChannels([fullChannel('ch_new', '新')]), 'replace');
  eq(res.total, 1);
  eq(res.channels[0].id, 'ch_new');
});

console.log('');
console.log('导入 · 源码级护栏（防止哪天被改回旧行为）');

check('导出走的是服务端路由，不是前端自己拼 JSON', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert(indexSrc.indexOf("pathname === '/api/channels/export'") > 0, '没有导出路由');
  assert(indexSrc.indexOf('channelTransfer.buildBundle') > 0, '导出路由没走 channelTransfer');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'api.js'), 'utf8');
  assert(apiSrc.indexOf('/api/channels/export') > 0, '前端没接导出接口');
  assert(apiSrc.indexOf('/api/channels/import/preview') > 0, '前端没接导入预览接口');
  assert(apiSrc.indexOf('/api/channels/import') > 0, '前端没接导入接口');
});

check('导入保存后不回明文：服务端必须先落到 configStore.save 再回包', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const at = indexSrc.indexOf("pathname === '/api/channels/import'");
  assert(at > 0, '没有导入路由');
  const body = indexSrc.slice(at, at + 6000);
  const saveAt = body.indexOf('configStore.save(config)');
  const respAt = body.indexOf('sendJson(res, 200');
  assert(saveAt > 0, '导入没有落盘');
  assert(saveAt < respAt, '先回包再保存，前端会读到还没加密的中间态');
});

check('默认「包含密钥」是勾上的（换电脑最常用），并且界面有醒目提醒', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'channels.html'), 'utf8');
  const at = html.indexOf('id="ch-include-keys"');
  assert(at > 0, '没有包含密钥的勾选项');
  assert(/id="ch-include-keys"[^>]*checked/.test(html), '默认没勾「包含密钥」');
  const frontSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'channels.js'), 'utf8');
  assert(frontSrc.indexOf('注意保管') > 0 || frontSrc.indexOf('明文密钥') > 0, '界面没有提醒这份文件里是明文密钥');
});

check('服务端的 merge 真的会按同名匹配，并且保留本地 id', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const at = indexSrc.indexOf("pathname === '/api/channels/import'");
  const body = indexSrc.slice(at, at + 4000);
  assert(body.indexOf("String(old.name || '').trim() === sameName") >= 0, 'merge 没有按同名匹配');
  assert(body.indexOf('Object.assign({}, one, { id: next[byName].id })') >= 0, '同名覆盖时没保留本地 id');
});

check('导入默认是「按 ID 覆盖」，不是「全部追加」', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'channels.html'), 'utf8');
  const at = html.indexOf('id="btn-ch-import-merge"');
  assert(at > 0, '没有「按 ID 覆盖」按钮');
  assert(html.slice(Math.max(0, at - 80), at + 40).indexOf('primary') >= 0, '主按钮不是「按 ID 覆盖」');
});

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
fs.rmSync(box, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
