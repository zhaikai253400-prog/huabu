'use strict';

// 卡片缩略图：用 ffmpeg 把原图 / 视频首帧压成小尺寸 webp，画布卡片默认只加载缩略图。
// 原图只在双击放大时才用，几十上百张卡片同时打开也不会把内存吃满。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const paths = require('./paths');
const assets = require('./assets');

const THUMB_DIR = path.join(paths.DATA_DIR, 'thumbs');
const MAX_SIDE = 720;
const QUALITY = 78;
// 同时最多跑几个 ffmpeg：开太多会把机器拖慢，反而更卡
const MAX_JOBS = 3;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

let running = 0;
const waiters = [];
const inflight = new Map();

// ===== 失败诊断 =====
// 缩略图生成失败以前是彻底静默的：卡片默默回退到原图，用户只觉得「怎么这么卡」，
// 完全不知道为什么。最常见的两种情况是「tools 里没放 ffmpeg」和「这条视频
// ffmpeg 解不出首帧」，两者的处理方式完全不同，但界面上长得一模一样。
// 这里把失败记进一个环形缓冲区（去重、带次数），日志面板里能看见。
const FAIL_KEEP = 60; // 最多留多少条不同的失败
const failLog = new Map(); // key = relPath + 原因 → { relPath, reason, at, seq, count }
const failOrder = []; // 记录插入顺序，用来裁剪最老的
// 同一毫秒内可能记下好几条，光按 at 排序顺序不稳定（谁先谁后看引擎心情）。
// 加一个只增不减的序号，排序时用它兜底，保证「最新的真的排最前面」。
let failSeq = 0;

function trimFailures() {
  while (failOrder.length > FAIL_KEEP) {
    const oldest = failOrder.shift();
    failLog.delete(oldest);
  }
}

// reason 只留一句摘要：ffmpeg 的 stderr 又长又吵，整段贴进日志面板没人看得下去
function reasonSummary(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'ffmpeg 没有给出原因';
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
}

function recordFailure(relPath, reason) {
  const cleanPath = String(relPath || '').trim();
  const cleanReason = reasonSummary(reason);
  const key = cleanPath + '\u0000' + cleanReason;
  const hit = failLog.get(key);
  if (hit) {
    hit.count += 1;
    hit.at = Date.now();
    hit.seq = ++failSeq;
    return hit;
  }
  const item = { relPath: cleanPath, reason: cleanReason, at: Date.now(), seq: ++failSeq, count: 1 };
  failLog.set(key, item);
  failOrder.push(key);
  trimFailures();
  return item;
}

// 失败清单：最近的在前面，供 /api/log 一并返回
function listFailures() {
  return failOrder
    .map((key) => failLog.get(key))
    .filter(Boolean)
    .sort((a, b) => b.at - a.at || b.seq - a.seq);
}

function clearFailures() {
  failLog.clear();
  failOrder.length = 0;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function acquire() {
  if (running < MAX_JOBS) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else running = Math.max(0, running - 1);
}

function cacheKeyOf(relPath, stat) {
  return crypto
    .createHash('sha1')
    .update(String(relPath) + '|' + stat.size + '|' + Math.round(stat.mtimeMs))
    .digest('hex');
}

function cachePathOf(key) {
  return path.join(THUMB_DIR, key.slice(0, 2), key + '.webp');
}

// 跑一次 ffmpeg。成功返回 { ok: true }；失败返回 { ok: false, reason }，
// reason 是 stderr 的摘要（以前 stdio 设成 ignore，出错连个原因都拿不到）。
// ffmpeg 找不到时单独给出「没装」的说明，这跟「装了但解不动这个文件」不是一回事。
function runFfmpeg(args) {
  const tools = paths.toolsInfo();
  if (!tools.ffmpeg) {
    return Promise.resolve({ ok: false, reason: '没有找到 ffmpeg（tools 目录里没有 ffmpeg.exe）' });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(tools.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, reason: '启动 ffmpeg 失败：' + ((error && error.message) || error) });
      return;
    }
    let err = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        // 只留前 4KB：ffmpeg 报错动不动几页，够看出原因就行
        if (err.length < 4096) err += chunk.toString('utf8');
      });
    }
    child.on('error', (error) => done({ ok: false, reason: '启动 ffmpeg 失败：' + ((error && error.message) || error) }));
    child.on('exit', (code) => done(code === 0 ? { ok: true } : { ok: false, reason: err || ('ffmpeg 退出码 ' + code) }));
  });
}

