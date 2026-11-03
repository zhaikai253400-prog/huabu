'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const paths = require('./paths');
const configStore = require('./config');
const store = require('./store');
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

// --background：托盘在后台拉起服务时用，不弹浏览器、也不留在任务栏
const BACKGROUND = process.argv.includes('--background');
const QUIET = BACKGROUND || process.argv.includes('--no-browser');
const ADMIN_TOKEN_FILE = path.join(paths.DATA_DIR, 'admin-token.txt');
let adminToken = '';
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

function readBody(req, limit) {
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
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('提交的格式不正确'));
      }
    });
    req.on('error', reject);
  });
}

// 收原始字节：本地挑的文件直接传上来，不走 JSON 包一层
function readRaw(req, limit) {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(res, filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(paths.WEB_DIR)) return sendText(res, 403, '不允许访问该路径');
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

// 接口通道设置页只在启动时注入本机钥匙；画布页和普通静态文件拿不到它。
function serveHtmlWithToken(res, filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(paths.WEB_DIR)) return sendText(res, 403, '不允许访问该路径');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return sendText(res, 404, '找不到页面：' + path.basename(resolved));
  }
  const html = fs.readFileSync(resolved, 'utf8').replace(/__LOCAL_TOKEN__/g, adminToken);
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// 导出素材的落地目录：默认在桌面的「画布导出」里，找不到桌面就退回程序目录
function exportDestDir(asked) {
  const custom = String(asked || '').trim();
  if (custom) {
    const abs = path.isAbsolute(custom) ? custom : path.resolve(paths.ROOT, custom);
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
    checks: selfCheck(tools),
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

  // 接口通道的读写、测试、拉模型只允许本机的「接口通道设置」窗口调用：
  // 画布页拿不到钥匙，也就拿不到密钥。
  if (pathname.indexOf('/api/channels') === 0) {
    const given = String(req.headers['x-local-token'] || '');
    if (!adminToken || given !== adminToken) {
      return sendJson(res, 401, { error: '通道设置只在本机的「接口通道设置」窗口里做，请从启动器重新打开那个窗口' });
    }
  }

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

  // 日志：不填 day 就列出所有日期 + 内存里最近几行；填了就读那一天的
  if (pathname === '/api/log' && method === 'GET') {
    const day = String(query.get('day') || '').trim();
    const days = logfile.listDays();
    if (!day) return sendJson(res, 200, { days: days, day: days[0] || '', lines: logRing.slice(-200), live: true });
    return sendJson(res, 200, { days: days, day: day, lines: logfile.readDay(day, Number(query.get('tail')) || 800), live: false });
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
      config.tailPrompts = configStore.normalizeTailPrompts(body.tailPrompts);
      changed.push('尾部提示词');
      log('尾部提示词已更新：' + config.tailPrompts.presets.length + ' 套，默认' + (config.tailPrompts.enabled ? '启用' : '关闭'));
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
      config.channels = channels.normalizeChannels(body.channels);
      configStore.save(config);
      log('接口通道已保存，共 ' + config.channels.length + ' 个');
      return sendJson(res, 200, { channels: config.channels });
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
    let submission = null;
    try {
      submission = generate.composeSubmission(config, body || {});
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
          submittedPrompt: submission.apiPrompt,
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

  if (pathname === '/api/canvases') {
    if (method === 'GET') return sendJson(res, 200, { canvases: store.listCanvases() });
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
    // 刚导进来的画布立刻留一份长期备份：以后就算改乱了，也还有「刚导入时」这一版
    backup.maybeBackup(imported.canvas.id, true);
    log('导入画布：' + imported.canvas.name + '（' + imported.nodeCount + ' 个卡片）');
    return sendJson(res, 200, imported);
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
      log('删除画布（回收站与历史版本目录各留了一份）');
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: '不支持的操作' });
  }

  return sendJson(res, 404, { error: '接口不存在：' + pathname });
}

function requestHandler(req, res) {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, parsed.searchParams).catch((error) => {
      log('接口出错：' + pathname + ' ' + error.message);
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
      else res.end();
    });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    return serveStatic(res, path.join(paths.WEB_DIR, 'index.html'));
  }
  if (pathname === '/canvas' || pathname === '/canvas.html') {
    return serveStatic(res, path.join(paths.WEB_DIR, 'canvas.html'));
  }
  if (pathname === '/channels' || pathname === '/channels.html') {
    return serveHtmlWithToken(res, path.join(paths.WEB_DIR, 'channels.html'));
  }
  if (pathname === '/launcher' || pathname === '/launcher.html') {
    return serveStatic(res, path.join(paths.WEB_DIR, 'launcher.html'));
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
  const server = http.createServer(requestHandler);
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempts > 0) {
      log('端口 ' + port + ' 被占用，换到 ' + (port + 1) + ' 再试');
      listen(port + 1, attempts - 1);
      return;
    }
    console.log('启动失败：' + error.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    activePort = port;
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
    server.close(() => {
      releaseInstanceLock();
      process.exit(0);
    });
    setTimeout(() => {
      releaseInstanceLock();
      process.exit(0);
    }, 3000);
  };
  shutdownServer = shutdown;
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
  }  channels.setLogger(log);
  config = configStore.load();
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
  // 每次启动换一把临时钥匙：只有本机启动器能读到它，画布页拿不到
  adminToken = crypto.randomBytes(24).toString('hex');
  try {
    paths.ensureDir(paths.DATA_DIR);
    fs.writeFileSync(ADMIN_TOKEN_FILE, adminToken, 'utf8');
  } catch (error) {
    log('写入本机设置钥匙失败：' + error.message);
  }
  listen(Number(config.port) || 17890, 20);
}

main().catch((error) => {
  console.log('启动失败：' + (error && error.message ? error.message : String(error)));
  process.exit(1);
});
