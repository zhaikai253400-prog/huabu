'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const channels = require('./channels');
const paths = require('./paths');
const assets = require('./assets');
const lastframe = require('./lastframe');
const tailclip = require('./tailclip');
const store = require('./store');
const modelSpecs = require('./model-specs');
const errorKinds = require('./error-kinds');
const configStore = require('./config');
// 参数装配规则与前端共用同一份源码（web 目录下的 UMD 模块，浏览器 <script> 直接加载）
const payloadRules = require('../web/assets/payload-rules.js');
// @ 引用语法（@[图1] / @图1）也只留一份实现：前端连显示、换号、摘引用都走它，
// 服务端这里只需要最后那一步「收拾成平台看得懂的写法」。第 12 份拷贝删掉。
const refs = require('../web/assets/refs.js');

const KIND_FOLDER = { image: '图片', video: '视频', audio: '音频' };

function dateStamp() {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// 归档子目录：按设置决定要不要在分类文件夹里再分一层（none / date / canvas）
function subFolderOf(config, payload) {
  const mode = (config && config.store && config.store.sub) || 'none';
  if (mode === 'date') return dateStamp();
  if (mode === 'canvas') {
    const canvasId = payload && payload.canvasId ? String(payload.canvasId) : '';
    if (!canvasId) return '未归属画布';
    const canvas = store.getCanvas(canvasId);
    return canvas ? canvas.name : '未归属画布';
  }
  return '';
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function snippet(text, limit) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  const max = limit || 200;
  return body.length > max ? body.slice(0, max) + '…' : body;
}

// 提示词里常带着从别处（聊天窗口、文档、代码块）复制来的 Markdown 围栏：
//     ```text
//     镜号一｜30秒 …
//     ```
// 这些反引号对模型毫无意义，却要占 token、还可能让模型以为在写代码而不是描述画面。
// 只去掉「独占一行的开头围栏」和「独占一行的结尾围栏」，正文一个字符都不动 ——
// 万一用户真的在提示词里讲了反引号（例如「画面里出现 ` 符号」），也不会被误删。
function stripPromptFence(text) {
  let body = String(text === undefined || text === null ? '' : text);
  if (!body) return '';
  // 开头：整行只有三个以上反引号，后面可跟语言标记（text / markdown / plaintext…）。
  // 围栏前面允许有若干空行 —— 从聊天窗口 / 文档里连版复制时常常带一行空行进来。
  const lead = body.match(/^([ \t]*(?:\r?\n[ \t]*)*)(`{3,}[ \t]*[A-Za-z0-9_+-]*[ \t]*(?:\r?\n|$))/);
  if (lead) body = body.slice(lead[0].length);
  // 结尾：整行只有三个以上反引号；围栏前后都可以夹空行
  const tail = body.match(/((?:\r?\n[ \t]*)*)`{3,}[ \t]*(?:(?:\r?\n[ \t]*)*)$/);
  if (tail) body = body.slice(0, body.length - tail[0].length);
  return body;
}

// 送接口前把提示词里的 @[图1] 收拾成平台看得懂的写法
function promptForApi(text) {
  return stripPromptFence(refs.forApi(text));
}

// 把画布里的素材名（「图42」「图45」）换成平台认的「图片N」序号。
//
// 为什么必须做：Prompt Hubs 的模型（Seedance / SD2.5 全系）只按
// media_inputs 里图片的**出现顺序**理解参考图。平台文档原话：
// 「提示词里用『图片1、视频1』按类型加序号引用素材，不要把素材 ID 写进提示词」。
// 而画布上的素材名是「图42」「图45」这种全局编号，跟本次提交的顺序毫无关系 ——
// 模型看到「图42 是林振南」根本不知道指的是第几张参考图，结果就是
// 图虽然传上去了（平台校验通过、生成也成功），画面里却完全没用上。
//
// 替换规则刻意保守，宁可漏换也不能错换：
//   · 只认「图N」这种纯阿拉伯数字名字，且该名字必须是本次真正带上来的素材；
//   · 同一个名字出现几次换几次；
//   · 长名字优先替换，避免「图4」把「图42」的前半截换掉；
//   · 图片 / 视频 / 音频分开计数，各自从 1 开始（平台也是这么算的）。
function remapRefNamesInPrompt(text, refs, opts) {
  const source = String(text || '');
  if (!source) return source;
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return source;

  const counters = { image: 0, video: 0, audio: 0 };
  const mapping = [];
  list.forEach((item) => {
    const kind = item && item.kind === 'video' ? 'video' : item && item.kind === 'audio' ? 'audio' : 'image';
    counters[kind] += 1;
    const name = String((item && item.name) || '').trim();
    if (!name) return;
    const hit = name.match(/^(图|视频|音频)\s*(\d+)$/);
    if (!hit) return;
    const prefix = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片';
    // 有的平台要求带 @ 前缀（元梦「源梦创作」文档：在提示词中用 @图片1 / @视频1 / @音频1 引用），
    // 不带 @ 它会当成普通文字，参考图等于没接上。
    const lead = opts && opts.atPrefix === true ? '@' : '';
    const target = lead + prefix + counters[kind];
    if (name === target) return;
    mapping.push({ from: name, to: target });
  });
  if (!mapping.length) return source;
  mapping.sort((a, b) => b.from.length - a.from.length);

  let out = source;
  mapping.forEach((pair) => {
    // 转义正则元字符，再追加「后面不能紧跟数字」的后瞻，
    // 这样「图4」不会把「图42」吃掉。
    const escaped = pair.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 边界要卡死：名字后面不能紧跟中文/数字/字母，否则「图45特写」会被
    // 误换成「图片1特写」——那不是引用素材，是另一个词了。
    // 边界只挡「数字和字母」：
    //   · 挡数字 → 「图4」不会把「图42」的前半截吃掉；
    //   · 挡字母 → 不会把「图45a」这种奇怪编号改坏；
    //   · **放行中文** → 「图45是荒废祠堂」（不带空格）这种写法必须能换，
    //     这是中文提示词里最常见的写法，漏换就等于参考图彻底失效。
    //     代价是「图45特写」也会变成「图片1特写」——语义依然通顺，可接受。
    // 名字前面可能已经有一个 @（用户写的「@图42」）。把 @ 一起吃掉再按需要补回来，
    // 否则 atPrefix 的通道会得到「@@图片1」，不带 @ 的通道会得到「@图片1」——两种都错。
    const pattern = new RegExp('@?' + escaped + '(?![0-9A-Za-z])', 'g');
    out = out.replace(pattern, pair.to);
  });
  return out;
}

// ---------- 尾部提示词 ----------
// 卡片只记「用哪一套」；真正的文字每轮提交时从设置里取，改预设不用回头改卡片。
// 旧卡片没有 tailPrompt 字段时视为不启用，绝不擅自追加。
function normalizeTailChoice(value) {
  // 与前端共用同一份规则，避免「前端认 true、服务端只认对象」这类漂移
  return payloadRules.normalizeTailChoice(value);
}

// 尾部提示词分两个池子：视频卡用 video 池、图片卡用 image 池，互不相通。
// 池子按「请求要哪一种」来选，而不是按卡片类型字符串 —— quick（快速视频）
// 在接口眼里就是视频，所以它取 video 池。
function tailPoolOf(config, kind) {
  const wanted = String(kind || '') === 'image' ? 'image' : 'video';
  return configStore.tailPoolOfConfig(config, wanted);
}

// resolveTail(config, payload, kind)
//   kind 显式传进来，**不要**从 payload 里猜：定时组那条路上 payload 是装配出来的，
//   早期版本压根没传类型，只能靠猜，于是图片卡会错拿到视频池里那套带
//   「无 BGM、嘴型不动」的文字。显式传参能让调用点自己说清"这是哪一类"。
function resolveTail(config, payload, kind) {
  const pool = tailPoolOf(config, kind);
  const frozen = payload && payload.frozenTail;
  if (frozen && typeof frozen === 'object') {
    if (!frozen.enabled) return { enabled: false, presetId: '', name: '', text: '' };
    return {
      enabled: true,
      presetId: String(frozen.presetId || ''),
      name: String(frozen.name || '尾部提示词'),
      text: String(frozen.text || ''),
    };
  }
  // 开关按**自己那一类**取：视频组和图片组各有一个，互不影响。
  // 老配置缺这个字段时 tailGroupEnabledOf 会回落到顶层 enabled，行为与分开关之前一致。
  const choice = normalizeTailChoice(payload && payload.tailPrompt);
  const override = payload && payload.tailOverride && typeof payload.tailOverride === 'object' ? payload.tailOverride : null;
  if (override && override.mode === 'none') return { enabled: false, presetId: '', name: '', text: '' };
  if (!configStore.tailGroupEnabledOf(config, kind)) {
    return { enabled: false, presetId: '', name: '', text: '' };
  }
  if (!choice.enabled && !(override && override.presetId)) return { enabled: false, presetId: '', name: '', text: '' };
  // 默认预设也要按池子取：图片卡的「跟随全局默认」指的是图片池的默认
  const presetId = String((override && override.presetId) || choice.presetId || pool.defaultId || '');
  if (!presetId) return { enabled: false, presetId: '', name: '', text: '' };
  const preset = pool.presets.find((item) => item && String(item.id) === presetId);
  if (!preset) {
    throw new Error('这张卡片引用的尾部提示词原预设已删除，请重新选一套，或关闭这张卡片的尾部提示词');
  }
  const text = String(preset.text || '').trim();
  if (!text) return { enabled: false, presetId: presetId, name: String(preset.name || ''), text: '' };
  return { enabled: true, presetId: presetId, name: String(preset.name || '尾部提示词'), text: text };
}

// 主提示词照旧处理 @[图1]；尾部提示词是纯文字，里面的 @ 原样保留，不再二次处理
function composePrompt(config, payload, kind) {
  const rawMain = String((payload && (payload.promptRaw || payload.prompt)) || '');
  const main = promptForApi(rawMain).trim();
  const tail = resolveTail(config, payload, kind);
  if (!main) return { apiPrompt: '', mainPrompt: '', tail: tail, appended: false };
  if (!tail.enabled || !tail.text) {
    return { apiPrompt: main, mainPrompt: main, tail: tail, appended: false };
  }
  const already = main.indexOf(tail.text) >= 0;
  return {
    apiPrompt: already ? main : main + '\n\n' + tail.text,
    mainPrompt: main,
    tail: tail,
    appended: !already,
  };
}

function composeSubmission(config, payload, kind) {
  const composed = composePrompt(config, payload, kind);
  if (!composed.apiPrompt) throw new Error('提示词是空的，先写点内容再生成');
  return {
    apiPrompt: composed.apiPrompt,
    mainPrompt: composed.mainPrompt,
    tailEnabled: composed.tail.enabled,
    tailPresetId: composed.tail.presetId,
    tailPresetName: composed.tail.name,
    tailText: composed.tail.text,
    tailAppended: composed.appended,
  };
}

function dataUrlOf(buffer, mime) {
  return 'data:' + (mime || 'image/png') + ';base64,' + buffer.toString('base64');
}

const KIND_TEXT = { image: '参考图', video: '参考视频', audio: '参考音频' };

// 通道没设就用这套默认收件要求
const FALLBACK_REF_LIMITS = {
  image: { exts: 'png,jpg,jpeg,webp,gif,bmp', maxMB: 20, maxSec: 0, totalMB: 0, maxCount: -1 },
  video: { exts: 'mp4,mov,webm,mkv', maxMB: 200, maxSec: 0, totalMB: 0, maxCount: -1 },
  audio: { exts: 'mp3,wav,m4a,aac,flac,ogg', maxMB: 50, maxSec: 0, totalMB: 0, maxCount: -1 },
};

// 参考素材读成原始字节：/media 地址直接读文件，远端地址下回来，data URL 直接解
async function oneRefRaw(config, url) {
  const text = String(url || '').trim();
  if (!text) return null;
  if (assets.isDataUrl(text)) {
    const decoded = assets.decodeDataUrl(text);
    if (!decoded) throw new Error('素材内容解不开');
    return { buffer: decoded.buffer, mime: decoded.mime || '', ext: '' };
  }
  if (text.indexOf('/media/') === 0) {
    const abs = assets.resolveMedia(config.assetRoot, text.slice('/media/'.length));
    if (!abs || !fs.existsSync(abs)) throw new Error('参考素材的文件不在了：' + text);
    return { buffer: fs.readFileSync(abs), mime: '', ext: path.extname(abs).toLowerCase() };
  }
  if (/^https?:\/\//i.test(text)) {
    const got = await assets.fetchBuffer(text, {}, 120000);
    return { buffer: got.buffer, mime: got.mime || '', ext: assets.extFromUrl(text) };
  }
  throw new Error('这个参考素材读不出来：' + text);
}

// 左侧「提交压缩」总开关：缺省打开；旧配置没有这一项时也按打开处理
function submitCompressEnabled(config) {
  const value = config && config.submitCompress;
  if (value && typeof value === 'object') return value.enabled !== false;
  if (value === undefined || value === null) return true;
  return value !== false && value !== 0 && value !== '0' && String(value).toLowerCase() !== 'false';
}

function refRule(channel, kind) {
  const table = (channel && channel.refLimits) || {};
  const one = table[kind] || {};
  const base = FALLBACK_REF_LIMITS[kind] || FALLBACK_REF_LIMITS.image;
  const exts = String(one.exts === undefined ? base.exts : one.exts)
    .split(/[,\s]+/)
    .map((item) => item.replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  const totalRaw = Number(one.totalMB);
  const countRaw = one.maxCount === undefined || one.maxCount === null || one.maxCount === '' ? -1 : Number(one.maxCount);
  return {
    exts: exts,
    maxMB: Number(one.maxMB) > 0 ? Number(one.maxMB) : base.maxMB,
    maxSec: Number(one.maxSec) > 0 ? Number(one.maxSec) : 0,
    totalMB: Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : 0,
    maxCount: Number.isFinite(countRaw) ? Math.max(-1, Math.min(99, Math.round(countRaw))) : -1,
  };
}

function tempFileOf(buffer, ext) {
  const file = path.join(
    os.tmpdir(),
    'canvas-ref-' + Date.now() + '-' + Math.random().toString(16).slice(2) + (ext || '.bin')
  );
  fs.writeFileSync(file, buffer);
  return file;
}

function mbOfBytes(bytes) {
  return Number(bytes || 0) / 1024 / 1024;
}

function mbText(bytes) {
  return mbOfBytes(bytes).toFixed(1);
}

// PNG 的 IHDR 里第 25 个字节是颜色类型：4 = 灰度+透明，6 = RGB+透明
function isPngWithAlpha(buffer) {
  if (!buffer || buffer.length < 26) return false;
  if (!(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)) return false;
  if (buffer.slice(12, 16).toString('ascii') !== 'IHDR') return false;
  return buffer[25] === 4 || buffer[25] === 6;
}

// WebP 的扩展头 VP8X 里带一个 alpha 标志位
function isWebpWithAlpha(buffer) {
  if (!buffer || buffer.length < 24) return false;
  if (buffer.slice(0, 4).toString('ascii') !== 'RIFF' || buffer.slice(8, 12).toString('ascii') !== 'WEBP') return false;
  if (buffer.slice(12, 16).toString('ascii') !== 'VP8X') return false;
  return (buffer[20] & 0x10) !== 0;
}

function hasAlpha(buffer) {
  return isPngWithAlpha(buffer) || isWebpWithAlpha(buffer);
}

// 只压“准备提交的临时副本”，画布原图、素材目录里的文件都不会被改
async function compressImage(buffer, ext, opts) {
  const tools = require('./paths').toolsInfo();
  if (!tools.ffmpeg) {
    throw new Error('参考图太大需要压缩，但没找到压缩工具：请确认 tools 目录里的 ffmpeg.exe 还在');
  }
  const clean = String(ext || '').replace(/^\./, '').toLowerCase();
  const alpha = hasAlpha(buffer);
  const allowed = Array.isArray(opts.allowed) && opts.allowed.length ? opts.allowed : ['png', 'jpg', 'jpeg', 'webp'];
  const can = (name) => allowed.indexOf(name) >= 0;
  let target = 'jpg';
  if (alpha) {
    if (opts.alphaFormat === 'png' && can('png')) target = 'png';
    else if (can('webp')) target = 'webp';
    else if (can('png')) target = 'png';
    else target = 'png';
  } else if (can('jpg') || can('jpeg')) {
    target = 'jpg';
  } else if (can('webp')) {
    target = 'webp';
  } else if (can('png')) {
    target = 'png';
  }
  const inputFile = tempFileOf(buffer, clean ? '.' + clean : '.img');
  const outputFile = tempFileOf(Buffer.alloc(0), '.' + target);
  try {
    let width = 0;
    let height = 0;
    if (tools.ffprobe) {
      try {
        const probe = await lastframe.runTool(
          tools.ffprobe,
          ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', inputFile],
          30000
        );
        const hit = String(probe.stdout || '').trim().match(/^(\d+)x(\d+)/);
        if (hit) {
          width = Number(hit[1]);
          height = Number(hit[2]);
        }
      } catch (error) {
        width = 0;
        height = 0;
      }
    }
    const maxEdge = Math.max(64, Number(opts.maxEdge) || 2048);
    const args = ['-y', '-v', 'error', '-i', inputFile];
    if (width > 0 && height > 0 && Math.max(width, height) > maxEdge) {
      // 等比缩到最长边不超过 maxEdge，宽高取偶数，避免个别编码器拒绝奇数尺寸
      const scale = maxEdge / Math.max(width, height);
      const outW = Math.max(2, Math.round((width * scale) / 2) * 2);
      const outH = Math.max(2, Math.round((height * scale) / 2) * 2);
      args.push('-vf', 'scale=' + outW + ':' + outH + ':flags=lanczos');
    }
    args.push('-frames:v', '1', '-map_metadata', '-1', '-an', '-sn');
    const quality = Math.max(1, Math.min(5, Number(opts.quality) || 2));
    if (target === 'jpg') {
      const jpegQuality = [2, 3, 5, 8, 12][quality - 1];
      args.push('-c:v', 'mjpeg', '-q:v', String(jpegQuality), '-pix_fmt', 'yuvj420p');
    } else if (target === 'webp') {
      const webpQuality = [90, 82, 72, 60, 45][quality - 1];
      args.push('-c:v', 'libwebp', '-quality', String(webpQuality), '-compression_level', '6');
      args.push('-pix_fmt', alpha ? 'yuva420p' : 'yuv420p');
    } else {
      args.push('-c:v', 'png', '-compression_level', '9', '-pix_fmt', alpha ? 'rgba' : 'rgb24');
    }
    args.push(outputFile);
    await lastframe.runTool(tools.ffmpeg, args, 120000);
    const out = fs.readFileSync(outputFile);
    if (!out || !out.length) throw new Error('压缩后是空的');
    // 只收 jpeg 的通道就别回 .jpg
    const outName = target === 'jpg' && !can('jpg') && can('jpeg') ? 'jpeg' : target;
    const outExt = '.' + outName;
    return { buffer: out, ext: outExt, mime: MIME_BY_EXT[outExt] || 'image/jpeg' };
  } finally {
    [inputFile, outputFile].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        /* 临时文件删不掉不影响结果 */
      }
    });
  }
}

