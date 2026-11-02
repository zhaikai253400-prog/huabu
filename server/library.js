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

// 回收站：删掉的素材只是挪进 data\recycle，这里列出来给用户捞回去。
//
// 目录形状是 recycle\素材-2026-11-03_01-55-00\<原来的相对路径>，
// 也可能有别的来源（比如坏库挪存档）直接落在 recycle 根下，一并列出来。

// 每个批次目录算一个「删除时间」：取批次名里的时间戳，认不出来就用目录的改动时间
function batchTimeOf(name, dir) {
  const hit = String(name).match(/^素材-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (hit) {
    const at = new Date(hit[1], Number(hit[2]) - 1, hit[3], hit[4], hit[5], hit[6]).getTime();
    if (Number.isFinite(at)) return at;
  }
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

function listRecycle() {
  const root = paths.RECYCLE_DIR;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { batches: [], total: 0, bytes: 0 };
  }
  const batches = [];
  let total = 0;
  let bytes = 0;
  entries.forEach((entry) => {
    if (!entry.isDirectory()) return;
    const dir = path.join(root, entry.name);
    const files = [];
    walkFiles(dir, files);
    let size = 0;
    const items = files.map((full) => {
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        return null;
      }
      size += stat.size;
      // 相对批次目录的路径，还原时按同样结构摆回素材目录
      const rel = path.relative(dir, full).split(path.sep).join('/');
      return { rel: rel, bytes: stat.size, name: path.basename(full) };
    }).filter(Boolean);
    if (!items.length) return;
    // 单批次太多条会把面板撑爆，只报前 200 条，另附真实条数
    batches.push({
      id: entry.name,
      at: batchTimeOf(entry.name, dir),
      label: /^素材-/.test(entry.name) ? '删除的素材' : entry.name,
      count: items.length,
      bytes: size,
      items: items.slice(0, 200),
    });
    total += items.length;
    bytes += size;
  });
  batches.sort((a, b) => b.at - a.at);
  return { batches: batches, total: total, bytes: bytes };
}

// 把回收站里的文件摆回素材目录。同名已存在时不覆盖 —— 直接报冲突让用户自己决定，
// 免得把用户后来新做的同名素材盖掉。
function restoreRecycle(assetRoot, batchId, relPaths) {
  const batch = path.join(paths.RECYCLE_DIR, String(batchId || ''));
  // 防目录穿越：批次目录必须真的落在回收站里
  const safeBatch = path.resolve(batch);
  if (safeBatch.indexOf(path.resolve(paths.RECYCLE_DIR) + path.sep) !== 0) {
    return { ok: false, error: '这个回收站批次不存在' };
  }
  if (!fs.existsSync(safeBatch) || !fs.statSync(safeBatch).isDirectory()) {
    return { ok: false, error: '这个回收站批次已经不在磁盘上了' };
  }
  const wanted = Array.isArray(relPaths) && relPaths.length ? relPaths : null;
  let moved = 0;
  const skipped = [];
  const failed = [];
  const files = [];
  walkFiles(safeBatch, files);
  files.forEach((full) => {
    const rel = path.relative(safeBatch, full).split(path.sep).join('/');
    if (wanted && wanted.indexOf(rel) < 0) return;
    const dest = path.join(assetRoot, ...rel.split('/').filter(Boolean));
    // 同样防穿越：目标必须落在素材目录里
    if (path.resolve(dest).indexOf(path.resolve(assetRoot) + path.sep) !== 0) {
      failed.push(rel);
      return;
    }
    if (fs.existsSync(dest)) {
      skipped.push(rel);
      return;
    }
    try {
      paths.ensureDir(path.dirname(dest));
      fs.renameSync(full, dest);
      moved += 1;
    } catch {
      failed.push(rel);
    }
  });
  return { ok: true, moved: moved, skipped: skipped, failed: failed };
}

module.exports = {
  FOLDERS,
  KIND_LABEL,
  listAssets,
  deleteAssets,
  listRecycle,
  restoreRecycle,
  orphanReport,
  collectReferences,
};
