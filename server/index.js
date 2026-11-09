'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const paths = require('./paths');
const configStore = require('./config');
const store = require('./store');
const migrate = require('./migrate');
const assets = require('./assets');
const assetIndex = require('./asset-index');
const channels = require('./channels');
const modelSpecs = require('./model-specs');
const generate = require('./generate');
const tasks = require('./tasks');
const scheduler = require('./scheduler');
const library = require('./library');
const logfile = require('./logfile');
const backup = require('./backup');
const thumbs = require('./thumbs');
const pickFolderDialog = require('./pick-folder');
const guard = require('./guard');
const keybox = require('./keybox');
const codesync = require('./codesync');
const share = require('./share');

// --background：托盘在后台拉起服务时用，不弹浏览器、也不留在任务栏
const BACKGROUND = process.argv.includes('--background');
const QUIET = BACKGROUND || process.argv.includes('--no-browser');
const ADMIN_TOKEN_FILE = path.join(paths.DATA_DIR, 'admin-token.txt');
const UI_TOKEN_FILE = path.join(paths.DATA_DIR, 'ui-token.txt');
// adminToken：只认「接口通道设置」窗口，能读写平台密钥
// uiToken   ：页面令牌，画布页 / 门户页 / 启动器都有，但碰不到 /api/channels*
let adminToken = '';
let uiToken = '';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const logRing = [];

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    now.getFullYear() +
    '-' + pad(now.getMonth() + 1) +
    '-' + pad(now.getDate()) +
    ' ' + pad(now.getHours()) +
    ':' + pad(now.getMinutes()) +
    ':' + pad(now.getSeconds())
  );
}

function log(message) {
  const line = '[' + stamp() + '] ' + message;
  console.log(line);
  logRing.push(line);
  if (logRing.length > 500) logRing.shift();
  try {
    const day = stamp().slice(0, 10);
    paths.ensureDir(paths.LOG_DIR);
    fs.appendFileSync(path.join(paths.LOG_DIR, day + '.log'), line + '\r\n', 'utf8');
  } catch {
    /* 日志写不了不影响主流程 */
  }
}

// 把老版本留在 data\config.json 里的明文密钥改成密文。
//
// 顺序刻意是「先备份、再写、再核对」：
//   1. 原文件拷到 _archive/config-plaintext-<时间>.json，出问题能照着恢复；
//   2. configStore.save() 内部会做写后回读自检，不一致就抛错、不动正式文件；
//   3. 只有真的改了才写日志，避免每次启动都刷一行「迁移完成」。
function migratePlaintextKeys() {
  const still = paths.CONFIG_FILE;
  if (!fs.existsSync(still)) return 0;
  // 注意：不能拿内存里的 config 去数 —— 它已经被 decryptConfig 还原成明文了，
  // 那样每次启动都会误判「还有明文」，于是反复备份、反复重写配置。
  // 只有磁盘原文里的 enc:v1: 前缀才是判断依据。
  let count = 0;
  try {
    count = configStore.plaintextCount(JSON.parse(fs.readFileSync(still, 'utf8')));
  } catch {
    return 0;
  }
  if (!count) return 0;
  try {
    const stamp = new Date()
      .toISOString()
      .replace(/[:T]/g, '-')
      .replace(/\..*$/, '');
    const archiveDir = path.join(paths.ROOT, '_archive');
    paths.ensureDir(archiveDir);
    // 备份文件里是明文密钥，所以尽量收紧权限；Windows 上靠 DPAPI 已经不适用（这是普通 JSON），
    // 至少要让它别随着程序目录一起被随手打包外发 —— 日志里也会提醒用户。
    const archive = path.join(archiveDir, 'config-plaintext-' + stamp + '.json');
    fs.copyFileSync(still, archive);
    configStore.save(config);
    log('平台密钥已改为加密保存（' + count + ' 处），迁移前的明文备份在 _archive\\' + path.basename(archive));
    log('确认一切正常后，可以删掉那份明文备份。');
    return count;
  } catch (error) {
    log('平台密钥自动迁移没成功：' + error.message);
    log('配置仍按原样可用；下次保存时会再试一次。');
    return 0;
  }
}
// 所有响应统一带上的安全头。
// 为什么放在入口处用 setHeader：页面、接口、素材、缩略图各走各的 writeHead，
// 逐个补一遍迟早漏掉一个；放在分派之前，连 400/403 这些早退响应也能覆盖。
//   · nosniff：素材目录里可能有用户放进来的任意扩展名文件，别让浏览器猜成脚本
//   · no-referrer：日志下载把钥匙放在查询串里，跳转时不能顺着 Referer 泄出去
//   · frame-ancestors/base-uri/object-src：本机页面不该被别的站点套框或劫持 <base>
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(text);
}

// 读请求体的原始文本，读到就缓存在 req 上。
//
// 为什么要缓存：局域网请求要先看请求体里的 canvasId，才知道「这块画布有没有
// 开共享」，不给协作者碰没共享的画布。而 HTTP 请求体是流、只能读一次 ——
// 前面判权限时读掉了，后面路由里再 readBody 就会永远等不到数据。
// 缓存之后两边拿到的是同一份，判权限与业务逻辑不会互相踩。
function readBodyText(req, limit) {
  if (typeof req.__bodyText === 'string') return Promise.resolve(req.__bodyText);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > (limit || 40 * 1024 * 1024)) {
        reject(new Error('提交内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
      req.__bodyText = text;
      resolve(text);
    });
    req.on('error', reject);
  });
}

function readBody(req, limit) {
  return readBodyText(req, limit).then((text) => {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('提交的格式不正确');
    }
  });
}

// 收原始字节：本地挑的文件直接传上来，不走 JSON 包一层
function readRaw(req, limit) {
  if (Buffer.isBuffer(req.__bodyBuffer)) return Promise.resolve(req.__bodyBuffer);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > (limit || 512 * 1024 * 1024)) {
        reject(new Error('这个文件太大了，超过 ' + Math.round((limit || 512 * 1024 * 1024) / 1024 / 1024) + ' MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      req.__bodyBuffer = buffer;
      resolve(buffer);
    });
    req.on('error', reject);
  });
}

function serveStatic(res, filePath) {
  const resolved = path.resolve(filePath);
  if (!guard.isInsideDir(paths.WEB_DIR, resolved)) return sendText(res, 403, '不允许访问该路径');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return sendText(res, 404, '找不到页面：' + path.basename(resolved));
  }
  const ext = path.extname(resolved).toLowerCase();
  const stat = fs.statSync(resolved);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(resolved).pipe(res);
}

// 给页面里的 js / css 加上「文件修改时间」作为版本号。
// 不加的话，改完代码只重启服务、不强刷新，浏览器很可能还拿着旧的 canvas.js，
// 看起来就像「改了没生效」。加上参数后，文件一变 URL 就变，浏览器必须重新下载。
function stampAssetUrls(html) {
  return html.replace(/\/assets\/([\w.\-]+\.(?:js|css))/g, (whole, name) => {
    try {
      const file = path.join(paths.WEB_DIR, 'assets', name);
      const stamp = Math.round(fs.statSync(file).mtimeMs);
      return '/assets/' + name + '?v=' + stamp;
    } catch {
      return whole;
    }
  });
}
// 页面令牌注入：每张页面只拿到自己该有的那把钥匙。
//   · 接口通道设置页 -> __LOCAL_TOKEN__（管理钥匙，能读写平台密钥）
//   · 门户 / 画布 / 启动器 -> __UI_TOKEN__（页面钥匙，调不动通道接口）
// 普通静态脚本、素材、缩略图一律不注入，画布页源码里也就没有密钥。
function serveHtmlWithTokens(res, filePath, withAdmin, fromLan) {
  const resolved = path.resolve(filePath);
  if (!guard.isInsideDir(paths.WEB_DIR, resolved)) return sendText(res, 403, '不允许访问该路径');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return sendText(res, 404, '找不到页面：' + path.basename(resolved));
  }
  const html = fs
    .readFileSync(resolved, 'utf8')
    // 局域网访客拿空串：他们的请求根本不走钥匙（见 tokenNeedOf 的 none 级），
    // 注入真钥匙只会多一处泄露面。
    .replace(/__LOCAL_TOKEN__/g, withAdmin && !fromLan ? adminToken : '')
    .replace(/__UI_TOKEN__/g, withAdmin ? adminToken : fromLan ? '' : uiToken);
  const body = Buffer.from(stampAssetUrls(html), 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// 导出素材的落地目录：默认在桌面的「画布导出」里，找不到桌面就退回程序目录
// 只认「用户刚在弹出的系统窗口里选过的那个目录」：也就是 config.exportDir。
// 请求体里的 destDir 一律以它为准，不再按字符串随便建目录——
// 否则任何能发请求的东西都能让服务往 C:\Windows\System32 里写文件。
function exportDestDir(asked) {
  const chosen = String(config.exportDir || '').trim();
  const custom = String(asked || '').trim();
  if (custom) {
    const abs = path.isAbsolute(custom) ? custom : path.resolve(paths.ROOT, custom);
    // 必须是用户自己点选过的目录，客户端传什么就写什么的时代到此为止
    if (!chosen || path.resolve(chosen) !== path.resolve(abs)) {
      log('导出目录被替换成未授权的路径，已拒绝：' + abs);
      return null;
    }
    try {
      fs.mkdirSync(abs, { recursive: true });
      return abs;
    } catch {
      return null;
    }
  }
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const desktop = path.join(home, 'Desktop');
  const base = home && fs.existsSync(desktop) ? desktop : paths.ROOT;
  const dir = path.join(base, '画布导出');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

// 同名文件不覆盖：xxx.png、xxx-2.png、xxx-3.png
function uniqueFile(dir, base, ext) {
  let target = path.join(dir, base + ext);
  let index = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, base + '-' + index + ext);
    index += 1;
  }
  return target;
}

// 素材目录里的文件：/media/图片/xxx.png，支持拖播放条（Range）
function serveMedia(req, res, relPath) {
  const target = assets.resolveMedia(config.assetRoot, relPath);
  if (!target) return sendText(res, 403, '不允许访问该路径');
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return sendText(res, 404, '找不到这个素材');
  const stat = fs.statSync(target);
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
        return res.end();
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      return fs.createReadStream(target, { start: start, end: end }).pipe(res);
    }
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  return fs.createReadStream(target).pipe(res);
}

let config = null;
let activePort = 0;
let shutdownServer = null;

function statusPayload() {
  const tools = paths.toolsInfo();
  return {
    ok: true,
    port: activePort,
    url: 'http://127.0.0.1:' + activePort,
    root: paths.ROOT,
    assetRoot: config.assetRoot,
    dataDir: paths.DATA_DIR,
    tools: {
      ffmpeg: Boolean(tools.ffmpeg),
      ffprobe: Boolean(tools.ffprobe),
    },
    writable: paths.dirWritable(config.assetRoot),
    stats: store.stats(),
    defaults: {
      image: config.image,
      video: config.video,
      ui: config.ui,
    },
    ui: config.ui,
    store: config.store,
    shortcuts: config.shortcuts,
    submitCompress: config.submitCompress,
    tailPrompts: config.tailPrompts,
    // 尾部预设的结构版本：前端拿它跟自己的比对，不一致就提示"服务需要重启"。
    // 这是 2026-11-08 那次"预设被清空"事故的防线之一 —— 见 config.js 的注释。
    tailSchemaVersion: configStore.TAIL_SCHEMA_VERSION,
    // 局域网访问：开关 + 可供另一台电脑直接输入的地址（只列真实网卡，不含回环 / 自动地址）
    lan: {
      enabled: Boolean(config.lan && config.lan.enabled),
      addresses: guard.lanAddresses(),
      port: activePort,
    },
    checks: selfCheck(tools),
    keyProtection: keybox.state(),
    channels: config.channels.length,
    startedAt: startedAt,
  };
}

