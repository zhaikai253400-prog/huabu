'use strict';

// 程序代码同步：只搬「程序本身」，不碰画布数据和素材库。
//
// 为什么单独成模块：这件事的风险不在于传输，而在于「写文件」。
// 一旦同步逻辑允许任意路径，等于给局域网开了一个任意写文件的口子。
// 所以这里只有两份白名单（目录 + 根部文件），其余一律不认：
//   · data/   画布库、配置、回收站、日志  —— 每台电脑各一份，永不传输
//   · 素材/   素材库                      —— 同上
//   · work/ _archive/ .git/ .tmp-*        —— 临时件与历史备份，不参与
//   · *.bak / *.tmp / *.log / *.pdb       —— 备份件与调试产物，不参与
//
// 两台电脑的模型：
//   A 机（主机）跑服务、开着局域网，只额外放行两个只读接口（清单 + 取文件）；
//   B 机（另一台）在自己的 /codesync 页里填 A 机的地址，由 B 机自己的服务去拉取、
//   写进 B 机自己的程序目录。写操作永远发生在「拉取方」，主机不需要写权限。

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const paths = require('./paths');

// 参与同步的目录（都在程序根目录下）
const CODE_DIRS = ['web', 'server', 'tools', 'runtime'];

// 参与同步的根部文件：双击启动需要的、以及说明文档
const CODE_FILES = [
  '无限画布.exe',
  '启动画布.bat',
  '允许局域网访问.bat',
  '使用说明.txt',
  'RUNTIME.txt',
  'dog.ico',
];

// 目录级排除：数据、素材、临时目录、版本库
const SKIP_DIRS = ['data', '素材', 'work', '_archive', '.git', 'node_modules', '.tmp-mut', '.tmp-test'];

// 文件级排除：备份件、临时件、日志、调试符号、系统垃圾文件
// 备份件与临时件：名字里出现 .bak / .tmp / .log 都算（canvas.js.bak-20261105 这种也要挡住）
const SKIP_FILE_RE = /(\.bak|\.tmp|\.log|\.pdb|~$|^thumbs\.db$|^desktop\.ini$|^\.ds_store$)/i;

// 单个文件上限：再大就不是程序代码了，多半是素材误入
const MAX_FILE_BYTES = 400 * 1024 * 1024;

function isSkippedName(name) {
  return SKIP_FILE_RE.test(String(name || ''));
}

function isSkippedDir(name) {
  const low = String(name || '').toLowerCase();
  return SKIP_DIRS.some((one) => one.toLowerCase() === low);
}

// 把一个相对路径解析成绝对路径；不在白名单里就返回 null。
// 判据是「解析后的真实位置」而不是字符串前缀 —— 后者挡不住 ..\\ 与符号链接。
function resolveCodePath(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.indexOf('\0') >= 0) return null;
  const segs = rel.split('/').filter(Boolean);
  if (!segs.length) return null;
  if (segs.some((one) => one === '.' || one === '..')) return null;
  if (segs.some((one) => isSkippedName(one))) return null;

  const abs = path.resolve(paths.ROOT, ...segs);
  if (abs !== paths.ROOT && !abs.startsWith(paths.ROOT + path.sep)) return null;

  if (segs.length === 1) {
    if (CODE_FILES.indexOf(segs[0]) < 0) return null;
    return abs;
  }
  const top = segs[0].toLowerCase();
  if (CODE_DIRS.indexOf(top) < 0) return null;
  // 目录里也要逐级排除（比如 server/data 之类将来可能出现的目录）
  const inner = segs.slice(1, -1);
  if (inner.some((one) => isSkippedDir(one))) return null;
  const realTop = path.resolve(paths.ROOT, segs[0]);
  if (!abs.startsWith(realTop + path.sep)) return null;
  return abs;
}

