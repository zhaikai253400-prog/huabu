'use strict';

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');
const store = require('./store');

const MAX_BACKUPS = 10;
const MIN_GAP_MS = 5 * 60 * 1000;
const lastAt = new Map();

function stampName() {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' +
    pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds())
  );
}

function dirOf(canvasId) {
  return path.join(paths.DATA_DIR, 'backups', String(canvasId));
}

function list(canvasId) {
  try {
    return fs
      .readdirSync(dirOf(canvasId))
      .filter((name) => /\.json$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function prune(canvasId) {
  const files = list(canvasId);
  while (files.length > MAX_BACKUPS) {
    const oldest = files.shift();
    try {
      fs.unlinkSync(path.join(dirOf(canvasId), oldest));
    } catch {
      /* 删不掉就算了 */
    }
  }
}

// 自动备份：同一块画布最少隔 5 分钟存一次，只留最近 10 份
function maybeBackup(canvasId, force) {
  const now = Date.now();
  const last = lastAt.get(canvasId) || 0;
  if (!force && now - last < MIN_GAP_MS) return null;
  const state = store.getState(canvasId);
  if (!state) return null;
  const dir = paths.ensureDir(dirOf(canvasId));
  const name = stampName() + '.json';
  const payload = {
    savedAt: now,
    canvas: { name: state.canvas.name },
    viewport: state.viewport,
    nodes: state.nodes,
    edges: state.edges,
  };
  try {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(payload), 'utf8');
  } catch {
    return null;
  }
  lastAt.set(canvasId, now);
  prune(canvasId);
  return name;
}

function listBackups(canvasId) {
  return list(canvasId)
    .slice()
    .reverse()
    .map((name) => {
      let stat = null;
      try {
        stat = fs.statSync(path.join(dirOf(canvasId), name));
      } catch {
        stat = null;
      }
      return {
        name: name,
        label: name.replace(/\.json$/, '').replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2'),
        bytes: stat ? stat.size : 0,
        mtime: stat ? stat.mtimeMs : 0,
      };
    });
}

function readBackup(canvasId, name) {
  if (!/^[\w.\-]+\.json$/.test(String(name || ''))) return null;
  const file = path.join(dirOf(canvasId), String(name));
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { MAX_BACKUPS, maybeBackup, listBackups, readBackup, dirOf };