// 逐级回退：先把「最长边」以内的清晰度用足（只调画质），还放不下才继续缩小
// 每一档都从原图重压，不叠加损失；「最长边」始终是硬上限，不会擅自放大
// always = 每次提交都压缩：第一档直接用通道设定的画质，避免为了省体积先压得太狠
function compressionSteps(cfg, always) {
  const edge = Math.max(1024, Number(cfg && cfg.maxEdge) > 0 ? Number(cfg.maxEdge) : 2048);
  const quality = Math.max(1, Math.min(5, Number(cfg && cfg.quality) || 2));
  const raw = always
    ? [
        { maxEdge: edge, quality: quality },
        { maxEdge: edge, quality: Math.min(5, quality + 1) },
        { maxEdge: edge, quality: Math.min(5, quality + 2) },
        { maxEdge: edge, quality: 5 },
        { maxEdge: Math.min(edge, 1600), quality: 4 },
        { maxEdge: Math.min(edge, 1280), quality: 4 },
        { maxEdge: Math.min(edge, 1024), quality: 4 },
      ]
    : [
        { maxEdge: edge, quality: 1 },
        { maxEdge: edge, quality: quality },
        { maxEdge: edge, quality: Math.min(5, quality + 1) },
        { maxEdge: edge, quality: Math.min(5, quality + 2) },
        { maxEdge: edge, quality: 5 },
        { maxEdge: Math.min(edge, 1600), quality: 4 },
        { maxEdge: Math.min(edge, 1280), quality: 4 },
        { maxEdge: Math.min(edge, 1024), quality: 4 },
      ];
  const seen = new Set();
  return raw.filter((step) => {
    const key = step.maxEdge + '/' + step.quality + '/' + (cfg && cfg.alphaFormat);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sizeReportOf(group, rule) {
  const parts = group.map((item) => (item.name || '参考素材') + ' ' + mbText(item.buffer.length) + ' MB');
  const total = group.reduce((sum, item) => sum + item.buffer.length, 0);
  const limits = ['单张 ≤ ' + rule.maxMB + ' MB'];
  if (rule.totalMB > 0) limits.push('合计 ≤ ' + rule.totalMB + ' MB');
  return '（' + limits.join('，') + '，现在 ' + parts.join('、') + '，合计 ' + mbText(total) + ' MB）';
}

// 按通道设的收件要求整体校验一遍；参考图超出大小限制时自动压缩提交副本
// options.always = true 时（左侧「提交压缩」开着），每张参考图每次提交都先压一遍
async function fitRefsToLimits(refs, channel, progress, options) {
  const list = Array.isArray(refs) ? refs : [];
  const always = Boolean(options && options.always);
  const stats = { beforeBytes: 0, afterBytes: 0, compressedCount: 0, byKind: {} };
  if (!list.length) return stats;
  for (const kind of ['image', 'video', 'audio']) {
    const group = list.filter((item) => item.kind === kind);
    if (!group.length) continue;
    const rule = refRule(channel, kind);
    if (rule.maxCount >= 0 && group.length > rule.maxCount) {
      if (rule.maxCount === 0) {
        throw new Error('这个通道不收' + KIND_TEXT[kind] + '，先在卡片上取消这 ' + group.length + ' 个素材');
      }
      throw new Error(KIND_TEXT[kind] + '最多 ' + rule.maxCount + ' 个，现在带了 ' + group.length + ' 个');
    }
    const beforeBytes = group.reduce((sum, item) => sum + item.buffer.length, 0);
    stats.beforeBytes += beforeBytes;

    const totalOf = () => group.reduce((sum, item) => sum + item.buffer.length, 0);
    const oversSingle = () => group.filter((item) => mbOfBytes(item.buffer.length) > rule.maxMB + 0.001);
    const oversTotal = () => rule.totalMB > 0 && mbOfBytes(totalOf()) > rule.totalMB + 0.001;
    const needShrink = () => oversSingle().length > 0 || oversTotal();

    if (kind !== 'image') {
      if (oversSingle().length) {
        const bad = oversSingle()[0];
        throw new Error(
          (bad.name || KIND_TEXT[kind]) + ' 有 ' + mbText(bad.buffer.length) + ' MB，超过通道设的 ' + rule.maxMB + ' MB 上限'
        );
      }
      if (oversTotal()) {
        throw new Error(KIND_TEXT[kind] + '合计 ' + mbText(totalOf()) + ' MB，超过通道设的 ' + rule.totalMB + ' MB 上限');
      }
      stats.byKind[kind] = { beforeBytes: beforeBytes, afterBytes: beforeBytes };
      stats.afterBytes += beforeBytes;
      continue;
    }

    const cfg = channel && channel.refCompress ? channel.refCompress : channels.defaultRefCompress();
    // 已经能直接透传给平台的公网图（remoteUrl 是 https）不必参与「提交压缩」：
    // 它根本不会再上传，压缩只会让本地副本和平台实际收到的图对不上。
    // 注意仍要按通道上限校验，超限了还是得压（下面 needShrink 的条件不受影响）。
    const directReady = group.every((item) => /^https:\/\//i.test(String(item.remoteUrl || '')));
    const wantCompress = always && !directReady;
    if (wantCompress || needShrink()) {
      // 总开关关掉时，超限兜底也照常执行：旧通道里遗留的「自动压缩关」不再拦住提交
      const compressible = group.filter(
        (item) => ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].indexOf(String(item.ext || '').toLowerCase()) >= 0
      );
      if (!compressible.length) {
        if (needShrink()) throw new Error('参考图超出通道限制，但这些格式都不能自动压缩' + sizeReportOf(group, rule));
      } else {
        // 每一档都从原图重新压，避免一压再压把画质越叠越差
        group.forEach((item) => {
          item.rawBuffer = item.buffer;
          item.rawExt = item.ext;
        });
        const steps = compressionSteps(cfg, wantCompress);
        // 总开关打开时第 1 档一定执行；之后只有超出限制才继续加码
        for (let index = 0; index < steps.length; index += 1) {
          if (index > 0 && !needShrink()) break;
          const step = steps[index];
          const shrinking = needShrink();
          if (typeof progress === 'function') {
            progress({
              stage: shrinking
                ? '参考图超出限制，正在自动压缩（第 ' + (index + 1) + '/' + steps.length + ' 档）…'
                : '正在压缩参考图（第 ' + (index + 1) + '/' + steps.length + ' 档）…',
            });
          }
          for (const item of compressible) {
            const out = await compressImage(item.rawBuffer, item.rawExt, Object.assign({ allowed: rule.exts }, step));
            // 没超限时，压缩反而变大就保留原图，避免提交体积无谓增加
            if (!shrinking && out.buffer.length >= item.rawBuffer.length) continue;
            item.buffer = out.buffer;
            item.ext = out.ext;
            item.mime = out.mime;
            item.dataUrl = dataUrlOf(out.buffer, out.mime);
            item.compressed = true;
            item.compressedStep = index + 1;
          }
          stats.compressedCount = group.filter((item) => item.compressed).length;
        }
      }
    }
    if (needShrink()) {
      const gifHint = group.some((item) => String(item.ext || '').toLowerCase() === '.gif')
        ? '；GIF 动图不能自动压缩，换成 PNG / JPG / WebP 再试'
        : '';
      throw new Error('参考图自动压缩后还是超出通道限制' + sizeReportOf(group, rule) + gifHint);
    }
    const afterBytes = totalOf();
    stats.byKind[kind] = { beforeBytes: beforeBytes, afterBytes: afterBytes };
    stats.afterBytes += afterBytes;
  }
  return stats;
}
// 提交前先照通道设的收件要求过一遍，不合规就直接说清楚，别白花一次调用
async function checkRef(channel, kind, label, ext, buffer) {
  const rule = refRule(channel, kind);
  const clean = String(ext || '').replace(/^\./, '').toLowerCase();
  if (clean && rule.exts.length && rule.exts.indexOf(clean) < 0) {
    throw new Error(label + ' 是 .' + clean + ' 格式，这个通道只收 ' + rule.exts.join(' / '));
  }
  // 图片的大小先不在这里判：超出时还能自动压到限制内，交给后面的整体检查
  if (kind === 'image') return;
  const mb = buffer.length / 1024 / 1024;
  if (mb > rule.maxMB) {
    throw new Error(label + ' 有 ' + mb.toFixed(1) + ' MB，超过通道设的 ' + rule.maxMB + ' MB 上限');
  }
  if (kind === 'video' && rule.maxSec > 0) {
    const tools = require('./paths').toolsInfo();
    if (tools.ffprobe) {
      const file = tempFileOf(buffer, ext || '.mp4');
      try {
        const seconds = await lastframe.probeDuration(tools.ffprobe, file);
        if (seconds > rule.maxSec + 0.5) {
          throw new Error(label + ' 有 ' + seconds.toFixed(1) + ' 秒，超过通道设的 ' + rule.maxSec + ' 秒上限');
        }
      } finally {
        try {
          fs.unlinkSync(file);
        } catch (error) {
          /* 临时文件删不掉不影响结果 */
        }
      }
    }
  }
}

async function prepareRefs(config, list, channel, progress, options) {
  const out = [];
  const items = list || [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const url = typeof item === 'string' ? item : item && item.url;
    const name = (item && item.name) || '参考素材' + (index + 1);
    const kind = (item && item.kind) || '';
    if (!url) continue;
    let raw = null;
    try {
      raw = await oneRefRaw(config, url);
    } catch (error) {
      throw new Error(name + ' 读不出来（' + error.message + '）');
    }
    if (!raw || !raw.buffer || !raw.buffer.length) throw new Error(name + ' 是空的，换一个文件再试');
    // 以文件真实内容为准：有的素材后缀写的是 png，里面其实是 jpeg
    const ext = assets.sniffExt(raw.buffer) || raw.ext || assets.extFromMime(raw.mime) || '';
    const mime = raw.mime || MIME_BY_EXT[ext] || '';
    if (kind) await checkRef(channel, kind, (KIND_TEXT[kind] || '参考素材') + '「' + name + '」', ext, raw.buffer);
    // 参考地址本身就是公网 https、且通道允许直连时，保留原地址（见下面 remoteUrl 的说明）
    const directRefUrl = channel && channel.directRefUrls === true && /^https:\/\//i.test(String(url));
    out.push({
      dataUrl: dataUrlOf(raw.buffer, mime),
      buffer: raw.buffer,
      mime: mime,
      ext: ext,
      name: name,
      kind: kind,
      role: (item && item.role) || '',
      // 原始引用地址（一般是 /media/xxx 这种相对路径）。
      // 保留下来是为了能把它冻结进任务快照：服务重启后还知道这次用了哪些素材。
      src: String(url || ''),
      // 有的通道只认公网 HTTPS 素材（xm API 的 SD2.5 系列就是这样）。
      // 如果这张参考图本来就是公网 https 地址，就直接把它当作素材地址，
      // 不再「下载 → 压缩 → 再传图床」来回折腾：少两次网络往返，也少一个会失败的环节。
      remoteUrl: directRefUrl ? String(url) : '',
      remoteId: '',
    });
  }
  const stats = await fitRefsToLimits(out, channel, progress, options);
  out.refStats = stats;
  // 压缩过的图，内容已经和原地址上的不是同一张了，不能再拿原地址糊弄平台：
  // 清掉 remoteUrl，让 uploadRefs 把压缩后的这一份重新传上去。
  out.forEach((item) => {
    if (item.compressed && item.remoteUrl) item.remoteUrl = '';
  });
  if (stats.compressedCount && typeof progress === 'function') {
    const imageStats = stats.byKind.image || { beforeBytes: 0, afterBytes: 0 };
    progress({
      stage:
        '参考图 ' +
        mbText(imageStats.beforeBytes) +
        ' MB → ' +
        mbText(imageStats.afterBytes) +
        ' MB（已自动压缩，原图没改）',
    });
  }
  return out;
}

const KIND_REF_NAME = { image: '图片', video: '视频', audio: '音频' };

// 图床把失败原因写在 JSON 里（picui.cn 是 {status:false,message:"不支持的文件类型"}），
// HTTP 状态码却还是 200。这里把这类「看起来成功、其实是拒绝」的原因抠出来，
// 否则用户只会看到一句「没拿到素材地址」，完全猜不到是图床不收这个格式。
function uploadFailReason(data) {
  const json = data && data.json;
  if (!json || typeof json !== 'object') return '';
  const picked =
    json.message || json.msg || json.error_description || json.reason ||
    (json.error && (typeof json.error === 'string' ? json.error : json.error.message)) ||
    json.detail || '';
  const text = String(picked || '').trim();
  if (text) return text;
  if (json.status === false || json.success === false || json.code === 1) return '图床返回失败（没写原因）';
  return '';
}

function hostOfSpec(spec) {
  try {
    return new URL(String(spec && spec.path)).host;
  } catch (error) {
    return '';
  }
}

// 上传失败统一报错。把「谁拒的、拒了什么、用户该去哪儿改」写全，
// 免得看到「没拿到素材地址」这种只能瞎猜的提示。
function uploadError(item, kindName, spec, got) {
  const host = hostOfSpec(spec);
  const reason = (got && got.reason) || '';
  return errorKinds.configError(
    '上传' + kindName + '「' + item.name + '」失败' + (reason ? '：' + reason : '，没拿到素材地址或编号'),
    (reason
      ? '这是上传图床' + (host ? '（' + host + '）' : '') + '返回的原文，不是生成平台报的错。' +
        '说明这个图床不收' + kindName + '：到通道的「参考素材：先上传再引用」里给' + kindName +
        '单独填一个支持它的上传地址（那里有 kappa.lol 的一键预设）。'
      : '检查通道的「上传结果取值路径」。') +
      (got && got.data && got.data.text ? '返回片段：' + snippet(got.data.text, 200) : '')
  );
}

// 传一次，把地址 / 编号 / 失败原因都摊平了交给调用方。
// 单独抽出来是为了让「主图床失败→备用图床重试」复用同一段解析逻辑。
async function uploadOnce(channel, spec, item) {
  const data = await channels.callUpload(channel, spec, item);
  let url = spec.resultUrl ? channels.pickByPath(data.json, spec.resultUrl) : '';
  const id = spec.resultId ? channels.pickByPath(data.json, spec.resultId) : '';
  const reason = uploadFailReason(data);
  // 图床给的地址没有扩展名时，有的平台会当成未知格式；按真实后缀补上。
  if (url && spec.appendExt && item.ext && !/\.[A-Za-z0-9]{1,5}(?:[?#].*)?$/.test(String(url))) {
    url = String(url) + item.ext;
  }
  return { ok: Boolean(url || id), url: url ? String(url) : '', id: id ? String(id) : '', reason: reason, data: data };
}

// 通道开了「先上传素材」就挨个传一遍，拿到平台给的地址 / 编号。
// 另有一条自动兜底：通道要求公网 HTTPS 直链（directRefUrls）却没开上传时，
// 本地文件会以 data URL 发过去被平台一律拒——这种情况先把本地文件传公共图床。
async function uploadRefs(channel, refs, ctx, progress) {
  const base = channel && channel.upload;
  const autoSpec = !(base && base.enabled === true) ? channels.autoUploadSpecFor(channel) : null;
  if ((!base || !base.enabled) && !autoSpec) return refs;
  if (!refs.length) return refs;
  if (autoSpec) {
    progress({ stage: '这个通道只认公网地址，先把本地素材传上去…' });
  }
  for (let index = 0; index < refs.length; index += 1) {
    const item = refs[index];
    // 每个素材按自己的类型取上传设置：图片图床常常只收图片，
    // 音频 / 视频要另配一个（见 channels.uploadSpecFor）。
    const spec = autoSpec || channels.uploadSpecFor(channel, item.kind);
    if (!spec || !String(spec.path || '').trim()) {
      throw errorKinds.configError(
        '通道「' + channel.name + '」开了「先上传素材」，但没填上' +
          (KIND_REF_NAME[item.kind] || '参考素材') + '的上传路径'
      );
    }
    // 已经是公网 https 地址了（通道允许直连）：平台收的就是这种地址，不用再传一次
    if (item.remoteUrl && /^https:\/\//i.test(item.remoteUrl)) continue;
    if (ctx && ctx.signal && ctx.signal.aborted) throw new Error('已取消');
    progress({ stage: '正在上传参考素材 ' + (index + 1) + '/' + refs.length + '…' });
    // 名字里已经带了后缀就别再加一遍
    const stem = String(item.name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
    item.fileName = assets.safeName(stem, 'ref', 40) + (item.ext || '');
    const kindName = KIND_REF_NAME[item.kind] || '参考素材';
    let used = spec;
    let got = await uploadOnce(channel, spec, item);
    // 主图床不收这一类（picui.cn 这类纯图片图床最常见）：自动换一个都收的图床再试一次。
    // 这一层兜底放在代码里，另一台电脑同步了代码就能用，不必先把 data/ 里的通道配置补齐。
    if (!got.ok) {
      const spare = channels.fallbackUploadSpec(channel, item.kind);
      if (spare) {
        progress({ stage: '图床不收' + kindName + '，换备用图床重传…' });
        const retry = await uploadOnce(channel, spare, item);
        if (retry.ok) {
          used = spare;
          got = retry;
        } else {
          throw uploadError(item, kindName, spare, retry);
        }
      } else {
        throw uploadError(item, kindName, spec, got);
      }
    }
    item.remoteUrl = got.url;
    item.remoteId = got.id;
    item.uploadHost = hostOfSpec(used);
  }
  return refs;
}

// 生成一份极小的样例素材，用来「试传」——只验图床收不收这个格式，不碰用户的文件。
// 图片用内置 1x1 PNG；音频 / 视频用 ffmpeg 现场压一个 1 秒的，没有 ffmpeg 就退回
// 一段最小可用的文件头（有的图床只看后缀和 MIME，这样也能验出「不支持该类型」）。
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+g6wAAAAASUVORK5CYII=',
  'base64'
);

async function sampleRef(kind) {
  const tools = paths.toolsInfo();
  // 图片也尽量用 ffmpeg 现画一张 320x240 的：有的图床（picui 就是）
  // 会拒掉 1x1 这种「明显不是照片」的图，用它试传会得到误导性的「服务异常」。
  if (kind === 'image' && !tools.ffmpeg) return { buffer: SAMPLE_PNG, ext: '.png', mime: 'image/png' };
  if (tools.ffmpeg) {
    if (kind === 'image') {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-sample-'));
      try {
        const out = path.join(work, 'sample.png');
        await lastframe.runTool(
          tools.ffmpeg,
          ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:d=1', '-frames:v', '1', out],
          60000
        );
        return { buffer: fs.readFileSync(out), ext: '.png', mime: 'image/png' };
      } catch (error) {
        return { buffer: SAMPLE_PNG, ext: '.png', mime: 'image/png' };
      } finally {
        try {
          fs.rmSync(work, { recursive: true, force: true });
        } catch (error) {
          /* 临时目录清不掉不影响结果 */
        }
      }
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-sample-'));
    try {
      if (kind === 'audio') {
        const out = path.join(work, 'sample.mp3');
        await lastframe.runTool(
          tools.ffmpeg,
          ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-q:a', '9', out],
          60000
        );
        return { buffer: fs.readFileSync(out), ext: '.mp3', mime: 'audio/mpeg' };
      }
      const out = path.join(work, 'sample.mp4');
      await lastframe.runTool(
        tools.ffmpeg,
        [
          '-y', '-v', 'error',
          '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1:r=10',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '1', out,
        ],
        120000
      );
      return { buffer: fs.readFileSync(out), ext: '.mp4', mime: 'video/mp4' };
    } catch (error) {
      // 编不出来就走下面的兜底，别把「试传」本身变成一次失败
    } finally {
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch (error) {
        /* 临时目录清不掉不影响结果 */
      }
    }
  }
  if (kind === 'audio') {
    // 一帧 MP3 头 + 静音帧，够图床判类型
    return {
      buffer: Buffer.from('SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMCAAAAAAAAAAAAAAAAAAAAAA', 'base64'),
      ext: '.mp3',
      mime: 'audio/mpeg',
    };
  }
  return { buffer: Buffer.from('00000018667479706d703432000000006d703432', 'hex'), ext: '.mp4', mime: 'video/mp4' };
}

// 试传一次：让用户在通道设置里当场知道「这个图床收不收音频 / 视频」，
// 不用等到生成时才撞上「不支持的文件类型」。
// 返回 { ok, url, id, host, reason, kindName }，不抛错（失败也是一种结果）。
async function testRefUpload(channel, kind) {
  const wanted = kind === 'video' || kind === 'audio' ? kind : 'image';
  const spec = channels.uploadSpecFor(channel, wanted);
  const kindName = KIND_REF_NAME[wanted] || '参考素材';
  const host = (function () {
    try {
      return new URL(String((spec && spec.path) || '')).host;
    } catch (error) {
      return '';
    }
  })();
  if (!spec || !spec.enabled) {
    return { ok: false, host: host, kindName: kindName, reason: '这个通道没有打开「先上传素材」' };
  }
  if (!String(spec.path || '').trim()) {
    return { ok: false, host: '', kindName: kindName, reason: '没填' + kindName + '的上传路径' };
  }
  const sample = await sampleRef(wanted);
  const item = {
    kind: wanted,
    name: '试传' + kindName + sample.ext,
    fileName: 'upload-test' + sample.ext,
    ext: sample.ext,
    mime: sample.mime,
    buffer: sample.buffer,
    dataUrl: dataUrlOf(sample.buffer, sample.mime),
  };
  let got;
  try {
    got = await uploadOnce(channel, spec, item);
  } catch (error) {
    got = { ok: false, reason: (error && error.message) || String(error), data: null };
  }
  // 跟真正生成时完全同一套兜底：主图床不收这一类就换备用图床再试。
  // 否则试传说「不行」、真生成却成功，反而更让人困惑。
  if (!got.ok) {
    const spare = channels.fallbackUploadSpec(channel, wanted);
    if (!spare) {
      return {
        ok: false,
        host: host,
        kindName: kindName,
        reason: got.reason || '没拿到素材地址或编号（检查「地址取值路径」）',
        snippet: snippet(got.data && got.data.text, 160),
      };
    }
    const spareHost = hostOfSpec(spare);
    let retry;
    try {
      retry = await uploadOnce(channel, spare, item);
    } catch (error) {
      retry = { ok: false, reason: (error && error.message) || String(error), data: null };
    }
    if (!retry.ok) {
      return {
        ok: false,
        host: spareHost,
        kindName: kindName,
        reason: (got.reason ? got.reason + '；' : '') + '换备用图床 ' + spareHost + ' 也没成功：' + (retry.reason || '没拿到地址'),
        snippet: snippet(retry.data && retry.data.text, 160),
        fellBack: true,
      };
    }
    return {
      ok: true,
      host: spareHost,
      kindName: kindName,
      url: retry.url,
      id: retry.id,
      fellBack: true,
      fellBackFrom: host,
      reason: got.reason,
    };
  }
  return { ok: true, host: host, kindName: kindName, url: got.url, id: got.id };
}

// 有的平台在任务详情里回的是相对路径，例如 520ruo：
//   { "status": "completed", "url": "/v1/videos/task_xxx/content" }
// 这种地址直接交给 fetch 会当场失败（不是合法的绝对 URL），
// 结果就是「平台明明出片了、本地一直报拿不到素材」。
//
// 不能无脑用 new URL(rel, baseUrl)：baseUrl 通常带 /v1 这种路径前缀，
// 而平台回的相对路径可能已经把 /v1 写全了、也可能只写到 /videos/…，
// 两种情况要分别对齐，否则会拼出 /v1/v1/... 或者丢掉 /v1。
//
// 放在 fetchMedia 里是因为它是所有素材下载的唯一入口（轮询取件、直链、取件接口兜底
// 都汇到这里），改这一处就全覆盖了，不用在每个调用点各补一次。
function absolutizeMediaUrl(found, channel) {
  if (!found || typeof found !== 'object') return found;
  const url = String(found.url || '').trim();
  if (!url || /^https?:\/\//i.test(url) || /^data:/i.test(url)) return found;
  const base = String((channel && channel.baseUrl) || '').trim().replace(/\/+$/, '');
  if (!base) return found;
  let origin = '';
  let basePath = '';
  try {
    const parsed = new URL(base);
    origin = parsed.origin;
    basePath = parsed.pathname.replace(/\/+$/, '');
  } catch {
    return found;
  }
  const rel = url.charAt(0) === '/' ? url : '/' + url;
  // 平台自己已经把 baseUrl 的路径前缀写全了（/v1/videos/…）：直接用 origin 拼
  const alreadyFull = basePath && (rel === basePath || rel.indexOf(basePath + '/') === 0);
  return Object.assign({}, found, { url: (alreadyFull ? origin : base) + rel });
}

async function fetchMedia(config, found, channel) {
  // 相对地址先补成绝对地址，后面的同域判断、下载、重试才有意义
  found = absolutizeMediaUrl(found, channel);
  if (found.base64) return { buffer: Buffer.from(found.base64, 'base64'), mime: '' };
  const dataUrl = found.dataUrl || (found.url && assets.isDataUrl(found.url) ? found.url : '');
  if (dataUrl) {
    const decoded = assets.decodeDataUrl(dataUrl);
    if (!decoded) throw new Error('素材内容解不开');
    return { buffer: decoded.buffer, mime: decoded.mime };
  }
  // 下载地址就在通道自己的域名上时，几乎肯定是「必须带鉴权」的取件接口
  // （例如 xm API 的 /videos/{id}/content）。先无头试一次等于白跑一趟 401，
  // 所以这种情况直接把鉴权带上；跨域地址（图床、CDN）仍然先不带密钥，
  // 免得把 API Key 泄露给不相干的下游。两条路都留了兜底重试。
  const sameHost = (function () {
    try {
      return new URL(found.url).host === new URL(channel && channel.baseUrl).host;
    } catch {
      return false;
    }
  })();
  const withAuth = () => assets.fetchBuffer(found.url, channels.buildHeaders(channel), 300000);
  const noAuth = () => assets.fetchBuffer(found.url, {}, 300000);
  if (sameHost) {
    try {
      return await withAuth();
    } catch (error) {
      return await noAuth();
    }
  }
  try {
    return await noAuth();
  } catch (error) {
    // 有的平台下载地址也要带密钥（外域 CDN 也偶有这种）
    return await withAuth();
  }
}

// 存进 素材/<分类>[/子目录]，返回相对路径和浏览地址
async function saveResult(config, found, channel, prompt, kind, sub) {
  const got = await fetchMedia(config, found, channel);
  if (!got.buffer || !got.buffer.length) throw new Error('拿到的素材是空的');
  const ext =
    assets.sniffExt(got.buffer) || assets.extFromMime(got.mime) || assets.extFromUrl(found.url) || '.png';
  const folder = KIND_FOLDER[kind] || '图片';
  const base = assets.stampName() + '_' + assets.safeName(prompt, '生成结果', 30);
  const abs = assets.writeAsset(config.assetRoot, folder, base, ext, got.buffer, sub === undefined ? subFolderOf(config, null) : sub);
  const rel = assets.relToRoot(abs, config.assetRoot);
  const size = assets.sizeOf(got.buffer);
  return {
    relPath: rel,
    url: assets.mediaUrl(rel),
    width: size ? size.width : 0,
    height: size ? size.height : 0,
    bytes: got.buffer.length,
  };
}

// 上传过就用平台给的地址，没上传就用 data URL（很多平台的图生图能直接吃）
// 注：通道 directRefUrls = true 时，uploadRefs 会自动把本地文件传成公网地址。
function refUrlOf(item) {
  return item.remoteUrl || item.dataUrl;
}

// 平台一般只认 reference_image / reference_video / reference_audio / reference_text 这几种角色，
// 画布里的「首帧 / 尾帧」本质上就是参考图，这里统一折算成对方认识的名字
function inputRoleOf(item, allowFrames) {
  const byKind =
    item.kind === 'video' ? 'reference_video' : item.kind === 'audio' ? 'reference_audio' : 'reference_image';
  const role = String(item.role || '');
  // 首尾帧：只有模型自己支持时才原样送 first_frame / last_frame，
  // 否则仍然当参考图送，免得老通道收到不认识的角色。
  if (allowFrames && /^(first_frame|last_frame)$/.test(role)) return role;
  return /^reference_(image|video|audio|text)$/.test(role) ? role : byKind;
}


// 这次提交要不要开人脸处理：通道里给这个模型勾了、并且确实带了参考图片才行。
// 文档写明它只作用于参考图片，纯文字或只带参考视频 / 音频时开了也没意义。
function faceWanted(payload, channel, model, refs, kind) {
  if (!channel || !model) return false;
  if (!channels.faceProcessingFor(channel, kind, model)) return false;
  return (refs || []).some((item) => item && item.kind === 'image');
}


// 提交前按模型能接受的档位再核对一次时长 / 比例。
// 为什么服务端还要再拦一遍：前端选项是照着模型清单渲染的，正常情况下点不出非法值，
// 但定时组快照、批量、老画布里的残留参数、以及直接打 /api/generate 的脚本都能绕过前端。
// 这类参数错了平台只会回 400，而 400 之前可能已经扣了一次额度 —— 宁可在这里先拦下来。
//
// 只「报错」不「悄悄改」：时长和比例会直接改变成片内容和计费，
// 未经用户同意就改掉比报错更糟（用户以为在跑 30 秒，实际出来 5 秒）。
// 分辨率是例外，见 buildVars 里的 resolvedResolution：那一档只影响清晰度，收敛更顺手。
function checkModelParams(model, kind, input, channelId) {
  if (kind !== 'video') return;
  const spec = modelSpecs.forModel(model, channelId);
  if (!spec) return;
  const label = '模型「' + model + '」';
  const seconds = Number(input && input.duration);
  const allowedDurations = Array.isArray(spec.durations) ? spec.durations : [];
  const minSec = Number(spec.minDurationSec) || 0;
  const maxSec = Number(spec.maxDurationSec) || 0;
  if (Number.isFinite(seconds) && seconds > 0) {
    // 判据分两层，别搞混：
    //   minDurationSec / maxDurationSec 是**平台真正接受的范围**（wan 系列是 2–30 秒内的任意整数）；
    //   durations 只是**卡片下拉里给的常用档位**（5/10/15/30），是范围的子集，不是白名单。
    // 所以能用范围判就用范围判，拿档位清单当白名单会把 12 秒这种合法值误杀。
    const rounded = Math.round(seconds);
    if (minSec && maxSec) {
      if (rounded < minSec || rounded > maxSec) {
        throw new Error(
          label + '不支持 ' + rounded + ' 秒。它能接受的是 ' + minSec + '–' + maxSec + ' 秒（整数秒）。'
        );
      }
    } else if (allowedDurations.length && allowedDurations.indexOf(String(rounded)) < 0) {
      throw new Error(
        label + '不支持 ' + rounded + ' 秒。它能接受的是：' + allowedDurations.join(' / ') + ' 秒。'
      );
    }
  }
  const ratio = String((input && input.ratio) || '').trim();
  const allowedRatios = Array.isArray(spec.ratios) ? spec.ratios : [];
  if (ratio && allowedRatios.length && allowedRatios.indexOf(ratio) < 0) {
    throw new Error(
      label + '不支持 ' + ratio + ' 这个比例，它支持：' + allowedRatios.join(' / ') +
        '。在这张卡片上换一个比例再生成。'
    );
  }
}

// 通道级上限取的是「这个通道最宽松的模型」（例如通道5 放 13 张给 Nano），
// 但通道里的每个模型各自能收多少并不一样：GPT 系列只收 9 张，SD2.5 特惠连参考视频都不收。
// 这里按模型再卡一次，别等平台 400 才知道超了 —— 400 之前额度可能已经扣掉了。
//
// 三类素材分开判：maxRefs / maxRefVideos / maxRefAudios，0 表示这一类完全不收。
// maxRefTotal 是「三类加起来」的总数上限（Prompt Hubs 的线路四就是各自 30/10/10 但合计 ≤50）。
function checkModelRefs(model, refs, kind, channelId) {
  const spec = modelSpecs.forModel(model, channelId);
  if (!spec) return;
  const label = '模型「' + model + '」';
  const list = refs || [];

  const countOf = (targetKind) =>
    list.filter((item) => item && (item.kind === targetKind || (targetKind === 'image' && !item.kind))).length;

  const rules = [
    { kind: 'image', name: '参考图', unit: '张', max: Number(spec.maxRefs) },
    { kind: 'video', name: '参考视频', unit: '个', max: spec.maxRefVideos === undefined ? null : Number(spec.maxRefVideos) },
    { kind: 'audio', name: '参考音频', unit: '个', max: spec.maxRefAudios === undefined ? null : Number(spec.maxRefAudios) },
  ];
  for (const rule of rules) {
    if (rule.max === null || !Number.isFinite(rule.max) || rule.max < 0) continue;
    const used = countOf(rule.kind);
    if (used <= rule.max) continue;
    if (rule.max === 0) {
      throw new Error(
        label + '不收' + rule.name + '，现在带了 ' + used + ' ' + rule.unit + '。先在卡片上把这些素材取消掉再生成。'
      );
    }
    throw new Error(
      label + '最多接 ' + rule.max + ' ' + rule.unit + rule.name + '，现在带了 ' + used + ' ' + rule.unit + '，先在卡片上减几个再生成'
    );
  }

  // 有的模型只做图生视频（520ruo 的 seedance_2.5_flash 必须至少 1 张参考图），
  // 纯文字提交会被平台直接拒单。这里先拦住，别让用户白等一次往返。
  const minImages = Number(spec.minRefs);
  if (Number.isFinite(minImages) && minImages > 0) {
    const used = countOf('image');
    if (used < minImages) {
      throw new Error(
        label + '必须至少带 ' + minImages + ' 张参考图（这个模型只做图生视频），现在带了 ' + used +
          ' 张。先在卡片上挂一张参考图再生成。'
      );
    }
  }

  const maxTotal = Number(spec.maxRefTotal);
  if (Number.isFinite(maxTotal) && maxTotal > 0) {
    const total = list.filter(Boolean).length;
    if (total > maxTotal) {
      throw new Error(
        label + '的参考素材合计最多 ' + maxTotal + ' 个（图 / 视频 / 音频加在一起），现在带了 ' + total + ' 个，先在卡片上减几个再生成'
      );
    }
  }
}

function buildVars(payload, channel, model, size, count, refs, kind) {
  // 分辨率也得按模型能接受的档位收敛，不能只让前端拦。
  // 前端选项是照着模型清单渲染的，但定时组、批量、老画布里的残留值、
  // 以及直接打 /api/generate 的请求，都可能带着这个模型根本没有的档位过来。
  // 视频看 resolutions（720p/1080p…），图片看 sizes（1K/2K/4K…）；
  // 模型没登记在 model-specs 里时不动它，免得把新通道的值改坏。
  const resolvedResolution = (function () {
    const spec = modelSpecs.forModel(model, channel && channel.id);
    const raw = String(payload.resolution || (kind === 'image' ? payload.sizeKey : '') || '').trim();
    if (!spec) return { value: raw.toUpperCase() };
    const table = Array.isArray(spec.resolutions) && spec.resolutions.length
      ? spec.resolutions
      : Array.isArray(spec.sizes) && spec.sizes.length
      ? spec.sizes
      : [];
    if (!table.length) return { value: raw.toUpperCase() };
    const hit = table.find((item) => String(item).toLowerCase() === raw.toLowerCase());
    // 传上来的档位模型不收：退回这个模型的默认档，而不是把无效值原样发出去
    const picked = hit || spec.defaultResolution || table[0];
    return { value: String(picked).toUpperCase() };
  })();
  // kind 决定去通道里查哪一份人脸处理名单
  // 通道开启「提示词用图片N」时，把「图42」这类画布素材名换成平台认的「图片2」。
  // 必须在 promptForApi 之后做：那一步只负责去掉 @[图1] 的方括号，
  // 不认识「图45」这种裸写法；真正的序号映射在这里。
  const rawPrompt = String(payload.apiPrompt || promptForApi(payload.prompt || payload.promptRaw || ''));
  const finalPrompt =
    channel && channel.refPromptIndex === true
      ? remapRefNamesInPrompt(rawPrompt, refs, { atPrefix: channel.refPromptAt === true })
      : rawPrompt;

  const vars = {
    requestId: crypto.randomUUID(),
    prompt: finalPrompt,
    promptRaw: String(payload.promptRaw || payload.prompt || ''),
    model: model,
    n: count,
    size: size,
    sizeKey: String(payload.sizeKey || ''),
    ratio: String(payload.ratio || ''),
    duration: Number(payload.duration) || 0,
    // 图片卡片上选的 1K / 2K / 4K 存在 sizeKey 里（视频才是 resolution），
    // 这里统一折算成接口要的 resolution 字段，别让卡片选 4K 却按默认 1K 出图。
    resolution: String(resolvedResolution.value || ''),
    // 有的平台分辨率要求小写（xm API 的 sd25-1-pro 就是 720p），
    // 所以同一个结论出两份写法，模板里按平台要求挑一个用。
    resolutionLower: String(resolvedResolution.value || '').toLowerCase(),
    // 有的平台（xinbiapi 的 gpt-image-2.5-flare）分辨率只认「1024*1024」这种星号写法，
    // 不认 1024x1024。同一份结论再多出一份星号写法，模板里按平台要求挑。
    sizeAsterisk: String(size || '').toLowerCase().replace(/x/g, '*'),
    mode: String(payload.mode || ''),
    refs: refs.map(refUrlOf),
    refCount: refs.length,
    refNames: refs.map((item) => item.name),
    refKinds: refs.map((item) => item.kind || ''),
    refImages: refs.filter((item) => item.kind === 'image').map(refUrlOf),
    refVideos: refs.filter((item) => item.kind === 'video').map(refUrlOf),
    refAudios: refs.filter((item) => item.kind === 'audio').map(refUrlOf),
    // 有的平台（如 xm API 的 bd-VIP 系列）参考素材统一走一个数组，每项是 {type, url}，
    // 而不是三条分开的地址数组。这里按参考顺序拼好，模板里写 "media": {{refMedia}} 即可。
    // type 用平台认的 reference_image / reference_video / reference_audio（frames 传 false，不做首尾帧转换）。
    refMedia: refs.map((item) => ({ type: inputRoleOf(item, false), url: refUrlOf(item) })),
    // Prompt Hubs（console.prompt-hubs.com）这类平台用的是统一契约 video.v1：
    // 素材写进 media_inputs，每项是 {kind, role, url}。
    //   kind 只认 image / video / audio；
    //   role 只有 reference（图、视频）和 audio_reference（音频）两种语义角色。
    // 这是平台自家画布提交时用的写法，比老的扁平字段更稳（平台文档也建议新接入走这条）。
    refMediaInputs: refs.map((item) => ({
      kind: item.kind === 'video' ? 'video' : item.kind === 'audio' ? 'audio' : 'image',
      role: item.kind === 'audio' ? 'audio_reference' : 'reference',
      url: refUrlOf(item),
    })),
    // 有的平台只收「内嵌 Base64」素材，完全不吃 URL ——
    // 520ruo 的 seedance_2.5_flash 就是这样：images 必填 1–10 张，
    // 元素可以是 Base64 字符串、data URI 或 {base64, mimeType} 对象，
    // 文档明确写了「本站当前图片URL传入尚未开放」。
    // 这里直接复用 prepareRefs 已经算好的 dataUrl（压缩之后的那一份），
    // 不再把 buffer 重新 base64 一遍：30 MB 素材再复制两份很容易把内存顶爆。
    refInlineImages: refs.filter((item) => item.kind === 'image' || !item.kind).map((item) => item.dataUrl || ''),
    // 音频的写法不一样：文档要求的是 {base64, mimeType} 对象数组，
    // 不能像图片那样直接塞 data URI，所以这里把 dataUrl 拆成两段。
    refInlineAudios: refs
      .filter((item) => item.kind === 'audio')
      .map((item) => {
        const dataUrl = String(item.dataUrl || '');
        const comma = dataUrl.indexOf(',');
        const meta = comma > 0 ? dataUrl.slice(5, comma).replace(/;base64$/i, '') : '';
        return {
          base64: comma > 0 ? dataUrl.slice(comma + 1) : dataUrl,
          mimeType: meta || item.mime || 'audio/mpeg',
        };
      }),
    // video.v1 的 operation 跟着素材类型走（和平台自己的判定函数一致）：
    // 有参考视频 -> video_to_video；只有参考图 -> image_to_video；纯文字 -> text_to_video。
    mediaOperation: refs.some((item) => item.kind === 'video')
      ? 'video_to_video'
      : refs.some((item) => item.kind === 'image' || !item.kind)
      ? 'image_to_video'
      : 'text_to_video',
    refIds: refs.map((item) => item.remoteId || ''),
    refUploadUrls: refs.map((item) => item.remoteUrl || ''),
    refImageIds: refs.filter((item) => item.kind === 'image').map((item) => item.remoteId || ''),
    refVideoIds: refs.filter((item) => item.kind === 'video').map((item) => item.remoteId || ''),
    refAudioIds: refs.filter((item) => item.kind === 'audio').map((item) => item.remoteId || ''),
    // 参考图人脸处理：只有通道里给这个模型勾了、并且这次确实带了参考图，才算开启
    faceProcessing: faceWanted(payload, channel, model, refs, kind || 'image'),
  };
  // 首尾帧：单独给出首帧 / 尾帧，通道模板里可以直接用 {{firstFrame}} / {{lastFrame}}
  const firstFrame = refs.find((item) => item.role === 'first_frame');
  const lastFrame = refs.find((item) => item.role === 'last_frame');
  const imageRefs = refs.filter((item) => item.kind === 'image');
  vars.firstFrame = firstFrame ? refUrlOf(firstFrame) : imageRefs[0] ? refUrlOf(imageRefs[0]) : '';
  vars.lastFrame = lastFrame
    ? refUrlOf(lastFrame)
    : imageRefs[1]
    ? refUrlOf(imageRefs[1])
    : '';
  vars.firstFrameId = firstFrame ? firstFrame.remoteId || '' : imageRefs[0] ? imageRefs[0].remoteId || '' : '';
  vars.lastFrameId = lastFrame ? lastFrame.remoteId || '' : imageRefs[1] ? imageRefs[1].remoteId || '' : '';
  refs.forEach((item, index) => {
    vars['ref' + index] = refUrlOf(item);
    vars['ref' + index + 'Id'] = item.remoteId || '';
  });
  if (refs.length) {
    vars.ref0 = refUrlOf(refs[0]);
    vars.ref1 = refs[1] ? refUrlOf(refs[1]) : '';
  }

  // 有的平台要 {role, fileId} 形状的素材清单；没有上传编号时这几项自然是空的
  // 首尾帧任务跟参考任务在两套模型里叫法不同，按模型能力决定
  const spec = modelSpecs.forModel(model, channel && channel.id);
  const framesCapable = !spec || spec.frames !== false;
  const isFrame = (item) => /^(first_frame|last_frame)$/.test(String(item.role || ''));
  const hasFrames = refs.some(isFrame);
  const wantFrames = String(payload.mode || '') === 'frames' && hasFrames && framesCapable;
  // 首尾帧任务只认首帧和尾帧，多接的参考图不能混进去
  const taskRefs = wantFrames ? refs.filter(isFrame) : refs;
  vars.inputFiles = taskRefs
    .map((item) => ({ role: inputRoleOf(item, framesCapable), fileId: item.remoteId || '' }))
    .filter((item) => item.fileId);
  // 纯文生 / 首尾帧 / 带参考素材，三种任务名先备好，模板里写 {{taskType}} 即可自动切换
  //
  // 图片通道（xinbiapi 这类 /media/tasks 平台）用的是另一套任务名：IMAGE_GENERATE / IMAGE_EDIT，
  // 而且 **带参考图就必须报 IMAGE_EDIT**（平台在 IMAGE_GENERATE 下不接受 reference_image）。
  // 这里按 kind 分支，不要拿视频那三档去凑：名字对不上平台会直接 400。
  if (kind === 'image') {
    vars.taskType = refs.length ? 'IMAGE_EDIT' : 'IMAGE_GENERATE';
  } else if (wantFrames) {
    vars.taskType = 'VIDEO_IMAGE_TO_VIDEO';
  } else {
    vars.taskType = refs.length ? 'VIDEO_REFERENCE' : 'VIDEO_TEXT_TO_VIDEO';
  }
  return vars;
}

// 图片生成的完整链路：选通道 → 组装请求 → 调用 → 存素材
// 卡片上写的模型名如果不在清单里也照样发出去，清单里没有就用通道里设的默认模型
function resolveModel(channel, kind, model) {
  const wanted = String(model || '').trim();
  const list = channels.modelIds(channel.models[kind]);
  if (wanted) return wanted;
  const fallback = channel.defaults && channel.defaults[kind] ? String(channel.defaults[kind]).trim() : '';
  if (fallback && list.indexOf(fallback) >= 0) return fallback;
  return list[0] || '';
}

// 附加参数：写在通道里的固定字段（例如 watermark、quality）合并进请求体
function looseValue(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  if (!raw) return '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (/^[[{]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function mergeExtra(bodyText, extra) {
  const source = extra && typeof extra === 'object' ? extra : {};
  const keys = Object.keys(source);
  if (!keys.length) return bodyText;
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyText;
  keys.forEach((key) => {
    if (!key) return;
    parsed[key] = looseValue(source[key]);
  });
  return JSON.stringify(parsed, null, 2);
}

// 空的素材数组没有意义，有的平台会把它当成「一个无效素材」直接拒单
// 所以组装完请求体后，把这些空数组字段整个去掉（只处理顶层、只处理媒体字段）
const EMPTY_MEDIA_KEYS = [
  'image_urls',
  'video_urls',
  'audio_urls',
  'images',
  'videos',
  'audios',
  'reference_images',
  'reference_videos',
  'reference_audios',
  // 520ruo 的 seedance_2.5_flash：images / audio 都是可选或必填的 Base64 数组，
  // 空的时候要整个删掉（平台会把空数组当成「传了但内容无效」）
  'audio',
  // Prompt Hubs 的 video.v1：素材统一走 media_inputs，空数组同样要清掉
  'media_inputs',
  // xm API 的两个视频模型：bd-VIP 走 media[{type,url}]，sd25-1-pro 走 images/video_refs/audio_refs。
  // 空数组有的平台会当成「一个无效素材」直接拒单，所以一并按空清理掉。
  'media',
  'image_refs',
  'video_refs',
  'audio_refs',
  'refs',
  'audioRefs',
  'videoRefs',
  'attachments',
  // inputFiles 故意**不**在这里：xinbiapi 的 /media/tasks 把 inputFiles 当必填字段，
  // 纯文生时也要显式给一个 []，删掉反而会被判「字段缺失」。
  'file_ids',
  'audio_file_ids',
  'video_file_ids',
];

function pruneEmptyMedia(bodyText) {
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyText;
  let changed = false;
  EMPTY_MEDIA_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(parsed, key) && Array.isArray(parsed[key]) && parsed[key].length === 0) {
      delete parsed[key];
      changed = true;
    }
  });
  return changed ? JSON.stringify(parsed, null, 2) : bodyText;
}

// 有的模型（例如 wan3.0-super）对参数查得很严：parameterSchema 里没声明的键一律 422。
// 通道模板是几个模型共用的，这里按模型的 paramKeys 把多余的参数剔掉。

// 人脸处理只在「这个模型被勾选」并且这次真的带了参考图时才开启。
// 平台默认关闭，所以没勾的时候要把字段删干净，不能留个 false 占位。
function applyFaceProcessing(bodyText, contentType, on) {
  if (contentType !== 'json' && contentType !== 'form') return bodyText;
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyText;
  if (on) {
    if (parsed.faceProcessing === true) return bodyText;
    parsed.faceProcessing = true;
    return JSON.stringify(parsed, null, 2);
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, 'faceProcessing')) return bodyText;
  delete parsed.faceProcessing;
  return JSON.stringify(parsed, null, 2);
}

function pruneUnsupportedParams(bodyText, model, channelId) {
  const spec = modelSpecs.forModel(model, channelId);
  const allowed = spec && Array.isArray(spec.paramKeys) ? spec.paramKeys : null;
  if (!allowed || !allowed.length) return bodyText;
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyText;
  const params = parsed.parameters;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return bodyText;
  let changed = false;
  Object.keys(params).forEach((key) => {
    if (allowed.indexOf(key) < 0) {
      delete params[key];
      changed = true;
    }
  });
  return changed ? JSON.stringify(parsed, null, 2) : bodyText;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new Error('已取消'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('已取消'));
      },
      { once: true }
    );
  });
}

