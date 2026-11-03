'use strict';

const crypto = require('node:crypto');
const errorKinds = require('./error-kinds');

const KINDS = ['image', 'video', 'audio'];
// 通道体检时的中文用途名，报错文案里用得上
const KIND_LABEL_CN = { image: '图片', video: '视频', audio: '音频' };

// 每次请求都记一笔（地址、耗时、返回码），密钥一律打码
let logger = null;

function setLogger(fn) {
  logger = typeof fn === 'function' ? fn : null;
}

function note(message) {
  if (!logger) return;
  try {
    logger(message);
  } catch {
    /* 记日志本身出错不影响请求 */
  }
}

function maskUrl(url) {
  return String(url || '').replace(
    /([?&](?:key|api[-_]?key|apikey|token|access[-_]?token|auth)=)[^&#]*/gi,
    '$1***'
  );
}

function tookText(ms) {
  return ms >= 1000 ? (ms / 1000).toFixed(1) + ' 秒' : ms + ' 毫秒';
}

// 每一类接口的默认写法，按 OpenAI 兼容的接口来，接别的平台就改这几项
function defaultApiSpec(kind) {
  if (kind === 'image') {
    return {
      path: '/images/generations',
      method: 'POST',
      contentType: 'json',
      body: '{\n  "model": "{{model}}",\n  "prompt": "{{prompt}}",\n  "n": {{n}},\n  "size": "{{size}}"\n}',
      extra: {},
      headers: {},
      resultUrl: 'data.0.url',
      resultB64: 'data.0.b64_json',
      framesBody: '',
      timeoutSec: 300,
      poll: defaultPoll(),
    };
  }
  if (kind === 'video') {
    return {
      path: '/videos',
      method: 'POST',
      contentType: 'json',
      body: '{\n  "model": "{{model}}",\n  "prompt": "{{prompt}}",\n  "duration": {{duration}},\n  "size": "{{size}}"\n}',
      extra: {},
      headers: {},
      resultUrl: 'data.0.url',
      resultB64: '',
      // 首尾帧任务有的平台字段完全不同，可以另写一份请求体；不填就仍然用上面那份
      framesBody: '',
      timeoutSec: 600,
      poll: defaultPoll('video'),
    };
  }
  return {
    path: '/audio/speech',
    method: 'POST',
    contentType: 'json',
    body: '{\n  "model": "{{model}}",\n  "input": "{{prompt}}"\n}',
    extra: {},
    headers: {},
    resultUrl: 'data.0.url',
    resultB64: '',
    framesBody: '',
    timeoutSec: 300,
    poll: defaultPoll(),
  };
}

function defaultSizeMap() {
  return {
    '1K': { '16:9': '1280x720', '9:16': '720x1280', '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152' },
    '2K': { '16:9': '2048x1152', '9:16': '1152x2048', '1:1': '1440x1440', '4:3': '1536x1152', '3:4': '1152x1536' },
    '4K': { '16:9': '3840x2160', '9:16': '2160x3840', '1:1': '2880x2880', '4:3': '3072x2304', '3:4': '2304x3072' },
  };
}

// 视频按分辨率档位算像素，常用的 480P / 720P / 1080P / 2K / 4K
function defaultVideoSizeMap() {
  return {
    '480p': { '16:9': '854x480', '9:16': '480x854', '1:1': '480x480', '4:3': '640x480', '3:4': '480x640' },
    '720p': { '16:9': '1280x720', '9:16': '720x1280', '1:1': '720x720', '4:3': '960x720', '3:4': '720x960' },
    '1080p': { '16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1080x1080', '4:3': '1440x1080', '3:4': '1080x1440' },
    '2K': { '16:9': '2560x1440', '9:16': '1440x2560', '1:1': '1440x1440', '4:3': '1920x1440', '3:4': '1440x1920' },
    '4K': { '16:9': '3840x2160', '9:16': '2160x3840', '1:1': '2160x2160', '4:3': '2880x2160', '3:4': '2160x2880' },
  };
}

function defaultAuth() {
  return { style: 'bearer', header: 'Authorization', prefix: 'Bearer ', query: 'key' };
}

function defaultFilters() {
  return {
    image: 'image|dall|flux|seedream|jimeng|kolors|qwen-image',
    video: 'video|kling|wan|veo|sora|seedance|hailuo|minimax|runway|pika|vace|ltx',
    audio: 'audio|tts|speech|music|suno|voice|whisper',
  };
}

function defaultLists() {
  return { enabled: true, path: '/models', method: 'GET', resultPath: 'data', itemId: 'id' };
}

// 有的平台能查余额 / 剩余次数，这一块是可选的，不开就什么都不做
function defaultBalance() {
  return {
    enabled: false,
    path: '/balance',
    method: 'GET',
    resultPath: 'credits',
    namePath: 'name',
    unitPath: 'unit',
    unitText: '',
    notePath: 'note',
    tasksPath: 'tasks',
  };
}

function normalizeBalance(input) {
  const base = defaultBalance();
  const source = input && typeof input === 'object' ? input : {};
  return {
    enabled: source.enabled === true,
    path: source.path === undefined ? base.path : str(source.path),
    method: (str(source.method, base.method) || base.method).toUpperCase(),
    resultPath: source.resultPath === undefined ? base.resultPath : str(source.resultPath),
    namePath: source.namePath === undefined ? base.namePath : str(source.namePath),
    unitPath: source.unitPath === undefined ? base.unitPath : str(source.unitPath),
    unitText: source.unitText === undefined ? base.unitText : str(source.unitText),
    notePath: source.notePath === undefined ? base.notePath : str(source.notePath),
    tasksPath: source.tasksPath === undefined ? base.tasksPath : str(source.tasksPath),
  };
}

// 有的平台会在首页显示「下一班什么时候发车」，这一块也是可选的
function defaultRide() {
  return {
    enabled: false,
    path: '/api/ride',
    method: 'GET',
    ridePath: 'ride',
    idPath: 'id',
    statePath: 'state',
    departAtPath: 'departAt',
    onboardPath: 'onboard',
    triggerPath: 'batchTrigger',
    stateText: 'open:开放上车,accepting:即将发车,boarded:已上车待发,running:发车中,done:已发车',
  };
}

function normalizeRide(input) {
  const base = defaultRide();
  const source = input && typeof input === 'object' ? input : {};
  return {
    enabled: source.enabled === true,
    path: source.path === undefined ? base.path : str(source.path),
    method: (str(source.method, base.method) || base.method).toUpperCase(),
    ridePath: source.ridePath === undefined ? base.ridePath : str(source.ridePath),
    idPath: source.idPath === undefined ? base.idPath : str(source.idPath),
    statePath: source.statePath === undefined ? base.statePath : str(source.statePath),
    departAtPath: source.departAtPath === undefined ? base.departAtPath : str(source.departAtPath),
    onboardPath: source.onboardPath === undefined ? base.onboardPath : str(source.onboardPath),
    triggerPath: source.triggerPath === undefined ? base.triggerPath : str(source.triggerPath),
    stateText: source.stateText === undefined ? base.stateText : str(source.stateText),
  };
}

// 异步接口（先返回任务号，再轮询拿结果）的默认写法，图片 / 视频都可能用得上
// 视频类默认等得更久：10 秒问一次，最长 6 小时
function defaultPoll(kind) {
  const isVideo = kind === 'video';
  return {
    enabled: false,
    path: '',
    method: 'GET',
    taskIdPath: 'data.0.task_id',
    statusField: 'data.0.status',
    doneValues: 'success,succeeded,completed,done,finished,ok,ready',
    failValues: 'failed,error,failure,canceled,cancelled,expired,rejected',
    resultUrl: '',
    resultB64: '',
    errorField: 'data.0.error',
    downloadPath: '',
    downloadIdPath: '',
    downloadUrlField: 'downloadUrl',
    intervalSec: isVideo ? 10 : 5,
    maxWaitSec: isVideo ? 21600 : 1800,
  };
}

// 有的平台要先上传素材、拿到素材编号，才能在下单时引用
function defaultUpload() {
  return {
    enabled: false,
    path: '/files/upload',
    method: 'POST',
    contentType: 'form',
    field: 'file',
    extra: {},
    headers: {},
    resultUrl: 'data.url',
    resultId: 'data.id',
    timeoutSec: 300,
  };
}

// 参考素材的收件要求：格式、大小，视频还能限时长（0 = 不限）
function defaultRefLimits() {
  return {
    image: { exts: 'png,jpg,jpeg,webp,gif,bmp', maxMB: 20, maxSec: 0, totalMB: 0, maxCount: -1 },
    video: { exts: 'mp4,mov,webm,mkv', maxMB: 200, maxSec: 0, totalMB: 0, maxCount: -1 },
    audio: { exts: 'mp3,wav,m4a,aac,flac,ogg', maxMB: 50, maxSec: 0, totalMB: 0, maxCount: -1 },
  };
}

// 参考图超限自动压缩：只压“准备提交的副本”，画布和素材目录里的原图永远不动
// maxEdge 是最长边像素，quality 1~5（1 最好、5 最省），alphaFormat 是透明图输出格式
function defaultRefCompress() {
  return { enabled: true, maxEdge: 2048, quality: 2, alphaFormat: 'webp' };
}

function normalizeRefCompress(input) {
  const base = defaultRefCompress();
  const source = input && typeof input === 'object' ? input : {};
  const edges = [1024, 1280, 1600, 2048, 2560, 3072, 3840];
  const edge = Number(source.maxEdge);
  const quality = Number(source.quality);
  return {
    enabled: source.enabled === false ? false : true,
    maxEdge: edges.indexOf(edge) >= 0 ? edge : base.maxEdge,
    quality: quality >= 1 && quality <= 5 ? Math.round(quality) : base.quality,
    alphaFormat: str(source.alphaFormat).toLowerCase() === 'png' ? 'png' : 'webp',
  };
}


// 参考图人脸处理：按素材类型分别记下勾选的模型编号。
// 平台默认关闭，只有勾上的模型在提交时才会带上 faceProcessing: true。
function defaultFaceProcessing() {
  return { image: [], video: [], audio: [] };
}

function normalizeFaceProcessing(input) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  KINDS.forEach(function (kind) {
    const list = Array.isArray(source[kind]) ? source[kind] : [];
    const seen = [];
    list.forEach(function (item) {
      const id = str(item).trim();
      if (id && seen.indexOf(id) < 0) seen.push(id);
    });
    out[kind] = seen;
  });
  return out;
}

