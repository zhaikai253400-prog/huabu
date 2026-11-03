'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const channels = require('./channels');
const assets = require('./assets');
const lastframe = require('./lastframe');
const store = require('./store');
const modelSpecs = require('./model-specs');
const errorKinds = require('./error-kinds');
// 参数装配规则与前端共用同一份源码（web 目录下的 UMD 模块，浏览器 <script> 直接加载）
const payloadRules = require('../web/assets/payload-rules.js');

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

// 送接口前把提示词里的 @[图1] 收拾成平台看得懂的写法
function promptForApi(text) {
  return String(text || '')
    .replace(/@\[([^\]\n]+)\]/g, (all, tag) => String(tag).replace(/^@+/, '').trim())
    .replace(/@(?=[图视音])/g, '');
}

// ---------- 尾部提示词 ----------
// 卡片只记「用哪一套」；真正的文字每轮提交时从设置里取，改预设不用回头改卡片。
// 旧卡片没有 tailPrompt 字段时视为不启用，绝不擅自追加。
function normalizeTailChoice(value) {
  // 与前端共用同一份规则，避免「前端认 true、服务端只认对象」这类漂移
  return payloadRules.normalizeTailChoice(value);
}

function tailPresetsOf(config) {
  return config && config.tailPrompts && Array.isArray(config.tailPrompts.presets)
    ? config.tailPrompts.presets
    : [];
}

function resolveTail(config, payload) {
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
  const global = config && config.tailPrompts ? config.tailPrompts : { enabled: true, presets: [] };
  const choice = normalizeTailChoice(payload && payload.tailPrompt);
  const override = payload && payload.tailOverride && typeof payload.tailOverride === 'object' ? payload.tailOverride : null;
  if (override && override.mode === 'none') return { enabled: false, presetId: '', name: '', text: '' };
  if (!global.enabled) return { enabled: false, presetId: '', name: '', text: '' };
  if (!choice.enabled && !(override && override.presetId)) return { enabled: false, presetId: '', name: '', text: '' };
  const presetId = String((override && override.presetId) || choice.presetId || global.defaultId || '');
  if (!presetId) return { enabled: false, presetId: '', name: '', text: '' };
  const preset = tailPresetsOf(config).find((item) => item && String(item.id) === presetId);
  if (!preset) throw new Error('这张卡片引用的尾部提示词原预设已删除，请重新选一套，或关闭这张卡片的尾部提示词');
  const text = String(preset.text || '').trim();
  if (!text) return { enabled: false, presetId: presetId, name: String(preset.name || ''), text: '' };
  return { enabled: true, presetId: presetId, name: String(preset.name || '尾部提示词'), text: text };
}

// 主提示词照旧处理 @[图1]；尾部提示词是纯文字，里面的 @ 原样保留，不再二次处理
function composePrompt(config, payload) {
  const rawMain = String((payload && (payload.promptRaw || payload.prompt)) || '');
  const main = promptForApi(rawMain).trim();
  const tail = resolveTail(config, payload);
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

function composeSubmission(config, payload) {
  const composed = composePrompt(config, payload);
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
    if (always || needShrink()) {
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
        const steps = compressionSteps(cfg, always);
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
      remoteUrl: '',
      remoteId: '',
    });
  }
  const stats = await fitRefsToLimits(out, channel, progress, options);
  out.refStats = stats;
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