function splitWords(text) {
  return String(text || '')
    .split(/[,，、\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function stampMinute(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return hours + ' 小时 ' + mins + ' 分钟';
  if (mins) return mins + ' 分钟 ' + secs + ' 秒';
  return secs + ' 秒';
}

// 组装一条「可接续」的记录：服务重启后靠它继续等，不用重新提交一遍
// refs 是本次真正送给平台的参考素材（可能是数组，也可能是带 refStats 的数组）。
// 只冻结「能重建的东西」：原始地址、角色、名字，不含 buffer（几 MB 的字节不该进库）。
function waitRefsOf(refs) {
  const list = Array.isArray(refs) ? refs : [];
  return list.map((item) => ({
    src: String((item && (item.src || item.remoteUrl || item.url)) || ''),
    name: String((item && item.name) || ''),
    kind: String((item && item.kind) || ''),
    role: String((item && item.role) || ''),
    remoteId: String((item && item.remoteId) || ''),
  }));
}

function buildWaitRecord(channel, kind, spec, payload, model, size, prompt, remoteId, refs) {
  const poll = spec.poll || {};
  const now = Date.now();
  const maxWaitSec = Math.max(30, Number(poll.maxWaitSec) || 1800);
  return {
    kind: kind,
    channelId: channel.id,
    channelName: channel.name || '',
    model: model,
    size: size,
    prompt: prompt,
    // 本次提交冻结的参考素材快照：重启接续、卡片展示「本次提交」都靠它
    refs: waitRefsOf(refs),
    remoteId: String(remoteId || ''),
    queryPath: String(poll.path || ''),
    listField: String(poll.listField || ''),
    listIdField: String(poll.listIdField || 'id'),
    method: poll.method || 'GET',
    statusField: poll.statusField || '',
    doneValues: poll.doneValues || '',
    failValues: poll.failValues || '',
    resultUrl: poll.resultUrl || spec.resultUrl || '',
    resultB64: poll.resultB64 || spec.resultB64 || '',
    errorField: poll.errorField || '',
    downloadPath: String(poll.downloadPath || ''),
    downloadIdPath: String(poll.downloadIdPath || ''),
    downloadUrlField: String(poll.downloadUrlField || ''),
    intervalSec: Math.max(1, Number(poll.intervalSec) || 5),
    maxWaitSec: maxWaitSec,
    startedAt: now,
    deadlineAt: now + maxWaitSec * 1000,
    attempt: 0,
    params: (payload && payload.params) || {},
    version: 1,
  };
}

// 异步接口：拿着任务号每隔几秒问一次，问出结果地址为止
// 第一次是立刻问，之后按间隔问；已等多久按记录里的开始时间算，重启后不会从头计时
async function pollRemote(config, channel, kind, record, ctx, progress) {
  const intervalMs = Math.max(1, Number(record.intervalSec) || 5) * 1000;
  // 最长等待时间。
  //
  // 这里只认「等了多久」这个时长，不能直接信 deadlineAt 那个绝对时间戳 ——
  // 它是任务刚提交时算出来的，一旦这条任务判过超时，再点「重新拉取」时
  // 那个时间戳早就过去了，循环第一次判 Date.now() >= deadline 就立刻 break，
  // 于是一个请求都不发、当场又报一次「等太久了」，用户以为永远拉不回来了。
  // 所以按 startedAt + maxWaitSec 现算一遍，并且保证至少还有一段可取件的时间。
  //
  // 通道里的「最长等待」是用户随时可能调大的配置，记录里的只是提交那一刻的快照。
  // 取两者较大的：用户把上限从 2 小时调到 4 小时后，之前提交、还在跑的任务也应该
  // 享受新的上限，而不是继续按老快照判超时。
  const pollCfg = (channel && channel[kind] && channel[kind].poll) || {};
  const maxWaitSec = Math.max(
    Number(record.maxWaitSec) || 0,
    Number(pollCfg.maxWaitSec) || 0,
    30
  );
  const maxWaitMs = maxWaitSec * 1000;
  const startedAt = Number(record.startedAt) || Date.now();
  // 重新拉取时（record.refetch）从「现在」重新计时：判过超时的任务本来就已经
  // 超过 maxWaitSec 了，不减这一下的话一进来就又超时。
  const baseMs = record.refetch ? Date.now() : startedAt;
  const deadline = Math.max(
    baseMs + maxWaitMs,
    Number(record.deadlineAt) || 0,
    Date.now() + 60 * 1000
  );
  const doneWords = splitWords(record.doneValues);
  const failWords = splitWords(record.failValues);
  const queryPath = String(record.queryPath || '').replace(
    /\{\{\s*(taskId|task_id|id)\s*\}\}/g,
    encodeURIComponent(record.remoteId)
  );
  let lastState = '';
  let round = 0;
  let misses = 0;
  // 按分类记「已经连续失败了几次」。只有确定没救的错误才会提前判死，
  // 网络类的一律不计数（strikes = 0），继续等满，免得片子其实成了却被误报。
  const strikes = new Map();
  for (;;) {
    if (Date.now() >= deadline) break;
    if (round) await sleep(Math.min(intervalMs, Math.max(1000, deadline - Date.now())), ctx && ctx.signal);
    round += 1;
    let data = null;
    try {
      data = await channels.callApi(channel, {
        path: queryPath,
        method: record.method || 'GET',
        contentType: 'none',
        timeoutSec: 60,
        signal: ctx && ctx.signal,
        // 轮询时 404 的含义是「平台不认这条任务号了」，跟 404 模型不存在是两码事
        where: 'poll',
      });
      // 这一轮问到了，连击数清零：错误必须是「连续的」才算数
      misses = 0;
      strikes.clear();
    } catch (error) {
      if (ctx && ctx.signal && ctx.signal.aborted) throw error;
      lastState = (error && error.detail) || (error && error.message) || String(error);
      const info = error.__info || errorKinds.classify(error, { where: 'poll', path: queryPath });

      // 密钥 / 额度 / 模型不对：再等多久都不会好，立刻报出来
      if (info.failFast) {
        throw errorKinds.explain(error, { where: 'poll', path: queryPath });
      }

      // 剩下的按分类记连击数，够数才判死。
      // 原来是一刀切「除了 401/403 一律等满」，对「任务号已经失效」「返回结构
      // 一直不对」这类明确故障来说太钝了 —— 用户要白等半小时才知道出了事。
      // 而网络抖动仍然不计数，保住了原来「宁可多等，不可误报」的保守性。
      const limit = Number(info.strikes) || 0;
      let count = 0;
      if (limit > 0) {
        count = (strikes.get(info.kind) || 0) + 1;
        strikes.set(info.kind, count);
        if (count >= limit) {
          throw errorKinds.explain(error, { where: 'poll', path: queryPath });
        }
      }

      misses += 1;
      if (Date.now() >= deadline) break;
      const tail = limit > 0 ? '，' + count + '/' + limit : '';
      progress({
        stage:
          '接口暂时查不到结果（第 ' + misses + ' 次' + tail + '），继续等（已等 ' +
          stampMinute(Date.now() - startedAt) + '，' + lastState.slice(0, 80) + '）',
      });
      continue;
    }
    // 有的平台只能「拉整个任务列表」，配了列表字段就先按任务号把自己那条挑出来
    let taskNode = data.json;
    if (record.listField) {
      const rows = channels.pickByPath(data.json, record.listField);
      const list = Array.isArray(rows) ? rows : [];
      const mine = list.find(
        (row) => String(channels.pickByPath(row, record.listIdField || 'id') || '') === String(record.remoteId)
      );
      if (!mine) {
        lastState = '列表里还没找到这条任务';
        progress({ stage: '生成中…（还排在队列里，已等 ' + stampMinute(Date.now() - startedAt) + '）' });
        continue;
      }
      taskNode = mine;
    }
    const statusRaw = channels.pickByPath(taskNode, record.statusField);
    const status = String(statusRaw === undefined || statusRaw === null ? '' : statusRaw).trim().toLowerCase();
    // 拉列表时不能拿整个列表的原文去撮地址，否则会把别人的片子 / 封面当成自己的成品
    const scanText = record.listField ? JSON.stringify(taskNode) : data.text;
    // 先按「结果地址路径」直接找。原来这里是 `record.downloadPath ? null : ...`：
    // 只要配了取件路径就完全不看返回体，于是「平台明明给了 video_url、只是取件文件号没配」
    // 这种组合会一路走到「任务完成了，但没找到结果文件号」——用户白等一场。
    // 取件路径只是「拿不到直链时的兜底」，不该反过来屏蔽直链。
    let found = channels.extractResult(scanText, taskNode, {
      resultUrl: record.resultUrl || '',
      resultB64: record.resultB64 || '',
    });
    // 封面图 / 预览图不算出片：丢掉它，继续按状态往下走（失败了就报错，没完成就接着等）
    if (found && !kindMatches(kind, found)) {
      progress({ stage: '生成中…（' + (kind === 'video' ? '还在等成片' : '还在等图片') + '，已等 ' + stampMinute(Date.now() - startedAt) + '）' });
      found = null;
    }
    if (found) return found;
    lastState = status || snippet(data.text, 120);
    progress({ stage: '生成中…（' + (status || '等待中') + '，已等 ' + stampMinute(Date.now() - startedAt) + '）' });
    const note = channels.pickByPath(taskNode, record.errorField);
    const tail = note ? '：' + String(note).slice(0, 200) : '';
    if (failWords.length && failWords.indexOf(status) >= 0) {
      throw errorKinds.makeError('UNKNOWN', '接口说这次生成失败了' + tail);
    }
    if (doneWords.length && doneWords.indexOf(status) >= 0) {
      // 有的平台在任务里只给「结果文件号」，要再走一次取件接口换下载地址
      if (record.downloadPath) {
        // 取件号可以是多候选（downloadIdPath 写 `a|b`），也可以整段留空——
        // 那种平台的取件地址就是 /videos/{{taskId}}/content，直接拿任务号当文件号。
        const fileId =
          channels.pickByPaths(taskNode, record.downloadIdPath) ||
          (String(record.downloadPath).indexOf('{{taskId}}') >= 0 ? record.remoteId : undefined);
        if (!fileId) {
          throw errorKinds.makeError('BAD_FORMAT', '任务完成了，但返回里没找到结果文件号，检查「取件文件号路径」' + tail);
        }
        const dlPath = String(record.downloadPath).replace(
          /\{\{\s*(fileId|file_id|id|taskId|task_id)\s*\}\}/g,
          encodeURIComponent(String(fileId))
        );
        progress({ stage: '生成完了，正在换取下载地址…' });
        const dl = await channels.callApi(channel, {
          path: dlPath,
          method: 'GET',
          contentType: 'none',
          timeoutSec: 60,
          signal: ctx && ctx.signal,
          where: 'download',
        });
        // 有的平台取件接口直接回视频 / 图片字节流（例如 xm API 的 /videos/{id}/content）：
        // 既没有 JSON、也没有「下载地址」字段，取件路径本身就是成片的地址。
        // 这里直接把它当成素材地址返回，交给 saveResult → fetchMedia 去下载
        //（那一步会带上通道鉴权，这类接口都要求 Bearer）。
        // 放在最前面判：二进制流不该再拿去扫正则，白费力气还可能误抓。
        if (!dl.json) return { url: dl.url };
        const direct = channels.pickByPaths(dl.json, record.downloadUrlField || 'downloadUrl');
        if (typeof direct === 'string' && /^https?:\/\//i.test(direct.trim())) return { url: direct.trim() };
        const again = channels.extractResult(dl.text, dl.json, {});
        if (again) return again;
        throw errorKinds.makeError('BAD_FORMAT', '取件接口没给出下载地址，检查「取件地址字段」' + tail);
      }
      throw errorKinds.makeError('BAD_FORMAT', '接口说完成了，但返回里没找到结果地址，检查「轮询结果地址路径」' + tail);
    }
  }
  // 等满了最长等待时间：这属于平台慢，不是配置错，给出「稍后重试或调小参数」的建议
  throw errorKinds.makeError(
    'PLATFORM_TIMEOUT',
    '等到超过通道里设的最长等待时间还没出结果（最后状态：' + lastState + '）'
  );
}

// 结果地址是不是这张卡片要的类型：视频卡片收到图片地址（常见于封面 / 预览图）就当没出片
function kindMatches(kind, found) {
  const url = String((found && (found.url || found.dataUrl)) || '');
  if (!url) return true;
  const clean = url.split('?')[0].split('#')[0].toLowerCase();
  const isVideo = /\.(mp4|mov|webm|m4v|mkv)$/.test(clean);
  const isImage = /\.(png|jpe?g|webp|gif|bmp|avif)$/.test(clean);
  if (kind === 'video') return !isImage;
  if (kind === 'image') return !isVideo;
  return true;
}

// 一次生成：选通道 → 组装请求 → 调用 → （需要就轮询）→ 存素材
// 服务端的统一收敛点：不管 payload 是谁拼的，进来都过一遍同一套参数规则。
//
// 之前三条入口各拼各的：单卡 / 批量走前端的 buildGeneratePayload，定时组在
// scheduler.js 里自己拼。同一个字段在两条路上含义不同（例如 mode：单卡没选就是空串，
// 定时组快照写死 reference），通道模板里的 {{mode}} 就会忽空忽有。
// 现在把规则收进 web/assets/payload-rules.js，前后端共用，这里做最后一道归一。
//
// 注意：只归一「参数」，不碰提示词 —— promptRaw / frozenTail 由调用方各自负责，
// resumeTask 还要靠它们接续重启前的任务。
function normalizePayload(payload, kind) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const nodeType = kind === 'video' ? src.nodeType || 'video' : kind || src.kind || 'image';
  return Object.assign({}, src, {
    kind: kind || src.kind || 'image',
    count: payloadRules.clampCount(src.count),
    mode: payloadRules.normalizeMode(nodeType, src.mode),
    refs: payloadRules.normalizeRefs(src.refs),
  });
}

// multipart 提交时，参考素材是通过文件字段上传的，
// 请求体里那三个「公网地址数组」必须去掉，否则平台会以为你同时传了地址和文件。
const MEDIA_URL_KEYS = ['imageUrls', 'videoUrls', 'audioUrls', 'image_urls', 'video_urls', 'audio_urls'];

function stripMediaUrlFields(bodyText) {
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyText;
  let changed = false;
  MEDIA_URL_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      delete parsed[key];
      changed = true;
    }
  });
  return changed ? JSON.stringify(parsed, null, 2) : bodyText;
}

