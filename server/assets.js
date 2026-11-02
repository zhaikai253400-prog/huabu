'use strict';

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');

function pad(value) {
  return String(value).padStart(2, '0');
}

// 2026-10-29_14-05-31
function stampName() {
  const d = new Date();
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    '_' + pad(d.getHours()) +
    '-' + pad(d.getMinutes()) +
    '-' + pad(d.getSeconds())
  );
}

// 文件名里的中文照留，只清掉非法字符，太长就截断
function safeName(text, fallback, maxLen) {
  let out = String(text || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  const limit = maxLen || 40;
  if (out.length > limit) out = out.slice(0, limit).trim();
  return out || fallback || '未命名';
}

function sniffExt(buffer) {
  if (!buffer || buffer.length < 12) return '';
  const head = buffer;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return '.png';
  if (head[0] === 0xff && head[1] === 0xd8) return '.jpg';
  if (head.slice(0, 4).toString('ascii') === 'GIF8') return '.gif';
  if (head.slice(4, 8).toString('ascii') === 'ftyp') return '.mp4';
  if (head.slice(0, 3).toString('ascii') === 'ID3') return '.mp3';
  if (head.slice(0, 4).toString('ascii') === 'RIFF') {
    const tag = head.slice(8, 12).toString('ascii');
    if (tag === 'WAVE') return '.wav';
    if (tag.slice(0, 3) === 'WEB') return '.webp';
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return '.webm';
  return '';
}

function extFromMime(mime) {
  const clean = String(mime || '').split(';')[0].trim().toLowerCase();
  const table = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
  };
  return table[clean] || '';
}

function extFromUrl(url) {
  try {
    const clean = String(url || '').split('?')[0].split('#')[0];
    const ext = path.extname(clean).toLowerCase();
    if (ext && ext.length <= 5) return ext;
  } catch {
    /* 忽略 */
  }
  return '';
}

const KIND_BY_EXT = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.bmp': 'image',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.mkv': 'video',
  '.avi': 'video',
  '.m4v': 'video',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
  '.ogg': 'audio',
};

const FOLDER_BY_KIND = { image: '图片', video: '视频', audio: '音频', frame: '尾帧' };

function folderFor(kind) {
  return FOLDER_BY_KIND[String(kind || '')] || '图片';
}

// 按扩展名认类型，扩展名不认识就按文件内容认
function kindOfFile(name, buffer) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (KIND_BY_EXT[ext]) return { kind: KIND_BY_EXT[ext], ext: ext };
  const sniffed = sniffExt(buffer || Buffer.alloc(0));
  if (sniffed && KIND_BY_EXT[sniffed]) return { kind: KIND_BY_EXT[sniffed], ext: sniffed };
  return { kind: '', ext: ext };
}

// 把本地挑的文件收进素材目录，名字带上时间戳，重名不覆盖
function importAsset(assetRoot, kind, originName, buffer, sub) {
  const clean = String(originName || '');
  const ext = path.extname(clean).toLowerCase();
  const base = stampName() + '_' + safeName(path.basename(clean, ext), '本地素材', 40);
  const target = writeAsset(assetRoot, folderFor(kind), base, ext || '.bin', buffer, sub);
  const rel = relToRoot(target, assetRoot);
  const size = sizeOf(buffer);
  return {
    relPath: rel,
    url: mediaUrl(rel),
    width: size ? size.width : 0,
    height: size ? size.height : 0,
    bytes: buffer.length,
    kind: kind,
  };
}

// 只认图片、视频、音频的头部尺寸，够卡片排版用
function sizeOf(buffer) {
  try {
    if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    /* 读不出来就算了 */
  }
  return null;
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, base + ' (' + index + ')' + ext);
    index += 1;
  }
  return candidate;
}

// 子目录片段：清掉非法字符，空的丢掉
function subParts(sub) {
  return String(sub || '')
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => safeName(part, '子目录', 40));
}

