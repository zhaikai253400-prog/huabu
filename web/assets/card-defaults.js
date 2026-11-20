(function (root, factory) {
  // 前后端共享的纯规则模块：不碰 DOM、不读写文件、不依赖任何运行时。
  //   浏览器：window.CanvasCardDefaults
  //   Node  ：require('../web/assets/card-defaults.js')
  //
  // 为什么要有它（2026-11-20）：用户在设置里指定「新建图片卡默认用 A 模型 2K」，
  // 这个规则要在三处同时成立才不打架：
  //   ① 卡片诞生时（canvas.js 的 addNode → seedParams）
  //   ② 服务端保存 / 读取配置时的归一化（config.js）
  //   ③ 设置面板里「模型一换，参数选项跟着收敛」的预览
  // 三处各写一份判据，早晚会出现「面板显示 2K、新卡片却是 1K」这种对不上的事，
  // 所以把规则收在这里一份。
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.CanvasCardDefaults = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 能设默认值的卡片类型。快速视频没有「模式」，其余与视频一致。
  const CARD_TYPES = ['image', 'video', 'quick'];

  // 每种卡片认识的参数键。不在这个清单里的键一律丢掉 ——
  // 否则一个手改过的 config.json 能把 video 的「时长」悄悄塞进图片卡。
  const PARAM_KEYS = {
    image: ['size', 'ratio', 'count'],
    video: ['duration', 'resolution', 'ratio', 'mode'],
    quick: ['duration', 'resolution', 'ratio'],
  };

  // 内置兜底值：用户没设、模型也没声明时的最后一层。
  // 必须与 canvas.js 里原来的 PARAM_DEFAULTS 一致，否则新卡片第一眼就会变样。
  const BUILTIN = {
    image: { size: '2K', ratio: '16:9', count: '1' },
    video: { duration: '30', resolution: '720p', ratio: '16:9', mode: 'reference' },
    quick: { duration: '30', resolution: '720p', ratio: '16:9' },
  };

  // 设置面板上的可选档位（模型没声明规格时用它）。
  // 必须与 canvas.js 里卡片上那排芯片的 options 一致，否则会出现
  // 「设置里能选 4K、卡片上却没有 4K」这种对不上的事 —— tools/tests/card-defaults.test.js 会比对两者。
  const UI_OPTIONS = {
    image: [
      { key: 'size', label: '尺寸', options: ['1K', '2K', '4K'] },
      { key: 'ratio', label: '比例', options: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
      { key: 'count', label: '张数', options: ['1', '2', '3', '4'], texts: ['1 张', '2 张', '3 张', '4 张'] },
    ],
    video: [
      { key: 'duration', label: '时长', options: ['5', '10', '15', '30'], texts: ['5 秒', '10 秒', '15 秒', '30 秒'] },
      { key: 'resolution', label: '分辨率', options: ['720p', '1080p'], texts: ['720P', '1080P'] },
      { key: 'ratio', label: '比例', options: ['16:9', '9:16', '1:1'] },
      { key: 'mode', label: '模式', options: ['reference', 'frames', 'text'], texts: ['全能参考', '首尾帧', '纯文生'] },
    ],
    quick: [
      { key: 'duration', label: '时长', options: ['5', '10', '15', '30'], texts: ['5 秒', '10 秒', '15 秒', '30 秒'] },
      { key: 'resolution', label: '分辨率', options: ['720p', '1080p'], texts: ['720P', '1080P'] },
      { key: 'ratio', label: '比例', options: ['16:9', '9:16', '1:1'] },
    ],
  };

  function UI_OPTIONS_OF(type) {
    return (UI_OPTIONS[String(type || '')] || []).map((one) => Object.assign({}, one));
  }

  function isCardType(type) {
    return CARD_TYPES.indexOf(String(type || '')) >= 0;
  }

  // 快速视频在接口眼里就是视频（同 payload-rules.kindOf 的约定）
  function kindOf(type) {
    return String(type || 'image') === 'quick' ? 'video' : String(type || 'image');
  }

  function paramKeysOf(type) {
    return (PARAM_KEYS[String(type || '')] || []).slice();
  }

  function builtinOf(type) {
    return Object.assign({}, BUILTIN[String(type || '')] || {});
  }

  function toText(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
  }

  // 一个类型的一组默认值：{ model, channelId, params }
  // 同时接受新写法（params 里放参数）和老 / 手改写法（参数平铺在同层），
  // 方便用户直接编辑 config.json 时不用记结构。
  function normalizeOne(type, raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const keys = PARAM_KEYS[String(type || '')] || [];
    const nested = src.params && typeof src.params === 'object' ? src.params : null;
    const params = {};
    keys.forEach((key) => {
      const fromNested = nested && nested[key] !== undefined && nested[key] !== null ? nested[key] : undefined;
      const fromFlat = src[key] !== undefined && src[key] !== null ? src[key] : undefined;
      const value = fromNested !== undefined ? fromNested : fromFlat;
      if (value === undefined) return;
      const text = toText(value);
      if (text === '') return;
      params[key] = text;
    });
    return {
      model: toText(src.model),
      channelId: toText(src.channelId),
      params: params,
    };
  }

  function hasAny(value) {
    if (!value || typeof value !== 'object') return false;
    if (toText(value.model)) return true;
    if (toText(value.channelId)) return true;
    const params = value.params;
    return Boolean(params && typeof params === 'object' && Object.keys(params).length);
  }

  // 快速视频默认跟视频共用一套（少配一遍）。用户真要单独设，写 quick 就会覆盖。
  function deriveQuick(video) {
    if (!video) return { model: '', channelId: '', params: {} };
    const params = {};
    (PARAM_KEYS.quick || []).forEach((key) => {
      if (video.params && video.params[key] !== undefined) params[key] = video.params[key];
    });
    return { model: video.model, channelId: video.channelId, params: params };
  }

  // 归一化整份默认值：{ image, video, quick }
  function normalize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const image = normalizeOne('image', src.image);
    const video = normalizeOne('video', src.video);
    const quickRaw = src.quick && typeof src.quick === 'object' ? src.quick : null;
    // quick 只在「自己写了东西」时才独立；否则跟随视频
    const quick = quickRaw && hasAny(normalizeOne('quick', quickRaw))
      ? normalizeOne('quick', quickRaw)
      : deriveQuick(video);
    return { image: image, video: video, quick: quick };
  }

  function presetOf(defaults, type) {
    const all = defaults && typeof defaults === 'object' ? defaults : {};
    const key = String(type || '');
    if (key === 'quick') {
      const quick = all.quick && typeof all.quick === 'object' ? all.quick : null;
      if (quick && hasAny(normalizeOne('quick', quick))) return normalizeOne('quick', quick);
      return normalizeOne('quick', all.video);
    }
    return normalizeOne(key, all[key]);
  }

  // 某个模型对某个参数能接受哪些值；模型没声明就返回 null（表示「不限制」）
  function optionsFor(type, key, spec) {
    if (!spec || typeof spec !== 'object') return null;
    const name = String(key || '');
    if (name === 'size') return Array.isArray(spec.sizes) && spec.sizes.length ? spec.sizes.map(String) : null;
    if (name === 'resolution') return Array.isArray(spec.resolutions) && spec.resolutions.length ? spec.resolutions.map(String) : null;
    if (name === 'duration') return Array.isArray(spec.durations) && spec.durations.length ? spec.durations.map(String) : null;
    if (name === 'ratio') return Array.isArray(spec.ratios) && spec.ratios.length ? spec.ratios.map(String) : null;
    if (name === 'mode') return Array.isArray(spec.modes) && spec.modes.length ? spec.modes.map(String) : null;
    return null;
  }

  function clampCount(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < 1) return '1';
    return String(Math.min(4, n));
  }

  // 新卡片出生时的参数。
  // 优先级（从低到高）：内置兜底 → 模型自己声明的默认 → 用户设的默认 → 模型档位收敛
  //
  // 为什么用户设置要压在模型默认之上：用户明确说了「A 模型用 2K」，
  // 而 A 模型恰好声明了 1K 默认 —— 那就该听用户的，只有在模型根本不支持 2K 时才收敛。
  //
  // 返回 { params, adjusted }：adjusted 记录被改掉的项，设置面板据此提示
  // 「你选的 2K，这个模型只开 1K，新卡片会按 1K 建」。
  function seedParams(type, preset, spec) {
    const key = String(type || '');
    const out = builtinOf(key);
    if (spec && typeof spec === 'object') {
      if (out.duration !== undefined && spec.defaultDuration !== undefined) {
        out.duration = toText(spec.defaultDuration);
      }
      if (out.resolution !== undefined && spec.defaultResolution !== undefined) {
        out.resolution = toText(spec.defaultResolution).toLowerCase();
      }
    }
    const want = preset && preset.params && typeof preset.params === 'object' ? preset.params : {};
    Object.keys(want).forEach((name) => {
      if (!(name in out)) return;
      const text = toText(want[name]);
      if (text !== '') out[name] = text;
    });
    if (out.count !== undefined) out.count = clampCount(out.count);

    const adjusted = [];
    Object.keys(out).forEach((name) => {
      const options = optionsFor(key, name, spec);
      if (!options || !options.length) return;
      if (options.indexOf(out[name]) >= 0) return;
      const before = out[name];
      // 收敛顺序：模型默认（更贴近这个模型的价钱 / 限制）→ 内置默认 → 第一个
      const prefer = [];
      if (name === 'duration' && spec.defaultDuration !== undefined) prefer.push(toText(spec.defaultDuration));
      if (name === 'resolution' && spec.defaultResolution !== undefined) prefer.push(toText(spec.defaultResolution).toLowerCase());
      if (name === 'size' && spec.defaultResolution !== undefined) prefer.push(toText(spec.defaultResolution));
      if (BUILTIN[key] && BUILTIN[key][name] !== undefined) prefer.push(toText(BUILTIN[key][name]));
      let picked = '';
      for (let i = 0; i < prefer.length; i += 1) {
        if (options.indexOf(prefer[i]) >= 0) {
          picked = prefer[i];
          break;
        }
      }
      out[name] = picked || options[0];
      if (adjusted.length < 8) adjusted.push({ key: name, want: before, got: out[name] });
    });
    return { params: out, adjusted: adjusted };
  }

  // 设置面板用：这个模型支持某组参数吗？给出一句人话解释。
  // 与 seedParams 的口径一致 —— 面板说「会被改成 1K」，新卡片就真的是 1K。
  function explainPreset(type, preset, spec) {
    const seeded = seedParams(type, preset, spec);
    if (!seeded.adjusted.length) return { changed: false, text: '', adjusted: [] };
    const labels = { size: '尺寸', ratio: '比例', count: '张数', duration: '时长', resolution: '分辨率', mode: '模式' };
    const text = seeded.adjusted
      .map((one) => (labels[one.key] || one.key) + ' ' + one.want + ' → ' + one.got)
      .join('，');
    return { changed: true, text: text, adjusted: seeded.adjusted };
  }

  return {
    CARD_TYPES: CARD_TYPES,
    PARAM_KEYS: PARAM_KEYS,
    BUILTIN: BUILTIN,
    UI_OPTIONS: UI_OPTIONS,
    UI_OPTIONS_OF: UI_OPTIONS_OF,
    isCardType: isCardType,
    kindOf: kindOf,
    paramKeysOf: paramKeysOf,
    builtinOf: builtinOf,
    normalizeOne: normalizeOne,
    normalize: normalize,
    presetOf: presetOf,
    optionsFor: optionsFor,
    clampCount: clampCount,
    seedParams: seedParams,
    explainPreset: explainPreset,
  };
});
