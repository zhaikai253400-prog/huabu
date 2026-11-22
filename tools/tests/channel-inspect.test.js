'use strict';

// F3 通道配置兼容检查（清单 40）的隔离测试。
//
// 背景：导入的通道 JSON 常常是别人给的、旧版本导出的、或者手写了一半的。
// 以前这些东西能一路存进去，直到用户真点生成才报错，而且报的是平台的错
// （「请求失败了」「模型不存在」），根本看不出是本地配置少填了东西。
//
// 要守的四件事：
//   1. inspectChannel 挑得出「真缺了就跑不起来」的字段，且不误伤合法配置；
//   2. 能跑但有隐患的进 notices，不当成错（不能把「没选默认模型」说成致命）；
//   3. 生成时报的这类错归到 CHANNEL_CONFIG，文案指向「回通道设置补」而不是平台；
//   4. 导入不阻断：接口照旧返回通道列表，体检结果只是搭车的附加字段。
//
// 运行：runtime/node.exe tools/tests/channel-inspect.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');

// 隔离：channels.js 会读 config 目录，不隔离可能碰到真实配置
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-chinspect-'));
require(path.join(__dirname, '_isolate.js'))(box);

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

const channels = require(path.join(ROOT, 'server', 'channels.js'));
const errorKinds = require(path.join(ROOT, 'server', 'error-kinds.js'));
const generateSrc = fs.readFileSync(path.join(ROOT, 'server', 'generate.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const frontSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'channels.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'style.css'), 'utf8');

// 一条健康的通道：什么都不缺，体检该全绿
function healthy() {
  return {
    id: 'ch_ok',
    name: '正常的通道',
    kinds: ['image'],
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    auth: { style: 'bearer' },
    models: { image: ['gpt-image-1'], video: [], audio: [] },
    defaults: { image: 'gpt-image-1', video: '', audio: '' },
    image: { path: '/images/generations', timeoutSec: 300, poll: { enabled: false } },
  };
}

console.log('F3 · 必须齐全的通道不该被挑刺');
check('健康通道 problems 为空', () => {
  const res = channels.inspectChannel(healthy());
  eq(res.problems.length, 0, '不该有问题：' + JSON.stringify(res.problems));
  eq(res.ok, true, 'ok 应为 true');
});

console.log('F3 · 真缺了就跑不起来的，得挑出来');
check('缺 Base URL', () => {
  const bad = healthy();
  bad.baseUrl = '';
  const res = channels.inspectChannel(bad);
  assert(res.problems.some((one) => one.field === 'baseUrl'), '没挑出 Base URL');
  eq(res.ok, false, '缺必填时 ok 必须是 false');
});
check('缺密钥', () => {
  const bad = healthy();
  bad.apiKey = '';
  const res = channels.inspectChannel(bad);
  assert(res.problems.some((one) => one.field === 'apiKey'), '没挑出密钥');
});
check('auth.style=none 时不要求密钥（这类接口本来就不用）', () => {
  const ok = healthy();
  ok.apiKey = '';
  ok.auth = { style: 'none' };
  const res = channels.inspectChannel(ok);
  assert(!res.problems.some((one) => one.field === 'apiKey'), '不该把不用密钥的接口判成缺密钥');
});
check('一个用途都没勾（这个通道永远用不上）', () => {
  const bad = healthy();
  bad.kinds = [];
  const res = channels.inspectChannel(bad);
  assert(res.problems.some((one) => one.field === 'kinds'), '没挑出空的 kinds');
});
check('勾了用途但一个模型都没有', () => {
  const bad = healthy();
  bad.models = { image: [], video: [], audio: [] };
  const res = channels.inspectChannel(bad);
  assert(res.problems.some((one) => one.field === 'models'), '没挑出空模型清单');
});
check('多个用途里只要有一个有模型就不算缺', () => {
  const ok = healthy();
  ok.kinds = ['image', 'video'];
  ok.models = { image: [], video: ['veo-3'], audio: [] };
  ok.video = { path: '/videos', timeoutSec: 600, poll: { enabled: true } };
  const res = channels.inspectChannel(ok);
  assert(!res.problems.some((one) => one.field === 'models'), '有可用模型却报了缺模型');
});
check('勾了用途却清空了该用途的请求路径', () => {
  const bad = healthy();
  bad.kinds = ['image', 'video'];
  bad.models = { image: ['gpt-image-1'], video: ['veo-3'], audio: [] };
  bad.video = { path: '', timeoutSec: 600, poll: { enabled: true } };
  const res = channels.inspectChannel(bad);
  assert(res.problems.some((one) => one.field === 'video.path'), '没挑出空的视频路径');
});
check('baseUrl 只有空格也算没填', () => {
  const bad = healthy();
  bad.baseUrl = '   ';
  const res = channels.inspectChannel(bad);
  assert(res.problems.some((one) => one.field === 'baseUrl'), '空格没被 trim 掉');
});