// 启动自检：素材目录能不能写、解码工具在不在、通道密钥填了没有，一目了然
function selfCheck(tools) {
  const list = [];
  list.push({
    key: 'assetRoot',
    label: '素材目录',
    ok: paths.dirWritable(config.assetRoot),
    detail: config.assetRoot,
  });
  list.push({
    key: 'ffmpeg',
    label: '解码工具',
    ok: Boolean(tools && tools.ffmpeg),
    detail: tools && tools.ffmpeg ? '已就绪，尾帧精确到最后一帧' : '没找到 tools\\ffmpeg.exe，尾帧只能近似提取',
  });
  const all = Array.isArray(config.channels) ? config.channels : [];
  const withKey = all.filter((channel) => channel && channel.enabled !== false && String(channel.apiKey || '').trim()).length;
  list.push({
    key: 'keys',
    label: '接口密钥',
    ok: withKey > 0,
    detail: all.length ? withKey + ' / ' + all.length + ' 个通道已填密钥' : '还没有配置任何通道',
  });
  list.push({ key: 'port', label: '服务端口', ok: Boolean(activePort), detail: 'http://127.0.0.1:' + activePort });
  const lanOn = Boolean(config.lan && config.lan.enabled);
  const lanIps = guard.lanAddresses();
  list.push({
    key: 'lan',
    label: '局域网访问',
    ok: lanOn ? lanIps.length > 0 : true,
    detail: lanOn
      ? (lanIps.length
        ? '已打开：' + lanIps.map((ip) => 'http://' + ip + ':' + activePort).join('、')
        : '已打开，但这台电脑没有可用的局域网地址（网线 / Wi-Fi 没连上）')
      : '关闭（只有本机能打开）',
  });
  // 密钥保护一旦失灵，表面上一切正常、只有生成时才 401，所以必须在自检里显式列出来
  const seal = keybox.state();
  list.push({
    key: 'keyProtect',
    label: '密钥加密',
    ok: seal.enabled && !seal.error,
    detail: seal.error ? seal.error : '已启用（磁盘上只存密文，解封钥匙与当前 Windows 用户绑定）',
  });
  return list;
}

let startedAt = Date.now();

// 把渠道里配置的模型摊平给前端，卡片上的模型下拉框直接用这份清单
function modelsPayload() {
  const out = { image: [], video: [], audio: [] };
  (config.channels || []).forEach((channel) => {
    if (!channel || channel.enabled === false) return;
    const kinds = Array.isArray(channel.kinds) && channel.kinds.length ? channel.kinds : ['image'];
    const models = channel.models && typeof channel.models === 'object' ? channel.models : {};
    const defaults = channel.defaults && typeof channel.defaults === 'object' ? channel.defaults : {};
    kinds.forEach((kind) => {
      if (!out[kind]) return;
      const list = Array.isArray(models[kind]) ? models[kind] : [];
      const picked = String(defaults[kind] || '').trim();
      list.forEach((entry) => {
        const id = channels.modelId(entry);
        if (!id) return;
        out[kind].push({
          id: id,
          label: channels.modelLabel(entry),
          note: channels.modelNote(entry),
          // 图片模型也带上规格（能选几 K、哪些比例），卡片上的选项跟着变
          spec: modelSpecs.forModel(id),
          channel: channel.name || channel.id || '',
          channelId: channel.id || '',
          isDefault: picked ? id === picked : false,
          notes: channel.notes || '',
        });
      });
    });
  });
  return out;
}

