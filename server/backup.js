'use strict';

// 画布备份分两级：
//   短期（本目录直接放的 .json）—— 改动后隔几分钟存一份，只留最近 10 份，
//                                    是「刚才手滑了」的第一道防线；
//   长期（daily/ 子目录）        —— 每天留一份，保留 30 天，
//                                    是「昨天还好好的，今天全没了」的第二道防线。
//
// 另外几个关键动作会强制留一份（force / forceSnapshot）：
//   删除画布、回滚历史版本、批量操作前 —— 这些是一步做错就难回头的事。

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');
const store = require('./store');

const MAX_BACKUPS = 10;                          // 短期保留份数
const MIN_GAP_MS = 5 * 60 * 1000;                // 短期最短间隔：5 分钟
const DAILY_KEEP_DAYS = 30;                      // 长期保留天数
const DAILY_DIR = 'daily';

const lastAt = new Map();
// 记录每块画布「今天有没有查过长期备份」，避免每次保存都去 readdir
const dailyCheckedDay = new Map();

function stampName() {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' +
    pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds())
  );
}

// 同一秒内可能连着写两份（比如批量前刚存完又回滚），只精确到秒会互相覆盖，
// 所以再补 3 位毫秒，保证同一秒内也不会撞名。
function stampNameMs() {
  const d = new Date();
  return stampName() + '-' + String(d.getMilliseconds()).padStart(3, '0');
}

function dayName(date) {
  const d = date || new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function dirOf(canvasId) {
  return path.join(paths.DATA_DIR, 'backups', String(canvasId));
}

function dailyDirOf(canvasId) {
  return path.join(dirOf(canvasId), DAILY_DIR);
}

function listNames(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /\.json$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function list(canvasId) {
  return listNames(dirOf(canvasId));
}

function listDaily(canvasId) {
  return listNames(dailyDirOf(canvasId));
}

// 短期只留最近 MAX_BACKUPS 份，多的从最旧的开始丢
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

// 长期按天算，超过 DAILY_KEEP_DAYS 天的删掉。
// 文件名就是 2026-11-03.json，按字符串比大小即可，不用逐个 stat。
function pruneDaily(canvasId) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAILY_KEEP_DAYS);
  const limit = dayName(cutoff); // 早于这天的都算过期
  listDaily(canvasId).forEach((name) => {
    if (name.replace(/\.json$/, '') >= limit) return;
    try {
      fs.unlinkSync(path.join(dailyDirOf(canvasId), name));
    } catch {
      /* 删不掉就算了 */
    }
  });
}

function payloadOf(state) {
  return {
    savedAt: Date.now(),
    canvas: { name: state.canvas.name },
    viewport: state.viewport,
    nodes: state.nodes,
    edges: state.edges,
  };
}

// 把一份 state 写成备份文件
function writeSnapshot(canvasId, state, dir, name) {
  paths.ensureDir(dir);
  fs.writeFileSync(path.join(dir, name), JSON.stringify(payloadOf(state)), 'utf8');
  return name;
}

// 每天的第一份改动，往 daily/ 里留一个以日期命名的快照；
// 同一天已经留过就不再写，避免一天堆出一堆。
function maybeDaily(canvasId, state) {
  const today = dayName();
  if (dailyCheckedDay.get(canvasId) === today) return null;
  dailyCheckedDay.set(canvasId, today);
  const name = today + '.json';
  const dir = dailyDirOf(canvasId);
  if (fs.existsSync(path.join(dir, name))) {
    pruneDaily(canvasId);
    return null;
  }
  try {
    writeSnapshot(canvasId, state, dir, name);
    pruneDaily(canvasId);
    return name;
  } catch {
    return null;
  }
}