// 参考素材 -> multipart 文件字段（images / videos / audios，多个同名字段重复）
function refFilesOf(refs) {
  const out = [];
  (refs || []).forEach((item, index) => {
    if (!item || !item.buffer || !item.buffer.length) return;
    const field = item.kind === 'video' ? 'videos' : item.kind === 'audio' ? 'audios' : 'images';
    const stem = String(item.name || 'ref' + (index + 1)).replace(/\.[A-Za-z0-9]{1,5}$/, '');
    out.push({
      field: field,
      buffer: item.buffer,
      mime: item.mime || 'application/octet-stream',
      name: stem + (item.ext || ''),
    });
  });
  return out;
}

async function runKind(config, kind, payload, ctx) {
  const progress = (ctx && ctx.progress) || function () {};
  const input = normalizePayload(payload, kind);
  const channel = channels.findChannel(config, {
    channelId: input.channelId,
    channelName: input.channelName,
    kind: kind,
    model: input.model,
  });
  const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
  if (!channel) throw errorKinds.configError('还没有能生成' + label + '的通道，先到门户页的「接口通道」里加一个');
  if (!channel.baseUrl) throw errorKinds.configError('通道「' + channel.name + '」还没填 Base URL');
  const spec = channel[kind];
  const model = resolveModel(channel, kind, input.model);
  // 先核参数再读素材：参数不合法的话，连下载参考图那一步都省了
  checkModelParams(model, kind, input, channel.id);
  const composed = composePrompt(config, input, kind);
  const prompt = composed.apiPrompt;
  if (!prompt) throw new Error('提示词是空的，先写点内容再生成');
  const count = input.count;
  const refs = await prepareRefs(config, input.refs, channel, progress, {
    always: submitCompressEnabled(config),
  });
  checkModelRefs(model, refs, kind, channel.id);
  await uploadRefs(channel, refs, ctx, progress);
  // 视频按分辨率算像素，图片按 1K/2K/4K 算
  const size = channels.sizeFor(channel, kind === 'video' ? input.resolution : input.sizeKey, input.ratio, kind);
  const vars = buildVars(input, channel, model, size, count, refs, kind);
  // 首尾帧任务字段往往和参考图任务不一样：通道里另写了 framesBody 就用它
  const frameJob = String(input.mode || '') === 'frames' && String(spec.framesBody || '').trim();
  const bodyTemplate = frameJob ? spec.framesBody : spec.body;
  let bodyText = pruneEmptyMedia(mergeExtra(channels.fillTemplate(bodyTemplate, vars), spec.extra));
  // 首尾帧只给了一张图时，平台要的是「首帧」模式：空着尾帧会被直接拒单
  if (frameJob) {
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch (error) {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      ['firstFrame', 'lastFrame'].forEach((key) => {
        if (typeof parsed[key] === 'string' && !parsed[key].trim()) delete parsed[key];
      });
      if (typeof parsed.mode === 'string' && parsed.mode === 'first_last' && !parsed.lastFrame) {
        parsed.mode = 'first_frame';
      }
      bodyText = JSON.stringify(parsed, null, 2);
    }
  }

  bodyText = pruneUnsupportedParams(bodyText, model, channel.id);
  // 参考图人脸处理：勾了这个模型才带 faceProcessing，没勾就把字段删掉
  bodyText = applyFaceProcessing(bodyText, spec.contentType, vars.faceProcessing === true);
  if (spec.contentType === 'json' || spec.contentType === 'form') {
    try {
      JSON.parse(bodyText);
    } catch (error) {
      throw errorKinds.configError('通道「' + channel.name + '」的请求体模板不是合法 JSON：' + error.message);
    }
  }
  // 有的平台会把整份请求体读进内存（520ruo 的网关就是），超过 64 MB 直接 413。
  // 内嵌 Base64 的通道最容易撞到这条：Base64 本身就要比原文件大 1/3。
  // 在本地就算好体积并给出可操作的建议，别让用户等半天才看到一句 "413"。
  //
  // 只在通道里**显式配了** maxBodyMB 时才检查：别的通道可能有自己的规则，
  // 不该因为我们给一个平台加的护栏而受影响。
  const maxBodyMB = Number(spec.maxBodyMB);
  if (Number.isFinite(maxBodyMB) && maxBodyMB > 0) {
    const bodyBytes = Buffer.byteLength(bodyText, 'utf8');
    if (bodyBytes > maxBodyMB * 1024 * 1024) {
      const mb = (bodyBytes / 1024 / 1024).toFixed(1);
      throw new Error(
        '这次请求体有 ' + mb + ' MB，超过通道设的 ' + maxBodyMB +
          ' MB 上限（参考素材是内嵌 Base64，会比原文件大 1/3）。先在卡片上减少参考图数量，或换成体积小一些的图再生成。'
      );
    }
  }

  // multipart 通道：本地参考素材直接当文件发，不再走公网地址
  const isMultipart = spec.contentType === 'multipart';
  let submitFiles = [];
  if (isMultipart) {
    bodyText = stripMediaUrlFields(bodyText);
    submitFiles = refFilesOf(refs);
    if (refs.length && !submitFiles.length) {
      throw errorKinds.configError('这个通道要用 multipart 上传参考素材，但素材内容没读出来');
    }
  }
  progress({ stage: '正在请求 ' + (channel.name || '接口') });
  // 请求头里也允许写占位符（常见的是每次请求换一个幂等键）
  const extraHeaders = {};
  Object.keys(spec.headers || {}).forEach((key) => {
    if (key) extraHeaders[key] = channels.fillTemplate(spec.headers[key], vars);
  });
  const data = await channels.callApi(channel, {
    path: spec.path,
    method: spec.method,
    contentType: spec.contentType,
    extraHeaders: extraHeaders,
    bodyText: bodyText,
    files: submitFiles,
    timeoutSec: spec.timeoutSec,
    signal: ctx && ctx.signal,
    where: 'submit',
  });
  // 异步通道（配了轮询）又没写明结果路径时，提交响应里常常只有封面 / 预览图，
  // 按文本撮会把封面当成成品、跳过轮询。这里只按配置的路径取，取不到就交给轮询。
  let found =
    spec.poll && spec.poll.enabled && !String(spec.resultUrl || '').trim()
      ? null
      : channels.extractResult(data.text, data.json, spec);
  if (!found && spec.poll && spec.poll.enabled) {
    const remoteId = channels.pickByPath(data.json, spec.poll.taskIdPath);
    if (!remoteId) {
      throw errorKinds.configError(
        '这个通道设成了「异步接口」，但接口返回里没找到任务号',
        '检查通道的「任务号取值路径」。返回片段：' + snippet(data.text, 200)
      );
    }
    const record = buildWaitRecord(channel, kind, spec, input, model, size, prompt, remoteId, refs);
    // 记下这条记录：万一服务重启，起来后还能接着等，不用重新生成一遍
    if (ctx && ctx.attach) ctx.attach(record);
    progress({ stage: '已提交，正在等接口出结果…' });
    found = await pollRemote(config, channel, kind, record, ctx, progress);
  }
  if (!found) {
    throw errorKinds.configError('接口返回里没找到素材地址', '检查通道的「结果取值路径」。返回片段：' + snippet(data.text, 220));
  }
  progress({ stage: '正在保存到 素材\\' + (KIND_FOLDER[kind] || '图片') });
  const saved = await saveResult(config, found, channel, prompt, kind, subFolderOf(config, input));
  return {
    relPath: saved.relPath,
    url: saved.url,
    width: saved.width,
    height: saved.height,
    bytes: saved.bytes,
    kind: kind,
    channel: channel.name,
    channelId: channel.id,
    model: model,
    size: size,
    count: count,
    refCount: refs.length,
    refBytesBefore: refs.refStats ? refs.refStats.beforeBytes : 0,
    refBytesAfter: refs.refStats ? refs.refStats.afterBytes : 0,
    refCompressed: refs.refStats ? refs.refStats.compressedCount : 0,
  };
}