function isCodeFile(relPath) {
  const abs = resolveCodePath(relPath);
  if (!abs) return false;
  try {
    const st = fs.statSync(abs);
    return st.isFile() && st.size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

// 遍历白名单，列出当前这台电脑上的程序文件。
// 只给 size / mtime，不算 hash：几百 MB 的 node.exe、ffmpeg，每次检查都读一遍太慢，
// 而「大小 + 修改时间」已经足够判断「这份文件动过没有」。
function listLocalFiles() {
  const out = [];
  const push = (abs) => {
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
    const rel = path.relative(paths.ROOT, abs).split(path.sep).join('/');
    if (!resolveCodePath(rel)) return;
    out.push({ path: rel, size: st.size, mtime: Math.round(st.mtimeMs) });
  };

  CODE_FILES.forEach((name) => push(path.join(paths.ROOT, name)));

  const walk = (dir, depth) => {
    if (depth > 6) return;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    names.sort();
    for (const name of names) {
      if (isSkippedName(name)) continue;
      const abs = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (isSkippedDir(name)) continue;
        walk(abs, depth + 1);
      } else if (st.isFile()) {
        push(abs);
      }
    }
  };
  CODE_DIRS.forEach((name) => {
    const dir = path.join(paths.ROOT, name);
    if (fs.existsSync(dir)) walk(dir, 0);
  });

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function digestOf(list) {
  const lines = list.map((one) => one.path + ':' + one.size + ':' + one.mtime);
  return require('node:crypto').createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);
}

function manifest() {
  const files = listLocalFiles();
  return {
    ok: true,
    root: paths.ROOT,
    host: require('node:os').hostname(),
    generatedAt: Date.now(),
    digest: digestOf(files),
    count: files.length,
    totalBytes: files.reduce((sum, one) => sum + one.size, 0),
    files: files,
  };
}

// 两台机器的清单做差：只比「路径 / 大小 / 修改时间」，不做内容比对。
// 结论分三类，前端要能分开说：
//   add —— 主机有、本机没有
//   update —— 两边都有但不一致
//   same —— 一致，不需要动
function diffManifests(remoteList, localList) {
  const localMap = new Map((localList || []).map((one) => [one.path, one]));
  const add = [];
  const update = [];
  for (const one of remoteList || []) {
    const mine = localMap.get(one.path);
    if (!mine) add.push(one);
    else if (Number(mine.size) !== Number(one.size) || Number(mine.mtime) !== Number(one.mtime)) update.push(one);
  }
  const remotePaths = new Set((remoteList || []).map((one) => one.path));
  const extra = (localList || []).filter((one) => !remotePaths.has(one.path)).map((one) => one.path);
  return { add, update, extra, same: (localList || []).length - update.length - extra.length };
}

// 只留 http / https，且必须带主机名：别的协议（file:、ftp:）一律不认
function normalizeBaseUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('请填写另一台电脑的画布地址，例如 http://192.168.3.13:17890');
  // 显式写了协议就必须是 http / https：否则 file:///C:/ 会被当成主机名
  // 补成 http://file:///C:/ 混过去，拿到一个永远连不上的地址。
  const scheme = /^([a-z][a-z0-9+.\-]*):\/\//i.exec(text);
  if (scheme && !/^https?$/i.test(scheme[1])) {
    throw new Error('只支持 http / https 地址，不认 ' + scheme[1] + '://');
  }
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : 'http://' + text);
  } catch {
    throw new Error('地址格式不对：' + text);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http / https 地址');
  if (!url.hostname) throw new Error('地址里没有主机名：' + text);
  url.hash = '';
  url.search = '';
  const base = url.origin + url.pathname.replace(/\/+$/, '');
  return base;
}

function requestBuffer(baseUrl, relUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(relUrl, baseUrl + '/');
    const client = target.protocol === 'https:' ? https : http;
    const req = client.get(
      target,
      { timeout: timeoutMs || 20000, headers: { Accept: 'application/json, */*' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          return resolve(requestBuffer(next, '', timeoutMs));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_FILE_BYTES) {
            req.destroy(new Error('对方返回的文件过大'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            let msg = '对方返回 ' + res.statusCode;
            try {
              const parsed = JSON.parse(body.toString('utf8'));
              if (parsed && parsed.error) msg = parsed.error;
            } catch {
              /* 不是 JSON 就用状态码 */
            }
            return reject(new Error(msg));
          }
          resolve(body);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('对方没有响应（超时）')));
    req.on('error', (error) => reject(error));
  });
}

async function fetchManifest(baseUrl) {
  const body = await requestBuffer(baseUrl, '/api/codesync/manifest', 8000);
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('对方回的不是清单，可能地址指向了别的程序');
  }
  if (!parsed || !Array.isArray(parsed.files)) throw new Error('对方没有返回文件清单');
  return parsed;
}

