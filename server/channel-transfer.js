'use strict';

// 接口通道的导入 / 导出。
//
// 为什么这件事要放在服务端做，而不是前端拼一段 JSON 让浏览器下载：
//   1) 密钥只有服务端手里是明文（磁盘上是 DPAPI + AES-GCM 的密文，内存里才解成明文）。
//      前端拿到的 apiKey 是 GET /api/channels 回的那份，能不能用只有服务端敢保证；
//   2) 「导出时带上密钥」是这次的核心诉求。密文（enc:v1:...）拷到另一台电脑是解不开的
//      —— 主密钥被 DPAPI 绑在本机 Windows 账户上。所以必须由服务端解密后导出明文；
//      同时先探一遍「这些密钥本机都解得开吗」，解不开就明确告诉用户哪几个通道不行，
//      而不是导出一个到了对面才发现全是空串的文件；
//   3) 导入时密钥要回到磁盘上继续是密文。服务端保存走 configStore.save -> keybox.encryptChannels，
//      所以只要把明文塞回去再保存一次，落盘就是新机器自己的密文，不会留明文。

const keybox = require('./keybox');
const channels = require('./channels');

// 导出包的格式版本。改字段含义时要升版本，导入端据此决定怎么兼容。
const FORMAT_VERSION = 1;
const FORMAT_KIND = 'canvas-channels';

// 密钥字段清单直接用 keybox 那份，绝不各写一份：
// 两边清单一旦分叉，「不含密钥导出」就会漏字段（磁盘上的密文原样导出去，
// 对面解不开、却还以为里面是明文）。
const SECRET_PATHS = keybox.SECRET_MAPS;

// 按 keybox 认定的「密钥字段」逐个查一遍：有没有明文、能不能解开。
// 只看 apiKey 是不够的：headers / query 里也常有 token（例如 x-api-key、图床的 Authorization）。
function secretAudit(list) {
  const rows = [];
  const problems = [];
  (Array.isArray(list) ? list : []).forEach((channel, index) => {
    if (!channel || typeof channel !== 'object') return;
    const name = String(channel.name || '').trim() || channel.id || '通道 ' + (index + 1);
    const plain = [];
    const sealed = [];
    const broken = [];

    // 自己走一遍和 keybox.eachSecret 相同的字段
    const visit = (holder, field, dotted) => {
      const value = holder && holder[field];
      if (typeof value !== 'string' || !value) return;
      if (keybox.isSealed(value)) {
        const opened = keybox.open(value);
        if (opened === null) {
          broken.push(dotted);
          // 解不开就别带出去：把密文原样塞进导出包，对面既解不开、又看不出「这里没密钥」，
          // 只会拿着一条永远 401 的配置去试。落成空串，配合 problems 明确告诉用户重填。
          holder[field] = '';
        } else {
          sealed.push(dotted);
          // 解密结果塞回副本，导出时用得上（只改副本，不动内存里的 config）
          holder[field] = opened;
        }
      } else if (value.indexOf('{{') >= 0 && value.indexOf('}}') >= 0) {
        // 占位符（{{requestId}} 这类）不是密钥，原样保留
      } else {
        plain.push(dotted);
      }
    };

    visit(channel, 'apiKey', 'apiKey');
    SECRET_PATHS.forEach((dotted) => {
      const holder = mapPath(channel, dotted);
      if (!holder) return;
      Object.keys(holder).forEach((field) => visit(holder, field, dotted + '.' + field));
    });

    rows.push({ id: String(channel.id || ''), name: name, plain: plain.length, sealed: sealed.length, broken: broken });
    if (broken.length) {
      problems.push({
        id: String(channel.id || ''),
        name: name,
        fields: broken,
        message:
          '通道「' + name + '」里有 ' + broken.length + ' 处密钥本机解不开（' + broken.join('、') + '）。' +
          '多半是 data\\secret.key 丢了、或者这份配置是从别的电脑直接拷过来的。' +
          '这个通道可以在「接口通道」里重填一次密钥再导出。',
      });
    }
  });
  return { rows: rows, problems: problems };
}