// 提交前预检：只读素材、按通道规则试压一遍，绝不调用上传和生成接口。
// 返回可提交数量、压缩前后体积和可读的问题说明，供批量提交前先给用户看一眼。
async function preflight(config, payload) {
  const asked = String((payload && payload.kind) || 'image');
  const kinds = Object.keys(KIND_FOLDER);
  const askedKind = kinds.indexOf(asked) >= 0 ? asked : 'image';
  // 预检必须按「真正提交时的那套参数」走，否则用户看到的检查结果和实际生成对不上
  payload = normalizePayload(payload, askedKind);
  const kind = askedKind;
  const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
  const out = {
    ok: false,
    kind: kind,
    label: label,
    model: '',
    channel: '',
    promptLength: 0,
    tailName: '',
    tailLength: 0,
    refCount: 0,
    beforeBytes: 0,
    afterBytes: 0,

    compressedCount: 0,
    faceProcessing: false,
    warnings: [],
    error: '',
  };
  try {
    const channel = channels.findChannel(config, {
      channelId: payload && payload.channelId,
      channelName: payload && payload.channelName,
      kind: kind,
      model: payload && payload.model,
    });
    if (!channel) throw errorKinds.configError('没有能生成' + label + '的可用通道，先检查接口通道设置');
    if (!channel.baseUrl) throw errorKinds.configError('通道「' + channel.name + '」还没填 Base URL');
    const model = resolveModel(channel, kind, payload && payload.model);
    out.model = model || '';
    out.channel = channel.name || '';
    // 预检要跟真提交用同一套参数校验，否则会出现「预检说没问题、一点就 400」的落差
    checkModelParams(model, kind, payload, channel.id);
    const submission = composeSubmission(config, payload, kind);
    out.promptLength = submission.apiPrompt.length;
    out.tailName = submission.tailPresetName || '';
    out.tailLength = submission.tailText ? submission.tailText.length : 0;
    if (submission.tailEnabled && !submission.tailAppended) out.warnings.push('主提示词里已经包含这段尾部文字，本次不会重复追加');
    const refs = await prepareRefs(config, (payload && payload.refs) || [], channel, null, {
      always: submitCompressEnabled(config),
    });
    checkModelRefs(model, refs, kind, channel.id);
    out.refCount = refs.length;
    const stats = refs.refStats || {};
    out.beforeBytes = Number(stats.beforeBytes) || 0;
    out.afterBytes = Number(stats.afterBytes) || 0;
    out.compressedCount = Number(stats.compressedCount) || 0;

    // 这次提交会不会开人脸处理，提交前就先让用户看见
    const faceOn = faceWanted(payload, channel, model, refs, kind);
    out.faceProcessing = faceOn;
    if (faceOn) out.warnings.push('参考图会先做一次人脸处理（不额外收费）');
    if (out.beforeBytes && out.afterBytes < out.beforeBytes) {
      out.warnings.push('参考素材会从 ' + mbText(out.beforeBytes) + ' MB 压到 ' + mbText(out.afterBytes) + ' MB 再提交');
    }
    out.ok = true;
    return out;
  } catch (error) {
    out.error = (error && error.message) || String(error);
    return out;
  }
}