console.log('F3 · 能跑但值得看一眼的，进 notices 而不是 problems');
check('没选默认模型 → 提示，不判错', () => {
  const one = healthy();
  one.defaults = { image: '', video: '', audio: '' };
  const res = channels.inspectChannel(one);
  eq(res.ok, true, '没选默认模型不该判成跑不起来');
  assert(res.notices.some((item) => item.field === 'defaults.image'), '没给出默认模型的提示');
});
check('默认模型不在清单里 → 提示（会被清掉，用户看到的是「没选」）', () => {
  const one = healthy();
  one.defaults = { image: '早就下架的模型', video: '', audio: '' };
  const res = channels.inspectChannel(one);
  eq(res.ok, true, '不该判死');
  const hit = res.notices.filter((item) => item.field === 'defaults.image');
  assert(hit.length === 1 && hit[0].detail.indexOf('不在模型清单里') >= 0, '没提示默认模型不在清单里');
});
check('视频/音频把轮询关了 → 提示（异步出片的平台会一直没结果）', () => {
  const one = healthy();
  one.kinds = ['video'];
  one.models = { image: [], video: ['veo-3'], audio: [] };
  one.video = { path: '/videos', timeoutSec: 600, poll: { enabled: false } };
  const res = channels.inspectChannel(one);
  eq(res.ok, true, '轮询关不关属于配置风格，不该判死');
  assert(res.notices.some((item) => item.field === 'video.poll'), '没提示视频轮询被关了');
});
check('图片关轮询不提醒（同步接口是常态）', () => {
  const res = channels.inspectChannel(healthy());
  assert(!res.notices.some((item) => item.field === 'image.poll'), '图片也提醒轮询了，太吵');
});
check('超时没设 → 提示已补默认值', () => {
  const one = healthy();
  one.image.timeoutSec = 0;
  const res = channels.inspectChannel(one);
  assert(res.notices.some((item) => item.field === 'image.timeoutSec'), '没提示超时会补默认');
});
check('列表接口开着却没路径 → 提示', () => {
  const one = healthy();
  one.lists = { enabled: true, path: '' };
  const res = channels.inspectChannel(one);
  assert(res.notices.some((item) => item.field === 'lists.path'), '没提示列表路径是空的');
});

console.log('F3 · 一批通道的汇总');
check('inspectChannels 数得清对错', () => {
  const bad = healthy();
  bad.id = 'ch_bad';
  bad.baseUrl = '';
  const res = channels.inspectChannels([healthy(), bad]);
  eq(res.total, 2, '总数');
  eq(res.okCount, 1, '正常数');
  eq(res.problemCount, 1, '问题数');
  eq(res.items.length, 2, '逐条结果');
});
check('传空 / 传垃圾不炸', () => {
  eq(channels.inspectChannels(null).total, 0, 'null 应给空结果');
  const res = channels.inspectChannel(null);
  eq(res.ok, false, '空对象什么都不齐，应该是 false');
  assert(res.problems.length > 0, '空对象该报缺字段');
});

