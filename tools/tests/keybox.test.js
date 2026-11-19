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
const { spawnSync } = require('node:child_process');

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

﻿﻿﻿console.log('');
console.log('【六】换电脑：同步 / 拷贝到另一台机器后，密钥必须还能用');

// 这是 2026-11-19 用户报的问题：把整个程序目录搬到另一台电脑，
// 每次同步更新之后接口通道的 key 就用不了，得重新输入。
//
// 根因：data\secret.key 原来只用 DPAPI(CurrentUser) 包着，而 DPAPI 绑定
// 「这台电脑 + 这个 Windows 用户」。到了另一台电脑上 DPAPI 解不开，
// 主密钥拿不到 → config.json 里的密钥虽然完好、却再也解不出来。
//
// 现在 secret.key 多存一份与机器无关的可移植副本。下面围着「旧机器那份
// DPAPI 密文解不开」来验 —— 这正是换电脑时实际发生的事。

// 造一份「从另一台电脑拷过来的」secret.key 权限现场：
// 断继承 + 把所有 ACE 清掉（相当于 ACL 里只剩旧机器的 SID，在这台机器上一条都不命中）。
// 实测这种形态有两个后果，必须一起验：
//   ① 读 → EPERM（连可移植副本都轮不到）
//   ② 改名覆盖 → **仍然成功**（覆盖权看的是目录）→ 老逻辑会在这里把原文件静默销毁
function makeOldPcAcl(keyFile) {
  const user = process.env.USERNAME || 'Administrator';
  const acl = (args) => spawnSync('icacls', [keyFile].concat(args), { encoding: 'utf8', windowsHide: true });
  acl(['/inheritance:r']);
  [user, 'Everyone', 'SYSTEM', 'Administrators', 'Users', 'Authenticated Users'].forEach((who) => {
    if (who) acl(['/remove:g', who]);
  });
  return acl;
}

// 每个用例都从零搭一套现场：删掉旧的 config.json / secret.key，
// 再让 configStore.save 现造一份。这样用例之间不会互相污染。
function freshPortableSite() {
  keybox._reset();
  const keyFile = keybox.keyPath(paths.DATA_DIR);
  try { fs.unlinkSync(keyFile); } catch { /* 本来就没有 */ }
  try { fs.unlinkSync(paths.CONFIG_FILE); } catch { /* 本来就没有 */ }

  const cfg = configStore.defaultConfig();
  cfg.channels = [{ id: 'ch_port', name: '可移植验证', apiKey: 'sk-portable-0001', kinds: ['image'] }];
  configStore.save(cfg); // 这一步会生成全新的 secret.key（含 local + portable）
  keybox._reset();
  return JSON.parse(fs.readFileSync(keyFile, 'utf8'));
}

// 模拟「这份 secret.key 是另一台电脑写的」：把本机那份换成别的机器才有钥匙的密文。
// portable 保持原样 —— 它才是换电脑后真正救命的东西。
function pretendFromAnotherPc(parsed) {
  const twisted = Object.assign({}, parsed);
  twisted.local = Buffer.from('dpapi-blob-from-another-pc-' + Date.now()).toString('base64');
  fs.writeFileSync(keybox.keyPath(paths.DATA_DIR), JSON.stringify(twisted, null, 2), 'utf8');
  keybox._reset();
}

// 让 DPAPI 辅助程序必然失败：把真正的 exe 挪开、放一个不是 PE 的占位文件。
function withBrokenDpapi(fn) {
  const helper = path.join(ROOT, 'server', 'keybox-helper.exe');
  const hidden = helper + '.real-' + process.pid;
  let moved = false;
  try {
    fs.renameSync(helper, hidden);
    moved = true;
  } catch { /* 没有就算了，后面写占位文件一样会让它失败 */ }
  try { fs.writeFileSync(helper, 'not-a-real-exe', 'utf8'); } catch { /* 忽略 */ }
  keybox._reset();
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(helper); } catch { /* 忽略 */ }
    if (moved) { try { fs.renameSync(hidden, helper); } catch { /* 忽略 */ } }
    keybox._reset();
  }
}

check('密钥文件里同时有本机份和可移植份（缺一不可：本机快、可移植救命）', () => {
  const parsed = freshPortableSite();
  eq(parsed.version, 2, 'secret.key 应当是新格式');
  ok(parsed.local && parsed.local.length > 40, '缺本机 DPAPI 份');
  ok(parsed.portable && parsed.portable.length > 40, '缺可移植份');
  ok(parsed.salt && parsed.salt.length > 10, '缺盐');
});

