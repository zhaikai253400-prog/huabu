'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_FILE, ROOT, ensureDir } = require('./paths');

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

function load() {
  const fallback = defaultConfig();
  try {
    if (!fs.existsSync(CONFIG_FILE)) return fallback;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const merged = merge(fallback, JSON.parse(raw));
    merged.ui = normalizeUi(merged.ui);
    merged.store = normalizeStore(merged.store);
    merged.shortcuts = normalizeShortcuts(merged.shortcuts);
    merged.submitCompress = normalizeSubmitCompress(merged.submitCompress);
    merged.tailPrompts = normalizeTailPrompts(merged.tailPrompts);
    return merged;
  } catch (error) {
    console.log('[配置] 读取失败，先使用默认设置：' + error.message);
    return fallback;
  }
}

function save(config) {
  ensureDir(path.dirname(CONFIG_FILE));
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return config;
}

module.exports = {
  defaultConfig,
  normalizeUi,
  normalizeStore,
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
};