async function generateImage(config, payload, ctx) {
  return runKind(config, 'image', payload, ctx);
}

// 服务重启后接着等：拿之前记下的任务号继续轮询，不再提交一遍
// options.refetch：用户手动点「重新拉取」时传 true。
// 这时整条任务早就超过最长等待时间了，必须从「现在」重新给一段取件窗口，
// 否则 pollRemote 一进去就判超时、一个请求都不发（这就是「平台明明出片了，
// 本地却永远拉不回来」的那个 bug）。
async function resumeTask(config, task, ctx, options) {
  const opts = options || {};
  const stored = task && task.resume ? task.resume : null;
  const record = stored && opts.refetch ? Object.assign({}, stored, { refetch: true }) : stored;
  const progress = (ctx && ctx.progress) || function () {};
  if (!record || !record.remoteId) throw new Error('这条任务没有可接续的信息（服务重启前还没拿到任务号）');
  const kind = record.kind || task.kind || 'image';
  const channel = channels.findChannel(config, {
    channelId: record.channelId,
    channelName: record.channelName,
    kind: kind,
    model: record.model,
    // 这条任务早在停用之前就提交出去了，钱也花了；现在只是回来取结果，
    // 通道状态不该影响取件。includeDisabled 让它照常命中。
    includeDisabled: true,
  });
  if (!channel) throw new Error('这条任务用的通道已经删掉了，没法接着等结果');
  progress({ stage: '接着等重启前提交的任务…' });
  const found = await pollRemote(config, channel, kind, record, ctx, progress);
  progress({ stage: '正在保存到 素材\\' + (KIND_FOLDER[kind] || '图片') });
  // 归档子目录按设置走（按日期 / 按画布名字），重启接续的任务也要落到同一层
  const saved = await saveResult(
    config,
    found,
    channel,
    record.prompt || task.prompt || '生成结果',
    kind,
    subFolderOf(config, { canvasId: task.canvasId })
  );
  return {
    relPath: saved.relPath,
    url: saved.url,
    width: saved.width,
    height: saved.height,
    bytes: saved.bytes,
    kind: kind,
    channel: channel.name,
    channelId: channel.id,
    model: record.model || task.model || '',
    size: record.size || '',
    count: 1,
    // 重启接续的任务也能报出「这次用了几个参考素材」，卡片展示才完整
    refCount: Array.isArray(record.refs) ? record.refs.length : 0,
    resumed: true,
  };
}