check('本机 DPAPI 那份解不开时（就是换电脑的情形），可移植份仍能解出原密钥', () => {
  const parsed = freshPortableSite();
  pretendFromAnotherPc(parsed);
  const cfg = JSON.parse(fs.readFileSync(paths.CONFIG_FILE, 'utf8'));
  const opened = keybox.decryptChannels(cfg.channels);
  eq(opened.locked, 0, '换电脑后仍然出现了解不开的密钥');
  eq(opened.list[0].apiKey, 'sk-portable-0001', '密钥没能解回明文');
  eq(keybox.state().source, 'portable', '应当标明这次是用可移植副本解开的');
  eq(keybox.state().error, '', '用可移植副本成功时不该留下错误');
});

check('换电脑后会用新电脑的 DPAPI 重包一份（下次启动走本机快路）', () => {
  const parsed = freshPortableSite();
  pretendFromAnotherPc(parsed);
  // 第一次：这台电脑用可移植副本解开，并顺便把本机份重写成本机能解的
  keybox.decryptChannels(JSON.parse(fs.readFileSync(paths.CONFIG_FILE, 'utf8')).channels);
  eq(keybox.state().source, 'portable', '第一次应当是走可移植副本');
  // 重启一次：本机份已经重写过，应当回到 local 这条路
  keybox._reset();
  const again = keybox.decryptChannels(JSON.parse(fs.readFileSync(paths.CONFIG_FILE, 'utf8')).channels);
  eq(again.locked, 0);
  eq(keybox.state().source, 'local', '重包之后应当回到本机 DPAPI 这条路');
});

check('新电脑上连 DPAPI 都不可用时，仅凭可移植份也能一直用', () => {
  freshPortableSite();
  withBrokenDpapi(() => {
    const opened = keybox.decryptChannels(JSON.parse(fs.readFileSync(paths.CONFIG_FILE, 'utf8')).channels);
    eq(opened.locked, 0, 'DPAPI 不可用时不该出现解不开的密钥');
    eq(opened.list[0].apiKey, 'sk-portable-0001');
    eq(keybox.state().source, 'portable');
  });
  keybox._reset();
  eq(configStore.load().channels[0].apiKey, 'sk-portable-0001', '测试收尾后密钥应当完好');
});

check('老格式的 secret.key（纯 base64、只有本机份）会被自动升级成新格式', () => {
  const parsed = freshPortableSite();
  const keyFile = keybox.keyPath(paths.DATA_DIR);
  // 退回成老版本格式：整个文件就是一串 DPAPI 密文
  fs.writeFileSync(keyFile, parsed.local, 'utf8');
  keybox._reset();
  const cfg = configStore.load();
  eq(cfg.channels[0].apiKey, 'sk-portable-0001', '升级过程中把密钥弄丢了');
  const after = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  eq(after.version, 2, '没有升级成新格式');
  ok(after.portable, '升级后仍然缺可移植份');
});

check('两份都坏掉时才报错，且密文原样留着（绝不抹掉用户密钥）', () => {
  const parsed = freshPortableSite();
  const twisted = Object.assign({}, parsed);
  twisted.local = Buffer.from('garbage-local').toString('base64');
  twisted.portable = Buffer.from('garbage-portable').toString('base64');
  fs.writeFileSync(keybox.keyPath(paths.DATA_DIR), JSON.stringify(twisted), 'utf8');
  keybox._reset();
  const cfg = JSON.parse(fs.readFileSync(paths.CONFIG_FILE, 'utf8'));
  const opened = keybox.decryptChannels(cfg.channels);
  ok(opened.locked > 0, '两份都坏了却解出了东西？');
  eq(opened.list[0].apiKey, cfg.channels[0].apiKey, '解不开时密文应当原样保留');
  ok(keybox.state().error.length > 0, '应当给出错误说明');
});

