'use strict';

// C1 单元测试：平台报错归类。
//
// 这里测的是「拿到一个错误，能不能正确认出它是哪一类」。
// 不联网、不碰真实平台，全部是构造出来的错误对象。

const path = require('node:path');

process.chdir(path.join(__dirname, '..', '..'));
const errorKinds = require(path.join(__dirname, '..', '..', 'server', 'error-kinds'));

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
  if (ok) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failed += 1;
    console.log('  ✗ ' + name + (extra ? ' —— ' + extra : ''));
  }
}

function group(title) {
  console.log('\n[' + title + ']');
}

// 造一个跟 callApi 抛出来的一模一样的错误
function apiError(status, body) {
  const error = new Error('接口返回 ' + status + '：' + (body || ''));
  error.status = status;
  error.body = body || '';
  return error;
}

function kindOf(error, context) {
  return errorKinds.classify(error, context || {}).kind;
}

// ---- 1. 状态码优先 ----
group('1 状态码能说明问题时，不看正文');
check('401 → AUTH', kindOf(apiError(401, 'whatever')) === 'AUTH');
check('403 → AUTH', kindOf(apiError(403, 'forbidden')) === 'AUTH');
// 403 也可能是「这个模型你的账号用不了」，别让用户跑去改密钥
check('403 + forbidden → AUTH', kindOf(apiError(403, 'forbidden')) === 'AUTH');
check(
  '403 + model is not available for the current user → NO_MODEL',
  kindOf(apiError(403, '{"error":"This video model is not available for the current user."}')) === 'NO_MODEL'
);
check('402 → QUOTA', kindOf(apiError(402, 'payment required')) === 'QUOTA');
check('429 → RATE_LIMIT', kindOf(apiError(429, 'slow down')) === 'RATE_LIMIT');
check('500 → NETWORK（会自动重试）', kindOf(apiError(500, 'oops')) === 'NETWORK');
check('502 → NETWORK', kindOf(apiError(502, 'bad gateway')) === 'NETWORK');
check('504 → NETWORK', kindOf(apiError(504, 'gateway timeout')) === 'NETWORK');
// 关键：状态码说清楚了，正文里的关键词不该把结论带偏
check(
  'https://x.com/model/1 返回 401 时仍是 AUTH（不因正文含 model 变成 NO_MODEL）',
  kindOf(apiError(401, 'invalid api key for model gpt-image')) === 'AUTH'
);

// ---- 2. 404 的两种含义 ----
group('2 404 要看场景，含义完全不同');
check(
  '拉模型时 404 → NO_MODEL',
  kindOf(apiError(404, 'not found'), { where: 'models', path: '/v1/models' }) === 'NO_MODEL'
);
check(
  '轮询任务时 404 → NOT_FOUND',
  kindOf(apiError(404, 'not found'), { where: 'poll', path: '/v1/tasks/abc' }) === 'NOT_FOUND'
);
check(
  '提交生成时 404 → 按路径判断（含 model）→ NO_MODEL',
  kindOf(apiError(404, 'no such model'), { where: 'submit', path: '/v1/images/generations' }) === 'NO_MODEL'
);
check(
  '没有场景信息时 404 → NOT_FOUND（保守）',
  kindOf(apiError(404, 'not found'), {}) === 'NOT_FOUND'
);

// ---- 3. 正文关键词 ----
group('3 状态码没说明问题时，看正文');
check('200 带 insufficient balance 不会是 AUTH', kindOf(apiError(400, 'insufficient balance')) === 'QUOTA');
check('400 + invalid api key → AUTH', kindOf(apiError(400, 'invalid api key provided')) === 'AUTH');
check('400 + quota exceeded → QUOTA', kindOf(apiError(400, 'quota exceeded')) === 'QUOTA');
check('400 + rate limit → RATE_LIMIT', kindOf(apiError(400, 'rate limit reached')) === 'RATE_LIMIT');
check('400 + model not found → NO_MODEL', kindOf(apiError(400, 'model not found')) === 'NO_MODEL');
check('400 + unsupported image format → BAD_REF', kindOf(apiError(400, 'unsupported image format')) === 'BAD_REF');
check('400 + 中文「额度不足」→ QUOTA', kindOf(apiError(400, '额度不足，请充值')) === 'QUOTA');
check('400 + 中文「密钥无效」→ AUTH', kindOf(apiError(400, '密钥无效')) === 'AUTH');
check('400 + 中文「不支持的模型」→ NO_MODEL', kindOf(apiError(400, '不支持的模型')) === 'NO_MODEL');

// ---- 4. 没有状态码 = 请求没走到平台 ----
group('4 没有状态码说明请求根本没走出去');
function netError(message) {
  const error = new Error(message);
  return error;
}
check('fetch failed → NETWORK', kindOf(netError('fetch failed')) === 'NETWORK');
check('ECONNREFUSED → NETWORK', kindOf(netError('connect ECONNREFUSED 127.0.0.1:8080')) === 'NETWORK');
check('ENOTFOUND → NETWORK', kindOf(netError('getaddrinfo ENOTFOUND api.xxx.com')) === 'NETWORK');
check('AbortSignal timeout → NETWORK', kindOf(netError('The operation was aborted due to timeout')) === 'NETWORK');
check('空消息 → NETWORK（保守当网络问题）', kindOf(netError('')) === 'NETWORK');
check(
  '无状态码但正文带 invalid api key → AUTH',
  (() => {
    const error = new Error('something odd');
    error.body = '{"error":{"message":"invalid api key"}}';
    return kindOf(error) === 'AUTH';
  })()
);

