'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// 平台密钥的静态加密：磁盘上只留密文，内存里仍然是明文。
//
// 为什么是两层：
//   · 主密钥（32 字节随机数）用 Windows DPAPI 保护 —— 它绑定当前 Windows 用户，
//     别的账户 / 拷到别的机器都解不开，不需要用户再记一个密码；
//   · 每个密钥字段用主密钥走 AES-256-GCM 单独加密 —— GCM 带校验，
//     密文被改动一个字节会解密失败，而不是悄悄解出一段乱码发去平台。
//
// 为什么主密钥要单独存一个文件、而不是每次现生成：
//   配置每次保存都要加密，每次启动都要解密；主密钥必须跨重启稳定，
//   否则上次存下的密钥这次就解不开了。
//
// 为什么不把整个 config.json 加密：
//   用户会手改 data\config.json（比如换端口、改素材目录），
//   整文件加密之后「用记事本看一眼」就做不到了；而且配置文件坏了要能一眼看出坏在哪。
//   只加密真正敏感的字段，其余保持明文可读、可手改。

const HELPER_EXE = path.join(__dirname, 'keybox-helper.exe');
const HELPER_SRC = path.join(__dirname, 'keybox.cs');
const KEY_FILE_NAME = 'secret.key';

// 密文前缀。带上版本号，将来换算法时旧密文还能按老规则解。
const PREFIX = 'enc:v1:';
const SECRET_BOX = { version: 1, algo: 'aes-256-gcm', keyWrap: 'dpapi-user' };
const MASTER_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// 这些位置的字符串按「密钥」对待，落盘前加密。
// 只列 HTTP 凭据相关的字段，不动模型清单、提示词这类大块内容 ——
// 加密范围越小，出问题时越容易定位。
const SECRET_MAPS = [
  'headers',
  'query',
  'image.headers',
  'video.headers',
  'audio.headers',
  'upload.headers',
];

let cachedKey = null;
let cachedError = '';
let helperChecked = false;

function setError(message) {
  if (message && cachedError !== message) {
    cachedError = message;
    console.log('[密钥保护] ' + message);
  }
}

function clearError() {
  cachedError = '';
}

// ---------------------------------------------------------------- DPAPI 外壳

function frameworkCsc() {
  const root = process.env.WINDIR || 'C:\\Windows';
  return [
    path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].filter((one) => fs.existsSync(one));
}

// 仓库里带编译好的 keybox-helper.exe；万一它被删了或者换了机器没带上，
// 这里现场用系统自带的 csc 编一份（约 0.5 秒，只发生一次）。
function ensureHelper() {
  if (fs.existsSync(HELPER_EXE)) return HELPER_EXE;
  const sources = frameworkCsc();
  if (!sources.length || !fs.existsSync(HELPER_SRC)) {
    setError('找不到 DPAPI 辅助程序（server\\keybox-helper.exe），密钥暂以明文保存');
    return null;
  }
  const out = path.join(path.dirname(HELPER_EXE), 'keybox-helper.build.exe');
  const run = spawnSync(
    sources[0],
    ['/nologo', '/target:exe', '/optimize+', '/out:' + out, HELPER_SRC],
    { windowsHide: true, encoding: 'utf8', timeout: 60000 }
  );
  if (run.status !== 0 || !fs.existsSync(out)) {
    setError('DPAPI 辅助程序编译失败：' + String(run.stderr || run.stdout || '').trim().slice(0, 200));
    return null;
  }
  try {
    fs.renameSync(out, HELPER_EXE);
  } catch {
    return out;
  }
  return HELPER_EXE;
}