console.log('F3 · 生成时报的错要归到「通道配置」，不是平台类');
check('CHANNEL_CONFIG 这一类存在且说清了怎么办', () => {
  assert(Boolean(errorKinds.KINDS.CHANNEL_CONFIG), 'KINDS 里没有 CHANNEL_CONFIG');
  const meta = errorKinds.meta('CHANNEL_CONFIG');
  assert(meta.title.indexOf('通道') >= 0, '标题要指向通道');
  assert(meta.advice.indexOf('通道') >= 0, '建议要指向通道设置');
  // 跟平台类划清界线：标题不该是「平台」的口吻
  assert(meta.title.indexOf('平台') < 0, '标题混进了「平台」，会让人以为是平台的问题');
});
check('通道配置类不可重试、立刻判死（重试多少次结果都一样）', () => {
  const meta = errorKinds.meta('CHANNEL_CONFIG');
  eq(meta.retryable, false, 'retryable 应为 false');
  eq(meta.failFast, true, 'failFast 应为 true');
  eq(meta.strikes, 1, '一次就够判死');
});
check('configError 的 message 是具体那句（用户才知道缺哪个字段）', () => {
  const err = errorKinds.configError('通道「A」还没填 Base URL');
  eq(err.kind, 'CHANNEL_CONFIG', '分类');
  eq(err.message, '通道「A」还没填 Base URL', 'message 不该被换成泛泛的类标题');
});
check('configError 的 detail 说清「不是平台的错」', () => {
  const err = errorKinds.configError('缺 X');
  assert(err.detail.indexOf('不是平台') >= 0, 'detail 没点明这不是平台返回的错误');
});
check('configError 能覆盖默认 detail（带上平台原文片段）', () => {
  const err = errorKinds.configError('没找到任务号', '返回片段：{"a":1}');
  eq(err.detail, '返回片段：{"a":1}', '自定义 detail 没生效');
});
check('configError 带上 configIssue 标记，前端要能认出来', () => {
  assert(errorKinds.configError('x').configIssue === true, '缺 configIssue 标记');
});

console.log('F3 · 生成链路里该归类的都归了类');
check('缺通道 / 缺 Base URL 用的是 configError', () => {
  const at = generateSrc.indexOf("if (!channel) throw");
  const body = generateSrc.slice(at, at + 400);
  assert(body.indexOf('errorKinds.configError') >= 0, '缺通道没归到通道配置类');
  assert(body.indexOf("还没填 Base URL')") >= 0, 'Base URL 那句不在了');
});
check('取值路径类报错（结果 / 任务号 / 上传）都归了类', () => {
  const at = generateSrc.indexOf('接口返回里没找到素材地址');
  assert(at > 0, '找不到那句报错');
  const line = generateSrc.slice(Math.max(0, at - 120), at);
  assert(line.indexOf('configError') >= 0, '结果取值路径没归类');
  assert(
    generateSrc.indexOf("'这个通道设成了「异步接口」，但接口返回里没找到任务号'") > 0,
    '任务号那句被改得看不出原意了'
  );
  const taskAt = generateSrc.indexOf('但接口返回里没找到任务号');
  const before = generateSrc.slice(Math.max(0, taskAt - 200), taskAt);
  assert(before.indexOf('configError') >= 0, '任务号取值路径没归类');
});
check('请求体模板不是合法 JSON 也归类（改平台没用）', () => {
  const at = generateSrc.indexOf('的请求体模板不是合法 JSON');
  const before = generateSrc.slice(Math.max(0, at - 160), at);
  assert(before.indexOf('configError') >= 0, '模板 JSON 报错没归类');
});
check('channels.js 里的 Base URL / 路径缺失也归了类', () => {
  const chSrc = fs.readFileSync(path.join(ROOT, 'server', 'channels.js'), 'utf8');
  assert(chSrc.indexOf("errorKinds.configError('这个通道还没填 Base URL')") >= 0, 'callApi 的 Base URL 没归类');
  assert(chSrc.indexOf("errorKinds.configError('余额查询的路径还没填')") >= 0, '余额路径没归类');
  assert(chSrc.indexOf("errorKinds.configError('班次查询的路径还没填')") >= 0, '班次路径没归类');
});

console.log('F3 · 导入时不阻断，体检结果搭车返回');
check('保存接口仍然返回 channels（老前端照旧能用）', () => {
  const at = indexSrc.indexOf('接口通道已保存');
  const body = indexSrc.slice(at, at + 600);
  assert(body.indexOf('channels: config.channels') >= 0, '返回里少了 channels，老前端会读不到');
});
check('保存接口额外带回 check 与 freshProblems', () => {
  const at = indexSrc.indexOf('接口通道已保存');
  const body = indexSrc.slice(at, at + 600);
  assert(body.indexOf('check: check') >= 0, '没带回体检结果');
  assert(body.indexOf('freshProblems') >= 0, '没带回「本次新增里有问题的」');
});
check('只把本次新增的算进 freshProblems（避免每次保存都弹旧问题）', () => {
  const at = indexSrc.indexOf('const fresh = check.items.filter');
  assert(at > 0, '找不到 freshProblems 的过滤');
  const body = indexSrc.slice(at, at + 120);
  assert(body.indexOf('!before.has(one.id)') >= 0, '没按「本次之前没有这个 id」过滤');
});