// 这次提交要不要开人脸处理：模型必须勾过，而且还在这个通道的模型清单里
function faceProcessingFor(channel, kind, model) {
  const wanted = str(model).trim();
  if (!channel || !wanted) return false;
  const conf = channel.faceProcessing;
  if (!conf || typeof conf !== 'object') return false;
  const picked = Array.isArray(conf[kind]) ? conf[kind] : [];
  if (picked.indexOf(wanted) < 0) return false;
  return modelIds(channel.models && channel.models[kind]).indexOf(wanted) >= 0;
}
function normalizeLimits(input) {
  const base = defaultRefLimits();
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  KINDS.forEach(function (kind) {
    const one = source[kind] && typeof source[kind] === 'object' ? source[kind] : {};
    // maxCount：-1 = 不限，0 = 这个通道完全不收这一类素材，正数 = 最多几个
    const countRaw = one.maxCount === undefined || one.maxCount === null || one.maxCount === '' ? -1 : Number(one.maxCount);
    const maxCount = Number.isFinite(countRaw) ? Math.max(-1, Math.min(99, Math.round(countRaw))) : -1;
    const totalRaw = Number(one.totalMB);
    out[kind] = {
      exts: one.exts === undefined ? base[kind].exts : str(one.exts),
      maxMB: Number(one.maxMB) > 0 ? Math.min(4096, Number(one.maxMB)) : base[kind].maxMB,
      maxSec: Number(one.maxSec) > 0 ? Math.round(Number(one.maxSec)) : 0,
      totalMB: Number.isFinite(totalRaw) && totalRaw > 0 ? Math.min(4096, totalRaw) : 0,
      maxCount: maxCount,
    };
  });
  return out;
}

function normalizeUpload(input) {
  const base = defaultUpload();
  const source = input && typeof input === 'object' ? input : {};
  const contentType =
    ['form', 'base64', 'binary', 'session'].indexOf(str(source.contentType)) >= 0 ? str(source.contentType) : base.contentType;
  return {
    enabled: source.enabled === true,
    path: source.path === undefined ? base.path : str(source.path),
    method: (str(source.method, base.method) || base.method).toUpperCase(),
    contentType: contentType,
    field: source.field === undefined ? base.field : str(source.field),
    extra: strMap(source.extra),
    headers: strMap(source.headers),
    resultUrl: source.resultUrl === undefined ? base.resultUrl : str(source.resultUrl),
    resultId: source.resultId === undefined ? base.resultId : str(source.resultId),
    timeoutSec: Math.max(10, Math.min(3600, Number(source.timeoutSec) || base.timeoutSec)),
  };
}

function defaultModels() {
  return { image: [], video: [], audio: [] };
}

function defaultKindDefaults() {
  return { image: '', video: '', audio: '' };
}