// 写进 素材/<folder>[/子目录]，返回绝对路径
function writeAsset(assetRoot, folder, base, ext, buffer, sub) {
  const dir = paths.ensureDir(path.join(assetRoot, folder, ...subParts(sub)));
  const target = uniquePath(dir, safeName(base, '未命名', 60), ext || '.bin');
  fs.writeFileSync(target, buffer);
  return target;
}

function relOf(absPath) {
  return paths.toRelative(absPath);
}

// 相对素材根目录的写法：图片/xxx.png，/media/ 后面接的就是它
function relToRoot(absPath, rootDir) {
  return path.relative(path.resolve(rootDir), path.resolve(absPath)).split(path.sep).join('/');
}

// 浏览器的 /media/图片/xxx.png 地址
function mediaUrl(relPath) {
  return (
    '/media/' +
    String(relPath || '')
      .split('/')
      .filter(Boolean)
      .map((part) => encodeURIComponent(part))
      .join('/')
  );
}

// /media/... 里的相对地址转绝对路径，越界一律拒绝
function resolveMedia(assetRoot, relPath) {
  const rootAbs = path.resolve(assetRoot);
  let clean = String(relPath || '');
  try {
    clean = decodeURIComponent(clean);
  } catch {
    /* 保持原样 */
  }
  clean = clean.replace(/^[/\\]+/, '');
  const target = path.resolve(rootAbs, clean);
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) return null;
  return target;
}

function isDataUrl(url) {
  return /^data:[^,]*,/i.test(String(url || ''));
}

function decodeDataUrl(url) {
  const text = String(url || '');
  const comma = text.indexOf(',');
  if (comma < 0) return null;
  const head = text.slice(5, comma);
  const payload = text.slice(comma + 1);
  const isBase64 = /;base64/i.test(head);
  const mime = head.split(';')[0] || '';
  const buffer = isBase64
    ? Buffer.from(payload.replace(/\s+/g, ''), 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { buffer, mime };
}

// 远端给的图片地址：直接下回来存本地
async function fetchBuffer(url, headers, timeoutMs) {
  const target = String(url || '').trim();
  if (!target) throw new Error('素材地址是空的');
  let host = '对方服务器';
  try {
    host = new URL(target).host || host;
  } catch {
    host = target.slice(0, 40);
  }
  const attempts = 3;
  let last = null;
  for (let round = 1; round <= attempts; round += 1) {
    let fatal = null;
    try {
      const response = await fetch(target, {
        headers: headers || {},
        signal: AbortSignal.timeout(timeoutMs || 180000),
        redirect: 'follow',
      });
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length) return { buffer: buffer, mime: response.headers.get('content-type') || '' };
        last = new Error('下载素材失败：' + host + ' 返回了空内容');
      } else {
        const text = await response.text().catch(() => '');
        const detail = String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
        const error = new Error('下载素材失败：' + host + ' 返回 ' + response.status + (detail ? '（' + detail + '）' : ''));
        if (response.status >= 400 && response.status < 500) fatal = error;
        else last = error;
      }
    } catch (error) {
      last = new Error('下载素材失败：连不上 ' + host + '（' + ((error && error.message) || error) + '）');
    }
    if (fatal) throw fatal;
    // 网络抖动 / 超时就再试两次，间隔一点点拉长
    if (round < attempts) await new Promise((resolve) => setTimeout(resolve, 800 * round));
  }
  throw last || new Error('下载素材失败：' + host);
}

module.exports = {
  stampName,
  safeName,
  sniffExt,
  extFromMime,
  extFromUrl,
  kindOfFile,
  folderFor,
  subParts,
  importAsset,
  sizeOf,
  writeAsset,
  relOf,
  relToRoot,
  mediaUrl,
  resolveMedia,
  isDataUrl,
  decodeDataUrl,
  fetchBuffer,
};
