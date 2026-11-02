'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, 'data');
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
  return path.join(ROOT, '素材');
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
  toRelative,
  toAbsolute,
  dirWritable,
  toolsInfo,
};