// 通道开了「先上传素材」就挨个传一遍，拿到平台给的地址 / 编号
async function uploadRefs(channel, refs, ctx, progress) {
  const spec = channel && channel.upload;
  if (!spec || !spec.enabled || !refs.length) return refs;
  if (!String(spec.path || '').trim()) throw errorKinds.configError('通道「' + channel.name + '」开了「先上传素材」，但没填上传路径');
  for (let index = 0; index < refs.length; index += 1) {
    const item = refs[index];
    if (ctx && ctx.signal && ctx.signal.aborted) throw new Error('已取消');
    progress({ stage: '正在上传参考素材 ' + (index + 1) + '/' + refs.length + '…' });
    // 名字里已经带了后缀就别再加一遍
    const stem = String(item.name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
    item.fileName = assets.safeName(stem, 'ref', 40) + (item.ext || '');
    const data = await channels.callUpload(channel, spec, item);
    const url = spec.resultUrl ? channels.pickByPath(data.json, spec.resultUrl) : '';
    const id = spec.resultId ? channels.pickByPath(data.json, spec.resultId) : '';
    if (!url && !id) {
      throw errorKinds.configError(
        '上传「' + item.name + '」之后没拿到素材地址或编号',
        '检查通道的「上传结果取值路径」。返回片段：' + snippet(data.text, 200)
      );
    }
    item.remoteUrl = url ? String(url) : '';
    item.remoteId = id ? String(id) : '';
  }
  return refs;
}

async function fetchMedia(config, found, channel) {
  if (found.base64) return { buffer: Buffer.from(found.base64, 'base64'), mime: '' };
  const dataUrl = found.dataUrl || (found.url && assets.isDataUrl(found.url) ? found.url : '');
  if (dataUrl) {
    const decoded = assets.decodeDataUrl(dataUrl);
    if (!decoded) throw new Error('素材内容解不开');
    return { buffer: decoded.buffer, mime: decoded.mime };
  }
  try {
    return await assets.fetchBuffer(found.url, {}, 300000);
  } catch (error) {
    // 有的平台下载地址也要带密钥，那就补上再试一次
    return await assets.fetchBuffer(found.url, channels.buildHeaders(channel), 300000);
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

// 通道级参考图上限取的是「这个通道最宽松的模型」（例如通道5 放 13 张给 Nano），
// 但 GPT 系列只收 9 张。这里按模型再卡一次，别等平台 400 才知道超了。
function checkModelRefs(model, refs, kind) {
  const spec = modelSpecs.forModel(model);
  const max = Number(spec && spec.maxRefs);
  if (!max || !Number.isFinite(max) || max <= 0) return;
  const images = (refs || []).filter((item) => item && (item.kind === 'image' || !item.kind));
  if (images.length <= max) return;
  throw new Error('模型「' + model + '」最多接 ' + max + ' 张参考图，现在带了 ' + images.length + ' 张，先在卡片上减几张再生成');
}

function buildVars(payload, channel, model, size, count, refs, kind) {
  // kind 决定去通道里查哪一份人脸处理名单
  const vars = {
    requestId: crypto.randomUUID(),
    prompt: String(payload.apiPrompt || promptForApi(payload.prompt || payload.promptRaw || '')),
    promptRaw: String(payload.promptRaw || payload.prompt || ''),
    model: model,
    n: count,
    size: size,
    sizeKey: String(payload.sizeKey || ''),
    ratio: String(payload.ratio || ''),
    duration: Number(payload.duration) || 0,
    // 图片卡片上选的 1K / 2K / 4K 存在 sizeKey 里（视频才是 resolution），
    // 这里统一折算成接口要的 resolution 字段，别让卡片选 4K 却按默认 1K 出图。
    resolution: (function () {
      const raw = String(payload.resolution || (kind === 'image' ? payload.sizeKey : '') || '').trim();
      const spec = modelSpecs.forModel(model);
      // 有的模型只开了一档清晰度（例如 nano-banana-2-lite 固定 1K），
      // 卡片上就算还留着旧值，也按平台支持的那一档发，免得直接 400。
      if (spec && Array.isArray(spec.sizes) && spec.sizes.length) {
        const hit = spec.sizes.find((item) => String(item).toLowerCase() === raw.toLowerCase());
        if (hit) return String(hit).toUpperCase();
        return String(spec.defaultResolution || spec.sizes[0]).toUpperCase();
      }
      if (raw) return raw.toUpperCase();
      return spec && spec.defaultResolution ? spec.defaultResolution : '';
    })(),
    resolutionLower: (function () {
      const raw = String(payload.resolution || (kind === 'image' ? payload.sizeKey : '') || '').trim();
      if (raw) return raw.toLowerCase();
      const spec = modelSpecs.forModel(model);
      return spec && spec.defaultResolution ? spec.defaultResolution.toLowerCase() : '';
    })(),
    mode: String(payload.mode || ''),
    refs: refs.map(refUrlOf),
    refCount: refs.length,
    refNames: refs.map((item) => item.name),
    refKinds: refs.map((item) => item.kind || ''),
    refImages: refs.filter((item) => item.kind === 'image').map(refUrlOf),
    refVideos: refs.filter((item) => item.kind === 'video').map(refUrlOf),
    refAudios: refs.filter((item) => item.kind === 'audio').map(refUrlOf),
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
  const spec = modelSpecs.forModel(model);
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
  if (wantFrames) vars.taskType = 'VIDEO_IMAGE_TO_VIDEO';
  else vars.taskType = refs.length ? 'VIDEO_REFERENCE' : 'VIDEO_TEXT_TO_VIDEO';
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
  'refs',
  'audioRefs',
  'videoRefs',
  'attachments',
  'inputFiles',
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

function pruneUnsupportedParams(bodyText, model) {
  const spec = modelSpecs.forModel(model);
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
  const deadline = Number(record.deadlineAt) || Date.now() + Math.max(30, Number(record.maxWaitSec) || 1800) * 1000;
  const doneWords = splitWords(record.doneValues);
  const failWords = splitWords(record.failValues);
  const startedAt = Number(record.startedAt) || Date.now();
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
    let found = record.downloadPath
      ? null
      : channels.extractResult(scanText, taskNode, {
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
        const fileId = channels.pickByPath(taskNode, record.downloadIdPath);
        if (!fileId) {
          throw errorKinds.makeError('BAD_FORMAT', '任务完成了，但返回里没找到结果文件号，检查「取件文件号路径」' + tail);
        }
        const dlPath = String(record.downloadPath).replace(
          /\{\{\s*(fileId|file_id|id)\s*\}\}/g,
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
        const direct = channels.pickByPath(dl.json, record.downloadUrlField || 'downloadUrl');
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
  const composed = composePrompt(config, input);
  const prompt = composed.apiPrompt;
  if (!prompt) throw new Error('提示词是空的，先写点内容再生成');
  const count = input.count;
  const refs = await prepareRefs(config, input.refs, channel, progress, {
    always: submitCompressEnabled(config),
  });
  checkModelRefs(model, refs, kind);
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

  bodyText = pruneUnsupportedParams(bodyText, model);
  // 参考图人脸处理：勾了这个模型才带 faceProcessing，没勾就把字段删掉
  bodyText = applyFaceProcessing(bodyText, spec.contentType, vars.faceProcessing === true);
  if (spec.contentType === 'json' || spec.contentType === 'form') {
    try {
      JSON.parse(bodyText);
    } catch (error) {
      throw errorKinds.configError('通道「' + channel.name + '」的请求体模板不是合法 JSON：' + error.message);
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
    const submission = composeSubmission(config, payload);
    out.promptLength = submission.apiPrompt.length;
    out.tailName = submission.tailPresetName || '';
    out.tailLength = submission.tailText ? submission.tailText.length : 0;
    if (submission.tailEnabled && !submission.tailAppended) out.warnings.push('主提示词里已经包含这段尾部文字，本次不会重复追加');
    const refs = await prepareRefs(config, (payload && payload.refs) || [], channel, null, {
      always: submitCompressEnabled(config),
    });
    checkModelRefs(model, refs, kind);
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
async function resumeTask(config, task, ctx) {
  const record = task && task.resume ? task.resume : null;
  const progress = (ctx && ctx.progress) || function () {};
  if (!record || !record.remoteId) throw new Error('这条任务没有可接续的信息（服务重启前还没拿到任务号）');
  const kind = record.kind || task.kind || 'image';
  const channel = channels.findChannel(config, {
    channelId: record.channelId,
    channelName: record.channelName,
    kind: kind,
    model: record.model,
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

module.exports = {

  applyFaceProcessing,
  faceWanted,
  checkModelRefs,
  buildVars,
  pruneEmptyMedia,
  pruneUnsupportedParams,
  promptForApi,
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
  extractLastFrame,
  subFolderOf,
  resolveModel,
  runKind,
  generateImage,
  resumeTask,
  testImage,
  saveResult,
};