// 返回 { ok, reason }：ok=false 时 reason 说明为什么没生成出来。
async function buildThumb(source, ext, output) {
  ensureDir(path.dirname(output));
  const scale = "scale='min(" + MAX_SIDE + ",iw)':-2";
  const args = ext && VIDEO_EXT.has(ext)
    ? ['-y', '-ss', '0.05', '-i', source, '-frames:v', '1', '-vf', scale, '-c:v', 'libwebp', '-quality', String(QUALITY), output]
    : ['-y', '-i', source, '-vf', scale, '-c:v', 'libwebp', '-quality', String(QUALITY), output];
  await acquire();
  try {
    const first = await runFfmpeg(args);
    if (first.ok) {
      if (fs.existsSync(output)) return { ok: true, reason: '' };
      return { ok: false, reason: 'ffmpeg 跑完了但没生成文件' };
    }
    // 视频首帧偶尔落在黑场或者时间点越界：退回从头取第一帧
    if (ext && VIDEO_EXT.has(ext)) {
      const retry = ['-y', '-i', source, '-frames:v', '1', '-vf', scale, '-c:v', 'libwebp', '-quality', String(QUALITY), output];
      const second = await runFfmpeg(retry);
      if (second.ok && fs.existsSync(output)) return { ok: true, reason: '' };
      // 两次都失败：记第二次的原因（从 0 秒取都失败，说明是文件本身的问题）
      try { fs.unlinkSync(output); } catch { /* 没生成就算了 */ }
      return { ok: false, reason: second.reason || first.reason };
    }
    try { fs.unlinkSync(output); } catch { /* 没生成就算了 */ }
    return { ok: false, reason: first.reason };
  } finally {
    release();
  }
}


// 返回缩略图的绝对路径；不支持的类型 / 生成失败返回 null，前端自动回退原图
function thumbFor(assetRoot, relPath) {
  const source = assets.resolveMedia(assetRoot, relPath);
  if (!source) return Promise.resolve(null);
  const ext = path.extname(source).toLowerCase();
  if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) return Promise.resolve(null);
  let stat;
  try {
    stat = fs.statSync(source);
  } catch {
    return Promise.resolve(null);
  }
  if (!stat.isFile()) return Promise.resolve(null);
  const key = cacheKeyOf(relPath, stat);
  const output = cachePathOf(key);
  if (fs.existsSync(output)) return Promise.resolve(output);
  if (inflight.has(key)) return inflight.get(key);
  const job = buildThumb(source, ext, output)
    .then((result) => {
      if (result.ok) return output;
      // 生成失败：记一条诊断（去重带次数），前端日志面板能看到原因
      recordFailure(relPath, result.reason);
      return null;
    })
    .catch((error) => {
      recordFailure(relPath, '生成缩略图时出错：' + ((error && error.message) || error));
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

function serveThumb(req, res, relPath) {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };
  thumbFor(configRoot(), relPath)
    .then((file) => {
      if (!file) return send(404, '这个素材没有缩略图');
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        return send(404, '缩略图还没准备好');
      }
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file).pipe(res);
    })
    .catch(() => send(404, '缩略图生成失败'));
}

// 由 index.js 注入当前素材根目录（用户可以在设置里改）
let assetRootResolver = () => paths.defaultAssetRoot();
function setAssetRootResolver(fn) {
  if (typeof fn === 'function') assetRootResolver = fn;
}
function configRoot() {
  return assetRootResolver();
}

module.exports = {
  THUMB_DIR,
  thumbFor,
  serveThumb,
  setAssetRootResolver,
  listFailures,
  clearFailures,
  recordFailure,
};