check('换电脑时文件权限也挡住了：secret.key 上只有旧机器的 SID，连读都读不了', () => {
  // 这是 2026-11-19 实测到的**第二层**原因，和可移植副本是两件事：
  //   restrictAcl 把继承断掉、只授权「本机的这个用户名」。ACL 里记的是旧机器 SID，
  //   换电脑以后新机器一条都不命中 —— 结果 readFileSync 直接 EPERM，可移植副本轮不到出场。
  // 断言三件事：① 先复现「真的读不了」 ② 自救后能读、密钥解得出 ③ 原密钥没被换掉
  const parsed = freshPortableSite();
  const keyFile = keybox.keyPath(paths.DATA_DIR);
  const before = fs.readFileSync(keyFile, 'utf8');
  keybox._reset();

  const user = process.env.USERNAME || 'Administrator';
  const acl = makeOldPcAcl(keyFile);
  // 连当前用户唯一那一份也给掉（清空 ACE 之后文件上一条都不剩）
  acl(['/remove:g', user]);

  let blocked = false;
  try {
    fs.readFileSync(keyFile, 'utf8');
  } catch (error) {
    blocked = error.code === 'EPERM' || error.code === 'EACCES';
  }
  try {
    ok(blocked, '没复现出「读不了」—— 说明这个用例的前提已经不成立');
    // 自救：不该抛错，应当自己把当前用户加回去并把密钥解出来
    const cfg = configStore.load();
    eq(cfg.channels[0].apiKey, 'sk-portable-0001', '权限自救没能救回密钥');
    ok(fs.existsSync(keyFile), '自救过程中把 secret.key 弄丢了');
    const after = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    eq(after.version, 2);
    ok(after.portable, '重写之后可移植份不见了');
    const opened = keybox.decryptChannels(after.channels || JSON.parse(fs.readFileSync(paths.CONFIG_FILE, 'utf8')).channels);
    eq(opened.locked, 0);
  } finally {
    acl(['/reset']);
    acl(['/grant:r', user + ':F']);
    keybox._reset();
  }
  ok(fs.readFileSync(keyFile, 'utf8').length > 0, '收尾后 secret.key 应当还在');
});

check('readKeyFile 的三分类：没有文件 / 读不出来 / 内容认不出，绝不能混成一个 null', () => {
  // 这是整条修复的地基：老代码把三种都返回 null，masterKey 就无法区分
  // 「首次运行（可以造新钥）」和「文件在那儿只是打不开（绝不能造新钥）」。
  // 直接调这个函数验分类，比在本机艰难地造出「读失败但覆盖能成功」的 ACL 组合可靠得多。
  const parsed = freshPortableSite();
  const keyFile = keybox.keyPath(paths.DATA_DIR);
  const before = fs.readFileSync(keyFile, 'utf8');
  ok(keybox._readKeyFile, 'keybox 没导出 _readKeyFile（测试钩子）');

  const stash = keyFile + '.stash';
  fs.writeFileSync(stash, before, 'utf8');
  // ① 没有文件 → null（这才允许「首次运行」造新钥）
  keybox._reset();
  fs.unlinkSync(keyFile);
  eq(keybox._readKeyFile(keyFile), null, '没有文件时应当返回 null');

  // ② 是目录（读一定失败）→ broken，绝不能是 null
  fs.mkdirSync(keyFile);
  try {
    const got = keybox._readKeyFile(keyFile);
    ok(got && got.broken === true, '读不出来时应当返回 { broken: true }，实际拿到 ' + JSON.stringify(got));
  } finally {
    fs.rmdirSync(keyFile);
  }

  // ③ JSON 解析不了 → broken
  fs.writeFileSync(keyFile, '{ 坏掉的 JSON', 'utf8');
  const badJson = keybox._readKeyFile(keyFile);
  ok(badJson && badJson.broken === true, 'JSON 坏了应当返回 broken，实际 ' + JSON.stringify(badJson));

  // ④ 合法 JSON 但不是对象 → broken
  fs.writeFileSync(keyFile, JSON.stringify([1, 2, 3]), 'utf8');
  const notObject = keybox._readKeyFile(keyFile);
  ok(notObject && notObject.broken === true, '合法 JSON 但不是对象也应当 broken，实际 ' + JSON.stringify(notObject));

  // ⑤ 空文件 → broken（空文件同样不能当成「首次运行」，它有可能是写到一半被打断）
  fs.writeFileSync(keyFile, '', 'utf8');
  const empty = keybox._readKeyFile(keyFile);
  ok(empty && empty.broken === true, '空文件应当 broken，实际 ' + JSON.stringify(empty));

  // ⑥ 正常文件 → 正常读出
  fs.writeFileSync(keyFile, before, 'utf8');
  const good = keybox._readKeyFile(keyFile);
  eq(good && good.version, 2);
  ok(good && good.portable, '正常文件应当读出可移植份');

  fs.unlinkSync(stash);
  keybox._reset();
  eq(configStore.load().channels[0].apiKey, 'sk-portable-0001');
});