async function handleApi(req, res, pathname, query) {
  const method = req.method.toUpperCase();

  // 接口通道的读写、测试、拉模型只允许本机的「接口通道设置」窗口调用。
  // 这道判断已经提前在 requestHandler 的守卫里做过（admin 级），这里不再重复。

  if (pathname === '/api/status' && method === 'GET') {
    return sendJson(res, 200, statusPayload());
  }

  // 库出过状况（打不开、被挪走、重建过）时，让页面能主动问一句。
  // 只暴露原因和旧库位置，不含任何画布内容，所以不设鉴权。
  if (pathname === '/api/health' && method === 'GET') {
    const notice = store.getHealthNotice();
    return sendJson(res, 200, {
      ok: !notice,
      dataDir: paths.DATA_DIR,
      notice: notice,
    });
  }

  // 用户点掉告警后清掉标记，避免每次都弹
  if (pathname === '/api/health/ack' && method === 'POST') {
    const had = store.clearHealthNotice();
    return sendJson(res, 200, { ok: true, cleared: had });
  }

  // 托盘图标里点「退出」时走这里：只认本机钥匙，网页和其它程序都调不动
  if (pathname === '/api/local/shutdown' && method === 'POST') {
    const given = String(req.headers['x-local-token'] || '');
    if (!adminToken || given !== adminToken) {
      return sendJson(res, 401, { error: '只有本机托盘能停服务' });
    }
    sendJson(res, 200, { ok: true, stopping: true });
    log('从托盘收到退出指令，服务正在关闭');
    if (shutdownServer) setTimeout(shutdownServer, 120);
    return;
  }

  // ---- 程序代码同步 ----
  // 主机侧：只读清单 + 按需取单个文件。两个都不需要钥匙（另一台电脑没有），
  // 但路径必须先过 codesync 的白名单，越界直接 403。
  if (pathname === '/api/codesync/manifest' && method === 'GET') {
    return sendJson(res, 200, codesync.manifest());
  }
  if (pathname === '/api/codesync/file' && method === 'GET') {
    const rel = String(query.get('path') || '');
    const abs = codesync.resolveCodePath(rel);
    if (!abs || !codesync.isCodeFile(rel)) {
      return sendJson(res, 403, { error: '这个路径不在允许同步的范围内：' + rel });
    }
    const stat = fs.statSync(abs);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(abs).pipe(res);
    return undefined;
  }
  // 本机侧：拿另一台电脑的清单做对比（只读，不写盘）
  if (pathname === '/api/codesync/plan' && method === 'GET') {
    try {
      const report = await codesync.plan(String(query.get('host') || ''));
      return sendJson(res, 200, report);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  // 本机侧：真正拉取并落盘（覆盖前先把老文件备份进 data\codesync-backup）
  if (pathname === '/api/codesync/pull' && method === 'POST') {
    const body = await readBody(req, 1024 * 1024);
    try {
      const report = await codesync.pull(String((body && body.host) || ''));
      log('程序代码同步完成：新增 ' + report.added.length + '，更新 ' + report.updated.length +
        '，失败 ' + report.failed.length);
      return sendJson(res, 200, report);
    } catch (error) {
      log('程序代码同步失败：' + error.message);
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/models' && method === 'GET') {
    return sendJson(res, 200, modelsPayload());
  }
  // 画布上的「通道状态」面板：只读汇总每个通道的余额 / 班次。
  // 这里刻意不返回密钥、地址和请求头，画布页拿到的都是能公开看的信息。
  if (pathname === '/api/channel-status' && method === 'GET') {
    try {
      const fresh = String(query.get('fresh') || '') === '1';
      const data = await channels.queryStatus(config, { fresh: fresh });
      return sendJson(res, 200, data);
    } catch (error) {
      log('查通道状态失败：' + error.message);
      return sendJson(res, 400, { error: error.message });
    }
  }

  // 日志：不填 day 就列出所有日期 + 内存里最近几行；填了就读那一天的。
  // 顺带带上缩略图生成失败清单：卡片会静默回退到原图，不写出来用户完全不知道为什么卡。
  if (pathname === '/api/log' && method === 'GET') {
    const day = String(query.get('day') || '').trim();
    const days = logfile.listDays();
    const thumbFailures = thumbs.listFailures();
    if (!day) {
      return sendJson(res, 200, {
        days: days,
        day: days[0] || '',
        lines: logRing.slice(-200),
        live: true,
        thumbFailures: thumbFailures,
      });
    }
    return sendJson(res, 200, {
      days: days,
      day: day,
      lines: logfile.readDay(day, Number(query.get('tail')) || 800),
      live: false,
      thumbFailures: thumbFailures,
    });
  }

  // 把某一天的日志当场下下来
  if (pathname === '/api/log/download' && method === 'GET') {
    const day = String(query.get('day') || '').trim();
    const file = logfile.fileOf(day);
    if (!file) return sendText(res, 404, '这一天的日志还没有');
    const raw = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="canvas-log-' + day + '.log"',
      'Content-Length': raw.length,
    });
    return res.end(raw);
  }

  // 界面设置 / 素材目录 / 归档方式 / 默认参数
  if (pathname === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    const changed = [];
    if (typeof body.assetRoot === 'string' && body.assetRoot.trim() && body.assetRoot.trim() !== config.assetRoot) {
      const raw = body.assetRoot.trim();
      // 相对路径一律按程序目录算，避免跟着启动目录乱跑
      const target = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(paths.ROOT, raw);
      // 先确认这个目录真的能用（盘符在、能写文件），确认不了就原样退回去，不动现有设置
      if (!paths.dirWritable(target)) {
        return sendJson(res, 400, {
          error: '这个素材目录用不了：' + target + '（盘符不存在或没有写入权限），素材目录保持原样',
        });
      }
      const previous = config.assetRoot;
      config.assetRoot = target;
      // 目录就在程序文件夹里，就顺手记下相对位置：整个文件夹搬到别的电脑/别的盘，也不用重设
      const relToRoot = path.relative(paths.ROOT, target);
      if (relToRoot && !relToRoot.startsWith('..') && !path.isAbsolute(relToRoot)) {
        config.assetRootRel = relToRoot.split(path.sep).join('/');
      } else {
        config.assetRootRel = '';
      }
      paths.ensureAssetLayout(config.assetRoot);
      changed.push('素材目录');
      log('素材目录已改：' + previous + ' → ' + config.assetRoot + '（旧目录里的素材保持原样，没有搬动）');
    }
    if (body.ui && typeof body.ui === 'object') {
      config.ui = configStore.normalizeUi(Object.assign({}, config.ui, body.ui));
      changed.push('界面显示');
    }
    if (body.store && typeof body.store === 'object') {
      config.store = configStore.normalizeStore(Object.assign({}, config.store, body.store));
      changed.push('归档方式');
    }
    if (body.shortcuts && typeof body.shortcuts === 'object') {
      config.shortcuts = configStore.normalizeShortcuts(Object.assign({}, config.shortcuts, body.shortcuts));
      changed.push('快捷键');
    }
    if (body.submitCompress !== undefined) {
      config.submitCompress = configStore.normalizeSubmitCompress(body.submitCompress);
      changed.push('提交压缩');
      log('提交压缩已' + (config.submitCompress.enabled ? '打开' : '关闭'));
    }
    if (body.tailPrompts !== undefined) {
      // **安全网**：拒绝"会把已有预设清空"的保存。
      //
      // 背景（2026-11-08 的真实事故）：服务进程跑的是旧代码、页面是新前端时，
      // 新前端发 {enabled, groups:{...}}，旧服务端只认扁平 raw.presets，
      // 于是把用户的预设读成空并落盘 —— 那套 335 字的预设就没了。
      //
      // 判据：这次提交**没有任何可识别的预设**，而磁盘上**原本有** →
      // 这几乎一定是"两端字段对不上"，而不是用户真的想全删。
      // 这种情况宁可报错让用户重开，也不能安静地把内容抹掉。
      // 用户真要清空，可以先删掉预设的正文内容（那样服务端会正常接受）。
      const beforeCount = (function () {
        const v = configStore.tailPoolOfConfig(config, 'video');
        const i = configStore.tailPoolOfConfig(config, 'image');
        return v.presets.length + i.presets.length;
      })();
      const incoming = configStore.tailPromptsShapeOf(body.tailPrompts);
      const normalized = configStore.normalizeTailPrompts(body.tailPrompts);
      const afterCount = normalized.groups.video.presets.length + normalized.groups.image.presets.length;
      // 只有"**旧形状**（没有 groups）+ 空内容"才是版本错配的特征 ——
      // 新前端一律发 groups，所以它清空预设是**真心想清空**，必须放行。
      // 这样安全网既能拦住事故，又不会把用户锁死。
      if (beforeCount > 0 && afterCount === 0 && incoming !== 'groups') {
        log('拒绝了这次尾部提示词保存：提交是旧形状（' + incoming + '）且没有任何预设，' +
          '而当前有 ' + beforeCount + ' 套。为避免误清空，没有写入。');
        return sendJson(res, 409, {
          error: '这次提交的格式是旧版的，里面没有带任何尾部提示词预设，但当前已有 ' + beforeCount +
            ' 套。为避免把你的预设清空，这次没有保存。' +
            '这通常是因为页面已经更新、而画布服务还是旧进程 —— 请重启一下画布服务再试。',
        });
      }
      config.tailPrompts = normalized;
      changed.push('尾部提示词');
      // 分两个池子了，日志要把两边都报出来，否则"只有 1 套"会让人以为图片那套没存上
      const vPool = configStore.tailPoolOfConfig(config, 'video');
      const iPool = configStore.tailPoolOfConfig(config, 'image');
      log('尾部提示词已更新：视频 ' + vPool.presets.length + ' 套 / 图片 ' + iPool.presets.length +
        ' 套，' + (config.tailPrompts.enabled ? '启用' : '关闭'));
    }
    if (body.lan !== undefined) {
      const before = Boolean(config.lan && config.lan.enabled);
      config.lan = configStore.normalizeLan(body.lan);
      if (config.lan.enabled !== before) {
        changed.push('局域网访问');
        log('局域网访问已' + (config.lan.enabled ? '打开' : '关闭') + '，需要重启服务才会生效');
      }
    }
    if (body.image && typeof body.image === 'object') {
      config.image = Object.assign({}, config.image, body.image);
      changed.push('图片默认');
    }
    if (body.video && typeof body.video === 'object') {
      config.video = Object.assign({}, config.video, body.video);
      changed.push('视频默认');
    }
    if (changed.length) {
      configStore.save(config);
      log('设置已更新：' + changed.join('、'));
    }
    return sendJson(res, 200, statusPayload());
  }

  // 素材库：浏览、搜索、筛选、排序
  if (pathname === '/api/library' && method === 'GET') {
    return sendJson(
      res,
      200,
      library.listAssets(config.assetRoot, {
        kind: query.get('kind') || 'all',
        q: query.get('q') || '',
        sort: query.get('sort') || 'time',
      })
    );
  }

  // 删素材：挪进回收站，不当场销毁
  if (pathname === '/api/library/delete' && method === 'POST') {
    const body = await readBody(req);
    const result = library.deleteAssets(config.assetRoot, body.relPaths);
    log('素材已移入回收站：' + result.moved + ' 个' + (result.failed.length ? '，失败 ' + result.failed.length + ' 个' : ''));
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/library/orphans' && method === 'GET') {
    return sendJson(res, 200, library.orphanReport(config));
  }

  if (pathname === '/api/library/orphans/clean' && method === 'POST') {
    const report = library.orphanReport(config);
    const result = library.deleteAssets(
      config.assetRoot,
      report.orphans.map((item) => item.relPath)
    );
    log('清理孤儿素材：' + result.moved + ' 个');
    return sendJson(res, 200, { moved: result.moved, failed: result.failed, recycle: result.recycle });
  }

  // 回收站：删掉的素材挪进 data\recycle 后不会当场销毁，这里能列出来并摆回去
  if (pathname === '/api/library/recycle') {
    if (method === 'GET') {
      return sendJson(res, 200, library.listRecycle());
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const result = library.restoreRecycle(config.assetRoot, body.batchId, body.items);
      if (!result.ok) return sendJson(res, 400, { error: result.error });
      log('从回收站还原素材：成功 ' + result.moved + ' 个' + (result.skipped.length ? '，' + result.skipped.length + ' 个同名已存在被跳过' : ''));
      return sendJson(res, 200, {
        moved: result.moved,
        skipped: result.skipped,
        failed: result.failed,
      });
    }
  }

  if (pathname === '/api/channels') {
    if (method === 'GET') {
      return sendJson(res, 200, { channels: config.channels || [], template: channels.defaultChannel() });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const before = new Set((config.channels || []).map((one) => one && one.id));
      config.channels = channels.normalizeChannels(body.channels);
      configStore.save(config);
      // 顺手做一遍兼容体检：新出现的通道（通常是刚导入的）缺了什么，
      // 在这里就告诉前端，别等用户真点生成才报平台的错（清单 40）。
      const check = channels.inspectChannels(config.channels);
      const fresh = check.items.filter((one) => one && !before.has(one.id));
      log('接口通道已保存，共 ' + config.channels.length + ' 个');
      return sendJson(res, 200, {
        channels: config.channels,
        check: check,
        // 本次新加进来的通道里，有问题的那些——前端导入完直接照着提示
        freshProblems: fresh.filter((one) => !one.ok),
      });
    }
    return sendJson(res, 405, { error: '不支持的操作' });
  }

  if (pathname === '/api/channels/probe' && method === 'POST') {
    const body = await readBody(req);
    const channel = channels.normalizeChannel(body.channel);
    try {
      const result = await channels.probeModels(channel);
      log('拉取模型成功：' + (channel.name || '通道') + '，共 ' + result.models.length + ' 个');
      return sendJson(res, 200, {
        models: result.models,
        split: channels.splitModels(result.models, channel.filters),
        url: result.url,
      });
    } catch (error) {
      log('拉取模型失败：' + error.message);
      return sendJson(res, 400, { error: error.message });
    }
  }

  // 查通道余额：只读接口，不会扣次数；草稿也不用先保存
  if (pathname === '/api/channels/balance' && method === 'POST') {
    const body = await readBody(req);
    const channel = channels.normalizeChannel(body.channel);
    try {
      const result = await channels.queryBalance(channel);
      log('查余额成功：' + (channel.name || '通道') + '，剩余 ' + (result.credits === null ? '未知' : result.credits));
      return sendJson(res, 200, result);
    } catch (error) {
      log('查余额失败：' + (channel.name || '通道') + '，' + error.message);
      return sendJson(res, 400, { error: error.message });
    }
  }

  // 查下一班发车：只读接口，不会扣次数；草稿也不用先保存
  if (pathname === '/api/channels/ride' && method === 'POST') {
    const body = await readBody(req);
    const channel = channels.normalizeChannel(body.channel);
    try {
      const result = await channels.queryRide(channel);
      log('查班次成功：' + (channel.name || '通道'));
      return sendJson(res, 200, result);
    } catch (error) {
      log('查班次失败：' + (channel.name || '通道') + '，' + error.message);
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/channels/test-image' && method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await generate.testImage(config, {
        channelId: body.channelId,
        channelName: body.channelName,
        model: body.model,
        prompt: body.prompt,
        sizeKey: body.sizeKey,
        ratio: body.ratio,
      });
      log('试生成成功：' + result.relPath);
      return sendJson(res, 200, { result: result });
    } catch (error) {
      log('试生成失败：' + error.message);
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/channels/test-video' && method === 'POST') {
    const body = await readBody(req);
    const model = String(body.model || '').trim();
    const channel = channels.findChannel(config, {
      channelId: body.channelId,
      channelName: body.channelName,
      kind: 'video',
      model: model,
    });
    if (!channel) return sendJson(res, 400, { error: '这个通道没有视频模型：先填好视频模型，并确认通道勾了「视频」' });
    const prompt = String(body.prompt || '一只小猫坐在窗边看雨，镜头缓慢推进，电影感光线').trim();
    const task = tasks.start(
      {
        channel: channel.name,
        kind: 'video',
        model: model,
        params: { duration: body.duration, resolution: body.resolution, ratio: body.ratio },
        prompt: prompt.slice(0, 120),
      },
      (ctx) =>
        generate.runKind(
          config,
          'video',
          {
            channelId: channel.id,
            model: model,
            prompt: prompt,
            promptRaw: prompt,
            duration: Number(body.duration) || 5,
            resolution: String(body.resolution || '720p'),
            ratio: String(body.ratio || '16:9'),
            mode: 'reference',
            refs: [],
          },
          ctx
        )
    );
    log('试生成视频已提交：' + (model || '默认模型') + '（' + channel.name + '）');
    return sendJson(res, 200, { task: task });
  }

  // 抽尾帧：给一段视频，抽出真正的最后一帧，存进 素材\尾帧
  if (pathname === '/api/tailframe' && method === 'POST') {
    const body = await readBody(req);
    const source = String(body.url || body.relPath || '').trim();
    if (!source) return sendJson(res, 400, { error: '没给视频地址' });
    const frame = await generate.extractLastFrame(
      config,
      source,
      String(body.name || '').trim(),
      generate.subFolderOf(config, { canvasId: body.canvasId })
    );
    log('尾帧已抽出：' + frame.relPath);
    return sendJson(res, 200, { frame: frame });
  }

  // 把本地挑的文件收进 素材 目录（原始字节直接传上来）
  //
  // 同一个文件第二次上传时默认不重复存：先算内容指纹，命中已有素材就把选择权交给前端
  // （dup=ask 时不落盘，回 duplicate 让用户挑；dup=reuse 直接用已有的；dup=copy 存新的一份）。
  // 老的调用方不带 dup，行为与从前一致（直接存），不会因为这次改动而坏掉。
  if (pathname === '/api/assets/import' && method === 'POST') {
    const name = String(query.get('name') || '本地素材');
    let kind = String(query.get('kind') || '');
    const dup = String(query.get('dup') || '');
    const buffer = await readRaw(req);
    if (!buffer.length) return sendJson(res, 400, { error: '没收到文件内容' });
    if (['image', 'video', 'audio'].indexOf(kind) < 0) kind = assets.kindOfFile(name, buffer).kind;
    if (!kind) {
      return sendJson(res, 400, { error: '认不出「' + name + '」是什么类型，只支持图片 / 视频 / 音频' });
    }
    const subFolder = generate.subFolderOf(config, { canvasId: query.get('canvasId') });

    if (dup === 'ask' || dup === 'reuse') {
      const hit = assetIndex.findDuplicate(config.assetRoot, buffer);
      if (hit) {
        if (dup === 'reuse') {
          log('本地素材命中已有的一份，直接引用：' + hit.relPath);
          return sendJson(res, 200, {
            asset: {
              relPath: hit.relPath,
              url: hit.url,
              width: hit.width,
              height: hit.height,
              bytes: hit.bytes,
              kind: hit.kind || kind,
            },
            reused: true,
          });
        }
        // dup=ask：先不落盘，把选择交给用户
        return sendJson(res, 200, {
          duplicate: {
            name: hit.name,
            relPath: hit.relPath,
            url: hit.url,
            bytes: hit.bytes,
            at: hit.at,
            width: hit.width,
            height: hit.height,
            kind: hit.kind || kind,
          },
        });
      }
    }

    const saved = assets.importAsset(config.assetRoot, kind, name, buffer, subFolder);
    assetIndex.remember(config.assetRoot, buffer, saved, name);
    log('本地素材已收进：' + saved.relPath);
    return sendJson(res, 200, { asset: saved });
  }

  if (pathname === '/api/export/pick-dir' && method === 'POST') {
    try {
      const picked = await pickFolderDialog(config.exportDir || '');
      if (picked.cancelled) {
        return sendJson(res, 200, { cancelled: true, path: '' });
      }
      config.exportDir = picked.path;
      configStore.save(config);
      log('导出目录已选择：' + picked.path);
      return sendJson(res, 200, { cancelled: false, path: picked.path });
    } catch (error) {
      return sendJson(res, 500, { error: '打开选择窗口失败：' + error.message });
    }
  }

  if (pathname === '/api/export/assets' && method === 'POST') {
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return sendJson(res, 400, { error: '没有可导出的素材' });
    const destDir = exportDestDir(body.destDir);
    if (!destDir) return sendJson(res, 400, { error: '导出目录不可用' });
    config.exportDir = destDir;
    try {
      configStore.save(config);
    } catch {
      /* 记不住也不影响这次导出 */
    }
    const saved = [];
    const failed = [];
    for (const item of items) {
      const relPath = String(item.file || '').trim();
      const origin = assets.resolveMedia(config.assetRoot, relPath);
      if (!origin || !fs.existsSync(origin) || !fs.statSync(origin).isFile()) {
        failed.push({ name: item.name || relPath, error: '找不到素材文件' });
        continue;
      }
      try {
        const ext = path.extname(origin);
        // 传进来的名字可能已经带了扩展名，先剥掉，避免出现 xxx.png.png
        const asked = String(item.name || '').trim();
        const cut = asked ? asked.slice(0, asked.length - (asked.endsWith(ext) ? ext.length : 0)) : '';
        const base = assets.safeName(cut || path.basename(origin, ext), '素材', 60);
        const target = uniqueFile(destDir, base, ext);
        fs.copyFileSync(origin, target);
        saved.push({ name: path.basename(target), path: target });
      } catch (error) {
        failed.push({ name: item.name || relPath, error: error.message });
      }
    }
    log('导出素材：成功 ' + saved.length + ' 个，失败 ' + failed.length + ' 个 → ' + destDir);
    return sendJson(res, 200, { dir: destDir, saved: saved, failed: failed });
  }
  // 提交前预检：只读参考素材并试压，不调用上传 / 生成接口，不会产生费用
  if (pathname === '/api/preflight' && method === 'POST') {
    const body = await readBody(req);
    const report = await generate.preflight(config, body || {});
    return sendJson(res, 200, report);
  }

  if (pathname === '/api/generate' && method === 'POST') {
    const body = await readBody(req);
    const asked = String(body.kind || 'image');
    const kind = ['image', 'video', 'audio'].indexOf(asked) >= 0 ? asked : 'image';
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
    const model = String(body.model || '').trim();
    const channel = channels.findChannel(config, {
      channelId: body.channelId,
      channelName: body.channelName,
      kind: kind,
      model: model,
    });
    if (!channel) {
      return sendJson(res, 400, {
        error: '还没有能生成' + label + '的通道，先到门户页的「接口通道」里加一个，并勾上「' + label + '」',
      });
    }
    // 尾部提示词在服务端统一拼：前端预览和真正提交用的是同一套规则，
    // 定时组则带 frozenTail 快照，运行期间改预设不会影响已经开始的这一轮。
    // kind 显式传进去 —— 图片和视频各用各的预设池，不能靠猜。
    let submission = null;
    try {
      submission = generate.composeSubmission(config, body || {}, kind);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
    const runPayload = Object.assign({}, body, {
      channelId: channel.id,
      apiPrompt: submission.apiPrompt,
      promptRaw: submission.mainPrompt,
    });
    const task = tasks.start(
      {
        canvasId: body.canvasId,
        nodeId: body.nodeId,
        channel: channel.name,
        kind: kind,
        model: model,
        params: {
          sizeKey: body.sizeKey,
          ratio: body.ratio,
          count: body.count,
          duration: body.duration,
          resolution: body.resolution,
          mode: body.mode,
          mainPrompt: submission.mainPrompt,
          // 不存 submittedPrompt：它就是 mainPrompt 再拼一段尾部提示词，
          // 由下面三个字段能精确还原（见 web/assets/canvas.js 的
          // composedPromptOf）。存一份是整份任务记录里最大的一笔重复。
          tailPresetId: submission.tailPresetId || '',
          tailPresetName: submission.tailPresetName || '',
          tailText: submission.tailText || '',
          tailAppended: Boolean(submission.tailAppended),
        },
        prompt: submission.apiPrompt.slice(0, 120),
      },
      (ctx) => generate.runKind(config, kind, runPayload, ctx)
    );
    log(label + '任务已提交：' + (model || '默认模型') + '（' + channel.name + '）' + (submission.tailEnabled ? '，已带尾部提示词「' + submission.tailPresetName + '」' : ''));
    return sendJson(res, 200, { task: task, submission: submission });
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(cancel))?$/);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]);
    if (taskMatch[2] === 'cancel' && method === 'POST') {
      const ok = tasks.cancel(taskId);
      let current = store.getTask(taskId);
      // 内存里没有这条任务时（服务重启过、或记录是更早留下的），直接把库里的记录标成已取消，
      // 免得卡片和任务面板永远停在「生成中」
      if (!ok && current && (current.status === 'queued' || current.status === 'running')) {
        store.updateTask(taskId, { status: 'canceled', stage: '已取消', error: '' });
        log('这条任务已经不在运行中，直接把记录标记为已取消：' + taskId);
        current = store.getTask(taskId);
      }
      return sendJson(res, 200, { ok: ok, task: store.getTask(taskId) });
    }
    if (method === 'GET') {
      const task = store.getTask(taskId);
      if (!task) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, { task: task });
    }
    return sendJson(res, 405, { error: '不支持的操作' });
  }

  if (pathname === '/api/tasks' && method === 'GET') {
    // 带上画布名字，任务面板里就能一眼看出这条任务属于哪块画布
    const names = new Map(store.listCanvases().map((item) => [item.id, item.name]));
    // 画布页会用 canvasId + active=1 拉「这块画布上还在跑的任务」，
    // 好把别处（例如接口直接提交、另一个标签页）发起的生成也接管过来显示
    const filterCanvas = String(query.get('canvasId') || '').trim();
    const activeOnly = String(query.get('active') || '') === '1';
    const list = store
      .listTasks(Number(query.get('limit')) || 120, { canvasId: filterCanvas, activeOnly: activeOnly })
      .map((task) =>
      Object.assign({}, task, {
        canvasName: names.get(task.canvasId) || '',
        canvasExists: !!task.canvasId && names.has(task.canvasId),
      })
    );
    return sendJson(res, 200, { tasks: list });
  }

  // ---------- 定时生成组 ----------
  if (pathname === '/api/schedules' && method === 'GET') {
    const canvasId = String(query.get('canvasId') || '').trim();
    if (!canvasId) return sendJson(res, 400, { error: '要指定是哪块画布' });
    return sendJson(res, 200, { schedules: scheduler.listOf(canvasId) });
  }

  const scheduleMatch = pathname.match(/^\/api\/schedules\/([^/]+)(?:\/(start|pause|stop))?$/);
  if (scheduleMatch) {
    const nodeId = decodeURIComponent(scheduleMatch[1]);
    const action = scheduleMatch[2];
    if (action === 'start' && method === 'POST') {
      const body = await readBody(req);
      const canvasId = String(body.canvasId || '').trim();
      if (!canvasId) return sendJson(res, 400, { error: '要指定是哪块画布' });
      try {
        const status = scheduler.start(canvasId, nodeId, body || {});
        return sendJson(res, 200, { schedule: status });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }
    if (action === 'pause' && method === 'POST') {
      const run = store.getScheduleRun(nodeId);
      if (!run) return sendJson(res, 404, { error: '这个定时组还没开始' });
      try {
        return sendJson(res, 200, { schedule: scheduler.pause(run.canvasId, nodeId) });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }
    if (action === 'stop' && method === 'POST') {
      const run = store.getScheduleRun(nodeId);
      if (!run) return sendJson(res, 404, { error: '这个定时组还没开始' });
      try {
        return sendJson(res, 200, { schedule: scheduler.stop(run.canvasId, nodeId) });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }
    if (!action && method === 'GET') {
      const run = store.getScheduleRun(nodeId);
      if (!run) return sendJson(res, 404, { error: '这个定时组还没有运行记录' });
      return sendJson(res, 200, { schedule: scheduler.statusOf(run.canvasId, nodeId) });
    }
    if (!action && method === 'DELETE') {
      const run = store.getScheduleRun(nodeId);
      scheduler.forget(run ? run.canvasId : '', nodeId);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: '不支持的操作' });
  }

  // ---- 共享工作区 ----
  // 一块画布 shared=1 就对局域网开放；不开的时候，局域网能做的事和以前一模一样。
  if (pathname === '/api/share/list' && method === 'GET') {
    return sendJson(res, 200, { canvases: store.listSharedCanvases(), limit: share.MAX_SESSIONS });
  }

  // 开 / 关共享只在本机做：这是「把门打开」的动作，不能让门里的人自己扩权
  const shareToggle = pathname.match(/^\/api\/canvases\/([^/]+)\/share$/);
  if (shareToggle) {
    if (method !== 'POST') return sendJson(res, 405, { error: '不支持的操作' });
    const id = decodeURIComponent(shareToggle[1]);
    const body = await readBody(req);
    const result = body && body.on ? store.enableShare(id) : store.disableShare(id);
    if (!result) return sendJson(res, 404, { error: '画布不存在' });
    if (!body || !body.on) {
      const kicked = share.closeCanvas(id, 'bye', { reason: '这块画布已关闭共享' });
      log('已关闭共享：' + result.name + (kicked ? '（断开 ' + kicked + ' 人）' : ''));
    } else {
      log('已开启共享：' + result.name + '（局域网可进，最多 ' + share.MAX_SESSIONS + ' 人）');
    }
    return sendJson(res, 200, {
      canvas: store.getCanvas(id),
      online: share.countOnline(id),
      limit: share.MAX_SESSIONS,
    });
  }

  // 进共享画布：拉一次全量状态（后续都走增量）
  const shareState = pathname.match(/^\/api\/share\/([^/]+)\/state$/);
  if (shareState && method === 'GET') {
    const id = decodeURIComponent(shareState[1]);
    if (!store.isShared(id)) return sendJson(res, 403, { error: '这块画布没有开启共享' });
    const state = store.getState(id);
    if (!state) return sendJson(res, 404, { error: '画布不存在' });
    state.online = share.countOnline(id);
    state.limit = share.MAX_SESSIONS;
    state.local = !req.__fromLan;
    return sendJson(res, 200, state);
  }

  // 增量保存：只写「我改过的那几张」。别人改的卡片不受影响，这是共编的地基。
  const sharePatch = pathname.match(/^\/api\/share\/([^/]+)\/patch$/);
  if (sharePatch && method === 'POST') {
    const id = decodeURIComponent(sharePatch[1]);
    if (!store.isShared(id)) return sendJson(res, 403, { error: '这块画布没有开启共享' });
    const body = await readBody(req);
    const who = share.sessionOf(id, body && body.sessionId);
    // 会话可以已经超时掉了（页面挂后台很久），这时不拒收，只记成「一位访客」
    const name = (who && who.name) || '一位协作者';
    const result = store.applyPatch(id, body || {});
    if (!result) return sendJson(res, 404, { error: '画布不存在' });
    const changed = result.applied.upserted || result.applied.deleted || result.applied.edges;
    if (changed || result.conflicts.length) {
      share.broadcast(id, 'change', {
        rev: result.rev,
        by: name,
        sessionId: String((body && body.sessionId) || ''),
        // clientId 是页面自己生成的随机串：发起方据此认出「这是我发的」，
        // 不依赖 SSE 会话有没有建好（刚打开页面就动手时还没建好）
        clientId: String((body && body.clientId) || ''),
        applied: result.applied,
        conflicts: result.conflicts,
        updatedAt: result.savedAt || Date.now(),
      });
    }
    if (changed) log('共享保存：' + name + ' 改了 ' + result.applied.upserted + ' 张、删了 ' + result.applied.deleted + ' 张');
    return sendJson(res, 200, result);
  }

  // 在线名单（不进 SSE 也能问一句）
  const sharePresence = pathname.match(/^\/api\/share\/([^/]+)\/presence$/);
  if (sharePresence && method === 'GET') {
    const id = decodeURIComponent(sharePresence[1]);
    if (!store.isShared(id)) return sendJson(res, 403, { error: '这块画布没有开启共享' });
    return sendJson(res, 200, {
      sessions: share.listSessions(id),
      count: share.countOnline(id),
      limit: share.MAX_SESSIONS,
    });
  }

  // 实时通道：SSE。别人的改动、谁进来了谁走了，都从这里推过来。
  const shareEvents = pathname.match(/^\/api\/share\/([^/]+)\/events$/);
  if (shareEvents && method === 'GET') {
    const id = decodeURIComponent(shareEvents[1]);
    if (!store.isShared(id)) {
      const why = '这块画布没有开启共享';
      if (pathname.indexOf('/api/') === 0) return sendJson(res, 403, { error: why });
      return sendText(res, 403, why);
    }
    if (!store.getCanvas(id)) return sendJson(res, 404, { error: '画布不存在' });
    const joined = share.join(id, req, res, {
      local: req.__fromLan !== true,
      clientId: String(query.get('client') || ''),
    });
    if (!joined.ok) return sendJson(res, joined.code, { error: joined.error });
    log('共享会话接入：' + joined.session.name + '（在线 ' + share.countOnline(id) + '/' + share.MAX_SESSIONS + '）');
    return undefined;
  }

  if (pathname === '/api/canvases') {
    if (method === 'GET') {
      // 局域网来的只列「开着共享」的那几块：别把主机所有画布的名字摆给协作者看
      if (req.__fromLan) {
        const shared = store.listSharedCanvases().map((one) => {
          const full = store.getCanvas(one.id);
          return full || one;
        });
        return sendJson(res, 200, { canvases: shared, sharedOnly: true });
      }
      return sendJson(res, 200, { canvases: store.listCanvases() });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { error: '请填写画布名字' });
      const created = store.createCanvas(name);
      log('新建画布：' + created.canvas.name);
      return sendJson(res, 200, created);
    }
    return sendJson(res, 405, { error: '不支持的操作' });
  }

  // 导入备份文件：单块画布搬来搬去用这个
  if (pathname === '/api/canvases/import' && method === 'POST') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.nodes)) return sendJson(res, 400, { error: '这个文件不是画布备份，里面没有卡片数据' });
    const imported = store.importCanvas(body);
    // 局域网协作者导进来的画布要直接标成共享：不标的话，他自己刷新一下就看不见了
    if (req.__fromLan) store.enableShare(imported.canvas.id);
    // 刚导进来的画布立刻留一份长期备份：以后就算改乱了，也还有「刚导入时」这一版
    backup.maybeBackup(imported.canvas.id, true);
    log('导入画布：' + imported.canvas.name + '（' + imported.nodeCount + ' 个卡片）');
    return sendJson(res, 200, imported);
  }

  // 只回「这块画布现在到第几版」，不带 nodes / edges。
  // 画布页手动点「检查更新」时用它比对版本号：整份 state 有几百 KB，
  // 而这里只有几十字节，比对一次几乎不花钱。
  const metaMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/meta$/);
  if (metaMatch) {
    if (method !== 'GET') return sendJson(res, 405, { error: '不支持的操作' });
    const id = decodeURIComponent(metaMatch[1]);
    const canvas = store.getCanvas(id);
    if (!canvas) return sendJson(res, 404, { error: '画布不存在' });
    return sendJson(res, 200, {
      id: canvas.id,
      name: canvas.name,
      rev: canvas.rev,
      updatedAt: canvas.updatedAt,
      nodeCount: canvas.nodeCount,
    });
  }

  const exportMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/export$/);
  if (exportMatch && method === 'GET') {
    const id = decodeURIComponent(exportMatch[1]);
    const payload = store.exportCanvas(id);
    if (!payload) return sendJson(res, 404, { error: '画布不存在' });
    log('导出画布：' + payload.canvas.name);
    return sendJson(res, 200, payload);
  }

  const backupMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/backups(?:\/(restore|snapshot))?$/);
  if (backupMatch) {
    const id = decodeURIComponent(backupMatch[1]);
    // 手动留一份快照：批量操作这类「一口气改动很多卡片」的动作，
    // 做之前先存一份，出问题能整块退回去。
    if (backupMatch[2] === 'snapshot' && method === 'POST') {
      const body = await readBody(req);
      const state = store.getState(id);
      if (!state) return sendJson(res, 404, { error: '画布不存在' });
      const name = backup.forceSnapshot(id, state, body.label || '手动存档');
      if (!name) return sendJson(res, 500, { error: '没能写下这次快照，检查一下磁盘空间' });
      log('手动存档：' + name);
      return sendJson(res, 200, { ok: true, name: name });
    }
    if (backupMatch[2] === 'restore' && method === 'POST') {
      const body = await readBody(req);
      const snapshot = backup.readBackup(id, body.name);
      if (!snapshot) return sendJson(res, 404, { error: '这个备份找不到了' });
      // 回滚会覆盖当前内容：先把「回滚前」的这一版强制留一份，
      // 用户回滚完发现不对，还能再退回来
      const before = store.getState(id);
      if (before) backup.forceSnapshot(id, before, '回滚前');
      const saved = store.saveState(id, { nodes: snapshot.nodes, edges: snapshot.edges, viewport: snapshot.viewport });
      if (!saved) return sendJson(res, 404, { error: '画布不存在' });
      log('画布已回滚到备份：' + String(body.name || '') + '（回滚前的版本已留档）');
      return sendJson(res, 200, { ok: true, savedAt: saved.savedAt, nodeCount: saved.nodeCount });
    }
    if (method === 'GET') {
      if (!store.getCanvas(id)) return sendJson(res, 404, { error: '画布不存在' });
      return sendJson(res, 200, { backups: backup.listBackups(id) });
    }
    return sendJson(res, 405, { error: '不支持的操作' });
  }

  const match = pathname.match(/^\/api\/canvases\/([^/]+)(?:\/(duplicate))?$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    if (action === 'duplicate' && method === 'POST') {
      const copy = store.duplicateCanvas(id);
      if (!copy) return sendJson(res, 404, { error: '画布不存在' });
      log('复制画布：' + copy.name);
      return sendJson(res, 200, { canvas: copy });
    }
    if (method === 'GET') {
      const state = store.getState(id);
      if (!state) return sendJson(res, 404, { error: '画布不存在' });
      return sendJson(res, 200, state);
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      // 先看这次保存会不会升级老数据。要升级的话，必须在写库之前把「旧样子」
      // 强制留一份 —— 留档这件事只有写库前做才有意义，写完了再留就是新数据了。
      // 清单 39 的「迁移必须可回退」就落在这一句上。
      const willMigrate = store.scanCanvasMigration(id);
      if (willMigrate.count) {
        const before = store.getState(id);
        if (before) backup.forceSnapshot(id, before, '数据升级前');
      }
      const result = store.saveState(id, body, body.rev);
      if (!result) return sendJson(res, 404, { error: '画布不存在' });
      // 冲突：这块画布在别的地方（多半是另一个标签页）已经被改过。
      // 这里一个字都不写，把服务端最新状态一起回过去，让前端去问用户怎么办。
      // 返回 409 而不是 200，前端才能和「保存成功」区分开。
      if (result.conflict) {
        log('画布保存被拒：版本号对不上（可能开了两个标签页），已回最新状态');
        const latest = store.getState(id);
        return sendJson(res, 409, {
          error: '这块画布在别的地方被改过了',
          conflict: true,
          rev: result.rev,
          savedAt: result.savedAt,
          nodeCount: result.nodeCount,
          state: latest,
        });
      }
      // 升级是「用户看不见、但确实动了他数据」的操作，留下一条可查的记录。
      // 库里那 28 块老画布就有 7 张废弃类型的卡片和 4 处老 prompt 字段，
      // 第一遍升级要能从日志里看出动了什么。
      if (result.migrated && result.migrated.count) {
        log('画布数据升级到第 ' + migrate.CURRENT_VER + ' 版：' + result.migrated.summary + '（升级前已留档）');
      }
      backup.maybeBackup(id);
      return sendJson(res, 200, result);
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const updated = store.renameCanvas(id, body.name);
      if (!updated) return sendJson(res, 404, { error: '画布不存在' });
      log('重命名画布：' + updated.name);
      return sendJson(res, 200, { canvas: updated });
    }
    if (method === 'DELETE') {
      scheduler.forgetCanvas(id);
      // 删除是「一步做错就难回头」的事，删之前把整块画布强制留一份到备份目录。
      // store.deleteCanvas 自己也会往回收站写一份，但那份和「历史版本」不是一个地方，
      // 用户从门户页的「历史版本」入口看不到；这里补上，两个入口都能找回。
      const before = store.getState(id);
      if (before) backup.forceSnapshot(id, before, '删除前');
      const ok = store.deleteCanvas(id);
      if (!ok) return sendJson(res, 404, { error: '画布不存在' });
      // 共享状态跟着画布一起消失：别留下一块「开着共享但打不开」的画布，
      // 也别让已经连上的人对着一块不存在的画布继续推改动
      store.clearShareOf(id);
      share.closeCanvas(id, 'bye', { reason: '这块画布已被删除' });
      log('删除画布（回收站与历史版本目录各留了一份）');
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: '不支持的操作' });
  }

  return sendJson(res, 404, { error: '接口不存在：' + pathname });
}

