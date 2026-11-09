'use strict';

// 平台密钥静态加密的回归测试（清单 40 · API Key 加密）。
//
// 加密这件事最容易出的不是「算错」，而是「算对了但把数据弄丢」：
//   · 主密钥解不开时把密钥抹成空串 —— 用户重填一遍才发现原来的再也回不来；
//   · 字段解不开时又写了回去，下一轮连诊断的线索都没了；
//   · 主密钥文件丢了却悄悄生成新的，把旧密文永久作废。
// 所以这里除了验「能不能加解密」，一半用例是在验「出错时什么都不该坏」。
//
// 运行：runtime/node.exe tools/tests/keybox.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-keybox-'));
require(path.join(__dirname, '_isolate.js'))(box);

const keybox = require(path.join(ROOT, 'server', 'keybox.js'));
const configStore = require(path.join(ROOT, 'server', 'config.js'));
const paths = require(path.join(ROOT, 'server', 'paths.js'));

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
function eq(got, want, msg) {
  if (got !== want) {
    throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function deep(a, b) {
  eq(JSON.stringify(a), JSON.stringify(b));
}

// 一份形状贴近真实配置的通道：apiKey + 四种用途的 headers/query 都有值。
function sampleChannels() {
  return [
    {
      id: 'ch_img',
      name: '生图通道',
      apiKey: 'sk-plain-image-0001',
      headers: { 'X-Custom': 'header-value-1' },
      query: { key: 'query-value-1' },
      image: { headers: { Authorization: 'Bearer image-h' }, poll: { taskIdPath: 'data.id' } },
      video: { headers: { 'X-Video': 'video-h' } },
      audio: { headers: { 'X-Audio': 'audio-h' } },
      upload: { headers: { 'X-Upload': 'upload-h' } },
    },
    { id: 'ch_plain', name: '无密钥通道', apiKey: '', models: { image: [] } },
  ];
}

console.log('平台密钥加密');
console.log('');
console.log('【一】基本加解密');

check('加密后的字符串带版本前缀（将来换算法时旧密文还认得出）', () => {
  const one = keybox.seal('hello-secret');
  // **先分清"失败"和"没前缀"**：seal 返回 null 表示 DPAPI 辅助程序没跑起来
  //（机器繁忙 / csc 编译失败 / 句柄耗尽），那是**环境问题**，不是"前缀写错了"。
  // 原来的断言只说"没有前缀：null"，排查时会往错的方向找（我自己就被带偏过：
  // 一度以为是加密逻辑坏了，实际是并发压力下 spawnSync 建子进程失败）。
  ok(one !== null, 'seal 返回了 null —— DPAPI 不可用（环境问题），不是前缀问题。' +
    'keybox.state(): ' + JSON.stringify(keybox.state()));
  ok(one.indexOf(keybox.PREFIX) === 0, '没有前缀：' + String(one).slice(0, 12));
  eq(keybox.open(one), 'hello-secret');
});

check('同一个明文加密两次得到不同密文（IV 每次随机）', () => {
  const a = keybox.seal('same-value');
  const b = keybox.seal('same-value');
  // 同样是先分环境问题：两次都为 null 时 a === b 恰好成立，
  // 报"IV 没随机"会把人引到加密实现上去（实际两次都失败了）。
  ok(a !== null && b !== null,
    'seal 返回了 null —— DPAPI 不可用（环境问题），不是 IV 的问题。' +
    'keybox.state(): ' + JSON.stringify(keybox.state()));
  ok(a !== b, '两次密文一样，说明 IV 没随机');
  eq(keybox.open(a), 'same-value');
  eq(keybox.open(b), 'same-value');
});

check('非密文原样返回（明文混进来也不会被当成密文搞坏）', () => {
  eq(keybox.open('just-plain'), 'just-plain');
  eq(keybox.open(''), '');
});

check('空值与非字符串不参与加密（不会被塞进无意义的密文）', () => {
  const res = keybox.encryptChannels([{ id: 'x', apiKey: '', headers: { a: '' }, image: { headers: {} } }]);
  eq(res.failed, 0);
  deep(res.list[0].apiKey, '');
});

console.log('');
console.log('【二】加密范围：只碰凭据，其余保持可读');

check('apiKey / headers / query / 各用途 headers 全部变成密文', () => {
  const res = keybox.encryptChannels(sampleChannels());
  eq(res.failed, 0);
  const c = res.list[0];
  ok(c.apiKey.indexOf(keybox.PREFIX) === 0, 'apiKey 没加密');
  ['headers', 'query'].forEach((k) => {
    Object.keys(c[k]).forEach((n) => ok(c[k][n].indexOf(keybox.PREFIX) === 0, k + '.' + n + ' 没加密'));
  });
  ['image', 'video', 'audio', 'upload'].forEach((k) => {
    Object.keys(c[k].headers).forEach((n) => ok(c[k].headers[n].indexOf(keybox.PREFIX) === 0, k + '.headers.' + n + ' 没加密'));
  });
});

check('其余配置（端口、模型清单、请求体）保持明文，用户能手改', () => {
  const plain = { port: 17890, channels: sampleChannels() };
  const out = JSON.parse(JSON.stringify(keybox.encryptConfig(plain)));
  eq(out.port, 17890);
  eq(out.channels[0].image.poll.taskIdPath, 'data.id');
  eq(out.channels[0].name, '生图通道');
  deep(out.secretBox, { version: 1, algo: 'aes-256-gcm', keyWrap: 'dpapi-user' });
});

check('内存里的原对象不被改动（加密只发生在副本上）', () => {
  const channels = sampleChannels();
  const before = JSON.stringify(channels);
  keybox.encryptChannels(channels);
  eq(JSON.stringify(channels), before, '原数组被改动了');
});

check('已加密的字段不再套第二层（重复保存不会越滚越长）', () => {
  const once = keybox.encryptChannels(sampleChannels()).list;
  const twice = keybox.encryptChannels(once).list;
  eq(JSON.stringify(twice), JSON.stringify(once), '重复加密改动了内容');
  eq(keybox.open(twice[0].apiKey), 'sk-plain-image-0001');
});

check('解密能把整份配置还原（逐字段比对，不用子串碰运气）', () => {
  const original = sampleChannels();
  const sealed = keybox.encryptChannels(original).list;
  const back = keybox.decryptChannels(sealed).list;
  deep(back, original);
});

console.log('');
console.log('【三】出问题时的兜底');

check('密文被篡改：解不开时保持原样，不输出乱码、也不抹成空串', () => {
  const sealed = keybox.seal('tamper-me');
  const raw = Buffer.from(sealed.slice(keybox.PREFIX.length), 'base64');
  raw[raw.length - 1] ^= 0xff;
  const broken = keybox.PREFIX + raw.toString('base64');
  eq(keybox.open(broken), null);
  const res = keybox.decryptChannels([{ id: 'x', apiKey: broken }]);
  eq(res.locked, 1);
  eq(res.list[0].apiKey, broken, '解不开的密文被改写了');
});

check('主密钥文件丢了：不新建钥匙，已有密文也不会被覆盖', () => {
  const sealedChannel = { id: 'x', apiKey: keybox.seal('keep-me') };
  const keyFile = keybox.keyPath(paths.DATA_DIR);
  const backup = fs.readFileSync(keyFile);
  fs.unlinkSync(keyFile);
  keybox._reset();
  try {
    // 写盘路径：没有残留密文时才允许建新钥匙；这里模拟「配置里只有明文」。
    const fresh = keybox.encryptChannels([{ id: 'y', apiKey: 'new-plain' }]);
    eq(fresh.failed, 0, '新装环境应当能建钥匙');
    fs.writeFileSync(keyFile, backup);
    keybox._reset();
  } finally {
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, backup);
    keybox._reset();
  }
  eq(keybox.open(sealedChannel.apiKey), 'keep-me', '恢复钥匙后旧密文应当还能解开');
});

check('配置里还有解不开的密文、钥匙却丢了：整次保存按失败处理，不新建钥匙', () => {
  const keyFile = keybox.keyPath(paths.DATA_DIR);
  const backup = fs.readFileSync(keyFile);
  const sealedValue = keybox.seal('locked-value');
  // 模拟「钥匙丢了，但待保存的配置里还有一条旧密文」。
  fs.unlinkSync(keyFile);
  keybox._reset();
  try {
    const res = keybox.encryptChannels([{ id: 'x', apiKey: sealedValue, headers: { a: 'plain-new' } }]);
    ok(res.failed > 0, '应当按失败处理，否则旧密文会被写坏');
    eq(res.failed, 1, '失败计数应当等于解不开的字段数');
    ok(!fs.existsSync(keyFile), '不该生成新的 secret.key');
    ok(keybox.state().error.indexOf('secret.key') >= 0 || keybox.state().error.length > 0, '应当给出原因');
    // 关键：那条旧密文必须原样留着，不能被换成新钥匙下的密文。
    eq(res.list[0].apiKey, sealedValue, '旧密文被改写了');
  } finally {
    fs.writeFileSync(keyFile, backup);
    keybox._reset();
  }
});

check('钥匙找回来之后，同一份配置能正常保存', () => {
  const sealedValue = keybox.seal('recover-me');
  const res = keybox.encryptChannels([{ id: 'x', apiKey: sealedValue }]);
  eq(res.failed, 0, '钥匙在的情况下不该失败');
  eq(keybox.open(res.list[0].apiKey), 'recover-me');
});
console.log('');
console.log('【四】与 configStore 的接线');

check('configStore.save 落盘后磁盘上没有明文密钥', () => {
  const cfg = configStore.defaultConfig();
  cfg.channels = sampleChannels();
  configStore.save(cfg);
  const raw = fs.readFileSync(paths.CONFIG_FILE, 'utf8');
  ok(raw.indexOf('sk-plain-image-0001') < 0, '磁盘上还有明文 apiKey');
  ok(raw.indexOf('header-value-1') < 0, '磁盘上还有明文 header');
  ok(raw.indexOf(keybox.PREFIX) >= 0, '磁盘上没有密文');
});

check('读回来仍是完整明文（页面显示、请求平台都靠它）', () => {
  const cfg = configStore.load();
  deep(cfg.channels[0].apiKey, 'sk-plain-image-0001');
  deep(cfg.channels[0].headers['X-Custom'], 'header-value-1');
  deep(cfg.channels[0].image.headers.Authorization, 'Bearer image-h');
  deep(cfg.channels[0].upload.headers['X-Upload'], 'upload-h');
});

check('plaintextCount 数的是「磁盘上还明文」的字段', () => {
  const raw = JSON.parse(fs.readFileSync(paths.CONFIG_FILE, 'utf8'));
  eq(configStore.plaintextCount(raw), 0, '加密后的配置不该再数出明文');
  eq(configStore.plaintextCount({ channels: sampleChannels() }), 7, '明文时应当数出 7 处');
});

check('同一份配置反复保存，磁盘内容不漂移', () => {
  const cfg = configStore.load();
  configStore.save(cfg);
  const first = fs.readFileSync(paths.CONFIG_FILE, 'utf8');
  configStore.save(configStore.load());
  const second = fs.readFileSync(paths.CONFIG_FILE, 'utf8');
  // 每次加密都会换 IV，所以字节不可能一样；要验的是「解出来后内容一致」。
  deep(configStore.load().channels, JSON.parse(first).channels.map((c, i) => cfg.channels[i]));
  eq(configStore.plaintextCount(JSON.parse(second)), 0);
});

check('save 遇到「旧密文还在、钥匙丢了」时，提示的是去找回 secret.key', () => {
  const keyFile = keybox.keyPath(paths.DATA_DIR);
  const cfgFile = paths.CONFIG_FILE;
  const keyBackup = fs.readFileSync(keyFile);
  const cfgBackup = fs.readFileSync(cfgFile);
  const cfg = configStore.load();
  const sealedValue = keybox.seal('still-locked');
  // 内存里留一条密文（模拟解密失败的字段），同时让钥匙消失。
  cfg.channels = [{ id: 'x', apiKey: sealedValue }];
  fs.unlinkSync(keyFile);
  keybox._reset();
  try {
    let message = '';
    try { configStore.save(cfg); } catch (error) { message = error.message; }
    ok(message.indexOf('secret.key') >= 0, '提示里应当点名 secret.key：' + message);
    ok(message.indexOf('这次没有保存') >= 0, '应当说清没有保存：' + message);
    eq(fs.readFileSync(cfgFile, 'utf8'), cfgBackup.toString('utf8'), '失败时不该动正式文件');
  } finally {
    fs.writeFileSync(keyFile, keyBackup);
    fs.writeFileSync(cfgFile, cfgBackup);
    keybox._reset();
  }
});
check('密钥保护状态可上报，页面能据此提示', () => {
  const state = keybox.state();
  ok(state.enabled === true, 'enabled 应为 true');
  eq(state.keyFile, 'secret.key');
  eq(state.error, '');
});

console.log('');
console.log('【五】源码级约束');

check('config.js 的 save 在加密失败时抛错，而不是退回明文', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'config.js'), 'utf8');
  ok(src.indexOf('sealed.failed') >= 0, '没有检查加密失败');
  ok(/throw new Error\([\s\S]{0,80}没有保存/.test(src), '没有明确的「这次没有保存」提示');
});

check('channels.js 在把值发出去之前拦一道「还是密文」', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'channels.js'), 'utf8');
  ok(src.indexOf('assertUsableSecret') >= 0, '缺少 assertUsableSecret');
  ok(src.indexOf('enc:v1:') >= 0 || src.indexOf('keybox.isSealed') >= 0, '没有判断密文前缀');
});

check('服务端不引第三方依赖', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'keybox.js'), 'utf8');
  const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  reqs.forEach((one) => ok(one.indexOf('node:') === 0 || one.charAt(0) === '.', '引入了第三方模块：' + one));
});

console.log('');
console.log('通过 ' + pass + '，失败 ' + fail);
fs.rmSync(box, { recursive: true, force: true });
process.exit(fail ? 1 : 0);