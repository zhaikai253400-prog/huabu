'use strict';

// 平台报错归类。
//
// 各家平台的报错长得都不一样：401 有的写 invalid api key、有的写 unauthorized；
// 402 有的写 insufficient balance、有的写 quota exceeded；404 更麻烦 ——
// 拉模型时是「模型不存在」，轮询任务时是「任务号没用了」，含义完全不同。
// 这个模块把它们归成有限的十来类，用户看到的是「密钥不对」而不是一长串英文原文。
//
// 每类的字段：
//   kind      分类标识。前端按它上色，轮询按它分流
//   title     给用户看的一句话，短到能塞进卡片状态栏
//   advice    该怎么办。放在详情里，不占状态栏
//   retryable 再试一次有没有意义（决定「重试」按钮的语气）
//   failFast  确定没救，轮询时不用再等
//   strikes   允许连续失败几次才判死；0 表示不判死（等满最长等待时间）
//
// 判定顺序按「信号强度」：状态码优先于关键词。状态码已经把话说清楚时就不再
// 看正文，免得正文里偶然出现 key 这种词，把 404 误判成密钥错误。

const KINDS = {
  AUTH: {
    title: '通道密钥不对或已过期',
    advice: '到「通道」设置里检查密钥是不是填错了，或者已经在平台那边作废了',
    retryable: false,
    failFast: true,
    strikes: 1,
  },
  QUOTA: {
    title: '通道额度不足',
    advice: '去平台充值，或者换一个还有额度的通道',
    retryable: false,
    failFast: true,
    strikes: 1,
  },
  NO_MODEL: {
    title: '平台不认这个模型',
    advice: '到通道里重新拉一次模型清单，挑一个确实在列表里的',
    retryable: false,
    failFast: true,
    strikes: 1,
  },
  NOT_FOUND: {
    title: '平台查不到这条任务',
    advice: '任务号可能已经失效了，重新生成一次',
    retryable: false,
    failFast: false,
    // 单次 404 可能只是平台一时抽风，连着 3 次才当任务号真没了
    strikes: 3,
  },
  BAD_REF: {
    title: '参考素材平台不接受',
    advice: '换一张小一点的图，或者转成 jpg / png 再试',
    retryable: false,
    failFast: true,
    strikes: 1,
  },
  BAD_FORMAT: {
    title: '看不懂平台返回的内容',
    advice: '检查通道里「结果地址路径」「状态字段」这些取值配置',
    retryable: false,
    failFast: false,
    // 平台偶尔会返回半截内容，连着 5 次都解析不出来才判死
    strikes: 5,
  },
  // 本地配置缺东西，请求根本没发出去。跟 AUTH / NO_MODEL 这类「平台说不行」
  // 不是一回事：改平台没用，得回来把通道补齐。重试多少次都是一个结果。
  CHANNEL_CONFIG: {
    title: '通道配置不完整',
    advice: '到「接口通道」里把这个通道缺的字段补齐（Base URL、密钥、模型清单、请求路径这些），改完再生成',
    retryable: false,
    failFast: true,
    strikes: 1,
  },
  RATE_LIMIT: {
    title: '平台在限流',
    advice: '稍等一会儿再试，不用改配置',
    retryable: true,
    failFast: false,
    strikes: 0,
  },
  NETWORK: {
    title: '网络没走通',
    advice: '会自动重试；一直这样就去看看网络，或者通道的 Base URL 填得对不对',
    retryable: true,
    failFast: false,
    strikes: 0,
  },
  PLATFORM_QUEUE: {
    title: '平台在排队',
    advice: '继续等就好，这属于正常情况',
    retryable: true,
    failFast: false,
    strikes: 0,
  },
  PLATFORM_TIMEOUT: {
    title: '等太久了还没出结果',
    advice: '稍后重试，或者把分辨率、时长调小一点',
    retryable: true,
    failFast: false,
    strikes: 0,
  },
  UNKNOWN: {
    title: '生成失败',
    advice: '看看下面的平台原文，或者到日志里查这次请求',
    retryable: false,
    failFast: false,
    strikes: 0,
  },
};