// 门户页的「试生成」：用第一条可用模型跑一张小图，确认链路通不通
async function testImage(config, payload) {
  const model = String(payload.model || '').trim();
  const channel = channels.findChannel(config, {
    channelId: payload.channelId,
    channelName: payload.channelName,
    kind: 'image',
    model: model,
  });
  if (!channel) throw errorKinds.configError('这个通道没有图片模型，先在上面把模型填进去');
  const prompt = String(payload.prompt || '一只橘色小猫坐在木桌上，柔和光线').trim();
  const result = await generateImage(
    config,
    {
      prompt: prompt,
      model: model,
      channelId: channel.id,
      sizeKey: payload.sizeKey || '1K',
      ratio: payload.ratio || '16:9',
      count: 1,
      refs: [],
    },
    { progress: function () {} }
  );
  return result;
}

// 视频来源可能是 /media 地址、远端地址或 data URL，统一落到一个本地文件上
async function sourceToFile(config, source) {
  const text = String(source || '').trim();
  if (!text) throw new Error('没给视频地址');
  if (text.indexOf('/media/') === 0) {
    const abs = assets.resolveMedia(config.assetRoot, text.slice('/media/'.length));
    if (!abs || !fs.existsSync(abs)) throw new Error('这个视频的文件不在了：' + text);
    return { file: abs, temp: false };
  }
  if (assets.isDataUrl(text)) {
    const decoded = assets.decodeDataUrl(text);
    if (!decoded) throw new Error('视频内容解不开');
    return { file: tempFileOf(decoded.buffer, '.mp4'), temp: true };
  }
  if (/^https?:\/\//i.test(text)) {
    const got = await assets.fetchBuffer(text, {}, 300000);
    return { file: tempFileOf(got.buffer, assets.extFromUrl(text) || '.mp4'), temp: true };
  }
  if (fs.existsSync(text)) return { file: text, temp: false };
  throw new Error('认不出这个视频地址：' + text);
}