// 新建通道时的空白模板
function defaultChannel() {
  return {
    id: 'ch_' + crypto.randomBytes(4).toString('hex'),
    name: '新通道',
    notes: '',
    enabled: true,
    kinds: ['image'],
    baseUrl: '',
    apiKey: '',
    auth: defaultAuth(),
    headers: {},
    query: {},
    models: defaultModels(),
    defaults: defaultKindDefaults(),
    filters: defaultFilters(),
    lists: defaultLists(),
    balance: defaultBalance(),
    ride: defaultRide(),
    sizeMap: defaultSizeMap(),
    videoSizeMap: defaultVideoSizeMap(),
    upload: defaultUpload(),
    refLimits: defaultRefLimits(),
    refCompress: defaultRefCompress(),
    faceProcessing: defaultFaceProcessing(),
    image: defaultApiSpec('image'),
    video: defaultApiSpec('video'),
    audio: defaultApiSpec('audio'),
  };
}

function str(value, fallback) {
  if (value === null || value === undefined) return fallback === undefined ? '' : fallback;
  return String(value);
}

function strMap(value) {
  const out = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    Object.keys(value).forEach((key) => {
      if (!key) return;
      out[key] = str(value[key]);
    });
  }
  return out;
}

function stringList(value) {
  if (Array.isArray(value)) return value.map((item) => str(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[\r\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeAuth(input) {
  const base = defaultAuth();
  const source = input && typeof input === 'object' ? input : {};
  const style = ['bearer', 'header', 'query', 'none'].indexOf(str(source.style)) >= 0 ? str(source.style) : base.style;
  let prefix = source.prefix === undefined || source.prefix === null ? base.prefix : str(source.prefix);
  if (style === 'bearer' && !prefix) prefix = 'Bearer ';
  if (style === 'header' && source.prefix === undefined) prefix = '';
  return {
    style: style,
    header: str(source.header, base.header) || base.header,
    prefix: prefix,
    query: str(source.query, base.query) || base.query,
  };
}

function normalizeSpec(kind, input) {
  const base = defaultApiSpec(kind);
  const source = input && typeof input === 'object' ? input : {};
  const contentType = ['json', 'form', 'text', 'none'].indexOf(str(source.contentType)) >= 0 ? str(source.contentType) : base.contentType;
  return {
    path: source.path === undefined ? base.path : str(source.path),
    method: (str(source.method, base.method) || base.method).toUpperCase(),
    contentType: contentType,
    body: source.body === undefined ? base.body : str(source.body),
    framesBody: source.framesBody === undefined ? base.framesBody || '' : str(source.framesBody),
    extra: strMap(source.extra),
    headers: strMap(source.headers),
    resultUrl: source.resultUrl === undefined ? base.resultUrl : str(source.resultUrl),
    resultB64: source.resultB64 === undefined ? base.resultB64 : str(source.resultB64),
    timeoutSec: Math.max(10, Math.min(3600, Number(source.timeoutSec) || base.timeoutSec)),
    poll: normalizePoll(source.poll, kind),
  };
}

function normalizePoll(input, kind) {
  const base = defaultPoll(kind);
  const source = input && typeof input === 'object' ? input : {};
  return {
    enabled: source.enabled === true,
    path: source.path === undefined ? base.path : str(source.path),
    method: (str(source.method, base.method) || base.method).toUpperCase(),
    taskIdPath: source.taskIdPath === undefined ? base.taskIdPath : str(source.taskIdPath),
    // 有的平台没有「按任务号查一条」的接口，只能拉整个列表再自己挑：填上列表字段即可
    listField: source.listField === undefined ? '' : str(source.listField),
    listIdField: source.listIdField === undefined ? base.listIdField || 'id' : str(source.listIdField) || 'id',
    statusField: source.statusField === undefined ? base.statusField : str(source.statusField),
    doneValues: source.doneValues === undefined ? base.doneValues : str(source.doneValues),
    failValues: source.failValues === undefined ? base.failValues : str(source.failValues),
    resultUrl: source.resultUrl === undefined ? base.resultUrl : str(source.resultUrl),
    resultB64: source.resultB64 === undefined ? base.resultB64 : str(source.resultB64),
    errorField: source.errorField === undefined ? base.errorField : str(source.errorField),
    downloadPath: source.downloadPath === undefined ? base.downloadPath : str(source.downloadPath),
    downloadIdPath: source.downloadIdPath === undefined ? base.downloadIdPath : str(source.downloadIdPath),
    downloadUrlField:
      source.downloadUrlField === undefined ? base.downloadUrlField : str(source.downloadUrlField) || base.downloadUrlField,
    intervalSec: Math.max(1, Math.min(600, Number(source.intervalSec) || base.intervalSec)),
    maxWaitSec: Math.max(30, Math.min(86400, Number(source.maxWaitSec) || base.maxWaitSec)),
  };
}

// 模型可以写成 “id”，也可以写成 “id | 显示名”，再多一段就是备注：“id | 显示名 | 备注”
// 备注专门用来区分不同中转站里同名的模型，画布的下拉框里会跟在名字后面显示
function parseModelEntry(raw) {
  const text = str(raw).trim();
  if (!text) return { id: '', label: '', note: '' };
  const parts = text
    .split(/\s*[|｜]\s*/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (parts.length >= 2) {
    return { id: parts[0], label: parts[1], note: parts.slice(2).join(' · ') };
  }
  return { id: text, label: text, note: '' };
}

function modelLabel(entry) {
  return parseModelEntry(entry).label;
}

function modelNote(entry) {
  return parseModelEntry(entry).note;
}

function modelId(entry) {
  return parseModelEntry(entry).id;
}

function modelIds(list) {
  return (list || []).map((item) => modelId(item)).filter(Boolean);
}

function normalizeSizeMap(input, base) {
  base = base || defaultSizeMap();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return base;
  const out = {};
  Object.keys(input).forEach((key) => {
    if (!key) return;
    const row = input[key];
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const inner = {};
      Object.keys(row).forEach((ratio) => {
        if (ratio) inner[ratio] = str(row[ratio]);
      });
      out[key] = inner;
    } else {
      out[key] = str(row);
    }
  });
  return Object.keys(out).length ? out : base;
}

// ===== 通道配置兼容检查（清单 40）=====
// 导入的通道 JSON 常常是「别人给的」「从旧版本导出的」「手写了一半的」：
// 少个 Base URL、密钥空着、模型清单和 kinds 对不上、路径还是模板里的占位符……
// 以前这些东西会一路存进去，直到用户真的点生成才报错，而且报的是平台的错
// （「请求失败了」「模型不存在」），完全看不出是本地配置的问题。
//
// 这里在导入时就把问题挑出来，明确告诉用户缺什么——但不阻断导入，
// 让用户先导进来、有空再补，比直接拒绝友好。
//
// 分两档：
//   problems   —— 真缺了就跑不起来（Base URL / 密钥 / 能干活的模型 / 生成路径）
//   notices    —— 能跑但值得看一眼（自动补上的默认值、有模型但没选默认、超时等）
function inspectChannel(channel) {
  const c = channel && typeof channel === 'object' ? channel : {};
  const name = str(c.name).trim() || '（未命名通道）';
  const problems = [];
  const notices = [];
  const kinds = Array.isArray(c.kinds) ? c.kinds.filter((kind) => KINDS.indexOf(kind) >= 0) : [];
  const models = c.models && typeof c.models === 'object' ? c.models : {};

  // ---- 真缺了就跑不起来 ----
  if (!str(c.baseUrl).trim()) {
    problems.push({ field: 'baseUrl', label: 'Base URL', detail: '接口地址没填，这个通道发不出任何请求' });
  }
  // 密钥：没配 auth 或走 query 的也可能合法，所以只在「明确需要密钥却又空着」时报
  const auth = c.auth && typeof c.auth === 'object' ? c.auth : {};
  const authStyle = str(auth.style, 'bearer');
  if (authStyle !== 'none' && !str(c.apiKey).trim()) {
    problems.push({ field: 'apiKey', label: '密钥', detail: '这个通道要密钥才能调，现在是空的' });
  }
  if (!kinds.length) {
    problems.push({ field: 'kinds', label: '支持的用途', detail: '一个都没勾，这个通道不会被任何生成用到' });
  }
  // 勾了用途却没有任何模型：连「用哪个模型」都选不出来
  const usableKinds = kinds.filter((kind) => modelIds(models[kind]).length > 0);
  if (kinds.length && !usableKinds.length) {
    problems.push({
      field: 'models',
      label: '模型清单',
      detail: '勾选的用途下都没有模型，生成时挑不中模型',
    });
  }
  // 生成路径：勾了某个用途却把该用途的请求路径清空了
  kinds.forEach((kind) => {
    const spec = c[kind];
    const path = spec && typeof spec === 'object' ? str(spec.path).trim() : '';
    if (!path) {
      problems.push({
        field: kind + '.path',
        label: KIND_LABEL_CN[kind] + '生成路径',
        detail: '这个通道要用来生成' + KIND_LABEL_CN[kind] + '，但请求路径是空的',
      });
    }
  });

  // ---- 能跑，但值得看一眼 ----
  // 勾了用途、模型清单里也有，却没选默认模型：能跑，但每次都得手选
  kinds.forEach((kind) => {
    const ids = modelIds(models[kind]);
    if (!ids.length) return;
    const want = str((c.defaults || {})[kind]).trim();
    if (!want) {
      notices.push({
        field: 'defaults.' + kind,
        label: KIND_LABEL_CN[kind] + '默认模型',
        detail: '没选默认模型，生成时会用清单里的第一个（' + ids[0] + '）',
      });
    } else if (ids.indexOf(want) < 0) {
      // 默认模型不在清单里：normalizeChannel 会把它清掉，用户看到的会是「没选」
      notices.push({
        field: 'defaults.' + kind,
        label: KIND_LABEL_CN[kind] + '默认模型',
        detail: '设的默认模型（' + want + '）不在模型清单里，已忽略',
      });
    }
  });
  // 轮询：勾了视频 / 音频这类要等结果的用途，却把轮询关了
  kinds.forEach((kind) => {
    const spec = c[kind];
    const poll = spec && typeof spec === 'object' ? spec.poll : null;
    if (kind !== 'image' && poll && poll.enabled === false) {
      notices.push({
        field: kind + '.poll',
        label: KIND_LABEL_CN[kind] + '轮询',
        detail: '轮询是关着的：如果这个平台的' + KIND_LABEL_CN[kind] + '是异步出片，会一直拿不到结果',
      });
    }
    const timeout = spec && typeof spec === 'object' ? Number(spec.timeoutSec) : 0;
    if (!timeout || timeout <= 0) {
      notices.push({
        field: kind + '.timeoutSec',
        label: KIND_LABEL_CN[kind] + '超时',
        detail: '超时没设或设成了 0，已自动补上默认值',
      });
    }
  });
  // 列表接口开着却没写路径
  const lists = c.lists && typeof c.lists === 'object' ? c.lists : {};
  if (lists.enabled !== false && !str(lists.path).trim()) {
    notices.push({ field: 'lists.path', label: '模型列表路径', detail: '列表接口开着但路径是空的，「拉取模型」会失败' });
  }

  return {
    id: str(c.id),
    name: name,
    problems: problems,
    notices: notices,
    ok: problems.length === 0,
  };
}

// 一批通道的体检结果，附带汇总，前端直接照着渲染
function inspectChannels(list) {
  const items = (Array.isArray(list) ? list : []).map((channel) => inspectChannel(channel));
  return {
    items: items,
    total: items.length,
    okCount: items.filter((one) => one.ok).length,
    problemCount: items.filter((one) => !one.ok).length,
    noticeCount: items.filter((one) => one.notices.length > 0).length,
  };
}

function normalizeChannel(input) {
  const base = defaultChannel();
  const source = input && typeof input === 'object' ? input : {};
  const kinds = stringList(source.kinds).filter((kind) => KINDS.indexOf(kind) >= 0);
  const modelsIn = source.models && typeof source.models === 'object' ? source.models : {};
  const models = { image: [], video: [], audio: [] };
  KINDS.forEach((kind) => {
    models[kind] = stringList(modelsIn[kind]);
  });
  const filtersIn = source.filters && typeof source.filters === 'object' ? source.filters : {};
  const listsIn = source.lists && typeof source.lists === 'object' ? source.lists : {};
  const defaultsIn = source.defaults && typeof source.defaults === 'object' ? source.defaults : {};
  const defaults = { image: '', video: '', audio: '' };
  KINDS.forEach((kind) => {
    const wanted = str(defaultsIn[kind]).trim();
    if (wanted && modelIds(models[kind]).indexOf(wanted) >= 0) defaults[kind] = wanted;
  });
  // 勾了人脸处理的模型如果已经从清单里删掉，这里顺手清掉，免得留下永远用不上的记录
  const faceProcessing = normalizeFaceProcessing(source.faceProcessing);
  KINDS.forEach(function (kind) {
    const alive = modelIds(models[kind]);
    faceProcessing[kind] = faceProcessing[kind].filter(function (id) {
      return alive.indexOf(id) >= 0;
    });
  });

  return {
    id: str(source.id) || base.id,
    name: str(source.name).trim() || base.name,
    notes: str(source.notes),
    enabled: source.enabled === false ? false : true,
    kinds: kinds.length ? kinds : ['image'],
    baseUrl: str(source.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: str(source.apiKey).trim(),
    auth: normalizeAuth(source.auth),
    headers: strMap(source.headers),
    query: strMap(source.query),
    models: models,
    defaults: defaults,
    filters: {
      image: filtersIn.image === undefined ? base.filters.image : str(filtersIn.image),
      video: filtersIn.video === undefined ? base.filters.video : str(filtersIn.video),
      audio: filtersIn.audio === undefined ? base.filters.audio : str(filtersIn.audio),
    },
    lists: {
      enabled: listsIn.enabled === false ? false : true,
      path: listsIn.path === undefined ? base.lists.path : str(listsIn.path),
      method: (str(listsIn.method, base.lists.method) || base.lists.method).toUpperCase(),
      resultPath: listsIn.resultPath === undefined ? base.lists.resultPath : str(listsIn.resultPath),
      itemId: listsIn.itemId === undefined ? base.lists.itemId : str(listsIn.itemId),
    },
    balance: normalizeBalance(source.balance),
    ride: normalizeRide(source.ride),
    sizeMap: normalizeSizeMap(source.sizeMap),
    videoSizeMap: normalizeSizeMap(source.videoSizeMap, defaultVideoSizeMap()),
    upload: normalizeUpload(source.upload),
    refLimits: normalizeLimits(source.refLimits),
    refCompress: normalizeRefCompress(source.refCompress),
    faceProcessing: faceProcessing,
    image: normalizeSpec('image', source.image),
    video: normalizeSpec('video', source.video),
    audio: normalizeSpec('audio', source.audio),
  };
}

function normalizeChannels(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => normalizeChannel(item));
}

function activeChannels(config) {
  return ((config && config.channels) || []).filter((channel) => channel && channel.enabled !== false);
}

// 找通道：先用指定 id，其次找能用这个模型的那个，最后退回第一个能干这活的
function findChannel(config, options) {
  const opts = options || {};
  const usable = activeChannels(config).filter((channel) => channel.kinds.indexOf(opts.kind) >= 0);
  if (opts.channelId) {
    const hit = usable.find((channel) => channel.id === opts.channelId);
    if (hit) return hit;
  }
  if (opts.channelName) {
    const hit = usable.find((channel) => channel.name === opts.channelName);
    if (hit) return hit;
  }
  if (opts.model) {
    const hit = usable.find((channel) => modelIds(channel.models[opts.kind]).indexOf(opts.model) >= 0);
    if (hit) return hit;
  }
  return usable[0] || null;
}

function buildUrl(channel, relPath) {
  const base = str(channel.baseUrl).trim().replace(/\/+$/, '');
  let extra = str(relPath).trim();
  if (!extra) return base;
  if (/^https?:\/\//i.test(extra)) return extra;
  if (extra.charAt(0) !== '/') extra = '/' + extra;
  const joined = base + extra;
  const parts = [];
  const query = channel.query && typeof channel.query === 'object' ? channel.query : {};
  Object.keys(query).forEach((key) => {
    if (!key) return;
    const value = query[key];
    if (value === '' || value === null || value === undefined) return;
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(str(value)));
  });
  const auth = channel.auth || {};
  if (auth.style === 'query' && channel.apiKey) {
    parts.push(encodeURIComponent(auth.query || 'key') + '=' + encodeURIComponent(str(channel.apiKey)));
  }
  if (!parts.length) return joined;
  return joined + (joined.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
}

function buildHeaders(channel) {
  const headers = { 'Content-Type': 'application/json' };
  const fixed = channel.headers && typeof channel.headers === 'object' ? channel.headers : {};
  Object.keys(fixed).forEach((key) => {
    if (key) headers[key] = str(fixed[key]);
  });
  const auth = channel.auth || {};
  const key = str(channel.apiKey);
  if (key && auth.style === 'bearer') {
    headers[auth.header || 'Authorization'] = str(auth.prefix) + key;
  } else if (key && auth.style === 'header') {
    headers[auth.header || 'X-API-Key'] = str(auth.prefix) + key;
  }
  return headers;
}

// 把 {{prompt}} 这类占位换成真实内容：数组 / 对象按 JSON 塞，字符串按“已经在引号里”转义
function fillTemplate(template, values) {
  return str(template).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (all, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return all;
    const value = values[key];
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') return JSON.stringify(value);
    return JSON.stringify(String(value)).slice(1, -1);
  });
}

function pickByPath(root, dotted) {
  if (!dotted) return undefined;
  let current = root;
  const parts = str(dotted).split('.');
  for (const rawKey of parts) {
    if (current === null || current === undefined) return undefined;
    const key = rawKey.trim();
    if (!key) continue;
    if (/^\d+$/.test(key)) current = Array.isArray(current) ? current[Number(key)] : undefined;
    else current = current[key];
  }
  return current;
}

function looksLikeBase64(text) {
  const value = str(text).trim();
  return value.length > 256 && !/\s/.test(value) && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 256));
}

// 从接口返回里把素材捞出来：先按配置的路径找，再退回整段文本里找
function extractResult(rawText, json, spec) {
  const direct = pickByPath(json, spec && spec.resultUrl);
  if (typeof direct === 'string' && direct.trim()) {
    const text = direct.trim();
    if (/^data:/i.test(text)) return { dataUrl: text };
    if (/^https?:\/\//i.test(text)) return { url: text };
    if (looksLikeBase64(text)) return { base64: text };
  }
  const inline = pickByPath(json, spec && spec.resultB64);
  if (typeof inline === 'string' && looksLikeBase64(inline)) return { base64: inline.trim() };
  const text = str(rawText);
  const dataHit = text.match(/data:(?:image|video|audio)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/i);
  if (dataHit) return { dataUrl: dataHit[0] };
  const urlHit = text.match(/https?:\/\/[^\s"'<>\\]+?\.(?:png|jpe?g|webp|gif|mp4|webm|mp3|wav)(?:\?[^\s"'<>\\]*)?/i);
  if (urlHit) return { url: urlHit[0] };
  const b64Hit = text.match(/"b64_json"\s*:\s*"([A-Za-z0-9+/=]{256,})"/i);
  if (b64Hit) return { base64: b64Hit[1] };
  return null;
}

// 按正则把拉回来的模型分到图片 / 视频 / 音频，分不走的单独列出来
function splitModels(ids, filters) {
  const out = { image: [], video: [], audio: [], other: [] };
  const rules = filters && typeof filters === 'object' ? filters : {};
  const compiled = {};
  KINDS.forEach((kind) => {
    const pattern = str(rules[kind]).trim();
    if (!pattern) return;
    try {
      compiled[kind] = new RegExp(pattern, 'i');
    } catch {
      compiled[kind] = null;
    }
  });
  (ids || []).forEach((raw) => {
    const id = str(raw).trim();
    if (!id) return;
    for (const kind of KINDS) {
      if (compiled[kind] && compiled[kind].test(id)) {
        if (out[kind].indexOf(id) < 0) out[kind].push(id);
        return;
      }
    }
    if (out.other.indexOf(id) < 0) out.other.push(id);
  });
  return out;
}

// kind 传 'video' 时用视频专用的分辨率对照表
function sizeFor(channel, sizeKey, ratioKey, kind) {
  const useVideo = kind === 'video';
  const fallbackMap = useVideo ? defaultVideoSizeMap() : defaultSizeMap();
  const fromChannel = channel ? (useVideo ? channel.videoSizeMap : channel.sizeMap) : null;
  const map = fromChannel && typeof fromChannel === 'object' ? fromChannel : fallbackMap;
  const bySize = map[str(sizeKey)];
  if (bySize && typeof bySize === 'object') {
    const hit = bySize[str(ratioKey)];
    if (hit) return str(hit);
  }
  if (bySize && typeof bySize === 'string') return bySize;
  // 图表里没有这个档位：视频退回 720p 那一行，图片退回 1K
  const fallbackRow = fallbackMap[useVideo ? '720p' : '1K'];
  if (fallbackRow && typeof fallbackRow === 'object' && fallbackRow[str(ratioKey)]) return str(fallbackRow[str(ratioKey)]);
  return str(sizeKey) || (useVideo ? '1280x720' : '1024x1024');
}

function shortError(text, status, statusText) {
  const body = str(text).replace(/\s+/g, ' ').trim();
  const clipped = body.length > 300 ? body.slice(0, 300) + '…' : body;
  return '接口返回 ' + status + (statusText ? ' ' + statusText : '') + (clipped ? '：' + clipped : '');
}

// 请求体编码：json 原样发；form 把 JSON 模板转成表单；text 原样发文本
function encodeBody(contentType, bodyText) {
  const text = String(bodyText === undefined || bodyText === null ? '' : bodyText);
  if (contentType === 'form') {
    const params = new URLSearchParams();
    let parsed = null;
    try {
      parsed = text.trim() ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.keys(parsed).forEach((key) => {
        const value = parsed[key];
        if (value === null || value === undefined) return;
        if (Array.isArray(value)) {
          value.forEach((item) => params.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item)));
        } else {
          params.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
      });
      return { body: params.toString(), type: 'application/x-www-form-urlencoded' };
    }
    return { body: text, type: 'application/x-www-form-urlencoded' };
  }
  if (contentType === 'text') return { body: text, type: 'text/plain; charset=utf-8' };
  return { body: text, type: 'application/json' };
}

async function callApi(channel, options) {
  const opts = options || {};
  const url = buildUrl(channel, opts.path);
  if (!url) throw errorKinds.configError('这个通道还没填 Base URL');
  const headers = buildHeaders(channel);
  if (opts.extraHeaders && typeof opts.extraHeaders === 'object') {
    Object.keys(opts.extraHeaders).forEach((key) => {
      if (key) headers[key] = str(opts.extraHeaders[key]);
    });
  }
  const contentType = str(opts.contentType) || 'json';
  const rawBody = opts.bodyText;
  const hasBody =
    contentType !== 'none' &&
    opts.method !== 'GET' &&
    rawBody !== undefined &&
    rawBody !== null &&
    String(rawBody).trim() !== '';
  const init = {
    method: (opts.method || 'POST').toUpperCase(),
    headers: headers,
    signal: opts.signal || AbortSignal.timeout(Math.max(10000, (Number(opts.timeoutSec) || 300) * 1000)),
  };
  if (!hasBody) {
    delete headers['Content-Type'];
  } else {
    const encoded = encodeBody(contentType, rawBody);
    if (headers['Content-Type'] === 'application/json' || !headers['Content-Type']) {
      headers['Content-Type'] = encoded.type;
    }
    init.body = encoded.body;
  }
  if (opts.signal) init.signal = opts.signal;
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    note('请求 ' + init.method + ' ' + maskUrl(url) + ' 没走通：' + ((error && error.message) || error));
    // 连不上、DNS 失败、超时、被中止：请求根本没走到平台
    const info = errorKinds.classify(error, { where: opts.where, path: opts.path });
    error.kind = info.kind;
    error.advice = info.advice;
    error.retryable = info.retryable;
    error.detail = (error && error.message) || String(error);
    throw error;
  }
  const text = await response.text();
  const elapsed = Date.now() - startedAt;
  note('请求 ' + init.method + ' ' + maskUrl(url) + ' → ' + response.status + '，用时 ' + tookText(elapsed));
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const raw = shortError(text, response.status, response.statusText);
    const info = errorKinds.classify(
      { status: response.status, message: raw, body: text },
      { where: opts.where, path: opts.path }
    );
    // 认得出是哪一类，就给用户一句中文短标题（卡片状态栏、气泡提示都放得下），
    // 平台原文完整留在 detail 里，详情面板与日志照旧能查到。
    // 认不出时保持原样 —— 宁可难看，也不能把仅有的一条线索吞掉。
    const error = new Error(info.kind === 'UNKNOWN' ? raw : info.title);
    error.status = response.status;
    error.kind = info.kind;
    error.advice = info.advice;
    error.retryable = info.retryable;
    error.detail = raw;
    error.body = text;
    throw error;
  }
  return { url: url, text: text, json: json };
}

// 拉模型清单：GET /models，取值路径可自定义
async function probeModels(channel) {
  const lists = channel.lists || {};
  if (lists.enabled === false) {
    throw new Error('这个通道没有模型清单接口，模型请在通道里手动填写');
  }
  const data = await callApi(channel, {
    path: lists.path || '/models',
    method: (str(lists.method) || 'GET').toUpperCase(),
    contentType: 'none',
    timeoutSec: 60,
    where: 'models',
  });
  let rows = pickByPath(data.json, lists.resultPath);
  if (!Array.isArray(rows)) {
    if (Array.isArray(data.json)) rows = data.json;
    else if (data.json && Array.isArray(data.json.models)) rows = data.json.models;
    else rows = [];
  }
  const ids = [];
  rows.forEach((row) => {
    const id = typeof row === 'string' ? row : pickByPath(row, lists.itemId || 'id');
    const name = modelId(id);
    if (name && ids.indexOf(name) < 0) ids.push(name);
  });
  return { models: ids, url: data.url, raw: data.text };
}

// 查余额：只读接口，不会扣次数
async function queryBalance(channel) {
  const conf = normalizeBalance(channel && channel.balance);
  if (!conf.enabled) throw new Error('这个通道还没打开「余额查询」');
  const path = str(conf.path).trim();
  if (!path) throw errorKinds.configError('余额查询的路径还没填');
  const method = (str(conf.method) || 'GET').toUpperCase();
  const data = await callApi(channel, {
    path: path,
    method: method,
    contentType: method === 'GET' ? 'none' : 'json',
    bodyText: method === 'GET' ? '' : '{}',
    timeoutSec: 45,
    where: 'balance',
  });
  const json = data.json;
  const rawCredits = pickByPath(json, conf.resultPath);
  let credits = null;
  if (typeof rawCredits === 'number' && isFinite(rawCredits)) credits = rawCredits;
  else if (typeof rawCredits === 'string' && rawCredits.trim() !== '' && isFinite(Number(rawCredits))) {
    credits = Number(rawCredits);
  }
  if (credits === null) {
    const remaining = pickByPath(json, 'remaining');
    if (typeof remaining === 'number' && isFinite(remaining)) credits = remaining;
  }
  const name = str(pickByPath(json, conf.namePath));
  const unit = str(conf.unitText) || str(pickByPath(json, conf.unitPath));
  const note = str(pickByPath(json, conf.notePath));
  const tasksRaw = pickByPath(json, conf.tasksPath);
  const tasks =
    tasksRaw && typeof tasksRaw === 'object' && !Array.isArray(tasksRaw)
      ? {
          done: Number(tasksRaw.done) || 0,
          failed: Number(tasksRaw.failed) || 0,
          running: Number(tasksRaw.running) || 0,
          pending: Number(tasksRaw.pending) || 0,
          total: Number(tasksRaw.total) || 0,
        }
      : null;
  return {
    credits: credits,
    name: name,
    unit: unit,
    note: note,
    tasks: tasks,
    url: data.url,
    raw: data.text,
  };
}

// 查下一班发车：只读接口，不会扣次数
async function queryRide(channel) {
  const conf = normalizeRide(channel && channel.ride);
  if (!conf.enabled) throw new Error('这个通道还没打开「班次查询」');
  const path = str(conf.path).trim();
  if (!path) throw errorKinds.configError('班次查询的路径还没填');
  const method = (str(conf.method) || 'GET').toUpperCase();
  const data = await callApi(channel, {
    path: path,
    method: method,
    contentType: method === 'GET' ? 'none' : 'json',
    bodyText: method === 'GET' ? '' : '{}',
    timeoutSec: 45,
    where: 'ride',
  });
  const json = data.json;
  const raw = pickByPath(json, conf.ridePath);
  const labels = {};
  str(conf.stateText)
    .split(',')
    .forEach((pair) => {
      const at = pair.indexOf(':');
      if (at <= 0) return;
      const key = pair.slice(0, at).trim();
      const label = pair.slice(at + 1).trim();
      if (key && label) labels[key] = label;
    });
  let ride = null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const state = str(pickByPath(raw, conf.statePath));
    const onboard = Number(pickByPath(raw, conf.onboardPath));
    const trigger = Number(pickByPath(raw, conf.triggerPath));
    ride = {
      id: str(pickByPath(raw, conf.idPath)),
      state: state,
      stateText: labels[state] || state,
      departAt: str(pickByPath(raw, conf.departAtPath)),
      onboard: isFinite(onboard) ? onboard : null,
      trigger: isFinite(trigger) ? trigger : null,
    };
  }
  return { ride: ride, url: data.url, raw: data.text };
}

// 上传一个参考素材：form = multipart（默认），base64 = data URL 塞进 JSON，binary = 原始字节
async function callUpload(channel, spec, item) {
  const url = buildUrl(channel, spec.path);
  if (!url) throw errorKinds.configError('这个通道还没填 Base URL');
  const headers = buildHeaders(channel);
  Object.keys(spec.headers || {}).forEach(function (key) {
    if (key) headers[key] = str(spec.headers[key]);
  });
  const timeoutMs = Math.max(10000, (Number(spec.timeoutSec) || 300) * 1000);
  const mime = str(item.mime) || 'application/octet-stream';
  const filename = str(item.fileName) || 'ref' + (str(item.ext) || '');
  const init = { method: (spec.method || 'POST').toUpperCase(), headers: headers, signal: AbortSignal.timeout(timeoutMs) };
  if (spec.contentType === 'session') {
    return await sessionUpload(channel, spec, item, headers, filename, mime);
  }
  if (spec.contentType === 'base64') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(
      Object.assign({ name: filename, filename: filename, file: item.dataUrl, data: item.dataUrl }, spec.extra || {})
    );
  } else if (spec.contentType === 'binary') {
    headers['Content-Type'] = mime;
    headers['X-File-Name'] = encodeURIComponent(filename);
    init.body = item.buffer;
  } else {
    // multipart 的 Content-Type 要让 fetch 自己带 boundary，不能抢先写死
    delete headers['Content-Type'];
    const form = new FormData();
    Object.keys(spec.extra || {}).forEach(function (key) {
      if (key) form.append(key, str(spec.extra[key]));
    });
    form.append(spec.field || 'file', new Blob([item.buffer], { type: mime }), filename);
    init.body = form;
  }
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    note('上传 ' + init.method + ' ' + maskUrl(url) + ' 没走通：' + ((error && error.message) || error));
    throw error;
  }
  const text = await response.text();
  note('上传 ' + init.method + ' ' + maskUrl(url) + ' → ' + response.status + '，用时 ' + tookText(Date.now() - startedAt));
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    json = null;
  }
  if (!response.ok) throw new Error('上传参考素材失败：' + shortError(text, response.status, response.statusText));
  return { url: url, text: text, json: json };
}