// 一个路径需要哪一级钥匙。
//   none  —— 页面、静态资源、素材、缩略图：只查 Host / Origin
//   ui    —— 普通接口：页面钥匙就够
//   admin —— 平台密钥与退出服务：只认管理钥匙
function tokenNeedOf(pathname, fromLan) {
  if (pathname.indexOf('/api/') !== 0) return 'none';
  // 这两个是「服务在不在」的探针：托盘和单实例检测都在用，
  // 内容只有路径与计数、没有任何密钥，所以不要求钥匙（Host/Origin 仍然查）。
  if (pathname === '/api/status' || pathname === '/api/health') return 'none';
  // 程序代码同步：另一台电脑手里没有本机钥匙，而且它要的就是「程序」，不是数据。
  // 只放开这两个只读接口，且内容受白名单限制（见 server/codesync.js）。
  if (isLanShareablePath(pathname)) return 'none';
  // 共享协作：局域网那台电脑同样拿不到本机钥匙（钥匙只注进本机打开的页面），
  // 所以这些路径必须走 none —— 它们的安全边界是「Host 是本机网卡 + Origin 同源」，
  // 加上「有一块画布正开着共享」。其余路径照旧要求钥匙，等于进不来。
  if (fromLan && lanCollabAllowed(pathname)) return 'none';
  if (pathname.indexOf('/api/channels') === 0) return 'admin';
  if (pathname.indexOf('/api/local/') === 0) return 'admin';
  return 'ui';
}