console.log('F3 · 前端把清单摆出来了');
check('导入预览按原始 JSON 体检（服务端用的是 inspectChannelsRaw，不是补全后的）', () => {
  const previewAt = indexSrc.indexOf("pathname === '/api/channels/import/preview'");
  assert(previewAt > 0, '找不到导入预览路由');
  const body = indexSrc.slice(previewAt, previewAt + 1600);
  assert(body.indexOf('inspectChannelsRaw(parsed.channels') >= 0, '预览没有按原始 JSON 体检');
  assert(body.indexOf('inspectChannels(incoming)') < 0, '预览还在拿补全后的数据体检，缺项会被填平查不出来');
  // 规则本身落在 channels.js：这一版必须真能挑出「写了那一节但 path 是空的」
  const rawBad = { id: 'ch_raw', name: '原始', kinds: ['image'], baseUrl: 'https://a.b', apiKey: 'sk-x', image: { path: '' } };
  assert(channels.inspectChannelsRaw([rawBad]).problemCount === 1, '原始体检没挑出空的生成路径');
  // 换 inspectChannel 就会因为默认模板补上 path 而误判为健康 —— 两条路必须分开
  const rawThin = { id: 'ch_thin', name: '简写', kinds: ['image'], baseUrl: 'https://a.b', apiKey: 'sk-x', models: { image: ['m1'] } };
  assert(channels.inspectChannelsRaw([rawThin]).problemCount === 0, '简写（整节没写）不该判成错');
  assert(channels.inspectChannelsRaw([rawThin]).noticeCount === 1, '简写应该提示「已按默认模板补上」');
});
check('体检清单有自己的一行（不在导入面板里，不会被一起收起）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'channels.html'), 'utf8');
  const panelStart = html.indexOf('id="ch-io-panel"');
  const reportAt = html.indexOf('id="ch-io-report"');
  assert(reportAt > 0, '没有体检清单容器');
  // 容器要落在 ch-io-panel 那个 div 结束之后
  const panelDiv = html.slice(panelStart, reportAt);
  assert(panelDiv.indexOf('</div>\n      </div>') >= 0 || panelDiv.indexOf('ch-io-row') >= 0, '布局对不上');
});
check('清单里问题用 ✖、只有提示用 ✔，一眼能分开', () => {
  const at = frontSrc.indexOf('function paintInspectReport');
  const body = frontSrc.slice(at, at + 3000);
  assert(body.indexOf("one.ok ? '✔' : '✖'") >= 0, '没有对错标记');
  assert(body.indexOf("'缺「'") >= 0, '问题行没有「缺 xx」前缀');
});
check('清单只在「刚导入」或「本来就开着」时才弹（自动保存别老弹）', () => {
  const at = frontSrc.indexOf('function paintInspectReport');
  const body = frontSrc.slice(at, at + 900);
  assert(body.indexOf('const wasOpen') >= 0, '没有记录清单原本是否展开');
  assert(body.indexOf('if (!fromImport && !wasOpen) return') >= 0, '没有「非导入且原本关着就不弹」的早退');
});
check('卡片头部角标显示缺了几项必填', () => {
  const at = frontSrc.indexOf('const missing = issueCountOf(channel)');
  assert(at > 0, '卡片头部没读体检结果');
  const body = frontSrc.slice(at, at + 500);
  assert(body.indexOf("'缺 ' + missing + ' 项必填'") >= 0, '没有「缺 N 项必填」角标');
});
check('提醒调用在落库之后（拿到真实 id，角标才对得上）', () => {
  const saveAt = frontSrc.indexOf('await window.api.importChannels(text');
  assert(saveAt > 0, '导入没有走服务端接口');
  const paintAt = frontSrc.indexOf('paintInspectReport({ check: result.check', saveAt);
  assert(paintAt > saveAt, '体检渲染排在导入之前，id 可能对不上');
  // 清单用的是服务端落库后回的那份 check，而不是前端自己算的
  assert(frontSrc.indexOf('const check = inspectBatch(raw)') < 0, '前端还在自己算体检，容易和服务端不一致');
});
check('样式存在', () => {
  assert(cssSrc.indexOf('.ch-io-report') >= 0, '缺 .ch-io-report 样式');
  assert(cssSrc.indexOf('.ch-io-report-row') >= 0, '缺行样式');
  assert(cssSrc.indexOf('.ch-badge.bad') >= 0, '缺角标告警样式');
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52));
process.exit(fail ? 1 : 0);