// 有的平台不收单个 multipart，而要「建会话 → 分片直传 → 完成校验 → 等可用」四步
// 这里按这套通用流程走：POST 建会话，按 parts[].uploadUrl 逐片 PUT，再 complete，最后轮询到 COMPLETED
async function sessionUpload(channel, spec, item, headers, filename, mime) {
  const basePath = str(spec.path) || '/media/uploads';
  const timeoutSec = Math.max(30, Number(spec.timeoutSec) || 300);
  const newKey = () => crypto.randomUUID();
  const sha = 'sha256:' + crypto.createHash('sha256').update(item.buffer).digest('hex');
  const createBody = JSON.stringify(
    Object.assign(
      {
        fileName: filename,
        mimeType: mime,
        sizeBytes: item.buffer.length,
        sha256: sha,
        purpose: str(spec.purpose) || 'INPUT',
      },
      spec.extra || {}
    )
  );
  const created = await callApi(channel, {
    path: basePath,
    method: 'POST',
    contentType: 'json',
    bodyText: createBody,
    headers: spec.headers,
    extraHeaders: Object.assign({}, spec.headers, { 'Idempotency-Key': newKey() }),
    timeoutSec: timeoutSec,
    where: 'upload',
  });
  const uploadId = str(pickByPath(created.json, 'uploadId'));
  let fileId = str(pickByPath(created.json, 'fileId'));
  if (!uploadId && !fileId) {
    throw new Error('建上传会话之后没拿到 uploadId / fileId，返回片段：' + str(created.text).slice(0, 200));
  }
  let status = str(pickByPath(created.json, 'status')).toUpperCase();
  const parts = pickByPath(created.json, 'parts');
  if (Array.isArray(parts) && parts.length) {
    const partSize = Number(pickByPath(created.json, 'partSizeBytes')) || item.buffer.length;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] || {};
      const uploadUrl = str(part.uploadUrl);
      if (!uploadUrl) continue;
      const number = Number(part.partNumber) || index + 1;
      const start = Math.max(0, (number - 1) * partSize);
      const slice = item.buffer.subarray(start, start + partSize);
      const put = await fetch(uploadUrl, { method: 'PUT', body: slice, signal: AbortSignal.timeout(timeoutSec * 1000) });
      if (!put.ok) {
        const body = await put.text();
        throw new Error('上传第 ' + number + ' 片失败：' + shortError(body, put.status, put.statusText));
      }
    }
  }
  if (uploadId && status !== 'COMPLETED') {
    await callApi(channel, {
      path: basePath + '/' + encodeURIComponent(uploadId) + '/complete',
      method: 'POST',
      contentType: 'json',
      bodyText: '{}',
      extraHeaders: { 'Idempotency-Key': newKey() },
      timeoutSec: 120,
      where: 'upload',
    });
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      const got = await callApi(channel, {
        path: basePath + '/' + encodeURIComponent(uploadId),
        method: 'GET',
        contentType: 'none',
        timeoutSec: 60,
        where: 'upload',
      });
      status = str(pickByPath(got.json, 'status')).toUpperCase();
      fileId = str(pickByPath(got.json, 'fileId')) || fileId;
      if (status === 'COMPLETED') {
        return { url: got.url, text: got.text, json: Object.assign({}, got.json, { fileId: fileId }) };
      }
      if (['REJECTED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'FAILED'].indexOf(status) >= 0) {
        const why =
          pickByPath(got.json, 'errorMessage') || pickByPath(got.json, 'errorCode') || status || '未知原因';
        throw new Error('平台没通过这个素材：' + str(why));
      }
      if (Date.now() >= deadline) {
        throw new Error('素材传完了，但等校验超时（最后状态：' + (status || '未知') + '）');
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return { url: created.url, text: created.text, json: Object.assign({}, created.json, { fileId: fileId }) };
}


// ---------------------------------------------------------------------------
// 画布上的「通道状态」面板用：一次把每个通道的余额、班次汇总出来。
// 只回传余额 / 班次这类公开信息，绝不带 apiKey、Base URL、请求头。
// 结果缓存一小会儿，面板反复刷新也不会一直去打平台。
// ---------------------------------------------------------------------------
const STATUS_TTL_MS = 20 * 1000;
let statusCache = { at: 0, data: null };

async function channelStatusOne(channel) {
  const conf = channel || {};
  const balanceOn = !!(conf.balance && conf.balance.enabled === true);
  const rideOn = !!(conf.ride && conf.ride.enabled === true);
  const kinds = Array.isArray(conf.kinds) && conf.kinds.length ? conf.kinds : ['image'];
  const models = conf.models && typeof conf.models === 'object' ? conf.models : {};
  const counts = {};
  KINDS.forEach(function (kind) {
    counts[kind] = Array.isArray(models[kind]) ? models[kind].length : 0;
  });
  const item = {
    id: str(conf.id),
    name: str(conf.name) || '未命名通道',
    enabled: conf.enabled !== false,
    kinds: kinds,
    notes: str(conf.notes),
    modelCounts: counts,
    balanceEnabled: balanceOn,
    rideEnabled: rideOn,
    balance: null,
    balanceError: '',
    ride: null,
    rideError: '',
  };

  const jobs = [];
  if (balanceOn) {
    jobs.push(
      queryBalance(conf)
        .then(function (res) {
          item.balance = {
            credits: res.credits === undefined ? null : res.credits,
            name: res.name || '',
            unit: res.unit || '',
            note: res.note || '',
            tasks: res.tasks || null,
          };
        })
        .catch(function (error) {
          item.balanceError = error.message;
        })
    );
  }
  if (rideOn) {
    jobs.push(
      queryRide(conf)
        .then(function (res) {
          item.ride = res.ride || null;
        })
        .catch(function (error) {
          item.rideError = error.message;
        })
    );
  }
  if (jobs.length) await Promise.all(jobs);
  return item;
}

async function queryStatus(config, opts) {
  const fresh = !!(opts && opts.fresh);
  if (!fresh && statusCache.data && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.data;
  }
  const list = config && Array.isArray(config.channels) ? config.channels : [];
  const items = [];
  for (let i = 0; i < list.length; i += 1) {
    items.push(await channelStatusOne(list[i]));
  }
  const data = { channels: items, at: Date.now() };
  statusCache = { at: Date.now(), data: data };
  return data;
}

module.exports = {
  KINDS,
  defaultUpload,
  defaultRefLimits,
  defaultRefCompress,
  normalizeRefCompress,
  defaultFaceProcessing,
  normalizeFaceProcessing,
  faceProcessingFor,
  normalizeUpload,
  normalizeLimits,
  defaultChannel,
  defaultApiSpec,
  defaultPoll,
  defaultSizeMap,
  defaultVideoSizeMap,
  defaultFilters,
  defaultLists,
  defaultModels,
  parseModelEntry,
  modelLabel,
  modelNote,
  modelId,
  modelIds,
  normalizeChannel,
  normalizeChannels,
  inspectChannel,
  inspectChannels,
  KIND_LABEL_CN,
  activeChannels,
  findChannel,
  buildUrl,
  buildHeaders,
  setLogger,
  fillTemplate,
  encodeBody,
  pickByPath,
  extractResult,
  splitModels,
  sizeFor,
  callApi,
  callUpload,
  probeModels,
  defaultBalance,
  normalizeBalance,
  queryBalance,
  defaultRide,
  normalizeRide,
  queryRide,
  queryStatus,
};