// 局域网只为一件事服务：让另一台电脑拉取「程序代码」。
// 只有这两个只读接口对外开放，别的全部拦下 —— 画布、素材库、生成任务
// 都是各台电脑自己的，不跨机同步（这也是「画布和素材库不要同步」的落地点）。
function isLanShareablePath(pathname) {
  return pathname === '/api/codesync/manifest' || pathname === '/api/codesync/file';
}

// 共享协作放行的范围。注意顺序：本机专属（平台密钥 / 退出 / 改配置 / 选目录 /
// 程序代码同步本机侧）一律先剔掉，再按前缀放行 —— 前缀匹配最容易被「多放一条」坑到。
function isCollabPath(pathname) {
  if (isLocalOnlyPath(pathname)) return false;
  // 这几条虽然不带密钥，但会改本机状态或弹本机窗口，协作者不该碰
  if (pathname === '/api/settings') return false;
  if (pathname === '/api/health/ack') return false;
  if (pathname.indexOf('/api/log') === 0) return false;
  if (pathname === '/api/export/pick-dir') return false;
  // 开 / 关共享是主机的权力：共享里再能开共享，等于谁都能把门开得更大
  if (/^\/api\/canvases\/[^/]+\/share$/.test(pathname)) return false;

  // 页面与静态资源：协作者要能打开画布页、看到图片缩略图
  if (pathname === '/' || pathname === '/index.html') return true;
  if (pathname === '/canvas' || pathname === '/canvas.html') return true;
  if (pathname === '/favicon.ico') return true;
  if (pathname.indexOf('/assets/') === 0) return true;
  if (pathname.indexOf('/media/') === 0) return true;
  if (pathname.indexOf('/thumb/') === 0) return true;

  // 接口：画布、素材库、生成、任务、定时组、共享本身
  if (pathname.indexOf('/api/') !== 0) return false;
  if (pathname === '/api/status' || pathname === '/api/health') return true;
  if (pathname === '/api/models' || pathname === '/api/channel-status') return true;
  if (pathname.indexOf('/api/library') === 0) return true;
  if (pathname === '/api/assets/import') return true;
  if (pathname === '/api/export/assets') return true;
  if (pathname === '/api/preflight' || pathname === '/api/generate') return true;
  if (pathname === '/api/tailframe') return true;
  if (pathname.indexOf('/api/tasks') === 0) return true;
  if (pathname.indexOf('/api/schedules') === 0) return true;
  if (pathname.indexOf('/api/canvases') === 0) return true;
  if (pathname.indexOf('/api/share') === 0) return true;
  return false;
}