// 抽某段视频的最后一帧，存进 素材\尾帧
async function extractLastFrame(config, source, label, sub) {
  const located = await sourceToFile(config, source);
  const shot = path.join(os.tmpdir(), 'canvas-frame-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.png');
  try {
    const info = await lastframe.extractLastFrame(located.file, shot);
    const buffer = fs.readFileSync(shot);
    if (!buffer.length) throw new Error('抽出来的画面是空的');
    const base = assets.stampName() + '_' + assets.safeName(label, '尾帧', 30) + '_尾帧';
    const abs = assets.writeAsset(config.assetRoot, '尾帧', base, '.png', buffer, sub);
    const rel = assets.relToRoot(abs, config.assetRoot);
    const size = assets.sizeOf(buffer);
    return {
      relPath: rel,
      url: assets.mediaUrl(rel),
      width: size ? size.width : 0,
      height: size ? size.height : 0,
      bytes: buffer.length,
      kind: 'image',
      frames: info.frames,
    };
  } finally {
    try {
      fs.unlinkSync(shot);
    } catch (error) {
      /* 临时文件删不掉不影响结果 */
    }
    if (located.temp) {
      try {
        fs.unlinkSync(located.file);
      } catch (error) {
        /* 同上 */
      }
    }
  }
}


// 从一段视频的尾部截出后 N 秒，存进 素材\视频\尾段
//
// 用途：给下一段视频当衔接参考 —— 上一段最后几秒的运动趋势、镜头方向和节奏，
// 直接喂给下一个模型，比只给一张尾帧更能把动作接上。
//
// 为什么重编码而不是 -c copy：
//   流拷贝只能从关键帧切。实测库里视频的关键帧间隔平均 2.2 秒、最大 3 秒，
//   末尾很容易多切出一截重复画面，正好毁掉衔接。重编码 5 秒只要 0.2 秒，
//   10 秒约 1 秒，换来帧级精确的 5.000 / 10.000，这点开销值得。
//
// 比目标短怎么办：不报错，整段拿走，并在返回值里标明 truncated，
//   让前端能直接说清楚「这段只有 5.2 秒，已取整段」。
async function extractTailClip(config, source, label, sub, wantSeconds) {
  const tools = paths.toolsInfo();
  if (!tools.ffmpeg) {
    throw new Error('还没放视频解码工具：把 ffmpeg.exe 放进 tools 目录，取尾段就能用');
  }
  const seconds = Number(wantSeconds) || 0;
  if (!(seconds > 0)) throw new Error('没说清楚要取后面几秒');
  const located = await sourceToFile(config, source);
  const stamp = Date.now() + '-' + Math.random().toString(16).slice(2);
  const tmp = path.join(os.tmpdir(), 'canvas-tail-' + stamp + '.mp4');
  try {
    const sourceInfo = tools.ffprobe ? await tailclip.probeVideo(tools.ffprobe, located.file) : { width: 0, height: 0, duration: 0, fps: 0 };
    const duration = sourceInfo.duration || (tools.ffprobe ? await tailclip.probeDuration(tools.ffprobe, located.file) : 0);
    if (!(duration > 0)) throw new Error('这段视频读不出时长，可能文件坏了，换一段再试');
    // 视频本身比要的还短：整段取走，不报错
    const truncated = duration < seconds - 0.05;
    const grabbed = Math.min(seconds, duration);
    const start = Math.max(0, duration - grabbed);
    const args = [
      '-y', '-v', 'error',
      // -ss 放在 -i 前面：先跳到位置再解码，长视频也不用从头解一遍
      '-ss', start.toFixed(3),
      '-i', located.file,
      '-t', grabbed.toFixed(3),
      // 只留第一路视频 + 有就带上音频：参考视频带声音不影响模型，
      // 但用户以后要剪成片时不用再补一遍
      '-map', '0:v:0', '-map', '0:a?',
      // 统一转成 yuv420p：浏览器和绝大多数平台都只认这个，
      // 源视频本来就是 8bit yuv420p，等于无损延续
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      tmp,
    ];
    await tailclip.runTool(tools.ffmpeg, args, 600000);
    const buffer = fs.readFileSync(tmp);
    if (!buffer.length) throw new Error('截出来的尾段是空的');
    // 文件名带上真实时长：被截短时一眼就能看出来不是整 5 秒
    const shown = (Math.round(grabbed * 10) / 10).toString().replace(/\.0$/, '');
    const base = assets.stampName() + '_' + assets.safeName(label, '尾段', 30) + '_尾' + shown + 's';
    // 归档：统一落在 视频\尾段 下；设置里如果还开了按日期 / 画布分子目录，就再往下落一层
    const folderSub = sub ? '尾段/' + sub : '尾段';
    const abs = assets.writeAsset(config.assetRoot, '视频', base, '.mp4', buffer, folderSub);
    const rel = assets.relToRoot(abs, config.assetRoot);
    return {
      relPath: rel,
      url: assets.mediaUrl(rel),
      kind: 'video',
      width: sourceInfo.width || 0,
      height: sourceInfo.height || 0,
      bytes: buffer.length,
      seconds: Math.round(grabbed * 100) / 100,
      sourceSeconds: Math.round(duration * 100) / 100,
      truncated: truncated,
    };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (error) {
      /* 临时文件删不掉不影响结果 */
    }
    if (located.temp) {
      try {
        fs.unlinkSync(located.file);
      } catch (error) {
        /* 同上 */
      }
    }
  }
}

module.exports = {
  // 仅供测试：直接跑轮询循环，不用真请求平台
  __pollRemote: pollRemote,
  stripMediaUrlFields,
  refFilesOf,

  applyFaceProcessing,
  faceWanted,
  checkModelRefs,
  checkModelParams,
  buildVars,
  pruneEmptyMedia,
  pruneUnsupportedParams,
  promptForApi,
  remapRefNamesInPrompt,
  normalizeTailChoice,
  // C5：三入口参数统一的收敛点，导出供测试直接比对前后端规则是否一致
  normalizePayload,
  payloadRules,
  resolveTail,
  composePrompt,
  composeSubmission,
  // 提交快照的组装（含参考素材冻结）：导出供测试直接校验，不必真跑一次生成
  buildWaitRecord,
  waitRefsOf,
  preflight,
  prepareRefs,
  fitRefsToLimits,
  submitCompressEnabled,
  compressImage,
  uploadRefs,
  testRefUpload,
  extractLastFrame,
  extractTailClip,
  subFolderOf,
  resolveModel,
  runKind,
  generateImage,
  resumeTask,
  testImage,
  saveResult,
};