// 正文关键词。只在状态码没能说明问题时才查。
// 词组尽量带上下文（用 invalid api key 而不是单个 key），减少误伤。
const WORDS = {
  AUTH: [
    'invalid api key',
    'incorrect api key',
    'api key invalid',
    'api key is invalid',
    'invalid token',
    'authentication failed',
    'authenticationerror',
    'unauthorized',
    '密钥无效',
    '密钥错误',
    '无效的密钥',
    '未授权',
    '签名错误',
  ],
  QUOTA: [
    'insufficient',
    'quota exceeded',
    'exceeded your current quota',
    'insufficient_user_quota',
    'no balance',
    'balance',
    '余额',
    '欠费',
    '额度不足',
    '额度已用尽',
    '配额',
  ],
  RATE_LIMIT: [
    'rate limit',
    'ratelimit',
    'too many requests',
    '请求过于频繁',
    '请求过快',
    '限流',
    '频率限制',
  ],
  NO_MODEL: [
    'model not found',
    'model_not_found',
    'no such model',
    'unknown model',
    'invalid model',
    'model does not exist',
    '模型不存在',
    '不支持的模型',
    '模型不可用',
  ],
  BAD_REF: [
    'image size',
    'image format',
    'unsupported format',
    'unsupported image',
    'file too large',
    'image too large',
    'invalid image',
    '素材',
    '图片过大',
    '图片格式',
    '尺寸超限',
  ],
};

// 连通性问题：没拿到状态码，说明请求根本没走到平台
const NETWORK_WORDS = [
  'fetch failed',
  'econnrefused',
  'econnreset',
  'enotfound',
  'etimedout',
  'eai_again',
  'socket hang up',
  'network',
  'timeout',
  'timed out',
  'aborted',
];

function statusOf(error) {
  const value = Number(error && error.status);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// 正文优先取原始 body（callApi 挂上的），退而求其次用 message
function bodyOf(error) {
  if (!error) return '';
  const body = typeof error.body === 'string' ? error.body : '';
  const message = typeof error.message === 'string' ? error.message : String(error);
  return (body ? body + ' ' + message : message).slice(0, 4000);
}

function byWord(text, kind) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  const list = WORDS[kind] || [];
  for (let i = 0; i < list.length; i += 1) {
    if (lower.indexOf(list[i]) >= 0) return true;
  }
  return false;
}

function looksLikeNetwork(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return true;
  for (let i = 0; i < NETWORK_WORDS.length; i += 1) {
    if (lower.indexOf(NETWORK_WORDS[i]) >= 0) return true;
  }
  return false;
}

function pick(kind) {
  const meta = KINDS[kind] ? kind : 'UNKNOWN';
  return { kind: meta, title: KINDS[meta].title, advice: KINDS[meta].advice,
    retryable: KINDS[meta].retryable, failFast: KINDS[meta].failFast, strikes: KINDS[meta].strikes };
}

