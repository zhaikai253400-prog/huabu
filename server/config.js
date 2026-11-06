'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_FILE, ROOT, ensureDir } = require('./paths');
const keybox = require('./keybox');

function defaultConfig() {
  return {
    port: 17890,
    assetRoot: path.join(ROOT, '素材'),
    // 素材目录如果是程序目录里面的一层（默认就是 素材），就记下相对位置。
    // 整个文件夹拷到别的电脑 / 换成别的盘符后，靠这个自动认出本机的素材目录。
    assetRootRel: '素材',
    ui: {
      scale: 1,
      theme: 'light',
      fontFamily: 'Microsoft YaHei UI',
      fontSize: 14,
    },
    // 提交压缩：总开关。打开后所有通道每次提交参考图都先压一遍
    submitCompress: {
      enabled: true,
    },
    // 尾部提示词：总开关 + 多套预设，视频 / 快速视频提交时自动追加
    tailPrompts: {
      enabled: true,
      defaultId: '',
      presets: [],
    },
    // 素材归档方式：none = 直接放类型文件夹；date = 再按日期分子文件夹；canvas = 再按画布名字分子文件夹
    store: {
      sub: 'none',
    },
    // 局域网访问：关着的时候只认 127.0.0.1，和以前一样；
    // 打开后服务会监听 0.0.0.0，同一局域网的其它电脑用浏览器就能看到同一份画布和素材。
    // 不开口令：本机自用、可信内网。真要在不安全网络里用，请先关掉这个开关。
    lan: {
      enabled: false,
    },
    shortcuts: {
      select: 'v',
      hand: 'h',
      fit: 'shift+1',
      reset: 'ctrl+0',
      undo: 'ctrl+z',
      redo: 'ctrl+shift+z',
      duplicate: 'ctrl+d',
      remove: 'delete',
    },
    image: {
      model: 'gpt-image-2.5-flare',
      size: '2048x1152',
      aspectRatio: '16:9',
      count: 1,
      quality: 'auto',
    },
    video: {
      model: '',
      duration: 30,
      resolution: '720p',
      aspectRatio: '16:9',
      mode: 'reference',
      maxWaitHours: 6,
      autoDownload: true,
    },
    channels: [],
  };
}

function merge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) {
    return Array.isArray(override) ? override.slice() : base;
  }
  if (typeof base === 'object' && typeof override === 'object') {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = merge(base[key], override[key]);
    }
    return out;
  }
  return override;
}

const UI_THEMES = ['light', 'dark'];

const SHORTCUT_ACTIONS = ['select', 'hand', 'fit', 'reset', 'undo', 'redo', 'duplicate', 'remove'];

const DEFAULT_SHORTCUTS = {
  select: 'v',
  hand: 'h',
  fit: 'shift+1',
  reset: 'ctrl+0',
  undo: 'ctrl+z',
  redo: 'ctrl+shift+z',
  duplicate: 'ctrl+d',
  remove: 'delete',
};

// 快捷键：只认这几个动作，值统一小写成 ctrl+shift+1 这种写法
function normalizeShortcuts(shortcuts) {
  const raw = shortcuts && typeof shortcuts === 'object' ? shortcuts : {};
  const out = {};
  SHORTCUT_ACTIONS.forEach((action) => {
    const value = String(raw[action] === undefined || raw[action] === null ? DEFAULT_SHORTCUTS[action] : raw[action])
      .trim()
      .toLowerCase()
      .slice(0, 40);
    out[action] = value || DEFAULT_SHORTCUTS[action];
  });
  return out;
}

// 界面设置：缩放 90%~150%，字号 12~20，主题只认浅色/深色
function normalizeUi(ui) {
  const raw = ui && typeof ui === 'object' ? ui : {};
  let scale = Number(raw.scale);
  if (!Number.isFinite(scale)) scale = 1;
  scale = Math.min(1.5, Math.max(0.9, Math.round(scale * 100) / 100));
  let fontSize = Number(raw.fontSize);
  if (!Number.isFinite(fontSize)) fontSize = 14;
  fontSize = Math.min(20, Math.max(12, Math.round(fontSize)));
  const theme = UI_THEMES.indexOf(String(raw.theme)) >= 0 ? String(raw.theme) : 'light';
  const fontFamily = String(raw.fontFamily || '').trim().slice(0, 80) || 'Microsoft YaHei UI';
  return { scale: scale, theme: theme, fontFamily: fontFamily, fontSize: fontSize };
}

// 局域网开关：只认明确的 true，其它一律当关闭（配置写坏了也不会把服务暴露出去）
function normalizeLan(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return { enabled: raw.enabled === true || raw.enabled === 'true' };
}

function normalizeStore(store) {
  const raw = store && typeof store === 'object' ? store : {};
  const sub = ['none', 'date', 'canvas'].indexOf(String(raw.sub)) >= 0 ? String(raw.sub) : 'none';
  return { sub: sub };
}

const TAIL_MAX_PRESETS = 30;
const TAIL_MAX_NAME = 40;
const TAIL_MAX_TEXT = 20000;