// 只走 stdin/stdout，不落临时文件：密钥内容不会出现在任何目录里。
function dpapi(mode, input, soft) {
  const helper = ensureHelper();
  if (!helper) return null;
  const run = spawnSync(helper, [mode], {
    input: input,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    timeout: 30000,
  });
  if (run.error || run.status !== 0 || !run.stdout || !run.stdout.length) {
    const detail = String(run.stderr || (run.error && run.error.message) || '').trim().slice(0, 300);
    // soft=true：调用方已经准备好后备方案（可移植副本），这里只作诊断，不往
    // 状态里写「解不开」—— 否则 masterKey 好不容易用 portable 解开，
    // 界面上还挂着一条吓人的红字。真正解不开时由 masterKey 统一报错。
    if (soft) {
      console.log('[密钥保护] DPAPI ' + (mode === 'protect' ? '加密' : '解密') + '没成功（改用可移植副本）：' + (detail || '退出码 ' + run.status));
      return null;
    }
    setError('DPAPI ' + (mode === 'protect' ? '加密' : '解密') + '失败：' + (detail || '退出码 ' + run.status));
    return null;
  }
  return Buffer.from(run.stdout);
}

// ---------------------------------------------------------------- 主密钥

function keyPath(dir) {
  return path.join(dir || keyDir(), KEY_FILE_NAME);
}

// 默认跟着 data/ 走：测试用 CANVAS_DATA_DIR 隔离时，密钥文件也一起隔离，
// 不会把真实环境的主密钥带进临时目录，也不会反过来污染真实密钥。
function keyDir() {
  return require('./paths').DATA_DIR;
}

// 只收紧当前用户的权限。Windows 上 Node 的 mode 参数基本无效，
// 所以要真拦住同机别的账户，得靠 icacls。失败不致命（DPAPI 本身已经绑定了用户）。
function restrictAcl(file) {
  try {
    const user = process.env.USERNAME;
    if (!user) return;
    spawnSync('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], {
      windowsHide: true,
      timeout: 10000,
    });
  } catch {
    /* 收紧不了也不影响 DPAPI 的绑定关系 */
  }
}

﻿// ---------------------------------------------------------------- 可移植副本
//
// 为什么要有它（2026-11-19 真实问题）：
//   secret.key 原来只用 DPAPI(CurrentUser) 包了一层。DPAPI 与「这台电脑 + 这个
//   Windows 用户」绑定，所以把程序目录整个搬到另一台电脑（或换个 Windows 账户）
//   之后，那把主密钥就再也解不开了 —— 表现正好是「通道密钥全都用不了，
//   得重新填一遍」。config.json 里的密钥本身是好的，缺的只是「解开它们的主密钥」。
//
// 所以现在 secret.key 里存两份包法：
//   · local    —— DPAPI(CurrentUser)，本机优先用它，安全性最好；
//   · portable —— AES-256-GCM，钥匙由固定常量 + 文件内随机盐经 scrypt 派生，
//                 与机器无关，换电脑 / 换 Windows 用户都能解开。
//
// 代价说清楚（不藏着）：portable 这份本质上是「可计算的混淆」—— 同时拿到
// secret.key 与 config.json 两个文件的人可以还原密钥。但只拿到 config.json 的人
// （例如把配置贴出来求助、贴日志）依然只能看到密文，
// 「配置里不留明文密钥」这条线守住了，同时换电脑不再需要重填密钥。
const PORTABLE_LABEL = 'canvas-keybox-portable-v2';
const PORTABLE_VERSION = 2;
const PORTABLE_SALT_BYTES = 16;

let cachedSource = ''; // 'local' | 'portable'：这次是用哪种方式解开的主密钥

function portableKeyOf(saltB64) {
  // 同一份盐 + 同一个常量必然派生出同一把钥匙，不依赖任何本机信息
  return crypto.scryptSync(PORTABLE_LABEL, Buffer.from(String(saltB64 || ''), 'base64'), MASTER_BYTES);
}

