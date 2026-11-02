'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// 数据根目录。测试请用环境变量隔离，不要事后改写本模块导出的常量：
//   CANVAS_DATA_DIR   —— 换掉整个 data/ 根（canvas.db、logs、recycle 会一起跟着走）
//   CANVAS_ASSET_ROOT —— 换掉素材目录
// 必须在 require 本模块之前设置好，因为下面这些路径都是加载时一次算定的。
const DATA_DIR = process.env.CANVAS_DATA_DIR
  ? path.resolve(process.env.CANVAS_DATA_DIR)
  : path.join(ROOT, 'data');
const ASSET_ROOT = process.env.CANVAS_ASSET_ROOT
  ? path.resolve(process.env.CANVAS_ASSET_ROOT)
  : path.join(ROOT, '素材');

const WEB_DIR = path.join(ROOT, 'web');
const TOOLS_DIR = path.join(ROOT, 'tools');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const RECYCLE_DIR = path.join(DATA_DIR, 'recycle');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DB_FILE = path.join(DATA_DIR, 'canvas.db');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');

const ASSET_FOLDERS = ['视频', '图片', '音频', '尾帧'];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureLayout() {
  ensureDir(DATA_DIR);
  ensureDir(LOG_DIR);
  ensureDir(RECYCLE_DIR);
  ensureDir(TOOLS_DIR);
  ensureDir(WEB_DIR);
  ensureDir(path.join(ROOT, 'runtime'));
}

function defaultAssetRoot() {
  return ASSET_ROOT;
}

// 供测试脚本调用的隔离自检：确认当前进程的数据目录确实在预期位置。
//
// 检查的是「导出对象上的当前值」，所以两种隔离方式都能覆盖：
//   1) 进程启动前设好 CANVAS_DATA_DIR（本模块加载时直接算成隔离路径）；
//   2) 模块加载之后由测试助手改写 module.exports.DATA_DIR / DB_FILE 等字段。
// 不通过就抛错，避免「以为隔离了、其实写进真实库」。
function assertDataDir(expectedDir) {
  const want = path.resolve(expectedDir);
  const out = module.exports;
  const got = path.resolve(out.DATA_DIR);
  if (got !== want) {
    throw new Error(
      '数据目录隔离失败：期望 ' + want + '，实际 ' + got + '。\n' +
      '请在 require 任何 server 模块之前设置环境变量 CANVAS_DATA_DIR=' + want + '，' +
      '或用 tools/tests/_isolate.js 统一处理。'
    );
  }
  if (path.resolve(out.DB_FILE) !== path.join(want, 'canvas.db')) {
    throw new Error('数据库路径没跟着数据目录走：' + out.DB_FILE);
  }
  return true;
}

function ensureAssetLayout(assetRoot) {
  const created = [];
  for (const folder of ASSET_FOLDERS) {
    const target = path.join(assetRoot, folder);
    if (!fs.existsSync(target)) {
      ensureDir(target);
      created.push(folder);
    }
  }
  return created;
}

function toRelative(absPath) {
  if (!absPath) return '';
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function toAbsolute(relPath) {
  if (!relPath) return '';
  if (path.isAbsolute(relPath)) return relPath;
  return path.resolve(ROOT, relPath);
}

function dirWritable(dir) {
  try {
    ensureDir(dir);
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function toolsInfo() {
  const find = (...names) => {
    for (const name of names) {
      const target = path.join(TOOLS_DIR, name);
      if (fs.existsSync(target)) return target;
    }
    return null;
  };
  return {
    ffmpeg: find('ffmpeg.exe', 'ffmpeg'),
    ffprobe: find('ffprobe.exe', 'ffprobe'),
  };
}

module.exports = {
  ROOT,
  WEB_DIR,
  DATA_DIR,
  ASSET_ROOT,
  TOOLS_DIR,
  LOG_DIR,
  RECYCLE_DIR,
  CONFIG_FILE,
  DB_FILE,
  RUNTIME_FILE,
  ASSET_FOLDERS,
  ensureDir,
  ensureLayout,
  ensureAssetLayout,
  defaultAssetRoot,
  assertDataDir,
  toRelative,
  toAbsolute,
  dirWritable,
  toolsInfo,
};
