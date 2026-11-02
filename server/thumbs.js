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

function runFfmpeg(args) {
  const tools = paths.toolsInfo();
  if (!tools.ffmpeg) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(tools.ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function buildThumb(source, ext, output) {
  ensureDir(path.dirname(output));
  const scale = "scale='min(" + MAX_SIDE + ",iw)':-2";
  const args = ext && VIDEO_EXT.has(ext)
    ? ['-y', '-ss', '0.05', '-i', source, '-frames:v', '1', '-vf', scale, '-c:v', 'libwebp', '-quality', String(QUALITY), output]
    : ['-y', '-i', source, '-vf', scale, '-c:v', 'libwebp', '-quality', String(QUALITY), output];
  await acquire();
  try {
    const ok = await runFfmpeg(args);
    if (!ok) {
      // 视频首帧偶尔落在黑场或者时间点越界：退回从头取第一帧
      if (ext && VIDEO_EXT.has(ext)) {
        const retry = ['-y', '-i', source, '-frames:v', '1', '-vf', scale, '-c:v', 'libwebp', '-quality', String(QUALITY), output];
        if (await runFfmpeg(retry)) return true;
      }
      try { fs.unlinkSync(output); } catch { /* 没生成就算了 */ }
      return false;
    }
    return fs.existsSync(output);
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
    .then((ok) => (ok ? output : null))
    .catch(() => null)
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
};