// 检查（不写盘）：给页面显示「会更新哪些文件」
async function plan(hostUrl) {
  const base = normalizeBaseUrl(hostUrl);
  const remote = await fetchManifest(base);
  const local = listLocalFiles();
  const diff = diffManifests(remote.files, local);
  return {
    ok: true,
    host: base,
    remote: { host: remote.host || '', count: remote.count || remote.files.length, digest: remote.digest || '' },
    local: { count: local.length, digest: digestOf(local) },
    add: diff.add.map((one) => ({ path: one.path, size: one.size })),
    update: diff.update.map((one) => ({ path: one.path, size: one.size })),
    extra: diff.extra,
    same: diff.same,
  };
}

function backupDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(paths.DATA_DIR, 'codesync-backup', stamp);
}

// 覆盖前先把老文件挪进 data\\codesync-backup\\<时间>，同步出问题还能手改回去。
// 备份写在自己这台电脑的 data 里，不参与下一次同步（data 目录本来就不同步）。
function backupExisting(abs, rel, dir) {
  try {
    if (!fs.existsSync(abs)) return;
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(abs, target);
  } catch {
    /* 备份失败不阻塞同步，但会在结果里体现 */
  }
}

// 真正拉取并落盘。返回每一个文件的处理结果，失败的不中断整体。
async function pull(hostUrl, options) {
  const opt = options || {};
  const base = normalizeBaseUrl(hostUrl);
  const maxFiles = Math.max(1, Math.min(2000, Number(opt.maxFiles) || 2000));
  const remote = await fetchManifest(base);
  const local = listLocalFiles();
  const diff = diffManifests(remote.files, local);
  const todo = diff.add.concat(diff.update).slice(0, maxFiles);

  const result = {
    ok: true,
    host: base,
    backupDir: '',
    updated: [],
    added: [],
    failed: [],
    skipped: diff.extra,
    same: diff.same,
    needRestart: false,
  };

  if (!todo.length) {
    return result;
  }

  const dir = backupDir();
  result.backupDir = dir;
  fs.mkdirSync(dir, { recursive: true });

  for (const one of todo) {
    const abs = resolveCodePath(one.path);
    if (!abs) {
      result.failed.push({ path: one.path, reason: '不在允许同步的范围内' });
      continue;
    }
    let body;
    try {
      body = await requestBuffer(base, '/api/codesync/file?path=' + encodeURIComponent(one.path), 120000);
    } catch (error) {
      result.failed.push({ path: one.path, reason: (error && error.message) || '下载失败' });
      continue;
    }
    if (body.length !== Number(one.size)) {
      result.failed.push({ path: one.path, reason: '大小对不上（收到 ' + body.length + ' 字节）' });
      continue;
    }
    const existed = fs.existsSync(abs);
    if (existed) backupExisting(abs, one.path, dir);
    const tmp = abs + '.codesync.tmp';
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(tmp, body);
      // 把修改时间也搬过来。不然下次对比时「大小一样、mtime 不一样」，
      // 会把所有文件都判成需要更新，每次都重拉一遍全量文件。
      const stamp = Number(one.mtime);
      if (Number.isFinite(stamp) && stamp > 0) {
        try {
          fs.utimesSync(tmp, new Date(stamp), new Date(stamp));
        } catch {
          /* 设不上也不影响内容，只是下次会多比一次 */
        }
      }
      fs.renameSync(tmp, abs);
      (existed ? result.updated : result.added).push(one.path);
    } catch (error) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* 忽略 */
      }
      // Windows 上正在运行的 exe / 被占用的文件会走到这里，这种情况要明确告诉用户
      const code = (error && error.code) || '';
      const busy = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      result.failed.push({
        path: one.path,
        reason: busy ? '文件正在被占用（先退出画布再同步一次）' : (error && error.message) || '写入失败',
      });
    }
  }

  // 换了服务端或前端代码，必须重启服务才会生效；只改数据目录不用重启。
  const touched = result.updated.concat(result.added);
  result.needRestart = touched.some((one) => {
    const p = String(one);
    return p.indexOf('server/') === 0 || p.indexOf('web/') === 0 || p === '无限画布.exe';
  });
  return result;
}

module.exports = {
  CODE_DIRS,
  CODE_FILES,
  SKIP_DIRS,
  MAX_FILE_BYTES,
  resolveCodePath,
  isCodeFile,
  listLocalFiles,
  digestOf,
  manifest,
  diffManifests,
  normalizeBaseUrl,
  fetchManifest,
  plan,
  pull,
};