// ---- 5. 认不出来时不臆测 ----
group('5 认不出来就老实说不知道');
check('奇怪的 418 → UNKNOWN', kindOf(apiError(418, "I'm a teapot")) === 'UNKNOWN');
check('UNKNOWN 的标题不冒充具体结论', errorKinds.meta('UNKNOWN').title.indexOf('密钥') < 0);
check('不认识的 kind 名回落到 UNKNOWN', errorKinds.meta('NOT_A_REAL_KIND').title === errorKinds.meta('UNKNOWN').title);

// ---- 6. 每类的元信息完整 ----
group('6 每一类都得说清「怎么办」');
const allKinds = Object.keys(errorKinds.KINDS);
check('分类数量合理（10~14 类）', allKinds.length >= 10 && allKinds.length <= 14, allKinds.length + ' 类');
let complete = true;
allKinds.forEach((kind) => {
  const meta = errorKinds.KINDS[kind];
  if (!meta.title || !meta.advice) complete = false;
  if (typeof meta.retryable !== 'boolean') complete = false;
  if (typeof meta.failFast !== 'boolean') complete = false;
  if (typeof meta.strikes !== 'number') complete = false;
  // 标题要能塞进卡片状态栏
  if (meta.title.length > 20) {
    console.log('    ！' + kind + ' 的标题偏长（' + meta.title.length + ' 字）：' + meta.title);
    complete = false;
  }
});
check('每一类都有 title / advice / retryable / failFast / strikes，且标题不超过 20 字', complete);

// ---- 7. 分流规则本身要自洽 ----
group('7 哪些该立刻判死，哪些该继续等');
const failFastKinds = allKinds.filter((kind) => errorKinds.KINDS[kind].failFast);
check('AUTH / QUOTA / NO_MODEL / BAD_REF 立刻判死',
  ['AUTH', 'QUOTA', 'NO_MODEL', 'BAD_REF'].every((k) => failFastKinds.indexOf(k) >= 0),
  failFastKinds.join(','));
check('NETWORK 不立刻判死（要等满，避免误报）', errorKinds.KINDS.NETWORK.failFast === false);
check('NETWORK 不记连击（strikes=0）', errorKinds.KINDS.NETWORK.strikes === 0);
check('RATE_LIMIT 不记连击（限流会自己好）', errorKinds.KINDS.RATE_LIMIT.strikes === 0);
check('PLATFORM_TIMEOUT 不记连击', errorKinds.KINDS.PLATFORM_TIMEOUT.strikes === 0);
check('NOT_FOUND 要连击 3 次才判死', errorKinds.KINDS.NOT_FOUND.strikes === 3);
check('BAD_FORMAT 要连击 5 次才判死', errorKinds.KINDS.BAD_FORMAT.strikes === 5);
check('可重试的类别标了 retryable', errorKinds.KINDS.NETWORK.retryable === true && errorKinds.KINDS.PLATFORM_QUEUE.retryable === true);
check('密钥错误标了不可重试（重试也没用）', errorKinds.KINDS.AUTH.retryable === false);

// ---- 8. explain / makeError 两个出口 ----
group('8 包装成给用户看的错误');
const wrapped = errorKinds.explain(apiError(401, 'invalid api key'), { where: 'submit' });
check('explain 把 message 换成中文短标题', wrapped.message === errorKinds.KINDS.AUTH.title, wrapped.message);
check('explain 保留平台原文在 detail 里', wrapped.detail.indexOf('invalid api key') >= 0, wrapped.detail);
check('explain 带上 kind / advice / retryable', wrapped.kind === 'AUTH' && Boolean(wrapped.advice) && wrapped.retryable === false);
check('explain 不丢原始异常（cause）', Boolean(wrapped.cause));

const made = errorKinds.makeError('PLATFORM_TIMEOUT', '等了 30 分钟');
check('makeError 造出的错误带分类', made.kind === 'PLATFORM_TIMEOUT' && made.message === errorKinds.KINDS.PLATFORM_TIMEOUT.title);
check('makeError 把细节留在 detail', made.detail === '等了 30 分钟');
check('makeError 不给 UNKNOWN 冒充结论', errorKinds.makeError('UNKNOWN', 'x').message === errorKinds.KINDS.UNKNOWN.title);

// 重复包装不该叠套（轮询里可能先 classify 再 explain）
const once = errorKinds.explain(apiError(401, 'x'), {});
const twice = errorKinds.explain(once, {});
check('重复 explain 不会把标题套成两层', twice.message === once.message, twice.message);

console.log('\n==============================================');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
console.log('==============================================');
process.exit(failed ? 1 : 0);