// 尾部提示词预设：最多 30 套，名称和正文都做长度保护；旧配置缺省时不影响使用
function normalizeTailPrompts(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const enabled = raw.enabled !== false;
  const source = Array.isArray(raw.presets) ? raw.presets : [];
  const seen = new Set();
  const presets = [];
  source.forEach((item) => {
    if (!item || presets.length >= TAIL_MAX_PRESETS) return;
    let id = String(item.id || '').trim().slice(0, 80);
    if (!id || seen.has(id)) id = 'tp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    if (seen.has(id)) return;
    seen.add(id);
    const name = String(item.name || '').trim().slice(0, TAIL_MAX_NAME);
    const text = String(item.text || '').slice(0, TAIL_MAX_TEXT);
    if (!name && !text) return;
    const now = Date.now();
    presets.push({
      id: id,
      name: name || ('尾部提示词 ' + (presets.length + 1)),
      text: text,
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || now,
    });
  });
  let defaultId = String(raw.defaultId || '').trim();
  if (defaultId && !presets.some((item) => item.id === defaultId)) defaultId = '';
  if (!defaultId && presets.length) defaultId = presets[0].id;
  return { enabled: enabled, defaultId: defaultId, presets: presets };
}

// 提交压缩总开关：缺省打开；只有明确关掉才关闭
function normalizeSubmitCompress(value) {
  const raw = value && typeof value === 'object' ? value.enabled : value;
  const off = raw === false || raw === 0 || raw === '0' || String(raw).toLowerCase() === 'false';
  return { enabled: !off };
}

// 读配置：磁盘上是密文的密钥字段，在这里换回明文再交给上层。
// 解密失败的字段保持密文原样（不抹成空串）——保存时会原样写回，用户换回原环境还能用。
function load() {
  const fallback = defaultConfig();
  try {
    if (!fs.existsSync(CONFIG_FILE)) return fallback;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const decrypted = keybox.decryptConfig(parsed);
    const merged = merge(fallback, decrypted);
    merged.ui = normalizeUi(merged.ui);
    merged.store = normalizeStore(merged.store);
    merged.lan = normalizeLan(merged.lan);
    merged.shortcuts = normalizeShortcuts(merged.shortcuts);
    merged.submitCompress = normalizeSubmitCompress(merged.submitCompress);
    merged.tailPrompts = normalizeTailPrompts(merged.tailPrompts);
    return merged;
  } catch (error) {
    console.log('[配置] 读取失败，先使用默认设置：' + error.message);
    return fallback;
  }
}

// 写配置：先把密钥字段加密成密文，再原子替换文件。
// 明文永远不落盘 —— 加密失败时直接抛错，让调用方把原因告诉用户，
// 而不是「悄悄地还是写了明文」，那种失败最难发现。
function save(config) {
  ensureDir(path.dirname(CONFIG_FILE));
  const sealed = keybox.encryptChannels(config && config.channels);
  if (sealed.failed) {
    // 两种失败看起来都是 failed>0，但该让用户做的事完全不同：
    //   · locked>0 —— 盘上还有解不开的旧密文、secret.key 丢了；恢复文件就对，别去动密钥；
    //   · 其余      —— 新密钥没加密成功；多半是 DPAPI 辅助程序不在或权限不对。
    const why = sealed.locked
      ? '有 ' + sealed.locked + ' 处密钥还是上次的密文，但 data\\secret.key 不见了。' +
        '为了不把已保存的密钥永久作废，这次没有保存。请先找回 secret.key（或从备份恢复 data 目录）。'
      : '请检查 server\\keybox-helper.exe 是否还在，或查看日志里的 [密钥保护] 提示。';
    throw new Error('平台密钥没能加密（' + sealed.failed + ' 处），这次没有保存。' + why);
  }
  const onDisk = Object.assign({}, config, { channels: sealed.list });
  if (sealed.sealed > 0) onDisk.secretBox = { version: 1, algo: 'aes-256-gcm', keyWrap: 'dpapi-user' };
  const body = JSON.stringify(onDisk, null, 2);

  // 写后自检：把这份 JSON 读回来解一遍，逐条比对本该存进去的密钥。
  // 为什么非做不可 —— 主密钥换了 / 加密逻辑改错了，唯一的表现就是「配置存了、
  // 下次启动密钥全空」；那时代码已经跑完、日志也看不出异常，用户只会发现生成失败。
  // 在替换正式文件之前拦下来，旧文件还在，密钥不会丢。
  assertRoundTrip(body, config);

  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return config;
}

// 拿即将写盘的内容走一遍「解析 -> 解密」，和内存里的密钥逐条对齐。
function assertRoundTrip(body, config) {
  const expected = keybox.collectSecrets(config);
  if (!expected.length) return;
  let back;
  try {
    back = keybox.decryptConfig(JSON.parse(body));
  } catch (error) {
    throw new Error('配置写盘前自检失败（解析不了刚生成的 JSON）：' + error.message);
  }
  const got = new Map(keybox.collectSecrets(back));
  const broken = expected.filter(([where, value]) => got.get(where) !== value);
  if (broken.length) {
    throw new Error(
      '配置写盘前自检失败：' + broken.length + ' 处密钥回读不出来（' + broken[0][0] + ' 等）。' +
      '常见原因是主密钥文件 data\\secret.key 与当前用户不匹配，这次没有保存。'
    );
  }
}
// 老版本留下的明文密钥：下次保存就会自动变成密文，这里只负责告诉用户还剩几处。
function plaintextCount(config) {
  return keybox.countPlaintext(config);
}
module.exports = {
  defaultConfig,
  normalizeUi,
  normalizeStore,
  normalizeLan,
  normalizeShortcuts,
  normalizeSubmitCompress,
  normalizeTailPrompts,
  TAIL_MAX_PRESETS,
  TAIL_MAX_NAME,
  TAIL_MAX_TEXT,
  SHORTCUT_ACTIONS,
  DEFAULT_SHORTCUTS,
  load,
  save,
  plaintextCount,
};