// 局域网这条路放不放行：程序代码同步的两个人人可用的只读接口，
// 或者「有一块画布正开着共享」时的协作白名单。
// 「有共享画布」这一条很关键：没开共享的时候，局域网行为和以前完全一样。
function lanCollabAllowed(pathname) {
  if (isLanShareablePath(pathname)) return true;
  if (!isCollabPath(pathname)) return false;
  try {
    return store.hasShared();
  } catch {
    return false;
  }
}

// 局域网能碰哪些画布：只有开着共享的那几块。
// 返回空串表示放行，否则返回给用户看的原因。
//
// 「按 id 操作某块画布」的路径统一是 /api/canvases/<id>/...，
// 这里把 id 取出来问一句 store.isShared。新建（POST /api/canvases）和
// 导入（/api/canvases/import）不针对具体画布，不在拦截范围内：
// 导入进来的画布会直接标成共享，否则协作者导完自己也看不见。
//
// 保留它是因为它把「哪些第一段其实是固定词、不是画布编号」写清楚了，
// 而下面 lanTargetCanvasIds 的正则做不到这个区分 —— 见那里的 COLLECTION_SEGMENTS。
// （这个函数目前没有被调用；真正生效的是 lanTargetCanvasIds。
//   留着是为了别丢掉这条知识，两条路径的判断必须一致。）
function lanCanvasScopeDenied(pathname, method) {
  const match = /^\/api\/canvases\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match) return '';
  const id = (() => {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  })();
  // import 是「新建一块」，不是操作某一块；它自己的 id 段是字面量 import
  if (id === 'import') return '';
  if (store.isShared(id)) return '';
  return '这块画布没有开启共享，协作者不能操作它';
}

// 「按画布授权」用到的辅助：从各种请求里问出「这次操作落在哪块画布上」。
//
// 为什么需要它：协作放行的是「协作」这一整类接口，但其中不少路径自己不带画布编号
// （生成、尾帧、素材库……）。少了这一步，局域网就能拿它们去打主机上任意一块
// 没开共享的画布 —— 包括花主机的付费额度、把主机的素材挪进回收站。
function taskCanvasIdOf(taskId) {
  const id = String(taskId || '').trim();
  if (!id) return '';
  // 任务可能已经不在表里（清理过），那就无从判断归属
  const task = store.getTask(id);
  return task ? String(task.canvasId || '') : '';
}

// 定量组的运行记录里带着画布编号。还没跑起来的定时组没有 run 记录，
// 这时返回空串 —— 调用方会按「说不清是哪块」拒绝，这是有意的保守选择。
function scheduleCanvasIdOf(nodeId) {
  const run = store.getScheduleRun(String(nodeId || '').trim());
  return run ? String(run.canvasId || '') : '';
}

// 从请求体 / 查询串里取 canvasId。缺省返回空串（= 没指定画布）。
function askedCanvasIdOf(body, query) {
  const fromBody = body && typeof body === 'object' ? body.canvasId : '';
  const fromQuery = query && typeof query.get === 'function' ? query.get('canvasId') : '';
  return String(fromBody || fromQuery || '').trim();
}

// 这几个路径的 canvasId 只写在请求体里，判权限时必须先把体读出来。
// 注意别把 /api/assets/import 加进来：它的 canvasId 在查询串里，
// 而它可能带着几百 MB 的文件体，为判权限把整个体读进内存不划算。
const BODY_SCOPED_PATHS = ['/api/generate', '/api/preflight', '/api/tailframe'];
function needsBodyForScope(pathname) {
  if (BODY_SCOPED_PATHS.indexOf(pathname) >= 0) return true;
  return /^\/api\/schedules\/[^/]+\/start$/.test(pathname);
}

// 局域网协作者这次请求要碰哪块画布；返回空数组表示「说不清是哪块」。
//
// 说不清时一律拒绝（见 lanCollabDenied）。宁可让协作者偶尔碰壁，
// 也不能因为「没解析出画布」就默认放行 —— 那正是原来那个洞。
// 有些路径看着像「操作某一块画布」，其实第一段是**固定词**、不是画布编号。
// 不排掉它们，正则就会把 `list` / `import` 当成画布 id，
// 于是 store.isShared('list') 为假 → 403 —— 把本来该放行的集合端点堵死。
//
// 这是我自己在第 2 步引入的回归（实测确认）：
//   · /api/share/list       → 协作者列不出共享画布
//   · /api/canvases/import  → 协作者导不了备份
// 后者尤其明显：index.js:1280 专门写了「局域网协作者导进来的画布要直接标成共享」，
// 说明这个功能是**有意开放**的，却被我的加固堵掉了。
// 教训：正则取"第一段"时必须先想清楚「这一段的取值域是什么」。
//
// 这两个词在当前路由里不会和真实画布编号冲突（编号一律以 c_ 开头，
// 见 store.newId('c')），所以按字面量排掉是安全的。
const COLLECTION_SEGMENTS = new Set(['list', 'import']);

function lanTargetCanvasIds(pathname, method, body, query) {
  // 1) /api/canvases/<id>/... 直接把编号写在路径里
  const inPath = /^\/api\/canvases\/([^/]+)(?:\/|$)/.exec(pathname);
  if (inPath) {
    let seg = inPath[1];
    try {
      seg = decodeURIComponent(seg);
    } catch {
      /* 保持原样 */
    }
    // 集合端点（/api/canvases/import）不是"操作某一块"，交给后面的通用规则
    if (!COLLECTION_SEGMENTS.has(seg)) return [seg];
  }
  // 2) /api/share/<id>/...：协作本身的那几条（state / patch / presence / events）。
  //    这些是协作者的主干道，编号同样在路径里。
  //    但 /api/share/list 是集合端点，第一段是字面量 list，不算画布。
  const inShare = /^\/api\/share\/([^/]+)(?:\/|$)/.exec(pathname);
  if (inShare) {
    let seg = inShare[1];
    try {
      seg = decodeURIComponent(seg);
    } catch {
      /* 保持原样 */
    }
    if (!COLLECTION_SEGMENTS.has(seg)) return [seg];
  }
  // 3) /api/schedules/<nodeId>[/action]：画布编号藏在定时组那条运行记录里
  const inSchedule = /^\/api\/schedules\/([^/]+)(?:\/|$)/.exec(pathname);
  if (inSchedule) {
    let nodeId = inSchedule[1];
    try {
      nodeId = decodeURIComponent(nodeId);
    } catch {
      /* 保持原样 */
    }
    const id = scheduleCanvasIdOf(nodeId);
    return id ? [id] : [];
  }
  // 4) /api/tasks/<taskId>[/cancel]
  const inTask = /^\/api\/tasks\/([^/]+)(?:\/|$)/.exec(pathname);
  if (inTask) {
    let taskId = inTask[1];
    try {
      taskId = decodeURIComponent(taskId);
    } catch {
      /* 保持原样 */
    }
    const id = taskCanvasIdOf(taskId);
    return id ? [id] : [];
  }
  // 5) 其余（/api/generate、/api/preflight、/api/tailframe、/api/tasks、
  //    /api/schedules、/api/assets/import）从请求体 / 查询串里取
  const asked = askedCanvasIdOf(body, query);
  return asked ? [asked] : [];
}

// 素材库是「整台电脑共用的一份」，天然不带画布编号，没法按画布授权。
// 所以对局域网单独分成两档：
//   只读的（浏览 / 找孤儿 / 看回收站）—— 放行。协作者要能看素材库，
//     页面上那个素材抽屉就是这么取数据的；
//   会动的（删素材 / 清孤儿 / 从回收站还原）—— 一律拒。
//     这几条动的是主机磁盘上的真实文件，而且不分属于哪块画布，
//     「共享一块画布」不该等于「可以删掉主机整个素材库」。
const LAN_LIBRARY_READONLY = ['/api/library', '/api/library/orphans'];