function mapPath(object, dotted) {
  const parts = String(dotted || '').split('.');
  let node = object;
  for (let i = 0; i < parts.length - 1; i += 1) {
    node = node && node[parts[i]];
    if (!node || typeof node !== 'object') return null;
  }
  const last = parts[parts.length - 1];
  const target = node && node[last];
  return target && typeof target === 'object' && !Array.isArray(target) ? target : null;
}

// 这份原始 JSON 里到底有没有凭据：apiKey 之外，自定义 header / query 里也可能是 token。
// 导入预览要用它标「这条没带密钥，导进来还得手填」，只看 apiKey 会漏掉一堆。
// 占位符（{{requestId}} 这类）不算有密钥。
function hasSecretValue(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const looksReal = (value) => {
    if (typeof value !== 'string' || !value.trim()) return false;
    return !(value.indexOf('{{') >= 0 && value.indexOf('}}') >= 0);
  };
  if (looksReal(raw.apiKey)) return true;
  return SECRET_PATHS.some((dotted) => {
    const holder = mapPath(raw, dotted);
    if (!holder) return false;
    return Object.keys(holder).some((field) => looksReal(holder[field]));
  });
}

function clone(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

// 导出的通道要不要带密钥。withKeys=false 时把密钥字段清空，
// 但保留「哪些字段本来是密钥」这件事——导入端据此知道该填哪些。
function stripSecrets(channel) {
  const copy = clone(channel);
  if (!copy || typeof copy !== 'object') return copy;
  if (typeof copy.apiKey === 'string') copy.apiKey = '';
  SECRET_PATHS.forEach((dotted) => {
    const holder = mapPath(copy, dotted);
    if (!holder) return;
    Object.keys(holder).forEach((field) => {
      const value = holder[field];
      if (typeof value !== 'string' || !value) return;
      // 占位符照旧保留：它不是密钥，而且删了会改变请求行为
      if (value.indexOf('{{') >= 0 && value.indexOf('}}') >= 0) return;
      holder[field] = '';
    });
  });
  return copy;
}

// 组装导出包。
//   channels: 内存里的通道列表（明文密钥）
//   options.withKeys / options.onlyIds
function buildBundle(list, options) {
  const opts = options || {};
  const onlyIds = Array.isArray(opts.onlyIds) && opts.onlyIds.length ? new Set(opts.onlyIds.map(String)) : null;
  const picked = (Array.isArray(list) ? list : []).filter((one) => one && (!onlyIds || onlyIds.has(String(one.id || ''))));

  // 审计要在明文上做（先把密文解开），所以先 clone 一份，避免改动调用方的对象
  const working = picked.map((one) => clone(one));
  const audit = secretAudit(working);

  const withKeys = opts.withKeys !== false;
  const outChannels = working.map((one) => (withKeys ? one : stripSecrets(one)));

  return {
    kind: FORMAT_KIND,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    // 让对面一眼看出这份是「带密钥」还是「不带密钥」，导入时据此提醒
    withKeys: withKeys,
    count: outChannels.length,
    app: 'infinite-canvas',
    channels: outChannels,
    audit: audit.rows,
    problems: audit.problems,
  };
}

// 解析导入包。接受三种写法：
//   1) 我们自己的导出包（{kind, version, channels, ...}）
//   2) 裸数组 [ {...}, ... ]
//   3) 单个通道对象 { id, baseUrl, ... }
function parseBundle(input) {
  let parsed = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) throw new Error('内容是空的');
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error('不是合法的 JSON：' + error.message);
    }
  }
  if (Array.isArray(parsed)) return { channels: parsed, withKeys: null, source: 'array' };
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.channels)) {
      return {
        channels: parsed.channels,
        withKeys: parsed.withKeys === undefined ? null : parsed.withKeys === true,
        exportedAt: String(parsed.exportedAt || ''),
        source: 'bundle',
      };
    }
    if (parsed.id && parsed.baseUrl !== undefined) {
      return { channels: [parsed], withKeys: null, source: 'single' };
    }
  }
  throw new Error('这份内容里没有通道配置');
}

module.exports = {
  FORMAT_KIND,
  FORMAT_VERSION,
  SECRET_PATHS,
  hasSecretValue,
  secretAudit,
  stripSecrets,
  buildBundle,
  parseBundle,
};