// 自动备份：同一块画布最少隔 5 分钟存一次，只留最近 10 份；
// 每次都顺带确认「今天有没有留长期备份」。
// force=true 跳过 5 分钟节流 —— 删除、回滚、批量这些场合必须留痕。
function maybeBackup(canvasId, force) {
  const now = Date.now();
  const last = lastAt.get(canvasId) || 0;
  const shortDue = force || now - last >= MIN_GAP_MS;
  const dailyDue = dailyCheckedDay.get(canvasId) !== dayName();
  if (!shortDue && !dailyDue) return null;

  const state = store.getState(canvasId);
  if (!state) return null;

  if (dailyDue) maybeDaily(canvasId, state);
  if (!shortDue) return null;

  let name = null;
  try {
    name = writeSnapshot(canvasId, state, dirOf(canvasId), stampNameMs() + '.json');
  } catch {
    return null;
  }
  lastAt.set(canvasId, now);
  prune(canvasId);
  return name;
}

// 强制留一份「当前状态」：批量操作、回滚、删除前调用。
// 直接接 state 对象，绕开 store 查询 —— 删除场景下库里的记录马上就要没了。
// label 是给用户看的（删除前 / 回滚前 / 批量前），中文必须保留，
// 所以只清掉文件名里不能用的字符；清完为空就用 pre-action 兜底。
function forceSnapshot(canvasId, state, label) {
  if (!state) return null;
  const prefix = String(label || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 20) || 'pre-action';
  const name = prefix + '-' + stampNameMs() + '.json';
  try {
    writeSnapshot(canvasId, state, dirOf(canvasId), name);
  } catch {
    return null;
  }
  lastAt.set(canvasId, Date.now());
  prune(canvasId);
  return name;
}

function describe(dir, name, kind) {
  let stat = null;
  try {
    stat = fs.statSync(path.join(dir, name));
  } catch {
    stat = null;
  }
  const base = name.replace(/\.json$/, '');
  let label;
  if (kind === 'daily') {
    // 每日备份的文件名就是 2026-11-03 这样的纯日期，
    // 不能拿下面那条「日期 时间」的规则去替换，否则 2026-11-03 会被显示成 2026:11:03
    label = base + '（当日）';
  } else {
    // 形如 2026-11-03_00-34-58-489 或 批量前-2026-11-03_00-34-58-489：
    // 把后半段的时间从 00-34-58 改成 00:34:58，读起来舒服些
    label = base.replace(/_/, ' ').replace(/-(\d\d)-(\d\d)(?:-\d{3})?$/, ':$1:$2');
  }
  return {
    name: name,
    label: label,
    bytes: stat ? stat.size : 0,
    mtime: stat ? stat.mtimeMs : 0,
    kind: kind,
  };
}

// 返回结构保持向后兼容（name/label/bytes/mtime），另外多带一个 kind：
//   recent = 刚才那几份，daily = 每天那份。
// 旧前端不认识 kind 也不会出错，只是不区分展示。
function listBackups(canvasId) {
  const recent = list(canvasId)
    .slice()
    .reverse()
    .map((name) => describe(dirOf(canvasId), name, 'recent'));
  const daily = listDaily(canvasId)
    .slice()
    .reverse()
    .map((name) => describe(dailyDirOf(canvasId), name, 'daily'));
  return recent.concat(daily);
}

// 读取时先在短期目录找，找不到再找长期目录。
// 名字校验不能用 \w —— 快照名里有「删除前 / 批量前」这类中文，
// 那样会把中文文件名全挡在外面，用户点「回滚到这里」就会失败。
// 这里改成：只挡真正危险的东西 —— 路径分隔符、上跳、盘符冒号。
function readBackup(canvasId, name) {
  const safe = String(name || '');
  if (!safe || safe.length > 120) return null;
  if (/[\\/]/.test(safe)) return null;          // 不许带路径分隔符
  if (safe.indexOf('..') >= 0) return null;     // 不许上跳
  if (safe.indexOf(':') >= 0) return null;      // Windows 盘符 / ADS 流
  if (!/\.json$/.test(safe)) return null;
  const plain = path.join(dirOf(canvasId), safe);
  const daily = path.join(dailyDirOf(canvasId), safe);
  const file = fs.existsSync(plain) ? plain : daily;
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  MAX_BACKUPS,
  DAILY_KEEP_DAYS,
  maybeBackup,
  forceSnapshot,
  listBackups,
  readBackup,
  dirOf,
  dailyDirOf,
};