check('secret.key 内容坏了 / 读不出来时，绝不新建钥匙覆盖它（否则旧密钥永久作废）', () => {
  // 这条守的是「最坏的一种失败」：文件在、只是打不开。
  // 老逻辑把「读不出来」和「没有文件」当成同一件事（readKeyFile 返回 null），
  // 于是 masterKey 走了「首次运行」那条路，生成新钥匙并覆盖 secret.key ——
  // 原来那份密文从此再也解不开，用户看到的就是「密钥又没了，只能重新填」。
  //
  // 用「内容坏掉的 JSON」来验，而不是「读不出来」：
  //   读失败那条路在本机通常会被「补授权自救」修好（那才是换电脑的正常路径），
  //   真正需要 broken 守卫的是**文件在、内容认不出** —— 这时自救帮不上忙，
  //   一旦当成「没有文件」，就会当场把用户的密钥销毁（实测变异：返回一把新钥
  //   并把原文件换成 version 2 的新内容）。两种形态共同点是「绝不能新建」。
  const parsed = freshPortableSite();
  const keyFile = keybox.keyPath(paths.DATA_DIR);
  const before = fs.readFileSync(keyFile, 'utf8');
  const garbage = '{ 这是坏掉的 JSON\n"local": "xxx"';
  fs.writeFileSync(keyFile, garbage, 'utf8');
  try {
    keybox._reset();
    // 启动路径（允许新建）最危险：它本来就有「造一把新钥」的权力
    let freshResult = null;
    let freshThrew = '';
    try { freshResult = keybox.masterKey(null, true); } catch (error) { freshThrew = error.message; }
    ok(!freshResult, '内容坏了却给出了钥匙（说明它新建了一把，把原文件覆盖了）' + (freshThrew ? '｜' + freshThrew : ''));
    eq(fs.readFileSync(keyFile, 'utf8'), garbage, '原 secret.key 被覆盖了 —— 旧密钥已永久作废');
    const why = keybox.state().error;
    ok(/secret\.key/.test(why), '报错里应当点名 secret.key：' + why);
    ok(/没有生成新钥匙/.test(why) || /不改动它/.test(why), '应当明确说「没生成新钥匙 / 没改动它」：' + why);
  } finally {
    fs.writeFileSync(keyFile, before, 'utf8');
    keybox._reset();
  }
  eq(configStore.load().channels[0].apiKey, 'sk-portable-0001', '收尾后密钥应当完好');
});

check('secret.key 是合法 JSON 但不是对象（例如被改成了数组）也不许被覆盖', () => {
  // 与上一条同一族：文件在、内容认不出。这条专门盯「JSON 解析成功但不是对象」那一支 ——
  // 变异测试发现：只把「JSON 解析失败」改回 null 时能抓到，但这一支被漏掉了。
  const parsed = freshPortableSite();
  const keyFile = keybox.keyPath(paths.DATA_DIR);
  const before = fs.readFileSync(keyFile, 'utf8');
  const weird = JSON.stringify(['这不是密钥文件', 1, 2]);
  fs.writeFileSync(keyFile, weird, 'utf8');
  try {
    keybox._reset();
    const got = keybox.masterKey(null, true);
    ok(!got, '内容不是对象却给出了钥匙（说明它新建了一把，把原文件覆盖了）');
    eq(fs.readFileSync(keyFile, 'utf8'), weird, '原 secret.key 被覆盖了');
    ok(/secret\.key/.test(keybox.state().error), '报错里应当点名 secret.key');
  } finally {
    fs.writeFileSync(keyFile, before, 'utf8');
    keybox._reset();
  }
  eq(configStore.load().channels[0].apiKey, 'sk-portable-0001');
});

check('可移植份的密码学约束：同一把主密钥 + 不同盐 → 不同密文，能各自解开', () => {
  const master = Buffer.alloc(32, 7);
  const saltA = Buffer.alloc(16, 1).toString('base64');
  const saltB = Buffer.alloc(16, 2).toString('base64');
  const a = keybox.portableWrap(master, saltA);
  const b = keybox.portableWrap(master, saltB);
  ok(a !== b, '不同盐却得到相同密文');
  deep(Array.from(keybox.portableUnwrap(a, saltA)), Array.from(master));
  deep(Array.from(keybox.portableUnwrap(b, saltB)), Array.from(master));
  eq(keybox.portableUnwrap(a, saltB), null, '换盐应当解不开');
});

check('可移植份被篡改一个字节就解不开（GCM 带校验，不会解出乱码）', () => {
  const master = Buffer.alloc(32, 3);
  const salt = Buffer.alloc(16, 9).toString('base64');
  const blob = keybox.portableWrap(master, salt);
  const raw = Buffer.from(blob, 'base64');
  raw[raw.length - 1] ^= 0xff;
  eq(keybox.portableUnwrap(raw.toString('base64'), salt), null);
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