// 不落在任何已有画布上、但要为协作者放行的端点。见 lanCollabDenied 里的说明。
// 只收「只读」或「新建、不动别人东西」的：
//   · /api/share/list      只读，且只列本来就开着共享的画布
//   · /api/canvases/import 新建一块并立刻标成共享，不碰任何已有画布
// 注意别往里加「能改已有画布」的东西 —— 那就绕过了按画布授权这道门。
const LAN_CANVASLESS_ALLOWED = new Set([
  '/api/share/list',
  '/api/canvases/import',
]);
function lanLibraryReadOnly(pathname, method) {
  if (method !== 'GET') return false;
  if (LAN_LIBRARY_READONLY.indexOf(pathname) >= 0) return true;
  // 回收站列表是只读的；还原（POST）不是。
  return pathname === '/api/library/recycle';
}

// 这次局域网请求放不放行。返回空串表示放行，否则返回给用户看的原因。
//
// 规则：
//   · 素材库的只读接口 —— 放行（它不属于任何一块画布，没法按画布判）；
//   · 其余一律**必须报出一块「正开着共享」的画布**才放行。
//     拿不出画布编号、或那块画布没开共享，都拒。
function lanCollabDenied(pathname, method, body, query) {
  if (lanLibraryReadOnly(pathname, method)) return '';
  // 有几个端点的路径形状像「操作某一块画布」，其实不是，它们**不落在任何已有画布上**：
  //   · /api/share/list      —— 列出正开着共享的画布（只读，且只暴露本来就已共享的）
  //   · /api/canvases/import —— 导入一份备份，**新建**一块画布，不动任何已有画布
  //     （而且 index.js:1280 明确会把局域网导进来的那块直接标成共享）
  // 对它们「按画布授权」无从判断（没有画布可判），所以必须显式放行 ——
  // 否则会掉进"说不清就拒绝"，把这几个合法功能堵死。
  // 第 2 步我就是漏了这一步，实测把协作的「列共享画布」和「导入备份」都堵掉了。
  if (LAN_CANVASLESS_ALLOWED.has(pathname)) return '';
  const ids = lanTargetCanvasIds(pathname, method, body, query);
  if (!ids.length) {
    return '这个操作要先指明是哪块画布，请从共享画布页面里发起';
  }
  if (ids.some((id) => store.isShared(id))) return '';
  return '这块画布没有开启共享，协作者不能操作它';
}

// 只能在本机打开的路径：平台密钥、托盘控制、进程级操作、以及会弹系统窗口的操作。
// 局域网请求现在连这些路径都到不了（上面那道总闸先拦了），这里保留给未来的本机判断用。
function isLocalOnlyPath(pathname) {
  if (pathname === '/channels' || pathname === '/channels.html') return true;
  if (pathname.indexOf('/api/channels') === 0) return true;
  if (pathname.indexOf('/api/local/') === 0) return true;
  if (pathname === '/codesync' || pathname === '/codesync.html') return true;
  if (pathname.indexOf('/api/codesync/plan') === 0) return true;
  if (pathname.indexOf('/api/codesync/pull') === 0) return true;
  // 这个接口会在这台电脑上弹出「选择文件夹」的系统窗口。
  // 从另一台电脑点，窗口会弹在这边却没人看得见，只会让人以为卡住了。
  if (pathname === '/api/export/pick-dir') return true;
  return false;
}

// 注意：这个处理器是 async 的 —— 局域网判权限时要先把请求体读出来
// （见下面 fromLan 那一段），而读体是异步的。
// 全局异常由下面 http.createServer 那处的 .catch 兜住，与 handleApi 同一套处理。
async function requestHandler(req, res) {
  applySecurityHeaders(res);
  const parsed = new URL(req.url, 'http://127.0.0.1');
  let pathname = '/';
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return sendText(res, 400, '地址格式不正确');
  }

  // 这条请求是不是从局域网那台电脑来的。要单独算一次：tokenNeedOf 需要它，
  // 但 guard.check 才刚做 Host 校验。判断规则和 guard 里完全一致，不另立一套。
  const lanEnabled = Boolean(config && config.lan && config.lan.enabled);
  const fromLan =
    lanEnabled && !guard.isLocalHost(req.headers.host) && guard.isLanHost(req.headers.host);
  // 后面 SSE 建会话时要知道「这是主机自己」还是「访客」，供在线名单显示「主机 / 访客 1」
  req.__fromLan = fromLan;

  // 先过守卫：Host 必须指向本机、带了 Origin 就必须同源、接口还要有钥匙。
  // 这一步对静态页面同样生效，DNS rebinding 才能一并挡掉。
  const verdict = guard.check(req, tokenNeedOf(pathname, fromLan), {
    adminToken: adminToken,
    uiToken: uiToken,
    // 局域网开关：打开后额外认「这台电脑自己的网卡地址」，其它地址照旧拒绝
    lanEnabled: lanEnabled,
    // 日志下载是浏览器直接导航（window.location.href），带不了自定义请求头，
    // 所以只有它允许把钥匙放在查询串里。别的接口一律只认请求头——
    // 钥匙进了 URL 就会留在浏览历史、Referer 里，能少一处是一处。
    queryToken: req.method === 'GET' && pathname === '/api/log/download'
      ? parsed.searchParams.get('token')
      : null,
  });
  // 从局域网进来的请求（不是这台电脑自己）只能做一件事：拉取程序代码。
  // 画布数据、素材库、生成任务、平台密钥一律不跨机 —— 每台电脑各用各的一份。
  // 这段要放在钥匙校验之前：否则局域网访问 /api/library 会先报 401，
  // 看起来像「填一把钥匙就能用」，实际上是路径根本不对外开放。
  if (verdict.local === false && !lanCollabAllowed(pathname)) {
    log('拦下局域网请求：' + pathname + '（不在共享协作范围内）');
    const why =
      '这台电脑没开共享画布，局域网只能用来同步「程序代码」。' +
      '要在同一块画布上一起改，请主机在画布页点「共享」把这块画布开出来。';
    if (pathname.indexOf('/api/') === 0) return sendJson(res, 403, { error: why });
    return sendText(res, 403, why);
  }

  if (!verdict.ok) {
    if (pathname.indexOf('/api/') === 0) return sendJson(res, verdict.code, { error: verdict.error });
    return sendText(res, verdict.code, verdict.error);
  }

  // 共享放行的是「协作」这一整类接口，但协作者只能碰「开着共享的那块画布」。
  // 少了这一道，局域网就能删掉主机上任意一块没共享的画布 —— 那等于把整库交出去。
  //
  // 这一道必须**先拿到 canvasId 再判**，而有些路径的编号只写在请求体里
  // （生成、预检、尾帧、定时组启动），所以必要时先把体读出来。
  // readBodyText 会把结果缓存在 req 上，稍后路由里再 readBody 拿到的是同一份，
  // 流不会因为「读两次」而枯竭。
  if (fromLan && pathname.indexOf('/api/') === 0) {
    const method = req.method.toUpperCase();
    let scopeBody = null;
    if (needsBodyForScope(pathname) && method !== 'GET' && method !== 'HEAD') {
      try {
        scopeBody = await readBody(req);
      } catch {
        // 体读不出来（太大 / 格式不对）就按「说不清是哪块画布」处理，交给下面拒掉
        scopeBody = null;
      }
    }
    const denied = lanCollabDenied(pathname, method, scopeBody, parsed.searchParams) || '';
    if (denied) {
      log('拦下局域网越权：' + pathname);
      return sendJson(res, 403, { error: denied });
    }
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, parsed.searchParams).catch((error) => {
      log('接口出错：' + pathname + ' ' + error.message);
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
      else res.end();
    });
    return;
  }

  // 页面一律走令牌注入版：门户页 / 画布页 / 启动器拿页面钥匙，通道设置页拿管理钥匙
  if (pathname === '/' || pathname === '/index.html') {
    return serveHtmlWithTokens(res, path.join(paths.WEB_DIR, 'index.html'), false, fromLan);
  }
  if (pathname === '/canvas' || pathname === '/canvas.html') {
    return serveHtmlWithTokens(res, path.join(paths.WEB_DIR, 'canvas.html'), false, fromLan);
  }
  if (pathname === '/channels' || pathname === '/channels.html') {
    return serveHtmlWithTokens(res, path.join(paths.WEB_DIR, 'channels.html'), true, fromLan);
  }
  // 托盘右键「检查画布更新…」打开的就是这一页：只读版本号，不改任何画布。
  // 用页面钥匙就够了（它只调 /api/canvases 这种普通接口）。
  if (pathname === '/update' || pathname === '/update.html') {
    return serveHtmlWithTokens(res, path.join(paths.WEB_DIR, 'update.html'), false, fromLan);
  }
  // 托盘右键「同步程序代码…」打开的就是这一页：只搬 web / server / tools / runtime，
  // 不碰 data 与 素材（白名单在 server/codesync.js 里）。
  if (pathname === '/codesync' || pathname === '/codesync.html') {
    return serveHtmlWithTokens(res, path.join(paths.WEB_DIR, 'codesync.html'), false, fromLan);
  }
  if (pathname === '/launcher' || pathname === '/launcher.html') {
    return serveHtmlWithTokens(res, path.join(paths.WEB_DIR, 'launcher.html'), false, fromLan);
  }
  if (pathname.indexOf('/media/') === 0) {
    return serveMedia(req, res, pathname.slice('/media/'.length));
  }
  if (pathname.indexOf('/thumb/') === 0) {
    return thumbs.serveThumb(req, res, pathname.slice('/thumb/'.length));
  }
  return serveStatic(res, path.join(paths.WEB_DIR, pathname.replace(/^\/+/, '')));
}

function openBrowser(url) {
  if (QUIET) return;
  try {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    console.log('请手动在浏览器打开：' + url);
  }
}

function banner(port, createdFolders) {
  const tools = paths.toolsInfo();
  const count = store.stats();
  console.log('');
  console.log('==============================================');
  console.log('  本地无限画布  已启动');
  console.log('==============================================');
  console.log('  网页地址    http://127.0.0.1:' + port);
  if (config.lan && config.lan.enabled) {
    const ips = guard.lanAddresses();
    if (ips.length) {
      ips.forEach((ip) => console.log('  局域网地址  http://' + ip + ':' + port + '   （另一台电脑用浏览器打开这个）'));
    } else {
      console.log('  局域网地址  没找到可用网卡，先确认这台电脑连上了同一个局域网');
    }
  }
  console.log('  程序目录    ' + paths.ROOT);
  console.log('  运行环境    ' + process.execPath);
  console.log('  素材目录    ' + config.assetRoot);
  console.log('  画布数量    ' + count.canvases + ' 块');
  console.log('  解码工具    ' + (tools.ffmpeg ? '已就绪（尾帧可精确提取）' : '未安装（尾帧暂用近似提取）'));
  if (createdFolders.length) {
    console.log('  已创建目录  ' + createdFolders.join('、'));
  }
  console.log('----------------------------------------------');
  console.log('  启动自检');
  selfCheck(tools).forEach((item) => {
    console.log('    ' + (item.ok ? '正常' : '注意') + '  ' + item.label + '：' + item.detail);
  });
  console.log('----------------------------------------------');
  console.log('  这个窗口请不要关闭，最小化即可。');
  console.log('  关掉窗口 = 停止服务，下次启动会自动接着跑。');
  console.log('==============================================');
  console.log('');
}

