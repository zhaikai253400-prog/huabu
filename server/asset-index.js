'use strict';

// 上传重复检测（清单 24）：同样的文件第二次上传时，别又存一份。
//
// 素材目录里同一张图存三份是很常见的事 —— 从桌面拖一次、从别的画布添加一次、
// 换台机器再传一次。占的是磁盘，乱的是一眼看不出哪个是哪个。
//
// 做法：给每个上传的文件算一个内容指纹，记在 data/assets-index.json 里。
// 第二次上传同一个文件就认得出来，让用户选择「用已有的」还是「仍然存一份」。
//
// 为什么指纹不用完整 SHA-1：
//   · 视频几百 MB 很常见，完整读一遍会让上传明显变慢；
//   · 这里要防的是「同一个人重复拖同一个文件」，不是防恶意构造碰撞。
//     首尾各取 1MB 加文件大小，对这类场景足够。
//   · 小于阈值的文件（绝大多数图片）仍然整份参与计算，等于全量哈希。
//
// 索引损坏（手改过、写一半断电）时当作空索引继续跑 —— 大不了少认出一个重复，
// 绝不能因为索引坏了就让上传失败。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const paths = require('./paths');

const INDEX_NAME = 'assets-index.json';
// 超过这个大小就只取头尾各 1MB
const SAMPLE_THRESHOLD = 4 * 1024 * 1024;
const SAMPLE_SIZE = 1024 * 1024;
// 最多记这么多条；超了从头砍掉（老的重复检测失效，比索引无限长大好）
const MAX_ENTRIES = 5000;

function indexPath() {
  return path.join(paths.DATA_DIR, INDEX_NAME);
}

// 内容指纹：小文件整份算，大文件首尾抽样 + 文件大小
function fingerprint(buffer) {
  if (!buffer || !buffer.length) return '';
  const hash = crypto.createHash('sha1');
  hash.update(String(buffer.length) + ':');
  if (buffer.length <= SAMPLE_THRESHOLD) {
    hash.update(buffer);
  } else {
    hash.update(buffer.subarray(0, SAMPLE_SIZE));
    hash.update(':');
    hash.update(buffer.subarray(buffer.length - SAMPLE_SIZE));
  }
  return hash.digest('hex');
}

// 索引读不出来就返回空壳（结构坏掉不该拖垮上传）
function readIndex() {
  const file = indexPath();
  try {
    if (!fs.existsSync(file)) return { version: 1, entries: {} };
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { version: 1, entries: {} };
    const entries = parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    return { version: Number(parsed.version) || 1, entries: entries };
  } catch (error) {
    // 索引坏了：当成空的。这里不抛错，也不去动这个文件 ——
    // 留着它，用户或后续版本还有机会把它救回来。
    return { version: 1, entries: {} };
  }
}

function writeIndex(index) {
  const file = indexPath();
  const keys = Object.keys(index.entries || {});
  // 太多就砍掉最早的一批（按记录时间排序）
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => Number((index.entries[a] || {}).at || 0) - Number((index.entries[b] || {}).at || 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((key) => {
        delete index.entries[key];
      });
  }
  paths.ensureDir(paths.DATA_DIR);
  fs.writeFileSync(file, JSON.stringify(index, null, 2), 'utf8');
}

// 记下那份素材还在不在（用户可能手动清了素材目录）
function stillThere(assetRoot, relPath) {
  if (!relPath) return false;
  const abs = path.join(path.resolve(assetRoot), String(relPath).split('/').join(path.sep));
  return fs.existsSync(abs);
}

// 这个文件内容在素材目录里有没有过？返回 { relPath, url, name, bytes, at } 或 null。
// 记下的文件若已经被删掉（用户手动清了素材目录），就当没命中 ——
// 否则会把卡片指向一个不存在的路径。
function findDuplicate(assetRoot, buffer, opts) {
  const fp = fingerprint(buffer);
  if (!fp) return null;
  const index = readIndex();
  const hit = index.entries[fp];
  if (!hit || !hit.relPath) return null;
  if (!stillThere(assetRoot, hit.relPath)) {
    // 记的那份没了：顺手把这条清掉，免得以后一直命中一个空路径
    if (!(opts && opts.dryRun)) {
      delete index.entries[fp];
      writeIndex(index);
    }
    return null;
  }
  return {
    fingerprint: fp,
    relPath: String(hit.relPath),
    url: String(hit.url || '/media/' + hit.relPath),
    name: String(hit.name || ''),
    bytes: Number(hit.bytes) || 0,
    at: Number(hit.at) || 0,
    width: Number(hit.width) || 0,
    height: Number(hit.height) || 0,
    kind: String(hit.kind || ''),
  };
}

// 把一个刚存下的素材记进索引
//
// 同一个指纹已经记过一笔、并且那一份文件还在时，保留原来那笔不覆盖：
//   · 用户选「仍然存一份」之后，弹框里显示的、以及之后「用已有的」该拿到的，
//     都是最先入库的那一份；让新副本抢走记录会让前后两次说法不一致；
//   · 最先那份被手动删掉时，才把这笔挪到新副本上（否则重复检测就白丢了）。
function remember(assetRoot, buffer, asset, originName) {
  const fp = fingerprint(buffer);
  if (!fp || !asset || !asset.relPath) return '';
  const index = readIndex();
  index.version = Number(index.version) || 1;
  const old = index.entries[fp];
  if (old && old.relPath && stillThere(assetRoot, old.relPath)) {
    // 名字是旧的没记下（早期记录）就顺手补上，其余一律保留
    if (!old.name && originName) old.name = String(originName);
    try {
      writeIndex(index);
    } catch (error) {
      return '';
    }
    return fp;
  }
  index.entries[fp] = {
    relPath: String(asset.relPath),
    url: String(asset.url || ''),
    name: String(originName || ''),
    kind: String(asset.kind || ''),
    bytes: Number(asset.bytes) || (buffer ? buffer.length : 0),
    width: Number(asset.width) || 0,
    height: Number(asset.height) || 0,
    at: Date.now(),
  };
  try {
    writeIndex(index);
  } catch (error) {
    // 索引写不进去（磁盘满 / 权限）不该让上传失败 —— 素材已经落盘了
    return '';
  }
  return fp;
}

// 索引里现在记了多少条（日志与测试用）
function count() {
  return Object.keys(readIndex().entries).length;
}

// 清掉索引（仅供测试与排查）
function clear() {
  const file = indexPath();
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  } catch {
    /* 清不掉就算了 */
  }
}

module.exports = {
  INDEX_NAME,
  SAMPLE_THRESHOLD,
  SAMPLE_SIZE,
  fingerprint,
  indexPath,
  readIndex,
  writeIndex,
  findDuplicate,
  remember,
  stillThere,
  count,
  clear,
};