function portableWrap(master, saltB64) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', portableKeyOf(saltB64), iv);
  const body = Buffer.concat([cipher.update(master), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function portableUnwrap(blob, saltB64) {
  let packed;
  try {
    packed = Buffer.from(String(blob || ''), 'base64');
  } catch {
    return null;
  }
  if (packed.length < IV_BYTES + TAG_BYTES + 1) return null;
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = packed.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', portableKeyOf(saltB64), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}

// 读 secret.key，两种格式都认：
//   v1：整个文件就是一串 base64（DPAPI 包好的主密钥）—— 老版本留下的；
//   v2：JSON，同时带 local / portable 两份。
// 读不出来返回 null（当作没有这个文件，绝不猜）。
function readKeyFile(file) {
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    setError('读取 ' + KEY_FILE_NAME + ' 失败：' + error.message);
    return null;
  }
  if (!raw) return null;
  if (raw.charAt(0) === '{') {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      let localBytes = null;
      if (parsed.local) {
        try {
          localBytes = Buffer.from(String(parsed.local), 'base64');
        } catch {
          localBytes = null;
        }
      }
      return {
        version: Number(parsed.version) || 2,
        // 注意：这里给的是**字节**，不是 base64 字符串 —— DPAPI 辅助程序吃的是原始密文，
        // 把 base64 文本喂进去会被它当成「损坏的密文」而解密失败。
        local: localBytes,
        portable: String(parsed.portable || ''),
        salt: String(parsed.salt || ''),
      };
    } catch {
      return null;
    }
  }
  // 老格式：纯 base64，只有 DPAPI 这一份
  let bytes = null;
  try {
    bytes = Buffer.from(raw, 'base64');
  } catch {
    bytes = null;
  }
  return { version: 1, local: bytes, portable: '', salt: '' };
}

// 写 secret.key：能拿 DPAPI 就用它包 local，同时永远写一份 portable。
// 两份都做不成才算失败 —— 只做成 portable 也能用（有些机器上 DPAPI 辅助程序不可用）。
function writeKeyFile(file, master) {
  const wrapped = dpapi('protect', master, true);
  const salt = crypto.randomBytes(PORTABLE_SALT_BYTES).toString('base64');
  const payload = {
    version: 2,
    local: wrapped ? wrapped.toString('base64') : '',
    portable: portableWrap(master, salt),
    salt: salt,
  };
  if (!payload.local && !payload.portable) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  restrictAcl(file);
  return true;
}

// 取主密钥。四种情况要分清楚：
//   1) 有密钥文件、DPAPI 解得开              -> 正常（本机）
//   2) 有密钥文件、DPAPI 解不开但有 portable -> 这台电脑是新来的（同步 / 拷贝过来），
//      用可移植副本解开，并顺手用本机 DPAPI 重包一份
//   3) 没有密钥文件                          -> 首次运行，生成一把
//   4) 有文件、两份都解不开                  -> 绝不能覆盖重生成（覆盖等于把旧密文永久作废）
function masterKey(dir, allowCreate) {
  const file = keyPath(dir);
  if (cachedKey) return cachedKey;

  const stored = readKeyFile(file);
  if (stored) {
    // (1) 先试本机 DPAPI —— 最稳的一条路，解开就不再碰别的
    const raw = stored.local && stored.local.length ? dpapi('unprotect', stored.local, true) : null;
    if (raw && raw.length === MASTER_BYTES) {
      cachedKey = Buffer.from(raw);
      cachedSource = 'local';
      // 老格式（v1）顺手升级成 v2：补上可移植副本，免得下次换电脑又解不开
      if (stored.version < 2 || !stored.portable) {
        try {
          writeKeyFile(file, cachedKey);
        } catch {
          /* 升级失败不影响本次运行，下次启动再试 */
        }
      }
      return cachedKey;
    }

    // (2) DPAPI 不通：多半是从另一台电脑同步 / 拷贝过来的，试可移植副本
    if (stored.portable) {
      const plain = portableUnwrap(stored.portable, stored.salt);
      if (plain && plain.length === MASTER_BYTES) {
        cachedKey = Buffer.from(plain);
        cachedSource = 'portable';
        clearError();
        console.log('[密钥保护] 已用可移植副本解开主密钥（这份数据来自另一台电脑 / 另一个 Windows 用户）');
        // 用本机 DPAPI 重新包一份：以后启动走本机这条快路，portable 继续留着
        try {
          writeKeyFile(file, cachedKey);
        } catch {
          /* 写不回去也能用，只是下次还要走 portable */
        }
        return cachedKey;
      }
    }

    // (4) 两份都解不开
    setError(
      KEY_FILE_NAME + ' 解不开 —— 本机 DPAPI 解不了，里面的可移植副本也解不开；' +
        '原来的平台密钥仍以密文留在配置里，换回原环境即可继续用'
    );
    return null;
  }

  // 解密路径绝不允许顺手生成新钥匙：配置里已经躺着密文了，
  // 这时候换一把新钥匙等于把那些密文永久作废，还让用户看不出发生过什么。
  if (allowCreate === false) {
    setError('找不到 data\\' + KEY_FILE_NAME + ' —— 它和 config.json 是一对的，缺了就打不开已保存的密钥。');
    return null;
  }

  // (3) 文件不存在：真正的新装才会走到这里。
  // 「配置里已有密文、钥匙却丢了」那种危险状态由 encryptChannels 提前拦住，
  // 因为只有它知道这次要写的内容里还有没有解不开的旧密文。
  const fresh = crypto.randomBytes(MASTER_BYTES);
  if (!writeKeyFile(file, fresh)) return null;
  cachedKey = fresh;
  cachedSource = 'local';
  return cachedKey;
}



// ---------------------------------------------------------------- 字段加解密

function isSealed(value) {
  return typeof value === 'string' && value.indexOf(PREFIX) === 0;
}

function seal(plain) {
  const key = masterKey();
  if (!key) return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), body]);
  return PREFIX + packed.toString('base64');
}

