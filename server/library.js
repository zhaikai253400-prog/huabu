'use strict';

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');
const assets = require('./assets');
const store = require('./store');

// 素材目录里的四个分类文件夹
const FOLDERS = [
  { folder: '图片', kind: 'image' },
  { folder: '视频', kind: 'video' },
  { folder: '音频', kind: 'audio' },
  { folder: '尾帧', kind: 'frame' },
];

const KIND_LABEL = { image: '图片', video: '视频', audio: '音频', frame: '尾帧' };

function walkFiles(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function summarize(items) {
  const byKind = { image: 0, video: 0, audio: 0, frame: 0 };
  const bytesByKind = { image: 0, video: 0, audio: 0, frame: 0 };
  let bytes = 0;
  for (const item of items) {
    bytes += item.size;
    if (byKind[item.kind] !== undefined) {
      byKind[item.kind] += 1;
      bytesByKind[item.kind] += item.size;
    }
  }
  return { count: items.length, bytes: bytes, byKind: byKind, bytesByKind: bytesByKind };
}

// 列出素材目录里的图片 / 视频 / 音频 / 尾帧，带筛选、搜索、排序
function listAssets(assetRoot, opts) {
  const options = opts || {};
  const kindFilter = String(options.kind || 'all');
  const keyword = String(options.q || '').trim().toLowerCase();
  const sort = String(options.sort || 'time');
  const items = [];
  for (const group of FOLDERS) {
    const dir = path.join(assetRoot, group.folder);
    for (const file of walkFiles(dir, [])) {
      const name = path.basename(file);
      const kind = group.kind;
      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const relPath = assets.relToRoot(file, assetRoot);
      items.push({
        name: name,
        relPath: relPath,
        url: assets.mediaUrl(relPath),
        folder: group.folder,
        kind: kind,
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }
  let list = items;
  if (kindFilter !== 'all') list = list.filter((item) => item.kind === kindFilter || (kindFilter === 'image' && item.kind === 'frame'));
  if (keyword) {
    list = list.filter(
      (item) => item.name.toLowerCase().indexOf(keyword) >= 0 || item.relPath.toLowerCase().indexOf(keyword) >= 0
    );
  }
  if (sort === 'name') list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  else if (sort === 'size') list = list.slice().sort((a, b) => b.size - a.size);
  else list = list.slice().sort((a, b) => b.mtime - a.mtime);
  return { items: list, stats: summarize(items), shown: list.length, total: items.length };
}

function stampName() {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' +
    pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds())
  );
}

// 删素材 = 挪到回收站目录，不当场销毁，后悔还能捞回来
function deleteAssets(assetRoot, relPaths) {
  const list = Array.isArray(relPaths) ? relPaths : [];
  const failed = [];
  let moved = 0;
  let target = '';
  if (list.length) {
    target = path.join(paths.RECYCLE_DIR, '素材-' + stampName());
    paths.ensureDir(target);
  }
  for (const rel of list) {
    const abs = assets.resolveMedia(assetRoot, rel);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      failed.push(rel);
      continue;
    }
    const dest = path.join(target, ...String(rel).split('/').filter(Boolean));
    try {
      paths.ensureDir(path.dirname(dest));
      fs.renameSync(abs, dest);
      moved += 1;
    } catch {
      try {
        fs.copyFileSync(abs, dest);
        fs.unlinkSync(abs);
        moved += 1;
      } catch {
        failed.push(rel);
      }
    }
  }
  return { moved: moved, failed: failed, recycle: target ? paths.toRelative(target) : '' };
}

// 画布里引用过的素材：节点里的 /media 地址和 relPath，加上任务结果路径
function collectReferences() {
  const refs = new Set();
  const addFrom = (text) => {
    if (!text) return;
    const urlPattern = /\/media\/([^"'\s)\\]+)/g;
    let match = urlPattern.exec(text);
    while (match) {
      let clean = match[1];
      try {
        clean = decodeURIComponent(clean);
      } catch {
        /* 保持原样 */
      }
      refs.add(clean.replace(/\\/g, '/'));
      match = urlPattern.exec(text);
    }
    const relPattern = /"relPath"\s*:\s*"([^"]+)"/g;
    match = relPattern.exec(text);
    while (match) {
      refs.add(match[1].replace(/\\/g, '/'));
      match = relPattern.exec(text);
    }
  };
  for (const canvas of store.listCanvases()) {
    const state = store.getState(canvas.id);
    if (state) addFrom(JSON.stringify(state));
  }
  for (const task of store.listTasks(500)) {
    addFrom(JSON.stringify({ resultPath: task.resultPath, result: task.result }));
  }
  return refs;
}

// 没有被任何画布引用的素材 = 孤儿
function orphanReport(config) {
  const all = listAssets(config.assetRoot, {}).items;
  const refs = collectReferences();
  const orphans = all.filter((item) => !refs.has(item.relPath));
  return { orphans: orphans, stats: summarize(orphans), total: all.length, referenced: refs.size };
}

module.exports = {
  FOLDERS,
  KIND_LABEL,
  listAssets,
  deleteAssets,
  orphanReport,
  collectReferences,
};