// 把一次报错归类。
//
// context.where 是调用场景，用来区分同一个状态码的不同含义：
//   'models'   拉模型清单   → 404 是「模型不存在」
//   'poll'     轮询任务结果 → 404 是「任务号失效了」
//   'submit'   提交生成     → 404 一般也是模型不存在
//   'balance' / 'status' / 'download' / 'api' 等
// context.path 是请求路径，404 时用来兜底判断是不是模型相关的接口。
function classify(error, context) {
  const ctx = context || {};
  const status = statusOf(error);
  const body = bodyOf(error);
  const where = String(ctx.where || '');
  const path = String(ctx.path || '');

  // 没拿到状态码 —— 请求根本没走到平台（拒连、DNS 失败、超时、被中止）
  if (!status) {
    if (byWord(body, 'AUTH')) return pick('AUTH');
    if (byWord(body, 'QUOTA')) return pick('QUOTA');
    if (byWord(body, 'NO_MODEL')) return pick('NO_MODEL');
    if (byWord(body, 'BAD_REF')) return pick('BAD_REF');
    if (looksLikeNetwork(body)) return pick('NETWORK');
    return pick('UNKNOWN');
  }

  // 状态码已经说清楚了的，不再看正文
  if (status === 401 || status === 403) return pick('AUTH');
  if (status === 402) return pick('QUOTA');
  if (status === 429) return pick('RATE_LIMIT');

  if (status === 404) {
    // 轮询时 404 是「这条任务平台不认了」，跟模型无关
    if (where === 'poll') return pick('NOT_FOUND');
    if (where === 'models' || /model/i.test(path)) return pick('NO_MODEL');
    if (byWord(body, 'NO_MODEL')) return pick('NO_MODEL');
    return pick('NOT_FOUND');
  }

  // 状态码没明说，看正文
  if (byWord(body, 'AUTH')) return pick('AUTH');
  if (byWord(body, 'QUOTA')) return pick('QUOTA');
  if (byWord(body, 'RATE_LIMIT')) return pick('RATE_LIMIT');
  if (byWord(body, 'NO_MODEL')) return pick('NO_MODEL');
  if (byWord(body, 'BAD_REF')) return pick('BAD_REF');

  // 5xx 与网关超时都当网络类：会自动重试，不该急着判死
  if (status >= 500 || status === 408 || status === 504) return pick('NETWORK');

  return pick('UNKNOWN');
}

// 取某一类的元信息（不传就返回全部）
function meta(kind) {
  if (!kind) return KINDS;
  return KINDS[kind] || KINDS.UNKNOWN;
}

// 把一个内部错误包装成「能给用户看」的错误：
// message 是短标题（直接进卡片状态栏），detail 是平台原文（留给详情与日志）。
function explain(error, context) {
  const info = (error && error.__info) || classify(error, context);
  const out = new Error(info.title);
  out.kind = info.kind;
  out.advice = info.advice;
  out.retryable = info.retryable;
  out.detail = (error && error.message) || String(error || '');
  out.cause = error;
  out.__info = info;
  return out;
}

// 按分类直接造一个错误（给那些不是从 callApi 出来的场景用：
// 比如轮询等满了最长等待时间、平台一直在排队）
function makeError(kind, detail) {
  const info = meta(kind);
  const out = new Error(info.title);
  out.kind = KINDS[kind] ? kind : 'UNKNOWN';
  out.advice = info.advice;
  out.retryable = info.retryable;
  out.detail = detail || '';
  out.__info = info;
  return out;
}

// 本地配置缺东西（清单 40）。
//
// 跟 makeError 的区别：makeError 的 message 是「通道配置不完整」这种类标题，
// 用户看完还是不知道缺哪个字段。这里 message 直接用具体那句描述
// （「通道「XX」还没填 Base URL」），类标题退到 detail 后面当上下文，
// advice 仍然是「回通道设置里去补」——卡片上既说清缺什么，也点明去哪儿改。
function configError(message, detail) {
  const info = meta('CHANNEL_CONFIG');
  const text = String(message || '').trim() || info.title;
  const out = new Error(text);
  out.kind = 'CHANNEL_CONFIG';
  out.advice = info.advice;
  out.retryable = info.retryable;
  // detail 是卡片正文。默认那句特意说清楚「这不是平台的错」——
  // 否则用户会拿着「没填 Base URL」去问平台客服。
  out.detail = String(detail || '').trim() ||
    '这条是本机通道设置没配全，不是平台返回的错误；补齐后重新生成就行。';
  out.__info = info;
  out.configIssue = true;
  return out;
}

module.exports = {
  KINDS,
  classify,
  meta,
  explain,
  makeError,
  configError,
};
