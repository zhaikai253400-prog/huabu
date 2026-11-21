'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_FILE, ROOT, ensureDir } = require('./paths');
const keybox = require('./keybox');
// 新建卡片默认值的归一化规则，与浏览器共用同一份（见 web/assets/card-defaults.js）
const cardDefaults = require('../web/assets/card-defaults.js');

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
    // 尾部提示词：按类型分成两套预设 + **各自的开关**（视频一套、图片一套，互不相通）。
    // 视频 / 快速视频提交时从 video 池取，图片卡从 image 池取。
    // 两个开关互不影响：关掉图片组，视频卡照常追加，反过来也一样。
    //
    // 默认值：视频开（常用）、图片关（不常用，需要时在浮层里单独打开）。
    // 注意这只作用于**全新安装**；已有配置按 normalizeTailPrompts 迁移，不会被动到。
    tailPrompts: {
      enabled: true,
      groups: {
        video: { enabled: true, defaultId: '', presets: [] },
        image: { enabled: false, defaultId: '', presets: [] },
      },
      defaultId: '',
      presets: [],
    },
    // 新建卡片默认值：图片 / 视频 / 快速视频各自用哪个模型、哪些参数。
    // 空模型 = 跟随渠道默认（与从前「记住上次用过」的行为一致）。
    // 这份配置跟着 data/ 走，换电脑后设置还在；不放在浏览器 localStorage 里。
    cardDefaults: {
      image: { model: '', channelId: '', params: {} },
      video: { model: '', channelId: '', params: {} },
      quick: { model: '', channelId: '', params: {} },
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

// 尾部提示词分两个池子，互不相通：
//   video —— 视频卡 / 快速视频卡用
//   image —— 图片卡用
// 为什么要分：两种卡片要的文字根本不同。视频那套会写「无 BGM、嘴型不动、
// 运镜、时长」之类，塞进图片请求纯属噪声；反过来图片那套的构图 / 画风措辞
// 对视频也未必合适。所以从数据结构上就分开，卡片只在自己的池子里选。
const TAIL_GROUPS = ['video', 'image'];

// 尾部预设的**结构版本**。前端保存前会跟它比对：
// 不一致说明"页面是新的、服务进程是旧的"（或反之），这时**不要写盘**，
// 而应提示用户重启服务。
//
// 为什么需要这个：2026-11-08 出过一次真实事故 ——
//   · 服务进程 17:53 启动（跑改动前的代码）
//   · 浏览器刷新拿到的是新前端（静态文件现读磁盘）
//   · 新前端发 {enabled, groups:{video,image}}，老服务端只认扁平的 raw.presets
//   · 老代码把 presets 读成空 → **用户那套 335 字的预设被清空**
// 两个版本都能"正常跑"，却在交界处悄悄毁数据。有了版本号就能在写盘前拦住。
//
// 3 版（2026-11-21）：视频组和图片组**各有一个开关**，不再共用一个总开关。
//   用户诉求：视频尾部提示词常用、图片不常用，两者不该绑在一起。
//   老结构（2 版：一个 enabled 管两组）读进来时按下面的规则迁移：
//     · 有 groups 且某组缺 enabled → 该组沿用顶层 enabled（行为与 2 版完全一致）
//     · 扁平老结构（根本没有 groups）→ 两组都取顶层 enabled
//   所以升级后「原本开着的还是开着」，不会因为分开关而忽然失效。
const TAIL_SCHEMA_VERSION = 3;

// 判断一份 tailPrompts 提交"是什么形状"。用于区分：
//   groups —— 新结构（带 groups 字段）
//   flat   —— 老结构（只有顶层 presets），或老代码写出来的空对象
//   none   —— 压根没这个字段 / 不是对象
function tailPromptsShapeOf(value) {
  if (!value || typeof value !== 'object') return 'none';
  if (value.groups && typeof value.groups === 'object') return 'groups';
  return 'flat';
}

function tailPoolOf(group, rawGroup) {
  const raw = rawGroup && typeof rawGroup === 'object' ? rawGroup : {};
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
  return { defaultId: defaultId, presets: presets };
}

// 尾部提示词预设：每类最多 30 套，名称和正文都做长度保护；旧配置缺省时不影响使用。
//
// **读时迁移**（重要）：老配置是扁平的 `{enabled, defaultId, presets}`，
// 那时只有视频 / 快速视频支持尾部提示词，所以那些预设**全部归入 video 池**。
// 这样用户既有的「3D国漫风格」不会被塞到图片卡上。
//
// 判定"有没有分过组"不能只看 `raw.groups` 在不在 —— 这里踩过一个很隐蔽的坑：
// `load()` 是先 `merge(defaultConfig(), 磁盘配置)` 再归一的。新默认值里已经有
// 空的 `groups`，而磁盘上还是老结构（只有 presets）—— merge 出来的对象
// **同时**带着"空的 groups"和"有内容的 presets"。若只看 groups 存在与否，
// 就会走"已分组"分支、**把用户真实的预设整个丢掉**（实测：你那套 335 字的
// 「3D国漫风格」直接消失）。所以判据是"**有没有任何一组真的有预设**"。
function tailPromptsHasRealGroups(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const g = raw.groups;
  if (!g || typeof g !== 'object') return false;
  return TAIL_GROUPS.some((name) => {
    const one = g[name];
    return Boolean(one && typeof one === 'object' && Array.isArray(one.presets) && one.presets.length);
  });
}

function normalizeTailPrompts(value) {
  const raw = value && typeof value === 'object' ? value : {};
  // 顶层 enabled 是 2 版留下的「一个开关管两组」。现在只当迁移用的默认值，
  // 以及给还没更新的老调用方当兼容视图（= video 组的开关）。
  const legacyEnabled = raw.enabled !== false;
  const groups = {};
  const groupsRaw = raw.groups && typeof raw.groups === 'object' ? raw.groups : null;
  const flatHasPresets = Array.isArray(raw.presets) && raw.presets.length > 0;

  // 每一组自己的开关：3 版起才有这个字段，缺省时回落到顶层，迁移才是无损的
  const enabledOf = (rawGroup, fallback) => {
    const one = rawGroup && typeof rawGroup === 'object' ? rawGroup : null;
    if (one && typeof one.enabled === 'boolean') return one.enabled;
    return fallback;
  };

  // 走哪条路取预设，看「有没有真的分过组」：
  //   · 某组真有预设            -> 分组读（正常情况）
  //   · 只有 groups 壳、没有预设 -> 也走分组读（新装的默认值就是这种形状，
  //     两组各自的默认开关必须被保留，否则「图片默认关」会被当成「跟顶层走」）
  //   · groups 壳 + 顶层还带着真预设 -> 老结构，预设全归 video（历史上出现过
  //     这种混合对象，判据沿用老注释里那次事故的结论）
  const useGroups = tailPromptsHasRealGroups(raw) || (Boolean(groupsRaw) && !flatHasPresets);

  if (useGroups) {
    // 确实已经分过组：按新结构读
    TAIL_GROUPS.forEach((g) => {
      groups[g] = tailPoolOf(g, groupsRaw && groupsRaw[g]);
      groups[g].enabled = enabledOf(groupsRaw && groupsRaw[g], legacyEnabled);
    });
  } else {
    // 老结构（扁平）→ 全部迁进 video 池；image 池初始为空。
    // 两组都沿用那个唯一的开关：升级前后行为一模一样，不会突然少追加或多追加。
    groups.video = tailPoolOf('video', { defaultId: raw.defaultId, presets: raw.presets });
    groups.video.enabled = enabledOf(groupsRaw && groupsRaw.video, legacyEnabled);
    groups.image = tailPoolOf('image', groupsRaw && groupsRaw.image);
    groups.image.enabled = enabledOf(groupsRaw && groupsRaw.image, legacyEnabled);
  }

  // 顶层保留一份 video 池的兼容视图：老版本的读写路径（以及暂时还没改的
  // 调用方）仍然按 raw.presets / raw.defaultId / raw.enabled 取用。
  return {
    enabled: groups.video.enabled,
    groups: groups,
    defaultId: groups.video.defaultId,
    presets: groups.video.presets,
  };
}

// 从「完整 config」或「tailPrompts 本身」里取出尾部提示词配置。
// 和 tailPoolOfConfig 同样的容错理由：两种形状容易传混，
// 传混的后果是**总开关被忽略**（回落到默认 enabled:true），
// 表现为"我明明关了尾部提示词，它还在追加" —— 所以统一在这里认形状。
function tailConfigOf(config) {
  const raw = config && typeof config === 'object' ? config : {};
  if (raw.tailPrompts && typeof raw.tailPrompts === 'object') return raw.tailPrompts;
  const looksLikeTailPrompts = raw.groups && typeof raw.groups === 'object'
    ? true
    : (Array.isArray(raw.presets) || typeof raw.enabled === 'boolean' || typeof raw.defaultId === 'string');
  return looksLikeTailPrompts ? raw : null;
}

// 取某一组自己的开关。
// 缺 enabled 字段时回落到顶层 enabled —— 拿到的配置没经过 normalizeTailPrompts
// （测试里手写的、或者 2 版留下没迁移的）时，行为必须和分开关之前一致。
function tailGroupEnabledOf(config, group) {
  const key = TAIL_GROUPS.indexOf(String(group)) >= 0 ? String(group) : 'video';
  const tp = tailConfigOf(config);
  if (!tp) return true;
  const one = tp.groups && tp.groups[key] ? tp.groups[key] : null;
  if (one && typeof one.enabled === 'boolean') return one.enabled;
  return tp.enabled !== false;
}

// 取某一类的池子。给错 group 时退回 video —— 宁可给视频池，
// 也不要让调用方拿到 undefined 然后在别处炸掉。
//
// 入参容错：**既接受完整 config，也接受 tailPrompts 本身**。
// 为什么值得容错：这两种形状很容易传混（我自己写测试时就传混过一次），
// 而传混的后果是"安静地返回空池" —— 表现为"尾部提示词莫名其妙不追加了"，
// 非常难查。多认一种形状就能把这个坑直接消掉。
//   完整 config：{ tailPrompts: { groups: {...} } }
//   tailPrompts：{ groups: {...} } 或老形状 { presets: [...] }
function tailPoolOfConfig(config, group) {
  const key = TAIL_GROUPS.indexOf(String(group)) >= 0 ? String(group) : 'video';
  const tp = tailConfigOf(config);
  if (tp && tp.groups && tp.groups[key]) return tp.groups[key];
  // 兼容没经过 normalizeTailPrompts 的对象（例如测试里手写的 config）
  if (key === 'video' && tp) {
    return { defaultId: String(tp.defaultId || ''), presets: Array.isArray(tp.presets) ? tp.presets : [] };
  }
  return { defaultId: '', presets: [] };
}

// 提交压缩总开关：缺省打开；只有明确关掉才关闭
function normalizeSubmitCompress(value) {
  const raw = value && typeof value === 'object' ? value.enabled : value;
  const off = raw === false || raw === 0 || raw === '0' || String(raw).toLowerCase() === 'false';
  return { enabled: !off };
}

// 新建卡片默认值：只认 image / video / quick 三类，参数键也各自受限。
// 真正的规则在共享模块里（server 与浏览器同一份），这里只做入口包装，
// 免得服务端又多出一份「哪些键算数」的判据慢慢和前端走偏。
function normalizeCardDefaults(value) {
  return cardDefaults.normalize(value);
}

// 取某一类的默认值（quick 没单独设就跟随 video）
function cardDefaultsOf(configOrDefaults, type) {
  const src = configOrDefaults && typeof configOrDefaults === 'object' ? configOrDefaults : {};
  const base = src.cardDefaults && typeof src.cardDefaults === 'object' ? src.cardDefaults : src;
  return cardDefaults.presetOf(base, type);
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
    // 尾部提示词**不能**用 merge 之后的对象归一：
    // 新默认值里 groups.image.enabled=false（图片组默认关），merge 会把它补进
    // 老配置那两组里，于是 2 版「一个开关管两组」的老用户升级后，图片组会被
    // 悄悄关掉 —— 那是行为变化，不是迁移。所以这里只看盘上写了什么：
    //   · 盘上有 tailPrompts -> 拿它原样归一，缺的字段按 2 版规则回落；
    //   · 盘上压根没有      -> 才用新装的默认值（视频开 / 图片关）。
    merged.tailPrompts = normalizeTailPrompts(
      decrypted && typeof decrypted === 'object' && decrypted.tailPrompts !== undefined
        ? decrypted.tailPrompts
        : fallback.tailPrompts
    );
    merged.cardDefaults = cardDefaults.normalize(merged.cardDefaults);
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
      '常见原因是主密钥文件 data\\secret.key 丢了，或与 data\\config.json 不是一对；这次没有保存。'
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
  normalizeCardDefaults,
  cardDefaultsOf,
  CARD_DEFAULT_TYPES: cardDefaults.CARD_TYPES,
  tailPoolOfConfig,
  tailGroupEnabledOf,
  tailConfigOf,
  tailPromptsShapeOf,
  TAIL_SCHEMA_VERSION,
  TAIL_GROUPS,
  TAIL_MAX_PRESETS,
  TAIL_MAX_NAME,
  TAIL_MAX_TEXT,
  SHORTCUT_ACTIONS,
  DEFAULT_SHORTCUTS,
  load,
  save,
  plaintextCount,
};