function open(sealed) {
  if (!isSealed(sealed)) return sealed;
  const key = masterKey(null, false);
  if (!key) return null;
  let packed;
  try {
    packed = Buffer.from(sealed.slice(PREFIX.length), 'base64');
  } catch {
    return null;
  }
  if (packed.length < IV_BYTES + TAG_BYTES) return null;
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = packed.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch (error) {
    // GCM 校验不过：密文被改过，或者换了主密钥
    setError('配置里的密钥解不开（校验不通过）：' + error.message);
    return null;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function mapPath(object, dotted) {
  const parts = dotted.split('.');
  let node = object;
  for (let i = 0; i < parts.length - 1; i += 1) {
    node = node && node[parts[i]];
    if (!node || typeof node !== 'object') return null;
  }
  const last = parts[parts.length - 1];
  const target = node && node[last];
  return target && typeof target === 'object' && !Array.isArray(target) ? target : null;
}

function eachSecret(config, visit) {
  const list = config && Array.isArray(config.channels) ? config.channels : [];
  list.forEach((channel) => {
    if (!channel || typeof channel !== 'object') return;
    visit(channel, 'apiKey');
    SECRET_MAPS.forEach((dotted) => {
      const map = mapPath(channel, dotted);
      if (!map) return;
      Object.keys(map).forEach((name) => visit(map, name));
    });
  });
}

// 落盘前调用：返回一份「字段已加密」的副本，原对象（内存里的 config）保持明文不动。
// 加密失败时返回 null，由调用方决定怎么办 —— 绝不能悄悄写一份明文进去。
// 落盘前调用：返回一份「字段已加密」的新数组，原数组（内存里的 config）保持明文不动。
// 加密失败时返回 failed>0，由调用方决定怎么办 —— 绝不能悄悄写一份明文进去。
function encryptChannels(list) {
  const out = clone(Array.isArray(list) ? list : []);
  let failed = 0;
  let sealed = 0;

  // 这份配置里已经有密文，就说明「必须用原来那把钥匙」才解得开它们。
  // 此时若 secret.key 丢了，绝不能顺手新建一把 —— 上面那些字段会被原样写回，
  // 新钥匙解不开它们，等于把用户已保存的密钥永久作废，而且当场看不出异常。
  // 所以整次保存按失败处理：正式文件不动，上层会明确告诉用户去恢复 secret.key。
  let locked = 0;
  eachSecret({ channels: out }, (holder, name) => {
    if (isSealed(holder[name])) locked += 1;
  });
  if (locked && !masterKey(null, false)) {
    return { list: out, failed: locked, sealed: 0, locked: locked };
  }
  eachSecret({ channels: out }, (holder, name) => {
    const value = holder[name];
    if (typeof value !== 'string' || !value) return;
    // 已经是密文的不再套一层：解不开主密钥时，原样写回才不会把用户密钥弄丢
    if (isSealed(value)) {
      sealed += 1;
      return;
    }
    // 请求头里允许写占位符（{{requestId}} 这类），提交时才换成真值。
    // 这类值不是密钥，绝不能加密：加密后成了一串 base64，发出去平台只当垃圾头，
    // 而配置界面看着又像「已经填好了」，出问题时极难排查。
    if (value.indexOf('{{') >= 0 && value.indexOf('}}') >= 0) return;
    const result = seal(value);
    if (result) {
      holder[name] = result;
      sealed += 1;
    } else {
      failed += 1;
    }
  });
  return { list: out, failed: failed, sealed: sealed };
}

// 整个配置对象版本，备份文件迁移用
function encryptConfig(config) {
  const copy = clone(config) || {};
  const result = encryptChannels(copy.channels);
  if (result.failed) return null;
  copy.channels = result.list;
  copy.secretBox = SECRET_BOX;
  return copy;
}
// 读盘后调用：把密文字段换回明文。
// 解不开时保留原样并报错 —— 绝不能把 '' 写回去，那等于把用户密钥抹掉。
function decryptChannels(list) {
  const out = clone(Array.isArray(list) ? list : []);
  let locked = 0;
  eachSecret({ channels: out }, (holder, name) => {
    const value = holder[name];
    if (!isSealed(value)) return;
    const plain = open(value);
    if (plain === null) locked += 1;
    else holder[name] = plain;
  });
  return { list: out, locked: locked };
}

function decryptConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const copy = clone(config);
  copy.channels = decryptChannels(copy.channels).list;
  return copy;
}

// 对副本做一次同样的遍历（副本结构与原对象一致）

// 把密钥字段摊成 [路径, 值] 清单，写入后用来逐条比对「存进去的和读回来的是否一致」。
// 只有比对通过才允许替换正式文件，避免出现「写了一半、旧密钥没了」。
function collectSecrets(target) {
  const config = Array.isArray(target) ? { channels: target } : target;
  const out = [];
  const list = config && Array.isArray(config.channels) ? config.channels : [];
  list.forEach((channel, index) => {
    if (!channel || typeof channel !== 'object') return;
    const base = 'channels[' + index + ']';
    if (typeof channel.apiKey === 'string' && channel.apiKey) out.push([base + '.apiKey', channel.apiKey]);
    SECRET_MAPS.forEach((dotted) => {
      const map = mapPath(channel, dotted);
      if (!map) return;
      Object.keys(map).forEach((name) => {
        const value = map[name];
        if (typeof value === 'string' && value) out.push([base + '.' + dotted + '.' + name, value]);
      });
    });
  });
  return out;
}
// 数一遍「磁盘上还是明文」的密钥位置 —— 迁移和告警用。
// 参数可以是整个配置对象，也可以直接传通道数组。
function countPlaintext(target) {
  const config = Array.isArray(target) ? { channels: target } : target;
  let total = 0;
  eachSecret(config, (holder, name) => {
    const value = holder[name];
    if (typeof value === 'string' && value && !isSealed(value)) total += 1;
  });
  return total;
}

function state() {
  return {
    enabled: Boolean(cachedKey) || helperReady(),
    error: cachedError,
    keyFile: KEY_FILE_NAME,
    // 'local'    = 本机 DPAPI 解开（最稳）
    // 'portable' = 从另一台电脑带过来的数据，用可移植副本解开的
    source: cachedSource,
    portable: PORTABLE_VERSION,
  };
}

function helperReady() {
  if (helperChecked) return fs.existsSync(HELPER_EXE);
  helperChecked = true;
  return Boolean(ensureHelper());
}

module.exports = {
  PREFIX,
  KEY_FILE_NAME,
  isSealed,
  seal,
  open,
  encryptConfig,
  decryptConfig,
  encryptChannels,
  decryptChannels,
  countPlaintext,
  collectSecrets,
  masterKey,
  keyPath,
  state,
  portableWrap,
  portableUnwrap,
  PORTABLE_VERSION,
  // 测试用：清掉进程内缓存，模拟「重启」
  _reset: () => {
    cachedKey = null;
    cachedSource = '';
    cachedError = '';
    helperChecked = false;
    clearError();
  },
};