// 同一份程序已经在跑的时候，别再起第二个：
// 两个服务会抢同一批生成任务（重复下载、状态来回覆盖），窗口也会莫名其妙开出两个。
// 判断依据是 data\runtime.json 里记的进程号 + 那个端口上的 /api/status 说自己就是这份程序。
function probeRunning() {
  return new Promise((resolve) => {
    let info = null;
    try {
      if (!fs.existsSync(paths.RUNTIME_FILE)) return resolve(null);
      info = JSON.parse(fs.readFileSync(paths.RUNTIME_FILE, 'utf8'));
    } catch {
      return resolve(null);
    }
    const pid = Number(info && info.pid);
    const port = Number(info && info.port);
    if (!pid || !port) return resolve(null);
    try {
      process.kill(pid, 0);
    } catch {
      return resolve(null);
    }
    const req = http.get({ host: '127.0.0.1', port: port, path: '/api/status', timeout: 900 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        try {
          const body = JSON.parse(raw);
          const same = body && body.root && path.resolve(body.root) === path.resolve(paths.ROOT);
          resolve(same ? { url: body.url || 'http://127.0.0.1:' + port, port: port } : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

// 已经在跑的时候，这个窗口只报个信，然后自己退出，不参与任何生成任务
function alreadyRunningBanner(running) {
  console.log('');
  console.log('==============================================');
  console.log('  本地无限画布  已经在运行了');
  console.log('==============================================');
  console.log('  网页地址    ' + running.url);
  console.log('  程序目录    ' + paths.ROOT);
  console.log('----------------------------------------------');
  console.log('  同一份程序只保留一个服务，这次就不再开第二个了。');
  console.log('  这个窗口可以关掉，不影响已经在跑的那个。');
  console.log('  想重启：先把原来那个黑窗口关掉，再双击「启动画布.bat」。');
  console.log('==============================================');
  console.log('');
}

function listen(port, attempts) {
  // requestHandler 是 async 的：局域网判权限要先读请求体。http.createServer
  // 不认 Promise，抛出来的 rejection 会变成 unhandledRejection 而不会被这里接住，
  // 请求就会挂住不回。所以包一层，把异步异常转成 500。
  const server = http.createServer((req, res) => {
    Promise.resolve(requestHandler(req, res)).catch((error) => {
      log('请求处理出错：' + req.url + ' ' + ((error && error.message) || error));
      if (!res.headersSent) sendJson(res, 500, { error: (error && error.message) || '服务内部错误' });
      else res.end();
    });
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempts > 0) {
      log('端口 ' + port + ' 被占用，换到 ' + (port + 1) + ' 再试');
      listen(port + 1, attempts - 1);
      return;
    }
    console.log('启动失败：' + error.message);
    process.exit(1);
  });
  // 局域网开关打开时监听 0.0.0.0，否则仍然只听回环地址。
  const bindHost = config.lan && config.lan.enabled ? '0.0.0.0' : '127.0.0.1';
  server.listen(port, bindHost, () => {
    activePort = port;
    // 共享在线名单靠心跳续命：不启动的话，20 秒后所有会话都会被当成掉线清掉
    share.startHeartbeat();
    const url = 'http://127.0.0.1:' + port;
    fs.writeFileSync(
      paths.RUNTIME_FILE,
      JSON.stringify({ port, url, pid: process.pid, startedAt }, null, 2),
      'utf8'
    );
    const created = paths.ensureAssetLayout(config.assetRoot);
    banner(port, created);
    log('服务已启动：' + url);
    openBrowser(url + '/launcher');
  });
  const shutdown = () => {
    log('收到退出指令，正在保存并关闭服务');
    try {
      if (fs.existsSync(paths.RUNTIME_FILE)) fs.unlinkSync(paths.RUNTIME_FILE);
    } catch {
      /* 忽略 */
    }
    // 先停止接收新连接，等现有请求处理完再关库：
    // 反过来先 close 的话，正在保存的请求会撞上已经关掉的连接，白白丢一次保存。
    // 两条退出路径都会关库，close() 自身幂等，重复调用无副作用。
    // 先主动断掉所有 SSE：不然 server.close() 会一直等这些长连接
    share.closeAll();
    server.close(() => {
      store.close();
      releaseInstanceLock();
      process.exit(0);
    });
    setTimeout(() => {
      store.close();
      releaseInstanceLock();
      process.exit(0);
    }, 3000);
  };
  shutdownServer = shutdown;
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  installCrashHandlers();
}

// 最后一道兜底：让"意外崩溃"至少留下痕迹。
//
// 为什么需要：这是个**托盘常驻服务**，用户平时看不到它的控制台。
// 一旦某个后台回调抛出未捕获异常（Node 默认行为是直接退出进程），
// 表现就是"画布突然打不开了"，而且**没有任何提示** —— 用户完全无从下手。
//
// 这里做两件最小的事：
//   ① uncaughtException：记一条日志（含堆栈），**然后继续运行**。
//      不主动退出，是因为本服务的核心（express 式的请求处理、SQLite 连接）
//      并不依赖某个特定回调的中间状态；让用户能继续用画布，比"干净地死掉"更有价值。
//      真的坏到不能用了，用户重启即可，而日志里已经有据可查。
//   ② unhandledRejection：只记日志。这个更常见，多半是某个 await 失败没人管，
//      通常不影响其它功能，不该因此杀掉服务。
function installCrashHandlers() {
  process.on('uncaughtException', (error) => {
    const where = (error && error.stack) || (error && error.message) || String(error);
    log('捕获到未处理的异常（服务继续运行）：' + where);
  });
  process.on('unhandledRejection', (reason) => {
    const text = (reason && reason.stack) || (reason && reason.message) || String(reason);
    log('捕获到未处理的 Promise 拒绝（服务继续运行）：' + text);
  });
}

// 进程锁：不管从托盘、双击还是命令行启动，同一时间只允许一份服务活着，
// 彻底杜绝「同时开好几个」抢同一批生成任务的情况。
let lockFileHeld = '';

function acquireInstanceLock() {
  const lockFile = path.join(paths.DATA_DIR, 'server.lock');
  try {
    paths.ensureDir(paths.DATA_DIR);
    if (fs.existsSync(lockFile)) {
      const raw = fs.readFileSync(lockFile, 'utf8');
      const oldPid = Number((raw.match(/\d+/) || [])[0]);
      let alive = false;
      if (oldPid) {
        try {
          process.kill(oldPid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      // 上一次进程已经退了，锁是残留的，直接接管
      if (alive && oldPid !== process.pid) return false;
    }
    fs.writeFileSync(lockFile, String(process.pid), 'utf8');
    lockFileHeld = lockFile;
    return true;
  } catch {
    return true;
  }
}

function releaseInstanceLock() {
  try {
    if (!lockFileHeld) return;
    const raw = fs.readFileSync(lockFileHeld, 'utf8').trim();
    if (raw === String(process.pid)) fs.unlinkSync(lockFileHeld);
  } catch {
    /* 忽略 */
  }
}

async function main() {
  paths.ensureLayout();
  // 已经在跑就直接复用它，连任务都不碰，免得两边抢同一批生成任务
  const running = await probeRunning();
  if (running) {
    log('同一份程序已经在跑（端口 ' + running.port + '），这次不再重复启动');
    alreadyRunningBanner(running);
    openBrowser(running.url + '/launcher');
    process.exit(0);
  }
  if (!acquireInstanceLock()) {
    log('另一个服务正在启动中，这次不再重复启动');
    process.exit(0);
  }
  channels.setLogger(log);
  config = configStore.load();
  // 老版本把平台密钥明文写在 data\config.json 里。这里做一次静默迁移：
  // 先把原文件拷一份到 _archive（万一新流程有问题还能手改回去），再按新格式存一遍。
  // 迁移失败不影响启动 —— 这次就继续用内存里的明文，下次保存再试。
  migratePlaintextKeys();
  thumbs.setAssetRootResolver(() => config.assetRoot);
  // 素材目录：先看有没有记下「相对程序目录」的位置。
  // 老配置没记过也不要紧，只要原来那个目录本来就在程序文件夹里，这里会自动补上。
  if (!config.assetRootRel && config.assetRoot) {
    const rel = path.relative(paths.ROOT, config.assetRoot);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      config.assetRootRel = rel.split(path.sep).join('/');
      try {
        configStore.save(config);
      } catch {
        /* 写不进去不影响本次启动 */
      }
    }
  }
  if (config.assetRootRel) {
    config.assetRoot = path.join(paths.ROOT, ...String(config.assetRootRel).split('/').filter(Boolean));
  } else if (!config.assetRoot) {
    config.assetRoot = paths.defaultAssetRoot();
  } else if (!fs.existsSync(config.assetRoot)) {
    // 素材目录在程序文件夹外面，而本机现在找不到它（换了电脑、移动硬盘没插）。
    // 先退回程序目录里的 素材，顺便在窗口里说清楚，免得一头雾水。
    log('原来的素材目录不在这台电脑上：' + config.assetRoot);
    log('先改用 ' + paths.defaultAssetRoot() + '，要改回去在门户页「显示与设置」里填。');
    config.assetRoot = paths.defaultAssetRoot();
    config.assetRootRel = '素材';
    try {
      configStore.save(config);
    } catch {
      /* 写不进去不影响本次启动 */
    }
  }
  // 手改过 data\config.json 也能用：启动时把通道配置补成完整形状
  config.channels = channels.normalizeChannels(config.channels);
  paths.ensureDir(config.assetRoot);
  paths.ensureAssetLayout(config.assetRoot);
  store.init();
  // 上次没跑完的异步任务（比如在等视频）：先接着等，再处理真的没救的
  const resumed = tasks.resumeAll(config);
  if (resumed) log('有 ' + resumed + ' 个上次没跑完的任务，继续接着等结果');
  const interrupted = store.interruptStaleTasks();
  if (interrupted) log('有 ' + interrupted + ' 个上次没跑完的任务，已标记为中断（可以重新点生成）');
  const liveSchedules = scheduler.init(config);
  if (liveSchedules) log('有 ' + liveSchedules + ' 个定时生成组还在跑 / 暂停中，已接回后台调度');
  startedAt = Date.now();
  // 每次启动换两把临时钥匙，都只有本机程序读得到：
  //   adminToken 给「接口通道设置」窗口与托盘（能读写平台密钥）
  //   uiToken    给门户 / 画布 / 启动器（能正常用画布，但碰不到密钥）
  adminToken = crypto.randomBytes(24).toString('hex');
  uiToken = crypto.randomBytes(24).toString('hex');
  try {
    paths.ensureDir(paths.DATA_DIR);
    fs.writeFileSync(ADMIN_TOKEN_FILE, adminToken, 'utf8');
    fs.writeFileSync(UI_TOKEN_FILE, uiToken, 'utf8');
  } catch (error) {
    log('写入本机访问钥匙失败：' + error.message);
  }
  listen(Number(config.port) || 17890, 20);
}

main().catch((error) => {
  console.log('启动失败：' + (error && error.message ? error.message : String(error)));
  process.exit(1);
});
