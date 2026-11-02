(function () {
  'use strict';

  // C5：参数装配规则与前端其它入口、服务端共用同一份源码（web/assets/payload-rules.js）。
  // 兜底留一份等价实现：老页面缓存里可能还没这个脚本，缺了也不能让画布整个打不开。
  // 这里的取值规则必须与共享模块逐字一致 —— 两边一旦分叉，C5 就白做了。
  const FALLBACK_MODES = ['reference', 'frames', 'text'];
  const FALLBACK_TAIL_KINDS = { video: 1, quick: 1 };
  const rules = window.CanvasPayloadRules || {
    TAIL_KINDS: FALLBACK_TAIL_KINDS,
    kindOf: (t) => (String(t || 'image') === 'quick' ? 'video' : String(t || 'image')),
    isTailKind: (t) => Boolean(FALLBACK_TAIL_KINDS[String(t || '')]),
    normalizeMode: (t, m) => {
      const type = String(t || '');
      // 图片 / 音频没有模式概念，硬塞值会让通道模板里的判断走偏
      if (!FALLBACK_TAIL_KINDS[type] && type !== 'video') return '';
      if (type === 'quick') return 'reference';
      const value = String(m == null ? '' : m);
      return FALLBACK_MODES.indexOf(value) >= 0 ? value : 'reference';
    },
    clampCount: (v) => {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < 1) return 1;
      return Math.min(4, n);
    },
    normalizeRefs: (list) =>
      (Array.isArray(list) ? list : [])
        .filter((item) => item && (item.url || item.src))
        .map((item) => ({
          url: String(item.url || item.src),
          kind: String(item.kind == null ? '' : item.kind),
          name: String(item.name == null ? '' : item.name),
          role: String(item.role == null ? '' : item.role),
        })),
    normalizeTailChoice: (value) => {
      if (value === true) return { enabled: true, presetId: '' };
      if (value === false || value == null || typeof value !== 'object') return { enabled: false, presetId: '' };
      return { enabled: value.enabled !== false, presetId: String(value.presetId || '') };
    },
    assemble: null,
  };

  const PRESETS = {
    image: {
      w: 360,
      h: 203,
      label: '图片',
      media: 'image',
      empty: '生成结果会显示在这里',
      placeholder: '描述想要的画面，例如：黄昏的海边，一只橙色小猫坐在礁石上…',
    },
    video: {
      w: 480,
      h: 270,
      label: '视频',
      media: 'video',
      empty: '生成好的视频会显示在这里',
      placeholder: '描述镜头和动作，例如：镜头缓慢推近，小猫抬头望向远方…',
    },
    audio: {
      w: 320,
      h: 96,
      label: '音频',
      media: 'audio',
      empty: '生成好的音频会显示在这里',
      placeholder: '描述想生成的声音，例如：雨打屋檐的声音，远处有雷声…',
    },
    group: {
      w: 320,
      h: 184,
      label: '组合',
      media: 'image',
      empty: '把卡片加进来：选中几张卡片，右键选「添加组」',
      placeholder: '给这组素材起个名字（可选），例如：开头三镜',
    },
    // 快速视频：不用连线，提示词里 @ 谁就用谁
    quick: {
      w: 480,
      h: 270,
      label: '快速视频',
      media: 'video',
      empty: '生成好的视频会显示在这里',
      placeholder: '写提示词，敲 @ 直接挑画布上的素材，不用先连线',
    },
    // 定时生成组：管着几张视频卡片，到点由本地后台自动生成
    schedule: {
      w: 360,
      h: 260,
      label: '定时生成组',
      media: 'image',
      empty: '选中两张以上视频卡片，右键「创建定时生成组」',
      placeholder: '给这个定时组起个名字（可选）',
    },
    // 3D 导演台：一张卡代表一个三维场景，双击进去摆位、记机位、出图
    director: {
      w: 520,
      h: 300,
      label: '3D 导演台',
      media: 'image',
      empty: '双击打开导演台，摆好机位再出图',
      placeholder: '',
    },
  };
  // 能新建的四种：图片 / 视频 / 音频 / 快速视频；组合是选中卡片之后合出来的
  const ADDABLE_TYPES = ['image', 'video', 'audio', 'quick'];
  const ROLES = {
    image: [{ key: 'reference_image', label: '参考图' }],
    // 快速视频靠 @ 引用，不靠连线；这里给空数组，连线面板就不显示
    quick: [],
    video: [
      { key: 'first_frame', label: '首帧' },
      { key: 'last_frame', label: '尾帧' },
      { key: 'reference_image', label: '参考图' },
      { key: 'reference_video', label: '参考视频' },
      { key: 'reference_audio', label: '参考音频' },
    ],
    audio: [],
    director: [],
    // 定时组不参与连线，只负责管组里的视频卡片
    schedule: [],
  };
  const PARAM_DEFS = {
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
    // 快速视频默认按「全能参考」走，不给模式切换，省一步
    quick: [
      { key: 'duration', label: '时长', options: ['5', '10', '15', '30'], texts: ['5 秒', '10 秒', '15 秒', '30 秒'] },
      { key: 'resolution', label: '分辨率', options: ['720p', '1080p'], texts: ['720P', '1080P'] },
      { key: 'ratio', label: '比例', options: ['16:9', '9:16', '1:1'] },
    ],
    audio: [],
    director: [],
    schedule: [],
  };
  const PARAM_DEFAULTS = {
    image: { size: '2K', ratio: '16:9', count: '1' },
    video: { duration: '30', resolution: '720p', ratio: '16:9', mode: 'reference' },
    quick: { duration: '30', resolution: '720p', ratio: '16:9' },
    audio: {},
    director: {},
    schedule: {},
  };
  // 没有任何渠道配置时先用这份内置清单，只要后台配好渠道就会自动换成渠道里的模型
  const FALLBACK_MODELS = {
    image: [
      'gpt-image-2.5-flare',
      'gpt-image-2-plus',
      'gpt-image-2-原生4k',
      'gpt-image-2.5特价2k',
      'gpt-image-2.5特价4k',
    ],
    video: [],
    audio: [],
  };
  const MODEL_MEMO_KEY = 'canvas.model-memo';

  let modelRegistry = { image: [], video: [], audio: [] };

  function readModelMemo() {
    try {
      const raw = window.localStorage.getItem(MODEL_MEMO_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function rememberModel(type, model) {
    try {
      const memo = readModelMemo();
      memo[type === 'quick' ? 'video' : type] = model;
      window.localStorage.setItem(MODEL_MEMO_KEY, JSON.stringify(memo));
    } catch {
      /* 记不住也不影响使用 */
    }
  }

  // 返回 [{ key, id, label, channel, channelId, isDefault }]，渠道里没有就退回内置清单
  function modelsFor(type) {
    // 快速视频用的就是视频模型
    const kind = type === 'quick' ? 'video' : type;
    const seen = new Set();
    const list = [];
    const push = (entry) => {
      const id = typeof entry === 'string' ? entry : entry && entry.id;
      if (!id) return;
      const channelId = (entry && entry.channelId) || '';
      const key = channelId + '::' + id;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({
        key: key,
        id: id,
        label: (entry && entry.label) || id,
        note: (entry && entry.note) || '',
        channel: (entry && entry.channel) || '',
        channelId: channelId,
        isDefault: Boolean(entry && entry.isDefault),
      });
    };
    (modelRegistry[kind] || []).forEach(push);
    if (!list.length) (FALLBACK_MODELS[kind] || []).forEach(push);
    // 同一个模型名出现在多个渠道里时，后面标上渠道名，选的时候不会选错
    const counts = {};
    list.forEach((item) => {
      counts[item.id] = (counts[item.id] || 0) + 1;
    });
    // 有备注就显示备注；没备注又跟别的渠道重名，就退一步标上渠道名
    list.forEach((item) => {
      const extra = item.note || (counts[item.id] > 1 ? item.channel : '');
      if (extra) item.label = item.label + ' · ' + extra;
    });
    return list;
  }

  async function loadModels() {
    if (!window.api || !window.api.models) return;
    try {
      const data = await window.api.models();
      const next = { image: [], video: [], audio: [] };
      ['image', 'video', 'audio'].forEach((key) => {
        next[key] = Array.isArray(data && data[key]) ? enableModelList(data[key]) : [];
      });
      modelRegistry = next;
    } catch (error) {
      console.log('模型清单读取失败，先用内置清单：' + error.message);
    }
  }

  function enableModelList(list) {
    return list.filter((item) => item && (typeof item === 'string' ? item : item.id));
  }

  // 卡片没选过模型时，优先用上次用过的，其次用清单第一个
  function pickDefaultModel(type) {
    const list = modelsFor(type);
    if (!list.length) return '';
    const remembered = readModelMemo()[type === 'quick' ? 'video' : type];
    if (remembered && list.some((item) => item.id === remembered)) return remembered;
    const preferred = list.find((item) => item.isDefault);
    if (preferred) return preferred.id;
    return list[0].id;
  }

  // 当前这张卡片用的模型，能接受哪些参数（服务端随模型清单一起发过来）
  function modelSpecOf(type, data) {
    const kind = type === 'quick' ? 'video' : type;
    const id = String((data && data.model) || '');
    if (!id) return null;
    const channelId = String((data && data.channelId) || '');
    const list = modelRegistry[kind] || [];
    let hit = list.find((item) => item.id === id && (!channelId || item.channelId === channelId));
    if (!hit) hit = list.find((item) => item.id === id);
    return (hit && hit.spec) || null;
  }

  // 同一个参数面板，换模型后能选的值不一样：768P 的模型就别给它 1080P
  function paramDefsOf(node, data) {
    const defs = PARAM_DEFS[node.type] || [];
    const spec = modelSpecOf(node.type, data);
    if (!spec) return defs;
    return defs.map((def) => {
      let options = def.options;
      let texts = def.texts;
      // 生图模型的「尺寸」就是它的 resolution 档位，lite 之类只开 1K 的模型就别给 2K / 4K
      if (def.key === 'size' && Array.isArray(spec.sizes) && spec.sizes.length) {
        options = spec.sizes.slice();
        texts = null;
      } else if (def.key === 'resolution' && Array.isArray(spec.resolutions) && spec.resolutions.length) {
        options = spec.resolutions.slice();
        texts = options.map((value) => String(value).toUpperCase());
      } else if (def.key === 'duration' && Array.isArray(spec.durations) && spec.durations.length) {
        options = spec.durations.map(String);
        texts = options.map((value) => value + ' 秒');
      } else if (def.key === 'ratio' && Array.isArray(spec.ratios) && spec.ratios.length) {
        options = spec.ratios.slice();
        texts = null;
      } else if (def.key === 'mode' && Array.isArray(spec.modes) && spec.modes.length) {
        const names = { reference: '全能参考', frames: '首尾帧', text: '纯文生' };
        options = spec.modes.slice();
        texts = options.map((value) => names[value] || value);
      }
      if (options === def.options) return def;
      return Object.assign({}, def, { options: options, texts: texts });
    });
  }

  function normalizeParams(node) {
    const data = node.data;
    const defaults = PARAM_DEFAULTS[node.type] || {};
    if (!data.params || typeof data.params !== 'object') data.params = {};
    const defs = paramDefsOf(node, data);
    Object.keys(defaults).forEach((key) => {
      const def = defs.find((item) => item.key === key);
      if (!def || !def.options.length) return;
      if (def.options.indexOf(data.params[key]) >= 0) return;
      // 换过模型后老的值可能不适用了：先用默认值，再不行就用第一个
      const fallback = String(defaults[key] === undefined ? '' : defaults[key]);
      data.params[key] = def.options.indexOf(fallback) >= 0 ? fallback : def.options[0];
    });
    return data.params;
  }

  // 定时组「同时生成」：0 = 不限制，1~10 张；缺省或乱填按 2 张
  function normalizeScheduleConcurrency(value) {
    if (value === 'unlimited' || value === 'all') return 0;
    if (value == null || value === '') return 2;
    const n = Number(value);
    if (!Number.isFinite(n)) return 2;
    if (n <= 0) return 0;
    return Math.max(1, Math.min(10, Math.round(n)));
  }

  function scheduleConcurrencyText(value) {
    const n = normalizeScheduleConcurrency(value);
    return n === 0 ? '不限制同时生成' : '同时 ' + n + ' 张';
  }

  // ---------- 尾部提示词 ----------
  // 卡片只保存 { enabled, presetId }，正文永远从设置里的预设读取。
  // presetId 为空表示「跟随全局默认」，换默认预设不用回头改每张卡。
  // 支持尾部的类型清单同样从共享规则里取，避免两处清单各写一份慢慢走偏
  const TAIL_KINDS = window.CanvasPayloadRules ? window.CanvasPayloadRules.TAIL_KINDS : { video: 1, quick: 1 };

  function tailConfig() {
    const fallback = { enabled: false, defaultId: '', presets: [] };
    if (!window.UITheme) return fallback;
    const raw = window.UITheme.tailPrompts();
    if (!raw || typeof raw !== 'object') return fallback;
    return {
      enabled: raw.enabled !== false,
      defaultId: String(raw.defaultId || ''),
      presets: Array.isArray(raw.presets) ? raw.presets : [],
    };
  }

  function tailPresetById(id) {
    const key = String(id || '');
    if (!key) return null;
    return tailConfig().presets.find((item) => item && String(item.id) === key) || null;
  }

  function tailPresetName(preset) {
    return preset ? String(preset.name || '未命名风格') : '';
  }

  function supportsTail(node) {
    return Boolean(node && TAIL_KINDS[node.type]);
  }

  function cardTailChoice(node) {
    if (!supportsTail(node)) return { enabled: false, presetId: '' };
    const raw = nodeData(node).tailPrompt;
    if (!raw || typeof raw !== 'object') return { enabled: false, presetId: '' };
    return { enabled: raw.enabled !== false, presetId: String(raw.presetId || '') };
  }

  function defaultTailChoice() {
    const cfg = tailConfig();
    if (!cfg.enabled || !cfg.defaultId || !tailPresetById(cfg.defaultId)) return { enabled: false, presetId: '' };
    return { enabled: true, presetId: '' };
  }

  function tailPresetForChoice(choice) {
    const cfg = tailConfig();
    const id = String((choice && choice.presetId) || cfg.defaultId || '');
    return id ? tailPresetById(id) : null;
  }

  // 保证卡片数据字段齐全，老数据也能直接打开
  function nodeData(node) {
    if (!node.data || typeof node.data !== 'object') node.data = {};
    const data = node.data;
    if (typeof data.text !== 'string') data.text = data.text == null ? '' : String(data.text);
    if (typeof data.title !== 'string') data.title = data.title == null ? '' : String(data.title);
    // 组合卡片：members 里存着这组有哪几张卡片
    if (node.type === 'group' && !Array.isArray(data.members)) data.members = [];
    // 定时组：members / order 存组里的视频卡片，schedule 存时间与快照
    if (node.type === 'schedule') {
      if (!Array.isArray(data.members)) data.members = [];
      if (!Array.isArray(data.order)) data.order = [];
      if (!data.schedule || typeof data.schedule !== 'object') data.schedule = {};
      const sched = data.schedule;
      if (!Number(sched.startAt)) sched.startAt = 0;
      if (!Number.isFinite(Number(sched.intervalSec))) sched.intervalSec = 120;
      if (sched.mode !== 'perCard') sched.mode = 'stagger';
      if (!sched.perCard || typeof sched.perCard !== 'object') sched.perCard = {};
      if (!sched.snapshots || typeof sched.snapshots !== 'object') sched.snapshots = {};
      sched.concurrency = normalizeScheduleConcurrency(sched.concurrency);
      // container=true：组是一个大框，成员卡片摆在框里；compact=true：成员缩成四分之一
      if (data.container !== true) data.container = false;
      if (data.compact !== true) data.compact = false;
      // order 去掉已经不在组里的，再把 members 里新加的补到后面
      const alive = new Set(data.members);
      data.order = data.order.filter((id) => alive.has(id));
      data.members.forEach((id) => {
        if (data.order.indexOf(id) < 0) data.order.push(id);
      });
    }
    // sized=true 表示用户手动拉过卡片大小，之后就不再自动按图片比例贴合
    if (data.sized !== true) data.sized = false;
    if (data.locked !== true) data.locked = false;
    if (data.hidden !== true) data.hidden = false;
    normalizeParams(node);
    if (!data.model) data.model = pickDefaultModel(node.type);
    return data;
  }

  function paramText(def, value) {
    const index = def.options.indexOf(value);
    if (def.texts && index >= 0) return def.texts[index];
    return value;
  }

  function refreshNode(node) {
    // 正在这张卡片的提示词里挑 @ 素材时，重建卡片不能把列表一起收掉
    const keepMention = Boolean(mentionEl && mentionNode && mentionNode.id === node.id);
    const el = elements.get(node.id);
    const mentionInline = Boolean(keepMention && mentionBox && el && el.contains(mentionBox));
    if (!keepMention) closeMention();
    if (!el) return;
    // 正在提示词里打字时重建卡片，光标要放回原处
    const keepFocus = el.contains(document.activeElement);
    const next = buildNode(node);
    el.replaceWith(next);
    elements.set(node.id, next);
    if (keepFocus) {
      const box = next.querySelector('.node-prompt');
      if (box) {
        box.focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(box);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    if (keepMention) {
      // 卡片内框重建过 → 挂到新的框上；大窗口的框没动 → 原地续上
      const wasStale = mentionStale;
      const target = mentionInline ? next.querySelector('.node-prompt') : mentionBox;
      if (target && document.body.contains(target)) openMention(node, target);
      else closeMention();
      mentionStale = wasStale && Boolean(mentionEl);
    }
    paintFilter();
    refreshSelection();
    syncPromptEditorRefs(node);
    syncPromptEditorParams(node);
    syncPromptEditorTail(node);
  }

  // 只是卡片背后的连线信息变了（比如删掉了另一张卡片）：只换掉编辑面板，
  // 卡片本体和图片 / 视频原样保留，免得媒体重新加载时黑闪一下
  function refreshPanelOnly(node) {
    const el = elements.get(node.id);
    if (!el) return;
    // 正在这张卡片的输入框里打字：先别换，免得光标被打断
    if (el.contains(document.activeElement)) return;
    const old = el.querySelector('.node-panel');
    if (!old) return;
    const next = buildPanel(node, nodeData(node), presetOf(node.type), el);
    old.replaceWith(next);
    placePanel();
    syncPromptEditorRefs(node);
    syncPromptEditorParams(node);
    syncPromptEditorTail(node);
  }

  // 定时组里的成员变了：只更新卡片上的橙色序号和组内样式，不重建卡片
  function paintScheduleBadges() {
    elements.forEach((el, id) => {
      const hit = memberSchedule.get(id);
      const badge = el.querySelector('.schedule-order');
      el.classList.toggle('sched-member', Boolean(hit));
      el.classList.toggle('sched-compact', Boolean(hit && hit.compact));
      if (!badge) return;
      if (!hit) {
        badge.classList.add('none');
        badge.textContent = '';
        badge.title = '';
        return;
      }
      badge.classList.remove('none');
      badge.textContent = String(hit.index);
      badge.title = '定时生成组里的第 ' + hit.index + ' 张';
    });
  }

  const MIN_W = 140;
  const MIN_H = 80;
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 4;
  const GRID = 8;
  const SNAP_PX = 6;
  const HISTORY_LIMIT = 60;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const viewportEl = document.getElementById('viewport');
  const worldEl = document.getElementById('world');
  const gridLayerEl = document.getElementById('grid-layer');

  // 画布是无限平面，可视区本身永远不该被滚动：焦点落到贴边内容时也保持原位
  function keepViewportAnchored() {
    if (viewportEl.scrollTop !== 0) viewportEl.scrollTop = 0;
    if (viewportEl.scrollLeft !== 0) viewportEl.scrollLeft = 0;
  }
  viewportEl.addEventListener('scroll', keepViewportAnchored, { passive: true });

  // 可视区位置缓存：拖动 / 缩放时每帧都去量一次会强制浏览器同步布局，
  // 这里只在一轮手势开始时量一次，手势期间一直复用
  let viewportBoxCache = null;
  function viewportBox() {
    if (!viewportBoxCache) viewportBoxCache = viewportEl.getBoundingClientRect();
    return viewportBoxCache;
  }
  function invalidateViewportBox() {
    viewportBoxCache = null;
  }
  window.addEventListener('resize', invalidateViewportBox);
  window.addEventListener('scroll', invalidateViewportBox, true);
  const nameEl = document.getElementById('canvas-name');
  const saveEl = document.getElementById('save-state');
  const zoomEl = document.getElementById('zoom-value');
  const loadingEl = document.getElementById('loading');
  const toastEl = document.getElementById('toast');
  const alignBarEl = document.getElementById('align-bar');
  const titleWrapEl = document.getElementById('canvas-title');
  const titleBtnEl = document.getElementById('canvas-title-btn');
  const titleTextEl = document.getElementById('canvas-title-text');
  const titleInputEl = document.getElementById('canvas-title-input');
  const params = new URLSearchParams(window.location.search);
  const canvasId = params.get('id');

  const svgLayer = buildSvgLayer();
  worldEl.appendChild(svgLayer);

  let nodes = [];
  let edges = [];
  let viewport = { x: 0, y: 0, zoom: 1 };
  const selection = new Set();
  const elements = new Map();
  const edgeElements = new Map();
  let selectedEdgeId = null;
  let editingId = null;
  // 当前展开（显示编辑面板）的卡片，只可能有一张
  let expandedId = null;
  // 面板上次是按哪个缩放贴的：缩放一变就要重新量，平移不用
  let panelZoom = 0;
  let mode = 'hand';
  let spaceDown = false;
  let clipboard = null;
  let dirty = false;
  let saving = false;
  let saveTimer = null;
  // 保存状态面板（只有保存失败时才弹）与上次成功保存的时刻
  let savePanel = null;
  let lastSavedAt = 0;
  let lastSaveError = '';
  // 保存失败期间把侧栏钉住不收起，红点才看得见
  let saveRailPinned = false;
  // 乐观锁：这块画布的版本号。读画布时从服务端拿到，每次保存成功后更新。
  // 保存时把它带回去，对不上说明另一个标签页改过，服务端会拒收（409）。
  let canvasRev = 0;
  // 已经弹出冲突面板时置位：期间暂停自动保存，否则会拿旧版本号反复撞 409
  let saveConflict = false;
  // 记下这次冲突的服务端信息，面板被误关后还能再打开
  let lastConflict = null;
  let menuEl = null;
  let toastTimer = null;
  let guideEls = [];
  // 拉线期间如果原来正展开着编辑面板，记下它，连线结束后再展开回来
  let keepExpandedAfterConnect = null;
  let pendingSnapshot = null;
  const history = { past: [], future: [] };
  // 拖卡片时的对齐辅助线（标尺线）：默认关，用户想要时再开，状态记在本地
  const SNAP_GUIDE_KEY = 'canvas.snap-guide';
  let snapGuideOn = readSnapGuide();

  function readSnapGuide() {
    try {
      return window.localStorage.getItem(SNAP_GUIDE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setSnapGuide(on) {
    snapGuideOn = Boolean(on);
    try {
      window.localStorage.setItem(SNAP_GUIDE_KEY, snapGuideOn ? '1' : '0');
    } catch {
      // 存不下就只管这一次
    }
    const button = document.getElementById('btn-snap');
    if (button) {
      button.classList.toggle('on', snapGuideOn);
      button.setAttribute('aria-pressed', snapGuideOn ? 'true' : 'false');
      const dot = document.getElementById('snap-dot');
      if (dot) dot.hidden = !snapGuideOn;
      setRailDesc('btn-snap', snapGuideOn
        ? '对齐辅助线：现在开着，拖卡片时会吸附并出现标尺线。点一下关掉'
        : '对齐辅助线：现在关着，拖卡片不会有吸附和线条。点一下打开');
    }
    if (!snapGuideOn) clearGuides();
  }

  function buildSvgLayer() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'edge-layer');
    const defs = document.createElementNS(SVG_NS, 'defs');
    const marker = (id, color) => {
      const node = document.createElementNS(SVG_NS, 'marker');
      node.setAttribute('id', id);
      node.setAttribute('viewBox', '0 0 10 10');
      node.setAttribute('refX', '9');
      node.setAttribute('refY', '5');
      node.setAttribute('markerWidth', '6');
      node.setAttribute('markerHeight', '6');
      node.setAttribute('orient', 'auto-start-reverse');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      path.setAttribute('fill', color);
      node.appendChild(path);
      return node;
    };
    defs.appendChild(marker('arrow', '#8b93a3'));
    defs.appendChild(marker('arrow-soft', '#b9c0cc'));
    defs.appendChild(marker('arrow-link', '#2f6fed'));
    defs.appendChild(marker('arrow-sel', '#2f6fed'));
    svg.appendChild(defs);
    return svg;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8);
  }

  function byId(id) {
    return nodes.find((node) => node.id === id) || null;
  }

  // 锁定：卡片被钉住，不能拖动、不能改，但还能往外送素材
  // 隐藏：从画布上收起来（连线一起收起），但它仍然能当别人的素材
  function isLocked(node) {
    return Boolean(node && node.data && node.data.locked);
  }

  function isHidden(node) {
    return Boolean(node && node.data && node.data.hidden);
  }

  function visibleNodes() {
    return nodes.filter((node) => !isHidden(node));
  }

  function hiddenNodes() {
    return nodes.filter((node) => isHidden(node));
  }

  function presetOf(type) {
    return PRESETS[type] || PRESETS.image;
  }

  // 提示条。actions 可选：给一串 { label, run }，会渲染成提示条里的按钮。
  // 带按钮的提示条鼠标悬停时暂停计时 —— 否则用户刚要伸手去点，提示就自己消失了。
  let toastPauseLeft = 0;
  let toastPauseAt = 0;
  let toastHoverBound = false;

  function toastHide() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = 0;
    }
    toastEl.classList.remove('show');
    toastEl.classList.remove('has-actions');
  }

  function toastSchedule(ms) {
    if (toastTimer) clearTimeout(toastTimer);
    toastPauseLeft = ms;
    toastPauseAt = Date.now();
    toastTimer = setTimeout(toastHide, ms);
  }

  function toast(message, stayMs, actions) {
    const list = Array.isArray(actions) ? actions.filter((item) => item && typeof item.run === 'function') : [];
    // 按钮比纯文字更值得多看两眼，最短停留也给足
    const stay = Math.max(list.length ? 5200 : 1200, Number(stayMs) || (list.length ? 8000 : 1800));
    // 上一次的按钮要清掉，否则残留的旧按钮会跟着新提示一起出现
    toastEl.textContent = '';
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    toastEl.appendChild(text);
    if (list.length) {
      const bar = document.createElement('span');
      bar.className = 'toast-actions';
      list.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'toast-action';
        button.textContent = item.label;
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          // 点了就先收起来：动作自己会再弹一条结果提示
          toastHide();
          item.run();
        });
        bar.appendChild(button);
      });
      toastEl.appendChild(bar);
      toastEl.classList.add('has-actions');
    }
    // 悬停暂停 / 移开续计，只绑一次
    if (!toastHoverBound) {
      toastHoverBound = true;
      toastEl.addEventListener('mouseenter', () => {
        if (!toastEl.classList.contains('has-actions')) return;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = 0;
        toastPauseLeft = Math.max(600, toastPauseLeft - (Date.now() - toastPauseAt));
      });
      toastEl.addEventListener('mouseleave', () => {
        if (!toastEl.classList.contains('has-actions')) return;
        if (!toastEl.classList.contains('show')) return;
        toastSchedule(Math.max(600, toastPauseLeft));
      });
    }
    toastEl.classList.add('show');
    toastSchedule(stay);
  }

  // 只改真正变了的东西：平移时不重设点阵大小，缩放时百分比文字不重复写
  let lastGridSize = 0;
  let lastZoomText = '';

  function applyViewport() {
    worldEl.style.transform =
      'translate3d(' + viewport.x + 'px,' + viewport.y + 'px,0) scale(' + viewport.zoom + ')';
    const size = Math.max(8, 24 * viewport.zoom);
    if (gridLayerEl && size !== lastGridSize) {
      lastGridSize = size;
      gridLayerEl.style.backgroundSize = size + 'px ' + size + 'px';
    }
    if (gridLayerEl) gridLayerEl.style.backgroundPosition = viewport.x + 'px ' + viewport.y + 'px';
    const zoomText = Math.round(viewport.zoom * 100) + '%';
    if (zoomText !== lastZoomText) {
      lastZoomText = zoomText;
      zoomEl.textContent = zoomText;
    }
    scheduleMinimap();
    placeAlignBar();
    // 编辑面板是固定屏幕尺寸的界面元素：缩放变了要重新贴一次，平移不用
    if (expandedId && viewport.zoom !== panelZoom) placePanel();
  }

  // 一轮手势（拖动 / 平移 / 缩放）期间：关掉流光等重特效，松手后再恢复
  let interactingCount = 0;
  let interactTimer = 0;
  function beginInteraction() {
    invalidateViewportBox();
    interactingCount += 1;
    if (interactingCount === 1) {
      if (interactTimer) {
        window.clearTimeout(interactTimer);
        interactTimer = 0;
      }
      viewportEl.classList.add('is-interacting');
    }
  }
  function endInteraction() {
    interactingCount = Math.max(0, interactingCount - 1);
    if (interactingCount > 0) return;
    if (interactTimer) window.clearTimeout(interactTimer);
    interactTimer = window.setTimeout(() => {
      interactTimer = 0;
      viewportEl.classList.remove('is-interacting');
      invalidateViewportBox();
      if (mmShown) scheduleMinimap();
    }, 120);
  }

  // 一帧最多刷一次视口：鼠标事件再密也不会堆积成一串重复布局
  let viewportFrame = 0;
  function scheduleViewport() {
    if (viewportFrame) return;
    viewportFrame = window.requestAnimationFrame(() => {
      viewportFrame = 0;
      applyViewport();
    });
  }
  function flushViewport() {
    if (viewportFrame) {
      window.cancelAnimationFrame(viewportFrame);
      viewportFrame = 0;
    }
    applyViewport();
  }

  function toWorld(clientX, clientY) {
    const rect = viewportBox();
    return {
      x: (clientX - rect.left - viewport.x) / viewport.zoom,
      y: (clientY - rect.top - viewport.y) / viewport.zoom,
    };
  }

  function toScreen(worldX, worldY) {
    const rect = viewportBox();
    return {
      x: worldX * viewport.zoom + viewport.x + rect.left,
      y: worldY * viewport.zoom + viewport.y + rect.top,
    };
  }

  // ---------- 保存状态 ----------
  // 侧栏那个小圆点只表达「现在是哪一种状态」；存到几点、失败了该怎么办，
  // 统一收进点开的面板里。只改颜色不给下一步操作，用户是不知道该做什么的。
  const SAVE_STATE_TEXT = {
    saved: '已保存',
    dirty: '待保存',
    saving: '保存中',
    error: '保存失败',
  };

  function setSaveState(kind) {
    const state = SAVE_STATE_TEXT[kind] ? kind : 'saved';
    saveEl.textContent = SAVE_STATE_TEXT[state];
    saveEl.className = 'save-state ' + state;
    saveEl.dataset.state = state;
    const desc = saveDescription(state);
    saveEl.setAttribute('aria-label', desc);
    setRailDesc('save-state', desc);
    // 侧栏平时是贴着左边缘才弹出的，保存失败时那个红点根本看不见。
    // 这里把侧栏强制顶出来，用户至少能看到「出事了」，点一下就知道怎么办。
    // 冲突同理：需要用户做决定，不能缩在边上没人看见。
    if (state === 'error' || saveConflict) showRailForSaveError();
    else if (saveRailPinned) releaseRailForSaveError();
  }

  // 保存失败期间把侧栏钉住不放回；恢复后松手，交还给原来的「贴边弹出」逻辑
  function showRailForSaveError() {
    const rail = document.getElementById('rail');
    const page = document.querySelector('.canvas-page');
    if (!rail || !page) return;
    saveRailPinned = true;
    rail.classList.add('open');
    page.classList.add('rail-open');
  }

  function releaseRailForSaveError() {
    saveRailPinned = false;
    const rail = document.getElementById('rail');
    const page = document.querySelector('.canvas-page');
    if (!rail || !page) return;
    // 鼠标还停在侧栏上就先留着，等它自己移开后由贴边逻辑收回
    if (rail.matches(':hover')) return;
    rail.classList.remove('open');
    page.classList.remove('rail-open');
  }

  // 圆点的悬浮说明：把「上次成功保存时间」一起带上，鼠标一停就知道存到哪一步了
  function saveDescription(state) {
    if (state === 'error') {
      const at = lastSavedAt ? '上次成功保存 ' + clockText(lastSavedAt) : '这块画布还没有成功保存过';
      return '保存失败：' + (lastSaveError || '本机服务暂时没回应') + '（' + at + '）· 点一下可以重试或先导出兜底';
    }
    if (state === 'dirty') {
      // 冲突未处理时，圆点上的说明要说清「为什么没在存」，否则用户以为卡住了
      if (saveConflict) return '这块画布在另一个窗口被改过了，需要你选一下怎么处理 · 点一下看选项';
      return '有改动还没存，正在排队写入';
    }
    if (state === 'saving') return '正在写入本机数据库…';
    return lastSavedAt ? '已保存 · ' + clockText(lastSavedAt) : '已保存';
  }

  function clockText(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // 打开画布时问一次服务端：库是不是被重建过？
  // 库坏掉时旧数据会被挪进回收站、空库顶上，用户在这块画布上看到的是「卡片全没了」。
  // 不说一声的话，用户第一反应是「我的东西被删了」，然后拼命找也找不到。
  async function checkHealth() {
    const bar = document.getElementById('alert-bar');
    if (!bar) return;
    let data = null;
    try {
      data = await window.api.health();
    } catch {
      // 老服务端没这个接口：静默跳过，别在画布页弹错
      return;
    }
    const notice = data && data.notice;
    if (!notice) return;
    // 保存状态圆点上挂个红点，侧栏收起来时也能看出「有事」
    if (saveEl) saveEl.classList.add('db-rebuilt');
    const where = notice.oldDir || (data.dataDir || '') + '\\recycle';
    bar.textContent = '';

    const head = document.createElement('div');
    head.className = 'alert-head';
    head.textContent = '⚠ 数据库异常，已重建空库（' + clockText(notice.at) + '）· 这块画布可能是空的';

    const body = document.createElement('div');
    body.className = 'alert-body';
    body.textContent = '原因：' + (notice.reason || '未知原因') + '。旧数据没有删除，完整保存在下面这个目录，把里面的 canvas.db 复制回 data 目录再重启就能恢复：';

    const pathLine = document.createElement('div');
    pathLine.className = 'alert-path';
    pathLine.textContent = where;

    const actions = document.createElement('div');
    actions.className = 'alert-actions';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制旧库路径';
    copyBtn.addEventListener('click', async () => {
      // clipboard API 在部分环境拿不到，用 execCommand 兜底，别让用户只能手选
      let ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(where);
          ok = true;
        }
      } catch {
        /* 落到兜底 */
      }
      if (!ok) {
        try {
          const area = document.createElement('textarea');
          area.value = where;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.top = '-1000px';
          document.body.appendChild(area);
          area.select();
          ok = document.execCommand('copy');
          area.remove();
        } catch {
          ok = false;
        }
      }
      copyBtn.textContent = ok ? '已复制' : '复制失败，请手动选中上面的路径';
    });

    const ackBtn = document.createElement('button');
    ackBtn.className = 'ghost';
    ackBtn.textContent = '收起';
    ackBtn.addEventListener('click', () => {
      bar.classList.add('hidden');
      // 只收本次页面，不调 ack：门户页还要继续提示，直到用户在那里点「我知道了」
    });

    actions.appendChild(copyBtn);
    actions.appendChild(ackBtn);
    bar.appendChild(head);
    bar.appendChild(body);
    bar.appendChild(pathLine);
    bar.appendChild(actions);
    bar.classList.remove('hidden');
  }

  // 保存失败时点圆点弹出来的面板：说清失败原因与上次成功时间，并给出两条出路
  function openSavePanel() {
    closeSavePanel();
    const panel = document.createElement('div');
    panel.className = 'menu save-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '保存状态');

    const head = document.createElement('div');
    head.className = 'save-panel-head';
    const title = document.createElement('b');
    title.textContent = '保存失败';
    head.appendChild(title);
    const reason = document.createElement('span');
    reason.textContent = lastSaveError || '本机服务暂时没回应';
    head.appendChild(reason);
    panel.appendChild(head);

    const when = document.createElement('div');
    when.className = 'save-panel-when';
    when.textContent = lastSavedAt
      ? '上次成功保存：' + clockText(lastSavedAt)
      : '这块画布还没有成功保存过';
    panel.appendChild(when);

    const sep = document.createElement('div');
    sep.className = 'sep';
    panel.appendChild(sep);

    // 服务恢复了就直接重试；服务还没起来，至少先把当前内容落到本地文件里
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '立即重试保存';
    retry.addEventListener('click', () => {
      closeSavePanel();
      dirty = true;
      saveNow(true);
    });
    panel.appendChild(retry);

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.textContent = '导出当前状态（.json）';
    exportBtn.addEventListener('click', () => exportCurrentState());
    panel.appendChild(exportBtn);

    document.body.appendChild(panel);
    // 贴在圆点右边；右边放不下就往左让，上下左右都不出窗口
    const rect = saveEl.getBoundingClientRect();
    panel.style.position = 'fixed';
    const w = panel.offsetWidth || 240;
    const h = panel.offsetHeight || 150;
    const margin = 10;
    let left = rect.right + margin;
    if (left + w > window.innerWidth - margin) left = rect.left - margin - w;
    if (left < margin) left = margin;
    let top = rect.top + rect.height / 2 - h / 2;
    top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - h - margin));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    savePanel = panel;
  }

  function closeSavePanel() {
    if (!savePanel) return;
    if (savePanel.parentNode) savePanel.parentNode.removeChild(savePanel);
    savePanel = null;
  }

  // 保存被服务端拒收：这块画布在别的地方（多半是另一个标签页）已经改过了。
  //
  // 为什么不能让程序自己选：两种做法都会丢东西。
  // 直接覆盖 → 丢掉另一个标签页的改动；直接放弃本地 → 丢掉本机这几分钟的改动。
  // 所以这里把三条路都摆出来，让用户自己定，其中「导出」那条路保证一个字节都不丢。
  function handleSaveConflict(info) {
    if (saveConflict) return;
    saveConflict = true;
    lastConflict = info || {};
    buildConflictPanel(lastConflict);
  }

  // 面板被误关（比如点了一下空白处）后还能再打开
  function reopenConflictPanel() {
    buildConflictPanel(lastConflict || {});
  }

  function buildConflictPanel(info) {
    if (savePanel) closeSavePanel();
    setSaveState('dirty');
    if (saveEl) saveEl.classList.add('conflict');

    const panel = document.createElement('div');
    panel.className = 'menu save-panel conflict-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '保存冲突');

    const head = document.createElement('div');
    head.className = 'save-panel-head';
    const title = document.createElement('b');
    title.textContent = '这块画布在别处被改过了';
    head.appendChild(title);
    panel.appendChild(head);

    const note = document.createElement('div');
    note.className = 'save-panel-note';
    note.textContent =
      '你打开这个页面之后，另一个窗口保存过同一块画布（服务端已到第 ' +
      Number(info.rev || 0) +
      ' 版，你手上是第 ' +
      canvasRev +
      ' 版）。你自己选怎么办，哪一条都不会偷偷丢掉东西。';
    panel.appendChild(note);

    const sep = document.createElement('div');
    sep.className = 'sep';
    panel.appendChild(sep);

    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.textContent = '用最新的（丢掉我这次的改动）';
    reloadBtn.addEventListener('click', async () => {
      reloadBtn.disabled = true;
      reloadBtn.textContent = '正在重新读取…';
      try {
        const state = info.state || (await window.api.getCanvas(canvasId));
        applyServerState(state);
        setCanvasName(state.canvas.name);
        renderAll();
        applyViewport();
        dirty = false;
        saveConflict = false;
        lastConflict = null;
        if (saveEl) saveEl.classList.remove('conflict');
        lastSavedAt = Date.now();
        lastSaveError = '';
        closeSavePanel();
        setSaveState('saved');
        toast('已载入最新版本');
      } catch (error) {
        reloadBtn.disabled = false;
        reloadBtn.textContent = '用最新的（丢掉我这次的改动）';
        toast('读取失败：' + ((error && error.message) || '请稍后再试'));
      }
    });
    panel.appendChild(reloadBtn);

    const mineBtn = document.createElement('button');
    mineBtn.type = 'button';
    mineBtn.textContent = '保留我的，覆盖过去';
    mineBtn.addEventListener('click', async () => {
      mineBtn.disabled = true;
      mineBtn.textContent = '正在保存…';
      // 覆盖之前先把服务端现在这一版留档，压错了还能从「历史版本」找回来
      try {
        await window.api.snapshotCanvas(canvasId, '被覆盖前');
      } catch {
        // 留档失败不拦覆盖：用户明确要做的事优先，备份只是加分项
      }
      // 关键：把版本号对齐到服务端当前值再发，否则又是 409
      canvasRev = Number.isInteger(info.rev) ? info.rev : canvasRev;
      saveConflict = false;
      lastConflict = null;
      if (saveEl) saveEl.classList.remove('conflict');
      closeSavePanel();
      dirty = true;
      await saveNow(true);
    });
    panel.appendChild(mineBtn);

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.textContent = '先导出我这份（.json）';
    exportBtn.addEventListener('click', () => exportCurrentState());
    panel.appendChild(exportBtn);

    document.body.appendChild(panel);
    const rect = saveEl ? saveEl.getBoundingClientRect() : { right: 60, left: 0, top: 100, height: 20 };
    panel.style.position = 'fixed';
    const w = panel.offsetWidth || 260;
    const h = panel.offsetHeight || 200;
    const margin = 10;
    let left = rect.right + margin;
    if (left + w > window.innerWidth - margin) left = rect.left - margin - w;
    if (left < margin) left = margin;
    let top = rect.top + rect.height / 2 - h / 2;
    top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - h - margin));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    savePanel = panel;
    // 冲突是「必须处理」的事：把侧栏顶出来，别让它缩在边上没人看见
    showRailForSaveError();
  }

  // 保存一直失败时的兜底出路：把当前画布内容直接下载成 json，先保住数据不丢
  function exportCurrentState() {
    try {
      const payload = {
        format: 'local-canvas',
        version: 1,
        exportedAt: Date.now(),
        canvas: { name: (nameEl && nameEl.textContent || '').trim() },
        viewport: viewport,
        nodes: collectNodes(),
        edges: edges,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '画布兜底-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 200);
      toast('已把当前状态导出成文件，可以先留个底');
    } catch (error) {
      toast('导出失败：' + ((error && error.message) || error));
    }
  }

  // 只有「保存失败」时圆点才可点，平时点它没有任何意义
  saveEl.addEventListener('click', () => {
    // 保存失败、或有冲突待处理时都能点开：冲突的面板被误关了，得有个地方再打开
    const state = saveEl.dataset.state;
    if (state !== 'error' && !saveConflict) return;
    if (savePanel) closeSavePanel();
    else if (saveConflict) reopenConflictPanel();
    else openSavePanel();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!savePanel) return;
    if (savePanel.contains(event.target) || saveEl.contains(event.target)) return;
    closeSavePanel();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && savePanel) closeSavePanel();
  });

  // 工具栏图标的说明文字：按钮的 title 会随状态变，统一走这里同步到悬浮提示
  function setRailDesc(id, text) {
    const el = document.getElementById(id);
    if (el) el.dataset.railDesc = text || '';
  }

  // 存档时去掉只对「这一次操作」有意义的临时标记：
  // 否则「正在检查参考素材」这类中间状态会被写进画布，下次打开就一直转圈
  const TRANSIENT_KEYS = ['checking', 'preparing'];

  function persistedData(data) {
    if (!data || typeof data !== 'object') return {};
    let copy = null;
    TRANSIENT_KEYS.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(data, key)) return;
      if (!copy) copy = { ...data };
      delete copy[key];
    });
    return copy || data;
  }

  function collectNodes() {
    return nodes.map((node, index) => ({
      id: node.id,
      type: node.type,
      x: Math.round(node.x),
      y: Math.round(node.y),
      w: Math.round(node.w),
      h: Math.round(node.h),
      z: index,
      data: persistedData(node.data),
      createdAt: node.createdAt,
    }));
  }

  function scheduleSave() {
    dirty = true;
    setSaveState('dirty');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }

  // force=true 是「立即重试保存」用的：跳过 dirty/saving 判断，手动点的那次必须真的发出去
  async function saveNow(force) {
    if (!force && (!dirty || saving)) return;
    if (saving) return;
    // 冲突面板弹着的时候不自动保存：这时候手里的 rev 已经过期，
    // 再发也只会在服务端被拒，白白刷日志，还会盖掉用户正在看的提示
    if (saveConflict) return;
    saving = true;
    dirty = false;
    setSaveState('saving');
    // 保存前给这次改动过的卡片盖个时间戳，供「快速定位 → 跳到最近修改」排序用。
    // 放在这里而不是每个编辑点：编辑点有四十多处，漏一个就有一类改动永远定位不到
    stampTouchedCards();
    try {
      const result = await window.api.saveCanvas(
        canvasId,
        { nodes: collectNodes(), edges: edges, viewport: viewport },
        canvasRev
      );
      // 服务端会把写入后的新版本号回过来，记下来供下次保存使用
      if (result && Number.isInteger(result.rev)) canvasRev = result.rev;
      lastSavedAt = Date.now();
      lastSaveError = '';
      if (savePanel) closeSavePanel();
      setSaveState('saved');
    } catch (error) {
      // 409：这块画布在另一个标签页被改过了。这不是「保存失败」，是本机会覆盖别人的改动，
      // 必须由用户来定怎么办，所以单独走一条路，不进普通的失败状态机。
      if (error && error.status === 409 && error.data && error.data.conflict) {
        dirty = true;
        saving = false;
        handleSaveConflict(error.data);
        return;
      }
      dirty = true;
      lastSaveError = (error && error.message) || String(error);
      setSaveState('error');
      console.log('保存失败：' + lastSaveError);
    } finally {
      saving = false;
      // 失败之后不要再自动重试了：一直打不通就一直重试，只会把日志刷满；
      // 改成留给用户点「立即重试」，或切回页面时自动试一次
      if (dirty && !lastSaveError && !saveConflict) saveTimer = setTimeout(saveNow, 1500);
    }
  }

  function renderAll() {
    renderNodes();
    renderEdges();
    // 重画之后把定时组的运行状态补回去，不用等下一次轮询
    nodes.forEach((node) => {
      if (isSchedule(node)) paintScheduleState(node, scheduleRuns.get(node.id) || null);
    });
  }

  function renderNodes() {
    closeMention();
    // 先算好每张视频卡片属于哪个定时组、排第几，卡片建出来才能挂上序号
    refreshScheduleMemberMap();
    worldEl.querySelectorAll('.node, .sched-slot').forEach((el) => el.remove());
    elements.clear();
    nodes.forEach((node, index) => {
      node.z = index;
      // 隐藏的卡片不建到画布上：它只是收起来了，数据还在
      if (isHidden(node)) return;
      const el = buildNode(node);
      elements.set(node.id, el);
      worldEl.appendChild(el);
    });
    placePanel();
    refreshHiddenBadge();
    paintFilter();
    keepViewportAnchored();
    invalidateViewportBox();
  }

  // 编辑面板固定宽度（屏幕像素），不跟着卡片大小伸缩：所有卡片弹出来一样大
  const PANEL_W = 560;

  // 编辑面板：固定大小，水平以卡片中心线对齐；
  // 下方放不下就翻到卡片上方，始终贴着卡片居中显示
  // 只记住「上一次真正贴过的面板」，不再每次遍历整张画布的所有卡片
  let lastPlacedPanel = null;
  let lastPlacedHost = null;

  function resetPanelPlacement() {
    if (lastPlacedPanel) {
      lastPlacedPanel.style.left = '';
      lastPlacedPanel.style.top = '';
      lastPlacedPanel.style.width = '';
      lastPlacedPanel.style.minWidth = '0px';
      lastPlacedPanel.style.maxHeight = '';
      lastPlacedPanel.style.transform = '';
      lastPlacedPanel.style.zoom = '';
      lastPlacedPanel.style.marginLeft = '';
    }
    if (lastPlacedHost) lastPlacedHost.classList.remove('panel-up');
    lastPlacedPanel = null;
    lastPlacedHost = null;
  }

  function placePanel() {
    {
      const el = expandedId ? elements.get(expandedId) : null;
      const id = expandedId;
      const panel = el && el.querySelector('.node-panel');
      // 展开的卡片换了（或者收起来了）：先把上一块面板的定位清掉
      if (lastPlacedPanel && lastPlacedPanel !== panel) resetPanelPlacement();
      if (panel) {
        lastPlacedPanel = panel;
        lastPlacedHost = el;
      }
      const hostNode = id ? byId(id) : null;
      if (!panel) {
        panelZoom = viewport.zoom || 1;
        return;
      }
      if (isSchedule(hostNode)) {
        // 定时组：设置窗口贴在组框正中间，缩放时跟着组一起变，不会跑到画布外面
        const zoom = viewport.zoom || 1;
        const k = Math.max(0.35, 1 / zoom);
        // 用界面级 zoom 抵消画布缩放，避免父级 scale 再套子级 scale 时文字发糊
        panel.style.zoom = String(k);
        panel.style.transform = 'translate(-50%, -50%)';
        const screenW = Math.max(240, hostNode.w * zoom - 28);
        const screenH = Math.max(240, hostNode.h * zoom - 28);
        const width = Math.min(860, screenW);
        panel.style.left = '50%';
        panel.style.top = '50%';
        panel.style.width = width + 'px';
        panel.style.minWidth = width + 'px';
        panel.style.maxHeight = Math.min(760, screenH) + 'px';
        return;
      }
      {
        const view = viewportBox();
        const box = el.getBoundingClientRect();
        const zoom = viewport.zoom || 1;
        // 面板属于界面，不跟着画布缩放：屏幕上始终是同一个尺寸
        const k = Math.max(0.35, 1 / zoom);
        const scale = k;
        // 用界面级 zoom 抵消画布缩放，避免父级 scale 再套子级 scale 时文字发糊
        panel.style.zoom = String(k);
        const pad = 12;
        const gap = 8;

        // ① 固定宽度：屏幕 460px；原地展开时用更宽的大面板；窗口实在太窄才跟着收一收
        const wide = promptWideOn(hostNode);
        const wantW = wide ? Math.max(PANEL_W, PROMPT_WIDE_W) : PANEL_W;
        const screenW = Math.min(wantW, Math.max(220, view.width - pad * 2));
        const width = screenW;
        panel.style.width = width + 'px';
        panel.style.minWidth = width + 'px';
        panel.style.maxHeight = '';

        // ② 上还是下：按屏幕上的实际空位判断，下方不够、上方更宽裕就翻上去
        const height = panel.offsetHeight;
        const roomBelow = view.bottom - box.bottom;
        const roomAbove = box.top - view.top;
        const up = roomBelow < height + gap + pad && roomAbove > roomBelow;
        el.classList.toggle('panel-up', up);

        panel.style.transform = '';
        // 上下翻转只影响基准位置；缩放已经交给面板自身的 zoom 处理
        panel.style.transformOrigin = up ? 'center bottom' : 'center top';

        // ③ 水平：对齐卡片中心线（左边缘 50%，再往回挪半个面板宽）
        panel.style.left = '50%';
        panel.style.marginLeft = -width / 2 + 'px';

        // ④ 贴着窗口左右边缘时整体往里让，保证整块面板都在窗口里
        let rect = panel.getBoundingClientRect();
        let dx = 0;
        if (rect.right > view.right - pad) dx = view.right - pad - rect.right;
        if (rect.left + dx < view.left + pad) dx = view.left + pad - rect.left;
        if (dx) panel.style.marginLeft = -width / 2 + dx + 'px';

        // ⑤ 竖直方向实在放不下（窗口很矮）就让面板自己滚动，别让底部按钮被切走
        const after = panel.getBoundingClientRect();
        const room = up ? after.bottom - view.top - pad : view.bottom - pad - after.top;
        if (after.height > room) panel.style.maxHeight = Math.max(240, room) + 'px';
      }
    }
    panelZoom = viewport.zoom || 1;
  }

  // 拖动时轻量判断：面板该在卡片下方还是上方，只有状态变了才真的重新贴一次
  function refreshPanelFlip(node) {
    const el = elements.get(node.id);
    const panel = el && el.querySelector('.node-panel');
    if (!panel || isSchedule(node)) return;
    const view = viewportBox();
    const box = el.getBoundingClientRect();
    const roomBelow = view.bottom - box.bottom;
    const roomAbove = box.top - view.top;
    const up = roomBelow < panel.offsetHeight + 20 && roomAbove > roomBelow;
    if (up !== el.classList.contains('panel-up')) placePanel();
  }

  function refreshZOrder() {
    applyZOrder();
  }

  // 卡片的原始尺寸（不受定时组紧凑模式影响）
  function rawSizeOf(node) {
    const preset = presetOf(node.type);
    return { w: node.w || preset.w, h: node.h || preset.h };
  }

  // 定时组里的卡片一律按统一的格子显示（紧凑模式再缩一半），
  // 卡片自己的原始宽高存在 node.w / node.h 里不动，移出组就还原成原样。
  function scheduleCellSize(compact) {
    const k = compact ? SCHEDULE_COMPACT_SCALE : 1;
    return { w: Math.round(SCHEDULE_CELL_W * k), h: Math.round(SCHEDULE_CELL_H * k) };
  }

  function sizeOf(node) {
    const hit = memberSchedule.get(node.id);
    if (hit) return scheduleCellSize(Boolean(hit.compact));
    return rawSizeOf(node);
  }

  // 组框永远压在组里的卡片下面，这样卡片才是「摆在框里」的；
  // 展开设置窗口时整组临时浮到最上面，面板和遮罩才盖得住组里的卡片。
  function zIndexOf(node) {
    if (isSchedule(node)) {
      const members = scheduleMembersOf(node);
      let lowest = Infinity;
      members.forEach((member) => {
        lowest = Math.min(lowest, Number(member.z) || 0);
      });
      const base = Number.isFinite(lowest) ? 10 + lowest - 1 : 10 + (Number(node.z) || 0);
      return base + (node.id === expandedId ? 30000 : 0);
    }
    return 10 + (Number(node.z) || 0) + (node.id === expandedId ? 200 : 0);
  }

  // 卡片大小只走固定的几档（按当前比例等比缩放），不会拉成任意长宽
  const RESIZE_STEPS = [0.55, 0.7, 0.85, 1, 1.2, 1.45, 1.75, 2.1, 2.5];

  // 卡片能缩到的最小档：短边 149，长边最多 264（按卡片比例算）
  // 横屏 264×149，竖屏 149×264，方图 149×149
  const MIN_CARD_SHORT = 149;
  const MIN_CARD_LONG = 264;

  function minCardSizeOf(widthRatio) {
    const r = Number.isFinite(widthRatio) && widthRatio > 0 ? widthRatio : 16 / 9;
    if (r >= MIN_CARD_LONG / MIN_CARD_SHORT) {
      return { w: MIN_CARD_LONG, h: Math.max(MIN_H, Math.round(MIN_CARD_LONG / r)) };
    }
    if (r <= MIN_CARD_SHORT / MIN_CARD_LONG) {
      return { w: Math.max(MIN_W, Math.round(MIN_CARD_LONG * r)), h: MIN_CARD_LONG };
    }
    if (r >= 1) return { w: Math.round(MIN_CARD_SHORT * r), h: MIN_CARD_SHORT };
    return { w: MIN_CARD_SHORT, h: Math.round(MIN_CARD_SHORT / r) };
  }

  function resizePresets(node, origin) {
    const ratio = origin.w > 0 ? origin.h / origin.w : 0.5625;
    // 以这类卡片的标准宽度为基准，同样大小的卡片永远落在同一档，不会因为先后拉过而错位
    const baseW = presetOf(node.type).w || 360;
    // 最小那一档统一：图片、视频、快速视频缩到底都是一样大
    const min = minCardSizeOf(ratio > 0 ? 1 / ratio : 16 / 9);
    const list = RESIZE_STEPS.map((step) => {
      const w = Math.max(MIN_W, Math.round(baseW * step));
      return { w: w, h: Math.max(MIN_H, Math.round(w * ratio)) };
    }).filter((item) => item.w > min.w);
    // 本来就更小的卡片（上传的缩略图素材）保留现在的尺寸，一拖不会突然跳大
    if (origin.w < min.w) list.unshift({ w: origin.w, h: origin.h });
    list.push(min);
    return list;
  }

  function nearestPresetIndex(presets, width) {
    let best = 0;
    let bestGap = Infinity;
    presets.forEach((item, index) => {
      const gap = Math.abs(item.w - width);
      if (gap < bestGap) {
        bestGap = gap;
        best = index;
      }
    });
    return best;
  }

  // 比例 → 卡片宽高。除了常看的几个，接口还会给 5:4、21:9、1:3 之类，统一按「a:b」现算
  const RATIO_VALUE = {
    '16:9': 16 / 9,
    '9:16': 9 / 16,
    '1:1': 1,
    '4:3': 4 / 3,
    '3:4': 3 / 4,
  };
  function ratioValueOf(key) {
    const text = String(key || '');
    if (RATIO_VALUE[text]) return RATIO_VALUE[text];
    const hit = text.match(/^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/);
    if (hit) {
      const a = Number(hit[1]);
      const b = Number(hit[2]);
      if (a > 0 && b > 0) return a / b;
    }
    return 16 / 9;
  }

  // 卡片默认按所选比例长成一条，图片 / 视频铺满整张卡片
  function defaultSize(type, params) {
    const preset = presetOf(type);
    if (type === 'audio' || type === 'group' || type === 'schedule') return { w: preset.w, h: preset.h };
    const ratio = ratioValueOf(params && params.ratio);
    return { w: preset.w, h: Math.max(MIN_H, Math.round(preset.w / ratio)) };
  }

  // 视频 / 音频卡片：按下时先记账，拖动超过阈值就把这次点击判为“拖”，
  // 松手后吞掉 click，只播放不位移的原地点击。
  const mediaGuard = { moved: false, startX: 0, startY: 0, el: null };

  function armMediaClickGuard(el, event) {
    mediaGuard.moved = false;
    mediaGuard.el = el;
    mediaGuard.startX = event ? event.clientX : 0;
    mediaGuard.startY = event ? event.clientY : 0;
  }

  function disarmMediaClickGuard() {
    mediaGuard.moved = false;
    mediaGuard.el = null;
  }

  // 全局跟踪：按住媒体后只要移动超过 3px 就算拖动
  window.addEventListener(
    'pointermove',
    (event) => {
      if (!mediaGuard.el) return;
      if (mediaGuard.moved) return;
      const dx = event.clientX - mediaGuard.startX;
      const dy = event.clientY - mediaGuard.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) mediaGuard.moved = true;
    },
    true
  );

  // 松手就收尾：标记只对“这一次按下”有效，不会残留到下一次点击
  window.addEventListener(
    'pointerup',
    () => {
      mediaGuard.el = null;
    },
    true
  );

  // 这些区域有自己的操作，点在上面不算“拖卡片”
  function isControlTarget(target) {
    if (!target || !target.closest) return false;
    return Boolean(
      target.closest('button') ||
        target.closest('select') ||
        target.closest('.port') ||
        target.closest('.resize-handle') ||
        target.closest('.node-prompt') ||
        target.closest('.node-refs') ||
        target.closest('.node-params') ||
        target.closest('.node-actions') ||
        target.closest('.tail-card') ||
        target.closest('.version-strip') ||
        target.closest('.prompt-tail-slot')
    );
  }

  function buildNode(node) {
    const preset = presetOf(node.type);
    const data = nodeData(node);
    const size = sizeOf(node);
    const el = document.createElement('div');
    el.className =
      'node' +
      (node.id === expandedId ? ' expanded' : '') +
      (node.id === expandedId && promptWideOn(node) ? ' wide' : '') +
      (isLocked(node) ? ' is-locked' : '') +
      (isHidden(node) ? ' is-hidden' : '');
    el.dataset.type = node.type;
    el.dataset.id = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.style.width = size.w + 'px';
    el.style.height = size.h + 'px';
    el.style.zIndex = String(zIndexOf(node));
    if (isTaskActive(data)) el.classList.add('is-generating');
    const hostHit = memberSchedule.get(node.id);
    if (hostHit) el.classList.add('sched-member');
    if (hostHit && hostHit.compact) el.classList.add('sched-compact');

    el.appendChild(buildMedia(node, data, preset));
    el.appendChild(buildIndexBadge(node));
    // 组里的卡片右上角挂一个橙色序号，一眼看出排第几
    if (!isSchedule(node)) el.appendChild(buildScheduleOrderBadge(node));
    if (isLocked(node)) {
      const lock = document.createElement('div');
      lock.className = 'node-lock';
      lock.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="4.6" y="10.4" width="14.8" height="9.6" rx="2.2"/><path d="M8.2 10.4V7.6a3.8 3.8 0 017.6 0v2.8"/></svg><span>已锁定</span>';
      lock.title = '这张卡片已锁定：不能拖动、不能修改，但可以当素材连给别人（Ctrl+L 解锁）';
      el.appendChild(lock);
    }
    el.appendChild(buildTitleTag(node, data));
    if (isSchedule(node)) {
      const scrim = document.createElement('div');
      scrim.className = 'schedule-scrim';
      scrim.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        setExpanded(null);
      });
      el.appendChild(scrim);
    }
    el.appendChild(buildPanel(node, data, preset, el));

    // 定时组是「管理器」，不接素材也不送素材，所以没有端口
    if (!isSchedule(node)) {
      const portIn = document.createElement('div');
      portIn.className = 'port in';
      portIn.title = '把别的卡片连到这里';
      const portOut = document.createElement('div');
      portOut.className = 'port out';
      portOut.title = '从这里拖出去连线';
      portOut.addEventListener('pointerdown', (event) => startConnect(event, node));
      el.appendChild(portIn);
      el.appendChild(portOut);
      // 定时组里的卡片大小统一，不给拉伸把手
      if (!memberSchedule.get(node.id)) {
        const handle = document.createElement('div');
        handle.className = 'resize-handle';
        handle.title = '拖动改变卡片大小';
        handle.addEventListener('pointerdown', (event) => startResize(event, node, el));
        el.appendChild(handle);
      }
    }

    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      // 点在视频 / 音频本体上：照样能拖动卡片。真拉开距离时把点击吞掉，
      // 避免松手顺带触发播放控件；原地松开则交给播放器处理。
      if (event.target.closest && event.target.closest('video, audio')) {
        closeMenu();
        if (!selection.has(node.id) || event.shiftKey) selectNode(node.id, event.shiftKey);
        if (!event.shiftKey) setExpanded(node.id);
        armMediaClickGuard(el, event);
        startDrag(event, node);
        return;
      }
      if (isControlTarget(event.target)) {
        // 点在提示词上只做选中，不要顺手把卡片拖走
        if (event.target.closest('.node-prompt')) {
          closeMenu();
          if (!selection.has(node.id) || event.shiftKey) selectNode(node.id, event.shiftKey);
        }
        return;
      }
      closeMenu();
      if (!selection.has(node.id) || event.shiftKey) selectNode(node.id, event.shiftKey);
      startDrag(event, node);
    });

    // 视频 / 音频的原生播放条会把点击吞掉（尤其是音频，整块都是控件），
    // 所以在捕获阶段先接一手：点它就选中并展开，同时不打扰播放控件本身
    // 视频 / 音频卡片的按下处理统一走上面冒泡阶段的逻辑（含拖动），
    // 这里不再重复拦截，避免把拖拽入口挡掉。

    // 视频 / 音频点击守卫：拖动过就吞掉这次落在媒体本身上的 click，
    // 避免刚拖完又触发播放/暂停。只拦媒体元素自身，卡片里的按钮和输入框
    // 不受影响，否则「展开」这类按钮会被误吞。
    el.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!target || !target.closest) return;
        if (!target.closest('video, audio')) return;
        if (!mediaGuard.moved) return;
        mediaGuard.moved = false;
        event.preventDefault();
        event.stopPropagation();
      },
      true
    );

    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selection.has(node.id)) selectNode(node.id, false);
      openNodeMenu(event.clientX, event.clientY);
    });

    // 双击图片 / 视频卡片：在画布上方放大查看；音频和空卡片不响应
    el.addEventListener('dblclick', (event) => {
      // 拖拽会接管指针，双击的落点有时会变成整张卡片；
      // 这里只排除提示词、按钮、端口和缩放手柄，避免编辑时误开放大窗。
      const ignore = event.target.closest && event.target.closest('.node-panel, .node-title-tag, .node-index, .node-rename, .port, .resize-handle, .node-video-bar, .node-audio-bar');
      if (ignore) return;
      if (node.type === 'director') {
        event.preventDefault();
        event.stopPropagation();
        if (isLocked(node)) {
          toast('这张卡片已锁定，先按 Ctrl+L 解锁再打开导演台');
          return;
        }
        openDirectorStage(node);
        return;
      }
      const result = data.result;
      if (!result || !result.url) return;
      const kind = result.kind || preset.media;
      if (kind !== 'image' && kind !== 'video') return;
      event.preventDefault();
      event.stopPropagation();
      openMediaLightbox(node, data, kind);
    });

    return el;
  }

  // 鼠标移上去时在卡片右上角浮出的小提示：告诉人这里可以双击放大
  function buildZoomHint() {
    const hint = document.createElement('div');
    hint.className = 'node-zoom-hint';
    hint.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/><path d="M11 8.2v5.6"/><path d="M8.2 11h5.6"/></svg><span>双击放大</span>';
    return hint;
  }
  // 卡片里显示的是缩略图，双击放大才用原图：地址从 /media/ 换成 /thumb/
  function thumbUrlOf(result) {
    const url = result && result.url ? String(result.url) : '';
    if (url.startsWith('/media/')) return '/thumb/' + url.slice('/media/'.length);
    return '';
  }

  // 缩略图没生成好（老素材 / 少见的格式）：静默回退到原图，卡片不会空着
  function fallbackToOriginal(img, result) {
    const original = result && result.url ? String(result.url) : '';
    if (!original || img.dataset.fallback === '1') return;
    img.dataset.fallback = '1';
    img.src = original;
  }

  // 静默态：卡片本身就是这块媒体，干净、没有边框、没有输入框
  function buildMedia(node, data, preset) {
    const media = document.createElement('div');
    media.className = 'node-media';
    // 定时组：正面显示组名、进度和组里每张视频的缩略图
    if (node.type === 'schedule') {
      media.appendChild(buildScheduleBody(node));
      return media;
    }
    // 组合卡片：一张卡代表一组素材，拉一条线就把整组接过去
    if (node.type === 'group') {
      media.appendChild(buildGroupBody(node));
      media.appendChild(buildStatus(data, node));
      media.appendChild(buildHoverBar(data, preset, node));
      return media;
    }
    // 3D 导演台卡片：正面就是一块场景入口，双击进去
    if (node.type === 'director') {
      media.classList.add('director-card');
      media.appendChild(buildDirectorBody(node, data));
      media.appendChild(buildStatus(data, node));
      media.appendChild(buildHoverBar(data, preset, node));
      return media;
    }
    const result = data.result;
    if (result && result.url) {
      media.classList.add('has-media');
      const kind = result.kind || preset.media;
      if (kind === 'image' || kind === 'video') media.classList.add('zoomable');
      if (kind === 'video') {
        // 视频卡片默认只挂一张封面图：几十张视频同时挂 <video> 会把解码器压满。
        // 点播放（或双击放大）时才真正创建播放器。
        const poster = document.createElement('img');
        poster.className = 'node-video-poster';
        poster.alt = '视频封面';
        poster.draggable = false;
        poster.decoding = 'async';
        const posterUrl = thumbUrlOf(result);
        if (posterUrl) {
          poster.src = posterUrl;
          poster.addEventListener('error', () => fallbackToOriginal(poster, result));
        } else {
          poster.classList.add('no-poster');
        }
        media.appendChild(poster);

        let video = null;
        let videoReady = false;
        const ensureVideo = () => {
          if (video) return video;
          video = document.createElement('video');
          video.src = result.url;
          video.preload = 'metadata';
          video.playsInline = true;
          // 不用浏览器自带的播放条：鼠标移开时它会整块收起，画面会黑闪一下。
          // 换成卡片自己画的播放条，播放器的画面层从头到尾不动。
          video.controls = false;
          video.addEventListener('loadeddata', () => {
            videoReady = true;
            media.classList.add('video-ready');
          });
          media.insertBefore(video, poster);
          return video;
        };

        const bar = document.createElement('div');
        bar.className = 'node-video-bar';
        bar.addEventListener('pointerdown', (event) => event.stopPropagation());
        const play = document.createElement('button');
        play.className = 'video-play';
        play.type = 'button';
        play.textContent = '▶';
        play.title = '播放 / 暂停';
        const track = document.createElement('div');
        track.className = 'video-track';
        track.title = '点一下可以跳到想看的画面';
        const fill = document.createElement('div');
        fill.className = 'video-fill';
        track.appendChild(fill);
        const time = document.createElement('span');
        time.className = 'video-time';
        time.textContent = '0:00';
        bar.appendChild(play);
        bar.appendChild(track);
        bar.appendChild(time);
        media.appendChild(bar);

        const stamp = (value) => {
          if (!Number.isFinite(value) || value <= 0) return '0:00';
          const total = Math.floor(value);
          return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
        };
        play.addEventListener('click', (event) => {
          event.stopPropagation();
          const player = ensureVideo();
          if (player.paused) {
            const played = player.play();
            if (played && played.catch) played.catch(() => {});
          } else {
            player.pause();
          }
        });
        track.addEventListener('click', (event) => {
          event.stopPropagation();
          if (!video || !Number.isFinite(video.duration) || !video.duration) return;
          const rect = track.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
          video.currentTime = ratio * video.duration;
        });
        // 封面还在的时候鼠标移上来，顺手把播放器准备好（只建一个，不重复加载）
        media.addEventListener('pointerenter', () => {
          if (!videoReady) ensureVideo();
        });
        media.addEventListener('play', (event) => {
          if (event.target === video) play.textContent = '❚❚';
        }, true);
        media.addEventListener('pause', (event) => {
          if (event.target === video) play.textContent = '▶';
        }, true);
        media.addEventListener('ended', (event) => {
          if (event.target === video) play.textContent = '▶';
        }, true);
        media.addEventListener('loadedmetadata', (event) => {
          if (event.target === video && video) time.textContent = stamp(video.duration);
        }, true);
        media.addEventListener('timeupdate', (event) => {
          if (event.target !== video || !video) return;
          const total = video.duration || 0;
          fill.style.width = (total ? (video.currentTime / total) * 100 : 0) + '%';
          time.textContent = stamp(video.currentTime) + ' / ' + stamp(total);
        }, true);
        // 播放条只在鼠标移上去时出现；只切卡片的 class，不碰 video 的控件
        media.addEventListener('pointerenter', () => media.classList.add('video-open'));
        media.addEventListener('pointerleave', () => media.classList.remove('video-open'));
      } else if (kind === 'audio') {
        // 音频没有画面：静默态只留一个音符，鼠标移上来才换成自绘的播放条
        media.classList.add('audio');
        const badge = document.createElement('div');
        badge.className = 'node-audio-badge';
        badge.textContent = '♪';

        const audio = document.createElement('audio');
        audio.src = result.url;
        audio.preload = 'metadata';
        audio.controls = false;

        const bar = document.createElement('div');
        bar.className = 'node-audio-bar';
        bar.addEventListener('pointerdown', (event) => event.stopPropagation());
        const play = document.createElement('button');
        play.className = 'audio-play';
        play.type = 'button';
        play.textContent = '▶';
        play.title = '播放 / 暂停';
        const track = document.createElement('div');
        track.className = 'audio-track';
        track.title = '点一下可以跳到想听的位置';
        const fill = document.createElement('div');
        fill.className = 'audio-fill';
        track.appendChild(fill);
        const time = document.createElement('span');
        time.className = 'audio-time';
        time.textContent = '0:00';
        bar.appendChild(play);
        bar.appendChild(track);
        bar.appendChild(time);

        const stamp = (value) => {
          if (!Number.isFinite(value) || value <= 0) return '0:00';
          const total = Math.floor(value);
          return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
        };

        play.addEventListener('click', (event) => {
          event.stopPropagation();
          if (audio.paused) audio.play();
          else audio.pause();
        });
        track.addEventListener('click', (event) => {
          event.stopPropagation();
          if (!Number.isFinite(audio.duration) || !audio.duration) return;
          const rect = track.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
          audio.currentTime = ratio * audio.duration;
        });
        audio.addEventListener('play', () => { play.textContent = '❚❚'; });
        audio.addEventListener('pause', () => { play.textContent = '▶'; });
        audio.addEventListener('ended', () => { play.textContent = '▶'; });
        audio.addEventListener('loadedmetadata', () => { time.textContent = stamp(audio.duration); });
        audio.addEventListener('timeupdate', () => {
          const total = audio.duration || 0;
          fill.style.width = (total ? (audio.currentTime / total) * 100 : 0) + '%';
          time.textContent = stamp(audio.currentTime) + ' / ' + stamp(total);
        });

        media.appendChild(badge);
        media.appendChild(bar);
        media.appendChild(audio);
        media.addEventListener('pointerenter', () => media.classList.add('audio-open'));
        media.addEventListener('pointerleave', () => media.classList.remove('audio-open'));
      } else {
        const img = document.createElement('img');
        const thumbUrl = thumbUrlOf(result);
        img.alt = '生成结果';
        img.draggable = false;
        img.decoding = 'async';
        img.loading = 'lazy';
        if (thumbUrl) {
          img.src = thumbUrl;
          img.addEventListener('error', () => fallbackToOriginal(img, result));
        } else {
          img.src = result.url;
        }
        img.addEventListener('load', () => {
          if (img.naturalWidth && img.naturalHeight) {
            fitNodeToAspect(node, img.naturalWidth / img.naturalHeight);
          }
        });
        media.appendChild(img);
      }
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'node-placeholder';
      placeholder.textContent = preset.empty;
      media.appendChild(placeholder);
    }
    if (media.classList.contains('zoomable')) media.appendChild(buildZoomHint());
    media.appendChild(buildStatus(data, node));
    media.appendChild(buildHoverBar(data, preset));
    return media;
  }

  // ---------- 3D 导演台：卡片是入口，双击进去摆位、记机位、出图 ----------
  function directorSceneOf(data) {
    if (!data.scene || typeof data.scene !== 'object') {
      data.scene = {
        objects: [],
        camera: { pos: [0, 2.6, 9.6], target: [0, 1.7, 0], fov: 35 },
        keyframes: [],
        duration: 8,
        aspect: '16:9',
      };
    }
    return data.scene;
  }

  function buildDirectorBody(node, data) {
    const wrap = document.createElement('div');
    wrap.className = 'director-body';
    const scene = directorSceneOf(data);
    const objects = Array.isArray(scene.objects) ? scene.objects.length : 0;
    const keys = Array.isArray(scene.keyframes) ? scene.keyframes.length : 0;
    const poster = String(data.poster || '').trim();

    if (poster) {
      const img = document.createElement('img');
      img.className = 'director-poster';
      img.src = poster;
      img.alt = '导演台最近一次出图';
      img.draggable = false;
      wrap.appendChild(img);
      wrap.classList.add('has-poster');
    } else {
      const art = document.createElement('div');
      art.className = 'director-art';
      art.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z"/><path d="M12 12.2l8-4.4"/><path d="M12 12.2V21"/><path d="M12 12.2L4 7.8"/></svg>';
      wrap.appendChild(art);
    }

    const overlay = document.createElement('div');
    overlay.className = 'director-overlay';
    const head = document.createElement('div');
    head.className = 'director-head';
    head.appendChild(document.createTextNode('3D 导演台'));
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'director-open';
    open.textContent = '打开';
    open.title = '打开导演台（也可以直接双击这张卡片）';
    if (isLocked(node)) {
      open.disabled = true;
      open.title = '卡片已锁定，先解锁再打开导演台';
    }
    open.addEventListener('pointerdown', (event) => event.stopPropagation());
    open.addEventListener('click', (event) => {
      event.stopPropagation();
      openDirectorStage(node);
    });
    head.appendChild(open);
    overlay.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'director-meta';
    meta.textContent =
      (objects ? objects + ' 个物件' : '空场景') +
      '　·　' +
      (keys ? keys + ' 个机位' : '还没记机位') +
      '　·　' +
      String(scene.aspect || '16:9');
    overlay.appendChild(meta);
    wrap.appendChild(overlay);
    return wrap;
  }

  function buildDirectorPanel(node, data) {
    const box = document.createElement('div');
    box.className = 'director-panel';
    const hint = document.createElement('div');
    hint.className = 'director-panel-hint';
    hint.textContent = '在导演台里摆好素材和机位，点「拍一张」出的图会自动连回这张卡片。';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'primary';
    open.textContent = '打开导演台';
    open.addEventListener('pointerdown', (event) => event.stopPropagation());
    open.addEventListener('click', (event) => {
      event.stopPropagation();
      openDirectorStage(node);
    });
    box.appendChild(hint);
    box.appendChild(open);
    return box;
  }

  // 画布上能进导演台的素材：已经有结果的图片 / 视频
  function directorMaterials() {
    const list = [];
    nodes.forEach((item) => {
      if (item.type !== 'image' && item.type !== 'video') return;
      const data = item.data || {};
      const result = data.result || {};
      if (!result.url) return;
      const title = String(data.title || '').trim();
      const text = displayText(data.text || '').trim();
      list.push({
        url: result.url,
        kind: item.type,
        name: title || text.slice(0, 24) || tagOf(item) || presetOf(item.type).label,
        width: Number(result.width) || 0,
        height: Number(result.height) || 0,
      });
    });
    return list;
  }

  function openDirectorStage(node, center) {
    if (!window.CanvasDirector) {
      toast('3D 引擎还在加载，稍等一下再打开');
      return;
    }
    let target = node;
    if (!target) {
      target = addNode('director', center);
      const created = nodeData(target);
      created.title = '3D 导演台';
      directorSceneOf(created);
      refreshNode(target);
    }
    const data = nodeData(target);
    const scene = directorSceneOf(data);
    window.CanvasDirector.open({
      api: window.api,
      canvasId: canvasId,
      title: String(data.title || '3D 导演台'),
      scene: scene,
      toast: toast,
      getMaterials: directorMaterials,
      onChange: (next) => {
        data.scene = next;
        scheduleSave();
      },
      onInsert: (payload) => insertDirectorShot(target, payload),
    });
  }

  // 导演台出图：建一张结果卡，再自动连回导演台卡片
  function insertDirectorShot(directorNode, payload) {
    if (!directorNode || !payload || !payload.asset) return null;
    const asset = payload.asset;
    const kind = payload.kind === 'video' ? 'video' : 'image';
    const index = Math.max(0, Number(payload.index) || 0);
    const width = Number(payload.width) || 0;
    const height = Number(payload.height) || 0;
    const presetSize = defaultSize(kind, PARAM_DEFAULTS[kind]);
    const gapX = Math.max(60, directorNode.w * 0.12);
    const gapY = 32;
    const at = {
      x: directorNode.x + directorNode.w + gapX,
      y: directorNode.y + index * (presetSize.h + gapY),
    };
    const created = addAssetCard(
      {
        url: asset.url,
        relPath: asset.relPath,
        kind: kind,
        name: asset.name,
        width: width,
        height: height,
      },
      at,
      payload.label || '导演台',
      { compact: false, collapsed: false }
    );
    const data = nodeData(created);
    data.title = String(payload.label || '导演台').trim();
    data.text = data.title;
    if (kind === 'image' && !payload.index) {
      const directorData = nodeData(directorNode);
      directorData.poster = asset.url;
      refreshNode(directorNode);
    }
    refreshNode(created);
    addEdge(created.id, directorNode.id);
    selection.clear();
    selection.add(created.id);
    refreshSelection();
    scheduleSave();
    return created;
  }

  // 生成中 / 生成失败直接盖在卡片中间
  // 只造骨架 + 交给 paintStatusBox 填内容：状态栏的文案 / 结构只有一处定义，
  // 免得「首次渲染」和「后续刷新」两条路各写一遍、慢慢长歪。
  function buildStatus(data, node) {
    const box = document.createElement('div');
    box.className = 'node-status show ' + (statusKindOf(data) || 'error');
    return paintStatusBox(box, data, node) || box;
  }

  // 鼠标移上去才浮出的窄条：显示模型和提示词开头
  function buildHoverBar(data, preset, node) {
    const bar = document.createElement('div');
    bar.className = 'node-hoverbar';
    bar.textContent = hoverTextOf(data, preset, node);
    return bar;
  }

  function hoverTextOf(data, preset, node) {
    // 组合看的是组名和组里有几样素材
    if (node && node.type === 'group') {
      const count = groupMembersOf(node).length;
      const name = String(data.text || '').trim();
      return (name ? name + '　·　' : '') + (count ? count + ' 个素材' : '空组合');
    }
    const parts = [];
    if (node && tagOf(node)) parts.push(tagOf(node));
    if (node && node.type === 'quick') {
      const picked = quickPickedOf(node);
      if (!tagOf(node)) parts.push('快速视频');
      if (picked.length) parts.push('@' + picked.length + ' 个素材');
    }
    if (String(data.title || '').trim()) parts.push(String(data.title).trim());
    if (data.model) parts.push(data.model);
    const text = displayText(data.text).trim().replace(/\s+/g, ' ');
    if (text) parts.push(text.slice(0, 42));
    return parts.join('　·　') || preset.label;
  }

  // 提示词改完，顺手把鼠标悬停时那条窄条上的文字也刷新一下
  function refreshHoverBar(node) {
    const el = elements.get(node.id);
    if (!el) return;
    const bar = el.querySelector('.node-hoverbar');
    if (!bar) return;
    bar.textContent = hoverTextOf(nodeData(node), presetOf(node.type), node);
  }

  // ---------- 双击图片 / 视频：在画布上方放大查看 ----------
  let lightboxEl = null;
  let lightboxVideo = null;

  function dimensionText(width, height) {
    const w = Math.round(Number(width) || 0);
    const h = Math.round(Number(height) || 0);
    return w > 0 && h > 0 ? w + ' × ' + h : '';
  }

  function mediaNameOf(data, node) {
    const custom = String((data && data.title) || '').trim();
    if (custom) return custom;
    const result = (data && data.result) || {};
    const raw = String(result.file || result.url || '').split('?')[0];
    const base = raw.split(/[\\/]/).pop();
    if (base) {
      try {
        return decodeURIComponent(base);
      } catch (err) {
        return base;
      }
    }
    return node && node.type === 'video' ? '视频' : '图片';
  }

  function closeMediaLightbox() {
    if (!lightboxEl) return;
    const mask = lightboxEl;
    lightboxEl = null;
    if (lightboxVideo) {
      try {
        lightboxVideo.pause();
      } catch (err) {}
      lightboxVideo.removeAttribute('src');
      try {
        lightboxVideo.load();
      } catch (err) {}
      lightboxVideo = null;
    }
    mask.classList.remove('open');
    // 每个放大窗自己收尾，快速连着开关也不会把新窗口误删
    setTimeout(() => mask.remove(), 220);
  }

  function openMediaLightbox(node, data, kind) {
    closeMediaLightbox();
    const result = (data && data.result) || {};
    if (!result.url || (kind !== 'image' && kind !== 'video')) return;
    // 卡片里正在播放的视频先停下来，别和放大窗里的声音叠在一起
    const card = elements.get(node.id);
    const inlineVideo = card && card.querySelector('video');
    if (inlineVideo) {
      try {
        inlineVideo.pause();
      } catch (err) {}
    }

    const mask = document.createElement('div');
    mask.className = 'media-lightbox';
    mask.setAttribute('role', 'dialog');
    mask.setAttribute('aria-modal', 'true');
    mask.setAttribute('aria-label', '放大查看素材');

    const stage = document.createElement('div');
    stage.className = 'media-lightbox-stage';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'media-lightbox-close';
    close.title = '关闭（Esc）';
    close.setAttribute('aria-label', '关闭');
    close.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';

    const body = document.createElement('div');
    body.className = 'media-lightbox-media';

    const meta = document.createElement('div');
    meta.className = 'media-lightbox-meta';

    const updateMeta = () => {
      const media = body.querySelector('img, video');
      const w = media && (media.naturalWidth || media.videoWidth);
      const h = media && (media.naturalHeight || media.videoHeight);
      const dim = dimensionText(w || result.width, h || result.height);
      const kindLabel = kind === 'video' ? '视频' : '图片';
      meta.textContent = dim ? kindLabel + '　·　' + dim : kindLabel;
    };

    if (kind === 'video') {
      const video = document.createElement('video');
      video.className = 'media-lightbox-video';
      video.src = result.url;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'auto';
      body.appendChild(video);
      lightboxVideo = video;
      video.addEventListener('loadedmetadata', updateMeta);
      const playing = video.play();
      if (playing && typeof playing.catch === 'function') playing.catch(() => {});
    } else {
      const img = document.createElement('img');
      img.className = 'media-lightbox-image';
      img.src = result.url;
      img.alt = mediaNameOf(data, node);
      img.draggable = false;
      body.appendChild(img);
      img.addEventListener('load', updateMeta);
    }

    const caption = document.createElement('div');
    caption.className = 'media-lightbox-caption';
    const name = document.createElement('div');
    name.className = 'media-lightbox-name';
    name.textContent = mediaNameOf(data, node);
    const hint = document.createElement('div');
    hint.className = 'media-lightbox-hint';
    hint.textContent = '点击空白处或按 Esc 关闭';
    caption.appendChild(name);
    caption.appendChild(meta);
    caption.appendChild(hint);

    stage.appendChild(close);
    stage.appendChild(body);
    stage.appendChild(caption);
    mask.appendChild(stage);
    updateMeta();

    mask.addEventListener('click', (event) => {
      if (event.target.closest && event.target.closest('.media-lightbox-stage')) return;
      closeMediaLightbox();
    });
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMediaLightbox();
    });

    document.body.appendChild(mask);
    lightboxEl = mask;
    requestAnimationFrame(() => {
      if (lightboxEl === mask) mask.classList.add('open');
    });
  }

  // Esc 先关放大窗：用捕获阶段拦住，画布自己的快捷键不会跟着响应
  document.addEventListener(
    'keydown',
    (event) => {
      if (!lightboxEl || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeMediaLightbox();
    },
    true
  );
  // 原地改标题 / 备注的小输入框：贴在卡片左上角，回车保存、Esc 放弃
  let renameEl = null;

  function closeRename() {
    if (!renameEl) return;
    // 先把引用清掉再摘元素：摘下去会立刻触发 blur，别让它把想放弃的内容存进去
    const dying = renameEl;
    renameEl = null;
    dying.remove();
  }

  // 画布正上方的名字：显示当前画布名，点一下就地改名
  function setCanvasName(name) {
    const value = String(name || '').trim() || '未命名画布';
    nameEl.textContent = value;
    if (titleTextEl) titleTextEl.textContent = value;
    document.title = value + ' · 本地无限画布';
  }

  let titleEditing = false;

  function finishTitleRename(save) {
    if (!titleEditing || !titleInputEl) return;
    titleEditing = false;
    const raw = String(titleInputEl.value || '').trim();
    titleInputEl.hidden = true;
    if (titleBtnEl) titleBtnEl.hidden = false;
    if (titleWrapEl) titleWrapEl.classList.remove('editing');
    if (!save || !raw || raw === nameEl.textContent) {
      titleInputEl.value = nameEl.textContent;
      return;
    }
    window.api
      .renameCanvas(canvasId, raw)
      .then((result) => {
        setCanvasName(result.canvas.name);
        toast('画布名字已改成：' + result.canvas.name);
      })
      .catch((error) => {
        toast('改名失败：' + error.message);
      });
  }

  function startTitleRename() {
    if (!titleInputEl || !titleBtnEl || titleEditing) return;
    titleEditing = true;
    titleInputEl.value = nameEl.textContent;
    titleBtnEl.hidden = true;
    titleInputEl.hidden = false;
    if (titleWrapEl) titleWrapEl.classList.add('editing');
    titleInputEl.focus({ preventScroll: true });
    titleInputEl.select();
  }

  function startRename(node, field) {
    closeRename();
    const data = nodeData(node);
    const el = elements.get(node.id);
    if (!el) return;
    const wrap = document.createElement('div');
    wrap.className = 'node-rename';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'node-rename-input';
    input.value = String(data.title || '');
    input.placeholder = '标题：例如 开头大景';
    input.maxLength = 60;
    wrap.appendChild(input);
    el.appendChild(wrap);
    renameEl = wrap;
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRename();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        commitRename(node, field, input.value);
      }
    });
    input.addEventListener('blur', () => {
      // 失焦就存下来，少一步确认
      if (!renameEl) return;
      commitRename(node, field, input.value);
    });
    input.focus({ preventScroll: true });
    input.select();
  }

  function commitRename(node, field, value) {
    if (!renameEl) return;
    const data = nodeData(node);
    const next = String(value || '').replace(/\s+$/, '');
    const prev = data.title;
    closeRename();
    if (next === prev) return;
    pushHistory();
    data.title = next;
    refreshNode(node);
    scheduleSave();
    toast(next ? '标题已改成「' + next + '」' : '标题已清空');
  }

  // 卡片左上角的标题小标签：没写标题就不占地方；点了能改
  function buildTitleTag(node, data) {
    const tag = document.createElement('div');
    const text = String(data.title || '').trim();
    // 组合卡片身上已经写着组名了，不再重复挂一个标题
    tag.className = 'node-title-tag' + (node.type === 'group' || node.type === 'schedule' ? ' none' : text ? '' : ' empty');
    if (node.type === 'group' || node.type === 'schedule') return tag;
    tag.textContent = text || '＋ 标题';
    tag.title = text ? '点一下改标题' : '点一下给这张卡片起个名字';
    tag.addEventListener('pointerdown', (event) => event.stopPropagation());
    tag.addEventListener('click', (event) => {
      event.stopPropagation();
      if (isLocked(node)) {
        toast('这张卡片已锁定，先按 Ctrl+L 解锁才能改标题');
        return;
      }
      startRename(node, 'title');
    });
    return tag;
  }

  // 卡片外侧上方的编号徽章：图1 / 视频2 / 音频1，永远显示，方便一眼认出是哪张
  function buildIndexBadge(node) {
    const badge = document.createElement('div');
    const tag = tagOf(node);
    badge.className = 'node-index' + (tag ? '' : ' none');
    if (!tag) return badge;
    badge.dataset.kind = numberKindOf(node);
    badge.textContent = tag;
    const title = String((node.data && node.data.title) || '').trim();
    badge.title = tag + (title ? '　' + title : '') + '（这张素材现在的序号，删掉前面的卡片会自动往前挪）';
    badge.addEventListener('pointerdown', (event) => event.stopPropagation());
    badge.addEventListener('click', (event) => event.stopPropagation());
    return badge;
  }

  // 只改序号牌上的字：删掉一张卡片后后面的号往前挪，
  // 不重建卡片本体，图片 / 视频不会跟着重新加载闪一下
  function paintIndexBadge(node) {
    const el = elements.get(node.id);
    if (!el) return;
    const badge = el.querySelector('.node-index');
    if (!badge) return;
    const tag = tagOf(node);
    badge.classList.toggle('none', !tag);
    if (!tag) {
      badge.textContent = '';
      badge.title = '';
      return;
    }
    badge.dataset.kind = numberKindOf(node);
    badge.textContent = tag;
    const title = String((node.data && node.data.title) || '').trim();
    badge.title = tag + (title ? '　' + title : '') + '（这张素材现在的序号，删掉前面的卡片会自动往前挪）';
  }

  // ---------- 尾部提示词：卡片上的开关和预设选择 ----------
  // 卡片只记「用哪一套」，正文仍在设置里；这样改一套预设，所有引用它的卡片一起生效。
  function tailSignature(node) {
    const cfg = tailConfig();
    const choice = cardTailChoice(node);
    return JSON.stringify({
      on: cfg.enabled,
      def: cfg.defaultId,
      presets: cfg.presets.map((one) => [one && one.id, one && one.name, one && String(one.text || '').length]),
      choice: choice,
      locked: isLocked(node),
    });
  }

  function tailHintText(node, choice) {
    const cfg = tailConfig();
    if (!cfg.enabled) return '尾部提示词总开关已关闭：所有卡片暂时都不追加，打开总开关后这张卡片的设置会自动恢复。';
    if (!cfg.presets.length) return '还没有尾部提示词预设，点「管理预设」先写一套常用风格。';
    if (!choice.enabled) return '这张卡片不会追加尾部提示词。勾上左边的开关即可启用。';
    const preset = tailPresetForChoice(choice);
    if (choice.presetId && !preset) return '这张卡片原来引用的预设已经删除了，请重新选一套。';
    if (!preset) return '当前没有默认预设，请在下拉框里选一套，或者到「管理预设」里把常用的一套设为默认。';
    if (!String(preset.text || '').trim()) return '「' + tailPresetName(preset) + '」还没有正文，提交时不会追加。';
    return '本次提交会追加「' + tailPresetName(preset) + '」 · ' + String(preset.text).trim().length + ' 字' + (choice.presetId ? '' : '（跟随全局默认）');
  }

  function buildTailCardBlock(node, data) {
    const cfg = tailConfig();
    const choice = cardTailChoice(node);
    const wrap = document.createElement('div');
    wrap.className = 'tail-card';
    wrap.addEventListener('pointerdown', (event) => event.stopPropagation());

    const head = document.createElement('div');
    head.className = 'tail-card-head';
    const label = document.createElement('label');
    label.className = 'tail-card-switch';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = choice.enabled;
    check.disabled = isLocked(node) || !cfg.presets.length;
    check.title = isLocked(node) ? '卡片已锁定，先解锁再改' : '这张卡片提交时要不要追加尾部提示词';
    const name = document.createElement('span');
    name.textContent = '尾部提示词';
    label.appendChild(check);
    label.appendChild(name);
    head.appendChild(label);

    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'tail-card-manage';
    manage.textContent = '管理预设';
    manage.title = '打开预设面板，新增、修改或删除尾部提示词';
    manage.addEventListener('click', (event) => {
      event.stopPropagation();
      if (window.UITheme) window.UITheme.openTailPromptsPanel();
    });
    head.appendChild(manage);
    wrap.appendChild(head);

    const row = document.createElement('div');
    row.className = 'tail-card-row';
    const select = document.createElement('select');
    select.className = 'tail-card-select';
    select.title = '这张卡片用哪一套尾部提示词';
    select.disabled = isLocked(node);
    const addOption = (value, text, picked) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      if (picked) opt.selected = true;
      select.appendChild(opt);
    };
    const defPreset = tailPresetById(cfg.defaultId);
    addOption('', '跟随全局默认' + (defPreset ? '（' + tailPresetName(defPreset) + '）' : cfg.defaultId ? '（原默认已删除）' : '（未设置）'), !choice.presetId);
    if (choice.presetId && !tailPresetById(choice.presetId)) {
      addOption(choice.presetId, '原预设已删除，请重新选择', true);
    }
    cfg.presets.forEach((preset) => {
      if (!preset || !preset.id) return;
      addOption(String(preset.id), tailPresetName(preset), String(choice.presetId) === String(preset.id));
    });
    select.addEventListener('pointerdown', (event) => event.stopPropagation());
    select.addEventListener('change', () => {
      if (isLocked(node)) return;
      pushHistory();
      data.tailPrompt = { enabled: choice.enabled, presetId: select.value };
      scheduleSave();
      refreshNode(node);
    });
    row.appendChild(select);
    wrap.appendChild(row);

    check.addEventListener('change', () => {
      if (isLocked(node)) return;
      pushHistory();
      let presetId = choice.presetId;
      if (check.checked && !presetId && !cfg.defaultId && cfg.presets.length) presetId = String(cfg.presets[0].id || '');
      data.tailPrompt = { enabled: check.checked, presetId: presetId };
      scheduleSave();
      refreshNode(node);
    });

    const hint = document.createElement('div');
    hint.className = 'tail-card-hint';
    hint.textContent = tailHintText(node, choice);
    wrap.appendChild(hint);
    return wrap;
  }

  // ---------- 生成版本历史：同一张卡片保留最近 20 次结果 ----------
  const CARD_HISTORY_LIMIT = 20;

  function versionEntryId() {
    return 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function cleanVersionResult(result) {
    if (!result || !result.url) return null;
    return {
      url: String(result.url),
      file: String(result.file || ''),
      kind: String(result.kind || 'image'),
      width: Number(result.width) || 0,
      height: Number(result.height) || 0,
      model: String(result.model || ''),
      at: Number(result.at) || Date.now(),
    };
  }

  function submissionMetaOf(source, fallback) {
    const raw = source && typeof source === 'object' ? source : {};
    const base = fallback && typeof fallback === 'object' ? fallback : {};
    const refs = Array.isArray(raw.refs) ? raw.refs : Array.isArray(base.refs) ? base.refs : [];
    return {
      mainPrompt: String(raw.mainPrompt || base.mainPrompt || ''),
      submittedPrompt: String(raw.submittedPrompt || raw.apiPrompt || base.submittedPrompt || ''),
      tailPresetId: String(raw.tailPresetId || base.tailPresetId || ''),
      tailPresetName: String(raw.tailPresetName || base.tailPresetName || ''),
      tailText: String(raw.tailText || base.tailText || ''),
      tailAppended: Boolean(raw.tailAppended || base.tailAppended),
      model: String(raw.model || base.model || ''),
      // 本次提交冻结的参考素材清单（只留名字/类型/角色/地址，不含字节）
      refs: refs.map((item) => ({
        name: String((item && item.name) || ''),
        kind: String((item && item.kind) || ''),
        role: String((item && item.role) || ''),
        src: String((item && (item.src || item.url)) || ''),
      })),
      refCount: Number.isFinite(Number(raw.refCount))
        ? Number(raw.refCount)
        : refs.length || Number(base.refCount) || 0,
      params: raw.params && typeof raw.params === 'object' ? raw.params : base.params && typeof base.params === 'object' ? base.params : {},
      at: Number(raw.at) || Number(base.at) || Date.now(),
    };
  }

  function currentSubmissionMeta(data) {
    return submissionMetaOf(data && (data.pendingSubmission || data.lastSubmission), {
      mainPrompt: data && data.text,
      model: data && data.model,
    });
  }

  function pushCardHistory(history, result, meta) {
    const clean = cleanVersionResult(result);
    const list = Array.isArray(history) ? history.slice() : [];
    if (!clean) return list;
    const withoutSame = list.filter((one) => !(one && one.result && String(one.result.url) === clean.url));
    withoutSame.unshift({
      id: versionEntryId(),
      result: clean,
      mainPrompt: String((meta && meta.mainPrompt) || ''),
      submittedPrompt: String((meta && meta.submittedPrompt) || ''),
      tailPresetId: String((meta && meta.tailPresetId) || ''),
      tailPresetName: String((meta && meta.tailPresetName) || ''),
      tailText: String((meta && meta.tailText) || ''),
      model: String((meta && meta.model) || clean.model || ''),
      params: meta && meta.params && typeof meta.params === 'object' ? meta.params : {},
      at: Number((meta && meta.at) || clean.at) || Date.now(),
    });
    return withoutSame.slice(0, CARD_HISTORY_LIMIT);
  }

  function versionEntriesOf(data) {
    const out = [];
    const seen = new Set();
    const add = (entry) => {
      if (!entry || !entry.result || !entry.result.url) return;
      const clean = cleanVersionResult(entry.result);
      if (!clean || seen.has(clean.url)) return;
      seen.add(clean.url);
      out.push({
        id: String(entry.id || versionEntryId()),
        result: clean,
        mainPrompt: String(entry.mainPrompt || ''),
        submittedPrompt: String(entry.submittedPrompt || ''),
        tailPresetId: String(entry.tailPresetId || ''),
        tailPresetName: String(entry.tailPresetName || ''),
        tailText: String(entry.tailText || ''),
        model: String(entry.model || clean.model || ''),
        params: entry.params && typeof entry.params === 'object' ? entry.params : {},
        at: Number(entry.at || clean.at) || 0,
      });
    };
    if (data.result && data.result.url) {
      const meta = currentSubmissionMeta(data);
      add(Object.assign({ id: 'current' }, meta, { result: data.result, at: data.result.at || meta.at }));
    }
    (Array.isArray(data.history) ? data.history : []).forEach(add);
    return out.slice(0, CARD_HISTORY_LIMIT);
  }

  // 照这一版参数改回去：参数、模型、尾部提示词都回到那一版的样子。
  // 不动结果文件本身 —— 换结果是「切换版本」的事，这里只管下次生成用什么。
  function applyVersionParams(node, entry) {
    const data = nodeData(node);
    const want = cardParamsFromEntry(entry, node);
    const defs = paramDefsOf(node, nodeData(node));
    // 先把「要改什么」算清楚，一处数据都不动。因为 pushHistory 拍的是改动前的样子，
    // 得先知道确实有改动才去拍 —— 否则参数本来就一样时也会往撤销栈里压一条与当前
    // 完全相同的快照，用户按「撤销」会看着像没反应（其实只是退到了同一个状态）。
    const plan = [];
    defs.forEach((def) => {
      if (!(def.key in want)) return;
      const before = String(data.params[def.key] == null ? '' : data.params[def.key]);
      if (before === want[def.key]) return;
      plan.push({ key: def.key, value: want[def.key], label: def.label + ' ' + paramText(def, want[def.key]) });
    });
    const entryModel = String((entry && entry.model) || '');
    const modelNext = entryModel && entryModel !== String(data.model || '') ? entryModel : '';
    // 尾部提示词：那一版用的预设若还在，就一起换过去（预设被删了就保留现在的，不乱清）
    const tailPresetId = String((entry && entry.tailPresetId) || '');
    const tailNext =
      supportsTail(node) && tailPresetId && tailPresetById(tailPresetId) &&
      String((data.tailPrompt && data.tailPrompt.presetId) || '') !== tailPresetId
        ? tailPresetId
        : '';
    const changed = plan.map((one) => one.label);
    if (modelNext) changed.push('模型 ' + modelNext);
    if (tailNext) changed.push('尾部提示词 ' + (String((entry && entry.tailPresetName) || '').trim() || tailNext));

    if (!changed.length) {
      toast('这一版的参数跟现在的完全一样，没什么要改的');
      return 0;
    }
    pushHistory();
    plan.forEach((one) => {
      data.params[one.key] = one.value;
    });
    if (modelNext) data.model = modelNext;
    if (tailNext) data.tailPrompt = { enabled: true, presetId: tailNext };
    normalizeParams(node);
    refreshNode(node);
    scheduleSave();
    return changed;
  }

  // 生成来源视图：把这张卡片「每次生成用了什么」摊开成时间线。
  // 数据早就在 data.history 里了（最近 20 版），缺的只是一个看得见的地方。
  function openVersionPanel(node) {
    const data = nodeData(node);
    const entries = versionEntriesOf(data);
    if (!entries.length) {
      toast('这张卡片还没有生成过，没有可看的来源');
      return;
    }
    const currentUrl = data.result && data.result.url ? String(data.result.url) : '';

    const mask = document.createElement('div');
    mask.className = 'modal-mask version-mask';
    const dialog = document.createElement('div');
    dialog.className = 'modal modal-version';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '生成来源');

    const head = document.createElement('div');
    head.className = 'modal-head';
    const title = document.createElement('b');
    title.textContent = '生成来源';
    head.appendChild(title);
    const headNote = document.createElement('span');
    headNote.className = 'muted-line version-head-note';
    headNote.textContent = locateLabelOf(node) + ' · 共 ' + entries.length + ' 版';
    head.appendChild(headNote);
    const grow = document.createElement('span');
    grow.className = 'grow';
    head.appendChild(grow);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ghost';
    closeBtn.type = 'button';
    closeBtn.textContent = '关闭';
    head.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body version-body';

    if (entries.length === 1) {
      const only = document.createElement('div');
      only.className = 'version-empty';
      only.textContent = '只生成过一版。再生成几次，这里就会按时间列出每一版用了什么。';
      body.appendChild(only);
    }

    const diffNote = document.createElement('span');
    diffNote.className = 'muted-line version-diff-note';
    diffNote.textContent = '';

    const repaint = () => {
      const list = document.createElement('div');
      list.className = 'version-timeline';
      const now = versionEntriesOf(nodeData(node));
      const shownCurrent = nodeData(node).result && nodeData(node).result.url ? String(nodeData(node).result.url) : '';
      let differs = 0;
      now.forEach((entry, index) => {
        const isCurrent = String(entry.result.url) === shownCurrent;
        const row = document.createElement('div');
        row.className = 'version-row' + (isCurrent ? ' current' : '');

        // 时间线左边那一列：圆点 + 竖线
        const rail = document.createElement('div');
        rail.className = 'version-rail';
        const dot = document.createElement('span');
        dot.className = 'version-dot';
        rail.appendChild(dot);
        if (index < now.length - 1) {
          const line = document.createElement('span');
          line.className = 'version-line';
          rail.appendChild(line);
        }
        row.appendChild(rail);

        const card = document.createElement('div');
        card.className = 'version-card';

        const thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.className = 'version-thumb';
        thumb.appendChild(versionMediaThumb(entry));
        thumb.title = isCurrent ? '这是卡片上正在显示的这一版' : '点一下，把卡片切到这一版';
        thumb.addEventListener('click', () => {
          switchCardVersion(node, entry.result.url);
          repaint();
        });
        card.appendChild(thumb);

        const info = document.createElement('div');
        info.className = 'version-info';

        const topLine = document.createElement('div');
        topLine.className = 'version-top';
        const when = document.createElement('b');
        when.className = 'version-when';
        when.textContent = timeTextOf(entry.at) || '时间不详';
        topLine.appendChild(when);
        if (isCurrent) {
          const nowTag = document.createElement('span');
          nowTag.className = 'version-tag-now';
          nowTag.textContent = '当前显示';
          topLine.appendChild(nowTag);
        }
        if (index === 0 && !isCurrent) {
          const latestTag = document.createElement('span');
          latestTag.className = 'version-tag-latest';
          latestTag.textContent = '最近一版';
          topLine.appendChild(latestTag);
        }
        info.appendChild(topLine);

        const summary = versionSummaryOf(entry, node);
        const summaryLine = document.createElement('div');
        summaryLine.className = 'version-summary';
        summaryLine.textContent = summary.length ? summary.join(' · ') : '这一版没有留下参数记录';
        info.appendChild(summaryLine);

        const prompt = String(entry.submittedPrompt || entry.mainPrompt || '').trim();
        if (prompt) {
          const promptLine = document.createElement('div');
          promptLine.className = 'version-prompt';
          promptLine.textContent = prompt;
          promptLine.title = prompt;
          info.appendChild(promptLine);
        }

        const actions = document.createElement('div');
        actions.className = 'version-actions';
        if (!isCurrent) {
          const useBtn = document.createElement('button');
          useBtn.type = 'button';
          useBtn.className = 'ghost';
          useBtn.textContent = '切到这一版';
          useBtn.title = '把卡片上显示的结果换成这一版（旧文件都保留）';
          useBtn.addEventListener('click', () => {
            switchCardVersion(node, entry.result.url);
            repaint();
          });
          actions.appendChild(useBtn);
        } else {
          const nowText = document.createElement('span');
          nowText.className = 'muted-line';
          nowText.textContent = '现在用的就是这一版';
          actions.appendChild(nowText);
        }
        if (versionParamsDiffer(entry, node)) {
          differs += 1;
          const backBtn = document.createElement('button');
          backBtn.type = 'button';
          backBtn.className = 'ghost';
          backBtn.textContent = '照这版参数改回来';
          backBtn.title = '把模型 / 参数 / 尾部提示词改回这一版的样子（下次生成用它），不改已生成的结果';
          backBtn.addEventListener('click', () => {
            const changed = applyVersionParams(node, entry);
            if (changed && changed.length) {
              repaint();
              toast('已改回这一版的设置：' + changed.join('、'), 6000, [{ label: '撤销', run: () => undo() }]);
            }
          });
          actions.appendChild(backBtn);
        }
        if (actions.childNodes.length) info.appendChild(actions);

        card.appendChild(info);
        row.appendChild(card);
        list.appendChild(row);
      });
      body.textContent = '';
      body.appendChild(list);
      diffNote.textContent = differs ? differs + ' 版的参数与现在不一样' : '各版参数与现在的一致';
    };

    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    foot.appendChild(diffNote);
    const footGrow = document.createElement('span');
    footGrow.className = 'grow';
    foot.appendChild(footGrow);
    const closeFoot = document.createElement('button');
    closeFoot.className = 'primary';
    closeFoot.type = 'button';
    closeFoot.textContent = '知道了';
    foot.appendChild(closeFoot);

    dialog.append(head, body, foot);
    mask.appendChild(dialog);
    document.body.appendChild(mask);
    repaint();

    const close = () => mask.remove();
    closeBtn.addEventListener('click', close);
    closeFoot.addEventListener('click', close);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) close();
    });
  }

  function versionTimeText(at) {
    const value = Number(at);
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }


  // ---------- 生成来源视图（清单 23）----------
  //
  // 历史里存的 params 是「接口形状」（sizeKey / 数字 count / duration 也是数字），
  // 卡片上的是「面板形状」（size / 字符串）。直接把这坨盖回卡片，会多出 sizeKey 这种
  // 面板不认的键，参数芯片就跟着显示错。所以搬回来之前先把键名对齐。
  // 反向（面板 → 历史）也要有，好比较「这版参数与现在是否一致」。
  const PARAM_KEY_ALIAS = { sizeKey: 'size' };

  // 把历史里那份参数整理成「面板参数」的样子（只保留这张卡片真有的参数键）
  function cardParamsFromEntry(entry, node) {
    const src = (entry && entry.params && typeof entry.params === 'object' ? entry.params : {}) || {};
    const defs = paramDefsOf(node, nodeData(node));
    const out = {};
    if (!defs.length) return out;
    defs.forEach((def) => {
      let value = src[def.key];
      if (value == null) {
        // 历史里可能叫 sizeKey，面板上叫 size
        Object.keys(PARAM_KEY_ALIAS).some((alias) => {
          if (PARAM_KEY_ALIAS[alias] !== def.key) return false;
          if (src[alias] == null) return false;
          value = src[alias];
          return true;
        });
      }
      if (value == null) return;
      // 面板参数一律是字符串，历史里可能是数字
      out[def.key] = String(value);
    });
    return out;
  }

  // 两版参数是否一样（面板形状对面板形状）。参数个数不同、值不同都算不一样。
  function sameParams(a, b) {
    const left = a && typeof a === 'object' ? a : {};
    const right = b && typeof b === 'object' ? b : {};
    const keys = Object.keys(left).concat(Object.keys(right)).filter((key, index, arr) => arr.indexOf(key) === index);
    return keys.every((key) => String(left[key] == null ? '' : left[key]) === String(right[key] == null ? '' : right[key]));
  }

  // 一版结果在面板里怎么描述：模型 · 参数 · 参考素材 · 尾部提示词
  function versionSummaryOf(entry, node) {
    const parts = [];
    const model = String((entry && entry.model) || '');
    if (model) parts.push('模型 ' + model);
    const params = cardParamsFromEntry(entry, node);
    const defs = paramDefsOf(node, nodeData(node));
    defs.forEach((def) => {
      const value = params[def.key];
      if (value == null || value === '') return;
      parts.push(def.label + ' ' + paramText(def, value));
    });
    const refs = entry && Array.isArray(entry.refs) ? entry.refs : [];
    if (refs.length) parts.push(refs.length + ' 个参考素材');
    const tail = String((entry && entry.tailPresetName) || '').trim();
    if (tail) parts.push('尾部：' + tail);
    return parts;
  }

  // 「这一版的参数与现在卡片上的是否一致」—— 决定要不要给「照这版参数改回去」按钮。
  function versionParamsDiffer(entry, node) {
    const data = nodeData(node);
    const want = cardParamsFromEntry(entry, node);
    const now = {};
    Object.keys(want).forEach((key) => {
      now[key] = String((data.params && data.params[key]) == null ? '' : data.params[key]);
    });
    if (!sameParams(want, now)) return true;
    const entryModel = String((entry && entry.model) || '');
    if (entryModel && entryModel !== String(data.model || '')) return true;
    return false;
  }

  function versionMediaThumb(entry) {
    const result = entry.result;
    if (result.kind === 'video') {
      const video = document.createElement('video');
      video.src = result.url;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      return video;
    }
    if (result.kind === 'audio') {
      const box = document.createElement('span');
      box.className = 'version-audio';
      box.textContent = '音频';
      return box;
    }
    const img = document.createElement('img');
    img.src = result.url;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    return img;
  }

  function switchCardVersion(node, url) {
    const data = nodeData(node);
    if (data.running) {
      toast('这张卡片正在生成，等这一轮结束再切换版本');
      return;
    }
    const entries = versionEntriesOf(data);
    const hit = entries.find((entry) => String(entry.result.url) === String(url));
    if (!hit) return;
    if (data.result && String(data.result.url) === String(hit.result.url)) {
      toast('现在显示的就是这一版');
      return;
    }
    pushHistory();
    let history = Array.isArray(data.history) ? data.history.slice() : [];
    if (data.result && data.result.url) {
      const already = history.some((one) => one && one.result && String(one.result.url) === String(data.result.url));
      if (!already) history = pushCardHistory(history, data.result, currentSubmissionMeta(data));
    }
    history = pushCardHistory(history, hit.result, hit);
    data.history = history;
    data.result = Object.assign({}, hit.result);
    data.lastSubmission = submissionMetaOf(hit, { model: hit.model, at: hit.at });
    if (data.result.width && data.result.height) {
      fitNodeToAspect(node, data.result.width / data.result.height);
    } else if (data.result.kind === 'video') {
      const parts = String((data.params && data.params.ratio) || '16:9')
        .split(':')
        .map((value) => Number(value));
      if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) fitNodeToAspect(node, parts[0] / parts[1]);
    }
    refreshNode(node);
    scheduleSave();
    toast('已切换到 ' + (versionTimeText(hit.at) || '这一版'));
  }

  function buildVersionStrip(node, data) {
    const entries = versionEntriesOf(data);
    const wrap = document.createElement('div');
    wrap.className = 'version-strip';
    // 只有一版时不占位置；至少生成过两次才显示版本条
    if (entries.length < 2) {
      wrap.hidden = true;
      return wrap;
    }
    wrap.addEventListener('pointerdown', (event) => event.stopPropagation());
    const head = document.createElement('div');
    head.className = 'version-head';
    const title = document.createElement('span');
    title.className = 'version-title';
    title.textContent = '生成版本 · ' + entries.length;
    const hint = document.createElement('span');
    hint.className = 'version-hint';
    hint.textContent = '点缩略图切换，旧文件都会保留';
    head.appendChild(title);
    head.appendChild(hint);
    // 「这一版当初是怎么生成的」得有个地方看 —— 缩略图只能看到结果
    const sourceBtn = document.createElement('button');
    sourceBtn.type = 'button';
    sourceBtn.className = 'version-source-btn';
    sourceBtn.textContent = '生成来源';
    sourceBtn.title = '看每一版用了什么模型、参数、提示词、参考素材';
    sourceBtn.addEventListener('pointerdown', (event) => event.stopPropagation());
    sourceBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openVersionPanel(node);
    });
    head.appendChild(sourceBtn);
    wrap.appendChild(head);

    const list = document.createElement('div');
    list.className = 'version-list';
    const currentUrl = data.result && data.result.url ? String(data.result.url) : '';
    entries.forEach((entry) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'version-item' + (String(entry.result.url) === currentUrl ? ' current' : '');
      item.appendChild(versionMediaThumb(entry));
      const time = document.createElement('span');
      time.className = 'version-time';
      time.textContent = String(entry.result.url) === currentUrl ? '当前' : versionTimeText(entry.at);
      item.appendChild(time);
      const prompt = String(entry.submittedPrompt || entry.mainPrompt || '').trim();
      const tips = [
        String(entry.result.url) === currentUrl ? '当前显示的版本' : '点一下切换到这一版',
        entry.model ? '模型：' + entry.model : '',
        prompt ? '提示词：' + prompt.slice(0, 180) : '',
        entry.tailPresetName ? '尾部提示词：' + entry.tailPresetName : '',
        entry.at ? '时间：' + new Date(entry.at).toLocaleString() : '',
      ].filter(Boolean);
      item.title = tips.join('\n');
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        switchCardVersion(node, entry.result.url);
      });
      list.appendChild(item);
    });
    wrap.appendChild(list);
    return wrap;
  }

  // 卡片里的尾部块与提示词浮窗共用同一套控件；浮窗开着时局部同步，不打断正在写的内容。
  function paintPromptEditorTail(node) {
    const host = promptEditorTailEl;
    if (!host || !node) return;
    const data = nodeData(node);
    host.innerHTML = '';
    if (!supportsTail(node)) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.dataset.sig = tailSignature(node);
    host.appendChild(buildTailCardBlock(node, data));
  }

  function syncPromptEditorTail(node) {
    const host = promptEditorTailEl;
    if (!host || !node || !promptEditorNode || promptEditorNode.id !== node.id) return;
    if (host.dataset.sig === tailSignature(node)) return;
    paintPromptEditorTail(node);
  }

  // 展开态：从卡片底部浮出的编辑面板，卡片本身的位置和大小不变
  function buildPanel(node, data, preset, el) {
    const panel = document.createElement('div');
    panel.className = 'node-panel';
    panel.addEventListener('pointerdown', (event) => event.stopPropagation());
    if (isLocked(node)) {
      const note = document.createElement('div');
      note.className = 'node-lock-note';
      note.textContent = '这张卡片已锁定：不能拖动、不能改提示词 / 模型 / 参数。按 Ctrl+L 解锁。';
      panel.appendChild(note);
    }
    // 组合卡片没有提示词和模型，只有组名和组里的素材
    if (node.type === 'group') {
      panel.appendChild(buildGroupPanel(node, data));
      return panel;
    }
    if (node.type === 'director') {
      panel.appendChild(buildDirectorPanel(node, data));
      return panel;
    }
    // 定时组没有提示词和模型，只有时间、成员和开始 / 暂停
    if (node.type === 'schedule') {
      panel.appendChild(buildSchedulePanel(node, data));
      return panel;
    }
    panel.appendChild(buildPanelHead(node, data, preset));
    const refs = buildRefs(node);
    if (refs) panel.appendChild(refs);
    panel.appendChild(buildPromptBlock(node, data, preset, el));
    panel.appendChild(buildParams(node, data));
    if (supportsTail(node)) panel.appendChild(buildTailCardBlock(node, data));
    panel.appendChild(buildVersionStrip(node, data));
    panel.appendChild(buildActions(node, data));
    return panel;
  }

  // ---------- 提示词框：高度偏好 / 字数统计 / 滚动位置 ----------
  // 默认「矮」（76px，约 3 行），点进去自动长高到 220px；
  // 手动加高或拖框底只记住这一张卡片，下次打开这张卡还是这个高度。
  // 按画布分开存：打开别的画布不会把这块画布记的高度清掉
  const PROMPT_SIZE_KEY = 'canvas.promptHeights.' + canvasId;
  const PROMPT_LEGACY_KEY = 'canvas.promptSize';
  const PROMPT_SHORT_H = 76;
  const PROMPT_TALL_H = 220;
  const PROMPT_MIN_H = 60;
  // 每张卡片各自记住的高度：{ [nodeId]: 高度 }
  let promptHeights = readPromptHeights();
  // 原地展开（大面板）：点「展开」把卡片面板本身加宽加高，不再另开一个窗口
  const PROMPT_WIDE_KEY = 'canvas.promptWide.' + canvasId;
  const PROMPT_WIDE_W = 780;
  let promptWide = readPromptWide();

  function readPromptWide() {
    const out = {};
    try {
      const raw = window.localStorage.getItem(PROMPT_WIDE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach((id) => {
          if (parsed[id]) out[id] = true;
        });
      }
    } catch {
      /* 读不到就按默认 */
    }
    return out;
  }

  function savePromptWide() {
    try {
      if (Object.keys(promptWide).length) {
        window.localStorage.setItem(PROMPT_WIDE_KEY, JSON.stringify(promptWide));
      } else {
        window.localStorage.removeItem(PROMPT_WIDE_KEY);
      }
    } catch {
      /* 记不住也不影响用 */
    }
  }

  function promptWideOn(node) {
    return Boolean(node && promptWide[node.id]);
  }

  function setPromptWide(node, on) {
    if (!node) return;
    if (on) promptWide[node.id] = true;
    else delete promptWide[node.id];
    savePromptWide();
  }

  // 大面板的提示词高度：尽量占满可视高度，但不超过 620
  function promptWideHeight() {
    return clamp(Math.round(window.innerHeight * 0.56), 240, 620);
  }
  // 每张卡片看到哪儿了：面板收起再打开，还停在原来那段
  const promptScrollMemo = new Map();
  let panelPlaceFrame = 0;
  let promptResizing = false;
  let promptMetaFrame = 0;
  let promptCaretFrame = 0;

  function promptHeightLimit() {
    // 再高也不能把整块面板顶出屏幕
    return Math.max(180, Math.min(620, Math.round(window.innerHeight * 0.62)));
  }

  function readPromptHeights() {
    const out = {};
    try {
      const raw = window.localStorage.getItem(PROMPT_SIZE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach((id) => {
          const height = Number(parsed[id]);
          if (Number.isFinite(height) && height >= PROMPT_MIN_H) out[id] = Math.round(height);
        });
      }
    } catch {
      /* 读不到就按默认 */
    }
    // 早期版本把高度记成「全局偏好」，一张卡加高会让所有卡一起变高；升级后不再使用
    try {
      window.localStorage.removeItem(PROMPT_LEGACY_KEY);
    } catch {
      /* 清不掉也不影响 */
    }
    return out;
  }

  function savePromptHeights() {
    try {
      if (Object.keys(promptHeights).length) {
        window.localStorage.setItem(PROMPT_SIZE_KEY, JSON.stringify(promptHeights));
      } else {
        window.localStorage.removeItem(PROMPT_SIZE_KEY);
      }
    } catch {
      /* 记不住也不影响用 */
    }
  }

  // 卡片删掉以后，把它的高度记录一起清掉，本地存的东西不会越积越多
  function prunePromptHeights() {
    let changed = false;
    Object.keys(promptHeights).forEach((id) => {
      if (byId(id)) return;
      delete promptHeights[id];
      changed = true;
    });
    if (changed) savePromptHeights();
    let wideChanged = false;
    Object.keys(promptWide).forEach((id) => {
      if (byId(id)) return;
      delete promptWide[id];
      wideChanged = true;
    });
    if (wideChanged) savePromptWide();
  }

  function promptCustomHeight(node) {
    const height = node ? Number(promptHeights[node.id]) : 0;
    return Number.isFinite(height) && height >= PROMPT_MIN_H ? height : 0;
  }

  // 只改这一张卡片：加高 / 拖动都记在它自己名下
  function setPromptCustomHeight(node, height) {
    if (!node) return;
    const next = Math.round(clamp(Number(height) || PROMPT_TALL_H, PROMPT_MIN_H, promptHeightLimit()));
    promptHeights[node.id] = next;
    savePromptHeights();
    return next;
  }

  function clearPromptCustomHeight(node) {
    if (!node || !promptHeights[node.id]) return;
    delete promptHeights[node.id];
    savePromptHeights();
  }

  // 没手动调过：不点进去 76px，点进去 220px；手动调过：一直是调好的高度
  function promptHeightFor(node, box, focusedOverride) {
    const limit = promptHeightLimit();
    const custom = promptCustomHeight(node);
    if (custom) return clamp(custom, PROMPT_MIN_H, limit);
    const focused =
      focusedOverride === undefined
        ? Boolean(box && (document.activeElement === box || box.contains(document.activeElement)))
        : Boolean(focusedOverride);
    return focused ? Math.min(PROMPT_TALL_H, limit) : PROMPT_SHORT_H;
  }

  function applyPromptHeight(box, node, focusedOverride) {
    if (!box) return;
    // 原地展开时提示词框跟着放大，长提示词看起来才舒服
    const height = promptWideOn(node)
      ? Math.max(promptWideHeight(), promptHeightFor(node, box, focusedOverride))
      : promptHeightFor(node, box, focusedOverride);
    box.style.height = Math.round(Math.min(height, promptHeightLimit())) + 'px';
  }

  // 面板高度变了：下一帧再重新贴一次，避免拖动时反复量尺寸
  function requestPlacePanel() {
    if (promptResizing) return;
    if (panelPlaceFrame) return;
    panelPlaceFrame = window.requestAnimationFrame(() => {
      panelPlaceFrame = 0;
      placePanel();
    });
  }

  // 把某张卡片的提示词框按它自己的高度重贴一次（不传就贴当前展开的那张）
  function syncPromptBoxSize(node) {
    const target = node || (expandedId ? byId(expandedId) : null);
    const el = target ? elements.get(target.id) : null;
    applyPromptHeight(el ? el.querySelector('.node-prompt') : null, target);
    requestPlacePanel();
  }

  // 「展开 / 收起」按钮的状态：原地展开时变成「收起」
  function paintPromptWideButton(btn, node) {
    if (!btn) return;
    const on = promptWideOn(node);
    const label = btn.querySelector('span');
    if (label) label.textContent = on ? '收起' : '展开';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on
      ? '收起大面板，回到卡片下方的常规大小'
      : '在卡片下方直接展开成大面板，写长提示词更舒服（不会另开窗口）';
  }

  function paintPromptSizeButton(btn, node) {
    if (!btn) return;
    const custom = Boolean(promptCustomHeight(node));
    btn.textContent = custom ? '还原' : '加高';
    btn.title = custom
      ? '把这张卡片的提示词框恢复默认高度（不点进去约 3 行，点进去自动长高）'
      : '把这张卡片的提示词框加高，写长提示词更舒服（只影响这张卡）';
    btn.setAttribute('aria-pressed', custom ? 'true' : 'false');
  }

  function paintPromptSizeButtonOf(node) {
    const el = node ? elements.get(node.id) : null;
    if (el) paintPromptSizeButton(el.querySelector('.prompt-size'), node);
  }


  function formatPromptCount(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function paintPromptMeta(meta, box) {
    if (!meta || !box) return;
    const text = promptTextOf(box);
    const chars = Array.from(text).length;
    const lines = text ? text.split('\n').length : 0;
    meta.textContent = formatPromptCount(chars) + ' 字 · ' + lines + ' 行';
    meta.classList.toggle('is-long', chars > 2000);
    meta.title = chars > 2000 ? '提示词比较长，注意检查有没有漏掉的段落' : '';
  }

  function paintPromptMetaOf(el) {
    if (!el) return;
    const box = el.querySelector('.node-prompt');
    const meta = el.querySelector('.prompt-meta');
    if (box && meta) paintPromptMeta(meta, box);
  }

  function schedulePromptMeta(meta, box) {
    if (promptMetaFrame) return;
    promptMetaFrame = window.requestAnimationFrame(() => {
      promptMetaFrame = 0;
      paintPromptMeta(meta, box);
    });
  }

  // 滚动位置按比例记：框变高变矮以后，还能停在原来那段
  function rememberPromptScroll(node, box) {
    if (!node || !box) return;
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    promptScrollMemo.set(node.id, max > 0 ? box.scrollTop / max : 0);
  }

  function restorePromptScroll(node, box) {
    if (!node || !box) return;
    const ratio = promptScrollMemo.get(node.id);
    if (!ratio) return;
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    if (max > 0) box.scrollTop = ratio * max;
  }

  // 打字时光标跑出可视区就把它拉回来（面板可能被画布缩放过，要换算）
  function keepPromptCaretVisible(box) {
    if (!box) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || !box.contains(range.startContainer)) return;
    const caret = range.getBoundingClientRect();
    if (!caret || (!caret.height && !caret.width)) return;
    const rect = box.getBoundingClientRect();
    const scale = box.offsetHeight > 0 && rect.height > 0 ? rect.height / box.offsetHeight : 1;
    const pad = 12;
    if (caret.bottom > rect.bottom - pad) {
      box.scrollTop += (caret.bottom - (rect.bottom - pad)) / scale;
    } else if (caret.top < rect.top + pad) {
      box.scrollTop -= ((rect.top + pad) - caret.top) / scale;
    }
  }

  function schedulePromptCaretFollow(box) {
    if (promptCaretFrame) return;
    promptCaretFrame = window.requestAnimationFrame(() => {
      promptCaretFrame = 0;
      keepPromptCaretVisible(box);
    });
  }

  // 拖框底：往上拖变高，往下拖变矮；双击恢复默认。只影响这一张卡片
  function setupPromptGrip(grip, box, node) {
    let drag = null;
    const stop = () => {
      if (!drag) return;
      drag = null;
      grip.classList.remove('dragging');
      document.body.classList.remove('prompt-resizing');
    };
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const panel = box.closest('.node-panel');
      const rect = panel ? panel.getBoundingClientRect() : null;
      const scale = rect && panel.offsetHeight > 0 ? rect.height / panel.offsetHeight : 1;
      drag = { y: event.clientY, h: box.offsetHeight, scale: scale || 1 };
      promptResizing = true;
      grip.classList.add('dragging');
      document.body.classList.add('prompt-resizing');
      if (grip.setPointerCapture) grip.setPointerCapture(event.pointerId);
    });
    grip.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const next = clamp(drag.h + (drag.y - event.clientY) / drag.scale, PROMPT_MIN_H, promptHeightLimit());
      box.style.height = Math.round(next) + 'px';
      requestPlacePanel();
    });
    grip.addEventListener('pointerup', () => {
      if (!drag) return;
      const height = box.offsetHeight;
      stop();
      promptResizing = false;
      setPromptCustomHeight(node, height);
      paintPromptSizeButtonOf(node);
      rememberPromptScroll(node, box);
      placePanel();
    });
    grip.addEventListener('pointercancel', () => {
      const wasDragging = Boolean(drag);
      stop();
      if (!wasDragging) return;
      promptResizing = false;
      setPromptCustomHeight(node, box.offsetHeight);
      paintPromptSizeButtonOf(node);
      placePanel();
    });
    grip.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearPromptCustomHeight(node);
      applyPromptHeight(box, node);
      paintPromptSizeButtonOf(node);
      requestPlacePanel();
      toast('这张卡片的提示词框已恢复默认高度');
    });
  }

  // 窗口变小：手动拖出来的高度跟着收进屏幕
  window.addEventListener('resize', () => {
    if (expandedId) syncPromptBoxSize();
  });

  // 提示词区域：小标题（字数 / 行数、加高、展开）+ 输入框 + 底部拖拽条
  function buildPromptBlock(node, data, preset, el) {
    const block = document.createElement('div');
    block.className = 'prompt-block';
    const bar = document.createElement('div');
    bar.className = 'prompt-bar';
    const label = document.createElement('span');
    label.className = 'prompt-label';
    label.textContent = '提示词';
    const meta = document.createElement('span');
    meta.className = 'prompt-meta';
    const size = document.createElement('button');
    size.type = 'button';
    size.className = 'prompt-size';
    paintPromptSizeButton(size, node);
    // 锁定只限制改内容，框本身加高只是「看得清楚」，仍然允许
    // 按下就阻止默认：不然输入框先失焦收回，面板一跳，按钮就点不到了
    size.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    size.addEventListener('click', (event) => {
      event.stopPropagation();
      const box = el.querySelector('.node-prompt');
      // 再点一次还原：只还原这张卡片
      if (promptCustomHeight(node)) clearPromptCustomHeight(node);
      else setPromptCustomHeight(node, PROMPT_TALL_H);
      applyPromptHeight(box, node);
      paintPromptSizeButton(size, node);
      requestPlacePanel();
    });
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'prompt-expand';
    expand.title = '展开成一个大窗口写提示词（长提示词看着更清楚）';
    expand.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5"/><path d="M20 15v5h-5"/><path d="M4 4l6 6"/><path d="M20 20l-6-6"/></svg><span>展开</span>';
    paintPromptWideButton(expand, node);
    if (isLocked(node)) {
      expand.disabled = true;
      expand.title = '卡片已锁定，先解锁才能编辑提示词';
    }
    expand.addEventListener('pointerdown', (event) => event.stopPropagation());
    expand.addEventListener('click', (event) => {
      event.stopPropagation();
      // 原地展开：面板本身加宽加高，不再另弹一个窗口
      const on = !promptWideOn(node);
      setPromptWide(node, on);
      // 展开时框加高；收起时把这张卡的手动高度清掉，回到原来的自动伸缩
      if (on) setPromptCustomHeight(node, promptWideHeight());
      else clearPromptCustomHeight(node);
      el.classList.toggle('wide', on);
      applyPromptHeight(box, node);
      paintPromptSizeButton(size, node);
      paintPromptWideButton(expand, node);
      requestPlacePanel();
      placePanel();
      if (on) focusPrompt(node);
    });
    const box = buildPrompt(node, data, preset, el);
    paintPromptMeta(meta, box);
    const grip = document.createElement('div');
    grip.className = 'prompt-grip';
    grip.title = '上下拖动调整提示词框高度，双击恢复默认';
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'horizontal');
    setupPromptGrip(grip, box, node);
    bar.appendChild(label);
    bar.appendChild(meta);
    bar.appendChild(size);
    bar.appendChild(expand);
    block.appendChild(bar);
    block.appendChild(box);
    block.appendChild(grip);
    return block;
  }

  // ---------- 提示词大编辑窗口：长提示词摊开写、摊开看 ----------
  let promptEditorEl = null;
  let promptEditorBox = null;
  // 浮窗里正在编辑哪张卡片：素材缩略图要跟着这张卡片走
  let promptEditorNode = null;
  let promptEditorRefsEl = null;
  let promptEditorParamsEl = null;
  let promptEditorTailEl = null;
  // 浮窗拖到哪儿，下次打开还在那儿；双击标题栏回到正中间
  const PROMPT_POS_KEY = 'canvas.promptEditorPos';

  function readPromptEditorPos() {
    try {
      const raw = window.localStorage.getItem(PROMPT_POS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) return parsed;
    } catch {
      /* 读不到就按默认居中 */
    }
    return null;
  }

  function placePromptEditor(modal, pos) {
    if (!pos) {
      modal.style.left = '';
      modal.style.top = '';
      modal.style.transform = '';
      return;
    }
    const width = modal.offsetWidth || 780;
    const height = modal.offsetHeight || 560;
    modal.style.transform = 'none';
    modal.style.left = clamp(pos.left, 8, Math.max(8, window.innerWidth - width - 8)) + 'px';
    modal.style.top = clamp(pos.top, 8, Math.max(8, window.innerHeight - height - 8)) + 'px';
  }

  function setupPromptEditorDrag(mask) {
    const modal = mask.querySelector('.prompt-modal');
    const head = mask.querySelector('.modal-head');
    if (!modal || !head) return;
    placePromptEditor(modal, readPromptEditorPos());
    let drag = null;
    head.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest && event.target.closest('button, select')) return;
      const rect = modal.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      modal.style.transform = 'none';
      modal.style.left = rect.left + 'px';
      modal.style.top = rect.top + 'px';
      modal.classList.add('dragging');
      if (head.setPointerCapture) head.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    head.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const rect = modal.getBoundingClientRect();
      const left = clamp(event.clientX - drag.dx, 8, Math.max(8, window.innerWidth - rect.width - 8));
      const top = clamp(event.clientY - drag.dy, 8, Math.max(8, window.innerHeight - rect.height - 8));
      modal.style.left = left + 'px';
      modal.style.top = top + 'px';
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      modal.classList.remove('dragging');
      const rect = modal.getBoundingClientRect();
      try {
        window.localStorage.setItem(
          PROMPT_POS_KEY,
          JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) })
        );
      } catch {
        /* 记不住位置也不影响用 */
      }
    };
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
    head.addEventListener('dblclick', (event) => {
      if (event.target.closest && event.target.closest('button, select')) return;
      placePromptEditor(modal, null);
      try {
        window.localStorage.removeItem(PROMPT_POS_KEY);
      } catch {
        /* 无所谓 */
      }
    });
  }

  // 模型下拉：卡片面板和展开窗口共用一套清单和切换逻辑
  function buildModelSelect(node, data, className) {
    const model = document.createElement('select');
    model.className = className;
    model.title = '这张卡片用哪个模型';
    const options = modelsFor(node.type);
    if (!options.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '未配置模型';
      model.appendChild(opt);
      model.disabled = true;
      model.title = '还没有配置渠道，先到门户页填写接口地址和密钥';
    } else {
      options.forEach((item) => {
        const opt = document.createElement('option');
        opt.value = item.key;
        opt.textContent = item.label;
        const tips = [];
        if (item.channel) tips.push('来自通道：' + item.channel);
        if (item.note) tips.push('备注：' + item.note);
        if (tips.length) opt.title = tips.join(' ｜ ');
        const sameChannel = !data.channelId || item.channelId === data.channelId;
        if (item.id === data.model && sameChannel) opt.selected = true;
        model.appendChild(opt);
      });
      if (!options.some((item) => item.id === data.model)) {
        const opt = document.createElement('option');
        opt.value = 'legacy::' + (data.model || '');
        opt.textContent = data.model || '未选择';
        opt.selected = true;
        model.insertBefore(opt, model.firstChild);
      }
    }
    if (isLocked(node)) {
      model.disabled = true;
      model.title = '卡片已锁定，先解锁才能换模型';
    }
    model.addEventListener('pointerdown', (event) => event.stopPropagation());
    model.addEventListener('change', () => {
      pushHistory();
      const hit = options.find((item) => item.key === model.value);
      data.model = hit ? hit.id : model.value;
      data.channelId = hit ? hit.channelId || '' : '';
      rememberModel(node.type, data.model);
      // 不同模型吃的时间和分辨率不一样，切换后把参数收回有效范围
      normalizeParams(node);
      scheduleSave();
      setTimeout(() => refreshNode(node), 0);
      toast('模型已切换为 ' + (hit ? hit.label : model.value));
    });
    return model;
  }

  // 浮窗里的素材缩略图：跟卡片内面板共用 buildRefs，编号 / 首尾帧 / 快速视频的 @ 都对得上
  function paintPromptEditorRefs(node) {
    const host = promptEditorRefsEl;
    if (!host || !node) return;
    host.innerHTML = '';
    const refs = buildRefs(node);
    // 导演台这类没有参考素材的卡片，这一块不占地方
    if (!refs) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const count = refs.querySelectorAll('.ref-tile').length;
    // 一个素材都没有的时候，只留 buildRefs 自带的提示文字，不加标题
    if (count > 0) {
      const head = document.createElement('div');
      head.className = 'prompt-refs-head';
      head.textContent = node.type === 'quick' ? '提示词里 @ 到的素材（' + count + '）' : '连进来的素材（' + count + '）';
      host.appendChild(head);
    }
    host.appendChild(refs);
  }

  // 参数行：时长 / 分辨率 / 比例 / 模式，跟卡片里那排小标签共用同一份定义
  function paramSignature(node, data) {
    const defs = paramDefsOf(node, data);
    return (
      defs
        .map((def) => def.key + ':' + def.options.join(',') + '/' + (def.texts ? def.texts.join(',') : '') + '=' + data.params[def.key])
        .join('|') + (isLocked(node) ? '|locked' : '')
    );
  }

  function paintPromptEditorParams(node) {
    const host = promptEditorParamsEl;
    if (!host || !node) return;
    const data = nodeData(node);
    const defs = paramDefsOf(node, data);
    host.innerHTML = '';
    host.dataset.sig = paramSignature(node, data);
    if (!defs.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    defs.forEach((def) => {
      const item = document.createElement('label');
      item.className = 'prompt-param';
      const label = document.createElement('span');
      label.className = 'prompt-param-label';
      label.textContent = def.label;
      const select = document.createElement('select');
      select.className = 'prompt-param-select';
      select.dataset.key = def.key;
      select.title = '在这里改' + def.label;
      def.options.forEach((value, index) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = (def.texts && def.texts[index]) || value;
        if (String(value) === String(data.params[def.key])) opt.selected = true;
        select.appendChild(opt);
      });
      if (String(data.params[def.key]) === '' && def.options.length) select.value = def.options[0];
      if (isLocked(node)) {
        select.disabled = true;
        select.title = '卡片已锁定，先解锁才能改参数';
      }
      select.addEventListener('pointerdown', (event) => event.stopPropagation());
      select.addEventListener('change', () => {
        pushHistory();
        const value = select.value;
        data.params[def.key] = value;
        // 换比例时卡片跟着变形，手动拉过大小就不动
        if (def.key === 'ratio' && !data.sized) {
          const size = defaultSize(node.type, data.params);
          node.w = size.w;
          node.h = size.h;
          const cardEl = elements.get(node.id);
          if (cardEl) {
            cardEl.style.width = size.w + 'px';
            cardEl.style.height = size.h + 'px';
          }
          updateEdgePaths([node]);
        }
        scheduleSave();
        // 浮动窗口自己记一下现在的状态，免得下次刷新时无谓重画、把焦点弄丢
        if (promptEditorParamsEl) promptEditorParamsEl.dataset.sig = paramSignature(node, data);
        // 卡片里那排参数标签跟着改字
        const cardEl = elements.get(node.id);
        if (cardEl) {
          const chip = cardEl.querySelector('.param-chip[data-key="' + def.key + '"]');
          if (chip) chip.textContent = def.label + ' · ' + paramText(def, value);
        }
        // 模式影响素材用途（首帧 / 尾帧），重画一遍卡片和素材条
        if (def.key === 'mode') refreshNode(node);
      });
      item.appendChild(label);
      item.appendChild(select);
      host.appendChild(item);
    });
  }

  // 卡片状态变了：只有参数清单或取值真的变了才重画，避免打断正在操作的下拉
  function syncPromptEditorParams(node) {
    const host = promptEditorParamsEl;
    if (!host || !node || !promptEditorNode || promptEditorNode.id !== node.id) return;
    const data = nodeData(node);
    if (host.dataset.sig === paramSignature(node, data)) return;
    paintPromptEditorParams(node);
  }

  // 卡片状态变了（连线、@ 增删、出结果）：浮窗开着就顺手重画素材条
  function syncPromptEditorRefs(node) {
    if (!promptEditorNode || !node || promptEditorNode.id !== node.id) return;
    paintPromptEditorRefs(node);
  }

  function closePromptEditor() {
    if (!promptEditorEl) return;
    const dying = promptEditorEl;
    promptEditorEl = null;
    promptEditorBox = null;
    promptEditorNode = null;
    promptEditorRefsEl = null;
    promptEditorParamsEl = null;
    promptEditorTailEl = null;
    dying.remove();
  }

  function openPromptEditor(node) {
    closePromptEditor();
    const data = nodeData(node);
    const preset = presetOf(node.type);
    const mask = document.createElement('div');
    mask.className = 'modal-mask prompt-mask';
    mask.innerHTML =
      '<div class="modal prompt-modal">' +
      '  <div class="modal-head"><b>写提示词</b>' +
      '    <span class="prompt-head-sub"></span>' +
      '    <span class="grow"></span>' +
      '    <span class="prompt-model-slot"></span>' +
      '    <button class="ghost" data-close>关闭</button></div>' +
      '  <div class="modal-body prompt-body">' +
      '    <div class="prompt-refs" data-refs></div>' +
      '    <div class="prompt-params" data-params></div>' +
      '    <div class="prompt-tail-slot" data-tail></div>' +
      '    <div class="prompt-editor" contenteditable="true" spellcheck="false"></div>' +
      '  </div>' +
      '  <div class="modal-foot">' +
      '    <span class="prompt-count">0 字</span>' +
      '    <span class="grow"></span>' +
      '    <span class="set-hint">回车换行，Ctrl+回车保存；Esc 关闭</span>' +
      '    <button class="ghost" data-save>保存</button>' +
      '    <button class="primary btn-run" data-generate>生成</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(mask);
    promptEditorEl = mask;
    promptEditorNode = node;
    promptEditorRefsEl = mask.querySelector('[data-refs]');
    promptEditorParamsEl = mask.querySelector('[data-params]');
    promptEditorTailEl = mask.querySelector('[data-tail]');
    setupPromptEditorDrag(mask);
    const box = mask.querySelector('.prompt-editor');
    promptEditorBox = box;
    const sub = mask.querySelector('.prompt-head-sub');
    const title = String(data.title || '').trim();
    // 模型名交给标题栏里的下拉框显示，这里只说是什么卡片
    sub.textContent = (title ? title + '　·　' : '') + preset.label;
    // 展开窗口里也能直接换模型：跟卡片里那个下拉是同一套清单、同一套逻辑
    const modelSlot = mask.querySelector('.prompt-model-slot');
    if (modelSlot && node.type !== 'director' && node.type !== 'schedule' && node.type !== 'group') {
      modelSlot.appendChild(buildModelSelect(node, data, 'prompt-model'));
    }
    box.dataset.placeholder = preset.placeholder;
    renderPrompt(box, node, data.text);
    paintPromptEditorRefs(node);
    paintPromptEditorParams(node);
    paintPromptEditorTail(node);
    const count = mask.querySelector('.prompt-count');
    const paintCount = () => {
      count.textContent = Array.from(promptTextOf(box)).length + ' 字';
    };
    paintCount();
    // 已经在跑的卡片：按钮直接变成「取消生成」
    const genBtn = mask.querySelector('[data-generate]');
    const paintGenBtn = () => {
      if (!genBtn) return;
      const running = Boolean(nodeData(node).running);
      genBtn.textContent = running ? '取消生成' : '生成';
      genBtn.classList.toggle('cancel', running);
      genBtn.title = running ? '取消这次生成' : '保存提示词并立即生成（Ctrl+Shift+回车）';
    };
    paintGenBtn();
    box.addEventListener('input', paintCount);
    box.addEventListener('input', () => {
      if (atMentionTrigger(box)) {
        if (mentionBox === box && mentionEl) refreshMention(node, box);
        else openMention(node, box);
        return;
      }
      // 选完素材以后继续正常打字，列表照样留着（点画布 / 点别的卡片 / 闲置 10 秒才收）；
      // 只有正在挑素材时把那个 @ 删掉了，才顺手收起来
      if (mentionBox === box && !mentionStale) closeMention();
    });
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !mentionPicking(box)) {
        event.preventDefault();
        event.stopPropagation();
        closePromptEditor();
        return;
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !mentionPicking(box)) {
        event.preventDefault();
        if (event.shiftKey) runFromPromptEditor(node, box);
        else savePromptEditor(node, box);
        return;
      }
      if (mentionPicking(box)) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveMention(1);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveMention(-1);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          chooseMention();
          return;
        }
      }
      if (mentionBox === box && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMention();
        return;
      }
    });
    box.addEventListener('focus', () => {
      if (mentionBox && mentionBox !== box) closeMention();
    });
    box.addEventListener('paste', (event) => {
      event.preventDefault();
      const raw = (event.clipboardData || window.clipboardData).getData('text/plain') || '';
      insertPlainText(box, raw);
    });
    mask.addEventListener('click', (event) => {
      const button = event.target.closest ? event.target.closest('button') : null;
      if (button && button.dataset.generate !== undefined) {
        runFromPromptEditor(node, box);
        return;
      }
      if (button && button.dataset.save !== undefined) {
        savePromptEditor(node, box);
        return;
      }
      if (button && button.dataset.close !== undefined) {
        closePromptEditor();
        return;
      }
      if (event.target === mask) closePromptEditor();
    });
    mask.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePromptEditor();
      }
    });
    box.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 只把大窗口里的文字写回卡片，不关窗；返回提示词有没有变化
  function writePromptEditor(node, box) {
    const data = nodeData(node);
    // 大窗口里手打的 @图1 同样认
    const next = normalizeMentions(node, promptTextOf(box));
    const changed = next !== data.text;
    if (changed) {
      pushHistory();
      data.text = next;
      scheduleSave();
    }
    syncQuickRefs(node);
    // 卡片面板里的提示词跟着更新
    const el = elements.get(node.id);
    if (el) {
      const inline = el.querySelector('.node-prompt');
      if (inline) {
        renderPrompt(inline, node, data.text);
        paintPromptMetaOf(el);
      }
    }
    // 快速视频：引用变了，素材条也要跟着重画
    if (node.type === 'quick') refreshNode(node);
    refreshHoverBar(node);
    return changed;
  }

  function savePromptEditor(node, box) {
    writePromptEditor(node, box);
    closePromptEditor();
    toast('提示词已保存');
  }

  // 审阅完直接生成：先落库，再交给卡片原来的生成流程（含模型 / @ 校验）
  function runFromPromptEditor(node, box) {
    const data = nodeData(node);
    if (data.running) {
      closePromptEditor();
      cancelGenerate(node);
      return;
    }
    writePromptEditor(node, box);
    closePromptEditor();
    startGenerate(node);
  }

  function buildPanelHead(node, data, preset) {
    const head = document.createElement('div');
    head.className = 'node-panel-head';
    const dot = document.createElement('div');
    dot.className = 'dot';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = preset.label;

    // 导演台卡片没有模型和参数，这里只放一个「打开」入口
    if (node.type === 'director') {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'node-model director-open-btn';
      open.textContent = '打开导演台';
      open.title = '双击卡片也能打开';
      if (isLocked(node)) {
        open.disabled = true;
        open.title = '卡片已锁定，先解锁再打开导演台';
      }
      open.addEventListener('pointerdown', (event) => event.stopPropagation());
      open.addEventListener('click', (event) => {
        event.stopPropagation();
        openDirectorStage(node);
      });
      head.appendChild(dot);
      head.appendChild(title);
      head.appendChild(open);
      return head;
    }

    const model = buildModelSelect(node, data, 'node-model');

    // 面板头部不再放删除按钮：模型选择框后面紧跟一个 × 容易被误点成删卡片。
    // 删除仍然可以走右键菜单的「删除」或键盘 Delete。

    head.appendChild(dot);
    head.appendChild(title);
    head.appendChild(model);
    return head;
  }

  // 素材编号用的种类简称：图1 / 视频1 / 音频1 / 快速视频1
  const KIND_LABEL = { image: '图', video: '视频', audio: '音频', quick: '快速视频' };

  function roleLabelOf(type, key) {
    const hit = (ROLES[type] || []).find((item) => item.key === key);
    return hit ? hit.label : '';
  }

  // 角色不用手选：按卡片模式和连线顺序自动判定
  // 全能参考（默认）：图片=参考图，视频=参考视频，音频=参考音频
  // 首尾帧：只收两张图，第一张当首帧、第二张当尾帧；顺序可以在面板里一键对调
  function rolePlan(node) {
    const incoming = edges.filter((edge) => edge.targetId === node.id);
    const mode = node.data && node.data.params ? node.data.params.mode : '';
    const useFrames = node.type === 'video' && mode === 'frames';
    // 首尾帧模式下用户手动对调过顺序：按存下来的顺序先排
    const frameOrder = useFrames && Array.isArray(node.data && node.data.frameOrder) ? node.data.frameOrder : [];
    const ordered = frameOrder.length
      ? incoming.slice().sort((a, b) => {
          const ia = frameOrder.indexOf(a.sourceId);
          const ib = frameOrder.indexOf(b.sourceId);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        })
      : incoming;
    const counters = { image: 0, video: 0, audio: 0, quick: 0 };
    let imageSeat = 0;
    const plan = [];
    ordered.forEach((edge) => {
      const source = byId(edge.sourceId);
      if (!source) return;
      // 连的是一整个组合：等于把组里的素材一次全接过来
      const sources = source.type === 'group' ? groupMembersOf(source) : [source];
      sources.forEach((one) => {
        const kind = mediaKindOf(one) || 'image';
        const numberKind = numberKindOf(one) || kind;
        counters[numberKind] += 1;
        let role = 'reference_image';
        if (kind === 'video') {
          role = 'reference_video';
        } else if (kind === 'audio') {
          role = 'reference_audio';
        } else if (useFrames && imageSeat === 0) {
          role = 'first_frame';
          imageSeat = 1;
        } else if (useFrames && imageSeat === 1) {
          role = 'last_frame';
          imageSeat = 2;
        }
        plan.push({
          edge: edge,
          source: one,
          kind: kind,
          role: role,
          // 用卡片自己的序号，跟卡片上方显示的编号牌一致
          tag: tagOf(one) || (KIND_LABEL[numberKind] || '素材') + counters[numberKind],
          via: source.type === 'group' ? source : null,
        });
      });
    });
    return plan;
  }

  // 已经连进来的素材：角色是自动的，不需要在下拉里选
  // 同一种素材排在同一行，一格一张缩略图；连线断了这一格就不出现，@ 里也找不到
  const REF_KINDS = ['image', 'video', 'audio'];

  // ---------- 素材序号：图1 / 视频1 / 音频1 / 快速视频1 ----------
  // 同一类素材按建卡先后排成 1、2、3…，中间删掉一张，后面的自动往前补，
  // 永远是一段连续的号，卡片上方外侧一直显示它。
  // @ 列表、提示词胶囊、组合缩略图、导出文件名用的都是这个号。
  // 快速视频单独一套号，不跟普通「视频N」混用。
  function materialKindOf(node) {
    if (!node) return '';
    return node.type === 'image' || node.type === 'video' || node.type === 'audio' ? node.type : '';
  }

  // 编号用的种类：快速视频算自己一类
  function numberKindOf(node) {
    if (!node) return '';
    if (node.type === 'quick') return 'quick';
    return materialKindOf(node);
  }

  // 送去接口时快速视频按视频处理
  function mediaKindOf(node) {
    if (!node) return '';
    if (node.type === 'quick') return 'video';
    return materialKindOf(node);
  }

  function tagOf(node) {
    const kind = numberKindOf(node);
    if (!kind) return '';
    const no = Number(node.data && node.data.no);
    if (!Number.isFinite(no) || no <= 0) return '';
    return (KIND_LABEL[kind] || '素材') + no;
  }

  // 全画布重排一次号：同类素材按建卡先后排成 1..N，中间不留空号。
  // 顺带把提示词里的 @[旧号] 一次性改成新号，让引用始终跟着那张素材走。
  // 返回 { tagged, retagged, rebound, rescheduled }：
  //   tagged      —— 序号变了的素材卡
  //   retagged    —— 提示词里的 @ 被改过号的卡片
  //   rebound     —— 快速视频的「编号 → 卡片」绑定跟着换过钥匙的卡片
  //   rescheduled —— 定时组里冻结的提示词被改过号的组卡
  // 必须「先把所有新旧号算完，再整体替换」：图2→图1、图3→图2 这种连环换号
  // 如果边算边写回，会出现一张图被换两次的错误。
  function renumberAll() {
    const tagged = new Set();
    const retagged = new Set();
    const rebound = new Set();
    const rescheduled = new Set();
    const buckets = { image: [], video: [], audio: [], quick: [] };
    nodes.forEach((node, index) => {
      const kind = numberKindOf(node);
      if (!kind) return;
      if (!buckets[kind]) buckets[kind] = [];
      buckets[kind].push({ node: node, index: index, at: Number(node.createdAt) || 0 });
    });
    // 旧号 → 新号。同一个旧号只可能属于一张卡，所以这里不会有歧义
    const renamed = new Map();
    Object.keys(buckets).forEach((kind) => {
      const label = KIND_LABEL[kind] || '素材';
      const list = buckets[kind].slice().sort((a, b) => a.at - b.at || a.index - b.index);
      list.forEach((item, seat) => {
        const node = item.node;
        const nextNo = seat + 1;
        const oldNo = Number(node.data && node.data.no);
        if (oldNo === nextNo) return;
        if (Number.isFinite(oldNo) && oldNo > 0) renamed.set(label + oldNo, label + nextNo);
        node.data.no = nextNo;
        tagged.add(node.id);
      });
    });
    // 快速视频记的「编号 → 卡片」跟着换钥匙，指向已删卡片的顺手清掉
    nodes.forEach((node) => {
      if (node.type !== 'quick') return;
      const data = nodeData(node);
      const old = data.quickRefs && typeof data.quickRefs === 'object' ? data.quickRefs : null;
      if (!old) return;
      const next = {};
      Object.keys(old).forEach((tag) => {
        const hit = nodes.find((one) => one.id === old[tag]);
        if (!hit) return;
        const live = tagOf(hit);
        if (!live) return;
        next[live] = hit.id;
      });
      const changed =
        Object.keys(next).length !== Object.keys(old).length ||
        Object.keys(next).some((tag) => old[tag] !== next[tag]);
      if (Object.keys(next).length) data.quickRefs = next;
      else delete data.quickRefs;
      if (changed) rebound.add(node.id);
    });

    if (!renamed.size) {
      return { tagged: tagged, retagged: retagged, rebound: rebound, rescheduled: rescheduled };
    }
    // 提示词里的 @[图3] 一次扫完统一换号
    nodes.forEach((node) => {
      const data = nodeData(node);
      const text = String(data.text || '');
      if (text.indexOf('@[') < 0) return;
      const next = text.replace(/@\[([^\]\n]+)\]/g, (all, tag) => {
        const to = renamed.get(tag);
        return to ? '@[' + to + ']' : all;
      });
      if (next === text) return;
      data.text = next;
      retagged.add(node.id);
    });
    // 定时组的「快照」里也冻着带编号的提示词文字，一起换掉，
    // 这样下次到点跑的还是同一批素材，文字也跟画布上一致
    nodes.forEach((node) => {
      if (!isSchedule(node)) return;
      const sched = nodeData(node).schedule;
      if (!sched || !sched.snapshots || typeof sched.snapshots !== 'object') return;
      Object.keys(sched.snapshots).forEach((id) => {
        const snap = sched.snapshots[id];
        if (!snap) return;
        const shown = String(snap.prompt || '');
        if (shown.indexOf('@') >= 0) {
          const nextShown = shown.replace(/@(快速视频|视频|音频|图)(\d+)/g, (all, kind, num) => {
            const to = renamed.get(kind + num);
            return to ? '@' + to : all;
          });
          if (nextShown !== shown) {
            snap.prompt = nextShown;
            rescheduled.add(node.id);
          }
        }
        const rawText = String(snap.promptRaw || '');
        if (rawText.indexOf('@[') >= 0) {
          const nextRaw = rawText.replace(/@\[([^\]\n]+)\]/g, (all, tag) => {
            const to = renamed.get(tag);
            return to ? '@[' + to + ']' : all;
          });
          if (nextRaw !== rawText) {
            snap.promptRaw = nextRaw;
            rescheduled.add(node.id);
          }
        }
      });
    });
    return { tagged: tagged, retagged: retagged, rebound: rebound, rescheduled: rescheduled };
  }

  // 一张素材被删掉以后，别的提示词里指向它的 @ 会变成空号；
  // 而重排会让这个空号被后面的卡片占用，看起来就像「引用自己跳到了别的图上」。
  // 所以在重排之前先把这些引用摘干净，用户能一眼看出那张素材已经没了。
  function stripRemovedRefs(tags) {
    const gone = tags instanceof Set ? tags : new Set(tags || []);
    const changed = new Set();
    if (!gone.size) return changed;
    // 把 @ 摘掉以后，两边会剩下多余空格：收成一个，首尾也去掉
    const tidy = (text) => text.replace(/[ \t]{2,}/g, ' ').trim();
    // 内部写法 @[图1]
    const cleanRaw = (text) => {
      let hit = false;
      const next = String(text || '').replace(/@\[([^\]\n]+)\]/g, (all, tag) => {
        if (!gone.has(tag)) return all;
        hit = true;
        return '';
      });
      return hit ? tidy(next) : null;
    };
    // 给人看的写法 @图1（定时组快照里存的是这种）
    const cleanShown = (text) => {
      let hit = false;
      const next = String(text || '').replace(/@(快速视频|视频|音频|图)(\d+)/g, (all, kind, num) => {
        if (!gone.has(kind + num)) return all;
        hit = true;
        return '';
      });
      return hit ? tidy(next) : null;
    };
    nodes.forEach((node) => {
      const data = nodeData(node);
      const next = cleanRaw(data.text);
      if (next === null) return;
      data.text = next;
      changed.add(node.id);
    });
    nodes.forEach((node) => {
      if (!isSchedule(node)) return;
      const sched = nodeData(node).schedule;
      if (!sched || !sched.snapshots || typeof sched.snapshots !== 'object') return;
      Object.keys(sched.snapshots).forEach((id) => {
        const snap = sched.snapshots[id];
        if (!snap) return;
        const shown = cleanShown(snap.prompt);
        if (shown !== null) {
          snap.prompt = shown;
          changed.add(node.id);
        }
        const raw = cleanRaw(snap.promptRaw);
        if (raw !== null) {
          snap.promptRaw = raw;
          changed.add(node.id);
        }
      });
    });
    return changed;
  }

  // 这一类素材现在有几张：新卡排在最后，先按「张数 + 1」占个位
  function numberSeatOf(kind) {
    let count = 0;
    nodes.forEach((node) => {
      if (numberKindOf(node) === kind) count += 1;
    });
    return count + 1;
  }

  function refSeatOf(node, item) {
    if (node.type === 'quick') return '';
    return item.role === 'first_frame' || item.role === 'last_frame' ? roleLabelOf(node.type, item.role) : '';
  }

  function refSourceText(item) {
    return item.source && item.source.data && item.source.data.text ? displayText(item.source.data.text).trim() : '';
  }

  // 缩略图：图片用图本身，视频取第一帧，音频给个音符底，没生成结果就放种类字
  function refThumbOf(item) {
    const thumb = document.createElement('div');
    thumb.className = 'ref-thumb';
    const source = item.source;
    const url = source && source.data && source.data.result ? source.data.result.url : '';
    const label = source ? presetOf(source.type).label : '素材';
    const result = source && source.data ? source.data.result : null;
    if (url && (item.kind === 'image' || item.kind === 'video')) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'lazy';
      const thumbUrl = thumbUrlOf(result);
      if (thumbUrl) {
        img.src = thumbUrl;
        img.addEventListener('error', () => {
          if (img.dataset.fallback === '1') {
            thumb.innerHTML = '';
            thumb.textContent = label;
            return;
          }
          fallbackToOriginal(img, result);
        });
      } else {
        img.src = url;
      }
      thumb.appendChild(img);
    } else if (item.kind === 'audio') {
      thumb.textContent = '♪';
    } else {
      thumb.textContent = label;
    }
    return thumb;
  }

  function buildRefTile(node, item) {
    const tile = document.createElement('div');
    tile.className = 'ref-tile';
    // 快速视频用自己的青色，但送接口时仍按视频处理
    tile.dataset.kind = item.numberKind || item.kind;
    const seat = refSeatOf(node, item);
    const about = refSourceText(item) || (item.source ? presetOf(item.source.type).label : '素材');
    const viaText = item.via ? '来自组合「' + groupNameOf(item.via) + '」' : '';
    tile.title =
      item.tag +
      (seat ? '（' + seat + '）' : '') +
      ' · ' +
      about +
      (viaText ? ' · ' + viaText : '') +
      (item.via ? '（点右上角 × 断开与这个组合的连线）' : '（点右上角 × 断开）');
    if (item.via) tile.classList.add('from-group');
    tile.appendChild(refThumbOf(item));
    const tag = document.createElement('span');
    tag.className = 'ref-tag';
    tag.textContent = item.tag;
    tile.appendChild(tag);
    if (seat) {
      const seatEl = document.createElement('span');
      seatEl.className = 'ref-seat';
      seatEl.textContent = seat;
      tile.appendChild(seatEl);
    }
    const unlink = document.createElement('button');
    unlink.className = 'icon-btn';
    unlink.type = 'button';
    unlink.textContent = '×';
    const quick = node.type === 'quick';
    unlink.title = quick
      ? '从提示词里去掉这个引用'
      : item.via
      ? '断开与组合「' + groupNameOf(item.via) + '」的连线'
      : '断开这条连线';
    unlink.addEventListener('pointerdown', (event) => event.stopPropagation());
    unlink.addEventListener('click', (event) => {
      event.stopPropagation();
      if (quick) dropQuickRef(node, item.tag);
      else removeEdge(item.edge.id);
    });
    tile.appendChild(unlink);
    return tile;
  }

  // 首尾帧对调：把两张图在连线顺序里换一下，首帧 / 尾帧的判定跟着变
  function swapFrames(node) {
    const frames = rolePlan(node).filter((item) => item.kind === 'image' && item.source);
    if (frames.length < 2) {
      toast('首尾帧要接两张图片才能对调');
      return;
    }
    pushHistory();
    const first = frames[0];
    const last = frames[1];
    // 以「画面顺序」为准来翻：本来已经对调过一次，就再翻回去
    const data = nodeData(node);
    const order = Array.isArray(data.frameOrder) && data.frameOrder.length ? data.frameOrder : frames.map((item) => item.source.id);
    if (order.length >= 2) {
      const flipped = order.slice();
      const head = flipped[0];
      flipped[0] = flipped[1];
      flipped[1] = head;
      data.frameOrder = flipped;
    }
    refreshNode(node);
    scheduleSave();
    toast('已对调：现在是「' + last.tag + '」当首帧、「' + first.tag + '」当尾帧');
  }

  function buildRefs(node) {
    const wrap = document.createElement('div');
    wrap.className = 'node-refs';
    // 快速视频：没有连线，改看提示词里 @ 了谁
    if (node.type === 'quick') {
      const picked = quickPickedOf(node);
      const bar = document.createElement('div');
      bar.className = 'ref-row';
      if (!picked.length) {
        const empty = document.createElement('div');
        empty.className = 'ref-empty';
        empty.textContent = '在提示词里敲 @ 直接挑素材，不用拉线';
        wrap.appendChild(empty);
        return wrap;
      }
      picked.forEach((item) => bar.appendChild(buildRefTile(node, item)));
      wrap.appendChild(bar);
      const note = document.createElement('div');
      note.className = 'ref-note quick-note';
      note.textContent = '这些是提示词里 @ 到的素材；去掉 @ 就不带了';
      wrap.appendChild(note);
      return wrap;
    }
    // 导演台没有参考素材连线，面板里只留一个入口
    if (node.type === 'director') return null;
    const roles = ROLES[node.type] || [];
    const plan = rolePlan(node);
    if (!plan.length) {
      if (!roles.length) return null;
      const empty = document.createElement('div');
      empty.className = 'ref-empty';
      empty.textContent = '从卡片左侧圆点连线，把素材接进来';
      wrap.appendChild(empty);
      return wrap;
    }
    plan.forEach((item) => {
      if (item.edge.role !== item.role) item.edge.role = item.role;
    });
    REF_KINDS.forEach((kind) => {
      const group = plan.filter((item) => item.kind === kind && item.source);
      if (!group.length) return;
      const row = document.createElement('div');
      row.className = 'ref-row';
      row.dataset.kind = kind;
      group.forEach((item) => row.appendChild(buildRefTile(node, item)));
      wrap.appendChild(row);
    });
    if (!wrap.querySelector('.ref-row')) {
      const empty = document.createElement('div');
      empty.className = 'ref-empty';
      empty.textContent = '从卡片左侧圆点连线，把素材接进来';
      wrap.appendChild(empty);
    }
    if (node.type === 'video' && node.data.params.mode === 'text') {
      const note = document.createElement('div');
      note.className = 'ref-note';
      note.textContent = '当前是纯文生模式，连进来的素材不会被带上';
      wrap.appendChild(note);
    }
    // 首尾帧模式：两张图接齐了就能一键对调首帧 / 尾帧
    if (node.type === 'video' && node.data.params.mode === 'frames') {
      const frames = plan.filter((item) => item.kind === 'image' && item.source);
      if (frames.length >= 2) {
        const swap = document.createElement('button');
        swap.type = 'button';
        swap.className = 'ref-swap';
        swap.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/></svg><span>互换首尾帧</span>';
        swap.title = '把现在当首帧的图和当尾帧的图对调一下';
        swap.addEventListener('pointerdown', (event) => event.stopPropagation());
        swap.addEventListener('click', (event) => {
          event.stopPropagation();
          swapFrames(node);
        });
        wrap.appendChild(swap);
      } else if (frames.length === 1) {
        const tip = document.createElement('div');
        tip.className = 'ref-note';
        tip.textContent = '首尾帧模式再接一张图片，就能当尾帧用（最多两张）';
        wrap.appendChild(tip);
      }
    }
    return wrap;
  }

  // ===== 提示词里的 @ 引用素材 =====
  // 存盘时写成 @[图1]；显示时是一条彩色胶囊，编号和上面素材条上的编号一致。
  // 素材断开或删掉以后，胶囊会变红，并且在点生成时被拦住。

  let mentionEl = null;
  let mentionBox = null;
  let mentionNode = null;
  let mentionList = [];
  let mentionIndex = 0;
  // 兜底：列表一直晾着会挡视线，10 秒没人动它就自己收起来
  const MENTION_IDLE_MS = 10000;
  let mentionIdleTimer = null;
  // true = 刚插过一个素材，列表还挂着但不再吃方向键 / 回车（回车照常换行）
  let mentionStale = false;

  function mentionPicking(box) {
    return mentionBox === box && Boolean(mentionEl) && !mentionStale;
  }

  function armMentionIdle() {
    if (mentionIdleTimer) window.clearTimeout(mentionIdleTimer);
    mentionIdleTimer = null;
    if (!mentionEl) return;
    mentionIdleTimer = window.setTimeout(checkMentionIdle, MENTION_IDLE_MS);
  }

  function checkMentionIdle() {
    mentionIdleTimer = null;
    if (!mentionEl) return;
    // 鼠标停在列表上（正在挑素材）就不算没人动
    if (mentionEl.matches(':hover')) {
      armMentionIdle();
      return;
    }
    closeMention();
  }

  function kindOfTag(tag) {
    const text = String(tag || '');
    if (text.indexOf('快速视频') === 0) return 'quick';
    if (text.indexOf('视频') === 0) return 'video';
    if (text.indexOf('音频') === 0) return 'audio';
    return 'image';
  }

  // 提示词框里的内容 → 存盘文本（胶囊还原成 @[图1]）
  // 换行两种都认：手动插的 <br>，以及浏览器回车产生的 <div>/<p> 块。
  function promptTextOf(box) {
    let out = '';
    const blockTags = { DIV: 1, P: 1, LI: 1, SECTION: 1, ARTICLE: 1 };
    box.childNodes.forEach((child, index) => {
      if (child.nodeType === 3) {
        out += child.nodeValue;
        return;
      }
      if (child.nodeType !== 1) return;
      if (child.classList && child.classList.contains('mention')) {
        out += '@[' + (child.dataset.tag || '') + ']';
        return;
      }
      if (child.tagName === 'BR') {
        out += '\n';
        return;
      }
      // 块级元素自己就是一行：前面补一个换行（第一个块除外）
      if (blockTags[child.tagName] && index > 0 && out && !out.endsWith('\n')) out += '\n';
      out += child.innerText != null ? child.innerText : child.textContent || '';
    });
    return out;
  }

  // 给人看的时候：@[图1] 写成 @图1
  function displayText(text) {
    return String(text || '').replace(/@\[([^\]\n]+)\]/g, (all, tag) => '@' + tag);
  }

  // 手打的「@图1 / @视频1 / @音频1」也认：只认这张卡片上真实存在的编号，
  // 转成内部写法 @[图1]，这样素材条、生成请求都能带上它
  function normalizeMentions(node, text) {
    const live = new Set(refItemsOf(node).map((item) => item.tag));
    return String(text || '').replace(/@(快速视频|图|视频|音频)(\d+)/g, (all, kind, num) => {
      const tag = kind + num;
      return live.has(tag) ? '@[' + tag + ']' : all;
    });
  }

  // 这张卡片身上还连着的素材，编号就是素材条上的编号
  function refItemsOf(node) {
    // 快速视频不用连线：@ 列表直接列出画布上所有能用的素材
    if (node.type === 'quick') return quickPoolOf(node);
    if (!((ROLES[node.type] || []).length)) return [];
    return rolePlan(node)
      .filter((item) => item.source)
      .map((item) => ({
        tag: item.tag,
        kind: item.kind,
        // 连进来的快速视频：送接口按视频，但编号 / 配色按「快速视频N」
        numberKind: numberKindOf(item.source) || item.kind,
        role: item.role,
        source: item.source,
        title: String((item.source.data && item.source.data.title) || '').trim(),
        name:
          (item.source.data && item.source.data.text ? displayText(item.source.data.text).trim() : '') ||
          presetOf(item.source.type).label,
      }));
  }

  // 快速视频的素材池：画布上所有已经出结果的图片 / 视频 / 音频 / 快速视频（不含自己和组合）
  // 编号按「图1、图2…视频1…音频1…快速视频1…」排，跟 @ 列表显示的一致，写进提示词也是这个编号
  function quickPoolOf(node) {
    const pool = [];
    // 编号直接用卡片自己的序号，跟编号牌上显示的一致
    nodes.forEach((item) => {
      if (item.id === node.id) return;
      const kind = mediaKindOf(item);
      if (!kind) return;
      const data = item.data || {};
      if (!data.result || !data.result.url) return;
      const tag = tagOf(item);
      if (!tag) return;
      pool.push({
        tag: tag,
        kind: kind,
        // 快速视频按参考视频送过去，但编号仍用自己的「快速视频N」
        numberKind: numberKindOf(item),
        role: 'reference_' + kind,
        source: item,
        title: String(data.title || '').trim(),
        name: displayText(data.text || '').trim() || presetOf(item.type).label,
      });
    });
    return pool;
  }

  // 快速视频当前实际引用的素材：按提示词里出现的 @ 编号取，顺序跟提示词一致
  function quickPickedOf(node) {
    const data = nodeData(node);
    const used = [];
    String(data.text || '').replace(/@\[([^\]\n]+)\]/g, (all, tag) => {
      if (used.indexOf(tag) < 0) used.push(tag);
      return all;
    });
    if (!used.length) return [];
    const pool = quickPoolOf(node);
    const out = [];
    used.forEach((tag) => {
      const hit = pool.find((item) => item.tag === tag);
      if (hit) out.push(hit);
    });
    return out;
  }

  // 提示词变了以后，把「编号 → 卡片」的绑定关系对齐：新出现的记下来，删掉的清掉
  function syncQuickRefs(node) {
    if (node.type !== 'quick') return;
    const data = nodeData(node);
    const used = [];
    String(data.text || '').replace(/@\[([^\]\n]+)\]/g, (all, tag) => {
      if (used.indexOf(tag) < 0) used.push(tag);
      return all;
    });
    const pool = quickPoolOf(node);
    // 编号重排后钥匙会变，这里只清掉「指向已删卡片」的旧记录，其余按当前编号重新绑
    const map = {};
    const old = data.quickRefs && typeof data.quickRefs === 'object' ? data.quickRefs : {};
    Object.keys(old).forEach((tag) => {
      const hit = nodes.find((one) => one.id === old[tag]);
      if (hit) map[tag] = hit.id;
    });
    used.forEach((tag) => {
      const hit = pool.find((item) => item.tag === tag);
      if (hit) map[tag] = hit.source.id;
    });
    if (Object.keys(map).length) data.quickRefs = map;
    else delete data.quickRefs;
  }

  // 从快速视频的提示词里去掉某一条 @ 引用（点了缩略图右上角的 ×）
  function dropQuickRef(node, tag) {
    const data = nodeData(node);
    const token = '@[' + tag + ']';
    if (String(data.text || '').indexOf(token) < 0) return;
    pushHistory();
    if (data.quickRefs && typeof data.quickRefs === 'object') delete data.quickRefs[tag];
    data.text = String(data.text || '')
      .split(token)
      .join('')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    refreshNode(node);
    scheduleSave();
    toast('已从提示词里去掉 @' + tag);
  }

  function makeMention(node, tag) {
    const live = refItemsOf(node).some((item) => item.tag === tag);
    const span = document.createElement('span');
    span.className = 'mention' + (live ? '' : ' broken');
    span.dataset.tag = tag;
    span.dataset.kind = kindOfTag(tag);
    span.contentEditable = 'false';
    span.textContent = tag;
    span.title = live ? '参考素材 ' + tag : '这个素材已经断开或删掉了，先把它连回来';
    return span;
  }

  // 纯文本 → 片段：换行变 <br>，空格原样留在文本节点里（配合 pre-wrap 不会被吞）
  function textFragment(text) {
    const frag = document.createDocumentFragment();
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((line, index) => {
      if (index) frag.appendChild(document.createElement('br'));
      if (line) frag.appendChild(document.createTextNode(line));
    });
    return frag;
  }

  // 把存盘文本里的 @[图1] 还原成胶囊
  function renderPrompt(box, node, text) {
    box.innerHTML = '';
    const source = String(text || '');
    const re = /@\[([^\]\n]+)\]/g;
    let last = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      if (match.index > last) box.appendChild(textFragment(source.slice(last, match.index)));
      box.appendChild(makeMention(node, match[1]));
      last = match.index + match[0].length;
    }
    if (last < source.length) box.appendChild(textFragment(source.slice(last)));
  }

  // 粘贴：自己插入文本节点 + <br>，保住原来的换行和行首空格
  // （直接 execCommand('insertText') 在 contenteditable 里会按 HTML 语义吞掉换行）
  function insertPlainText(box, raw) {
    const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!box.contains(range.commonAncestorContainer)) return false;
    range.deleteContents();
    const frag = textFragment(text);
    const last = frag.lastChild;
    range.insertNode(frag);
    if (last) {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function commitPrompt(node, box) {
    const data = nodeData(node);
    // 手打的 @图1 先统一成内部写法，再存
    const raw = promptTextOf(box);
    const next = normalizeMentions(node, raw);
    if (next === data.text) return;
    pushHistory();
    data.text = next;
    syncQuickRefs(node);
    // 手打的那几个也变成胶囊，跟点选插入的样子一致
    if (next !== raw) renderPrompt(box, node, next);
    paintPromptMetaOf(box.closest('.node'));
    scheduleSave();
    refreshHoverBar(node);
    // 快速视频：@ 增删后，面板里的素材缩略图要跟着变
    if (node.type === 'quick') refreshNode(node);
  }

  // 光标前面刚敲下去的是不是 @
  function atMentionTrigger(box) {
    return Boolean(mentionTokenAt(box));
  }

  // 光标前正在输入的 @ 片段：@ / @图 / @图2 / @视频1 / @音频3
  // 返回 { textNode, start, end, raw, kind, num }，不匹配就返回 null
  function mentionTokenAt(box) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || !box.contains(range.startContainer)) return null;
    const node = range.startContainer;
    if (node.nodeType !== 3) return null;
    const text = node.nodeValue || '';
    const caret = range.startOffset;
    let index = caret - 1;
    while (index >= 0 && text[index] !== '@') {
      const ch = text[index];
      // 片段里只允许「图 / 视 / 频 / 音 / 快 / 速 / 数字」，遇到空格或别的字就不算
      if (!/[图视频音频快速0-9]/.test(ch)) return null;
      index -= 1;
    }
    if (index < 0) return null;
    const raw = text.slice(index, caret);
    const hit = /^@(快速视频|图|视频|音频)?(\d*)$/.exec(raw);
    if (!hit) return null;
    return { textNode: node, start: index, end: caret, raw: raw, kind: hit[1] || '', num: hit[2] || '' };
  }

  const MENTION_KIND = { 图: 'image', 视频: 'video', 音频: 'audio', 快速视频: 'quick' };

  // 按「@ + 类型 + 编号」筛素材
  function filterMentionItems(items, token) {
    if (!token) return items;
    const kind = MENTION_KIND[token.kind] || '';
    return items.filter((item) => {
      if (kind && (item.numberKind || item.kind) !== kind) return false;
      // 只敲了「@快」这种半截类型：按编号前缀先筛一轮
      if (!kind && token.kind) return item.tag.indexOf(token.kind) === 0;
      if (!token.num) return true;
      return item.tag.indexOf((token.kind || '') + token.num) === 0;
    });
  }

  function closeMention() {
    if (mentionIdleTimer) window.clearTimeout(mentionIdleTimer);
    mentionIdleTimer = null;
    if (mentionEl) mentionEl.remove();
    mentionEl = null;
    mentionBox = null;
    mentionNode = null;
    mentionList = [];
    mentionIndex = 0;
  }

  function caretSpot(box) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return { left: rect.left, top: rect.bottom };
    }
    const boxRect = box.getBoundingClientRect();
    return { left: boxRect.left + 14, top: boxRect.top + 10 };
  }

  function paintMentionIndex() {
    if (!mentionEl) return;
    Array.from(mentionEl.querySelectorAll('.mention-item')).forEach((el, index) => {
      el.classList.toggle('active', index === mentionIndex);
    });
  }

  // 列表里的一行：缩略图 + 编号 + 标题（+ 提示词小字）
  function buildMentionItem(node, box, item, active) {
    const button = document.createElement('button');
    button.className = 'mention-item' + (active ? ' active' : '');
    button.type = 'button';
    button.dataset.kind = item.numberKind || item.kind;
    const thumbBox = document.createElement('span');
    thumbBox.className = 'mention-thumb';
    thumbBox.appendChild(refThumbOf(item));
    const tag = document.createElement('span');
    tag.className = 'ref-tag';
    tag.textContent = item.tag;
    const name = document.createElement('span');
    name.className = 'mention-name';
    // 缩略图后面先显示素材标题，没有标题时才退回提示词开头
    const heading = item.title || item.name;
    name.textContent = heading;
    name.title = item.title && item.name ? item.name : heading;
    const textBox = document.createElement('span');
    textBox.className = 'mention-text';
    textBox.appendChild(name);
    button.appendChild(thumbBox);
    button.appendChild(tag);
    button.appendChild(textBox);
    if (item.title && item.name && item.name !== item.title) {
      const sub = document.createElement('span');
      sub.className = 'mention-sub';
      sub.textContent = item.name;
      textBox.appendChild(sub);
    }
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      applyMention(node, box, item.tag);
    });
    return button;
  }

  function openMention(node, box) {
    const token = mentionTokenAt(box);
    const all = refItemsOf(node);
    const items = filterMentionItems(all, token);
    if (!items.length) {
      if (!all.length) {
        toast('这张卡片还没有连素材，先把素材连过来再引用');
      } else if (token && token.kind) {
        toast('这张卡片上没有「@' + token.kind + (token.num || '') + '」对应的素材');
      } else if (token && token.num) {
        toast('没有编号是「' + token.num + '」的素材');
      }
      return;
    }
    closeMention();
    mentionBox = box;
    mentionNode = node;
    mentionList = items;
    mentionIndex = 0;
    mentionStale = false;

    const panel = document.createElement('div');
    panel.className = 'mention-panel';
    const hint = document.createElement('div');
    hint.className = 'mention-hint';
    hint.textContent = token && (token.kind || token.num)
      ? '找到 ' + items.length + ' 个（↑↓ 选择，回车插入）'
      : '插入参考素材（↑↓ 选择，回车插入；选完自动收起，再敲 @ 继续）';
    panel.appendChild(hint);
    items.forEach((item, index) => {
      panel.appendChild(buildMentionItem(node, box, item, index === 0));
    });
    panel.addEventListener('pointermove', armMentionIdle);
    panel.addEventListener('pointerdown', armMentionIdle);
    document.body.appendChild(panel);
    mentionEl = panel;
    armMentionIdle();

    const spot = caretSpot(box);
    const left = Math.min(Math.max(8, spot.left), Math.max(8, window.innerWidth - panel.offsetWidth - 10));
    const top = Math.min(Math.max(8, spot.top + 6), Math.max(8, window.innerHeight - panel.offsetHeight - 10));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  // 在已经打开的列表里换筛选条件：不重建面板，免得每次敲字都闪一下
  function refreshMention(node, box) {
    armMentionIdle();
    mentionStale = false;
    const token = mentionTokenAt(box);
    const all = refItemsOf(node);
    const items = filterMentionItems(all, token);
    if (!items.length) {
      closeMention();
      return;
    }
    const same =
      mentionList.length === items.length && mentionList.every((item, index) => items[index].tag === item.tag);
    if (same) return;
    mentionList = items;
    mentionIndex = 0;
    if (!mentionEl) {
      openMention(node, box);
      return;
    }
    // 只换列表项与提示文字，面板位置保持不动
    Array.from(mentionEl.querySelectorAll('.mention-item')).forEach((el) => el.remove());
    const hint = mentionEl.querySelector('.mention-hint');
    if (hint) {
      hint.textContent = token && (token.kind || token.num)
        ? '找到 ' + items.length + ' 个（↑↓ 选择，回车插入）'
        : '插入参考素材（↑↓ 选择，回车插入；选完自动收起，再敲 @ 继续）';
    }
    items.forEach((item, index) => {
      mentionEl.appendChild(buildMentionItem(node, box, item, index === 0));
    });
  }

  function moveMention(step) {
    if (!mentionList.length) return;
    mentionIndex = (mentionIndex + step + mentionList.length) % mentionList.length;
    paintMentionIndex();
  }

  function chooseMention() {
    const item = mentionList[mentionIndex];
    if (!item || !mentionNode || !mentionBox) return;
    applyMention(mentionNode, mentionBox, item.tag);
  }

  function applyMention(node, box, tag) {
    try {
      if (!refItemsOf(node).some((item) => item.tag === tag)) {
        closeMention();
        toast('这个素材已经不在卡片上了');
        return;
      }
      const sel = window.getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      const span = makeMention(node, tag);
      let placed = false;
      if (range && box.contains(range.startContainer)) {
        // 把光标前正在输入的「@图 / @图2 / @视频1」整段圈进来，连同胶囊一起替换掉
        const token = mentionTokenAt(box);
        if (token) {
          range.setStart(token.textNode, token.start);
          range.setEnd(token.textNode, token.end);
          range.deleteContents();
        }
        if (box.contains(range.startContainer)) {
          range.insertNode(span);
          range.setStartAfter(span);
          range.collapse(true);
          const tail = document.createTextNode(' ');
          range.insertNode(tail);
          range.setStartAfter(tail);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          placed = true;
        }
      }
      if (!placed) {
        box.appendChild(span);
        box.appendChild(document.createTextNode(' '));
      }
      // 选完一个就收起列表，光标停在胶囊后面；要再引用就重新敲 @
      // 同一个素材可以重复 @，所以这里不记「已用过」、也不划掉任何一项
      closeMention();
      box.focus({ preventScroll: true });
      commitPrompt(node, box);
      // 快速视频的引用是「存进卡片」的：记下引用的是哪张卡片，生成时照着取
      if (node.type === 'quick') {
        const data = nodeData(node);
        const picked = refItemsOf(node).find((item) => item.tag === tag);
        if (picked) {
          // 编号和卡片的绑定关系记下来，之后画布上增删素材也不会串号
          if (!data.quickRefs || typeof data.quickRefs !== 'object') data.quickRefs = {};
          data.quickRefs[tag] = picked.source.id;
          scheduleSave();
        }
      }
    } catch (error) {
      closeMention();
      toast('插入引用没成功：' + error.message);
    }
  }
  function brokenMentions(node) {
    if (node.type === 'quick') {
      // 快速视频除了按当前编号找，还要认「编号 → 卡片」的绑定记录：
      // 跨电脑复制画布后编号变了，只要卡还在，就不算失效
      const data = nodeData(node);
      const pool = quickPoolOf(node);
      const saved = data.quickRefs && typeof data.quickRefs === 'object' ? data.quickRefs : {};
      const live = new Set(pool.map((item) => item.tag));
      const found = [];
      String(data.text || '').replace(/@\[([^\]\n]+)\]/g, (all, tag) => {
        if (live.has(tag)) return all;
        if (quickRefSourceOf(node, tag, pool, saved)) {
          live.add(tag);
          return all;
        }
        if (found.indexOf(tag) < 0) found.push(tag);
        return all;
      });
      return found;
    }
    const live = new Set(refItemsOf(node).map((item) => item.tag));
    const found = [];
    String(nodeData(node).text || '').replace(/@\[([^\]\n]+)\]/g, (all, tag) => {
      if (!live.has(tag) && found.indexOf(tag) < 0) found.push(tag);
      return all;
    });
    return found;
  }

  // ===== 组合：一张卡代表一组素材，拉一条线就把整组接过去 =====
  // 组里的卡片还是画布上原来的卡片，只是被「登记」进组合；
  // 目标卡片收素材时会自动把组合摊开成里面的一张张卡片。

  // 组合里还存在的成员卡片，顺序就是当初加进来的顺序；组合里不再套组合
  function groupMembersOf(group) {
    const list = group && group.data && Array.isArray(group.data.members) ? group.data.members : [];
    const seen = new Set();
    const out = [];
    list.forEach((id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const node = byId(id);
      if (node && node.type !== 'group') out.push(node);
    });
    return out;
  }

  function groupNameOf(group) {
    const text = group && group.data && group.data.text ? displayText(group.data.text).trim() : '';
    return text || '组合';
  }

  // 这张卡片被登记在哪些组合里
  function groupsOf(nodeId) {
    return nodes.filter(
      (node) =>
        node.type === 'group' &&
        node.data &&
        Array.isArray(node.data.members) &&
        node.data.members.indexOf(nodeId) >= 0
    );
  }

  // 当前选中的卡片，摊平成真正的素材卡片（选中的组合会摊开成组里的卡片）
  function selectedCards() {
    const seen = new Set();
    const out = [];
    const push = (card) => {
      if (!card || card.type === 'group' || card.type === 'schedule' || seen.has(card.id)) return;
      seen.add(card.id);
      out.push(card);
    };
    nodes.forEach((node) => {
      if (!selection.has(node.id)) return;
      if (node.type === 'group') groupMembersOf(node).forEach(push);
      else push(node);
    });
    return out;
  }

  // 复制 / 粘贴时，组合里指向的卡片一并换成新复制出来的那份
  function remapGroupMembers(copies, map) {
    copies.forEach((copy) => {
// 快速视频：再制 / 粘贴卡片时，如果它 @ 的素材刚好也有一份新副本，引用要跟到新的那张上
      if (copy.type === 'quick' && copy.data && copy.data.quickRefs && typeof copy.data.quickRefs === 'object') {
        const next = {};
        Object.keys(copy.data.quickRefs).forEach((tag) => {
          const id = copy.data.quickRefs[tag];
          next[tag] = map.get(id) || id;
        });
        copy.data.quickRefs = next;
      }
      if (copy.type === 'schedule' && copy.data && Array.isArray(copy.data.members)) {
        const sched = copy.data.schedule && typeof copy.data.schedule === 'object' ? copy.data.schedule : null;
        const perCard = sched && sched.perCard ? sched.perCard : {};
        const snapshots = sched && sched.snapshots ? sched.snapshots : {};
        const nextPer = {};
        const nextSnap = {};
        const nextMembers = [];
        copy.data.members.forEach((id) => {
          const hit = map.get(id) || id;
          if (nextMembers.indexOf(hit) < 0) nextMembers.push(hit);
          if (perCard[id] !== undefined) nextPer[hit] = perCard[id];
          if (snapshots[id]) nextSnap[hit] = snapshots[id];
        });
        copy.data.members = nextMembers;
        copy.data.order = Array.isArray(copy.data.order)
          ? copy.data.order.map((id) => map.get(id) || id).filter((id) => nextMembers.indexOf(id) >= 0)
          : nextMembers.slice();
        if (sched) {
          sched.perCard = nextPer;
          sched.snapshots = nextSnap;
        }
        return;
      }
      if (copy.type !== 'group' || !copy.data || !Array.isArray(copy.data.members)) return;
      copy.data.members = copy.data.members.map((id) => map.get(id) || id);
    });
  }

  // ===== 定时生成组：把多张视频卡片排好队，到点由本地后台自动生成 =====
  // 组卡片本身不参与连线，只负责「管」组里的视频卡片；
  // 配置（成员 / 时间 / 快照）存在卡片数据里，跟着画布导出；
  // 运行状态由后台单独记账，刷新页面、关掉浏览器都不会丢。

  const SCHEDULE_TYPES = { video: 1, quick: 1 };
  // 紧凑模式：面积缩成四分之一 = 线性缩一半
  const SCHEDULE_COMPACT_SCALE = 0.5;
  let scheduleRuns = new Map();
  let scheduleTimer = null;
  let scheduleSyncTimer = null;
  let memberSchedule = new Map();

  function isSchedule(node) {
    return Boolean(node && node.type === 'schedule');
  }

  function scheduleMembersOf(node) {
    const data = nodeData(node);
    const seen = new Set();
    const out = [];
    (Array.isArray(data.members) ? data.members : []).forEach((id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const member = byId(id);
      if (member && SCHEDULE_TYPES[member.type]) out.push(member);
    });
    return out;
  }

  function scheduleOrderOf(node) {
    const data = nodeData(node);
    const map = new Map(scheduleMembersOf(node).map((member) => [member.id, member]));
    const out = [];
    (Array.isArray(data.order) ? data.order : []).forEach((id) => {
      const member = map.get(id);
      if (!member) return;
      out.push(member);
      map.delete(id);
    });
    map.forEach((member) => out.push(member));
    return out;
  }

  function scheduleSort(cards) {
    return cards.slice().sort((a, b) => {
      const rank = (node) => (node.type === 'quick' ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.y - b.y || a.x - b.x;
    });
  }

  // 每张视频卡片属于哪个定时组、排第几：卡片右上角要挂一个橙色序号
  function refreshScheduleMemberMap() {
    memberSchedule = new Map();
    nodes.forEach((node) => {
      if (!isSchedule(node)) return;
      const compact = Boolean(nodeData(node).compact);
      scheduleOrderOf(node).forEach((member, index) => {
        if (memberSchedule.has(member.id)) return;
        memberSchedule.set(member.id, { scheduleId: node.id, index: index + 1, compact: compact });
      });
    });
  }

  function scheduleCandidates(cards) {
    const taken = new Set();
    nodes.forEach((node) => {
      if (!isSchedule(node)) return;
      (nodeData(node).members || []).forEach((id) => taken.add(id));
    });
    const pool = Array.isArray(cards) ? cards : nodes.filter((node) => selection.has(node.id));
    return pool.filter((node) => {
      if (!SCHEDULE_TYPES[node.type]) return false;
      if (isHidden(node) || isLocked(node)) return false;
      return !taken.has(node.id);
    });
  }

  function stampToLocalInput(ms) {
    const d = new Date(Number(ms) || Date.now());
    const pad = (value) => String(value).padStart(2, '0');
    return (
      d.getFullYear() +
      '-' + pad(d.getMonth() + 1) +
      '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) +
      ':' + pad(d.getMinutes())
    );
  }

  function localInputToStamp(value) {
    const stamp = new Date(String(value || '')).getTime();
    return Number.isFinite(stamp) ? stamp : 0;
  }

  function clockText(ms) {
    const value = Number(ms) || 0;
    if (!value) return '--:--';
    const d = new Date(value);
    const pad = (item) => String(item).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function countdownText(ms) {
    const gap = Number(ms) - Date.now();
    if (!Number.isFinite(gap)) return '';
    if (gap <= 0) return '马上';
    const total = Math.round(gap / 1000);
    const min = Math.floor(total / 60);
    const sec = total % 60;
    if (min >= 60) return Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分';
    return min ? min + ' 分 ' + sec + ' 秒' : sec + ' 秒';
  }

  // 冻存一张卡片此刻的提示词 / 模型 / 参数 / 参考素材，到点就照这份跑
  function snapshotOfMember(member) {
    const data = nodeData(member);
    const options = modelsFor(member.type);
    const hit =
      options.find((item) => item.id === data.model && (!data.channelId || item.channelId === data.channelId)) ||
      options.find((item) => item.id === data.model);
    const params = data.params || {};
    return {
      prompt: displayText(data.text || '').trim(),
      promptRaw: String(data.text || ''),
      channelId: data.channelId || '',
      channelName: (hit && hit.channel) || '',
      model: data.model || '',
      params: {
        size: params.size || '',
        ratio: params.ratio || '',
        count: Number(params.count) || 1,
        duration: Number(params.duration) || 0,
        resolution: params.resolution || '',
        // C5：快照只记卡片上的原值，模式归一到装配时统一做（rules.assemble）。
        // 这里曾经把空值写死成 'reference'，与单卡那条「原样传空串」的规则分叉。
        mode: String(params.mode || ''),
      },
      refs: refsForApi(member),
      tailPrompt: data.tailPrompt ? { ...data.tailPrompt } : undefined,
      at: Date.now(),
    };
  }

  // 备用模型：最多 3 个，按顺序在主模型失败后自动切换
  function frozenBackups(list) {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((item) => {
      if (!item || !item.model || out.length >= 3) return;
      const key = String(item.channelId || '') + '::' + String(item.model || '');
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        key: key,
        model: String(item.model || ''),
        channelId: String(item.channelId || ''),
        channelName: String(item.channelName || item.channel || ''),
        note: String(item.note || ''),
        label: String(item.label || '') || String(item.model || ''),
      });
    });
    return out;
  }

  function refreshScheduleSnapshots(node, quiet) {
    const data = nodeData(node);
    const snapshots = {};
    scheduleOrderOf(node).forEach((member) => {
      snapshots[member.id] = snapshotOfMember(member);
    });
    data.schedule.snapshots = snapshots;
    data.schedule.backupSnapshots = frozenBackups(data.schedule.backups);
    scheduleSave();
    if (!quiet) {
      refreshNode(node);
      toast('已刷新快照：组里 ' + Object.keys(snapshots).length + ' 张卡片按现在的提示词和模型生成');
    }
    return snapshots;
  }

  // 组框的固定留白：顶部标题栏 + 内边距
  const SCHEDULE_HEAD_H = 48;
  const SCHEDULE_PAD = 18;
  const SCHEDULE_GAP = 26;
  // 组内卡片统一按这个格子显示（16:9），整齐好看；紧凑模式缩一半
  const SCHEDULE_CELL_W = 480;
  const SCHEDULE_CELL_H = 270;
  const SCHEDULE_LAYOUT_VERSION = 2;

  // 2 张 2 列、3~4 张 2 列、5~9 张 3 列、10~16 张 4 列，再多就按平方根往下排
  function scheduleGrid(count) {
    const cols = count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : count <= 16 ? 4 : Math.ceil(Math.sqrt(count));
    return { cols: cols, rows: Math.max(1, Math.ceil(count / cols)) };
  }

  // 把组里的卡片摆进组框：组是一个大容器，卡片就在框里面，格子大小完全一致
  function layoutScheduleCards(node, cards, moveSelf) {
    const data = nodeData(node);
    const members = cards.slice();
    const cell = scheduleCellSize(Boolean(data.compact));
    if (!members.length) {
      node.w = Math.max(node.w || 0, 420);
      node.h = Math.max(node.h || 0, 260);
      return;
    }
    const anchorX = Math.round(node.x);
    const anchorY = Math.round(node.y);
    const grid = scheduleGrid(members.length);
    node.w = Math.round(SCHEDULE_PAD * 2 + grid.cols * cell.w + (grid.cols - 1) * SCHEDULE_GAP);
    node.h = Math.round(SCHEDULE_HEAD_H + SCHEDULE_PAD * 2 + grid.rows * cell.h + (grid.rows - 1) * SCHEDULE_GAP);
    node.x = anchorX;
    node.y = anchorY;
    data.container = true;
    data.layoutVersion = SCHEDULE_LAYOUT_VERSION;
    members.forEach((card, index) => {
      const col = index % grid.cols;
      const row = Math.floor(index / grid.cols);
      card.x = Math.round(anchorX + SCHEDULE_PAD + col * (cell.w + SCHEDULE_GAP));
      card.y = Math.round(anchorY + SCHEDULE_HEAD_H + SCHEDULE_PAD + row * (cell.h + SCHEDULE_GAP));
    });
  }

  // 紧凑模式：卡片缩成四分之一面积（线性一半），组框跟着收紧
  function setScheduleCompact(node, on) {
    const data = nodeData(node);
    if (Boolean(data.compact) === Boolean(on)) return;
    pushHistory();
    data.compact = Boolean(on);
    refreshScheduleMemberMap();
    layoutScheduleCards(node, scheduleOrderOf(node), true);
    renderAll();
    selection.clear();
    selection.add(node.id);
    refreshSelection();
    scheduleSave();
    toast(on ? '已切成紧凑模式：组里的卡片缩成四分之一' : '已恢复正常大小');
  }

  function createScheduleGroup(cards, dropped) {
    const picked = scheduleSort(cards);
    if (picked.length < 2) {
      toast('至少选两张视频卡片才能创建定时生成组');
      return null;
    }
    pushHistory();
    let originX = Infinity;
    let originY = Infinity;
    picked.forEach((card) => {
      originX = Math.min(originX, card.x);
      originY = Math.min(originY, card.y);
    });
    if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
      originX = 80;
      originY = 80;
    }
    const startAt = Math.round((Date.now() + 60000) / 60000) * 60000;
    const data = {
      text: '',
      model: '',
      params: {},
      sized: true,
      container: true,
      compact: false,
      members: picked.map((card) => card.id),
      order: picked.map((card) => card.id),
      schedule: {
        startAt: startAt,
        intervalSec: 120,
        mode: 'stagger',
        perCard: {},
        concurrency: 2,
        snapshots: {},
        backups: [],
        backupSnapshots: [],
      },
    };
    picked.forEach((card, index) => {
      data.schedule.perCard[card.id] = startAt + index * 120000;
      data.schedule.snapshots[card.id] = snapshotOfMember(card);
    });
    const node = {
      id: uid('n'),
      type: 'schedule',
      x: Math.round(originX),
      y: Math.round(originY),
      w: 360,
      h: 260,
      data: data,
      createdAt: Date.now(),
    };
    nodes.push(node);
    refreshScheduleMemberMap();
    layoutScheduleCards(node, picked, false);
    refreshScheduleMemberMap();
    renderAll();
    selection.clear();
    selection.add(node.id);
    setExpanded(node.id);
    refreshSelection();
    keepViewportAnchored();
    scheduleSave();
    toast(
      '已创建定时生成组：' + picked.length + ' 张视频卡片' +
        (dropped > 0 ? '，其他 ' + dropped + ' 张卡片已自动移出' : '') +
        '。点组中间的设置窗口按计划生成'
    );
    return node;
  }

  function relayoutSchedule(node) {
    const members = scheduleOrderOf(node);
    if (!members.length) {
      toast('这个定时组里还没有视频卡片');
      return;
    }
    pushHistory();
    const sorted = scheduleSort(members);
    const data = nodeData(node);
    data.order = sorted.map((member) => member.id);
    data.members = sorted.map((member) => member.id);
    refreshScheduleMemberMap();
    layoutScheduleCards(node, sorted, true);
    refreshScheduleMemberMap();
    renderAll();
    selection.clear();
    selection.add(node.id);
    refreshSelection();
    scheduleSave();
    toast('已重新排版：快速视频排在前面，卡片按网格摆进组里');
  }

  // 把一张卡片从定时组里摘出去，它留在原地变成普通卡片
  function removeScheduleMember(node, member, quiet, noHistory) {
    const data = nodeData(node);
    const list = Array.isArray(data.members) ? data.members.slice() : [];
    const at = list.indexOf(member.id);
    if (at < 0) return false;
    if (!noHistory) pushHistory();
    list.splice(at, 1);
    data.members = list;
    data.order = (Array.isArray(data.order) ? data.order : []).filter((id) => id !== member.id);
    if (data.schedule && data.schedule.perCard) delete data.schedule.perCard[member.id];
    if (data.schedule && data.schedule.snapshots) delete data.schedule.snapshots[member.id];
    if (!list.length) {
      // 最后一张也走了：组框没有意义，直接收掉
      nodes = nodes.filter((item) => item.id !== node.id);
      if (expandedId === node.id) expandedId = null;
      selection.delete(node.id);
      try {
        window.api.forgetSchedule(node.id).catch(() => {});
      } catch (error) {
        /* 记录清不掉也不挡移除 */
      }
      scheduleRuns.delete(node.id);
    } else {
      refreshScheduleMemberMap();
      layoutScheduleCards(node, scheduleOrderOf(node), true);
    }
    refreshScheduleMemberMap();
    renderAll();
    refreshSelection();
    scheduleSave();
    if (!quiet) {
      toast(list.length ? '已把「' + (tagOf(member) || '视频') + '」移出定时组，卡片留在画布上' : '组里的卡片都移出去了，定时组已自动解散');
    }
    return true;
  }

  // 卡片中心是否还在组框里面
  function memberInside(host, member) {
    if (!host || !member) return false;
    const size = sizeOf(member);
    const cx = member.x + size.w / 2;
    const cy = member.y + size.h / 2;
    return cx > host.x && cx < host.x + host.w && cy > host.y && cy < host.y + host.h;
  }

  let memberSlotEl = null;

  // 拖动组内卡片时：原位置留一个虚线空槽，拖出组框时组框换成警示色
  function paintMemberDrag(member, host) {
    if (!memberSlotEl) {
      memberSlotEl = document.createElement("div");
      memberSlotEl.className = "sched-slot";
      worldEl.appendChild(memberSlotEl);
    }
    const size = sizeOf(member);
    const order = scheduleOrderOf(host);
    const index = order.findIndex((item) => item.id === member.id);
    const slot = memberSlotPos(host, index, order.length);
    memberSlotEl.style.width = size.w + "px";
    memberSlotEl.style.height = size.h + "px";
    memberSlotEl.style.zIndex = String(zIndexOf(host) + 1);
    memberSlotEl.style.left = slot.x + "px";
    memberSlotEl.style.top = slot.y + "px";
    const hostEl = elements.get(host.id);
    if (hostEl) hostEl.classList.toggle("member-leaving", !memberInside(host, member));
  }

  function clearMemberDrag() {
    if (memberSlotEl) {
      memberSlotEl.remove();
      memberSlotEl = null;
    }
    elements.forEach((el) => el.classList.remove("member-leaving"));
  }

  // 第 index 个格子的左上角坐标
  function memberSlotPos(host, index, total) {
    const data = nodeData(host);
    const cell = scheduleCellSize(Boolean(data.compact));
    const grid = scheduleGrid(Math.max(1, total));
    const col = index % grid.cols;
    const row = Math.floor(index / grid.cols);
    return {
      x: Math.round(host.x + SCHEDULE_PAD + col * (cell.w + SCHEDULE_GAP)),
      y: Math.round(host.y + SCHEDULE_HEAD_H + SCHEDULE_PAD + row * (cell.h + SCHEDULE_GAP)),
    };
  }

  // 松手还在组里：滑回原来的格子，序号和顺序都不动
  function snapMemberBack(member, host) {
    const order = scheduleOrderOf(host);
    const index = order.findIndex((item) => item.id === member.id);
    const slot = memberSlotPos(host, index, order.length);
    const el = elements.get(member.id);
    clearMemberDrag();
    const same = Math.abs(member.x - slot.x) < 1 && Math.abs(member.y - slot.y) < 1;
    if (!el || same) {
      renderAll();
      selection.clear();
      selection.add(member.id);
      refreshSelection();
      scheduleSave();
      return;
    }
    el.classList.add("sched-snapback");
    el.style.left = slot.x + "px";
    el.style.top = slot.y + "px";
    member.x = slot.x;
    member.y = slot.y;
    setTimeout(() => {
      if (el) el.classList.remove("sched-snapback");
      renderAll();
      selection.clear();
      selection.add(member.id);
      refreshSelection();
      scheduleSave();
    }, 190);
  }


  function dissolveSchedule(node) {
    if (!node) return;
    if (isLocked(node)) {
      toast('这个定时组已锁定，先按 Ctrl+L 解锁再解散');
      return;
    }
    pushHistory();
    const data = nodeData(node);
    const members = scheduleOrderOf(node);
    // 解散时保留组内的排列顺序：按同样的网格重新摊开，不会跳回建组前的位置
    if (members.length) {
      let cellW = 0;
      let cellH = 0;
      members.forEach((member) => {
        const size = rawSizeOf(member);
        cellW = Math.max(cellW, size.w);
        cellH = Math.max(cellH, size.h);
      });
      const grid = scheduleGrid(members.length);
      const originX = Math.round(node.x + SCHEDULE_PAD);
      const originY = Math.round(node.y + SCHEDULE_HEAD_H + SCHEDULE_PAD);
      members.forEach((member, index) => {
        const col = index % grid.cols;
        const row = Math.floor(index / grid.cols);
        const size = rawSizeOf(member);
        member.x = Math.round(originX + col * (cellW + SCHEDULE_GAP) + (cellW - size.w) / 2);
        member.y = Math.round(originY + row * (cellH + SCHEDULE_GAP) + (cellH - size.h) / 2);
      });
    }
    data.members = [];
    data.order = [];
    try {
      window.api.forgetSchedule(node.id).catch(() => {});
    } catch (error) {
      /* 后台记录清不掉也不挡解散 */
    }
    scheduleRuns.delete(node.id);
    nodes = nodes.filter((item) => item.id !== node.id);
    if (expandedId === node.id) expandedId = null;
    selection.delete(node.id);
    refreshScheduleMemberMap();
    renderAll();
    refreshSelection();
    scheduleSave();
    toast('已解散定时组，组里的卡片按原来的顺序留在画布上');
  }

  // 一键把组里生成好的视频导出到本地，有标题的卡片直接用标题当文件名
  async function exportScheduleVideos(node) {
    if (!node) return;
    if (exporting) {
      toast('上一次导出还没结束，稍等一下');
      return;
    }
    const members = scheduleOrderOf(node);
    if (!members.length) {
      toast('这个定时组里还没有视频卡片');
      return;
    }
    const items = [];
    const used = new Set();
    let skipped = 0;
    members.forEach((member, index) => {
      const data = nodeData(member);
      const result = data && data.result;
      const rel = result ? assetRelOf(result) : '';
      const kind = result ? result.kind || presetOf(member.type).media : '';
      if (!rel || kind !== 'video') {
        skipped += 1;
        return;
      }
      const title = String(data.title || '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/, '')
        .trim();
      let base = title || tagOf(member) || '视频' + (index + 1);
      base = base.slice(0, 80) || '视频' + (index + 1);
      let name = base;
      let seq = 2;
      while (used.has(name.toLowerCase())) {
        name = base + '-' + seq;
        seq += 1;
      }
      used.add(name.toLowerCase());
      items.push({ file: rel, name: name });
    });
    if (!items.length) {
      toast('组里还没有生成好的视频，先点「开始」跑完再来导出');
      return;
    }
    exporting = true;
    try {
      toast('请在弹出的窗口里选择保存位置…');
      const pickedRes = await fetch('/api/export/pick-dir', { method: 'POST' });
      const pickedData = await pickedRes.json();
      if (!pickedRes.ok) throw new Error(pickedData && pickedData.error ? pickedData.error : '打开选择窗口失败');
      if (pickedData.cancelled || !pickedData.path) {
        toast('已取消导出');
        return;
      }
      toast('正在导出 ' + items.length + ' 个视频…', 4000);
      const res = await fetch('/api/export/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items, destDir: pickedData.path }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out && out.error ? out.error : '导出失败');
      const okCount = (out.saved || []).length;
      const failCount = (out.failed || []).length;
      if (!okCount) {
        toast('导出失败：' + ((out.failed && out.failed[0] && out.failed[0].error) || '视频没能复制过去'), 5000);
        return;
      }
      const notes = [];
      if (skipped) notes.push('跳过 ' + skipped + ' 个还没生成好的');
      if (failCount) notes.push(failCount + ' 个失败');
      toast('已导出 ' + okCount + ' 个视频到 ' + out.dir + (notes.length ? '，' + notes.join('，') : ''), 7000);
    } catch (error) {
      toast('导出失败：' + ((error && error.message) || '请稍后再试'));
    } finally {
      exporting = false;
    }
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    for (let step = 0; step < 60 && saving; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    dirty = false;
    try {
      const result = await window.api.saveCanvas(
        canvasId,
        { nodes: collectNodes(), edges: edges, viewport: viewport },
        canvasRev
      );
      if (result && Number.isInteger(result.rev)) canvasRev = result.rev;
      lastSavedAt = Date.now();
      lastSaveError = '';
      setSaveState('saved');
    } catch (error) {
      dirty = true;
      // 冲突要单独说清楚：这是一次「前置检查」式的保存（比如启动定时组之前必须先存住），
      // 调用方看到这个标记就知道该停下来，而不是当成磁盘写不进去
      if (error && error.status === 409 && error.data && error.data.conflict) {
        handleSaveConflict(error.data);
        const conflict = new Error('这块画布在另一个窗口被改过了，先处理一下再继续');
        conflict.conflict = true;
        throw conflict;
      }
      lastSaveError = (error && error.message) || String(error);
      setSaveState('error');
      throw error;
    }
  }

  async function startSchedule(node) {
    const data = nodeData(node);
    const members = scheduleOrderOf(node);
    if (members.length < 2) {
      toast('组里至少要有两张视频卡片才能开始');
      return;
    }
    const empty = members.filter((member) => !String(nodeData(member).text || '').trim());
    if (empty.length) {
      toast('有 ' + empty.length + ' 张卡片还没写提示词，先补上再开始');
      return;
    }
    if (Number(data.schedule.startAt) <= Date.now()) {
      data.schedule.startAt = Date.now() + 5000;
      toast('开始时间已经过了，改成 5 秒后开始');
    }
    refreshScheduleSnapshots(node, true);
    try {
      await flushSave();
    } catch (error) {
      toast('保存画布失败，先没能开始：' + error.message);
      return;
    }
    try {
      const res = await window.api.startSchedule(node.id, { canvasId: canvasId, startAt: data.schedule.startAt });
      scheduleRuns.set(node.id, res.schedule);
      refreshNode(node);
      paintScheduleState(node, res.schedule);
      toast(
        '定时组已开始：共 ' + members.length + ' 张，' +
          (data.schedule.mode === 'perCard' ? '按每张自己定的时间' : '每 ' + (Number(data.schedule.intervalSec) || 0) + ' 秒一张') +
          '，' + scheduleConcurrencyText(data.schedule.concurrency) +
          (frozenBackups(data.schedule.backups).length ? '，失败会自动切换备用模型' : '')
      );
    } catch (error) {
      toast('没能开始：' + error.message);
    }
  }

  async function pauseSchedule(node) {
    try {
      const res = await window.api.pauseSchedule(node.id);
      scheduleRuns.set(node.id, res.schedule);
      refreshNode(node);
      paintScheduleState(node, res.schedule);
      toast('定时组已暂停：已经提交的会继续跑完');
    } catch (error) {
      toast('暂停失败：' + error.message);
    }
  }

  async function stopSchedule(node) {
    try {
      const res = await window.api.stopSchedule(node.id);
      scheduleRuns.set(node.id, res.schedule);
      refreshNode(node);
      paintScheduleState(node, res.schedule);
      toast('定时组已停止：还没提交的已取消');
    } catch (error) {
      toast('停止失败：' + error.message);
    }
  }

  // 组卡片正面：名字、状态、进度、组里每张的缩略图和序号
  // 定时组正面：顶上一条组头（名字 / 状态 / 按钮），下面是空的，组里的卡片直接摆在框里
  function buildScheduleBody(node) {
    const data = nodeData(node);
    const wrap = document.createElement('div');
    wrap.className = 'schedule-body';

    const head = document.createElement('div');
    head.className = 'schedule-head';
    const title = document.createElement('span');
    title.className = 'schedule-title';
    title.textContent = String(data.text || '').trim() || '定时生成组';
    title.title = '点一下打开组设置；按住拖动可以移动整个组';
    let titleDown = null;
    title.addEventListener('pointerdown', (event) => {
      titleDown = { x: event.clientX, y: event.clientY };
    });
    title.addEventListener('click', (event) => {
      event.stopPropagation();
      // 拖完松手不算点击，免得拖动组之后顺手弹出设置窗口
      if (titleDown && Math.abs(event.clientX - titleDown.x) + Math.abs(event.clientY - titleDown.y) > 5) {
        titleDown = null;
        return;
      }
      titleDown = null;
      selectNode(node.id, false);
      setExpanded(node.id);
    });
    head.appendChild(title);

    const count = document.createElement('span');
    count.className = 'schedule-count';
    const members = scheduleOrderOf(node);
    count.textContent = members.length
      ? members.length + ' 张 · ' + scheduleConcurrencyText(data.schedule.concurrency)
      : '空';
    head.appendChild(count);

    const state = document.createElement('span');
    state.className = 'schedule-state';
    state.textContent = '未开始';
    head.appendChild(state);

    const backupTags = frozenBackups(data.schedule ? data.schedule.backups : []);
    if (backupTags.length) {
      const chip = document.createElement('span');
      chip.className = 'schedule-backup-chip';
      chip.textContent = '备用 ' + backupTags.length;
      chip.title = '主模型失败后依次尝试：' + backupTags.map((one, index) => '备用 ' + (index + 1) + ' ' + (one.label || one.model)).join(' → ');
      head.appendChild(chip);
    }

    const tools = document.createElement('div');
    tools.className = 'schedule-tools';
    const tool = (label, tip, run) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'schedule-tool';
      button.textContent = label;
      button.title = tip;
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        run();
      });
      tools.appendChild(button);
      return button;
    };
    tool(data.compact ? '正常大小' : '紧凑模式', data.compact ? '恢复卡片原本大小' : '组里的卡片缩成四分之一，方便一次看很多张', () =>
      setScheduleCompact(node, !data.compact)
    );
    tool('导出', '把组里生成好的视频导出到本地，有标题的用标题当文件名', () => exportScheduleVideos(node));
    tool('设置', '打开组设置：时间、生成方式、备用模型', () => {
      selectNode(node.id, false);
      setExpanded(node.id);
    });
    head.appendChild(tools);
    wrap.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'schedule-meta';
    const progress = document.createElement('span');
    progress.className = 'schedule-progress';
    progress.textContent = members.length ? members.length + ' 张视频' : '还没有视频卡片';
    const next = document.createElement('span');
    next.className = 'schedule-next';
    meta.appendChild(progress);
    meta.appendChild(next);
    wrap.appendChild(meta);

    if (!members.length) {
      const empty = document.createElement('div');
      empty.className = 'schedule-empty';
      empty.textContent = '选中两张以上视频卡片，右键「创建定时生成组」';
      wrap.appendChild(empty);
    }
    return wrap;
  }

  function buildScheduleOrderBadge(node) {
    const badge = document.createElement('div');
    badge.className = 'schedule-order';
    const hit = memberSchedule.get(node.id);
    if (!hit) {
      badge.classList.add('none');
      return badge;
    }
    badge.textContent = String(hit.index);
    badge.title = '定时生成组里的第 ' + hit.index + ' 张';
    return badge;
  }

  function scheduleFieldBox(label, input) {
    const wrap = document.createElement('label');
    wrap.className = 'schedule-field';
    const text = document.createElement('span');
    text.textContent = label;
    wrap.appendChild(text);
    wrap.appendChild(input);
    return wrap;
  }

  function buildSchedulePanel(node, data) {
    const box = document.createElement('div');
    box.className = 'schedule-panel';

    const head = document.createElement('div');
    head.className = 'node-panel-head';
    const dot = document.createElement('div');
    dot.className = 'dot';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = '定时生成组';
    const close = document.createElement('button');
    close.className = 'icon-btn';
    close.type = 'button';
    close.textContent = '×';
    close.title = '解散这个定时组：组里的卡片会留在画布上';
    close.addEventListener('pointerdown', (event) => event.stopPropagation());
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      dissolveSchedule(node);
    });
    head.appendChild(dot);
    head.appendChild(title);
    head.appendChild(close);
    box.appendChild(head);

    const sched = data.schedule;

    const name = document.createElement('input');
    name.className = 'group-name';
    name.type = 'text';
    name.placeholder = '给这个定时组起个名字（可选）';
    name.value = String(data.text || '');
    name.addEventListener('pointerdown', (event) => event.stopPropagation());
    name.addEventListener('change', () => {
      const next = name.value.trim();
      if (next === data.text) return;
      pushHistory();
      data.text = next;
      scheduleSave();
      refreshNode(node);
    });
    box.appendChild(name);

    const fields = document.createElement('div');
    fields.className = 'schedule-fields';

    const startInput = document.createElement('input');
    startInput.type = 'datetime-local';
    startInput.className = 'schedule-input';
    startInput.value = stampToLocalInput(sched.startAt);
    startInput.addEventListener('change', () => {
      const stamp = localInputToStamp(startInput.value);
      if (!stamp) return;
      pushHistory();
      sched.startAt = stamp;
      scheduleSave();
    });
    fields.appendChild(scheduleFieldBox('开始时间', startInput));

    const modeSelect = document.createElement('select');
    modeSelect.className = 'schedule-input';
    [['stagger', '错峰：按间隔一张张来'], ['perCard', '逐张：每张各定时间']].forEach((pair) => {
      const opt = document.createElement('option');
      opt.value = pair[0];
      opt.textContent = pair[1];
      if (sched.mode === pair[0]) opt.selected = true;
      modeSelect.appendChild(opt);
    });
    modeSelect.addEventListener('change', () => {
      pushHistory();
      sched.mode = modeSelect.value === 'perCard' ? 'perCard' : 'stagger';
      if (sched.mode === 'perCard') {
        scheduleOrderOf(node).forEach((member, index) => {
          if (!Number(sched.perCard[member.id])) {
            sched.perCard[member.id] = (Number(sched.startAt) || Date.now()) + index * (Number(sched.intervalSec) || 0) * 1000;
          }
        });
      }
      scheduleSave();
      refreshNode(node);
    });
    fields.appendChild(scheduleFieldBox('生成方式', modeSelect));

    const gapInput = document.createElement('input');
    gapInput.type = 'number';
    gapInput.min = '0';
    gapInput.step = '10';
    gapInput.className = 'schedule-input';
    gapInput.value = String(Number(sched.intervalSec) || 0);
    gapInput.disabled = sched.mode === 'perCard';
    gapInput.addEventListener('change', () => {
      const value = Math.max(0, Math.round(Number(gapInput.value) || 0));
      gapInput.value = String(value);
      pushHistory();
      sched.intervalSec = value;
      scheduleSave();
    });
    fields.appendChild(scheduleFieldBox('每张间隔（秒）', gapInput));

    const concSelect = document.createElement('select');
    concSelect.className = 'schedule-input';
    const concNow = normalizeScheduleConcurrency(sched.concurrency);
    for (let value = 1; value <= 10; value += 1) {
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = value + ' 张';
      if (concNow === value) opt.selected = true;
      concSelect.appendChild(opt);
    }
    const unlimitedOpt = document.createElement('option');
    unlimitedOpt.value = '0';
    unlimitedOpt.textContent = '不限制';
    if (concNow === 0) unlimitedOpt.selected = true;
    concSelect.appendChild(unlimitedOpt);
    concSelect.addEventListener('change', () => {
      pushHistory();
      sched.concurrency = normalizeScheduleConcurrency(concSelect.value);
      scheduleSave();
      refreshNode(node);
    });
    fields.appendChild(scheduleFieldBox('同时生成', concSelect));
    box.appendChild(fields);
    const concHint = document.createElement('div');
    concHint.className = 'schedule-conc-hint';
    concHint.textContent = '选「不限制」会一次性提交所有到点的卡片，可能触发接口限流或产生较多费用。';
    box.appendChild(concHint);

    const videoModels = modelsFor('video');
    const backupBox = document.createElement('div');
    backupBox.className = 'schedule-backups';
    const backupHead = document.createElement('div');
    backupHead.className = 'schedule-backups-head';
    backupHead.textContent = '备用模型（最多 3 个，按顺序自动切换）';
    backupBox.appendChild(backupHead);
    if (!videoModels.length) {
      const none = document.createElement('div');
      none.className = 'schedule-backup-hint';
      none.textContent = '还没有可用的视频模型，先到「接口通道设置」里配置';
      backupBox.appendChild(none);
    } else {
      const saved = Array.isArray(sched.backups) ? sched.backups : [];
      for (let seat = 0; seat < 3; seat += 1) {
        const row = document.createElement('div');
        row.className = 'schedule-backup-row';
        const label = document.createElement('span');
        label.className = 'schedule-backup-label';
        label.textContent = '备用 ' + (seat + 1);
        row.appendChild(label);
        const select = document.createElement('select');
        select.className = 'schedule-input schedule-backup-select';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '不使用';
        select.appendChild(blank);
        const current = saved[seat];
        const currentKey = current
          ? String(current.key || (String(current.channelId || '') + '::' + String(current.model || '')))
          : '';
        videoModels.forEach((item) => {
          const opt = document.createElement('option');
          opt.value = item.key;
          opt.textContent = item.label;
          const tips = [];
          if (item.channel) tips.push('来自通道：' + item.channel);
          if (item.note) tips.push('备注：' + item.note);
          if (tips.length) opt.title = tips.join(' ｜ ');
          if (currentKey && item.key === currentKey) opt.selected = true;
          select.appendChild(opt);
        });
        select.addEventListener('pointerdown', (event) => event.stopPropagation());
        select.addEventListener('change', () => {
          pushHistory();
          const list = Array.isArray(sched.backups) ? sched.backups.slice(0, 3) : [];
          while (list.length < 3) list.push(null);
          const hit = videoModels.find((item) => item.key === select.value);
          list[seat] = hit
            ? {
                key: hit.key,
                model: hit.id,
                channelId: hit.channelId || '',
                channelName: hit.channel || '',
                note: hit.note || '',
                label: hit.label,
              }
            : null;
          // 同一个模型 + 同一个通道重复选没有意义，自动把另一格让出来
          if (hit) {
            for (let other = 0; other < list.length; other += 1) {
              if (other === seat || !list[other]) continue;
              const otherKey = String(list[other].key || (String(list[other].channelId || '') + '::' + String(list[other].model || '')));
              if (otherKey !== hit.key) continue;
              list[other] = null;
              toast('备用 ' + (other + 1) + ' 和备用 ' + (seat + 1) + ' 是同一个模型，已自动去掉重复的那个');
            }
          }
          // 空着的格子不写进配置：备用按顺序补位，导出备份里也不会留一堆 null
          sched.backups = list.filter(Boolean);
          // 配置变了，旧的冻结清单作废，下次点开始 / 刷新快照时重新冻
          sched.backupSnapshots = [];
          scheduleSave();
          refreshNode(node);
        });
        row.appendChild(select);
        backupBox.appendChild(row);
      }
      const hint = document.createElement('div');
      hint.className = 'schedule-backup-hint';
      hint.textContent = '主模型失败才会切换；切换会重新提交，可能产生额外费用。每次重试前等 5 秒。';
      backupBox.appendChild(hint);
    }
    box.appendChild(backupBox);

    const members = scheduleOrderOf(node);
    const list = document.createElement('div');
    list.className = 'schedule-members';
    if (!members.length) {
      const empty = document.createElement('div');
      empty.className = 'group-empty';
      empty.textContent = '组里还没有视频卡片：选中两张以上视频卡片，右键「创建定时生成组」';
      list.appendChild(empty);
    } else {
      members.forEach((member, index) => {
        const row = document.createElement('div');
        row.className = 'schedule-member';
        const no = document.createElement('span');
        no.className = 'schedule-member-no';
        no.textContent = String(index + 1);
        row.appendChild(no);
        row.appendChild(refThumbOf({ source: member, kind: 'video' }));
        const about = document.createElement('div');
        about.className = 'schedule-member-text';
        const tag = document.createElement('b');
        tag.textContent = tagOf(member) || '视频';
        const text = document.createElement('span');
        text.textContent = displayText(member.data.text || '').trim().slice(0, 30) || '还没写提示词';
        about.appendChild(tag);
        about.appendChild(text);
        row.appendChild(about);
        const runNow = scheduleRuns.get(node.id) || null;
        const itemNow = runNow && Array.isArray(runNow.items)
          ? runNow.items.find((one) => one.nodeId === member.id)
          : null;
        const modelTag = document.createElement('span');
        modelTag.className = 'schedule-member-model';
        if (itemNow && Number(itemNow.backupIndex) > 0) {
          modelTag.classList.add('backup');
          modelTag.textContent = '备用' + Number(itemNow.backupIndex) + ' · ' + (itemNow.model || '');
        } else {
          const snapNow = sched.snapshots && sched.snapshots[member.id] ? sched.snapshots[member.id] : null;
          modelTag.textContent = (itemNow && itemNow.model) || (snapNow && snapNow.model) || '未快照';
        }
        const attempts = itemNow && Array.isArray(itemNow.attempts) ? itemNow.attempts : [];
        if (attempts.length > 1) {
          modelTag.title = attempts
            .map((one) => {
              const at = one.at ? clockText(one.at) + ' ' : '';
              const state = one.status === 'failed' ? '失败' : one.status === 'skipped' ? '跳过' : one.status === 'done' ? '成功' : '尝试';
              return at + (Number(one.index) > 0 ? '备用' + Number(one.index) : '主模型') + '：' + state + (one.error ? '（' + one.error + '）' : '');
            })
            .join('\n');
        }
        row.appendChild(modelTag);
        if (sched.mode === 'perCard') {
          const time = document.createElement('input');
          time.type = 'datetime-local';
          time.className = 'schedule-input schedule-member-time';
          time.value = stampToLocalInput(sched.perCard[member.id] || Number(sched.startAt) || Date.now());
          time.addEventListener('change', () => {
            const stamp = localInputToStamp(time.value);
            if (!stamp) return;
            pushHistory();
            sched.perCard[member.id] = stamp;
            scheduleSave();
          });
          row.appendChild(time);
        }
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'icon-btn';
        jump.textContent = '↗';
        jump.title = '跳到这张卡片';
        jump.addEventListener('pointerdown', (event) => event.stopPropagation());
        jump.addEventListener('click', (event) => {
          event.stopPropagation();
          goToNode(member.id);
        });
        row.appendChild(jump);
        list.appendChild(row);
      });
    }
    box.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'schedule-actions';
    const mk = (label, kind, run, tip) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'schedule-btn' + (kind ? ' ' + kind : '');
      button.textContent = label;
      button.title = tip || label;
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        run();
      });
      actions.appendChild(button);
      return button;
    };
    mk('开始', 'primary', () => startSchedule(node), '到点后按顺序自动提交组里的视频');
    mk('暂停', '', () => pauseSchedule(node), '已经提交的继续跑完，后面的先不提交');
    mk('停止', '', () => stopSchedule(node), '还没提交的直接取消，已经提交的继续跑完');
    mk('刷新快照', '', () => refreshScheduleSnapshots(node), '把每张卡片现在的提示词 / 模型 / 素材冻存一份');
    mk('重新排版', '', () => relayoutSchedule(node), '快速视频排在前面，按 2×2 / 3×3 重新摆好');
    box.appendChild(actions);

    const hint = document.createElement('div');
    hint.className = 'group-hint';
    hint.textContent = '到点后由本地后台自动生成，浏览器关掉也会继续跑。';
    box.appendChild(hint);
    return box;
  }

  // 定时组里的卡片正在生成时，在卡片中间盖一层轻量提示。
  // 只加一层 div，不重建卡片，视频 / 图片元素保持原样，不会黑闪。
  function scheduleLiveBoxOf(memberEl) {
    let box = memberEl.querySelector('.node-status.schedule-live');
    if (box) return box;
    const media = memberEl.querySelector('.node-media');
    if (!media) return null;
    box = document.createElement('div');
    box.className = 'node-status schedule-live';
    const spin = document.createElement('div');
    spin.className = 'st-spin';
    const title = document.createElement('div');
    title.className = 'st-title';
    title.textContent = '正在生成中…';
    const msg = document.createElement('div');
    msg.className = 'st-msg';
    box.appendChild(spin);
    box.appendChild(title);
    box.appendChild(msg);
    media.appendChild(box);
    return box;
  }

  function waitedText(startedAt) {
    const started = Number(startedAt) || 0;
    if (!started) return '';
    const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
    if (!secs) return '';
    if (secs < 60) return '已等待 ' + secs + ' 秒';
    return '已等待 ' + Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒';
  }

  function paintScheduleMemberLive(member, item, run) {
    const memberEl = elements.get(member.id);
    if (!memberEl) return;
    const running = Boolean(item && item.status === 'running');
    let box = memberEl.querySelector('.node-status.schedule-live');
    if (!running) {
      if (box) box.remove();
      memberEl.classList.remove('sched-live');
      return;
    }
    memberEl.classList.add('sched-live');
    box = scheduleLiveBoxOf(memberEl);
    if (!box) return;
    box.classList.add('show', 'running');
    box.classList.remove('error');
    const stage = item.task && item.task.stage ? String(item.task.stage) : '已提交，正在等结果';
    const timeText = waitedText(item.startedAt);
    const title = box.querySelector('.st-title');
    if (title) title.textContent = '正在生成中…';
    const msg = box.querySelector('.st-msg');
    if (msg) {
      const parts = [];
      if (Number.isFinite(Number(item.index))) parts.push('第 ' + (Number(item.index) + 1) + ' 张');
      if (run && run.concurrency !== undefined && run.concurrency !== null) {
        parts.push(scheduleConcurrencyText(run.concurrency));
      }
      parts.push(stage);
      parts.push(timeText);
      msg.textContent = parts.filter(Boolean).join(' · ');
      msg.style.display = msg.textContent ? '' : 'none';
    }
  }

  function paintScheduleState(node, run) {
    const data = nodeData(node);
    const members = scheduleOrderOf(node);
    const items = (run && run.items) || [];
    const state = run && run.state ? run.state : 'idle';
    let stateText = '未开始';
    if (state === 'running') stateText = items.some((one) => one.status === 'running') ? '生成中' : '等待中';
    else if (state === 'paused') stateText = '已暂停';
    else if (state === 'stopped') stateText = '已停止';
    else if (state === 'done') stateText = '已完成';

    const doneCount = items.filter((one) => one.status === 'done').length;
    const failCount = items.filter((one) => one.status === 'failed').length;
    const retrying = items.find((one) => one.status === 'running' && Number(one.backupIndex) > 0) || null;
    const total = items.length || members.length;
    const progressText = total
      ? doneCount + ' / ' + total + (failCount ? '　失败 ' + failCount : '')
      : members.length + ' 张视频';

    let nextText = '';
    if (state === 'running') {
      const running = items.find((one) => one.status === 'running');
      const pending = items
        .filter((one) => one.status === 'pending')
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (running && retrying) {
        nextText = '第 ' + (Number(running.index) + 1) + ' 张改用备用 ' + Number(running.backupIndex) + '（' + (running.model || '') + '）重试';
      } else if (running) {
        const runningCount = items.filter((one) => one.status === 'running').length;
        nextText = runningCount > 1
          ? '正在生成 ' + runningCount + ' 张'
          : '正在生成第 ' + (Number(running.index) + 1) + ' 张';
      } else if (pending) {
        nextText = (Number(pending.backupIndex) > 0 ? '备用 ' + Number(pending.backupIndex) + ' 重试：' : '下一张 ') +
          clockText(pending.dueAt) + '（' + countdownText(pending.dueAt) + '）';
      }
    } else if (state === 'paused') {
      nextText = '已暂停，点「开始」接着跑';
    } else if (state === 'idle') {
      nextText = members.length ? '计划 ' + clockText(data.schedule.startAt) + ' 开始' : '';
    }

    const el = elements.get(node.id);
    if (!el) return;
    const stateEl = el.querySelector('.schedule-state');
    if (stateEl) {
      stateEl.textContent = stateText;
      stateEl.dataset.state = state;
    }
    const progressEl = el.querySelector('.schedule-progress');
    if (progressEl) progressEl.textContent = progressText;
    const nextEl = el.querySelector('.schedule-next');
    if (nextEl) nextEl.textContent = nextText;

    members.forEach((member) => {
      const memberEl = elements.get(member.id);
      if (!memberEl) return;
      const item = items.find((one) => one.nodeId === member.id) || null;
      paintScheduleMemberLive(member, item, run);
      const badge = memberEl.querySelector('.schedule-order');
      if (!badge) return;
      const status = item ? item.status : '';
      badge.classList.toggle('running', status === 'running');
      badge.classList.toggle('done', status === 'done');
      badge.classList.toggle('failed', status === 'failed' || status === 'canceled');
      const onBackup = Boolean(item && Number(item.backupIndex) > 0 && (status === 'running' || status === 'pending'));
      badge.classList.toggle('backup', onBackup);
      if (item && onBackup) {
        badge.title = '主模型失败，正在用备用 ' + Number(item.backupIndex) + '（' + (item.model || '') + '）重试';
      }
    });

    el.querySelectorAll('.schedule-tile').forEach((tile) => {
      const item = items.find((one) => one.nodeId === tile.dataset.member);
      tile.dataset.state = item ? item.status : '';
    });
  }

  // 后台把结果写进了库，前端把成员卡片拉回来刷新一下，不用整块重开画布
  async function syncMemberResults(ids) {
    const wanted = Array.from(new Set(ids.filter(Boolean)));
    if (!wanted.length) return;
    let state = null;
    try {
      state = await window.api.getCanvas(canvasId);
    } catch (error) {
      return;
    }
    const live = new Map((state.nodes || []).map((node) => [node.id, node]));
    let changed = false;
    wanted.forEach((id) => {
      const member = byId(id);
      const source = live.get(id);
      if (!member || !source) return;
      const next = source.data || {};
      const snapshot = (value) => JSON.stringify({
        result: value.result || null,
        error: value.error || '',
        running: Boolean(value.running),
        history: Array.isArray(value.history) ? value.history : [],
        lastSubmission: value.lastSubmission || null,
        retrying: Boolean(value.retrying),
      });
      if (snapshot(member.data) === snapshot(next)) return;
      member.data.result = next.result || null;
      member.data.error = next.error || '';
      member.data.running = Boolean(next.running);
      member.data.taskId = next.taskId || '';
      member.data.progress = next.progress || '';
      member.data.history = Array.isArray(next.history) ? next.history : [];
      member.data.lastSubmission = next.lastSubmission || null;
      member.data.retrying = Boolean(next.retrying);
      refreshNode(member);
      changed = true;
    });
    if (changed) refreshSelection();
  }

  // 清掉已经不成立的「正在生成中」遮罩（跑完、停止、解散、卡片被隐藏都会走到这里）
  function cleanScheduleLive(keep) {
    document.querySelectorAll('.node-status.schedule-live').forEach((box) => {
      const el = box.closest('.node');
      if (!el || !keep.has(el.dataset.id)) {
        box.remove();
        if (el) el.classList.remove('sched-live');
      }
    });
    elements.forEach((el, id) => {
      if (!keep.has(id)) el.classList.remove('sched-live');
    });
  }

  async function pollSchedules() {
    const list = nodes.filter((node) => isSchedule(node) && !isHidden(node));
    let res = null;
    try {
      res = await window.api.schedules(canvasId);
    } catch (error) {
      return;
    }
    const next = new Map();
    (res.schedules || []).forEach((run) => next.set(run.nodeId, run));
    const liveIds = new Set();
    const needSync = [];
    list.forEach((node) => {
      const run = next.get(node.id) || null;
      const prev = scheduleRuns.get(node.id) || null;
      if (run && run.items) {
        run.items.forEach((item) => {
          if (item.status === 'running') liveIds.add(item.nodeId);
          const old = prev && prev.items ? prev.items.find((one) => one.nodeId === item.nodeId) : null;
          const was = old ? old.status : '';
          if (item.status !== was && (item.status === 'done' || item.status === 'failed')) needSync.push(item.nodeId);
        });
      }
      paintScheduleState(node, run);
    });
    cleanScheduleLive(liveIds);
    scheduleRuns = next;
    if (needSync.length) {
      if (scheduleSyncTimer) clearTimeout(scheduleSyncTimer);
      scheduleSyncTimer = setTimeout(() => syncMemberResults(needSync), 400);
    }
  }

  function startSchedulePolling() {
    if (scheduleTimer) clearInterval(scheduleTimer);
    scheduleTimer = setInterval(() => {
      pollSchedules();
    }, 1500);
    pollSchedules();
  }

  // 组合卡片的正面：组名 + 组里素材的缩略图，点缩略图跳到那张卡片
  function buildGroupBody(node) {
    const wrap = document.createElement('div');
    wrap.className = 'group-body';
    const members = groupMembersOf(node);

    const head = document.createElement('div');
    head.className = 'group-head';
    const title = document.createElement('span');
    title.className = 'group-title';
    title.textContent = groupNameOf(node);
    title.title = '点这张卡片可以改名字';
    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = members.length ? members.length + ' 个素材' : '空组合';
    head.appendChild(title);
    head.appendChild(count);
    wrap.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'group-grid';
    if (!members.length) {
      const empty = document.createElement('div');
      empty.className = 'group-empty';
      empty.textContent = '还没有素材：选中几张卡片，右键选「添加组」就能并进来';
      grid.appendChild(empty);
    } else {
      const counters = { image: 0, video: 0, audio: 0, quick: 0 };
      members.forEach((member) => {
        const kind = mediaKindOf(member) || 'image';
        const numberKind = numberKindOf(member) || kind;
        counters[numberKind] += 1;
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'group-tile';
        tile.dataset.kind = numberKind;
        const about = member.data && member.data.text ? displayText(member.data.text).trim().slice(0, 28) : '';
        tile.title = '点一下跳到这张卡片：' + (about || presetOf(member.type).label);
        tile.appendChild(refThumbOf({ source: member, kind: kind }));
        const tag = document.createElement('span');
        tag.className = 'ref-tag';
        // 有编号就用它，老数据才退回「视频1」这种临时顺序号
        tag.textContent = tagOf(member) || (KIND_LABEL[numberKind] || '素材') + counters[numberKind];
        tile.appendChild(tag);
        tile.addEventListener('pointerdown', (event) => event.stopPropagation());
        tile.addEventListener('click', (event) => {
          event.stopPropagation();
          goToNode(member.id);
        });
        grid.appendChild(tile);
      });
    }
    wrap.appendChild(grid);
    return wrap;
  }

  // 组合卡片的编辑面板：改名字、看组里有什么、把某张卡片移出去、解散组合
  function buildGroupPanel(node, data) {
    const box = document.createElement('div');
    box.className = 'group-panel';

    const head = document.createElement('div');
    head.className = 'node-panel-head';
    const dot = document.createElement('div');
    dot.className = 'dot';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = '组合';
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '×';
    del.title = '解散这个组合：组里的卡片会留在画布上，连线还原成各自连出去';
    del.addEventListener('pointerdown', (event) => event.stopPropagation());
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      ungroup(node);
    });
    head.appendChild(dot);
    head.appendChild(title);
    head.appendChild(del);
    box.appendChild(head);

    const name = document.createElement('input');
    name.className = 'group-name';
    name.type = 'text';
    name.placeholder = presetOf('group').placeholder;
    name.value = String(data.text || '').replace(/@\[([^\]\n]+)\]/g, (all, tag) => '@' + tag);
    name.addEventListener('pointerdown', (event) => event.stopPropagation());
    name.addEventListener('change', () => {
      const next = name.value.trim();
      if (next === data.text) return;
      pushHistory();
      data.text = next;
      scheduleSave();
      refreshNode(node);
    });
    box.appendChild(name);

    const members = groupMembersOf(node);
    const list = document.createElement('div');
    list.className = 'node-refs group-members';
    if (!members.length) {
      const empty = document.createElement('div');
      empty.className = 'ref-empty';
      empty.textContent = '组里还没有卡片，选中要放的卡片再右键「添加组」';
      list.appendChild(empty);
    } else {
      const row = document.createElement('div');
      row.className = 'ref-row';
      const counters = { image: 0, video: 0, audio: 0, quick: 0 };
      members.forEach((member) => {
        const numberKind = numberKindOf(member) || 'image';
        counters[numberKind] += 1;
        row.appendChild(
          buildGroupMemberTile(node, member, tagOf(member) || (KIND_LABEL[numberKind] || '素材') + counters[numberKind])
        );
      });
      list.appendChild(row);
    }
    box.appendChild(list);

    const hint = document.createElement('div');
    hint.className = 'group-hint';
    hint.textContent = '从这张卡片右侧的圆点拉一条线到图片 / 视频卡片，组里的素材就会一起送过去。';
    box.appendChild(hint);

    return box;
  }

  function buildGroupMemberTile(group, member, tagText) {
    const tile = document.createElement('div');
    tile.className = 'ref-tile';
    const kind = mediaKindOf(member) || 'image';
    tile.dataset.kind = numberKindOf(member) || kind;
    const about = member.data && member.data.text ? displayText(member.data.text).trim() : '';
    tile.title = (about ? about.slice(0, 40) : presetOf(member.type).label) + '（点右上角 × 从组合里移出去）';
    tile.appendChild(refThumbOf({ source: member, kind: kind }));
    const tag = document.createElement('span');
    tag.className = 'ref-tag';
    tag.textContent = tagText || presetOf(member.type).label;
    tile.appendChild(tag);
    const unlink = document.createElement('button');
    unlink.className = 'icon-btn';
    unlink.type = 'button';
    unlink.textContent = '×';
    unlink.title = '从组合里移出去（卡片还留在画布上）';
    unlink.addEventListener('pointerdown', (event) => event.stopPropagation());
    unlink.addEventListener('click', (event) => {
      event.stopPropagation();
      pushHistory();
      group.data.members = group.data.members.filter((id) => id !== member.id);
      refreshNode(group);
      scheduleSave();
      toast('已从组合里移出去');
    });
    tile.appendChild(unlink);
    tile.addEventListener('pointerdown', (event) => event.stopPropagation());
    tile.addEventListener('click', (event) => {
      event.stopPropagation();
      goToNode(member.id);
    });
    return tile;
  }

  // 这些卡片原来直接连出去的线，改成从组合出去（组内部互相连的不动）
  function absorbMemberEdges(group, members) {
    const ids = new Set(members.map((member) => member.id));
    const inside = new Set(groupMembersOf(group).map((member) => member.id));
    const targets = [];
    edges.forEach((edge) => {
      if (!ids.has(edge.sourceId)) return;
      if (inside.has(edge.targetId)) return;
      if (targets.indexOf(edge.targetId) < 0) targets.push(edge.targetId);
    });
    if (!targets.length) return;
    edges = edges.filter((edge) => !(ids.has(edge.sourceId) && targets.indexOf(edge.targetId) >= 0));
    targets.forEach((targetId) => {
      if (edges.some((edge) => edge.sourceId === group.id && edge.targetId === targetId)) return;
      edges.push({ id: uid('e'), sourceId: group.id, targetId: targetId, role: '' });
    });
  }

  // 成组卡片优先放在素材组的左边；如果那个位置在屏幕外，就在当前视野里找一片空位，
  // 保证不移动画面也能马上看到新建的组合
  function groupSpotInView(preferred, w, h) {
    const pad = 24;
    const left = -viewport.x / viewport.zoom + pad;
    const top = -viewport.y / viewport.zoom + pad;
    const right = (viewportEl.clientWidth - viewport.x) / viewport.zoom - pad - w;
    const bottom = (viewportEl.clientHeight - viewport.y) / viewport.zoom - pad - h;
    const maxX = Math.max(left, right);
    const maxY = Math.max(top, bottom);
    const startX = clamp(Math.round(preferred.x), left, maxX);
    const startY = clamp(Math.round(preferred.y), top, maxY);
    for (let step = 0; step <= 14; step += 1) {
      const tries = step === 0
        ? [{ x: startX, y: startY }]
        : [
            { x: startX + step * 32, y: startY },
            { x: startX - step * 32, y: startY },
            { x: startX, y: startY + step * 32 },
            { x: startX, y: startY - step * 32 },
          ];
      for (const spot of tries) {
        if (spot.x < left || spot.y < top || spot.x > maxX || spot.y > maxY) continue;
        const blocked = nodes.some((item) => {
          const other = sizeOf(item);
          const overlapW = Math.min(spot.x + w, item.x + other.w) - Math.max(spot.x, item.x);
          const overlapH = Math.min(spot.y + h, item.y + other.h) - Math.max(spot.y, item.y);
          return overlapW > 0 && overlapH > 0 && (overlapW * overlapH) / (w * h) > 0.5;
        });
        if (!blocked) return spot;
      }
    }
    return { x: startX, y: startY };
  }

  function createGroup(cards) {
    const size = defaultSize('group', null);
    const minX = Math.min.apply(null, cards.map((card) => card.x));
    const minY = Math.min.apply(null, cards.map((card) => card.y));
    // 组合卡片放在这组素材左边一点，一眼看出它是这一堆的代表
    const spot = groupSpotInView({ x: Math.round(minX - size.w - 48), y: Math.round(minY) }, size.w, size.h);
    const group = {
      id: uid('n'),
      type: 'group',
      x: spot.x,
      y: spot.y,
      w: size.w,
      h: size.h,
      data: {
        text: '',
        model: '',
        params: {},
        sized: true,
        members: cards.map((card) => card.id),
      },
      createdAt: Date.now(),
    };
    nodes.push(group);
    absorbMemberEdges(group, cards);
    renderAll();
    selection.clear();
    selection.add(group.id);
    setExpanded(group.id);
    refreshSelection();
    keepViewportAnchored();
    scheduleSave();
    const targets = edges.filter((edge) => edge.sourceId === group.id).length;
    toast(
      '已把 ' + cards.length + ' 张卡片加成一个组' + (targets ? '，原来的连线也并到组上了' : '，从组上拉一条线就行')
    );
    return group;
  }

  function addMembersToGroup(group, cards) {
    const add = cards.filter((card) => card.type !== 'group' && groupMembersOf(group).indexOf(card) < 0);
    if (!add.length) return;
    pushHistory();
    add.forEach((card) => {
      // 一张卡片只待在一个组合里，先从别的组合里摘出去
      groupsOf(card.id).forEach((other) => {
        if (other.id === group.id) return;
        other.data.members = other.data.members.filter((id) => id !== card.id);
      });
      if (group.data.members.indexOf(card.id) < 0) group.data.members.push(card.id);
    });
    absorbMemberEdges(group, add);
    renderAll();
    selection.clear();
    selection.add(group.id);
    setExpanded(group.id);
    refreshSelection();
    scheduleSave();
    toast('已经放进「' + groupNameOf(group) + '」，现在有 ' + groupMembersOf(group).length + ' 个素材');
  }

  // 把选中的卡片合出一个新组合；选中的如果正好是一个组合，就把别的卡片并进去
  function groupSelection() {
    const picked = nodes.filter((node) => selection.has(node.id));
    const groupPicked = picked.filter((node) => node.type === 'group');
    const cards = selectedCards();
    if (groupPicked.length === 1 && cards.length) {
      if (groupMembersOf(groupPicked[0]).length + cards.length < 2) {
        toast('至少两张卡片才能加成一个组');
        return;
      }
      addMembersToGroup(groupPicked[0], cards);
      return;
    }
    if (cards.length < 2) {
      toast('至少选两张卡片才能加成一个组（按住 Shift 点选，或者按住 Ctrl 在空白处拖框选）');
      return;
    }
    pushHistory();
    createGroup(cards);
  }

  // 组合没了以后，从组合出去的线要还给组里的每一张卡片
  function relinkGroupEdges(group) {
    const members = groupMembersOf(group);
    const outgoing = edges.filter((edge) => edge.sourceId === group.id);
    const added = [];
    outgoing.forEach((edge) => {
      members.forEach((member) => {
        if (member.id === edge.targetId) return;
        if (added.indexOf(member.id + '>' + edge.targetId) >= 0) return;
        added.push(member.id + '>' + edge.targetId);
        if (edges.some((item) => item.sourceId === member.id && item.targetId === edge.targetId)) return;
        edges.push({ id: uid('e'), sourceId: member.id, targetId: edge.targetId, role: '' });
      });
    });
    edges = edges.filter((edge) => edge.sourceId !== group.id);
  }

  // 解散组合：组合卡片消失，卡片留在画布上，连线还原
  function ungroup(group) {
    if (!group) return;
    if (isLocked(group)) {
      toast('这个组合已锁定，先按 Ctrl+L 解锁再解散');
      return;
    }
    pushHistory();
    relinkGroupEdges(group);
    nodes = nodes.filter((node) => node.id !== group.id);
    if (expandedId === group.id) expandedId = null;
    selection.delete(group.id);
    renderAll();
    refreshSelection();
    scheduleSave();
    toast('已解散组合，卡片都留在画布上');
  }

  function buildPrompt(node, data, preset, el) {
    const box = document.createElement('div');
    box.className = 'node-prompt';
    // 锁定的卡片：提示词只能看，不能改
    const locked = isLocked(node);
    box.contentEditable = locked ? 'false' : 'true';
    // 锁定也要能点进去看长提示词（只读，不会改内容）
    if (locked) {
      box.tabIndex = 0;
      box.setAttribute('aria-readonly', 'true');
      box.title = '卡片已锁定：提示词只能看，按 Ctrl+L 解锁后才能修改';
    }
    box.spellcheck = false;
    box.dataset.placeholder = preset.placeholder;
    renderPrompt(box, node, data.text);
    // 平时矮一点，点进去自动长高；这张卡片手动调过高度的，一直按它自己的高度
    applyPromptHeight(box, node);
    box.addEventListener('focus', () => {
      if (mentionBox && mentionBox !== box) closeMention();
      editingId = node.id;
      el.classList.add('editing');
      // 点进来就长高，几千字的提示词一眼能看一大段
      applyPromptHeight(box, node);
      requestPlacePanel();
      schedulePromptCaretFollow(box);
    });
    box.addEventListener('blur', () => {
      rememberPromptScroll(node, box);
      // 没手动调过的才收回默认高度，几十张卡片排在一起还是整整齐齐
      applyPromptHeight(box, node, false);
      requestPlacePanel();
      if (editingId !== node.id) return;
      editingId = null;
      el.classList.remove('editing');
      commitPrompt(node, box);
    });
    box.addEventListener('input', () => {
      const meta = el.querySelector('.prompt-meta');
      if (meta) schedulePromptMeta(meta, box);
      schedulePromptCaretFollow(box);
      if (atMentionTrigger(box)) {
        if (mentionBox === box && mentionEl) refreshMention(node, box);
        else openMention(node, box);
        return;
      }
      // 选完素材以后继续正常打字，列表照样留着（点画布 / 点别的卡片 / 闲置 10 秒才收）；
      // 只有正在挑素材时把那个 @ 删掉了，才顺手收起来
      if (mentionBox === box && !mentionStale) closeMention();
    });
    box.addEventListener('scroll', () => rememberPromptScroll(node, box), { passive: true });
    box.addEventListener('keydown', (event) => {
      if (mentionPicking(box)) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveMention(1);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveMention(-1);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          chooseMention();
          return;
        }
      }
      if (mentionBox === box && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMention();
        return;
      }
      if (event.key === 'Escape') box.blur();
    });
    box.addEventListener('paste', (event) => {
      event.preventDefault();
      const raw = (event.clipboardData || window.clipboardData).getData('text/plain') || '';
      insertPlainText(box, raw);
    });
    return box;
  }

  // 卡片大小默认贴着媒体比例走，用户手动拉过之后就不再自动改
  function fitNodeToAspect(node, ratio) {
    if (!ratio || !Number.isFinite(ratio) || ratio <= 0) return;
    if (memberSchedule.get(node.id)) return;
    if (nodeData(node).sized) return;
    const width = node.w || presetOf(node.type).w;
    const height = Math.max(MIN_H, Math.round(width / ratio));
    if (Math.abs(height - node.h) < 2) return;
    node.h = height;
    const el = elements.get(node.id);
    if (el) el.style.height = height + 'px';
    updateEdgePaths([node]);
    scheduleSave();
  }

  function buildParams(node, data) {
    const wrap = document.createElement('div');
    wrap.className = 'node-params';
    const defs = paramDefsOf(node, data);
    defs.forEach((def) => {
      const button = document.createElement('button');
      button.className = 'param-chip';
      button.type = 'button';
      button.dataset.key = def.key;
      button.title = '点击选择' + def.label;
      button.textContent = def.label + ' · ' + paramText(def, data.params[def.key]);
      if (isLocked(node)) {
        button.disabled = true;
        button.title = '卡片已锁定，先解锁才能改参数';
      }
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const rect = button.getBoundingClientRect();
        openMenu(
          rect.left,
          rect.bottom + 4,
          def.options.map((value, index) => ({
            label: (def.texts && def.texts[index]) || value,
            run: () => {
              pushHistory();
              data.params[def.key] = value;
              button.textContent = def.label + ' · ' + paramText(def, value);
              // 换比例时，卡片默认跟着变形成对应比例（手动拉过大小就不动）
              if (def.key === 'ratio' && !data.sized) {
                const size = defaultSize(node.type, data.params);
                node.w = size.w;
                node.h = size.h;
                const cardEl = elements.get(node.id);
                if (cardEl) {
                  cardEl.style.width = size.w + 'px';
                  cardEl.style.height = size.h + 'px';
                }
                updateEdgePaths([node]);
              }
              scheduleSave();
              // 模式会影响素材的用途（首帧 / 尾帧），换模式后要把素材条重画一遍
              if (def.key === 'mode') refreshNode(node);
            },
          }))
        );
      });
      wrap.appendChild(button);
    });
    return wrap;
  }

  function buildActions(node, data) {
    const wrap = document.createElement('div');
    wrap.className = 'node-actions';
    const status = document.createElement('div');
    status.className = 'task-state';
    status.textContent = taskStateText(data);

    if (node.type === 'video' || node.type === 'quick') {
      const tail = document.createElement('button');
      tail.className = 'btn-tail';
      tail.type = 'button';
      tail.textContent = '提取尾帧';
      tail.title = '抽出这段视频的最后一帧，生成一张图片卡片';
      if (isLocked(node)) {
        tail.disabled = true;
        tail.title = '卡片已锁定，先解锁再操作';
      }
      tail.addEventListener('pointerdown', (event) => event.stopPropagation());
      tail.addEventListener('click', (event) => {
        event.stopPropagation();
        startTailFrame(node);
      });
      wrap.appendChild(status);
      wrap.appendChild(tail);
    } else {
      wrap.appendChild(status);
    }

    const run = document.createElement('button');
    run.className = 'primary btn-run' + (data.running ? ' cancel' : '');
    run.type = 'button';
    run.textContent = data.running ? '取消生成' : '生成';
    run.title = data.running ? '这次不生成，取消掉' : '按上面的设置开始生成';
    if (isLocked(node) && !data.running) {
      run.disabled = true;
      run.title = '卡片已锁定，先按 Ctrl+L 解锁再生成';
    }
    run.addEventListener('pointerdown', (event) => event.stopPropagation());
    run.addEventListener('click', (event) => {
      event.stopPropagation();
      if (nodeData(node).running) cancelGenerate(node);
      else startGenerate(node);
    });
    wrap.appendChild(run);
    return wrap;
  }

  function taskStateText(data) {
    if (data.running) {
      const text = data.progress || '已提交，正在生成';
      return /[）)。…]$/.test(text) ? text : text + '…';
    }
    if (data.preparing) return data.preparing;
    if (data.error) return '上次失败：' + data.error;
    return '';
  }

  function generateValidationError(node) {
    const data = nodeData(node);
    if (!node || ['image', 'video', 'quick'].indexOf(node.type) < 0) return '这张卡片不能直接生成素材';
    if (isLocked(node)) return '这张卡片已锁定，先按 Ctrl+L 解锁再生成';
    if (data.running) return '这张卡片正在生成，等这一轮结束再操作';
    const broken = brokenMentions(node);
    if (broken.length) {
      return node.type === 'quick'
        ? '提示词里的 @' + broken.join('、@') + ' 在这台电脑上找不到对应素材了，把它从提示词里删掉，或者重新 @ 一张'
        : '提示词里的 @' + broken.join('、@') + ' 已经没有对应素材了，先把它连回来，或者把这段引用删掉';
    }
    // 连线卡片：有素材还没出结果 / 文件读不出来时不悄悄跳过，直接说清楚
    if (node.type !== 'quick') {
      const wanted = rolePlan(node).filter((item) => item.source).length;
      const usable = refsForApi(node).length;
      if (wanted > usable) {
        return (
          '有 ' + (wanted - usable) +
          ' 个连进来的素材还没出结果或读不出来，先等它生成完，或者把连线删掉再生成'
        );
      }
    }
    if (!data.model) return '这张卡片还没有可用模型，请先在启动器的「接口通道设置」里配置';
    if (!String(data.text || '').trim()) return '先写点提示词再生成';
    return '';
  }

  // 单卡、批量、预检都用这一份请求，避免三条路各拼一套参数。
  // 参数规则本身收在 window.CanvasPayloadRules 里，与服务端共用同一份源码 ——
  // 这里只负责把画布上的卡片信息读出来喂给它，不再自己判 mode / count 的默认值。
  function buildGeneratePayload(node) {
    const data = nodeData(node);
    const params = data.params || {};
    const raw = {
      canvasId: canvasId,
      nodeId: node.id,
      nodeType: node.type,
      prompt: displayText(data.text),
      promptRaw: data.text,
      model: data.model,
      channelId: data.channelId || '',
      params: params,
      refs: refsForApi(node),
      tailPrompt: cardTailChoice(node),
    };
    if (typeof rules.assemble === 'function') return rules.assemble(raw);
    // 共享模块没加载上（老页面缓存）时的兜底：规则与共享模块保持一致
    return {
      canvasId: raw.canvasId,
      nodeId: raw.nodeId,
      kind: rules.kindOf(node.type),
      prompt: raw.prompt,
      promptRaw: raw.promptRaw,
      model: raw.model,
      channelId: raw.channelId,
      sizeKey: params.size || '',
      ratio: params.ratio || '',
      count: rules.clampCount(params.count),
      duration: Number(params.duration) || 0,
      resolution: params.resolution || '',
      mode: rules.normalizeMode(node.type, params.mode),
      refs: raw.refs,
      tailPrompt: rules.isTailKind(node.type) ? raw.tailPrompt : { enabled: false, presetId: '' },
    };
  }

  async function checkBeforeGenerate(payload) {
    if (!window.api || typeof window.api.preflight !== 'function') {
      return { ok: false, error: '本机服务没有提供提交前检查，请重启画布服务后再试', warnings: [] };
    }
    try {
      return (await window.api.preflight(payload)) || { ok: false, error: '提交前检查没有返回结果', warnings: [] };
    } catch (error) {
      return { ok: false, error: (error && error.message) || '提交前检查失败', warnings: [] };
    }
  }

  async function startGenerate(node) {
    const data = nodeData(node);
    const invalid = generateValidationError(node);
    if (invalid) {
      toast(invalid);
      return;
    }
    // 快速视频：提示词里没 @ 任何素材就是纯文生，提醒一句但不拦
    if (node.type === 'quick' && !quickPickedOf(node).length) {
      toast('提示词里还没有 @ 素材，这次会按纯文字生成');
    }
    if (data.checking) {
      toast('正在检查参考素材，稍等一下');
      return;
    }
    data.checking = true;
    data.preparing = '正在检查参考素材…';
    updateTaskUi(node);
    try {
      const payload = buildGeneratePayload(node);
      const report = await checkBeforeGenerate(payload);
      if (!report.ok) {
        toast('提交前检查没通过：' + (report.error || '参考素材不可用'), 5000);
        return;
      }
      if (report.warnings && report.warnings.length) {
        toast('检查通过：' + report.warnings.join('；'), 4600);
      }
      await submitGenerate(node, { payload: payload, skipPreflight: true });
    } finally {
      data.checking = false;
      if (data.preparing) {
        data.preparing = '';
        updateTaskUi(node);
        scheduleSave();
      }
    }
  }

  // ===== 生成任务：提交 → 轮询 → 结果回到卡片 =====
  // 轮询只改卡片上的字，不重建整张卡片，免得用户在打字时光标乱跳
  const taskTimers = new Map();

  function stopWatch(nodeId) {
    const timer = taskTimers.get(nodeId);
    if (timer) clearTimeout(timer);
    taskTimers.delete(nodeId);
  }

  // 已经连线的素材，按顺序转成接口要的参考清单。
  // 图片 / 视频 / 音频都会送过去，通道模板里用 {{refs}} 或分类的
  // {{refImages}} / {{refVideos}} / {{refAudios}} 取用，模板没写就不会带上。
  function refsForApi(node) {
    if (node.type === 'quick') return quickRefsForApi(node);
    const plan = rolePlan(node);
    // 首尾帧模式：把首帧排在最前、尾帧紧随其后，接口拿到的顺序就是画面顺序
    const frames = node.type === 'video' && node.data.params.mode === 'frames';
    const ordered = frames
      ? plan
          .slice()
          .sort((a, b) => {
            const rank = (item) => (item.role === 'first_frame' ? 0 : item.role === 'last_frame' ? 1 : 2);
            return rank(a) - rank(b);
          })
      : plan;
    return ordered
      .filter((item) => {
        return item.source && item.source.data && item.source.data.result && item.source.data.result.url;
      })
      .map((item) => ({
        url: item.source.data.result.url,
        kind: item.kind,
        name: item.tag,
        role: item.role,
      }));
  }

  // 快速视频的 @ 素材能不能用：卡在画布上、类型对得上、已经有结果文件
  function quickRefUsable(node, src) {
    if (!src || src.id === node.id) return false;
    const kind = mediaKindOf(src);
    if (!kind) return false;
    const result = src.data && src.data.result;
    return Boolean(result && result.url);
  }

  // 找 @ 编号对应的素材卡：先按当前编号找；编号在这台电脑上对不上时，
  // 用「编号 → 卡片」的绑定记录兜底找回，避免跨电脑复制画布后素材被悄悄丢掉
  function quickRefSourceOf(node, tag, pool, saved) {
    const hit = pool.find((item) => item.tag === tag);
    if (hit && hit.source) return hit.source;
    let src = byId(saved[tag]);
    if (quickRefUsable(node, src)) return src;
    const keys = Object.keys(saved);
    for (let index = 0; index < keys.length; index += 1) {
      src = byId(saved[keys[index]]);
      if (quickRefUsable(node, src) && tagOf(src) === tag) return src;
    }
    return null;
  }

  // 快速视频：只看提示词里 @ 了谁，把对应卡片的结果交给接口；没 @ 就不带素材
  function quickRefsForApi(node) {
    const data = nodeData(node);
    const used = [];
    String(data.text || '').replace(/@\[([^\]\n]+)\]/g, (all, tag) => {
      if (used.indexOf(tag) < 0) used.push(tag);
      return all;
    });
    if (!used.length) return [];
    const pool = quickPoolOf(node);
    const saved = data.quickRefs && typeof data.quickRefs === 'object' ? data.quickRefs : {};
    const out = [];
    const rebound = {};
    used.forEach((tag) => {
      const src = quickRefSourceOf(node, tag, pool, saved);
      if (!src) return;
      const result = src.data && src.data.result;
      if (!result || !result.url) return;
      const kind = mediaKindOf(src);
      out.push({ url: result.url, kind: kind, name: tag, role: 'reference_' + kind });
      rebound[tag] = src.id;
    });
    // 兜底找回过的绑定写回去：下次编号再变，也能跟着同一张卡走
    const oldKeys = Object.keys(saved);
    const changed =
      oldKeys.length !== Object.keys(rebound).length ||
      oldKeys.some((key) => saved[key] !== rebound[key]);
    if (changed) {
      if (Object.keys(rebound).length) data.quickRefs = rebound;
      else delete data.quickRefs;
      scheduleSave();
    }
    return out;
  }

  function isTaskActive(data) {
    return Boolean(data && (data.running || data.preparing));
  }

  function statusKindOf(data) {
    if (data.running) return 'running';
    if (data.preparing) return 'preparing';
    if (data.error) return 'error';
    return '';
  }

  // 「本次提交」那一行的文案：模型 · 尺寸 · N 个参考素材 · 提示词前 20 字。
  // 只在真拿到快照时才有内容；拿不到就返回空串，那一行整个不占位。
  function submitLineOf(data) {
    const meta = data && (data.pendingSubmission || data.lastSubmission);
    if (!meta) return '';
    const params = (meta.params && typeof meta.params === 'object' ? meta.params : {}) || {};
    const parts = [];
    const model = String(meta.model || '').trim();
    if (model) parts.push(model);
    const size = String(params.sizeKey || params.size || '').trim();
    const ratio = String(params.ratio || '').trim();
    if (size || ratio) parts.push([size, ratio].filter(Boolean).join(' '));
    const refCount = Number(meta.refCount) || (Array.isArray(meta.refs) ? meta.refs.length : 0);
    if (refCount > 0) parts.push(refCount + ' 个参考素材');
    const main = String(meta.mainPrompt || meta.submittedPrompt || '').trim().replace(/\s+/g, ' ');
    if (main) parts.push(main.slice(0, 20) + (main.length > 20 ? '…' : ''));
    return parts.join(' · ');
  }

  // 快照的完整明细，点开那一行时用。每条都做成「键：值」，空值跳过。
  function submitDetailOf(data) {
    const meta = data && (data.pendingSubmission || data.lastSubmission);
    if (!meta) return [];
    const params = (meta.params && typeof meta.params === 'object' ? meta.params : {}) || {};
    const rows = [];
    const push = (key, value) => {
      const text = String(value == null ? '' : value).trim();
      if (text) rows.push([key, text]);
    };
    push('模型', meta.model);
    push('尺寸', [params.sizeKey, params.ratio].filter(Boolean).join(' '));
    push('张数', params.count ? params.count + ' 张' : '');
    if (params.duration) push('时长', params.duration + ' 秒');
    if (params.resolution) push('分辨率', params.resolution);
    if (params.mode) push('模式', params.mode);
    if (meta.tailPresetName) push('尾部预设', meta.tailPresetName + (meta.tailAppended ? '（已追加）' : '（未追加）'));
    const main = String(meta.mainPrompt || '').trim();
    if (main) push('主提示词', main);
    const submitted = String(meta.submittedPrompt || '').trim();
    if (submitted && submitted !== main) push('实际发送', submitted);
    const refs = Array.isArray(meta.refs) ? meta.refs : [];
    if (refs.length) {
      push(
        '参考素材',
        refs
          .map((item) => {
            const name = String((item && item.name) || '').trim() || '未命名';
            const kindText = item && item.kind ? '（' + item.kind + '）' : '';
            const roleText = item && item.role ? '［' + item.role + '］' : '';
            return name + kindText + roleText;
          })
          .join('、')
      );
    } else if (Number(meta.refCount) > 0) {
      push('参考素材', Number(meta.refCount) + ' 个');
    }
    if (meta.at) {
      const when = new Date(Number(meta.at));
      if (!isNaN(when.getTime())) push('提交时间', when.toLocaleString());
    }
    return rows;
  }

  // 卡片重建、老数据、异常分支都可能让遮罩丢失：只要有状态就补一层，
  // 不再依赖 buildMedia 一定已经画过 .node-status
  function ensureStatusBox(el, data, node) {
    let box = el.querySelector('.node-status:not(.schedule-live)');
    if (box || !statusKindOf(data)) return box;
    const media = el.querySelector('.node-media');
    if (!media) return null;
    box = buildStatus(data, node);
    media.appendChild(box);
    return box;
  }

  // 只改字和转圈，不重建整张卡片：视频不会黑闪，轮询也不会打断输入
  function paintStatusBox(box, data, node) {
    if (!box) return box;
    const kind = statusKindOf(data);
    if (!kind) {
      box.className = 'node-status';
      box.dataset.kind = '';
      box.textContent = '';
      return box;
    }
    if (box.dataset.kind !== kind) {
      box.className = 'node-status show ' + kind;
      box.dataset.kind = kind;
      box.textContent = '';
      if (kind !== 'error') {
        const spin = document.createElement('div');
        spin.className = 'st-spin';
        box.appendChild(spin);
      }
      const title = document.createElement('div');
      title.className = 'st-title';
      box.appendChild(title);
      const message = document.createElement('div');
      message.className = 'st-msg';
      box.appendChild(message);
      const advice = document.createElement('div');
      advice.className = 'st-advice';
      box.appendChild(advice);
      // 「本次提交」一行：生成中时让用户看清这次到底提交了什么
      const submit = document.createElement('div');
      submit.className = 'st-submit';
      box.appendChild(submit);
      const detail = document.createElement('div');
      detail.className = 'st-submit-detail';
      box.appendChild(detail);
      // 生成中改了参数：轻提示 + 「用新参数再跑一次」按钮
      const changed = document.createElement('div');
      changed.className = 'st-changed';
      const changedText = document.createElement('div');
      changedText.className = 'st-changed-text';
      changed.appendChild(changedText);
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'st-again';
      again.textContent = '用新参数再跑一次';
      changed.appendChild(again);
      box.appendChild(changed);
    }
    const title = box.querySelector('.st-title');
    const message = box.querySelector('.st-msg');
    const advice = box.querySelector('.st-advice');
    const submit = box.querySelector('.st-submit');
    const detail = box.querySelector('.st-submit-detail');
    const changed = box.querySelector('.st-changed');
    let titleText = '生成失败';
    let messageText = data.error || '';
    let adviceText = '';
    if (kind === 'running') {
      titleText = '正在生成中…';
      messageText = data.progress || '已提交，正在等结果';
    } else if (kind === 'preparing') {
      titleText = '正在准备提交…';
      messageText = data.preparing || '正在检查参考素材…';
    } else if (kind === 'error' && data.errorInfo) {
      // 服务端认得出这是哪一类错误时，标题就是那句中文短结论（「通道密钥不对」），
      // message 放平台原文，advice 告诉用户下一步该干什么。
      titleText = data.errorInfo.title || titleText;
      messageText = data.errorInfo.detail || data.error || '';
      adviceText = data.errorInfo.advice || '';
    }
    if (title) title.textContent = titleText;
    if (message) {
      message.textContent = messageText;
      box.classList.toggle('has-msg', Boolean(messageText));
      // 原文太长时只显示两行，点标题看全文（避免把卡片撑得没边）
      box.classList.toggle('long-msg', Boolean(messageText) && String(messageText).length > 60);
    }
    if (advice) {
      advice.textContent = adviceText;
      advice.style.display = adviceText ? '' : 'none';
    }
    // 「本次提交」：只在生成中 / 准备中显示（这是「正在跑的这一版是什么」的答案）；
    // 出错时也该显示，用户才知道是拿什么参数撞的墙。
    if (submit) {
      const line = submitLineOf(data);
      const showLine = Boolean(line) && (kind === 'running' || kind === 'preparing' || kind === 'error');
      submit.textContent = line;
      submit.style.display = showLine ? '' : 'none';
      submit.classList.toggle('clickable', showLine);
    }
    if (detail) {
      const open = box.dataset.detailOpen === '1';
      const rows = open ? submitDetailOf(data) : [];
      detail.textContent = '';
      rows.forEach((row) => {
        const line = document.createElement('div');
        line.className = 'st-submit-row';
        const key = document.createElement('span');
        key.className = 'k';
        key.textContent = row[0] + '：';
        const value = document.createElement('span');
        value.className = 'v';
        value.textContent = row[1];
        line.appendChild(key);
        line.appendChild(value);
        detail.appendChild(line);
      });
      detail.style.display = rows.length ? '' : 'none';
    }
    // 生成期间改了参数：提醒一句，并给个「用新参数再跑一次」的出口。
    // 判定放在这里（而不是各处改动入口）是因为所有改动最终都会走到重绘，
    // 只要对比「当前卡片值」和「冻结快照」就够了，不用在每个输入框上挂钩子。
    if (changed) {
      const diff = node ? submissionDiffOf(node, data) : null;
      const show = Boolean(diff && diff.changed) && (kind === 'running' || kind === 'preparing');
      changed.style.display = show ? '' : 'none';
      if (show) {
        const text = changed.querySelector('.st-changed-text');
        if (text) {
          text.textContent =
            '已改动：' + diff.fields.join('、') + '　·　只影响下次生成，当前任务仍用提交时的版本';
        }
        const again = changed.querySelector('.st-again');
        if (again && !again.dataset.bound) {
          again.dataset.bound = '1';
          again.addEventListener('click', (event) => {
            event.stopPropagation();
            const host = changed.closest('.node');
            const id = host && host.dataset ? host.dataset.id : '';
            const target = id ? nodeById(id) : null;
            if (target && typeof rerunWithNewParams === 'function') rerunWithNewParams(target);
          });
        }
      }
    }
    return box;
  }

  // 对比「当前卡片上的值」与「本次提交冻结的快照」，找出生成期间被改动的项。
  // 只比几样真正会影响结果的：提示词、模型、尺寸/比例/张数/时长/分辨率/模式、参考素材。
  // 返回 { changed, fields } —— fields 是给用户看的中文名列表。
  function submissionDiffOf(node, data) {
    const d = data || (node ? nodeData(node) : null);
    const meta = d && (d.pendingSubmission || d.lastSubmission);
    if (!meta) return null;
    // 只比「当前这一版正在跑」的：pendingSubmission 存在说明是本次提交的那一份
    if (!d.pendingSubmission) return null;
    const fields = [];
    const params = (meta.params && typeof meta.params === 'object' ? meta.params : {}) || {};
    const now = (d.params && typeof d.params === 'object' ? d.params : {}) || {};

    const mainNow = String(d.text || '').trim();
    const mainThen = String(meta.mainPrompt || meta.submittedPrompt || '').trim();
    if (mainNow && mainThen && mainNow !== mainThen) fields.push('提示词');

    const modelNow = String(d.model || '').trim();
    const modelThen = String(meta.model || '').trim();
    if (modelNow !== modelThen) fields.push('模型');

    const cmp = (a, b) => String(a == null ? '' : a) !== String(b == null ? '' : b);
    if (cmp(now.size, params.sizeKey || params.size)) fields.push('尺寸');
    if (cmp(now.ratio, params.ratio)) fields.push('比例');
    if (cmp(now.count, params.count)) fields.push('张数');
    if (cmp(now.duration, params.duration)) fields.push('时长');
    if (cmp(now.resolution, params.resolution)) fields.push('分辨率');

    // 参考素材：按名字 + 类型 + 角色比对（顺序也算，因为首尾帧顺序影响画面）
    const sigOf = (list) =>
      (Array.isArray(list) ? list : [])
        .map((item) => [item && item.name, item && item.kind, item && item.role].join('|'))
        .join('>');
    const refsNow = typeof refsForApi === 'function' ? refsForApi(node) : [];
    if (sigOf(refsNow) !== sigOf(meta.refs)) fields.push('参考素材');

    return { changed: fields.length > 0, fields: fields };
  }

  function nodeById(id) {
    let hit = null;
    nodes.forEach((item) => {
      if (item && item.id === id) hit = item;
    });
    return hit;
  }

  // 「用新参数再跑一次」：不打断当前任务 —— 一张卡片只有一个轮询位，
  // 立刻再提交会把旧任务的轮询顶掉、旧结果就永远回不到卡片上了。
  // 所以这里挂一个「排队」标记，等当前任务出结果（或失败）后自动接着跑。
  function rerunWithNewParams(node) {
    const data = nodeData(node);
    if (data.checking) {
      toast('正在检查参考素材，稍等一下');
      return;
    }
    if (!data.running && !data.preparing) {
      startGenerate(node);
      return;
    }
    if (data.rerunQueued) {
      toast('已经排上了：等这次跑完就自动用新参数再跑一次');
      return;
    }
    data.rerunQueued = true;
    toast('已排上：等这次跑完，自动用新参数再跑一次（两个结果都会留下）', 4600);
    refreshNode(node);
    scheduleSave();
  }

  // 任务收尾时看一眼有没有排队的重跑（成功 / 失败都会走到这里）
  function runQueuedRerun(node) {
    const data = nodeData(node);
    if (!data.rerunQueued) return false;
    data.rerunQueued = false;
    scheduleSave();
    // 放到下一轮事件循环再开跑：让当前这一版的结果先渲染出来，
    // 用户能看见「旧的那版留下了」，再进入新的工作态。
    setTimeout(() => startGenerate(node), 60);
    return true;
  }

  // 点「本次提交」那一行：展开 / 收起完整快照。
  // 状态遮罩本身是 pointer-events:none（不挡画布上的拖拽），只把这一行放出来可点。
  function bindStatusToggle(box) {
    if (!box || box.dataset.bound === '1') return;
    box.dataset.bound = '1';
    box.addEventListener('click', (event) => {
      const line = event.target && event.target.closest ? event.target.closest('.st-submit') : null;
      if (!line || line.style.display === 'none') return;
      event.stopPropagation();
      box.dataset.detailOpen = box.dataset.detailOpen === '1' ? '0' : '1';
      // 展开状态变了，重画一次（paintStatusBox 只认 data，这里借 dataset 传递）
      const host = box.closest('.node');
      if (host && typeof host.__repaintStatus === 'function') host.__repaintStatus();
    });
  }

  function updateTaskUi(node) {
    const el = elements.get(node.id);
    if (!el) return;
    const data = nodeData(node);
    // 生成中 / 准备中：给整张卡片打标记，CSS 会把旧封面和播放条收起来
    const active = isTaskActive(data);
    const wasActive = el.classList.contains('is-generating');
    el.classList.toggle('is-generating', active);
    // 刚进入工作态时把正在播放的旧视频 / 音频停掉：
    // 画面已经藏起来了，声音再继续放会让人以为在放新生成的那条
    if (active && !wasActive) {
      el.querySelectorAll('video, audio').forEach((player) => {
        try {
          if (player && !player.paused) player.pause();
        } catch (error) {
          /* 老浏览器 / 已卸载的播放器，忽略 */
        }
      });
    }
    const box = ensureStatusBox(el, data, node);
    // 「本次提交」那一行点开后要能重画：把节点数据挂到卡片上，供点击回调取用
    el.__repaintStatus = () => {
      const now = elements.get(node.id);
      if (now) paintStatusBox(now.querySelector('.node-status:not(.schedule-live)'), nodeData(node), node);
    };
    bindStatusToggle(box);
    paintStatusBox(box, data, node);
    const state = el.querySelector('.task-state');
    if (state) state.textContent = taskStateText(data);
    const run = el.querySelector('.btn-run');
    if (run) {
      run.textContent = data.running ? '取消生成' : data.preparing ? '准备中…' : '生成';
      run.classList.toggle('cancel', Boolean(data.running));
      run.disabled = Boolean(data.preparing) || (isLocked(node) && !data.running);
      run.title = data.preparing
        ? '正在检查参考素材，稍等一下'
        : data.running
          ? '这次不生成，取消掉'
          : '按上面的设置开始生成';
    }
  }

  async function submitGenerate(node, opts) {
    const options = opts || {};
    const data = nodeData(node);
    const payload = options.payload || buildGeneratePayload(node);
    if (!options.skipPreflight) {
      const report = await checkBeforeGenerate(payload);
      if (!report.ok) {
        if (!options.quiet) toast('提交前检查没通过：' + (report.error || '参考素材不可用'), 5000);
        return { ok: false, error: report.error || '参考素材不可用' };
      }
      if (!options.quiet && report.warnings && report.warnings.length) {
        toast('检查通过：' + report.warnings.join('；'), 4600);
      }
    }
    data.running = true;
    data.preparing = '';
    data.error = '';
    data.progress = '正在提交';
    // 新一轮开始了，之前排的队已经兑现（runQueuedRerun 在开跑前就清掉了），
    // 这里再兜一次底，避免标记残留导致下一轮结束又自动开一次。
    data.rerunQueued = false;
    refreshNode(node);
    scheduleSave();
    try {
      const res = await window.api.generate(payload);
      data.taskId = res.task.id;
      data.progress = res.task.stage || '排队中';
      data.pendingSubmission = submissionMetaOf(
        Object.assign({}, res.submission || {}, {
          model: payload.model,
          // 本次实际送出去的参考素材：卡片上要显示「N 个参考素材」
          refs: refsOfPayload(payload),
          refCount: refsOfPayload(payload).length,
          params: {
            sizeKey: payload.sizeKey,
            ratio: payload.ratio,
            count: payload.count,
            duration: payload.duration,
            resolution: payload.resolution,
            mode: payload.mode,
          },
          at: Date.now(),
        })
      );
      updateTaskUi(node);
      scheduleSave();
      watchTask(node.id, res.task.id);
      return { ok: true };
    } catch (error) {
      data.running = false;
      data.progress = '';
      data.error = error.message;
      data.pendingSubmission = null;
      refreshNode(node);
      scheduleSave();
      if (!options.quiet) toast('没提交成功：' + error.message);
      return { ok: false, error: error.message };
    }
  }

  // 把 payload.refs（前端送出的参考素材）折算成快照里存的那几个字段。
  // 前端只知道 url/kind/name/role；服务端冻结时用的 src 在这里就对应 url。
  function refsOfPayload(payload) {
    const list = payload && Array.isArray(payload.refs) ? payload.refs : [];
    return list.map((item) => ({
      name: String((item && item.name) || ''),
      kind: String((item && item.kind) || ''),
      role: String((item && item.role) || ''),
      src: String((item && (item.url || item.src)) || ''),
    }));
  }

  function submissionMetaFromTask(task, data) {
    const params = (task && task.params) || {};
    const resumeRefs = task && task.resume && Array.isArray(task.resume.refs) ? task.resume.refs : null;
    return submissionMetaOf(
      {
        mainPrompt: params.mainPrompt,
        submittedPrompt: params.submittedPrompt,
        tailPresetId: params.tailPresetId,
        tailPresetName: params.tailPresetName,
        tailText: params.tailText,
        tailAppended: params.tailAppended,
        model: (task && task.model) || (data && data.model),
        params: params,
        // 服务端把参考素材冻结在 resume.refs 里，重启接续的任务也能显示出来
        refs: resumeRefs || undefined,
        at: (task && task.updatedAt) || Date.now(),
      },
      { model: data && data.model }
    );
  }

  function applyTaskResult(node, task) {
    const data = nodeData(node);
    const result = task.result || {};
    const oldResult = data.result || null;
    const oldMeta = data.lastSubmission || null;
    data.running = false;
    data.progress = '';
    data.error = '';
    data.taskId = task.id || data.taskId;
    if (result.url) {
      const nextResult = {
        url: result.url,
        file: result.relPath || '',
        kind: result.kind || node.type || 'image',
        width: Number(result.width) || 0,
        height: Number(result.height) || 0,
        model: task.model || data.model,
        at: task.updatedAt || Date.now(),
      };
      let history = Array.isArray(data.history) ? data.history.slice() : [];
      if (oldResult && oldResult.url && oldResult.url !== nextResult.url) {
        const already = history.some((one) => one && one.result && String(one.result.url) === String(oldResult.url));
        if (!already) history = pushCardHistory(history, oldResult, oldMeta || currentSubmissionMeta(data));
      }
      const meta = submissionMetaOf(data.pendingSubmission || submissionMetaFromTask(task, data), {
        mainPrompt: data.text,
        model: nextResult.model,
      });
      history = pushCardHistory(history, nextResult, meta);
      data.history = history;
      data.lastSubmission = Object.assign({}, meta, { model: nextResult.model, at: nextResult.at });
      data.pendingSubmission = null;
      data.result = nextResult;
      if (data.result.width && data.result.height) {
        fitNodeToAspect(node, data.result.width / data.result.height);
      } else if (data.result.kind === 'video') {
        // 视频拿不到像素尺寸，就按卡片上选的比例把卡片摆正
        const parts = String((data.params && data.params.ratio) || '16:9')
          .split(':')
          .map((value) => Number(value));
        if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) fitNodeToAspect(node, parts[0] / parts[1]);
      }
      const label = data.result.kind === 'video' ? '视频' : data.result.kind === 'audio' ? '音频' : '图片';
      toast(label + '生成好了，已存进 素材\\' + label + ' 目录');
    }
    refreshNode(node);
    scheduleSave();
    // 生成期间点过「用新参数再跑一次」：这一版已经留下，接着跑新参数那一版
    runQueuedRerun(node);
  }

  function failTask(node, message, errorInfo) {
    const data = nodeData(node);
    data.running = false;
    data.progress = '';
    data.error = message || '生成失败';
    // 服务端认得出错误类别时带一份结构化信息（分类 / 建议 / 平台原文），
    // 卡片上就能显示成「通道密钥不对」+ 该怎么做，而不是一长串英文。
    data.errorInfo = errorInfo || null;
    refreshNode(node);
    scheduleSave();
    // 这一版失败了：如果排队里有新参数的版本，接着跑（用户既然点了再跑一次，
    // 多半就是冲着重试来的，不该因为上一次失败就把队列丢掉）。
    runQueuedRerun(node);
  }

  // 查询任务时偶尔会碰上本机服务重启、端口还没接上。
  // 这种短暂断线不能当成生成失败，否则卡片会停在「读取生成进度失败」，后面真正的结果也接不回来。
  function taskRetryDelay(misses) {
    if (misses <= 5) return 2000;
    if (misses <= 15) return 5000;
    return 10000;
  }

  function watchTask(nodeId, taskId) {
    stopWatch(nodeId);
    let misses = 0;
    let warned = false;
    const tick = async () => {
      const node = byId(nodeId);
      if (!node) {
        stopWatch(nodeId);
        return;
      }
      let task = null;
      try {
        const res = await window.api.task(taskId);
        task = res.task;
        misses = 0;
        warned = false;
      } catch (error) {
        const status = Number(error && error.status) || 0;
        const reason = (error && error.message) || '本机服务暂时连不上';
        // 只有服务端明确说「这条任务不存在」才算没救；其余多半是服务重启 / 网络抖动
        if (status === 404) {
          failTask(node, '这个生成任务在本地记录里找不到了（可能被清理过），可以重新点一次生成');
          return;
        }
        misses += 1;
        // 断线（status 0）可以一直等本机服务回来；服务端明确报错则重试有限次，免得卡片永远转圈
        if (status >= 400 && misses > 10) {
          failTask(node, '读取生成进度失败：' + reason + '（已重试 10 次）');
          return;
        }
        const data = nodeData(node);
        data.running = true;
        data.error = '';
        data.progress = misses <= 2 ? '正在重新连接本地服务…' : '等待本地服务恢复（第 ' + misses + ' 次重试）…';
        updateTaskUi(node);
        if (!warned) {
          warned = true;
          toast('跟本地服务的连接断了一下，正在自动重连；这次生成不会丢');
        }
        taskTimers.set(nodeId, setTimeout(tick, taskRetryDelay(misses)));
        return;
      }
      if (!task) {
        failTask(node, '这个生成任务在本地记录里找不到了（可能被清理过），可以重新点一次生成');
        return;
      }
      if (task.status === 'done') {
        applyTaskResult(node, task);
        return;
      }
      if (task.status === 'failed' || task.status === 'canceled' || task.status === 'interrupted') {
        if (task.status === 'canceled') {
          const data = nodeData(node);
          data.running = false;
          data.progress = '';
          data.error = '';
          refreshNode(node);
          scheduleSave();
          return;
        }
        failTask(node, task.error || '生成失败', task.errorInfo);
        toast('生成失败：' + ((task.errorInfo && task.errorInfo.title) || task.error || ''));
        return;
      }
      const data = nodeData(node);
      data.progress = task.stage || '正在生成';
      updateTaskUi(node);
      taskTimers.set(nodeId, setTimeout(tick, 2000));
    };
    tick();
  }

  async function cancelGenerate(node) {
    const data = nodeData(node);
    const taskId = data.taskId;
    // 本页刚点了取消：短时间内别再被自动接管回来
    muteTaskAdopt(node.id);
    stopWatch(node.id);
    // 取消是明确的「别跑了」：把排队里的重跑一并撤掉，不能背着用户再开一次
    const hadQueued = Boolean(data.rerunQueued);
    data.rerunQueued = false;
    data.running = false;
    data.progress = '';
    data.error = '';
    refreshNode(node);
    scheduleSave();
    if (taskId) {
      try {
        await window.api.cancelTask(taskId);
      } catch (error) {
        /* 取消失败也不影响本地状态 */
      }
    }
    toast(hadQueued ? '这次生成已取消，排队中的重跑也一并撤掉了' : '这次生成已取消');
  }

  // 之前因为本机断线被误判成「读取生成进度失败」的卡片：重新核对一次，
  // 任务还在跑就接着盯，已经出结果就补回卡片，真失败则换成平台给的原因
  function reclaimMistakenFailure(node) {
    const data = nodeData(node);
    data.running = true;
    data.error = '';
    data.progress = '正在核对任务状态…';
    refreshNode(node);
    scheduleSave();
    watchTask(node.id, data.taskId);
  }

  // 关掉浏览器再打开：之前还在跑的任务接着盯，被误判的旧卡片也顺手校正
  function resumeRunningTasks() {
    const recheck = [];
    nodes.forEach((node) => {
      const data = nodeData(node);
      if (!data.running) {
        if (data.taskId && /^读取生成进度失败/.test(String(data.error || ''))) recheck.push(node);
        return;
      }
      if (data.taskId) {
        watchTask(node.id, data.taskId);
        return;
      }
      data.running = false;
      data.preparing = '';
      data.progress = '';
      refreshNode(node);
      scheduleSave();
    });
    recheck.forEach(reclaimMistakenFailure);
  }

  // ===== 自动接管别处提交的任务 =====
  // 卡片上的 running / taskId 存在库里，但页面只有在「自己点的生成」或「刚打开画布」时
  // 才会去盯任务。接口直接提交、另一个标签页提交、或后台定时组提交的任务，
  // 当前页面并不知道，卡片就一直停在旧封面（任务面板里却能看到在跑）。
  // 这里每 5 秒问一次「本画布还有哪些任务在跑」，把卡片状态补齐并接管轮询。
  const TASK_ADOPT_MS = 5000;
  let taskAdoptTimer = null;
  let taskAdoptBusy = false;
  const taskAdoptMute = new Map(); // 刚在本页点过「取消」的卡片，短时间内不要又被接管回来

  function muteTaskAdopt(nodeId) {
    taskAdoptMute.set(nodeId, Date.now());
  }

  function isAdoptMuted(nodeId) {
    const at = taskAdoptMute.get(nodeId);
    if (!at) return false;
    if (Date.now() - at < 20000) return true;
    taskAdoptMute.delete(nodeId);
    return false;
  }

  async function adoptActiveTasks() {
    if (taskAdoptBusy || document.hidden) return;
    taskAdoptBusy = true;
    let res = null;
    try {
      res = await window.api.tasks(80, { canvasId: canvasId, active: true });
    } catch (error) {
      taskAdoptBusy = false;
      return;
    }
    taskAdoptBusy = false;
    const active = new Map();
    ((res && res.tasks) || []).forEach((task) => {
      if (task && task.nodeId && (task.status === 'queued' || task.status === 'running')) {
        active.set(task.nodeId, task);
      }
    });
    const stale = [];
    let changed = false;
    nodes.forEach((node) => {
      if (taskTimers.has(node.id)) return; // 本页已经在盯，别插手
      if (isAdoptMuted(node.id)) return;
      // 定时组的成员由定时组自己同步结果，这里不插手，免得两份结果互相覆盖
      if (memberSchedule.get(node.id)) return;
      const data = nodeData(node);
      const task = active.get(node.id);
      if (task) {
        // 库里说这张卡片正在跑：把封面切成生成中，再接管轮询。
        // 就算卡片上已经是 running（刷新页面后就是这样），也要补上轮询，否则永远不更新。
        const same = Boolean(data.running) && data.taskId === task.id;
        data.running = true;
        data.preparing = '';
        data.error = '';
        data.taskId = task.id;
        data.progress = task.stage || data.progress || '正在生成';
        const el = elements.get(node.id);
        if (el) updateTaskUi(node);
        else refreshNode(node);
        if (!same) changed = true;
        watchTask(node.id, task.id);
        return;
      }
      // 反过来：卡片还写着「生成中」，但 active 列表里没有它 —— 可能已经出结果了。
      // 记下来，循环结束后逐条核对，免得卡片永远停在转圈。
      if (!data.running || !data.taskId) return;
      stale.push({ node: node, taskId: data.taskId });
    });
    if (changed) {
      scheduleSave();
      refreshSelection();
    }
    // 卡片写着生成中、任务却不在 active 列表：逐条核对真实结果
    if (!stale.length) return;
    for (const item of stale) {
      const node = byId(item.node.id);
      if (!node || taskTimers.has(node.id)) continue;
      let task = null;
      try {
        task = (await window.api.task(item.taskId)).task;
      } catch (error) {
        continue; // 断线就等下一轮，别误判成失败
      }
      if (!task) continue;
      if (task.status === 'done') {
        applyTaskResult(node, task);
      } else if (task.status === 'canceled') {
        const data = nodeData(node);
        data.running = false;
        data.progress = '';
        data.error = '';
        refreshNode(node);
        scheduleSave();
      } else if (task.status === 'failed' || task.status === 'interrupted') {
        failTask(node, task.error || '生成失败', task.errorInfo);
      } else {
        // 还在排队 / 运行，只是列表翻页没翻到：直接接管
        const data = nodeData(node);
        data.running = true;
        data.progress = task.stage || '正在生成';
        updateTaskUi(node);
        watchTask(node.id, task.id);
      }
    }
  }

  function startTaskAdoption() {
    if (taskAdoptTimer) clearInterval(taskAdoptTimer);
    taskAdoptTimer = setInterval(adoptActiveTasks, TASK_ADOPT_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) adoptActiveTasks();
    });
    setTimeout(adoptActiveTasks, 1200);
  }

  function startTailFrame(node) {
    const data = nodeData(node);
    if (!data.result || !data.result.url) {
      toast('这张卡片还没有视频，先生成一段再提取尾帧');
      return;
    }
    if (data.tailBusy) return;
    data.tailBusy = true;
    const el = elements.get(node.id);
    const button = el ? el.querySelector('.btn-tail') : null;
    if (button) {
      button.disabled = true;
      button.textContent = '正在抽尾帧…';
    }
    toast('正在抽最后一帧，稍等一下…');
    window.api
      .tailFrame({ url: data.result.url, name: data.text })
      .then((res) => {
        const frame = (res && res.frame) || {};
        if (!frame.url) throw new Error('没拿到画面');
        const type = 'image';
        const presetSize = defaultSize(type, PARAM_DEFAULTS[type]);
        const created = addNode(type, {
          x: node.x + node.w + 80 + presetSize.w / 2,
          y: node.y + presetSize.h / 2,
        });
        const target = nodeData(created);
        target.text = data.text || '';
        target.result = {
          url: frame.url,
          file: frame.relPath || '',
          kind: 'image',
          width: Number(frame.width) || 0,
          height: Number(frame.height) || 0,
          model: '尾帧',
        };
        refreshNode(created);
        if (frame.width && frame.height) fitNodeToAspect(created, frame.width / frame.height);
        scheduleSave();
        toast('尾帧已抽出，存进 素材\\尾帧，右边多了一张图片卡片');
      })
      .catch((error) => {
        toast('尾帧没抽出来：' + error.message);
      })
      .finally(() => {
        data.tailBusy = false;
        const back = elements.get(node.id);
        const again = back ? back.querySelector('.btn-tail') : null;
        if (again) {
          again.disabled = false;
          again.textContent = '提取尾帧';
        }
      });
  }

  // 只展开选中的那一张；展开的卡片临时浮到最上面，面板才不会被别的卡片压住
  function setExpanded(id) {
    const next = id || null;
    if (expandedId === next) {
      const same = expandedId ? elements.get(expandedId) : null;
      if (same) same.classList.toggle('wide', promptWideOn(byId(expandedId)));
      applyZOrder();
      placePanel();
      return;
    }
    expandedId = next;
    elements.forEach((el, nodeId) => {
      el.classList.toggle('expanded', nodeId === expandedId);
      el.classList.toggle('wide', nodeId === expandedId && promptWideOn(byId(nodeId)));
    });
    viewportEl.classList.toggle('has-expanded', Boolean(expandedId));
    applyZOrder();
    placePanel();
    // 面板再打开时回到上次看到的位置，几千字的提示词不用重新找
    const openEl = expandedId ? elements.get(expandedId) : null;
    const openBox = openEl ? openEl.querySelector('.node-prompt') : null;
    if (openBox) {
      window.requestAnimationFrame(() => {
        const host = expandedId ? byId(expandedId) : null;
        if (!host) return;
        restorePromptScroll(host, openBox);
        paintPromptMetaOf(openEl);
      });
    }
  }

  function applyZOrder() {
    nodes.forEach((node, index) => {
      node.z = index;
      const el = elements.get(node.id);
      if (el) el.style.zIndex = String(zIndexOf(node));
    });
    // 生成状态会变（跑完 / 失败），筛选的颜色跟着刷新一下
    if (filterActive() || worldEl.classList.contains('filtering')) paintFilter();
    // 定位按钮上的「正在生成」计数也跟着刷新
    paintLocateBadge();
    placeAlignBar();
  }

  function focusPrompt(node) {
    const el = elements.get(node.id);
    if (!el) return;
    const box = el.querySelector('.node-prompt');
    if (!box) return;
    box.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(box);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function refreshSelection() {
    // 展开的卡片必须是选中的那一张；一旦不再是选中状态就自动收起
    if (expandedId && !selection.has(expandedId)) expandedId = null;
    // 选中的组合，把它组里的卡片也圈一下，一眼看出这几张是一组
    const groupMemberIds = new Set();
    selection.forEach((id) => {
      const node = byId(id);
      if (node && node.type === 'group') groupMembersOf(node).forEach((member) => groupMemberIds.add(member.id));
    });
    elements.forEach((el, id) => {
      el.classList.toggle('selected', selection.has(id));
      el.classList.toggle('expanded', id === expandedId);
      el.classList.toggle('wide', id === expandedId && promptWideOn(byId(id)));
      el.classList.toggle('in-group', groupMemberIds.has(id) && !selection.has(id));
    });
    const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
    edgeElements.forEach((item, id) => {
      const isSelected = id === selectedEdgeId;
      const edge = edgeById.get(id);
      // 卡片（含组合里的成员）被选中时，连到它的线收紧成实线；其余保持淡虚线
      const isLinked = Boolean(edge) && (
        selection.has(edge.sourceId) ||
        selection.has(edge.targetId) ||
        groupMemberIds.has(edge.sourceId) ||
        groupMemberIds.has(edge.targetId)
      );
      item.group.classList.toggle('selected', isSelected);
      item.group.classList.toggle('is-linked', isLinked && !isSelected);
      item.visible.setAttribute('marker-end', isSelected ? 'url(#arrow-sel)' : isLinked ? 'url(#arrow-link)' : 'url(#arrow-soft)');
    });
    viewportEl.classList.toggle('has-expanded', Boolean(expandedId));
    applyZOrder();
    placePanel();
  }

  function selectNode(id, additive) {
    if (!additive) {
      selection.clear();
      selectedEdgeId = null;
    }
    selection.add(id);
    refreshSelection();
  }

  function selectEdge(id) {
    selection.clear();
    selectedEdgeId = id;
    refreshSelection();
  }

  function clearSelection() {
    selection.clear();
    selectedEdgeId = null;
    expandedId = null;
    refreshSelection();
  }

  // ===== 连线 =====

  function anchorOf(node, side) {
    const size = sizeOf(node);
    return {
      x: side === 'out' ? node.x + size.w : node.x,
      y: node.y + size.h / 2,
    };
  }

  function curvePath(from, to) {
    const dx = clamp(Math.abs(to.x - from.x) * 0.5, 40, 180);
    return (
      'M ' + from.x + ' ' + from.y +
      ' C ' + (from.x + dx) + ' ' + from.y +
      ', ' + (to.x - dx) + ' ' + to.y +
      ', ' + to.x + ' ' + to.y
    );
  }

  function renderEdges() {
    Array.from(svgLayer.querySelectorAll('g.edge')).forEach((g) => g.remove());
    edgeElements.clear();
    edges.forEach((edge) => {
      const group = document.createElementNS(SVG_NS, 'g');
      group.setAttribute('class', 'edge');
      const hit = document.createElementNS(SVG_NS, 'path');
      hit.setAttribute('class', 'edge-hit');
      const visible = document.createElementNS(SVG_NS, 'path');
      visible.setAttribute('class', 'edge-path');
      visible.setAttribute('marker-end', 'url(#arrow-soft)');
      group.appendChild(hit);
      group.appendChild(visible);
      hit.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        selectEdge(edge.id);
      });
      hit.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectEdge(edge.id);
        openEdgeMenu(event.clientX, event.clientY);
      });
      hit.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        removeEdge(edge.id);
      });
      svgLayer.appendChild(group);
      edgeElements.set(edge.id, { group: group, hit: hit, visible: visible });
    });
    updateEdgePaths();
  }

  function updateEdgePaths(list, nodeIndex) {
    const filter = list ? new Set(list.map((node) => node.id)) : null;
    const nodeById = nodeIndex || new Map(nodes.map((node) => [node.id, node]));
    edges.forEach((edge) => {
      const item = edgeElements.get(edge.id);
      if (!item) return;
      if (filter && !filter.has(edge.sourceId) && !filter.has(edge.targetId)) return;
      const source = nodeById.get(edge.sourceId) || null;
      const target = nodeById.get(edge.targetId) || null;
      if (!source || !target || isHidden(source) || isHidden(target)) {
        item.group.style.display = 'none';
        return;
      }
      item.group.style.display = '';
      const d = curvePath(anchorOf(source, 'out'), anchorOf(target, 'in'));
      item.hit.setAttribute('d', d);
      item.visible.setAttribute('d', d);
    });
    scheduleMinimap();
  }

  function addEdge(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return false;
    const source = byId(sourceId);
    const target = byId(targetId);
    if (!source || !target) return false;
    if (source.type === 'schedule' || target.type === 'schedule') {
      toast('定时生成组不参与连线：把视频卡片连给别的卡片就行');
      return false;
    }
    if (source.type === 'group' && target.type === 'group') {
      toast('组合之间不能再连，先把它们拆开再加到一起');
      return false;
    }
    if (target.type === 'group') {
      toast('组合是往外送素材的，不能把别的卡片连进组合里');
      return false;
    }
    // 锁定的卡片：输入口封住，别人连不进来；但它自己往外连是允许的
    if (isLocked(target)) {
      toast('「' + (tagOf(target) || presetOf(target.type).label) + '」已锁定，不能连进来（先按 Ctrl+L 解锁）');
      return false;
    }
    if (isHidden(target)) {
      toast('那张卡片现在是隐藏状态，先恢复显示再连');
      return false;
    }
    if (edges.some((edge) => edge.sourceId === sourceId && edge.targetId === targetId)) {
      toast('这两张卡片已经连过了');
      return false;
    }
    // 首尾帧模式：只收两张图片，第三张直接拦住，免得连线了却不生效
    const frameMode = target.type === 'video' && target.data && target.data.params && target.data.params.mode === 'frames';
    if (frameMode && source.type === 'image') {
      const current = rolePlan(target).filter((item) => item.kind === 'image' && item.source);
      if (current.length >= 2) {
        toast('首尾帧模式只接两张图片：想换的话，先断开一张再连，或者在卡片里点「互换首尾帧」');
        return false;
      }
    }
    pushHistory();
    edges.push({ id: uid('e'), sourceId: sourceId, targetId: targetId, role: '' });
    renderEdges();
    refreshNode(byId(targetId));
    refreshSelection();
    scheduleSave();
    return true;
  }

  function removeEdge(id) {
    const index = edges.findIndex((edge) => edge.id === id);
    if (index < 0) return;
    // 锁定的卡片：锁定前就连进来的旧线保持原样，锁着的时候删不掉
    const lockedTarget = byId(edges[index].targetId);
    if (isLocked(lockedTarget)) {
      toast('这条线连着已锁定的「' + (tagOf(lockedTarget) || '卡片') + '」，先按 Ctrl+L 解锁才能删');
      return;
    }
    pushHistory();
    const target = byId(edges[index].targetId);
    edges.splice(index, 1);
    if (selectedEdgeId === id) selectedEdgeId = null;
    renderEdges();
    if (target) refreshNode(target);
    // 断开一张后，对调顺序里残留的那条也一起清掉
    if (target && Array.isArray(target.data && target.data.frameOrder)) {
      const left = edges.filter((edge) => edge.targetId === target.id).map((edge) => edge.sourceId);
      const kept = target.data.frameOrder.filter((id) => left.indexOf(id) >= 0);
      if (kept.length !== target.data.frameOrder.length) {
        if (kept.length) target.data.frameOrder = kept;
        else delete target.data.frameOrder;
      }
    }
    refreshSelection();
    scheduleSave();
    // 连线也是容易误删的：给一条撤销入口
    toast('已断开这条连线', 6000, [{ label: '撤销删除', run: () => undo() }]);
  }

  function snapshot() {
    return JSON.stringify({
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        x: Math.round(node.x),
        y: Math.round(node.y),
        w: Math.round(rawSizeOf(node).w),
        h: Math.round(rawSizeOf(node).h),
        data: node.data || {},
        createdAt: node.createdAt,
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        role: edge.role || '',
      })),
    });
  }

  function pushHistory() {
    const snap = pendingSnapshot !== null ? pendingSnapshot : snapshot();
    pendingSnapshot = null;
    history.past.push(snap);
    if (history.past.length > HISTORY_LIMIT) history.past.shift();
    history.future.length = 0;
    updateHistoryButtons();
  }

  function beginTransaction() {
    pendingSnapshot = snapshot();
  }

  function dropTransaction() {
    pendingSnapshot = null;
  }

  function restoreState(json) {
    const data = JSON.parse(json);
    nodes = data.nodes.map((node) => ({ ...node, data: node.data || {} }));
    edges = data.edges.map((edge) => ({ ...edge }));
    // 撤销回到删除前：号按当时的顺序重新排一遍，删掉的那张回来、后面的号退回原位
    renumberAll();
    selection.clear();
    selectedEdgeId = null;
    editingId = null;
    renderAll();
    refreshSelection();
    scheduleSave();
  }

  function undo() {
    if (!history.past.length) return;
    restoreState(history.past.pop());
    updateHistoryButtons();
    toast('已撤销');
  }

  function updateHistoryButtons() {
    document.getElementById('btn-undo').disabled = history.past.length === 0;
  }

  function clearGuides() {
    guideEls.forEach((el) => el.remove());
    guideEls = [];
  }

  function renderGuides(guides) {
    clearGuides();
    if (!guides.length) return;
    const rect = viewportEl.getBoundingClientRect();
    guides.forEach((guide) => {
      const el = document.createElement('div');
      el.className = 'guide ' + (guide.axis === 'x' ? 'v' : 'h');
      if (guide.axis === 'x') {
        el.style.left = (toScreen(guide.pos, 0).x - rect.left) + 'px';
        el.style.top = '0px';
        el.style.height = rect.height + 'px';
      } else {
        el.style.top = (toScreen(0, guide.pos).y - rect.top) + 'px';
        el.style.left = '0px';
        el.style.width = rect.width + 'px';
      }
      viewportEl.appendChild(el);
      guideEls.push(el);
    });
  }

  function computeSnap(origin, dx, dy, statics) {
    const threshold = SNAP_PX / viewport.zoom;
    let bestX = null;
    let bestY = null;
    origin.forEach((item, index) => {
      const bounds = {
        left: item.x + dx,
        right: item.x + dx + item.node.w,
        centerX: item.x + dx + item.node.w / 2,
        top: item.y + dy,
        bottom: item.y + dy + item.node.h,
        centerY: item.y + dy + item.node.h / 2,
      };
      const selfBounds = origin.map((other) => ({
        left: other.x + dx,
        right: other.x + dx + other.node.w,
        centerX: other.x + dx + other.node.w / 2,
        top: other.y + dy,
        bottom: other.y + dy + other.node.h,
        centerY: other.y + dy + other.node.h / 2,
      }));
      statics.forEach((other) => {
        const size = sizeOf(other);
        const targets = {
          left: other.x,
          right: other.x + size.w,
          centerX: other.x + size.w / 2,
          top: other.y,
          bottom: other.y + size.h,
          centerY: other.y + size.h / 2,
        };
        const xPairs = [
          [bounds.left, targets.left], [bounds.left, targets.right], [bounds.left, targets.centerX],
          [bounds.right, targets.left], [bounds.right, targets.right], [bounds.right, targets.centerX],
          [bounds.centerX, targets.left], [bounds.centerX, targets.right], [bounds.centerX, targets.centerX],
        ];
        xPairs.forEach((pair) => {
          const diff = pair[1] - pair[0];
          if (Math.abs(diff) <= threshold && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) {
            if (selfBounds.some((box) => pair[1] > box.left - 0.5 && pair[1] < box.right + 0.5 && bounds.top < box.bottom && bounds.bottom > box.top && box !== selfBounds[index])) return;
            bestX = { diff: diff, pos: pair[1] };
          }
        });
        const yPairs = [
          [bounds.top, targets.top], [bounds.top, targets.bottom], [bounds.top, targets.centerY],
          [bounds.bottom, targets.top], [bounds.bottom, targets.bottom], [bounds.bottom, targets.centerY],
          [bounds.centerY, targets.top], [bounds.centerY, targets.bottom], [bounds.centerY, targets.centerY],
        ];
        yPairs.forEach((pair) => {
          const diff = pair[1] - pair[0];
          if (Math.abs(diff) <= threshold && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) {
            bestY = { diff: diff, pos: pair[1] };
          }
        });
      });
    });
    const guides = [];
    let finalX = dx;
    let finalY = dy;
    if (bestX) {
      finalX = dx + bestX.diff;
      guides.push({ axis: 'x', pos: bestX.pos });
    } else {
      const base = origin[0];
      finalX = Math.round((base.x + dx) / GRID) * GRID - base.x;
    }
    if (bestY) {
      finalY = dy + bestY.diff;
      guides.push({ axis: 'y', pos: bestY.pos });
    } else {
      const base = origin[0];
      finalY = Math.round((base.y + dy) / GRID) * GRID - base.y;
    }
    return { dx: finalX, dy: finalY, guides: guides };
  }

  function centerOfView() {
    return {
      x: (viewportEl.clientWidth / 2 - viewport.x) / viewport.zoom,
      y: (viewportEl.clientHeight / 2 - viewport.y) / viewport.zoom,
    };
  }

  // 屏幕坐标 → 画布坐标（素材从素材库拖进来、文件从桌面拖进来都用它）
  function dropPointAt(clientX, clientY) {
    const rect = viewportEl.getBoundingClientRect();
    return {
      x: (clientX - rect.left - viewport.x) / viewport.zoom,
      y: (clientY - rect.top - viewport.y) / viewport.zoom,
    };
  }

  // 素材卡统一缩成缩略图：140 的方框里按原比例缩，超过 140 就按高度反算宽度
  const MATERIAL_BOX = 140;
  const MATERIAL_MIN_W = 80;
  function materialSizeOf(ratio) {
    const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9;
    let w = MATERIAL_BOX;
    let h = Math.round(MATERIAL_BOX / r);
    if (h > MATERIAL_BOX) {
      h = MATERIAL_BOX;
      w = Math.round(MATERIAL_BOX * r);
    }
    return {
      w: Math.max(MATERIAL_MIN_W, Math.min(MATERIAL_BOX, w)),
      h: Math.max(MIN_H, Math.min(MATERIAL_BOX, h)),
    };
  }

  // 素材卡缩到缩略图大小：以卡片当前中心为准，缩完还待在原来的位置
  function compactMaterialNode(node, ratio) {
    const size = materialSizeOf(ratio);
    const cx = node.x + node.w / 2;
    const cy = node.y + node.h / 2;
    node.w = size.w;
    node.h = size.h;
    node.x = Math.round(cx - size.w / 2);
    node.y = Math.round(cy - size.h / 2);
    const data = nodeData(node);
    // 缩略图尺寸是定好的，之后不再按图片比例自动拉高
    data.sized = true;
    data.thumb = true;
    data.thumbW = size.w;
    data.thumbH = size.h;
    const el = elements.get(node.id);
    if (el) {
      el.style.width = size.w + 'px';
      el.style.height = size.h + 'px';
      el.style.left = node.x + 'px';
      el.style.top = node.y + 'px';
    }
    updateEdgePaths([node]);
    return size;
  }

  // 素材（已经在素材目录里的文件）：直接建一张卡片引用它，不重复存一份
  function addAssetCard(asset, at, label, opts) {
    // 上传 / 拖进来的素材默认缩成缩略图、也不自动弹面板；导演台出图这类结果卡保持原样
    const compact = !opts || opts.compact !== false;
    const collapsed = !opts || opts.collapsed !== false;
    const type = asset.kind === 'frame' ? 'image' : asset.kind || 'image';
    const presetSize = defaultSize(type, PARAM_DEFAULTS[type]);
    // at 默认是左上角；opts.center=true 时直接当成卡片最终中心（素材缩略图都按中心落点）
    const center = opts && opts.center ? { x: at.x, y: at.y } : { x: at.x + presetSize.w / 2, y: at.y + presetSize.h / 2 };
    const created = addNode(type, center, { collapsed: collapsed, suppressTail: true });
    const data = nodeData(created);
    data.result = {
      url: asset.url,
      file: asset.relPath || asset.file || '',
      kind: type,
      width: Number(asset.width) || 0,
      height: Number(asset.height) || 0,
      model: label || asset.model || '本地素材',
    };
    data.text = String(asset.name || asset.text || '').replace(/\.[^.]+$/, '');
    // 导入的本地文件：把文件名写进标题，编号牌旁边就能看到叫什么
    if (!String(data.title || '').trim() && asset.name) {
      // 素材库里的文件名带「年月日_时分秒_」前缀，标题上不显示这串时间
      data.title = String(asset.name)
        .replace(/\.[^.]+$/, '')
        .replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/, '')
        .slice(0, 60);
    }
    if (compact) compactMaterialNode(created, asset.width && asset.height ? asset.width / asset.height : 0);
    refreshNode(created);
    if (!compact && asset.width && asset.height) fitNodeToAspect(created, asset.width / asset.height);
    return created;
  }

  // 素材文件本身的宽高：图片读 naturalWidth，视频读 videoWidth
  function probeSize(url, kind) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      setTimeout(() => finish(null), 4000);
      if (kind === 'image' || kind === 'frame') {
        const img = new Image();
        img.onload = () => finish({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => finish(null);
        img.src = url;
      } else if (kind === 'video') {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = () => finish({ width: video.videoWidth, height: video.videoHeight });
        video.onerror = () => finish(null);
        video.src = url;
      } else {
        finish(null);
      }
    });
  }

  // 从素材库点一下 / 双击：把已有素材加到画布中间
  async function addLibraryAsset(item, at) {
    const center = at || centerOfView();
    const created = addAssetCard(
      { relPath: item.relPath, url: item.url, kind: item.kind, name: item.name },
      center,
      '',
      { center: true }
    );
    scheduleSave();
    const size = await probeSize(item.url, item.kind);
    if (size && size.width && size.height) {
      const data = nodeData(created);
      data.result.width = size.width;
      data.result.height = size.height;
      // 读到真实宽高后，按真实比例再缩一次；用户中途手动拉过就不动
      if (data.thumb && created.w === data.thumbW && created.h === data.thumbH) {
        compactMaterialNode(created, size.width / size.height);
      } else if (!data.sized) {
        fitNodeToAspect(created, size.width / size.height);
      }
      refreshNode(created);
      scheduleSave();
    }
    toast('已把「' + item.name + '」加到画布（直接引用素材目录里的文件）');
  }

  // 本地挑的文件 / 从桌面拖进来的文件：先收进素材目录，再各建一张卡片
  async function importLocalFiles(files, at, opts) {
    if (!files || !files.length) return;
    const from = at || centerOfView();
    const connectFrom = opts && opts.connectFrom ? String(opts.connectFrom) : '';
    const created = [];
    let placed = 0;
    const failed = [];
    for (const file of files) {
      try {
        const res = await window.api.importAsset(file, '', canvasId);
        const asset = (res && res.asset) || {};
        // 多选时依次错开摆放，别叠成一摞
        const gapX = 170;
        const gapY = 150;
        const card = addAssetCard(
          {
            url: asset.url,
            relPath: asset.relPath,
            kind: asset.kind,
            name: file.name,
            width: asset.width,
            height: asset.height,
          },
          {
            x: Math.round(from.x + (placed % 2) * gapX),
            y: Math.round(from.y + Math.floor(placed / 2) * gapY),
          },
          '本地素材',
          { center: true }
        );
        created.push(card);
        placed += 1;
      } catch (error) {
        failed.push(file.name + '：' + error.message);
      }
    }
    if (placed) {
      scheduleSave();
      toast(
        '已上传 ' + placed + ' 个素材，存在 素材 目录里' +
          (failed.length ? '（' + failed.length + ' 个没成功）' : '')
      );
    }
    if (connectFrom && created.length) {
      created.forEach((card) => addEdge(connectFrom, card.id));
      if (opts && opts.keepExpanded && byId(opts.keepExpanded)) {
        expandedId = opts.keepExpanded;
        selection.clear();
        selection.add(opts.keepExpanded);
        refreshSelection();
      }
    }
    if (failed.length) {
      // 失败的单独说清楚是哪个文件、什么原因
      setTimeout(() => toast('没上传成功：' + failed.slice(0, 2).join('；') + (failed.length > 2 ? ' 等' : '')), placed ? 1900 : 0);
    }
  }

  let localInput = null;
  function pickLocalFiles(center, opts) {
    if (!localInput) {
      localInput = document.createElement('input');
      localInput.type = 'file';
      localInput.multiple = true;
      localInput.accept = 'image/*,video/*,audio/*';
      localInput.style.display = 'none';
      document.body.appendChild(localInput);
    }
    const settings = opts || {};
    const connectFrom = settings.connectFrom ? String(settings.connectFrom) : '';
    const keepExpanded = settings.keepExpanded ? String(settings.keepExpanded) : '';
    localInput.onchange = () => {
      const files = Array.from(localInput.files || []);
      localInput.value = '';
      if (!files.length) return;
      importLocalFiles(files, center || centerOfView(), {
        connectFrom: connectFrom,
        keepExpanded: keepExpanded,
      });
    };
    localInput.click();
  }

  // 直接从桌面把文件拖到画布上
  function bindFileDrop() {
    const typesOf = (event) => {
      const dt = event.dataTransfer;
      return dt ? Array.from(dt.types || []) : [];
    };
    const hasFiles = (event) => {
      return typesOf(event).indexOf('Files') >= 0;
    };
    const hasAsset = (event) => {
      return typesOf(event).indexOf('application/x-canvas-asset') >= 0;
    };
    const dropPoint = (event) => dropPointAt(event.clientX, event.clientY);
    document.addEventListener('dragenter', (event) => {
      if (!hasFiles(event) && !hasAsset(event)) return;
      event.preventDefault();
      viewportEl.classList.add('dropping');
    });
    document.addEventListener('dragover', (event) => {
      if (!hasFiles(event) && !hasAsset(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', (event) => {
      if (!event.relatedTarget) viewportEl.classList.remove('dropping');
    });
    document.addEventListener('drop', (event) => {
      if (!hasFiles(event) && !hasAsset(event)) return;
      event.preventDefault();
      viewportEl.classList.remove('dropping');
      if (hasAsset(event)) {
        let item = null;
        try {
          item = JSON.parse(event.dataTransfer.getData('application/x-canvas-asset') || 'null');
        } catch (error) {
          item = null;
        }
        if (item && item.relPath) addLibraryAsset(item, dropPoint(event));
        return;
      }
      const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
      if (!files.length) return;
      importLocalFiles(files, dropPoint(event));
    });
  }

  // 右侧素材库抽屉：点工具栏按钮开合，里面的素材能直接拖到画布
  function bindLibraryDrawer() {
    const drawer = document.getElementById('library-drawer');
    const body = document.getElementById('library-body');
    const toggle = document.getElementById('btn-library');
    const closeBtn = document.getElementById('drawer-close');
    if (!drawer || !body || !toggle) return;
    let mounted = false;
    const open = () => {
      drawer.classList.remove('hidden');
      if (!mounted) {
        mounted = true;
        window.AssetLibrary.mount(body, {
          onAdd: (item) => addLibraryAsset(item, centerOfView()),
          onPick: (item) => addLibraryAsset(item, centerOfView()),
          onDrop: (item, point) => addLibraryAsset(item, dropPointAt(point.clientX, point.clientY)),
        });
      } else if (window.AssetLibrary) {
        window.AssetLibrary.reload();
      }
    };
    const close = () => drawer.classList.add('hidden');
    toggle.addEventListener('click', () => {
      if (drawer.classList.contains('hidden')) open();
      else close();
    });
    if (closeBtn) closeBtn.addEventListener('click', close);
  }

  // 新卡片别正好压在已有卡片上：位置被占了就往右下错开一点，免得看起来像只加了一张
  function freeSpot(x, y, w, h) {
    const taken = (ax, ay) =>
      nodes.some((item) => {
        const other = sizeOf(item);
        const overlapW = Math.min(ax + w, item.x + other.w) - Math.max(ax, item.x);
        const overlapH = Math.min(ay + h, item.y + other.h) - Math.max(ay, item.y);
        return overlapW > 0 && overlapH > 0 && (overlapW * overlapH) / (w * h) > 0.5;
      });
    let ax = x;
    let ay = y;
    for (let i = 0; i < 12 && taken(ax, ay); i += 1) {
      ax += 28;
      ay += 28;
    }
    return { x: ax, y: ay };
  }

  function addNode(type, center, opts) {
    // collapsed=true：建完只选中、不自动展开面板（导入素材时用）
    // connectFrom：卡片建好后，自动从来源卡片连一条线过来
    const connectFrom = opts && opts.connectFrom ? String(opts.connectFrom) : '';
    const keepExpanded = opts && opts.keepExpanded ? String(opts.keepExpanded) : '';
    const preset = presetOf(type);
    const presetSize = defaultSize(type, PARAM_DEFAULTS[type]);
    const point = center || {
      x: (viewportEl.clientWidth / 2 - viewport.x) / viewport.zoom,
      y: (viewportEl.clientHeight / 2 - viewport.y) / viewport.zoom,
    };
    const spot = freeSpot(Math.round(point.x - presetSize.w / 2), Math.round(point.y - presetSize.h / 2), presetSize.w, presetSize.h);
    const node = {
      id: uid('n'),
      type: type,
      x: spot.x,
      y: spot.y,
      w: presetSize.w,
      h: presetSize.h,
      data: {
        text: '',
        model: pickDefaultModel(type),
        params: { ...(PARAM_DEFAULTS[type] || {}) },
        sized: false,
      },
      createdAt: Date.now(),
    };
    if (!(opts && opts.suppressTail) && TAIL_KINDS[type]) {
      const seed = defaultTailChoice();
      if (seed.enabled) node.data.tailPrompt = seed;
    }
    // 新卡排在同类素材的最后，入画布后再统一重排一次，保证号是连续的
    const kind = numberKindOf(node);
    if (kind) node.data.no = numberSeatOf(kind);
    pushHistory();
    nodes.push(node);
    if (kind) renumberAll();
    const collapsed = Boolean(opts && opts.collapsed);
    if (!collapsed) expandedId = node.id;
    renderNodes();
    selection.clear();
    selection.add(node.id);
    refreshSelection();
    if (connectFrom && byId(connectFrom)) addEdge(connectFrom, node.id);
    if (keepExpanded && byId(keepExpanded)) {
      expandedId = keepExpanded;
      selection.clear();
      selection.add(keepExpanded);
      refreshSelection();
    } else if (!collapsed) {
      focusPrompt(node);
    }
    keepViewportAnchored();
    scheduleSave();
    return node;
  }

  function copySelection() {
    if (!selection.size) return;
    clipboard = {
      nodes: nodes
        .filter((node) => selection.has(node.id))
        .map((node) => ({ ...node, data: JSON.parse(JSON.stringify(node.data || {})) })),
      edges: edges
        .filter((edge) => selection.has(edge.sourceId) && selection.has(edge.targetId))
        .map((edge) => ({ ...edge })),
    };
    toast('已复制 ' + clipboard.nodes.length + ' 张卡片');
  }

  function pasteClipboard() {
    if (!clipboard || !clipboard.nodes.length) return;
    pushHistory();
    const map = new Map();
    const copies = clipboard.nodes.map((node) => {
      const copy = {
        ...node,
        id: uid('n'),
        x: node.x + 32,
        y: node.y + 32,
        data: JSON.parse(JSON.stringify(node.data || {})),
        createdAt: Date.now(),
      };
      map.set(node.id, copy.id);
      return copy;
    });
    // 粘出来的素材是新的一张：先去掉老号，再统一排到同类素材的最后
    copies.forEach((copy) => {
      if (!numberKindOf(copy)) return;
      delete copy.data.no;
    });
    nodes.push(...copies);
    remapGroupMembers(copies, map);
    renumberAll();
    clipboard.edges.forEach((edge) => {
      if (map.has(edge.sourceId) && map.has(edge.targetId)) {
        edges.push({ id: uid('e'), sourceId: map.get(edge.sourceId), targetId: map.get(edge.targetId) });
      }
    });
    clipboard = {
      nodes: copies.map((copy) => ({ ...copy, data: JSON.parse(JSON.stringify(copy.data || {})) })),
      edges: clipboard.edges.map((edge) => ({
        id: edge.id,
        sourceId: map.get(edge.sourceId) || edge.sourceId,
        targetId: map.get(edge.targetId) || edge.targetId,
      })),
    };
    selection.clear();
    copies.forEach((copy) => selection.add(copy.id));
    renderAll();
    refreshSelection();
    scheduleSave();
    toast('已粘贴 ' + copies.length + ' 张卡片');
  }

  // ===== 锁定 / 隐藏 =====
  // 锁定：卡片被钉在原位，拖不动、改不了、删不掉；它的输出口照常敞开，
  //       所以「锁定卡片 -> 别的卡片」这条线仍然能拉；反过来别人连不进来。
  //       锁定之前就连进来的线原样保留，锁着的时候不能删也不能再加。
  // 隐藏：卡片和它的连线一起从画面上收起来，但数据还在，
  //       它照样能当别人的参考素材（连线关系没断，只是不画出来）。

  function lockedSelection() {
    return Array.from(selection)
      .map((id) => byId(id))
      .filter((node) => isLocked(node));
  }

  function setLocked(ids, on) {
    const list = ids.map((id) => byId(id)).filter(Boolean);
    if (!list.length) return 0;
    let changed = 0;
    list.forEach((node) => {
      const data = nodeData(node);
      if (Boolean(data.locked) === Boolean(on)) return;
      data.locked = Boolean(on);
      changed += 1;
    });
    if (!changed) return 0;
    // 锁上时顺手收起编辑面板，免得留一个改不了的输入框开着
    if (on && expandedId && list.some((node) => node.id === expandedId)) setExpanded(null);
    renderAll();
    refreshSelection();
    scheduleSave();
    return changed;
  }

  function toggleLockSelection() {
    if (!selection.size) {
      toast('先选中要锁定的卡片（点一下卡片，或者按住 Ctrl 框选）');
      return;
    }
    const list = Array.from(selection)
      .map((id) => byId(id))
      .filter(Boolean);
    if (!list.length) return;
    const allLocked = list.every((node) => isLocked(node));
    const count = setLocked(list.map((node) => node.id), !allLocked);
    if (!count) return;
    toast(
      allLocked
        ? '已解锁 ' + count + ' 张卡片，现在可以拖动和修改了'
        : '已锁定 ' + count + ' 张卡片：拖不动、改不了，但还能当素材连给别人'
    );
  }

  function hideSelection() {
    if (!selection.size) {
      toast('先选中要隐藏的卡片');
      return;
    }
    const list = Array.from(selection)
      .map((id) => byId(id))
      .filter(Boolean);
    if (!list.length) return;
    let changed = 0;
    list.forEach((node) => {
      const data = nodeData(node);
      if (data.hidden) return;
      data.hidden = true;
      changed += 1;
    });
    if (!changed) return;
    pushHistory();
    if (expandedId && list.some((node) => node.id === expandedId)) expandedId = null;
    selection.clear();
    selectedEdgeId = null;
    renderAll();
    refreshSelection();
    scheduleSave();
    toast('已隐藏 ' + changed + ' 张卡片：它们还能当素材用，右下角可以随时恢复');
  }

  // 恢复隐藏：不再一次性全放出来，弹窗勾选，只恢复选中的那些
  let hiddenPickerEl = null;

  function closeHiddenPicker() {
    if (!hiddenPickerEl) return;
    const dying = hiddenPickerEl;
    hiddenPickerEl = null;
    dying.remove();
    document.removeEventListener('keydown', onHiddenPickerKey, true);
  }

  function onHiddenPickerKey(event) {
    if (!hiddenPickerEl) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeHiddenPicker();
    }
  }

  function thumbOfHidden(node) {
    const data = nodeData(node);
    const url = data.result && data.result.url ? data.result.url : '';
    if (url && (node.type === 'image' || node.type === 'video')) {
      const el = document.createElement(node.type === 'video' ? 'video' : 'img');
      el.src = url;
      if (node.type === 'video') {
        el.muted = true;
        el.playsInline = true;
        el.preload = 'metadata';
      }
      el.alt = '';
      return el;
    }
    const span = document.createElement('span');
    span.className = 'hidden-restore-ph';
    span.textContent = node.type === 'audio' ? '♪' : presetOf(node.type).label.slice(0, 1);
    return span;
  }

  function showHiddenPicker() {
    const list = hiddenNodes();
    if (!list.length) {
      toast('现在没有隐藏的卡片');
      return;
    }
    closeHiddenPicker();
    const mask = document.createElement('div');
    mask.className = 'modal-mask hidden-restore-mask';
    const dialog = document.createElement('div');
    dialog.className = 'modal hidden-restore-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const head = document.createElement('div');
    head.className = 'modal-head';
    const headTitle = document.createElement('b');
    headTitle.textContent = '恢复隐藏的卡片';
    const headSub = document.createElement('span');
    headSub.className = 'hidden-restore-sub';
    headSub.textContent = '勾选要放回画布的那些，没勾的继续隐藏';
    head.appendChild(headTitle);
    head.appendChild(headSub);
    const headGrow = document.createElement('span');
    headGrow.className = 'grow';
    head.appendChild(headGrow);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ghost';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', closeHiddenPicker);
    head.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body hidden-restore-body';
    const tools = document.createElement('div');
    tools.className = 'hidden-restore-tools';
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'ghost';
    allBtn.textContent = '全选';
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.className = 'ghost';
    noneBtn.textContent = '全不选';
    const countEl = document.createElement('span');
    countEl.className = 'hidden-restore-count';
    tools.appendChild(allBtn);
    tools.appendChild(noneBtn);
    tools.appendChild(countEl);
    body.appendChild(tools);

    const listEl = document.createElement('div');
    listEl.className = 'hidden-restore-list';
    const boxes = new Map();
    list.forEach((node) => {
      const data = nodeData(node);
      const row = document.createElement('label');
      row.className = 'hidden-restore-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = node.id;
      boxes.set(node.id, box);
      const thumb = document.createElement('div');
      thumb.className = 'hidden-restore-thumb';
      thumb.appendChild(thumbOfHidden(node));
      const meta = document.createElement('div');
      meta.className = 'hidden-restore-meta';
      const nameRow = document.createElement('div');
      nameRow.className = 'hidden-restore-name';
      const tag = tagOf(node);
      const kind = presetOf(node.type).label;
      const title = String(data.title || '').trim();
      nameRow.textContent = (tag ? tag + ' · ' : '') + (title || kind);
      const text = document.createElement('div');
      text.className = 'hidden-restore-text';
      const summary = displayText(data.text || '').replace(/s+/g, ' ').trim();
      text.textContent = summary || (data.result && data.result.url ? '已有生成结果' : '暂无提示词');
      meta.appendChild(nameRow);
      meta.appendChild(text);
      row.appendChild(box);
      row.appendChild(thumb);
      row.appendChild(meta);
      listEl.appendChild(row);
    });
    body.appendChild(listEl);

    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    const footHint = document.createElement('span');
    footHint.className = 'hidden-restore-hint';
    footHint.textContent = '关闭窗口不会恢复任何卡片';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ghost';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', closeHiddenPicker);
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'primary';
    okBtn.addEventListener('click', () => {
      const picked = Array.from(boxes.values()).filter((box) => box.checked).map((box) => box.value);
      if (!picked.length) {
        toast('先勾选要恢复的卡片');
        return;
      }
      closeHiddenPicker();
      restoreHidden(picked);
    });
    foot.appendChild(footHint);
    foot.appendChild(grow);
    foot.appendChild(cancelBtn);
    foot.appendChild(okBtn);

    dialog.appendChild(head);
    dialog.appendChild(body);
    dialog.appendChild(foot);
    mask.appendChild(dialog);
    document.body.appendChild(mask);
    hiddenPickerEl = mask;

    const paint = () => {
      const picked = Array.from(boxes.values()).filter((box) => box.checked).length;
      countEl.textContent = '已选 ' + picked + ' / ' + list.length + ' 张';
      okBtn.textContent = picked ? '恢复选中的 ' + picked + ' 张' : '恢复选中的卡片';
      okBtn.disabled = picked === 0;
    };
    Array.from(boxes.values()).forEach((box) => box.addEventListener('change', paint));
    allBtn.addEventListener('click', () => {
      Array.from(boxes.values()).forEach((box) => {
        box.checked = true;
      });
      paint();
    });
    noneBtn.addEventListener('click', () => {
      Array.from(boxes.values()).forEach((box) => {
        box.checked = false;
      });
      paint();
    });
    paint();
    mask.addEventListener('pointerdown', (event) => event.stopPropagation());
    mask.addEventListener('click', (event) => {
      if (event.target === mask) closeHiddenPicker();
    });
    document.addEventListener('keydown', onHiddenPickerKey, true);
    setTimeout(() => allBtn.focus(), 0);
  }

  function restoreHidden(ids) {
    const wanted = new Set(ids);
    const list = hiddenNodes().filter((node) => wanted.has(node.id));
    if (!list.length) return;
    pushHistory();
    list.forEach((node) => {
      nodeData(node).hidden = false;
    });
    renderAll();
    applyViewport();
    refreshSelection();
    scheduleSave();
    toast('已恢复 ' + list.length + ' 张卡片，其余仍然隐藏');
  }

  function toggleHideSelection() {
    // 有选中的就隐藏选中的；没选中的话，如果有藏起来的卡片就把它们全放出来
    if (selection.size) {
      hideSelection();
      return;
    }
    if (hiddenNodes().length) {
      showHiddenPicker();
      return;
    }
    toast('先选中要隐藏的卡片（选中后按 Ctrl+Shift+H）');
  }

  let hiddenBadgeEl = null;

  function refreshHiddenBadge() {
    const count = hiddenNodes().length;
    if (!hiddenBadgeEl) {
      hiddenBadgeEl = document.createElement('button');
      hiddenBadgeEl.type = 'button';
      hiddenBadgeEl.className = 'hidden-badge';
      hiddenBadgeEl.addEventListener('pointerdown', (event) => event.stopPropagation());
      hiddenBadgeEl.addEventListener('click', (event) => {
        event.stopPropagation();
        showHiddenPicker();
      });
      viewportEl.appendChild(hiddenBadgeEl);
    }
    hiddenBadgeEl.classList.toggle('hidden', count === 0);
    hiddenBadgeEl.textContent = count ? count + ' 张卡片已隐藏 · 点此勾选恢复' : '';
    hiddenBadgeEl.title = count ? '点一下打开勾选窗口，只恢复你选中的卡片（Ctrl+Shift+H）' : '';
  }

  function deleteSelection() {
    if (selectedEdgeId) {
      removeEdge(selectedEdgeId);
      return;
    }
    if (!selection.size) return;
    // 锁定的卡片删不掉：先把它们从这次删除里摘出去
    const lockedIds = new Set();
    selection.forEach((id) => {
      const node = byId(id);
      if (isLocked(node)) lockedIds.add(id);
    });
    const ids = new Set(Array.from(selection).filter((id) => !lockedIds.has(id)));
    if (!ids.size) {
      toast('选中的 ' + lockedIds.size + ' 张卡片已锁定，删不掉。先按 Ctrl+L 解锁');
      return;
    }
    pushHistory();
    // 这次删除牵连到的卡片：只刷新它们，其余卡片原样留在画面上
    const touched = new Set();
    // 定时组被整个删掉时，组里的卡片要恢复成普通大小，只有它们需要整个重建
    const freed = new Set();
    // 组合被删掉时，组里的卡片留在画布上，原来的连线还给每一张卡片
    nodes.forEach((node) => {
      if (node.type === 'group' && ids.has(node.id)) relinkGroupEdges(node);
    });
    // 被删掉的卡片也要从它待过的组合里摘出去
    nodes.forEach((node) => {
      if (node.type !== 'group' || ids.has(node.id)) return;
      if (!Array.isArray(node.data.members)) return;
      const before = node.data.members.length;
      node.data.members = node.data.members.filter((id) => !ids.has(id));
      if (node.data.members.length !== before) touched.add(node.id);
    });
    // 定时组：删掉组就清掉后台运行记录；成员被删掉就从组里摘出去
    const relayout = [];
    nodes.forEach((node) => {
      if (node.type !== 'schedule') return;
      if (ids.has(node.id)) {
        // 组头没了：组里的卡片要变回普通卡片（有拉伸把手、原尺寸）
        scheduleOrderOf(node).forEach((member) => freed.add(member.id));
        try {
          window.api.forgetSchedule(node.id);
        } catch (error) {
          /* 记录清不掉也不挡删除 */
        }
        scheduleRuns.delete(node.id);
        return;
      }
      const data = nodeData(node);
      const alive = data.members.filter((id) => !ids.has(id));
      if (alive.length === data.members.length) return;
      data.members = alive;
      data.order = data.order.filter((id) => alive.indexOf(id) >= 0);
      Object.keys(data.schedule.perCard).forEach((id) => {
        if (alive.indexOf(id) < 0) delete data.schedule.perCard[id];
      });
      Object.keys(data.schedule.snapshots).forEach((id) => {
        if (alive.indexOf(id) < 0) delete data.schedule.snapshots[id];
      });
      // 只有组头的人数变了：重建这一个组框，组里的视频卡片不动
      relayout.push(node);
      touched.add(node.id);
    });
    // 断掉的连线另一头：卡片面板里的素材条要跟着更新
    edges.forEach((edge) => {
      if (!ids.has(edge.sourceId) && !ids.has(edge.targetId)) return;
      if (!ids.has(edge.sourceId)) touched.add(edge.sourceId);
      if (!ids.has(edge.targetId)) touched.add(edge.targetId);
    });
    const removed = ids.size;
    // 被删素材原来的号：重排前要先把这些号从别人的提示词里摘掉
    const removedTags = new Set();
    nodes.forEach((node) => {
      if (!ids.has(node.id)) return;
      const tag = tagOf(node);
      if (tag) removedTags.add(tag);
    });
    nodes = nodes.filter((node) => !ids.has(node.id));
    edges = edges.filter((edge) => !ids.has(edge.sourceId) && !ids.has(edge.targetId));
    selection.clear();
    // 指向已删素材的 @ 先摘掉，再重排号，引用不会悄悄跳到别的卡片上
    const stripped = stripRemovedRefs(removedTags);
    stripped.forEach((id) => touched.add(id));
    // 删掉中间一张素材后，后面的号自动往前补；提示词里的 @ 一起改成新号
    const numbered = renumberAll();
    // 序号牌只改字，不重建卡片：其余卡片上的图片 / 视频不会跟着闪
    numbered.tagged.forEach((id) => {
      const one = byId(id);
      if (one) paintIndexBadge(one);
    });
    numbered.retagged.forEach((id) => touched.add(id));
    numbered.rebound.forEach((id) => touched.add(id));
    numbered.rescheduled.forEach((id) => touched.add(id));
    // 组合 / 定时组的缩略图和成员条上写着成员的号，有人换号就重画它们的面板
    if (numbered.tagged.size) {
      nodes.forEach((one) => {
        if (one.type === 'group' || isSchedule(one)) touched.add(one.id);
      });
    }
    // 只摘掉被删的这几张卡片：不走 renderAll，就不会把全画布的图片 / 视频
    // 全部重建、重新加载，删除时其他卡片不会跟着一起闪一下
    ids.forEach((id) => {
      const el = elements.get(id);
      if (el) el.remove();
      elements.delete(id);
    });
    prunePromptHeights();
    refreshScheduleMemberMap();
    // 组里少了一张：剩下的卡片重新排一遍，中间不留空格
    relayout.forEach((node) => layoutScheduleCards(node, scheduleOrderOf(node), false));
    if (relayout.length) {
      refreshScheduleMemberMap();
      // 重排只改坐标：剩下的卡片直接在原地挪过去，不重建
      relayout.forEach((node) => {
        scheduleOrderOf(node).forEach((member) => {
          const el = elements.get(member.id);
          if (!el) return;
          el.style.left = member.x + 'px';
          el.style.top = member.y + 'px';
        });
      });
      updateEdgePaths();
      scheduleMinimap();
    }
    paintScheduleBadges();
    renderEdges();
    const refreshOne = (id, full) => {
      if (ids.has(id)) return;
      const node = byId(id);
      if (!node || !elements.has(id)) return;
      if (full || node.type === 'group' || isSchedule(node)) {
        refreshNode(node);
        if (isSchedule(node)) paintScheduleState(node, scheduleRuns.get(id) || null);
      } else {
        refreshPanelOnly(node);
      }
    };
    freed.forEach((id) => refreshOne(id, true));
    touched.forEach((id) => refreshOne(id, false));
    refreshHiddenBadge();
    paintFilter();
    keepViewportAnchored();
    refreshSelection();
    scheduleSave();
    // 删完给一条能反悔的路：撤销回到删之前（连同连线），或者去回收站翻旧文件
    toast(
      '已删除 ' + removed + ' 张卡片' + (stripped.size ? '，提示词里指向它的 @ 也一起清掉了' : ''),
      8000,
      [
        { label: '撤销删除', run: () => undo() },
        { label: '查看回收站', run: () => openRecycleBin() },
      ]
    );
  }

  function reorderSelection(toFront) {
    if (!selection.size) return;
    pushHistory();
    const picked = nodes.filter((node) => selection.has(node.id));
    const rest = nodes.filter((node) => !selection.has(node.id));
    nodes = toFront ? rest.concat(picked) : picked.concat(rest);
    refreshZOrder();
    scheduleSave();
    toast(toFront ? '已置顶' : '已置底');
  }

  function selectAll() {
    nodes.forEach((node) => {
      if (isHidden(node)) return;
      selection.add(node.id);
    });
    refreshSelection();
  }

  let lastNudgeAt = 0;

  function nudge(dx, dy) {
    if (!selection.size) return;
    const now = Date.now();
    if (now - lastNudgeAt > 700) pushHistory();
    lastNudgeAt = now;
    const moved = [];
    selection.forEach((id) => {
      const node = byId(id);
      if (!node || isLocked(node)) return;
      node.x += dx;
      node.y += dy;
      const el = elements.get(id);
      if (el) {
        el.style.left = node.x + 'px';
        el.style.top = node.y + 'px';
      }
      moved.push(node);
    });
    updateEdgePaths(moved);
    scheduleSave();
  }

  function closeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }

  function openMenu(clientX, clientY, items) {
    closeMenu();
    const rect = viewportEl.getBoundingClientRect();
    menuEl = document.createElement('div');
    menuEl.className = 'menu';
    items.forEach((item) => {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'sep';
        menuEl.appendChild(sep);
        return;
      }
      const button = document.createElement('button');
      if (item.danger) button.className = 'danger-item';
      if (item.disabled) {
        // 没得跳的项留在菜单里但点不动：菜单结构稳定，一眼看出「现在没有」，
        // 比整项消失好 —— 消失会让人以为功能没了
        button.classList.add('disabled-item');
        button.disabled = true;
        button.title = item.disabledHint || '这一项现在没有内容';
      }
      button.textContent = item.label;
      if (item.key) {
        const key = document.createElement('span');
        key.className = 'key';
        key.textContent = item.key;
        button.appendChild(key);
      }
      button.addEventListener('click', () => {
        if (item.disabled) return;
        closeMenu();
        item.run();
      });
      menuEl.appendChild(button);
    });
    viewportEl.appendChild(menuEl);
    const maxLeft = Math.max(8, rect.width - menuEl.offsetWidth - 10);
    const maxTop = Math.max(8, rect.height - menuEl.offsetHeight - 10);
    menuEl.style.left = Math.min(Math.max(8, clientX - rect.left), maxLeft) + 'px';
    menuEl.style.top = Math.min(Math.max(8, clientY - rect.top), maxTop) + 'px';
  }

  function openTypeMenu(clientX, clientY, center, opts) {
    // 连线落到空白处时只给能接收连线的三种卡片；快速视频靠 @，不接收连线
    const connectFrom = opts && opts.connectFrom ? String(opts.connectFrom) : '';
    const keepExpanded = opts && opts.keepExpanded ? String(opts.keepExpanded) : '';
    const types = connectFrom ? ADDABLE_TYPES.filter((type) => type !== 'quick') : ADDABLE_TYPES;
    const items = types.map((type) => ({
      label: presetOf(type).label,
      run: () => addNode(type, center, { connectFrom: connectFrom, keepExpanded: keepExpanded }),
    }));
    items.push({ sep: true });
    items.push({
      label: connectFrom ? '上传本地素材并连线' : '上传',
      run: () => pickLocalFiles(center, { connectFrom: connectFrom, keepExpanded: keepExpanded }),
    });
    openMenu(clientX, clientY, items);
  }

  function openNodeMenu(clientX, clientY) {
    const items = [];
    const cards = selectedCards();
    const pickedGroups = nodes.filter((node) => selection.has(node.id) && node.type === 'group');
    const onlyOneGroup = selection.size === 1 && pickedGroups.length === 1;
    if (selection.size === 1) {
      const node = byId(Array.from(selection)[0]);
      if (node) {
        if (isLocked(node)) {
          // 锁定的卡片只留「解锁」这类不碰内容的东西
        } else if (node.type === 'group') {
          items.push({ label: '改名字', run: () => { selectNode(node.id, false); setExpanded(node.id); } });
          items.push({ label: '解散组合（卡片留在画布上）', run: () => ungroup(node) });
        } else if (node.type === 'schedule') {
          const sdata = nodeData(node);
          items.push({ label: '定时设置…', run: () => { selectNode(node.id, false); setExpanded(node.id); } });
          items.push({ label: '导出组内视频…', run: () => exportScheduleVideos(node) });
          items.push({
            label: sdata.compact ? '恢复正常大小' : '紧凑模式（缩成四分之一）',
            run: () => setScheduleCompact(node, !sdata.compact),
          });
          items.push({ label: '重新排版', run: () => relayoutSchedule(node) });
          items.push({ label: '解散定时组（卡片留在画布上）', run: () => dissolveSchedule(node) });
        } else {
          const hostOfNode = memberSchedule.get(node.id) ? byId(memberSchedule.get(node.id).scheduleId) : null;
          if (hostOfNode) {
            items.push({
              label: '移出定时组（卡片留在画布上）',
              run: () => removeScheduleMember(hostOfNode, node, false),
            });
            items.push({ sep: true });
          }
          const data = nodeData(node);
          items.push({
            label: data.running ? '取消这次生成' : '开始生成',
            run: () => (data.running ? cancelGenerate(node) : startGenerate(node)),
          });
          if (node.type === 'video' || node.type === 'quick') items.push({ label: '提取尾帧', run: () => startTailFrame(node) });
          // 生成过一次就有来源可看（哪怕只有一条），但没生成过就不给这项
          if (versionEntriesOf(data).length >= 1) {
            items.push({ label: '生成来源…', run: () => openVersionPanel(node) });
          }
        }
        items.push({ sep: true });
      }
    }
    // 选中两张以上卡片就能合出一个组；选中的正好是一个组，就把别的卡片并进去
    if (cards.length >= 2 && !onlyOneGroup) {
      items.push({
        label: pickedGroups.length === 1 ? '把选中的卡片并进「' + groupNameOf(pickedGroups[0]) + '」' : '添加组',
        key: 'Ctrl+G',
        run: groupSelection,
      });
      // 框选里只要有视频卡片，就给一条创建定时组的入口；其他类型创建时自动剔除
      if (cards.some((card) => SCHEDULE_TYPES[card.type])) {
        const ready = scheduleCandidates(cards).length;
        items.push({
          label: '创建定时生成组' + (ready ? '（' + ready + ' 张视频）' : ''),
          run: () => {
            const list = scheduleCandidates(cards);
            createScheduleGroup(list, cards.length - list.length);
          },
        });
      }
      items.push({ sep: true });
    }
    if (selection.size >= 2) {
      items.push({ label: '整理选中的卡片：按连线分层', key: 'Ctrl+Shift+L', run: () => tidyLayout('flow') });
      items.push({ label: '整理选中的卡片：排成网格', run: () => tidyLayout('grid') });
      items.push({ sep: true });
    }
    items.push({ label: '导出', key: 'Ctrl+Shift+E', run: () => exportSelectedAssets() });
    items.push({ sep: true });
    items.push(
      { label: '复制', key: 'Ctrl+C', run: copySelection },
      { sep: true },
      { label: '置顶显示', run: () => reorderSelection(true) },
      { label: '置底显示', run: () => reorderSelection(false) },
      { sep: true }
    );
    const picked = Array.from(selection)
      .map((id) => byId(id))
      .filter(Boolean);
    const allLocked = picked.length > 0 && picked.every((node) => isLocked(node));
    items.push({
      label: allLocked ? '解锁' : '锁定',
      key: 'Ctrl+L',
      run: toggleLockSelection,
    });
    items.push({ label: '隐藏', key: 'Ctrl+Shift+H', run: hideSelection });
    items.push({ sep: true });
    items.push({ label: '删除', key: 'Delete', danger: true, run: deleteSelection });
    openMenu(clientX, clientY, items);
  }

  function openEdgeMenu(clientX, clientY) {
    openMenu(clientX, clientY, [
      { label: '删除这条连线', key: 'Delete', danger: true, run: () => removeEdge(selectedEdgeId) },
    ]);
  }

  function openCanvasMenu(clientX, clientY, center) {
    const items = ADDABLE_TYPES.map((type) => ({
      label: presetOf(type).label,
      run: () => addNode(type, center),
    }));
    items.push({ label: '上传', run: () => pickLocalFiles(center) });
    items.push({ label: '导出', key: 'Ctrl+Shift+E', run: () => exportSelectedAssets() });
    items.push({ sep: true });
    items.push({ label: '3D 导演台…', run: () => openDirectorStage(null, center) });
    items.push({ sep: true });
    if (clipboard && clipboard.nodes.length) items.push({ label: '粘贴', key: 'Ctrl+V', run: pasteClipboard });
    items.push({ sep: true });
    items.push({ label: '一键整理：按连线分层', key: 'Ctrl+Shift+L', run: () => tidyLayout('flow') });
    items.push({ label: '一键整理：排成网格', run: () => tidyLayout('grid') });
    items.push({ sep: true });
    items.push({ label: '全选', key: 'Ctrl+A', run: selectAll });
    items.push({ label: '适应窗口', key: 'Shift+1', run: fitView });
    const hiddenCount = hiddenNodes().length;
    if (hiddenCount) {
      items.push({ sep: true });
      items.push({ label: '恢复隐藏的卡片…（' + hiddenCount + ' 张）', run: showHiddenPicker });
    }
    openMenu(clientX, clientY, items);
  }

  // ===== 交互 =====

  function bringNodeToFront(id) {
    const index = nodes.findIndex((item) => item.id === id);
    if (index < 0) return;
    const picked = nodes.splice(index, 1)[0];
    nodes.push(picked);
    refreshZOrder();
  }

  function startDrag(event, node) {
    // 锁定的卡片：点一下照样打开面板看提示词，但拖不动、改不了
    if (isLocked(node)) {
      closeMenu();
      if (!selection.has(node.id) || event.shiftKey) selectNode(node.id, event.shiftKey);
      setExpanded(node.id);
      // 真按住拖了才提示一句，单纯点开看看不打扰
      const lockX = event.clientX;
      const lockY = event.clientY;
      let warned = false;
      const onLockMove = (ev) => {
        if (warned) return;
        if (Math.abs(ev.clientX - lockX) + Math.abs(ev.clientY - lockY) <= 5) return;
        warned = true;
        window.removeEventListener('pointermove', onLockMove, true);
        toast('这张卡片已锁定，拖不动。按 Ctrl+L 解锁');
      };
      window.addEventListener('pointermove', onLockMove, true);
      window.addEventListener('pointerup', () => window.removeEventListener('pointermove', onLockMove, true), {
        once: true,
        capture: true,
      });
      return;
    }
    const startX = event.clientX;
    const startY = event.clientY;
    // 只拖当前选中的卡片：组合卡片是独立的代表卡，拖它不会顺带把组里的
    // 素材卡（以及其他卡片）一起拖走，免得整理画布时整片都跟着跑。
    const moving = [];
    const movingIds = new Set();
    const pushMoving = (item) => {
      if (!item || movingIds.has(item.id)) return;
      // 选中的一堆里混着锁定的：只挪没锁的那些
      if (isLocked(item) || isHidden(item)) return;
      movingIds.add(item.id);
      moving.push(item);
    };
    const memberHit = memberSchedule.get(node.id);
    const memberHost = memberHit ? byId(memberHit.scheduleId) : null;
    if (memberHost) {
      // 组里的卡片只拖自己：轻移会弹回原位，拖到框外才算移出组
      pushMoving(node);
    } else {
      nodes.forEach((item) => {
        if (!selection.has(item.id)) return;
        pushMoving(item);
      });
      // 拖定时组的时候，组框和组里的卡片一起走，不会散架
      moving.slice().forEach((item) => {
        if (!isSchedule(item)) return;
        scheduleMembersOf(item).forEach(pushMoving);
      });
    }
    const origin = moving.map((item) => ({ node: item, x: item.x, y: item.y }));
    const statics = nodes.filter((item) => !movingIds.has(item.id));
    const target = event.currentTarget;
    let moved = false;
    // 按住 Shift 点一下 = 加选，松手时不能把刚选好的这一堆打散
    const additive = Boolean(event.shiftKey);
    beginTransaction();
    beginInteraction();

    // 拖动只写 transform（GPU 合成），不碰 left/top，整帧不触发重排
    const nodeIndex = new Map(nodes.map((item) => [item.id, item]));
    let frame = 0;
    let flipAt = 0;

    const paintDrag = () => {
      frame = 0;
      origin.forEach((item) => {
        const el = elements.get(item.node.id);
        if (!el) return;
        const dx = item.node.x - item.x;
        const dy = item.node.y - item.y;
        el.style.transform = Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01
          ? ''
          : 'translate3d(' + dx + 'px,' + dy + 'px,0)';
      });
      if (memberHost) paintMemberDrag(node, memberHost);
      updateEdgePaths(origin.map((item) => item.node), nodeIndex);
      placeAlignBar();
      // 面板翻面要量尺寸：拖得再快也最多 8 帧查一次
      if (expandedId === node.id) {
        const now = performance.now();
        if (now - flipAt > 120) {
          flipAt = now;
          refreshPanelFlip(node);
        }
      }
    };

    // 松手：把 transform 一次性落到 left/top 上，视觉位置不变
    const commitDrag = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      origin.forEach((item) => {
        const el = elements.get(item.node.id);
        if (!el) return;
        el.style.left = Math.round(item.node.x) + 'px';
        el.style.top = Math.round(item.node.y) + 'px';
        el.style.transform = '';
        item.node.x = Math.round(item.node.x);
        item.node.y = Math.round(item.node.y);
      });
      if (memberHost) paintMemberDrag(node, memberHost);
    };

    const onMove = (moveEvent) => {
      let dx = (moveEvent.clientX - startX) / viewport.zoom;
      let dy = (moveEvent.clientY - startY) / viewport.zoom;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 1) {
        moved = true;
        bringNodeToFront(node.id);
        pushHistory();
      }
      if (!moved) return;
      // 对齐辅助线默认关着：关着时卡片完全跟着手走，不吸附、不画线
      if (snapGuideOn && !moveEvent.ctrlKey) {
        const snapped = computeSnap(origin, dx, dy, statics);
        dx = snapped.dx;
        dy = snapped.dy;
        renderGuides(snapped.guides);
      } else {
        clearGuides();
      }
      origin.forEach((item) => {
        item.node.x = item.x + dx;
        item.node.y = item.y + dy;
      });
      if (!frame) frame = window.requestAnimationFrame(paintDrag);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      endInteraction();
      clearGuides();
      if (moved) commitDrag();
      if (!moved) {
        dropTransaction();
        // 按住 Shift 点一下只是加选，别把已经选好的那一堆打散
        if (additive) {
          refreshSelection();
          return;
        }
        // 点一下（没有拖动）＝ 选中这一张并展开它的编辑面板
        selectNode(node.id, false);
        setExpanded(node.id);
        return;
      }
      // 组里的卡片：拖到框外才算移出，留在框内就滑回原来的槽位
      if (memberHost) {
        if (!memberInside(memberHost, node)) {
          clearMemberDrag();
          removeScheduleMember(memberHost, node, true, true);
          toast('这张卡片被拖到组外，已经移出定时组（Ctrl+Z 可以撤销）');
          return;
        }
        snapMemberBack(node, memberHost);
        return;
      }
      scheduleSave();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      /* 捕获失败也不影响拖动 */
    }
  }

  function startResize(event, node, el) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    closeMenu();
    if (isLocked(node)) {
      toast('这张卡片已锁定，大小也改不了。按 Ctrl+L 解锁');
      return;
    }
    if (isSchedule(node)) {
      toast('定时组的大小跟着组里的卡片自动排，用「紧凑模式」可以整体缩小');
      return;
    }
    if (memberSchedule.get(node.id)) {
      toast('定时组里的卡片大小统一，移出组后才能单独调');
      return;
    }
    const handle = event.currentTarget;
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = sizeOf(node);
    const ratio = origin.w > 0 ? origin.h / origin.w : 0.5625;
    const presets = resizePresets(node, origin);
    // 所有卡片缩到最小都是同一档尺寸，图片和视频不会一大一小
    const minWidth = presets.reduce((small, item) => Math.min(small, item.w), origin.w);
    let started = false;
    let finished = false;
    let frame = 0;
    let pendingW = origin.w;
    beginTransaction();

    // 拖动过程只改宽高 + 连线，不做重建面板这类重活，保证跟手
    // 面板宽度只跟缩放有关、不跟卡片宽高有关，拖动过程先不重排，
    // 松手时统一校正一次，避免每帧强制布局
    const paint = (width) => {
      node.w = width;
      node.h = Math.max(MIN_H, Math.round(width * ratio));
      el.style.width = node.w + 'px';
      el.style.height = node.h + 'px';
    };

    const applyFrame = () => {
      frame = 0;
      paint(pendingW);
      updateEdgePaths([node]);
      placeAlignBar();
    };

    const onMove = (moveEvent) => {
      if (finished) return;
      if (pointerId != null && moveEvent.pointerId != null && moveEvent.pointerId !== pointerId) return;
      // 兜底：视频卡片的原生播放控件偶尔会把 pointerup 吞掉，
      // 只要左键已经不在了就立刻收尾，避免松手后卡片还跟着鼠标缩放
      if (typeof moveEvent.buttons === 'number' && (moveEvent.buttons & 1) === 0) {
        finish();
        return;
      }
      const dx = (moveEvent.clientX - startX) / viewport.zoom;
      const dy = (moveEvent.clientY - startY) / viewport.zoom;
      const pull = dx + dy * 0.5;
      if (!started && Math.abs(pull) > 4) {
        started = true;
        nodeData(node).sized = true;
        el.classList.add('resizing');
        pushHistory();
      }
      if (!started) return;
      // 缩略图素材可能比最小宽度还窄，再怎么拉也不该被撑大
      pendingW = Math.round(Math.max(minWidth, origin.w + pull));
      if (frame) return;
      // 每帧最多画一次，鼠标再快也不会堆积
      frame = requestAnimationFrame(applyFrame);
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('mouseup', finish);
      window.removeEventListener('blur', finish);
      document.removeEventListener('visibilitychange', onVisibility);
      if (handle && handle.releasePointerCapture && pointerId != null) {
        try {
          handle.releasePointerCapture(pointerId);
        } catch {
          /* 已经释放过就算了 */
        }
      }
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      el.classList.remove('resizing');
      if (!started) {
        dropTransaction();
        return;
      }
      // 松手后落到最近的固定档位：拖动时顺滑，停下来永远是整齐的尺寸
      const step = nearestPresetIndex(presets, pendingW);
      node.w = presets[step].w;
      node.h = presets[step].h;
      el.style.width = node.w + 'px';
      el.style.height = node.h + 'px';
      updateEdgePaths([node]);
      placePanel();
      placeAlignBar();
      scheduleSave();
    };

    const onVisibility = () => {
      if (document.hidden) finish();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('mouseup', finish);
    window.addEventListener('blur', finish);
    document.addEventListener('visibilitychange', onVisibility);
    // 把指针锁在手柄上，视频自带的控件就抢不走这次拖动的收尾事件
    if (handle && handle.setPointerCapture && pointerId != null) {
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        /* 捕获失败也不影响拖动 */
      }
    }
  }

  function startConnect(event, node) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    closeMenu();
    const from = anchorOf(node, 'out');
    // 这一趟拉线之前展开的是哪张：连线结束后要展开回来，别打断正在写的提示词
    const resumeId = keepExpandedAfterConnect || (expandedId && expandedId !== node.id ? expandedId : null);
    let dragged = false;
    const startClient = { x: event.clientX, y: event.clientY };
    const temp = document.createElementNS(SVG_NS, 'path');
    temp.setAttribute('class', 'edge-temp');
    temp.setAttribute('d', curvePath(from, from));
    svgLayer.appendChild(temp);

    const onMove = (moveEvent) => {
      if (Math.abs(moveEvent.clientX - startClient.x) + Math.abs(moveEvent.clientY - startClient.y) > 6) {
        dragged = true;
      }
      temp.setAttribute('d', curvePath(from, toWorld(moveEvent.clientX, moveEvent.clientY)));
      const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const overNode = under && under.closest ? under.closest('.node') : null;
      const overId = overNode ? overNode.dataset.id : '';
      const overNodeRef = overId ? byId(overId) : null;
      const blocked = Boolean(overNodeRef) && (isLocked(overNodeRef) || isHidden(overNodeRef));
      elements.forEach((el, id) => {
        el.classList.toggle(
          'connect-target',
          Boolean(overNode) && overNode.dataset.id === id && id !== node.id && !blocked
        );
        el.classList.toggle(
          'connect-blocked',
          Boolean(overNode) && overNode.dataset.id === id && id !== node.id && blocked
        );
      });
    };

    const onUp = (upEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      temp.remove();
      elements.forEach((el) => el.classList.remove('connect-target', 'connect-blocked'));
      const under = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
      const overNode = under && under.closest ? under.closest('.node') : null;
      const handled = { force: false };
      keepExpandedAfterConnect = null;
      if (overNode && overNode.dataset.id !== node.id) {
        addEdge(node.id, overNode.dataset.id);
      } else if (!overNode && dragged) {
        // 松在空白处：就地弹「新增卡片」菜单，选完自动连回来
        openTypeMenu(upEvent.clientX, upEvent.clientY, toWorld(upEvent.clientX, upEvent.clientY), {
          connectFrom: node.id,
          keepExpanded: resumeId || node.id,
        });
        handled.force = true;
      }
      // 连线成功或弹出菜单后：把原来正在编辑的那张重新展开，别打断写提示词
      if (!handled.force && resumeId && byId(resumeId)) {
        expandedId = resumeId;
        selection.clear();
        selection.add(resumeId);
        refreshSelection();
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function startPan(event, clearOnClick) {
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = viewport.x;
    const originY = viewport.y;
    let moved = false;
    viewportEl.classList.add('panning');
    beginInteraction();

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      viewport.x = originX + dx;
      viewport.y = originY + dy;
      scheduleViewport();
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      viewportEl.classList.remove('panning');
      endInteraction();
      if (moved) {
        flushViewport();
        scheduleSave();
      } else if (clearOnClick) {
        clearSelection();
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function startMarquee(event, additive) {
    const rect = viewportBox();
    const startX = event.clientX - rect.left;
    const startY = event.clientY - rect.top;
    const box = document.createElement('div');
    box.className = 'marquee';
    box.style.left = startX + 'px';
    box.style.top = startY + 'px';
    box.style.width = '0px';
    box.style.height = '0px';
    viewportEl.appendChild(box);
    let moved = false;

    const onMove = (moveEvent) => {
      const currentX = moveEvent.clientX - rect.left;
      const currentY = moveEvent.clientY - rect.top;
      const left = Math.min(startX, currentX);
      const top = Math.min(startY, currentY);
      const width = Math.abs(currentX - startX);
      const height = Math.abs(currentY - startY);
      if (width + height > 3) moved = true;
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.width = width + 'px';
      box.style.height = height + 'px';
    };

    const onUp = (upEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      box.remove();
      if (!moved) {
        if (!additive) clearSelection();
        return;
      }
      const currentX = upEvent.clientX - rect.left;
      const currentY = upEvent.clientY - rect.top;
      const left = Math.min(startX, currentX);
      const top = Math.min(startY, currentY);
      const width = Math.abs(currentX - startX);
      const height = Math.abs(currentY - startY);
      const a = toWorld(rect.left + left, rect.top + top);
      const b = toWorld(rect.left + left + width, rect.top + top + height);
      const hit = nodes.filter((node) => {
        if (isHidden(node)) return false;
        const size = sizeOf(node);
        return node.x < b.x && node.x + size.w > a.x && node.y < b.y && node.y + size.h > a.y;
      });
      if (!additive) {
        selection.clear();
        selectedEdgeId = null;
      }
      hit.forEach((node) => selection.add(node.id));
      refreshSelection();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = viewportBox();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const worldX = (mx - viewport.x) / viewport.zoom;
    const worldY = (my - viewport.y) / viewport.zoom;
    const next = clamp(viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    viewport.x = mx - worldX * next;
    viewport.y = my - worldY * next;
    viewport.zoom = next;
    applyViewport();
    scheduleSave();
  }

  // 滚轮缩放：一帧只算一次，连续滚动时不会每来一个事件就重排一遍
  let zoomPending = null;
  let zoomFrame = 0;
  let zoomSaveTimer = 0;
  let zoomIdleTimer = 0;
  function queueZoom(clientX, clientY, factor) {
    if (!zoomPending) zoomPending = { x: clientX, y: clientY, factor: 1 };
    zoomPending.x = clientX;
    zoomPending.y = clientY;
    zoomPending.factor *= factor;
    if (!zoomFrame) {
      zoomFrame = window.requestAnimationFrame(() => {
        zoomFrame = 0;
        const job = zoomPending;
        zoomPending = null;
        if (!job) return;
        applyZoomStep(job.x, job.y, job.factor);
      });
    }
    if (!zoomIdleTimer) beginInteraction();
    if (zoomIdleTimer) window.clearTimeout(zoomIdleTimer);
    zoomIdleTimer = window.setTimeout(() => {
      zoomIdleTimer = 0;
      endInteraction();
      if (zoomSaveTimer) window.clearTimeout(zoomSaveTimer);
      zoomSaveTimer = 0;
      scheduleSave();
    }, 320);
  }

  function applyZoomStep(clientX, clientY, factor) {
    const rect = viewportBox();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const worldX = (mx - viewport.x) / viewport.zoom;
    const worldY = (my - viewport.y) / viewport.zoom;
    const next = clamp(viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    viewport.x = mx - worldX * next;
    viewport.y = my - worldY * next;
    viewport.zoom = next;
    scheduleViewport();
  }

  function zoomCenter(factor) {
    const rect = viewportEl.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  function resetView() {
    viewport = { x: 0, y: 0, zoom: 1 };
    applyViewport();
    scheduleSave();
  }

  // 一批卡片的外接矩形。没东西可算就返回 null（调用方据此决定要不要 fallback）。
  // measure 可选：默认按卡片当前显示尺寸；测试里可以塞一个替身。
  function boundsOfNodes(list, measure) {
    const arr = (Array.isArray(list) ? list : []).filter(Boolean);
    if (!arr.length) return null;
    const measureOf = typeof measure === 'function' ? measure : sizeOf;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    arr.forEach((node) => {
      const size = measureOf(node) || { w: 0, h: 0 };
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + size.w);
      maxY = Math.max(maxY, node.y + size.h);
    });
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    if (!Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
    return {
      minX: minX,
      minY: minY,
      maxX: maxX,
      maxY: maxY,
      w: Math.max(1, maxX - minX),
      h: Math.max(1, maxY - minY),
    };
  }

  // 由外接矩形算出「刚好框住」的缩放与平移。view 是可视区尺寸。
  // 抽成纯函数是为了单测能直接验算，不用真起一个浏览器。
  function fitTransformOf(bounds, view, pad) {
    const gap = Math.max(24, Number(pad) || 70);
    const width = Math.max(60, (Number(view && view.w) || 0) - gap * 2);
    const height = Math.max(60, (Number(view && view.h) || 0) - gap * 2);
    const zoom = clamp(Math.min(width / (bounds.w || 1), height / (bounds.h || 1)), MIN_ZOOM, MAX_ZOOM);
    return {
      zoom: zoom,
      x: gap + (width - bounds.w * zoom) / 2 - bounds.minX * zoom,
      y: gap + (height - bounds.h * zoom) / 2 - bounds.minY * zoom,
    };
  }

  // 把画面缩放到「刚好框住这一批卡片」。fitView 是它的全量特例，
  // 快速定位的几种入口都用这一个，缩放规则不会各写一套。
  function fitToNodes(list, opts) {
    const bounds = boundsOfNodes(list);
    if (!bounds) return false;
    const next = fitTransformOf(bounds, { w: viewportEl.clientWidth, h: viewportEl.clientHeight }, opts && opts.pad);
    viewport.zoom = next.zoom;
    viewport.x = next.x;
    viewport.y = next.y;
    applyViewport();
    return true;
  }

  // 选中这一批卡片并跳过去。单选时不缩小 —— 直接保持当前缩放居中，
  // 不然「跳到最近完成」这种只有一张的场景会被硬拉得很近或很远。
  function locateNodes(list, opts) {
    const arr = (Array.isArray(list) ? list : []).filter(Boolean);
    if (!arr.length) return false;
    selection.clear();
    selectedEdgeId = null;
    arr.forEach((node) => selection.add(node.id));
    refreshSelection();
    if (arr.length === 1) {
      const node = arr[0];
      const size = sizeOf(node);
      const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
      viewport.zoom = zoom;
      viewport.x = viewportEl.clientWidth / 2 - (node.x + size.w / 2) * zoom;
      viewport.y = viewportEl.clientHeight / 2 - (node.y + size.h / 2) * zoom;
      applyViewport();
    } else {
      fitToNodes(arr, opts);
    }
    scheduleSave();
    return true;
  }

  // ---------- 快速定位（清单 22）----------
  //
  // 「最近改过」需要「每张卡片各不相同」的时间点。库里的 nodes.updated_at 是整块
  // 保存时统一盖的戳 —— 同一块画布的每张卡片都是同一个值，比不出先后，用不了。
  //
  // 所以这里自己记：每次保存前，把每张卡片当前的样子算一个签名，跟上次保存时
  // 留下的签名比一比，变过的就盖上此刻的时间。好处是只有一处逻辑，不用在
  // 四十多个「改内容」的地方各插一行 —— 那种写法漏一个就有一类改动永远定位不到。
  // 顺带还天然排除了「只是平移了画面」这种不算改卡片的保存。
  let touchSignatures = new Map();
  let touchBaselineReady = false;

  function cardSignature(node) {
    const data = nodeData(node);
    return [
      Math.round(node.x),
      Math.round(node.y),
      Math.round(node.w),
      Math.round(node.h),
      data.text,
      data.title,
      data.model,
      JSON.stringify(data.params || {}),
      data.result ? String(data.result.url || '') : '',
      Array.isArray(data.history) ? data.history.length : 0,
      data.hidden ? 1 : 0,
      data.locked ? 1 : 0,
    ].join('\u0001');
  }

  // 返回这次保存里被改过的卡片张数。第一次调用只建基线不算改过 ——
  // 否则刚打开画布就会把所有卡片都盖成「刚刚」。
  function stampTouchedCards() {
    const next = new Map();
    let changed = 0;
    const at = Date.now();
    nodes.forEach((node) => {
      const sig = cardSignature(node);
      next.set(node.id, sig);
      if (!touchBaselineReady) return;
      if (touchSignatures.get(node.id) === sig) return;
      nodeData(node).editedAt = at;
      changed += 1;
    });
    touchSignatures = next;
    touchBaselineReady = true;
    return changed;
  }

  function touchedAtOf(node) {
    const data = nodeData(node);
    const seen = [
      Number(data.editedAt) || 0,
      Number(data.lastSubmission && data.lastSubmission.at) || 0,
      Number(data.result && data.result.at) || 0,
    ];
    const history = Array.isArray(data.history) ? data.history : [];
    if (history.length) seen.push(Number(history[0] && history[0].at) || 0);
    return Math.max.apply(null, seen.concat([0]));
  }

  function finishedAtOf(node) {
    const data = nodeData(node);
    return Number(data.result && data.result.at) || 0;
  }

  // 按某个时间戳挑「最新的那一张」。一张都没有（或全没时间）时返回 null，
  // 调用方据此把菜单项置灰，而不是点下去什么都不发生。
  function newestBy(list, stampOf) {
    let best = null;
    let bestAt = -1;
    (Array.isArray(list) ? list : []).forEach((node) => {
      if (!node) return;
      const at = Number(stampOf(node)) || 0;
      if (at > bestAt) {
        bestAt = at;
        best = node;
      }
    });
    return best && bestAt > 0 ? { node: best, at: bestAt } : null;
  }

  // 此刻真的在跑的卡片：自己生成中的，加上定时组里正在跑的那几张（连同组卡本身）。
  // includeHidden 用来区分「没有」和「有但被藏起来了」—— 后者得先放出来才看得到。
  function runningTargets(opts) {
    const includeHidden = Boolean(opts && opts.includeHidden);
    const seen = new Set();
    const out = [];
    const push = (node) => {
      if (!node || seen.has(node.id)) return;
      if (!includeHidden && isHidden(node)) return;
      seen.add(node.id);
      out.push(node);
    };
    nodes.forEach((node) => {
      if (isSchedule(node)) {
        const run = scheduleRuns.get(node.id) || null;
        const items = (run && run.items) || [];
        items.forEach((one) => {
          if (one && one.status === 'running') push(byId(one.nodeId));
        });
        if (items.some((one) => one && one.status === 'running')) push(node);
        return;
      }
      if (isTaskActive(nodeData(node))) push(node);
    });
    return out;
  }

  function sinceTextOf(at) {
    const ms = Number(at) || 0;
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 3600 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 30 * 86400 * 1000) return Math.floor(diff / 86400000) + ' 天前';
    return timeTextOf(ms);
  }

  // 一张卡片在定位菜单里怎么称呼：标题 → 序号徽章 → 类型名
  function locateLabelOf(node) {
    const data = nodeData(node);
    const title = String(data.title || '').trim();
    if (title) return title;
    const tag = tagOf(node);
    if (tag) return tag;
    const preset = presetOf(node.type);
    return (preset && preset.label) || '卡片';
  }

  function clipText(text, max) {
    const str = String(text == null ? '' : text);
    const limit = Math.max(2, Number(max) || 14);
    return str.length > limit ? str.slice(0, limit - 1) + '…' : str;
  }

  function locateRunning() {
    const list = runningTargets();
    if (!list.length) {
      const hidden = runningTargets({ includeHidden: true }).length;
      toast(
        hidden
          ? '有 ' + hidden + ' 张卡片正在生成，但都被藏起来了。先按 Ctrl+Shift+H 把它们放出来'
          : '现在没有正在生成的卡片'
      );
      return;
    }
    locateNodes(list, { pad: 90 });
    toast('正在生成的有 ' + list.length + ' 张，已经圈出来了', 6000, [
      {
        label: '打开任务面板',
        run: () => {
          if (window.TaskPanel && window.TaskPanel.open) window.TaskPanel.open();
        },
      },
    ]);
  }

  // kind='touched' 找最近改过的，其余找最近生成完成的
  function locateNewest(kind) {
    const byTouched = kind === 'touched';
    const hit = newestBy(visibleNodes(), byTouched ? touchedAtOf : finishedAtOf);
    if (!hit) {
      toast(byTouched ? '这些卡片还没有改过，找不到「最近修改」' : '还没有生成完成的卡片');
      return;
    }
    locateNodes([hit.node], { pad: 90 });
    const when = sinceTextOf(hit.at);
    toast(
      (byTouched ? '最近修改：' : '最近完成：') + locateLabelOf(hit.node) + (when ? '（' + when + '）' : ''),
      6000,
      [{ label: '展开这张卡片', run: () => setExpanded(hit.node.id) }]
    );
  }

  // 定位按钮：弹出三个入口。每项都把「会跳到哪张、多久以前」写在脸上，
  // 免得点下去才发现跳错了地方；没得跳的项置灰，点不动。
  function openLocateMenu(clientX, clientY) {
    const running = runningTargets();
    const hiddenRunning = runningTargets({ includeHidden: true }).length - running.length;
    const finished = newestBy(visibleNodes(), finishedAtOf);
    const touched = newestBy(visibleNodes(), touchedAtOf);
    const items = [
      {
        label: running.length
          ? '只看正在生成的（' + running.length + ' 张）'
          : hiddenRunning
          ? '只看正在生成的（' + hiddenRunning + ' 张被藏起来了）'
          : '只看正在生成的（现在没有）',
        disabled: running.length === 0,
        disabledHint: hiddenRunning ? '先按 Ctrl+Shift+H 把藏起来的卡片放出来' : '现在没有卡片在生成',
        run: locateRunning,
      },
      {
        label: finished
          ? '跳到最近完成：' + clipText(locateLabelOf(finished.node), 14)
          : '跳到最近完成（还没有生成完成的）',
        key: finished ? sinceTextOf(finished.at) : '',
        disabled: !finished,
        run: () => locateNewest('finished'),
      },
      {
        label: touched
          ? '跳到最近修改：' + clipText(locateLabelOf(touched.node), 14)
          : '跳到最近修改（还没有改过的）',
        key: touched ? sinceTextOf(touched.at) : '',
        disabled: !touched,
        run: () => locateNewest('touched'),
      },
    ];
    openMenu(clientX, clientY, items);
  }

  function paintLocateBadge() {
    const badge = document.getElementById('locate-badge');
    if (!badge) return;
    const count = runningTargets().length;
    badge.textContent = count + '';
    badge.hidden = count === 0;
  }

  function fitView() {
    if (!nodes.length) {
      resetView();
      return;
    }
    // 适应窗口只看看得见的卡片
    const list = visibleNodes();
    if (!list.length) {
      resetView();
      return;
    }
    if (!fitToNodes(list, { pad: 70 })) resetView();
    scheduleSave();
  }

  // 从任务面板跳过来时地址里带 ?node=卡片编号，把画面挪到那张卡片上并选中它
  function focusNodeById(id) {
    const node = byId(String(id || ''));
    if (!node) return false;
    const size = sizeOf(node);
    const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
    viewport.zoom = zoom;
    viewport.x = viewportEl.clientWidth / 2 - (node.x + size.w / 2) * zoom;
    viewport.y = viewportEl.clientHeight / 2 - (node.y + size.h / 2) * zoom;
    applyViewport();
    selectNode(node.id, false);
    return true;
  }

  // 选择 / 平移合成一颗按钮，图标按当前模式换
  const TOOL_ICONS = {
    select:
      '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M5 2.6l0 16.6 4.1-4.1 2.7 5.9 2.5-1.1-2.7-5.9 5.8 0z"/></svg>',
    hand:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18"/><path d="M12 3l-2.4 2.4M12 3l2.4 2.4M12 21l-2.4-2.4M12 21l2.4-2.4M3 12l2.4-2.4M3 12l2.4 2.4M21 12l-2.4-2.4M21 12l-2.4 2.4"/></svg>',
  };

  // 白天 / 夜间按钮的图标
  const THEME_ICONS = {
    dark:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.6A8.6 8.6 0 019.4 3.5a8.6 8.6 0 1011.1 11.1z"/></svg>',
    light:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M4.4 12H2.2M21.8 12h-2.2M6.2 6.2L4.7 4.7M19.3 19.3l-1.5-1.5M6.2 17.8l-1.5 1.5M19.3 4.7l-1.5 1.5"/></svg>',
  };

  function paintThemeButton(theme) {
    const dark = theme === 'dark';
    const icon = document.getElementById('theme-icon');
    if (icon) icon.innerHTML = THEME_ICONS[dark ? 'light' : 'dark'];
    const label = document.getElementById('theme-label');
    if (label) label.textContent = dark ? '日间模式' : '夜间模式';
    setRailDesc('btn-theme', dark ? '现在是夜间模式，点一下换回白天' : '现在是白天模式，点一下换成夜间');
  }

  // 左侧「提交压缩」：打开后所有通道、所有模型每次提交参考图都先压一遍
  function paintSubmitCompress(on) {
    const button = document.getElementById('btn-submit-compress');
    if (!button) return;
    button.classList.toggle('on', Boolean(on));
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    const dot = document.getElementById('submit-compress-dot');
    if (dot) dot.hidden = !on;
    const desc = on
      ? '提交压缩：已打开。所有通道每次提交参考图都会先压缩，只压提交用的临时副本，原图和素材库文件不变。点一下关闭'
      : '提交压缩：已关闭。只在参考图超过通道大小限制时自动压缩。点一下打开';
    setRailDesc('btn-submit-compress', desc);
    button.title = desc;
  }

  // 左侧「尾部提示词」：单击开关总开关，双击管理预设
  function paintTailPrompts(on) {
    const button = document.getElementById('btn-tail-prompts');
    if (!button) return;
    button.classList.toggle('on', Boolean(on));
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    const dot = document.getElementById('tail-prompts-dot');
    if (dot) dot.hidden = !on;
    const desc = on
      ? '尾部提示词：已启用。生成时会按卡片选择自动追加预设文字。单击关闭，双击管理预设'
      : '尾部提示词：已关闭。所有卡片暂不追加预设文字。单击启用，双击管理预设';
    setRailDesc('btn-tail-prompts', desc);
    button.title = desc;
  }

  async function toggleTailPrompts() {
    if (!window.UITheme) return;
    const button = document.getElementById('btn-tail-prompts');
    const current = window.UITheme.tailPrompts();
    const next = !(current && current.enabled !== false);
    paintTailPrompts(next);
    if (button) button.disabled = true;
    try {
      await window.UITheme.save({ tailPrompts: { ...current, enabled: next } });
      paintTailPrompts(window.UITheme.tailPrompts().enabled);
      document.dispatchEvent(new CustomEvent('tail-prompts-changed'));
      toast(next ? '尾部提示词总开关已打开' : '尾部提示词总开关已关闭：已有卡片的设置会保留');
    } catch (error) {
      paintTailPrompts(current && current.enabled !== false);
      toast('这个开关没存上，请再试一次：' + error.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function toggleSubmitCompress() {
    const button = document.getElementById('btn-submit-compress');
    if (!window.UITheme) return;
    const current = window.UITheme.submitCompress();
    const next = !current.enabled;
    // 先按新状态亮起来，保存失败再退回去
    paintSubmitCompress(next);
    button.disabled = true;
    try {
      await window.UITheme.save({ submitCompress: { enabled: next } });
      paintSubmitCompress(window.UITheme.submitCompress().enabled);
      toast(next
        ? '提交压缩已打开：所有通道每次提交都会先压缩参考图（只压提交副本）'
        : '提交压缩已关闭：以后只在参考图超出限制时才压缩');
    } catch (error) {
      paintSubmitCompress(current.enabled);
      toast('这个开关没存上，请再试一次：' + error.message);
    } finally {
      button.disabled = false;
    }
  }

  function setMode(next) {
    mode = next;
    const hand = next === 'hand';
    const btn = document.getElementById('tool-mode');
    if (btn) btn.classList.toggle('on', hand);
    setRailDesc('tool-mode', hand
      ? '现在是「平移」工具（默认）：拖空白处移动画面，按住 Ctrl 拖空白处可以框选卡片。点一下换回「选择」（快捷键 H / V）'
      : '现在是「选择」工具：点选、框选、拖动卡片。点一下换成「平移」（快捷键 V / H）');
    const icon = document.getElementById('tool-mode-icon');
    if (icon) icon.innerHTML = TOOL_ICONS[hand ? 'hand' : 'select'];
    const label = document.getElementById('tool-mode-label');
    if (label) label.textContent = hand ? '平移' : '选择';
    viewportEl.classList.toggle('mode-hand', hand);
  }

  // 左侧工具栏：平时藏在画布左边，鼠标碰到左边缘才滑出；图标上的简介用自绘气泡
  function bindRail() {
    const rail = document.getElementById('rail');
    const page = document.querySelector('.canvas-page');
    if (!rail || !page) return;

    const EDGE = 10;        // 鼠标离左边缘多近就开始弹出
    const OPEN_DELAY = 110; // 停一下再弹，手划过去不会误触
    const CLOSE_DELAY = 420; // 移开后缓一下再收，避免闪

    let openTimer = 0;
    let closeTimer = 0;

    const tip = document.createElement('div');
    tip.className = 'rail-tip';
    document.body.appendChild(tip);

    const isOpen = () => rail.classList.contains('open');

    // 工具栏可占的竖向范围：上面留 14px，下面到小地图上方 10px 为止
    const region = () => {
      const EDGE = 14;
      const GAP = 10;
      const mm = document.getElementById('minimap');
      const bottom = mm && !mm.classList.contains('hidden')
        ? mm.getBoundingClientRect().top - GAP
        : window.innerHeight - EDGE;
      return { top: EDGE, bottom: Math.max(EDGE + 160, bottom) };
    };
    const railPadding = () => {
      const cs = window.getComputedStyle(rail);
      return {
        padTop: parseFloat(cs.paddingTop) || 0,
        padBottom: parseFloat(cs.paddingBottom) || 0
      };
    };
    const availableHeight = () => {
      const { padTop, padBottom } = railPadding();
      const reg = region();
      return Math.max(180, Math.floor(reg.bottom - reg.top - padTop - padBottom));
    };

    // 图标大小：先挑大号，屏幕放不下再一级级缩小，尽量不让工具条挤到小地图
    const SIZES = [42, 40, 38, 36, 34, 32];
    const applySize = (px) => {
      rail.style.setProperty('--rail-btn-size', px + 'px');
      rail.style.setProperty('--rail-icon-size', Math.round(px / 2) + 'px');
      rail.style.setProperty('--rail-name-size', Math.round(px * 0.9) + 'px');
    };
    const neededHeight = () => {
      const group = rail.querySelector('.rail-group');
      const cs = window.getComputedStyle(rail);
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      return (group ? group.offsetHeight : 0) + pad;
    };
    const fitLargest = () => {
      const avail = availableHeight();
      for (const px of SIZES) {
        applySize(px);
        if (neededHeight() <= avail) return true;
      }
      return false;
    };
    let reflowQueued = false;
    const runReflow = () => {
      reflowQueued = false;
      rail.classList.remove('two-col');
      if (!fitLargest()) {
        // 一列怎么都放不下，就排成两列再试
        rail.classList.add('two-col');
        if (!fitLargest()) applySize(SIZES[SIZES.length - 1]);
      }
      // 竖向居中：以整个窗口的中线为基准；只有会压到左下角小地图时，才往上让一点
      const reg = region();
      const { padTop, padBottom } = railPadding();
      const group = rail.querySelector('.rail-group');
      const pill = group ? group.offsetHeight : 0;
      const idealTop = (window.innerHeight - pill) / 2;
      const maxTop = Math.max(reg.top, reg.bottom - pill);
      const pillTop = Math.min(Math.max(idealTop, reg.top), maxTop);
      rail.style.top = Math.round(pillTop - padTop) + 'px';
      rail.style.maxHeight = Math.ceil(Math.max(pill, reg.bottom - pillTop) + padBottom) + 'px';
      // 左边那个小把手也跟着对齐到工具栏中间
      const zone = document.getElementById('rail-zone');
      if (zone) zone.style.top = Math.round(pillTop + pill / 2) + 'px';
      if (isOpen()) placeTip(tip.dataset.for);
    };
    const reflow = () => {
      if (reflowQueued) return;
      reflowQueued = true;
      window.requestAnimationFrame(runReflow);
    };
    window.__railReflow = reflow;
    window.requestAnimationFrame(runReflow);

    const open = () => {
      window.clearTimeout(openTimer);
      openTimer = 0;
      window.clearTimeout(closeTimer);
      closeTimer = 0;
      rail.classList.add('open');
      page.classList.add('rail-open');
    };

    const close = () => {
      window.clearTimeout(openTimer);
      openTimer = 0;
      window.clearTimeout(closeTimer);
      closeTimer = 0;
      // 保存失败期间不许自动收起，否则用户刚要去看红点它就缩回去了
      if (saveRailPinned) return;
      rail.classList.remove('open');
      page.classList.remove('rail-open');
      tip.classList.remove('show');
    };

    const closeSoon = () => {
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(close, CLOSE_DELAY);
    };

    // 鼠标贴到画布左边缘就弹出来
    document.addEventListener(
      'mousemove',
      (event) => {
        // 手正按着拖卡片 / 画框选的时候不弹，免得挡住操作
        if (event.buttons) return;
        if (event.clientX > EDGE) {
          if (openTimer) {
            window.clearTimeout(openTimer);
            openTimer = 0;
          }
          return;
        }
        if (isOpen() || openTimer) return;
        if (document.querySelector('.modal-mask')) return;
        openTimer = window.setTimeout(open, OPEN_DELAY);
      },
      { passive: true }
    );

    rail.addEventListener('mouseenter', () => {
      window.clearTimeout(closeTimer);
      closeTimer = 0;
    });
    rail.addEventListener('mouseleave', closeSoon);

    // 键盘 Tab 到工具栏里也要能看见它
    rail.addEventListener('focusin', open);
    rail.addEventListener('focusout', (event) => {
      if (!rail.contains(event.relatedTarget)) closeSoon();
    });

    // 点画布别处就收起来，但弹窗里的操作不受影响
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.modal-mask')) return;
      if (isOpen() && !rail.contains(target)) closeSoon();
    });
    window.addEventListener('resize', reflow);
    window.addEventListener('load', () => window.requestAnimationFrame(reflow));

    // ---- 图标上的功能简介 ----
    let tipTimer = 0;

    function hideTip() {
      window.clearTimeout(tipTimer);
      tipTimer = 0;
      tip.classList.remove('show');
    }

    function placeTip(id) {
      const el = id ? document.getElementById(id) : null;
      if (!el || !tip.classList.contains('show')) return;
      const rect = el.getBoundingClientRect();
      const gap = 10;
      let left = rect.right + gap;
      const width = tip.offsetWidth;
      if (left + width > window.innerWidth - 8) left = Math.max(8, rect.left - gap - width);
      let top = rect.top + rect.height / 2;
      const half = tip.offsetHeight / 2;
      top = Math.min(Math.max(top, half + 8), window.innerHeight - half - 8);
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }

    function showTip(el, delay) {
      window.clearTimeout(tipTimer);
      const run = () => {
        const labelEl = el.querySelector('.rail-text');
        const isName = el.classList.contains('rail-name');
        const heading = isName
          ? (labelEl && labelEl.textContent.trim() ? labelEl.textContent.trim() : '画布名字')
          : labelEl
            ? labelEl.textContent.trim()
            : '';
        // 按钮说明会随状态变（夜间/白天、辅助线开关），每次显示都重新读一遍
        const desc = el.dataset.railDesc || el.getAttribute('title') || (heading ? '' : (el.textContent || '').trim());
        if (!desc && !heading) return;
        tip.dataset.for = el.id || '';
        tip.innerHTML = '';
        if (heading) {
          const b = document.createElement('b');
          b.textContent = heading;
          tip.appendChild(b);
        }
        if (desc) {
          const span = document.createElement('span');
          span.textContent = desc;
          tip.appendChild(span);
        }
        tip.classList.add('show');
        placeTip(el.id);
      };
      if (delay) tipTimer = window.setTimeout(run, delay);
      else run();
    }

    const items = rail.querySelectorAll('.rail-btn, .rail-name');
    items.forEach((el) => {
      // 去掉浏览器自带的灰提示，改成自己的气泡
      const native = el.getAttribute('title');
      if (native) {
        if (!el.dataset.railDesc) el.dataset.railDesc = native;
        el.removeAttribute('title');
      }
      if (!el.hasAttribute('aria-label')) {
        const labelEl = el.querySelector('.rail-text');
        el.setAttribute('aria-label', labelEl ? labelEl.textContent.trim() : '');
      }
      el.addEventListener('mouseenter', () => showTip(el, 140));
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('focus', () => showTip(el, 0));
      el.addEventListener('blur', hideTip);
    });

    // 保存状态也是一个小圆点，鼠标移上去说明一下
    const saveDot = document.getElementById('save-state');
    if (saveDot) {
      saveDot.setAttribute('aria-label', (saveDot.textContent || '').trim() || '保存状态');
      const dotNative = saveDot.getAttribute('title');
      if (dotNative) {
        if (!saveDot.dataset.railDesc) saveDot.dataset.railDesc = dotNative;
        saveDot.removeAttribute('title');
      }
      saveDot.addEventListener('mouseenter', () => showTip(saveDot, 140));
      saveDot.addEventListener('mouseleave', hideTip);
    }
  }

  // 快捷键：默认一套，用户在「显示与设置」改过就按改过的来
  const FALLBACK_SHORTCUTS = {
    select: 'v',
    hand: 'h',
    fit: 'shift+1',
    reset: 'ctrl+0',
    undo: 'ctrl+z',
    remove: 'delete',
    tidy: 'ctrl+shift+l',
    export: 'ctrl+shift+e',
  };

  function shortcutMap() {
    const custom = window.UITheme && window.UITheme.shortcuts ? window.UITheme.shortcuts() : null;
    return Object.assign({}, FALLBACK_SHORTCUTS, custom || {});
  }

  function comboOf(event) {
    const mods = [];
    if (event.ctrlKey || event.metaKey) mods.push('ctrl');
    if (event.altKey) mods.push('alt');
    if (event.shiftKey) mods.push('shift');
    let key = String(event.key || '').toLowerCase();
    const shifted = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' };
    if (shifted[key]) key = shifted[key];
    if (key === 'delete' || key === 'backspace') key = 'delete';
    if (key === ' ') key = 'space';
    return key ? mods.concat(key).join('+') : '';
  }

  function hitShortcut(event) {
    const combo = comboOf(event);
    if (!combo) return '';
    const map = shortcutMap();
    const actions = Object.keys(map);
    for (let index = 0; index < actions.length; index += 1) {
      if (map[actions[index]] === combo) return actions[index];
    }
    return '';
  }

  // ---------- 性能小面板：默认隐藏，Ctrl+Alt+P 或地址后加 ?perf=1 才出现 ----------
  // 只在自己可见的时候跑统计，不看不耗性能。
  const perfPanelEl = document.getElementById('perf-panel');
  const perfOut = {
    fps: document.getElementById('perf-fps'),
    frame: document.getElementById('perf-frame'),
    long: document.getElementById('perf-long'),
    dom: document.getElementById('perf-dom'),
    media: document.getElementById('perf-media'),
    mem: document.getElementById('perf-mem'),
  };
  let perfOn = false;
  let perfRaf = 0;
  let perfLast = 0;
  let perfFrames = [];
  let perfLongCount = 0;
  let perfLongTotal = 0;
  let perfLongObserver = null;
  let perfLastPaint = 0;

  function perfText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function perfSample(now) {
    if (!perfOn) return;
    if (perfLast) {
      const delta = now - perfLast;
      if (delta > 0 && delta < 2000) perfFrames.push(delta);
      if (perfFrames.length > 120) perfFrames.shift();
    }
    perfLast = now;
    if (now - perfLastPaint > 500) {
      perfLastPaint = now;
      const sorted = perfFrames.slice().sort((a, b) => a - b);
      const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
      const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
      perfText(perfOut.fps, avg > 0 ? String(Math.round(1000 / avg)) : '--');
      perfText(perfOut.frame, sorted.length ? Math.round(p95) + ' ms' : '--');
      perfText(perfOut.long, perfLongCount + ' 次' + (perfLongTotal ? ' / ' + Math.round(perfLongTotal) + ' ms' : ''));
      perfText(perfOut.dom, String(document.getElementsByTagName('*').length));
      const imgs = document.querySelectorAll('.node img').length;
      const vids = document.querySelectorAll('.node video').length;
      perfText(perfOut.media, imgs + ' / ' + vids);
      const mem = performance.memory;
      perfText(perfOut.mem, mem && mem.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1048576) + ' MB' : '--');
      if (perfPanelEl) perfPanelEl.classList.toggle('is-warn', p95 > 24 || perfLongCount > 0);
    }
    perfRaf = window.requestAnimationFrame(perfSample);
  }

  function setPerfPanel(on) {
    perfOn = Boolean(on);
    if (perfPanelEl) {
      perfPanelEl.classList.toggle('show', perfOn);
      perfPanelEl.setAttribute('aria-hidden', perfOn ? 'false' : 'true');
    }
    if (perfRaf) {
      window.cancelAnimationFrame(perfRaf);
      perfRaf = 0;
    }
    if (!perfOn) {
      if (perfLongObserver) {
        try { perfLongObserver.disconnect(); } catch { /* 忽略 */ }
        perfLongObserver = null;
      }
      perfFrames = [];
      perfLast = 0;
      perfLongCount = 0;
      perfLongTotal = 0;
      return;
    }
    perfFrames = [];
    perfLast = 0;
    perfLongCount = 0;
    perfLongTotal = 0;
    perfLastPaint = 0;
    if (typeof PerformanceObserver === 'function') {
      try {
        perfLongObserver = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => {
            perfLongCount += 1;
            perfLongTotal += entry.duration;
          });
        });
        perfLongObserver.observe({ entryTypes: ['longtask'] });
      } catch { /* 浏览器不支持就算了 */ }
    }
    perfRaf = window.requestAnimationFrame(perfSample);
  }

  function setupPerfPanel() {
    if (params.get('perf') === '1') setPerfPanel(true);
  }

  function bindEvents() {
    // 点到卡片本体和它的编辑面板之外的地方，就把展开的提示词栏收起来。
    // 侧边栏、工具栏、端口、连线这些区域的点击不会走到卡片的选中逻辑，
    // 所以需要在这里统一兜底。
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (!target || !target.closest) return;
        // @ 素材列表挂在 body 上，点它本身不算「点到外面」
        if (mentionEl && mentionEl.contains(target)) return;
        // 点到列表和它所属的提示词框以外（画布空白、别的卡片、工具栏）→ 收起列表
        if (mentionEl && !(mentionBox && mentionBox.contains(target))) closeMention();
        if (!expandedId) return;
        if (menuEl && menuEl.contains(target)) return;
        if (promptEditorEl && promptEditorEl.contains(target)) return;
        // 从任意卡片的端口开始拉线：不收起当前提示词编辑，等连线结束后再展开回来
        if (target.closest('.port')) {
          keepExpandedAfterConnect = expandedId;
          return;
        }
        const el = elements.get(expandedId);
        if (el && el.contains(target)) {
          // 卡片内部：拖右下角改尺寸先收起提示词栏，其余区域保持展开
          if (target.closest('.resize-handle')) setExpanded(null);
          return;
        }
        setExpanded(null);
      },
      true
    );

    document.addEventListener('dragstart', (event) => {
      if (viewportEl.contains(event.target)) event.preventDefault();
    });

    viewportEl.addEventListener('mousedown', (event) => {
      if (event.button === 1) event.preventDefault();
    });

    viewportEl.addEventListener('pointerdown', (event) => {
      if (menuEl && menuEl.contains(event.target)) return;
      if (event.target !== viewportEl && event.target !== worldEl) return;
      if (event.button === 2) return;
      closeMenu();
      // 按住 Ctrl 拖空白处 = 框选多张卡片（平移模式下也能用，方便打包成组）
      if (event.button === 0 && (event.ctrlKey || event.metaKey)) {
        startMarquee(event, event.shiftKey);
        return;
      }
      if (event.button === 1 || mode === 'hand' || spaceDown) {
        startPan(event, event.button === 0 && !spaceDown);
        return;
      }
      if (event.button !== 0) return;
      startMarquee(event, event.shiftKey);
    });

    // 滚轮先给“鼠标底下真正能滚的东西”用：长提示词框、素材条、检查器。
    // 以前这里无条件 preventDefault，导致提示词框里滚动也会把画布缩放掉。
    const WHEEL_SCROLL_OVERFLOW = /^(auto|scroll|overlay)$/;

    // 鼠标是不是落在“文字输入框”里（卡片里的提示词、大窗口里的提示词）
    function wheelEditorTarget(target) {
      if (!target || !target.closest) return null;
      return target.closest('.node-prompt, .prompt-editor, textarea');
    }

    // 从鼠标位置往上找第一个能上下滚的容器
    function wheelScroller(target) {
      let el = target && target.nodeType === 1 ? target : null;
      while (el && el !== viewportEl && el !== document.body) {
        const style = window.getComputedStyle(el);
        if (WHEEL_SCROLL_OVERFLOW.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) {
          return el;
        }
        el = el.parentElement;
      }
      return null;
    }

    viewportEl.addEventListener(
      'wheel',
      (event) => {
        // 提示词框：滚轮只滚文字；就算滚到头、或者内容根本不够滚，也不去缩放画布
        const editing = wheelEditorTarget(event.target);
        if (editing) {
          event.stopPropagation();
          const style = window.getComputedStyle(editing);
          const canScroll = WHEEL_SCROLL_OVERFLOW.test(style.overflowY) && editing.scrollHeight > editing.clientHeight + 1;
          if (!canScroll) event.preventDefault();
          return;
        }
        // 卡片面板 / 素材条 / 检查器里的滚动区：让它们自己滚，不去缩放画布
        if (wheelScroller(event.target)) {
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        closeMention();
        queueZoom(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0014));
      },
      { passive: false }
    );

    viewportEl.addEventListener('dblclick', (event) => {
      if (event.target !== viewportEl && event.target !== worldEl) return;
      openTypeMenu(event.clientX, event.clientY, toWorld(event.clientX, event.clientY));
    });

    viewportEl.addEventListener('contextmenu', (event) => {
      if (event.target !== viewportEl && event.target !== worldEl) return;
      event.preventDefault();
      openCanvasMenu(event.clientX, event.clientY, toWorld(event.clientX, event.clientY));
    });

    document.addEventListener('keydown', (event) => {
      // 放大窗开着时，方向键、删除键这些画布快捷键先不动画布
      if (lightboxEl) return;
      // Ctrl+Alt+P：性能小面板，随时可以开 / 关，也不打扰正在输入的文字
      if ((event.ctrlKey || event.metaKey) && event.altKey && String(event.key || '').toLowerCase() === 'p') {
        event.preventDefault();
        setPerfPanel(!perfOn);
        return;
      }
      const typing = editingId !== null || (event.target && (event.target.isContentEditable || event.target.tagName === 'INPUT'));
      // 筛选面板开着时，Esc 不管焦点在哪都先把它收起来
      if (filterEl && event.key === 'Escape') {
        event.preventDefault();
        closeFilterPanel();
        return;
      }
      // 快捷键表打开时，键位只用来搜和关，不去动画布
      if (helpEl) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeHelp();
        }
        return;
      }
      if (event.key === 'F1' || (event.ctrlKey && event.key === '/')) {
        event.preventDefault();
        openHelp();
        return;
      }
      if (event.code === 'Space' && !typing) {
        spaceDown = true;
        if (mode !== 'hand') viewportEl.classList.add('mode-hand');
      }
      if ((event.key === 'Control' || event.key === 'Meta') && !typing) {
        viewportEl.classList.add('ctrl-select');
      }
      // 找卡片：不管光标在哪都能按出来，盖掉浏览器自带的查找
      if ((event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 'f') {
        event.preventDefault();
        openSearch();
        return;
      }
      if (event.key === 'Escape') {
        if (searchOpen()) {
          closeSearch();
          return;
        }
        if (editingId) {
          const el = elements.get(editingId);
          const box = el ? el.querySelector('.node-prompt') : null;
          if (box) box.blur();
        } else {
          clearSelection();
          closeMenu();
        }
        return;
      }
      if (typing) return;
      // 锁定 / 隐藏：Ctrl+L、Ctrl+Shift+H
      const mod = event.ctrlKey || event.metaKey;
      const hotKey = String(event.key || '').toLowerCase();
      if (mod && !event.shiftKey && hotKey === 'l') {
        event.preventDefault();
        toggleLockSelection();
        return;
      }
      if (mod && event.shiftKey && hotKey === 'h') {
        event.preventDefault();
        toggleHideSelection();
        return;
      }
      // 快捷键：默认一套，用户改过就按用户改的来
      const action = hitShortcut(event);
      if (action === 'select') {
        setMode('select');
        return;
      }
      if (action === 'hand') {
        setMode('hand');
        return;
      }
      if (action === 'undo') {
        event.preventDefault();
        undo();
        return;
      }
      if (action === 'reset') {
        event.preventDefault();
        resetView();
        return;
      }
      if (action === 'fit') {
        event.preventDefault();
        fitView();
        return;
      }
      if (action === 'tidy') {
        event.preventDefault();
        tidyLayout('flow');
        return;
      }
      if (action === 'export') {
        event.preventDefault();
        // 导出素材：弹出选择目录的窗口，再把卡片背后的原文件复制过去
        exportSelectedAssets();
        return;
      }
      if (action === 'remove') {
        event.preventDefault();
        deleteSelection();
        return;
      }
      const ctrl = event.ctrlKey || event.metaKey;
      const key = (event.key || '').toLowerCase();
      if (ctrl && key === 'c') {
        copySelection();
        return;
      }
      if (ctrl && key === 'v') {
        pasteClipboard();
        return;
      }
      if (ctrl && key === 'a') {
        event.preventDefault();
        selectAll();
        return;
      }
      if (ctrl && key === 'g') {
        event.preventDefault();
        groupSelection();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (!selection.size) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        if (event.key === 'ArrowLeft') nudge(-step, 0);
        if (event.key === 'ArrowRight') nudge(step, 0);
        if (event.key === 'ArrowUp') nudge(0, -step);
        if (event.key === 'ArrowDown') nudge(0, step);
        return;
      }
    });

    document.addEventListener('keyup', (event) => {
      if (event.code === 'Space') {
        spaceDown = false;
        if (mode !== 'hand') viewportEl.classList.remove('mode-hand');
      }
      if (event.key === 'Control' || event.key === 'Meta') viewportEl.classList.remove('ctrl-select');
    });

    window.addEventListener('blur', () => {
      spaceDown = false;
      viewportEl.classList.remove('ctrl-select');
      if (mode !== 'hand') viewportEl.classList.remove('mode-hand');
    });
  }

  // ---------- 小地图：一眼看到所有卡片在哪，点一下就能跳过去 ----------
  const MM_W = 200;
  const MM_H = 132;
  const MM_PAD = 9;
  const MM_KEY = 'canvas-minimap';
const MM_TINTS = { image: '#2f9e6f', video: '#b4552f', audio: '#7a4fd4', group: '#4a6da8', quick: '#1f7a8c', schedule: '#f08a24' };

  let mmEl = null;
  let mmCanvas = null;
  let mmCtx = null;
  let mmView = null;
  let mmShown = true;
  let mmQueued = false;

  function setupMinimap() {
    mmEl = document.getElementById('minimap');
    mmCanvas = document.getElementById('minimap-canvas');
    if (!mmEl || !mmCanvas) return;
    setSnapGuide(snapGuideOn);
    mmCtx = mmCanvas.getContext('2d');
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    mmCanvas.width = Math.round(MM_W * dpr);
    mmCanvas.height = Math.round(MM_H * dpr);
    mmCanvas.style.width = MM_W + 'px';
    mmCanvas.style.height = MM_H + 'px';
    mmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let stored = null;
    try {
      stored = window.localStorage.getItem(MM_KEY);
    } catch {
      stored = null;
    }
    mmShown = stored !== '0';
    paintMinimapButton();

    let dragging = false;
    const jumpTo = (event) => {
      if (!mmView) return;
      const rect = mmCanvas.getBoundingClientRect();
      const wx = (event.clientX - rect.left - mmView.ox) / mmView.scale;
      const wy = (event.clientY - rect.top - mmView.oy) / mmView.scale;
      viewport.x = viewportEl.clientWidth / 2 - wx * viewport.zoom;
      viewport.y = viewportEl.clientHeight / 2 - wy * viewport.zoom;
      applyViewport();
      scheduleSave();
    };
    mmCanvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      dragging = true;
      try {
        mmCanvas.setPointerCapture(event.pointerId);
      } catch {
        /* 捕获不到也能用 */
      }
      jumpTo(event);
    });
    mmCanvas.addEventListener('pointermove', (event) => {
      if (dragging) jumpTo(event);
    });
    const stop = () => {
      dragging = false;
    };
    mmCanvas.addEventListener('pointerup', stop);
    mmCanvas.addEventListener('pointercancel', stop);
    window.addEventListener('resize', scheduleMinimap);
    // 窗口大小一变，展开的面板要重新量：可能得翻面，也可能要收窄
    window.addEventListener('resize', () => {
      if (expandedId) placePanel();
    });
    // 兜底：卡片被别处改动（粘贴、撤销、生成回填）时也不会漏画
    window.setInterval(() => {
      if (mmShown) scheduleMinimap();
    }, 2500);
    scheduleMinimap();
  }

  function paintMinimapButton() {
    if (mmEl) mmEl.classList.toggle('hidden', !mmShown);
    if (window.__railReflow) window.requestAnimationFrame(window.__railReflow);
    const btn = document.getElementById('btn-minimap');
    if (btn) btn.classList.toggle('on', mmShown);
    setRailDesc('btn-minimap', mmShown ? '小地图开着，点一下收起' : '展开小地图，一眼看到所有卡片在哪');
  }

  function toggleMinimap() {
    mmShown = !mmShown;
    paintMinimapButton();
    try {
      window.localStorage.setItem(MM_KEY, mmShown ? '1' : '0');
    } catch {
      /* 忽略 */
    }
    if (mmShown) scheduleMinimap();
  }

  // 一帧最多画一次，拖动卡片的时候也不会卡
  let mmLastDraw = 0;
  function scheduleMinimap() {
    if (!mmCtx || !mmShown || mmQueued) return;
    mmQueued = true;
    // 拖动 / 缩放时小地图不需要每帧重画，降到一个不显眼的小频率
    if (interactingCount > 0 && performance.now() - mmLastDraw < 140) {
      window.setTimeout(() => {
        mmQueued = false;
        drawMinimap();
      }, 140);
      return;
    }
    window.requestAnimationFrame(() => {
      mmQueued = false;
      drawMinimap();
    });
  }

  function drawMinimap() {
    if (!mmCtx || !mmShown) return;
    mmLastDraw = performance.now();
    const ctx = mmCtx;
    ctx.clearRect(0, 0, MM_W, MM_H);
    const box = viewportBox();

    const view = {
      x: -viewport.x / viewport.zoom,
      y: -viewport.y / viewport.zoom,
      w: box.width / viewport.zoom,
      h: box.height / viewport.zoom,
    };
    // 视野和卡片一起算进来，跳远的时候也能一眼看到自己在哪
    let minX = view.x;
    let minY = view.y;
    let maxX = view.x + view.w;
    let maxY = view.y + view.h;
    // 隐藏的卡片不画进小地图
    visibleNodes().forEach((node) => {
      const size = sizeOf(node);
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + size.w);
      maxY = Math.max(maxY, node.y + size.h);
    });
    minX -= 40;
    minY -= 40;
    maxX += 40;
    maxY += 40;
    const worldW = Math.max(1, maxX - minX);
    const worldH = Math.max(1, maxY - minY);
    const innerW = MM_W - MM_PAD * 2;
    const innerH = MM_H - MM_PAD * 2;
    const scale = Math.min(innerW / worldW, innerH / worldH);
    const ox = MM_PAD + (innerW - worldW * scale) / 2 - minX * scale;
    const oy = MM_PAD + (innerH - worldH * scale) / 2 - minY * scale;
    mmView = { scale: scale, ox: ox, oy: oy };
    const px = (x) => ox + x * scale;
    const py = (y) => oy + y * scale;

    ctx.strokeStyle = 'rgba(140, 150, 168, 0.5)';
    ctx.lineWidth = 1;
    edges.forEach((edge) => {
      const a = byId(edge.sourceId);
      const b = byId(edge.targetId);
      if (!a || !b || isHidden(a) || isHidden(b)) return;
      const asize = sizeOf(a);
      const bsize = sizeOf(b);
      ctx.beginPath();
      ctx.moveTo(px(a.x + asize.w), py(a.y + asize.h / 2));
      ctx.lineTo(px(b.x), py(b.y + bsize.h / 2));
      ctx.stroke();
    });

    // 当前画面的范围先铺一层淡蓝底，卡片画在它上面，颜色才不会被染蓝
    ctx.fillStyle = 'rgba(47, 111, 237, 0.13)';
    ctx.fillRect(px(view.x), py(view.y), view.w * scale, view.h * scale);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f6fed';
    visibleNodes().forEach((node) => {
      const size = sizeOf(node);
      const w = Math.max(2, size.w * scale);
      const h = Math.max(2, size.h * scale);
      ctx.fillStyle = MM_TINTS[node.type] || '#8b93a3';
      ctx.fillRect(px(node.x), py(node.y), w, h);
      if (selection.has(node.id)) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.6;
        ctx.strokeRect(px(node.x) - 1.5, py(node.y) - 1.5, w + 3, h + 3);
      }
    });

    // 当前画面的框线压在最上面，一眼看出自己在画布的哪一块
    ctx.strokeStyle = 'rgba(47, 111, 237, 0.9)';
    ctx.lineWidth = 1.4;
    ctx.strokeRect(px(view.x), py(view.y), view.w * scale, view.h * scale);

    if (!nodes.length) {
      ctx.fillStyle = 'rgba(140, 150, 168, 0.95)';
      ctx.font = '12px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('还没有卡片', MM_W / 2, MM_H / 2);
    }
  }

  // ---------- 找卡片：Ctrl+F 搜提示词 / 模型 / 类型，点一条直接跳过去 ----------
  const searchPanel = document.getElementById('search-panel');
  const searchInput = document.getElementById('search-input');
  const searchHint = document.getElementById('search-hint');
  const searchList = document.getElementById('search-list');
  let searchHits = [];
  let searchCursor = 0;

  function searchOpen() {
    return Boolean(searchPanel) && !searchPanel.classList.contains('hidden');
  }

  function searchEntries() {
    return nodes.map((node) => {
      const data = nodeData(node);
      const label = presetOf(node.type).label;
      const members = node.type === 'group' ? groupMembersOf(node) : [];
      const text = displayText(data.text).trim();
      const memberNames = members.map(
        (member) => displayText((member.data && member.data.text) || '').trim() || presetOf(member.type).label
      );
      const state = data.running
        ? { text: '生成中', cls: 'run' }
        : data.error
        ? { text: '失败', cls: 'bad' }
        : data.result && data.result.url
        ? { text: '已完成', cls: '' }
        : { text: '', cls: '' };
      return {
        id: node.id,
        type: node.type,
        label: label,
        title:
          node.type === 'group'
            ? groupNameOf(node) + (members.length ? '（' + members.length + ' 个素材）' : '（空组合）')
            : (tagOf(node) ? tagOf(node) + '　' : '') +
              (String(data.title || '').trim() || text || label + '（还没写提示词）'),
        sub: [String(data.model || ''), memberNames.length ? '组里：' + memberNames.join('、') : '']
          .filter(Boolean)
          .join('　·　'),
        state: state,
        hay: [label, String(data.model || ''), text, String(data.title || ''), tagOf(node)]
          .concat(memberNames)
          .join(' ')
          .toLowerCase(),
      };
    });
  }

  function renderSearchHits(query) {
    if (!searchList) return;
    const q = String(query || '').trim().toLowerCase();
    const all = searchEntries();
    searchHits = q ? all.filter((item) => item.hay.indexOf(q) >= 0) : all;
    searchList.innerHTML = '';
    if (!searchHits.length) {
      searchCursor = 0;
      searchHint.classList.add('warn');
      searchHint.textContent = nodes.length ? '没有找到匹配的卡片，换个词试试' : '这张画布上还没有卡片';
      return;
    }
    searchCursor = clamp(searchCursor, 0, searchHits.length - 1);
    searchHint.classList.remove('warn');
    searchHint.textContent = q
      ? '找到 ' + searchHits.length + ' 张，点一条就跳过去（↑↓ 选，回车确定）'
      : '这张画布上有 ' + searchHits.length + ' 张卡片，输几个字就能筛出来';
    searchHits.forEach((hit, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-hit' + (index === searchCursor ? ' cursor' : '');
      button.dataset.type = hit.type;
      const dot = document.createElement('span');
      dot.className = 'dot';
      const main = document.createElement('span');
      main.className = 'sh-main';
      const title = document.createElement('span');
      title.className = 'sh-title';
      title.textContent = hit.title;
      const sub = document.createElement('span');
      sub.className = 'sh-sub';
      sub.textContent = hit.sub || hit.label;
      main.appendChild(title);
      main.appendChild(sub);
      const state = document.createElement('span');
      state.className = 'sh-state' + (hit.state.cls ? ' ' + hit.state.cls : '');
      state.textContent = hit.state.text;
      button.appendChild(dot);
      button.appendChild(main);
      button.appendChild(state);
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', () => goToNode(hit.id));
      searchList.appendChild(button);
    });
  }

  // 跳到一张卡片上：画面居中、选中、展开编辑面板
  function goToNode(id) {
    closeSearch();
    const target = byId(String(id || ''));
    if (target && isHidden(target)) {
      target.data.hidden = false;
      renderAll();
      refreshSelection();
      scheduleSave();
      toast('这张卡片刚才是隐藏状态，已经帮你放回画布');
    }
    if (!focusNodeById(id)) {
      toast('这张卡片已经不在了，可能已经被删掉');
      return false;
    }
    setExpanded(id);
    return true;
  }

  function openSearch() {
    if (!searchPanel) return;
    searchPanel.classList.remove('hidden');
    searchCursor = 0;
    renderSearchHits(searchInput.value);
    searchInput.focus({ preventScroll: true });
    searchInput.select();
  }

  function closeSearch() {
    if (!searchPanel) return;
    searchPanel.classList.add('hidden');
    searchInput.value = '';
    searchHits = [];
    searchCursor = 0;
  }

  function moveSearch(step) {
    if (!searchHits.length) return;
    searchCursor = (searchCursor + step + searchHits.length) % searchHits.length;
    const items = Array.from(searchList.querySelectorAll('.search-hit'));
    items.forEach((el, index) => el.classList.toggle('cursor', index === searchCursor));
    const active = items[searchCursor];
    // 结果列表自己滚动，别让搜索结果把整个画布可视区带着滚走
    if (active && searchList) {
      const top = active.offsetTop;
      const bottom = top + active.offsetHeight;
      if (top < searchList.scrollTop) searchList.scrollTop = top;
      else if (bottom > searchList.scrollTop + searchList.clientHeight) searchList.scrollTop = bottom - searchList.clientHeight;
    }
  }

  function bindSearch() {
    const button = document.getElementById('btn-search');
    if (button) button.addEventListener('click', openSearch);
    if (!searchPanel) return;
    const close = document.getElementById('search-close');
    if (close) close.addEventListener('click', closeSearch);
    searchInput.addEventListener('input', () => {
      searchCursor = 0;
      renderSearchHits(searchInput.value);
    });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSearch(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSearch(-1);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const hit = searchHits[searchCursor];
        if (hit) goToNode(hit.id);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSearch();
      }
    });
  }

  // ---------- 一键整理排版：按连线分层（左→右）或者排成网格 ----------
  const LAYOUT_COL_GAP = 96;
  const LAYOUT_ROW_GAP = 56;

  // 排版时「组合卡片 + 组里的素材」算一个整体，一起挪，不会散架
  function layoutUnits(scopeIds) {
    const used = new Set();
    const units = [];
    const take = (node, members) => {
      if (used.has(node.id)) return;
      if (scopeIds && !scopeIds.has(node.id)) return;
      // 锁定的卡片原地不动，不参与整理排版
      if (isLocked(node)) return;
      const list = [node].concat(members);
      list.forEach((item) => used.add(item.id));
      units.push({ id: node.id, nodes: list });
    };
    // 组合先认领组里的卡片，剩下的卡片再各自成一组
    nodes.forEach((node) => {
      if (node.type !== 'group') return;
      take(node, groupMembersOf(node));
    });
    // 定时组也连成员一起挪，整理排版不会把组里的排布打散
    nodes.forEach((node) => {
      if (node.type !== 'schedule') return;
      take(node, scheduleMembersOf(node));
    });
    nodes.forEach((node) => {
      if (node.type === 'group' || node.type === 'schedule') return;
      take(node, []);
    });
    return units;
  }

  function unitBox(unit) {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    unit.nodes.forEach((node) => {
      const size = sizeOf(node);
      x1 = Math.min(x1, node.x);
      y1 = Math.min(y1, node.y);
      x2 = Math.max(x2, node.x + size.w);
      y2 = Math.max(y2, node.y + size.h);
    });
    return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
  }

  // 选中两张以上卡片时只整理这一块，没选东西就整理整张画布
  function layoutScope() {
    if (selection.size < 2) return null;
    const ids = new Set();
    nodes.forEach((node) => {
      if (!selection.has(node.id)) return;
      ids.add(node.id);
      if (node.type === 'group') groupMembersOf(node).forEach((member) => ids.add(member.id));
    });
    return ids;
  }

  // 只算「整体与整体之间」的连线，组合内部的连线不参与排版
  function unitLinks(units) {
    const unitOf = new Map();
    units.forEach((unit) => unit.nodes.forEach((node) => unitOf.set(node.id, unit.id)));
    const outs = new Map();
    const ins = new Map();
    units.forEach((unit) => {
      outs.set(unit.id, []);
      ins.set(unit.id, []);
    });
    edges.forEach((edge) => {
      const from = unitOf.get(edge.sourceId);
      const to = unitOf.get(edge.targetId);
      if (!from || !to || from === to) return;
      if (outs.get(from).indexOf(to) < 0) outs.get(from).push(to);
      if (ins.get(to).indexOf(from) < 0) ins.get(to).push(from);
    });
    return { outs: outs, ins: ins };
  }

  // 按连线分层：没接别人素材的排最左，由它衍生出来的往右排；环上的连线忽略掉，不会算不完
  function flowPlan(units, boxes, origin) {
    const links = unitLinks(units);
    const state = new Map();
    const depth = new Map();
    const depthOf = (id) => {
      const seen = state.get(id);
      if (seen === 2) return depth.get(id);
      if (seen === 1) return -1;
      state.set(id, 1);
      let best = 0;
      (links.ins.get(id) || []).forEach((from) => {
        const value = depthOf(from);
        if (value >= 0) best = Math.max(best, value + 1);
      });
      state.set(id, 2);
      depth.set(id, best);
      return best;
    };
    units.forEach((unit) => depthOf(unit.id));

    const columns = [];
    units.forEach((unit) => {
      const level = depth.get(unit.id) || 0;
      if (!columns[level]) columns[level] = [];
      columns[level].push(unit.id);
    });
    const order = columns.map((column) => column.slice());
    order.forEach((column) => {
      column.sort((a, b) => boxes.get(a).y - boxes.get(b).y || boxes.get(a).x - boxes.get(b).x);
    });
    // 连线尽量不交叉：来回几轮重心排序
    for (let pass = 0; pass < 4; pass += 1) {
      const forward = pass % 2 === 0;
      const spot = new Map();
      order.forEach((column) => column.forEach((id, index) => spot.set(id, index)));
      const line = order.map((_, index) => index);
      if (!forward) line.reverse();
      line.forEach((index) => {
        if (forward && index === 0) return;
        if (!forward && index === order.length - 1) return;
        const column = order[index];
        const keys = new Map();
        column.forEach((id, position) => {
          const refs = (forward ? links.ins.get(id) : links.outs.get(id)) || [];
          const spots = refs.map((other) => spot.get(other)).filter((value) => typeof value === 'number');
          keys.set(id, spots.length ? spots.reduce((sum, value) => sum + value, 0) / spots.length : position);
        });
        column.sort((a, b) => keys.get(a) - keys.get(b) || boxes.get(a).y - boxes.get(b).y);
      });
    }

    const columnWidth = order.map((column) => Math.max.apply(null, column.map((id) => boxes.get(id).w)));
    const columnHeight = order.map((column) =>
      column.reduce((sum, id, position) => sum + boxes.get(id).h + (position ? LAYOUT_ROW_GAP : 0), 0)
    );
    const tallest = Math.max.apply(null, columnHeight);
    const plan = new Map();
    let x = origin.x;
    order.forEach((column, index) => {
      let y = origin.y + Math.round((tallest - columnHeight[index]) / 2);
      column.forEach((id) => {
        const box = boxes.get(id);
        plan.set(id, { x: Math.round(x + (columnWidth[index] - box.w) / 2), y: Math.round(y) });
        y += box.h + LAYOUT_ROW_GAP;
      });
      x += columnWidth[index] + LAYOUT_COL_GAP;
    });
    return plan;
  }

  // 网格排布：保持原来的上下左右顺序，一行一行摆齐
  function gridPlan(units, boxes, origin) {
    const list = units
      .slice()
      .sort((a, b) => boxes.get(a.id).y - boxes.get(b.id).y || boxes.get(a.id).x - boxes.get(b.id).x);
    const total = list.length;
    let sumW = 0;
    let sumH = 0;
    list.forEach((unit) => {
      sumW += boxes.get(unit.id).w;
      sumH += boxes.get(unit.id).h;
    });
    const shape = sumH / total / Math.max(1, sumW / total);
    const columns = Math.max(1, Math.min(total, Math.round(Math.sqrt(total * Math.max(0.2, shape) * 1.2))));
    const columnWidth = new Array(columns).fill(0);
    const rowHeight = [];
    list.forEach((unit, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      columnWidth[column] = Math.max(columnWidth[column], boxes.get(unit.id).w);
      rowHeight[row] = Math.max(rowHeight[row] || 0, boxes.get(unit.id).h);
    });
    const plan = new Map();
    list.forEach((unit, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const box = boxes.get(unit.id);
      let x = origin.x;
      for (let step = 0; step < column; step += 1) x += columnWidth[step] + LAYOUT_COL_GAP;
      let y = origin.y;
      for (let step = 0; step < row; step += 1) y += rowHeight[step] + LAYOUT_ROW_GAP;
      plan.set(unit.id, { x: Math.round(x + (columnWidth[column] - box.w) / 2), y: Math.round(y) });
    });
    return plan;
  }

  function boundsOf(list) {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    list.forEach((node) => {
      const size = sizeOf(node);
      x1 = Math.min(x1, node.x);
      y1 = Math.min(y1, node.y);
      x2 = Math.max(x2, node.x + size.w);
      y2 = Math.max(y2, node.y + size.h);
    });
    if (!Number.isFinite(x1)) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function tidyLayout(kind, wholeCanvas) {
    if (nodes.length < 2) {
      toast('画布上还没有几张卡片，先加几张再来整理');
      return;
    }
    const scope = wholeCanvas ? null : layoutScope();
    const units = layoutUnits(scope);
    if (units.length < 2) {
      toast('这一块只有一张卡片，不用整理');
      return;
    }
    const boxes = new Map();
    units.forEach((unit) => boxes.set(unit.id, unitBox(unit)));
    let left = Infinity;
    let top = Infinity;
    boxes.forEach((box) => {
      left = Math.min(left, box.x);
      top = Math.min(top, box.y);
    });
    const origin = { x: Math.round(left), y: Math.round(top) };
    const plan = kind === 'grid' ? gridPlan(units, boxes, origin) : flowPlan(units, boxes, origin);
    const before = boundsOf(nodes);
    pushHistory();
    units.forEach((unit) => {
      const target = plan.get(unit.id);
      if (!target) return;
      const box = boxes.get(unit.id);
      const dx = Math.round(target.x - box.x);
      const dy = Math.round(target.y - box.y);
      if (!dx && !dy) return;
      unit.nodes.forEach((node) => {
        node.x = Math.round(node.x + dx);
        node.y = Math.round(node.y + dy);
      });
    });
    // 画面跟着挪一点：整理完还看得见刚才那一块，不会被甩到别处
    const after = boundsOf(nodes);
    viewport.x += Math.round((before.x + before.w / 2 - (after.x + after.w / 2)) * viewport.zoom);
    viewport.y += Math.round((before.y + before.h / 2 - (after.y + after.h / 2)) * viewport.zoom);
    renderAll();
    applyViewport();
    refreshSelection();
    scheduleSave();
    toast((kind === 'grid' ? '已经排成网格：' : '已经按连线从左到右排好：') + units.length + ' 张卡片');
  }

  function openTidyMenu(clientX, clientY) {
    const scope = layoutScope();
    const items = [];
    if (scope) {
      items.push({ label: '整理选中的卡片：按连线分层', key: 'Ctrl+Shift+L', run: () => tidyLayout('flow') });
      items.push({ label: '整理选中的卡片：排成网格', run: () => tidyLayout('grid') });
      items.push({ sep: true });
    }
    items.push({ label: '整理整张画布：按连线分层', key: 'Ctrl+Shift+L', run: () => tidyLayout('flow', true) });
    items.push({ label: '整理整张画布：排成网格', run: () => tidyLayout('grid', true) });
    openMenu(clientX, clientY, items);
  }

  // ---------- 多选批量操作栏：对齐与等距分布 ----------
  const ALIGN_LABELS = {
    left: '左对齐',
    hcenter: '水平居中',
    right: '右对齐',
    top: '顶对齐',
    vcenter: '垂直居中',
    bottom: '底对齐',
  };

  let alignBarSize = null;

  // 能对齐的对象：选中的卡片；选中的组合算一个整体，整组一起挪，组内位置不变
  function alignUnits() {
    if (selection.size < 2) return null;
    const units = layoutUnits(layoutScope());
    if (units.length < 2) return null;
    const boxes = new Map();
    units.forEach((unit) => boxes.set(unit.id, unitBox(unit)));
    return { units: units, boxes: boxes };
  }

  function alignBounds(boxes) {
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    boxes.forEach((box) => {
      left = Math.min(left, box.x);
      right = Math.max(right, box.x + box.w);
      top = Math.min(top, box.y);
      bottom = Math.max(bottom, box.y + box.h);
    });
    return { left: left, right: right, top: top, bottom: bottom };
  }

  // 操作栏浮在选中的卡片上方；上面放不下就翻到下面，跟着平移 / 缩放 / 拖动一起走
  function placeAlignBar() {
    if (!alignBarEl) return;
    const picked = alignUnits();
    if (!picked) {
      alignBarEl.classList.add('hidden');
      alignBarSize = null;
      return;
    }
    paintBatchButtons();
    const rect = viewportBox();
    const area = alignBounds(picked.boxes);
    const screenLeft = area.left * viewport.zoom + viewport.x;
    const screenRight = area.right * viewport.zoom + viewport.x;
    const screenTop = area.top * viewport.zoom + viewport.y;
    const screenBottom = area.bottom * viewport.zoom + viewport.y;
    const firstShow = alignBarEl.classList.contains('hidden');
    alignBarEl.classList.remove('hidden');
    // 尺寸只在刚显示出来（或者窗口变过大小）时量一次，拖动卡片时不再反复触发布局计算
    if (firstShow || !alignBarSize) {
      alignBarSize = { w: alignBarEl.offsetWidth || 300, h: alignBarEl.offsetHeight || 36 };
    }
    const barW = alignBarSize.w;
    const barH = alignBarSize.h;
    const center = (screenLeft + screenRight) / 2;
    const minX = barW / 2 + 8;
    const maxX = Math.max(minX, rect.width - barW / 2 - 8);
    alignBarEl.style.left = clamp(center, minX, maxX) + 'px';
    let top = screenTop - barH - 12;
    if (top < 8) top = screenBottom + 12;
    alignBarEl.style.top = clamp(top, 8, Math.max(8, rect.height - barH - 8)) + 'px';
  }

  function moveUnits(units, moves, message) {
    let any = false;
    moves.forEach((move) => {
      if (move.dx || move.dy) any = true;
    });
    if (!any) {
      toast('这几张已经对齐好了');
      return;
    }
    pushHistory();
    units.forEach((unit) => {
      const move = moves.get(unit.id);
      if (!move || (!move.dx && !move.dy)) return;
      unit.nodes.forEach((node) => {
        node.x = Math.round(node.x + move.dx);
        node.y = Math.round(node.y + move.dy);
      });
    });
    renderNodes();
    updateEdgePaths();
    refreshSelection();
    scheduleSave();
    toast(message);
  }

  function alignSelection(mode) {
    const picked = alignUnits();
    if (!picked) {
      toast('先选中两张以上卡片（按住 Shift 点选，或者按住 Ctrl 在空白处拖框选中）');
      return;
    }
    const area = alignBounds(picked.boxes);
    const moves = new Map();
    picked.units.forEach((unit) => {
      const box = picked.boxes.get(unit.id);
      let dx = 0;
      let dy = 0;
      if (mode === 'left') dx = area.left - box.x;
      else if (mode === 'hcenter') dx = (area.left + area.right) / 2 - (box.x + box.w / 2);
      else if (mode === 'right') dx = area.right - (box.x + box.w);
      else if (mode === 'top') dy = area.top - box.y;
      else if (mode === 'vcenter') dy = (area.top + area.bottom) / 2 - (box.y + box.h / 2);
      else if (mode === 'bottom') dy = area.bottom - (box.y + box.h);
      moves.set(unit.id, { dx: Math.round(dx), dy: Math.round(dy) });
    });
    moveUnits(picked.units, moves, '已' + (ALIGN_LABELS[mode] || '对齐'));
  }

  // 等距分布：最边上两张不动，中间的按一样的间隔排开（至少三张才有意义）
  function distributeSelection(axis) {
    const picked = alignUnits();
    if (!picked) {
      toast('先选中两张以上卡片（按住 Shift 点选，或者按住 Ctrl 在空白处拖框选中）');
      return;
    }
    if (picked.units.length < 3) {
      toast('等距分布至少要三张卡片，中间那几张才有得排');
      return;
    }
    const horizontal = axis === 'x';
    const boxes = picked.boxes;
    const list = picked.units.slice().sort((a, b) => {
      return horizontal ? boxes.get(a.id).x - boxes.get(b.id).x : boxes.get(a.id).y - boxes.get(b.id).y;
    });
    const head = boxes.get(list[0].id);
    const tail = boxes.get(list[list.length - 1].id);
    const start = horizontal ? head.x : head.y;
    const end = horizontal ? tail.x + tail.w : tail.y + tail.h;
    const used = list.reduce((sum, unit) => sum + (horizontal ? boxes.get(unit.id).w : boxes.get(unit.id).h), 0);
    const gap = (end - start - used) / (list.length - 1);
    let cursor = start;
    const moves = new Map();
    list.forEach((unit) => {
      const box = boxes.get(unit.id);
      const delta = Math.round(cursor - (horizontal ? box.x : box.y));
      moves.set(unit.id, horizontal ? { dx: delta, dy: 0 } : { dx: 0, dy: delta });
      cursor += (horizontal ? box.w : box.h) + gap;
    });
    moveUnits(picked.units, moves, horizontal ? '已水平等距分布' : '已垂直等距分布');
  }

  // ---------- 多选批量生成 / 批量重试 ----------
  // 只处理真正能出素材的卡片；组合、定时组、导演台、锁定和正在跑的卡片自动跳过。
  function batchCandidates(mode) {
    const out = nodes.filter((node) => {
      if (!node || !selection.has(node.id)) return false;
      if (['image', 'video', 'quick'].indexOf(node.type) < 0) return false;
      if (isLocked(node) || isHidden(node)) return false;
      const data = nodeData(node);
      if (data.running) return false;
      // 批量重试只挑上一次失败的卡片；想全部重做用「批量生成」
      if (mode === 'retry') return Boolean(data.error);
      return true;
    });
    return out;
  }

  // 批量重命名只管「卡片标题」，所以能改的范围比批量生成宽：
  // 组合、定时组、导演台身上也有标题，锁定 / 隐藏的仍然跳过。
  function batchRenameCandidates() {
    return nodes.filter((node) => {
      if (!node || !selection.has(node.id)) return false;
      return !isLocked(node) && !isHidden(node);
    });
  }

  function paintBatchButtons() {
    if (!alignBarEl) return;
    const genCount = batchCandidates('generate').length;
    const retryCount = batchCandidates('retry').length;
    const renameCount = batchRenameCandidates().length;
    const gen = alignBarEl.querySelector('[data-batch="generate"]');
    const retry = alignBarEl.querySelector('[data-batch="retry"]');
    const rename = alignBarEl.querySelector('[data-batch="rename"]');
    const sep = alignBarEl.querySelector('.batch-sep');
    let changed = false;
    const paint = (button, count, label, hint) => {
      if (!button) return;
      const text = label + ' ' + count;
      const hidden = count <= 0;
      if (button.textContent !== text) button.textContent = text;
      if (button.hidden !== hidden) button.hidden = hidden;
      button.title = hidden ? hint.hidden : hint.shown;
      if (button.dataset.count !== String(count)) {
        button.dataset.count = String(count);
        changed = true;
      }
    };
    paint(gen, genCount, '批量生成', {
      hidden: '选中的卡片里没有可以生成的卡片',
      shown: '批量生成：先逐张检查参考素材，确认后再一起提交',
    });
    paint(retry, retryCount, '批量重试', {
      hidden: '选中的卡片里没有上一次失败的',
      shown: '批量重试：把上一次失败的这几张再跑一遍',
    });
    paint(rename, renameCount, '批量重命名', {
      hidden: '选中的卡片里没有可以改标题的（锁定的要先解锁）',
      shown: '批量重命名：统一改名、加前缀序号，或者查找替换',
    });
    if (sep) {
      const hideSep = genCount <= 0 && retryCount <= 0 && renameCount <= 0;
      if (sep.hidden !== hideSep) sep.hidden = hideSep;
    }
    if (changed) alignBarSize = null;
  }

  function mbTextOf(bytes) {
    return (Number(bytes || 0) / 1024 / 1024).toFixed(1) + ' MB';
  }

  // ---------- 批量重命名 ----------
  // 三种改法：统一设为 / 前缀加序号 / 查找替换。都是纯文本操作，改前先给预览。
  //
  // 序号的排序基准是「选中的顺序」——画布上的卡片顺序（nodes 数组）跟
  // 用户的视觉顺序一致（从左到右、从上到下），比按 id 排更好猜。
  function renameSortKey(node) {
    // 分行分列：先按行（y 除以卡片高度的一半，容忍轻微高低差），再按 x
    const rowH = Math.max(40, (node.h || 240) * 0.6);
    return [Math.round(node.y / rowH), node.x];
  }

  function orderedRenameTargets() {
    const list = batchRenameCandidates();
    const indexOf = new Map();
    nodes.forEach((node, i) => indexOf.set(node.id, i));
    return list.slice().sort((a, b) => {
      const ka = renameSortKey(a);
      const kb = renameSortKey(b);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      if (ka[1] !== kb[1]) return ka[1] - kb[1];
      return (indexOf.get(a.id) || 0) - (indexOf.get(b.id) || 0);
    });
  }

  // 序号补零：卡片多的时候排出来更整齐（1 → 01）
  function padIndex(n, total) {
    const width = String(Math.max(1, total)).length;
    return String(n).padStart(width, '0');
  }

  function renamePreviewOf(targets, mode, opt) {
    const total = targets.length;
    return targets.map((node, i) => {
      const data = nodeData(node);
      const oldTitle = String(data.title || '').trim();
      const seq = i + 1;
      let next = oldTitle;
      if (mode === 'set') {
        next = opt.text || '';
      } else if (mode === 'prefix') {
        // 前缀 / 后缀各自去掉首尾空白：手输时多打一个空格很常见，
        // 留着会变成「镜头_ 1」这种看着像出错的名字
        const head = String(opt.prefix || '').trim();
        const tail = String(opt.suffix || '').trim();
        next = head + padIndex(seq + (Number(opt.start) || 1) - 1, total + (Number(opt.start) || 1) - 1) + tail;
      } else if (mode === 'replace') {
        if (!opt.find) next = oldTitle;
        else next = oldTitle.split(opt.find).join(opt.to == null ? '' : opt.to);
      }
      return { node: node, id: node.id, oldTitle: oldTitle, newTitle: String(next).trim(), seq: seq };
    });
  }

  function applyBatchRename(rows) {
    const changed = rows.filter((row) => row.oldTitle !== row.newTitle);
    if (!changed.length) {
      toast('标题没有变化，什么都没改');
      return 0;
    }
    pushHistory();
    changed.forEach((row) => {
      const data = nodeData(row.node);
      data.title = row.newTitle;
    });
    // 只重画改过的那几张：别的卡片不跟着闪
    changed.forEach((row) => refreshNode(row.node));
    scheduleSave();
    return changed.length;
  }

  async function openBatchRename() {
    const targets = orderedRenameTargets();
    if (!targets.length) {
      toast('选中的卡片里没有可以改标题的（锁定的要先解锁）');
      return;
    }
    const state = { mode: 'prefix', text: '', prefix: '', suffix: '', start: 1, find: '', to: '' };
    let rows = renamePreviewOf(targets, state.mode, state);

    const mask = document.createElement('div');
    mask.className = 'modal-mask rename-mask';
    const dialog = document.createElement('div');
    dialog.className = 'modal modal-rename';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '批量重命名');

    const head = document.createElement('div');
    head.className = 'modal-head';
    const title = document.createElement('b');
    title.textContent = '批量重命名';
    const note = document.createElement('span');
    note.className = 'muted-line rename-note';
    note.textContent = '会改 ' + targets.length + ' 张卡片的标题';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ghost';
    closeBtn.type = 'button';
    closeBtn.textContent = '关闭';
    head.append(title, note, grow, closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body rename-body';

    // 模式切换
    const tabs = document.createElement('div');
    tabs.className = 'rename-tabs';
    const TABS = [
      { value: 'prefix', label: '前缀 + 序号' },
      { value: 'set', label: '统一设为' },
      { value: 'replace', label: '查找替换' },
    ];
    const fields = document.createElement('div');
    fields.className = 'rename-fields';

    const preview = document.createElement('div');
    preview.className = 'rename-preview';

    const paintTabs = () => {
      tabs.textContent = '';
      TABS.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'rename-tab' + (state.mode === item.value ? ' active' : '');
        button.textContent = item.label;
        button.addEventListener('click', () => {
          state.mode = item.value;
          rows = renamePreviewOf(targets, state.mode, state);
          paintTabs();
          paintFields();
          paintPreview();
        });
        tabs.appendChild(button);
      });
    };

    const makeField = (labelText, key, placeholder, onInput) => {
      const wrap = document.createElement('label');
      wrap.className = 'rename-field';
      const span = document.createElement('span');
      span.className = 'rename-field-label';
      span.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.placeholder = placeholder || '';
      input.value = state[key] == null ? '' : String(state[key]);
      input.addEventListener('input', () => {
        state[key] = input.value;
        if (onInput) onInput(input.value);
        rows = renamePreviewOf(targets, state.mode, state);
        paintPreview();
      });
      wrap.appendChild(span);
      wrap.appendChild(input);
      return wrap;
    };

    const paintFields = () => {
      fields.textContent = '';
      if (state.mode === 'set') {
        fields.appendChild(makeField('都叫', 'text', '例如 开场镜头'));
      } else if (state.mode === 'prefix') {
        fields.appendChild(makeField('前缀', 'prefix', '例如 镜头_'));
        fields.appendChild(makeField('起始序号', 'start', '1', (value) => {
          const n = Math.max(1, Math.floor(Number(value) || 1));
          state.start = n;
        }));
        fields.appendChild(makeField('后缀（可选）', 'suffix', '例如 _成片'));
      } else {
        fields.appendChild(makeField('找', 'find', '要替换掉的文字'));
        fields.appendChild(makeField('替换成', 'to', '留空就是删掉'));
      }
    };

    const paintPreview = () => {
      preview.textContent = '';
      const head2 = document.createElement('div');
      head2.className = 'rename-preview-head';
      const changedCount = rows.filter((row) => row.oldTitle !== row.newTitle).length;
      head2.textContent = changedCount
        ? '预览（' + changedCount + ' 张会变，其余保持不变）'
        : '预览（当前设置不会改动任何标题）';
      preview.appendChild(head2);
      const list = document.createElement('div');
      list.className = 'rename-preview-list';
      rows.forEach((row) => {
        const line = document.createElement('div');
        line.className = 'rename-preview-row' + (row.oldTitle === row.newTitle ? '' : ' changed');
        const seq = document.createElement('span');
        seq.className = 'rename-preview-seq';
        seq.textContent = String(row.seq);
        const before = document.createElement('span');
        before.className = 'rename-preview-old';
        before.textContent = row.oldTitle || '（没标题）';
        const arrow = document.createElement('span');
        arrow.className = 'rename-preview-arrow';
        arrow.textContent = '→';
        const after = document.createElement('span');
        after.className = 'rename-preview-new';
        after.textContent = row.newTitle || '（清空）';
        line.append(seq, before, arrow, after);
        list.appendChild(line);
      });
      preview.appendChild(list);
    };

    body.appendChild(tabs);
    body.appendChild(fields);
    body.appendChild(preview);
    paintTabs();
    paintFields();
    paintPreview();

    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    const tip = document.createElement('span');
    tip.className = 'muted-line';
    tip.textContent = '序号按画布上从左到右、从上到下排';
    const grow2 = document.createElement('span');
    grow2.className = 'grow';
    const cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.type = 'button';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.type = 'button';
    ok.textContent = '改这 ' + targets.length + ' 张';
    foot.append(tip, grow2, cancel, ok);

    dialog.append(head, body, foot);
    mask.appendChild(dialog);
    document.body.appendChild(mask);

    const close = () => mask.remove();
    closeBtn.addEventListener('click', close);
    cancel.addEventListener('click', close);
    ok.addEventListener('click', () => {
      const count = applyBatchRename(rows);
      close();
      if (count) toast('已改 ' + count + ' 张卡片的标题', 4000, [{ label: '撤销', run: () => undo() }]);
      else toast('标题没有变化，什么都没改');
    });
    mask.addEventListener('click', (event) => {
      if (event.target === mask) close();
    });
  }

  function sizeTextOf(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' 字节';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function timeTextOf(at) {
    const ms = Number(at) || 0;
    if (!ms) return '时间不详';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes())
    );
  }

  // 回收站面板：删掉的素材只是挪进 data\recycle，这里能看、能挑着摆回去。
  // 入口在删除后的提示条上，也可以从素材库那边进。
  async function openRecycleBin() {
    let data = null;
    try {
      data = await window.api.recycleList();
    } catch (error) {
      toast('读回收站失败：' + ((error && error.message) || '服务没响应'), 5000);
      return;
    }
    const batches = (data && data.batches) || [];
    const mask = document.createElement('div');
    mask.className = 'modal-mask recycle-mask';
    const picked = new Set();

    const dialog = document.createElement('div');
    dialog.className = 'modal modal-recycle';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '回收站');

    const head = document.createElement('div');
    head.className = 'modal-head';
    const title = document.createElement('b');
    title.textContent = '回收站';
    head.appendChild(title);
    const headNote = document.createElement('span');
    headNote.className = 'muted-line recycle-head-note';
    headNote.textContent = batches.length
      ? batches.length + ' 批 · 共 ' + (data.total || 0) + ' 个文件 · ' + sizeTextOf(data.bytes)
      : '';
    head.appendChild(headNote);
    const grow = document.createElement('span');
    grow.className = 'grow';
    head.appendChild(grow);
    const headClose = document.createElement('button');
    headClose.className = 'ghost';
    headClose.type = 'button';
    headClose.textContent = '关闭';
    head.append(headClose);

    const body = document.createElement('div');
    body.className = 'modal-body recycle-body';

    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    const footNote = document.createElement('span');
    footNote.className = 'muted-line';
    foot.appendChild(footNote);
    const footGrow = document.createElement('span');
    footGrow.className = 'grow';
    foot.appendChild(footGrow);
    const restoreAll = document.createElement('button');
    restoreAll.className = 'ghost';
    restoreAll.type = 'button';
    restoreAll.textContent = '全选';
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'primary';
    restoreBtn.type = 'button';
    restoreBtn.textContent = '还原选中的';
    restoreBtn.disabled = true;
    foot.appendChild(restoreAll);
    foot.appendChild(restoreBtn);

    dialog.appendChild(head);
    dialog.appendChild(body);
    dialog.appendChild(foot);
    mask.appendChild(dialog);

    const paintFoot = () => {
      const count = picked.size;
      restoreBtn.disabled = count === 0;
      restoreBtn.textContent = count ? '还原选中的 ' + count + ' 个' : '还原选中的';
      footNote.textContent = count ? '已选 ' + count + ' 个文件' : '勾几个文件，或者整批还原';
    };

    const paint = () => {
      body.textContent = '';
      if (!batches.length) {
        const empty = document.createElement('div');
        empty.className = 'muted-line recycle-empty';
        empty.textContent = '回收站是空的。删除素材时不会直接销毁，会先挪到这里，方便后悔。';
        body.appendChild(empty);
        paintFoot();
        return;
      }
      batches.forEach((batch) => {
        const group = document.createElement('div');
        group.className = 'recycle-batch';
        const bar = document.createElement('div');
        bar.className = 'recycle-batch-head';
        const hit = document.createElement('label');
        hit.className = 'recycle-batch-title';
        const box = document.createElement('input');
        box.type = 'checkbox';
        const ids = batch.items.map((item) => item.rel);
        box.checked = ids.length > 0 && ids.every((rel) => picked.has(batch.id + '::' + rel));
        box.addEventListener('change', () => {
          ids.forEach((rel) => {
            const key = batch.id + '::' + rel;
            if (box.checked) picked.add(key);
            else picked.delete(key);
          });
          paint();
        });
        const label = document.createElement('b');
        label.textContent = batch.label;
        hit.appendChild(box);
        hit.appendChild(label);
        bar.appendChild(hit);
        const meta = document.createElement('span');
        meta.className = 'muted-line';
        meta.textContent = timeTextOf(batch.at) + ' · ' + batch.count + ' 个 · ' + sizeTextOf(batch.bytes);
        bar.appendChild(meta);
        group.appendChild(bar);

        const list = document.createElement('div');
        list.className = 'recycle-list';
        batch.items.forEach((item) => {
          const row = document.createElement('label');
          row.className = 'recycle-row';
          const check = document.createElement('input');
          check.type = 'checkbox';
          const key = batch.id + '::' + item.rel;
          check.checked = picked.has(key);
          check.addEventListener('change', () => {
            if (check.checked) picked.add(key);
            else picked.delete(key);
            paintFoot();
          });
          const name = document.createElement('span');
          name.className = 'recycle-name';
          name.textContent = item.rel;
          const size = document.createElement('span');
          size.className = 'muted-line';
          size.textContent = sizeTextOf(item.bytes);
          row.appendChild(check);
          row.appendChild(name);
          row.appendChild(size);
          list.appendChild(row);
        });
        if (batch.count > batch.items.length) {
          const more = document.createElement('div');
          more.className = 'muted-line recycle-more';
          more.textContent = '这一批还有 ' + (batch.count - batch.items.length) + ' 个文件没列出来，整批还原时会一起处理。';
          list.appendChild(more);
        }
        group.appendChild(list);
        body.appendChild(group);
      });
      paintFoot();
    };

    paint();

    const close = () => mask.remove();
    headClose.addEventListener('click', close);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) close();
    });

    restoreAll.addEventListener('click', () => {
      const everything = batches.every((batch) =>
        batch.items.every((item) => picked.has(batch.id + '::' + item.rel))
      );
      picked.clear();
      if (!everything) {
        batches.forEach((batch) => batch.items.forEach((item) => picked.add(batch.id + '::' + item.rel)));
      }
      paint();
    });

    restoreBtn.addEventListener('click', async () => {
      // 按批次分组提交：接口是「一批 + 若干文件」
      const byBatch = new Map();
      picked.forEach((key) => {
        const at = key.indexOf('::');
        const batchId = key.slice(0, at);
        const rel = key.slice(at + 2);
        if (!byBatch.has(batchId)) byBatch.set(batchId, []);
        byBatch.get(batchId).push(rel);
      });
      restoreBtn.disabled = true;
      restoreBtn.textContent = '正在还原…';
      let moved = 0;
      let skipped = 0;
      let failed = 0;
      for (const [batchId, items] of byBatch) {
        try {
          const res = await window.api.recycleRestore(batchId, items);
          moved += Number(res.moved) || 0;
          skipped += (res.skipped || []).length;
          failed += (res.failed || []).length;
        } catch (error) {
          failed += items.length;
        }
      }
      picked.clear();
      try {
        data = await window.api.recycleList();
      } catch (error) {
        data = { batches: [], total: 0, bytes: 0 };
      }
      batches.length = 0;
      (data.batches || []).forEach((item) => batches.push(item));
      paint();
      const parts = ['已还原 ' + moved + ' 个'];
      if (skipped) parts.push(skipped + ' 个同名已存在，没覆盖');
      if (failed) parts.push(failed + ' 个没成功');
      toast(parts.join('，'), 5200);
    });

    document.body.appendChild(mask);
    // 打开时先算一次底部的选中提示
    paintFoot();
  }

  function batchNodeName(node) {
    const data = nodeData(node);
    const title = String(data.title || '').trim();
    const tag = tagOf(node);
    return (tag ? tag + ' ' : '') + (title || presetOf(node.type).label);
  }

  async function runPool(items, limit, worker) {
    let next = 0;
    const count = Math.max(1, Math.min(limit, items.length));
    const runners = [];
    for (let i = 0; i < count; i += 1) {
      runners.push((async () => {
        while (true) {
          const index = next;
          next += 1;
          if (index >= items.length) return;
          try {
            await worker(items[index]);
          } catch (error) {
            items[index].error = (error && error.message) || String(error);
          }
        }
      })());
    }
    await Promise.all(runners);
  }

  function showBatchReview(title, items) {
    const usable = items.filter((item) => item.report && item.report.ok);
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML =
        '<div class="modal modal-batch">' +
        '  <div class="modal-head"><b></b><button class="ghost" data-cancel>关闭</button></div>' +
        '  <div class="modal-body batch-body">' +
        '    <div class="batch-summary"></div>' +
        '    <div class="batch-list"></div>' +
        '    <div class="set-hint batch-note">检查只读取参考素材并试压提交副本，不会上传、不会生成、也不会产生费用。原图和素材目录里的文件都不会改。</div>' +
        '  </div>' +
        '  <div class="modal-foot">' +
        '    <span class="batch-progress"></span><span class="grow"></span>' +
        '    <button class="ghost" data-cancel>取消</button>' +
        '    <button class="primary" data-submit hidden></button>' +
        '  </div>' +
        '</div>';
      document.body.appendChild(mask);
      mask.querySelector('.modal-head b').textContent = title;
      const summary = mask.querySelector('.batch-summary');
      const okText = document.createElement('div');
      okText.className = 'batch-ok-count';
      okText.textContent = usable.length + ' 张可以提交';
      const badCount = items.length - usable.length;
      const badText = document.createElement('div');
      badText.className = 'batch-bad-count';
      badText.textContent = badCount ? badCount + ' 张需要先处理（不会提交）' : '全部检查通过';
      summary.appendChild(okText);
      summary.appendChild(badText);

      const list = mask.querySelector('.batch-list');
      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'batch-row ' + (item.report && item.report.ok ? 'ok' : 'bad');
        const head = document.createElement('div');
        head.className = 'batch-row-head';
        const name = document.createElement('b');
        name.textContent = batchNodeName(item.node);
        const state = document.createElement('span');
        state.className = 'batch-row-state';
        state.textContent = item.report && item.report.ok ? '可提交' : '需先处理';
        head.appendChild(name);
        head.appendChild(state);
        row.appendChild(head);

        const detail = document.createElement('div');
        detail.className = 'batch-row-detail';
        if (!item.report) {
          detail.className = 'batch-row-error';
          detail.textContent = item.error || '没有完成检查';
        } else {
          const report = item.report;
          const bits = [];
          bits.push('模型：' + (report.model || '默认'));
          bits.push('通道：' + (report.channel || '未写明'));
          bits.push('参考素材：' + (Number(report.refCount) || 0) + ' 个');
          if (report.faceProcessing) bits.push('人脸处理：开');
          if (Number(report.beforeBytes) > 0) {
            bits.push('体积：' + mbTextOf(report.beforeBytes) + ' → ' + mbTextOf(report.afterBytes));
          }
          bits.push('提示词：' + (Number(report.promptLength) || 0) + ' 字');
          bits.push(report.tailName ? '尾部：' + report.tailName + '（' + (Number(report.tailLength) || 0) + ' 字）' : '尾部：无');
          detail.textContent = bits.join('　·　');
        }
        row.appendChild(detail);

        // 没有 report 时，错误已经在上面那行说明里了，不要重复写两遍
        if (item.report && !item.report.ok) {
          const err = document.createElement('div');
          err.className = 'batch-row-error';
          err.textContent = item.error || item.report.error || '这张卡片现在不能提交';
          row.appendChild(err);
        }
        if (item.report && item.report.warnings && item.report.warnings.length) {
          const warn = document.createElement('div');
          warn.className = 'batch-row-warn';
          warn.textContent = item.report.warnings.join('；');
          row.appendChild(warn);
        }
        list.appendChild(row);
      });

      const progress = mask.querySelector('.batch-progress');
      if (progress) progress.textContent = '确认后最多同时提交 2 张，单张失败不会影响其他卡片。';
      const submit = mask.querySelector('[data-submit]');
      if (usable.length) {
        submit.hidden = false;
        submit.textContent = '提交 ' + usable.length + ' 张';
      }
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        mask.remove();
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      };
      document.addEventListener('keydown', onKey, true);
      mask.querySelectorAll('[data-cancel]').forEach((button) => button.addEventListener('click', () => finish(false)));
      if (usable.length) submit.addEventListener('click', () => finish(true));
      mask.addEventListener('click', (event) => {
        if (event.target === mask) finish(false);
      });
    });
  }

  let batchBusy = false;

  async function runBatchGenerate(mode) {
    if (batchBusy) {
      toast('上一批还在检查或提交，稍等一下');
      return;
    }
    const targets = batchCandidates(mode);
    if (!targets.length) {
      toast(mode === 'retry' ? '选中的卡片里没有失败或生成过的卡片' : '选中的卡片里没有可以直接生成的素材卡');
      return;
    }
    batchBusy = true;
    try {
      const items = [];
      for (let i = 0; i < targets.length; i += 1) {
        const node = targets[i];
        const data = nodeData(node);
        toast('提交前检查：第 ' + (i + 1) + ' / ' + targets.length + ' 张…', 60000);
        // 批量检查也可能是几十秒：每张正在检查的卡片自己也亮起状态，别看起来没反应
        data.preparing = '检查参考素材（' + (i + 1) + ' / ' + targets.length + '）…';
        updateTaskUi(node);
        try {
          const invalid = generateValidationError(node);
          if (invalid) {
            items.push({ node: node, payload: null, report: null, error: invalid });
            continue;
          }
          const payload = buildGeneratePayload(node);
          const report = await checkBeforeGenerate(payload);
          items.push({ node: node, payload: payload, report: report, error: report.ok ? '' : report.error });
        } finally {
          data.preparing = '';
          updateTaskUi(node);
        }
      }
      const confirmed = await showBatchReview(mode === 'retry' ? '批量重试前检查' : '批量生成前检查', items);
      if (!confirmed) {
        toast('已取消，没有提交任何卡片');
        return;
      }
      const usable = items.filter((item) => item.report && item.report.ok && item.payload);
      // 批量提交是一口气改动很多卡片，提交前先给整块画布留个档：
      // 万一参数或参考素材搞错了，能从「历史版本」整块退回来。
      // 存档失败不拦着提交（可能只是磁盘满了），只是少一道保险。
      try {
        await window.api.snapshotCanvas(canvasId, '批量前');
      } catch {
        /* 存档没成也不影响这次批量 */
      }
      let success = 0;
      let failed = 0;
      await runPool(usable, 2, async (item) => {
        const result = await submitGenerate(item.node, { payload: item.payload, skipPreflight: true, quiet: true });
        if (result.ok) {
          success += 1;
          item.done = true;
        } else {
          failed += 1;
          item.error = result.error || '没提交成功';
        }
      });
      if (failed) toast('已提交 ' + success + ' 张，另有 ' + failed + ' 张没提交上；失败原因已写回卡片', 6000);
      else toast('已提交 ' + success + ' 张，正在逐张生成；进度会显示在卡片中间', 5000);
    } finally {
      batchBusy = false;
    }
  }

  // ---------- 导出：把卡片里的素材原文件完整复制到本地文件夹 ----------
  // 只导出卡片背后的真实文件（图片 / 视频 / 音频），不生成截图，也不拼图。
  // 选中几张就导这几张（选中组合会把它里面的卡片一起导出），一张没选就导整张画布。
  let exporting = false;

  // 卡片上记的相对路径；老卡片只存了 /media/... 地址时，从地址里还原出相对路径
  function assetRelOf(result) {
    const file = String((result && result.file) || "").trim();
    if (file) return file;
    const url = String((result && result.url) || "");
    const hit = url.match(/^\/media\/(.+)$/);
    if (!hit) return "";
    try {
      return decodeURIComponent(hit[1]);
    } catch {
      return hit[1];
    }
  }

  // 导出后的文件名：编号_标题_提示词，例如「图1_林振南_一只小猫」
  function exportBaseName(node) {
    const data = nodeData(node);
    const parts = [];
    const tag = tagOf(node);
    if (tag) parts.push(tag);
    const title = String(data.title || "").replace(/\s+/g, " ").trim();
    if (title) parts.push(title);
    const prompt = String(data.text || "")
      .replace(/@\[[^\]\n]*\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (prompt) parts.push(prompt.slice(0, 40));
    const seen = new Set();
    const uniq = parts.filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return (uniq.join("_") || presetOf(node.type).label || "素材").slice(0, 80);
  }

  async function exportSelectedAssets() {
    if (exporting) {
      toast("上一次导出还没结束，稍等一下");
      return;
    }
    const picked = nodes.filter((node) => selection.has(node.id));
    const base = picked.length ? picked : nodes;
    if (!base.length) {
      toast("画布上还没有卡片，先加几张再来导出");
      return;
    }
    const ids = new Set(base.map((node) => node.id));
    base.forEach((node) => {
      if (node.type === "group") groupMembersOf(node).forEach((member) => ids.add(member.id));
      if (node.type === "schedule") scheduleMembersOf(node).forEach((member) => ids.add(member.id));
    });
    const items = [];
    let skipped = 0;
    nodes.filter((node) => ids.has(node.id)).forEach((node) => {
      if (node.type === "group" || node.type === "schedule") return;
      const data = nodeData(node);
      const result = data && data.result;
      const rel = result ? assetRelOf(result) : "";
      if (!rel) {
        skipped += 1;
        return;
      }
      // 只传名字，扩展名由服务端按原文件补，避免出现 xxx.png.png
      items.push({ file: rel, name: exportBaseName(node) });
    });
    if (!items.length) {
      toast(picked.length ? "选中的卡片还没有生成好的素材，没有可以导出的文件" : "画布上的卡片都还没有生成好的素材，没有可以导出的文件");
      return;
    }
    exporting = true;
    try {
      toast("请在弹出的窗口里选择保存位置…");
      const pickedRes = await fetch("/api/export/pick-dir", { method: "POST" });
      const pickedData = await pickedRes.json();
      if (!pickedRes.ok) throw new Error(pickedData && pickedData.error ? pickedData.error : "打开选择窗口失败");
      if (pickedData.cancelled || !pickedData.path) {
        toast("已取消导出");
        return;
      }
      toast("正在导出 " + items.length + " 个素材…", 4000);
      const res = await fetch("/api/export/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: items, destDir: pickedData.path }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data && data.error ? data.error : "导出失败");
      const okCount = (data.saved || []).length;
      const failCount = (data.failed || []).length;
      if (!okCount) {
        toast("导出失败：" + ((data.failed && data.failed[0] && data.failed[0].error) || "素材没能复制过去"), 5000);
        return;
      }
      const notes = [];
      if (skipped) notes.push("跳过 " + skipped + " 个没生成好的");
      if (failCount) notes.push(failCount + " 个失败");
      const tail = notes.length ? "，" + notes.join("，") : "";
      toast("已导出 " + okCount + " 个素材到 " + data.dir + tail, 7000);
    } catch (error) {
      toast("导出失败：" + ((error && error.message) || "请稍后再试"));
    } finally {
      exporting = false;
    }
  }


  // ---------- 快捷键一览：画布内随时查，键位跟你自己改过的一致 ----------
  const HELP_GROUPS = [
    {
      title: '工具与画面',
      items: [
        { name: '选择工具', key: 'select', note: '点选、拖动卡片' },
        { name: '平移工具（默认）', key: 'hand', note: '拖空白处移动画面' },
        { name: '按住 Ctrl 拖空白处框选', caps: ['Ctrl', '拖空白'], note: '平移模式下也能框选多张卡片，方便打包成组' },
        { name: '按住空格临时平移', caps: ['空格'], note: '松开就回到原来的工具' },
        { name: '适应窗口（所有卡片都看得见）', key: 'fit' },
        { name: '回到原点，缩放归 100%', key: 'reset' },
        { name: '滚轮缩放', caps: ['滚轮'], note: '以鼠标位置为中心' },
        { name: '中键拖拽平移', caps: ['中键'], note: '不用先切工具' },
        { name: '查找卡片', caps: ['Ctrl', 'F'], note: '提示词、模型、类型、组合名都能搜' },
        { name: '打开这张快捷键表', caps: ['F1'] },
      ],
    },
    {
      title: '卡片',
      items: [
        { name: '在空白处双击新建卡片', caps: ['双击空白'] },
        { name: '在空白处右键打开菜单', caps: ['右键空白'] },
        { name: '在卡片上右键打开菜单', caps: ['右键卡片'] },
        { name: '选中卡片 / 取消选中', caps: ['点击卡片'], note: '点空白处取消' },
        { name: '加选、减选', caps: ['Shift', '点击'], note: '框选时按住 Shift 也是加选' },
        { name: '删除卡片或连线', key: 'remove' },
        { name: '复制 / 粘贴卡片', caps: ['Ctrl', 'C'], note: '粘贴是 Ctrl+V，粘出来的卡片往右下挪一点' },
        { name: '微调位置', caps: ['方向键'], note: '按住 Shift 一次走 10 像素' },
        { name: '全选', caps: ['Ctrl', 'A'] },
        { name: '锁定 / 解锁选中的卡片', caps: ['Ctrl', 'L'], note: '锁定后拖不动、改不了、删不掉，但还能当素材连给别人' },
        { name: '隐藏选中的卡片 / 勾选恢复', caps: ['Ctrl', 'Shift', 'H'], note: '隐藏的卡片仍然能当参考素材；没选中时打开勾选窗口，只恢复勾中的卡片' },
      ],
    },
    {
      title: '排列与整理',
      items: [
        { name: '把选中的卡片加成一组', caps: ['Ctrl', 'G'] },
        { name: '一键整理排版（按连线分层）', key: 'tidy' },
        { name: '多选后的对齐条', caps: ['选中 2 张以上'], note: '左右上下对齐、等距分布' },
        { name: '导出卡片素材到本地文件夹', key: 'export', note: '图片 / 视频 / 音频都按原文件复制出去' },
      ],
    },
    {
      title: '撤销与返回',
      items: [
        { name: '撤销', key: 'undo' },
        { name: '关掉弹层 / 取消选中', caps: ['Esc'] },
        { name: '回到门户页', caps: ['左栏「门户页」'] },
      ],
    },
    {
      title: '提示词与参考素材',
      items: [
        { name: '在提示词里引用已连线的素材', caps: ['@'], note: '敲 @ 会列出 图1 / 视频1 / 音频1' },
        { name: '快速视频卡片', caps: ['新建快速视频'], note: '不用连线，提示词里 @ 谁就用谁' },
        { name: '把素材连到卡片上', caps: ['拖左侧圆点到目标'], note: '连上来就算参考，不用再选类型' },
        { name: '视频提取尾帧', caps: ['右键视频卡片'], note: '会新建一张图片卡片' },
      ],
    },
  ];

  let helpEl = null;

  function prettyCombo(combo) {
    return String(combo || '')
      .split('+')
      .filter(Boolean)
      .map((part) => {
        if (part === 'ctrl') return 'Ctrl';
        if (part === 'alt') return 'Alt';
        if (part === 'shift') return 'Shift';
        if (part === 'delete') return 'Delete';
        if (part === 'space') return '空格';
        if (part === 'escape') return 'Esc';
        return part.length === 1 ? part.toUpperCase() : part;
      });
  }

  function helpRows(query) {
    const map = shortcutMap();
    const needle = String(query || '').trim().toLowerCase();
    const groups = HELP_GROUPS.map((group) => {
      const items = group.items
        .map((item) => {
          const caps = item.key ? prettyCombo(map[item.key]) : item.caps || [];
          return { name: item.name, note: item.note || '', caps: caps, text: item.name + ' ' + (item.note || '') + ' ' + caps.join(' ') };
        })
        .filter((item) => !needle || item.text.toLowerCase().indexOf(needle) >= 0);
      return { title: group.title, items: items };
    });
    return groups.filter((group) => group.items.length);
  }

  function renderHelp(query) {
    if (!helpEl) return;
    const body = helpEl.querySelector('.help-groups');
    if (!body) return;
    const groups = helpRows(query);
    body.textContent = '';
    if (!groups.length) {
      const empty = document.createElement('div');
      empty.className = 'help-empty';
      empty.textContent = '没找到「' + query + '」，换个词试试，比如「导出」「对齐」「撤销」。';
      body.appendChild(empty);
      return;
    }
    groups.forEach((group) => {
      const wrap = document.createElement('div');
      wrap.className = 'help-group';
      const title = document.createElement('div');
      title.className = 'help-group-title';
      title.textContent = group.title;
      wrap.appendChild(title);
      group.items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'help-row';
        const text = document.createElement('div');
        text.className = 'help-row-text';
        const name = document.createElement('div');
        name.className = 'help-row-name';
        name.textContent = item.name;
        text.appendChild(name);
        if (item.note) {
          const note = document.createElement('div');
          note.className = 'help-row-note';
          note.textContent = item.note;
          text.appendChild(note);
        }
        const keys = document.createElement('div');
        keys.className = 'help-keys';
        item.caps.forEach((cap) => {
          const key = document.createElement('span');
          key.className = 'keycap';
          key.textContent = cap;
          keys.appendChild(key);
        });
        row.appendChild(text);
        row.appendChild(keys);
        wrap.appendChild(row);
      });
      body.appendChild(wrap);
    });
  }

  function openHelp() {
    if (helpEl) {
      const input = helpEl.querySelector('.help-search input');
      if (input) input.focus({ preventScroll: true });
      return;
    }
    const mask = document.createElement('div');
    mask.className = 'modal-mask help-mask';
    mask.innerHTML =
      '<div class="modal help-modal">' +
      '  <div class="modal-head"><b>快捷键与操作一览</b>' +
      '    <span class="grow"></span>' +
      '    <button class="ghost" data-close>关闭</button></div>' +
      '  <div class="help-search">' +
      '    <input type="search" placeholder="搜一下：导出、对齐、撤销…" autocomplete="off" />' +
      '  </div>' +
      '  <div class="modal-body"><div class="help-groups"></div></div>' +
      '  <div class="modal-foot"><span class="set-hint">键位是现在生效的这一套，在「显示 → 画布快捷键」里改过会跟着变。</span></div>' +
      '</div>';
    document.body.appendChild(mask);
    helpEl = mask;
    const input = mask.querySelector('.help-search input');
    input.addEventListener('input', () => renderHelp(input.value));
    mask.querySelector('[data-close]').addEventListener('click', closeHelp);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) closeHelp();
    });
    mask.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeHelp();
      }
    });
    renderHelp('');
    input.focus({ preventScroll: true });
  }

  function closeHelp() {
    if (!helpEl) return;
    helpEl.remove();
    helpEl = null;
  }

  function bindHelp() {
    const button = document.getElementById('btn-help');
    if (button) button.addEventListener('click', openHelp);
  }

  // ---------- 筛选显示：按类型 / 生成状态把不关心的卡片淡下去 ----------
  const FILTER_TYPES = [
    { key: 'image', label: '图片' },
    { key: 'video', label: '视频' },
    { key: 'quick', label: '快速视频' },
    { key: 'audio', label: '音频' },
    { key: 'group', label: '组合' },
  ];
  const FILTER_STATES = [
    { key: 'running', label: '生成中' },
    { key: 'failed', label: '生成失败' },
    { key: 'done', label: '已完成' },
    { key: 'empty', label: '还没生成' },
  ];
  const filter = { types: new Set(), states: new Set() };

  function filterActive() {
    return filter.types.size > 0 || filter.states.size > 0;
  }

  function stateOfNode(node) {
    const data = node.data || {};
    if (data.running) return 'running';
    if (data.error) return 'failed';
    if (data.result && data.result.url) return 'done';
    return 'empty';
  }

  function matchesFilter(node) {
    if (!filterActive()) return true;
    if (filter.types.size && !filter.types.has(node.type)) return false;
    if (filter.states.size && !filter.states.has(stateOfNode(node))) return false;
    return true;
  }

  // 组卡片算不算通过：自己通过，或者组里有素材通过（按图片筛的时候，含图片的组合也该亮着）
  function nodeVisibleUnderFilter(node) {
    if (matchesFilter(node)) return true;
    if (node.type === 'group' && filter.types.size === 0) return false;
    if (node.type === 'group') {
      return groupMembersOf(node).some((member) => matchesFilter(member));
    }
    return false;
  }

  function paintFilter() {
    if (!filterActive()) {
      worldEl.classList.remove('filtering');
      elements.forEach((el) => el.classList.remove('filtered-out'));
      edgeElements.forEach((item) => item.group.classList.remove('filtered-out'));
      paintFilterCounts();
      return;
    }
    worldEl.classList.add('filtering');
    const visible = new Set();
    elements.forEach((el, id) => {
      const node = byId(id);
      const on = Boolean(node) && nodeVisibleUnderFilter(node);
      el.classList.toggle('filtered-out', !on);
      if (on) visible.add(id);
    });
    // 两端都亮着的连线才亮，其余淡下去
    edges.forEach((edge) => {
      const item = edgeElements.get(edge.id);
      if (!item) return;
      item.group.classList.toggle('filtered-out', !(visible.has(edge.sourceId) && visible.has(edge.targetId)));
    });
    paintFilterCounts();
    scheduleMinimap();
  }

  function filterCountOf(type, state) {
    const scope = nodes.filter((node) => (type ? node.type === type : true));
    if (!state) return scope.length;
    return scope.filter((node) => stateOfNode(node) === state).length;
  }

  function paintFilterCounts() {
    if (!filterEl) return;
    const typeBox = filterEl.querySelector('[data-filter="types"]');
    const stateBox = filterEl.querySelector('[data-filter="states"]');
    if (typeBox) {
      typeBox.querySelectorAll('button[data-key]').forEach((button) => {
        const key = button.dataset.key;
        button.classList.toggle('on', filter.types.has(key));
        button.textContent = FILTER_TYPES.find((item) => item.key === key).label + ' ' + filterCountOf(key, '');
      });
      const clear = typeBox.querySelector('[data-clear="types"]');
      if (clear) clear.hidden = filter.types.size === 0;
    }
    if (stateBox) {
      stateBox.querySelectorAll('button[data-key]').forEach((button) => {
        const key = button.dataset.key;
        button.classList.toggle('on', filter.states.has(key));
        button.textContent = FILTER_STATES.find((item) => item.key === key).label + ' ' + filterCountOf('', key);
      });
      const clear = stateBox.querySelector('[data-clear="states"]');
      if (clear) clear.hidden = filter.states.size === 0;
    }
    const summary = filterEl.querySelector('.filter-summary');
    if (summary) {
      if (!filterActive()) {
        summary.textContent = '没有筛选，所有卡片都正常显示';
        summary.classList.remove('on');
      } else {
        const shown = nodes.filter((node) => nodeVisibleUnderFilter(node)).length;
        summary.textContent = '正在筛选：显示 ' + shown + ' / ' + nodes.length + ' 张';
        summary.classList.add('on');
      }
    }
    const badge = document.getElementById('filter-badge');
    if (badge) {
      const shown = nodes.filter((node) => nodeVisibleUnderFilter(node)).length;
      badge.textContent = shown + '';
      badge.hidden = !filterActive();
      badge.classList.toggle('zero', filterActive() && shown === 0);
    }
  }

  let filterEl = null;

  function toggleFilter(kind, key) {
    const set = filter[kind];
    if (set.has(key)) set.delete(key);
    else set.add(key);
    paintFilter();
    // 筛完之后如果当前选中的卡片被淡下去了，取消选中，免得误操作到看不见的卡片
    const visible = nodes.filter((node) => nodeVisibleUnderFilter(node)).map((node) => node.id);
    const keep = visible.filter((id) => selection.has(id));
    if (keep.length !== selection.size) {
      selection.clear();
      keep.forEach((id) => selection.add(id));
      if (expandedId && !selection.has(expandedId)) expandedId = null;
      refreshSelection();
    }
  }

  function clearFilter() {
    filter.types.clear();
    filter.states.clear();
    paintFilter();
    refreshSelection();
  }

  function selectFiltered() {
    const visible = nodes.filter((node) => nodeVisibleUnderFilter(node));
    if (!visible.length) {
      toast('现在没有符合筛选条件的卡片');
      return;
    }
    selection.clear();
    visible.forEach((node) => selection.add(node.id));
    refreshSelection();
    toast('已选中符合筛选的 ' + visible.length + ' 张卡片');
  }

  function openFilterPanel() {
    if (filterEl) {
      closeFilterPanel();
      return;
    }
    const mask = document.createElement('div');
    mask.className = 'modal-mask filter-mask';
    const typeButtons = FILTER_TYPES.map(
      (item) => '<button type="button" data-key="' + item.key + '">' + item.label + '</button>'
    ).join('');
    const stateButtons = FILTER_STATES.map(
      (item) => '<button type="button" data-key="' + item.key + '">' + item.label + '</button>'
    ).join('');
    mask.innerHTML =
      '<div class="modal filter-modal">' +
      '  <div class="modal-head"><b>只看想看的卡片</b>' +
      '    <span class="grow"></span>' +
      '    <button class="ghost" data-close>关闭</button></div>' +
      '  <div class="modal-body">' +
      '    <div class="filter-summary">没有筛选，所有卡片都正常显示</div>' +
      '    <div class="filter-block" data-filter="types">' +
      '      <div class="filter-title">按类型</div>' +
      '      <div class="filter-chips">' + typeButtons + '</div>' +
      '      <button type="button" class="filter-clear" data-clear="types" hidden>清掉类型筛选</button>' +
      '    </div>' +
      '    <div class="filter-block" data-filter="states">' +
      '      <div class="filter-title">按状态</div>' +
      '      <div class="filter-chips">' + stateButtons + '</div>' +
      '      <button type="button" class="filter-clear" data-clear="states" hidden>清掉状态筛选</button>' +
      '    </div>' +
      '    <div class="filter-hint">不符合条件的卡片会变淡留在原地，位置不会乱；连线两端都亮着才亮。' +
      '同一组里可以多选，比如「视频 + 生成失败」一起看。</div>' +
      '  </div>' +
      '  <div class="modal-foot">' +
      '    <button type="button" id="filter-all">清掉全部筛选</button>' +
      '    <button type="button" id="filter-select">选中符合的卡片</button>' +
      '    <span class="grow"></span>' +
      '    <span class="set-hint">筛选只影响显示，不改动卡片，也不进撤销记录。</span>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(mask);
    filterEl = mask;
    mask.addEventListener('click', (event) => {
      const button = event.target.closest ? event.target.closest('button') : null;
      if (!button) {
        if (event.target === mask) closeFilterPanel();
        return;
      }
      if (button.dataset.close !== undefined) {
        closeFilterPanel();
        return;
      }
      if (button.dataset.clear === 'types') {
        filter.types.clear();
        paintFilter();
        return;
      }
      if (button.dataset.clear === 'states') {
        filter.states.clear();
        paintFilter();
        return;
      }
      if (button.id === 'filter-all') {
        clearFilter();
        return;
      }
      if (button.id === 'filter-select') {
        selectFiltered();
        return;
      }
      const key = button.dataset.key;
      if (!key) return;
      const block = button.closest('.filter-block');
      const kind = block && block.dataset.filter === 'states' ? 'states' : 'types';
      toggleFilter(kind, key);
    });
    mask.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeFilterPanel();
      }
    });
    paintFilter();
  }

  function closeFilterPanel() {
    if (!filterEl) return;
    filterEl.remove();
    filterEl = null;
  }

  function bindFilter() {
    const button = document.getElementById('btn-filter');
    if (button) button.addEventListener('click', openFilterPanel);
  }

  function bindToolbar() {
    document.getElementById('btn-back').addEventListener('click', async () => {
      await saveNow();
      window.location.href = '/';
    });
    document.getElementById('btn-add').addEventListener('click', (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      openTypeMenu(rect.right + 10, rect.top, null);
    });
    const modeBtn = document.getElementById('tool-mode');
    if (modeBtn) modeBtn.addEventListener('click', () => setMode(mode === 'hand' ? 'select' : 'hand'));
    const themeBtn = document.getElementById('btn-theme');
    if (themeBtn && window.UITheme) {
      themeBtn.addEventListener('click', () => {
        const next = window.UITheme.current().theme === 'dark' ? 'light' : 'dark';
        window.UITheme.apply(Object.assign({}, window.UITheme.current(), { theme: next }));
        paintThemeButton(next);
        window.UITheme.save({ ui: { theme: next } }).catch(() => {
          toast('主题没能存下来，下次打开可能还是原来的');
        });
      });
    }
    document.addEventListener('ui-ready', (event) => {
      const theme = event.detail && event.detail.theme ? event.detail.theme : 'light';
      paintThemeButton(theme);
    });
    const minimapBtn = document.getElementById('btn-minimap');
    if (minimapBtn) minimapBtn.addEventListener('click', toggleMinimap);
    const submitCompressBtn = document.getElementById('btn-submit-compress');
    if (submitCompressBtn) submitCompressBtn.addEventListener('click', toggleSubmitCompress);
    const tailBtn = document.getElementById('btn-tail-prompts');
    if (tailBtn) {
      let tailClickTimer = 0;
      tailBtn.addEventListener('click', () => {
        if (tailClickTimer) return;
        tailClickTimer = window.setTimeout(() => {
          tailClickTimer = 0;
          toggleTailPrompts();
        }, 220);
      });
      tailBtn.addEventListener('dblclick', (event) => {
        event.preventDefault();
        if (tailClickTimer) {
          window.clearTimeout(tailClickTimer);
          tailClickTimer = 0;
        }
        if (window.UITheme) window.UITheme.openTailPromptsPanel();
      });
    }
    document.addEventListener('tail-prompts-changed', () => {
      paintTailPrompts(window.UITheme ? window.UITheme.tailPrompts().enabled : false);
      if (expandedId) {
        const node = byId(expandedId);
        if (node) refreshNode(node);
      }
    });
    const snapBtn = document.getElementById('btn-snap');
    if (snapBtn) {
      snapBtn.addEventListener('click', () => {
        setSnapGuide(!snapGuideOn);
        toast(snapGuideOn ? '对齐辅助线已打开：拖卡片时会吸附并出现标尺线' : '对齐辅助线已关闭：拖卡片不再出现线条');
      });
    }
    bindSearch();
    bindHelp();
    bindFilter();
    const tidyBtn = document.getElementById('btn-tidy');
    if (tidyBtn) {
      tidyBtn.addEventListener('click', (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        openTidyMenu(rect.right + 10, rect.top);
      });
    }
    const exportBtn = document.getElementById('btn-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        exportSelectedAssets();
      });
    }
    if (alignBarEl) {
      alignBarEl.addEventListener('click', (event) => {
        const button = event.target.closest ? event.target.closest('button') : null;
        if (!button) return;
        button.blur();
        const batch = button.dataset.batch || '';
        if (batch === 'generate') runBatchGenerate('generate');
        else if (batch === 'retry') runBatchGenerate('retry');
        else if (batch === 'rename') openBatchRename();
        if (batch) return;
        const action = button.dataset.align || '';
        if (action === 'dist-x') distributeSelection('x');
        else if (action === 'dist-y') distributeSelection('y');
        else if (action) alignSelection(action);
      });
      window.addEventListener('resize', () => {
        alignBarSize = null;
        placeAlignBar();
      });
    }
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-fit').addEventListener('click', fitView);
    document.getElementById('btn-reset').addEventListener('click', resetView);
    const locateBtn = document.getElementById('btn-locate');
    if (locateBtn) {
      locateBtn.addEventListener('click', (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        openLocateMenu(rect.left, rect.bottom + 6);
      });
    }
    const tasksBtn = document.getElementById('btn-tasks');
    if (tasksBtn && window.TaskPanel) {
      tasksBtn.addEventListener('click', () => window.TaskPanel.open());
    }
    document.getElementById('btn-zoom-in').addEventListener('click', () => zoomCenter(1.2));
    document.getElementById('btn-zoom-out').addEventListener('click', () => zoomCenter(1 / 1.2));
    const nameBtn = document.getElementById('rail-name');
    if (nameBtn) nameBtn.addEventListener('click', startTitleRename);
    if (titleBtnEl) {
      titleBtnEl.addEventListener('click', (event) => {
        event.stopPropagation();
        startTitleRename();
      });
      titleBtnEl.addEventListener('pointerdown', (event) => event.stopPropagation());
    }
    if (titleInputEl) {
      titleInputEl.addEventListener('pointerdown', (event) => event.stopPropagation());
      titleInputEl.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finishTitleRename(true);
          titleInputEl.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finishTitleRename(false);
          titleInputEl.blur();
        }
      });
      titleInputEl.addEventListener('blur', () => finishTitleRename(true));
    }
    updateHistoryButtons();
  }

  // 老画布里存的「提示词卡片 / 生成卡片」在打开时自动换成新卡片，内容不丢
  const LEGACY_SIZES = {
    image: [[340, 440], [260, 180]],
    video: [[360, 510], [260, 180]],
    audio: [[320, 300], [260, 180]],
  };

  function migrateNode(node) {
    const type = String(node.type || '');
    const raw = node.data && typeof node.data === 'object' ? node.data : {};
    const text = raw.text || raw.prompt || '';
    let next = node;
    if (type === 'prompt' || type === 'material') {
      next = { ...node, type: 'image', data: { ...raw, text: text } };
    } else if (type === 'generate') {
      next = { ...node, type: 'video', data: { ...raw, text: text } };
    } else if (!PRESETS[type]) {
      next = { ...node, type: 'image' };
    }
    // 旧版卡片是竖着的一条，卡片改版后换成贴着媒体的横条尺寸
    const legacy = LEGACY_SIZES[next.type] || [];
    if (legacy.some((pair) => pair[0] === next.w && pair[1] === next.h)) {
      const size = defaultSize(next.type, (next.data && next.data.params) || null);
      next = { ...next, w: size.w, h: size.h };
    }
    return next;
  }

  // 老画布的定时组升级成「大容器」：组框套住原来的成员，并按网格重新摆好
  function migrateScheduleContainers() {
    let changed = false;
    nodes.forEach((node) => {
      if (!isSchedule(node)) return;
      const data = nodeData(node);
      const stale = Number(data.layoutVersion) !== SCHEDULE_LAYOUT_VERSION;
      if (data.container === true && !stale) return;
      const members = scheduleOrderOf(node);
      data.container = true;
      changed = true;
      if (!members.length) return;
      let x1 = Infinity;
      let y1 = Infinity;
      members.forEach((member) => {
        x1 = Math.min(x1, member.x);
        y1 = Math.min(y1, member.y);
      });
      if (Number.isFinite(x1) && Number.isFinite(y1)) {
        node.x = Math.round(x1);
        node.y = Math.round(y1);
      }
    });
    if (changed) {
      refreshScheduleMemberMap();
      nodes.forEach((node) => {
        if (!isSchedule(node)) return;
        const members = scheduleOrderOf(node);
        if (members.length) layoutScheduleCards(node, members, false);
      });
      refreshScheduleMemberMap();
    }
    return changed;
  }

  // 把服务端返回的画布数据装进内存（bootstrap 首次加载、以及保存冲突后
  // 「用服务端最新版本」都走这里），保证两条路径的解析规则完全一致
  function applyServerState(state) {
    nodes = (state.nodes || []).map((raw) => {
      const node = migrateNode(raw);
      const preset = presetOf(node.type);
      return {
        id: node.id,
        type: node.type,
        x: node.x,
        y: node.y,
        w: node.w || preset.w,
        h: node.h || preset.h,
        data: node.data || {},
        createdAt: node.createdAt,
      };
    });
    edges = (state.edges || []).map((edge) => ({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      role: edge.role || '',
    }));
    viewport = state.viewport && Number.isFinite(state.viewport.zoom)
      ? { x: state.viewport.x, y: state.viewport.y, zoom: state.viewport.zoom }
      : { x: 0, y: 0, zoom: 1 };
    // 版本号跟着服务端走，之后保存都基于这一版
    canvasRev = state.canvas && Number.isInteger(state.canvas.rev) ? state.canvas.rev : 0;
  }

  async function bootstrap() {
    // 字体 / 字号 / 缩放 / 主题：先套上再画，避免闪一下
    if (window.UITheme) await window.UITheme.load();
    if (!canvasId) {
      window.location.replace('/');
      return;
    }
    await loadModels();
    try {
      const state = await window.api.getCanvas(canvasId);
      applyServerState(state);
      setCanvasName(state.canvas.name);
      // 老画布统一按建卡顺序排成连续号；号已经连续时这里什么都不改
      const numbered = renumberAll();
      if (numbered.tagged.size || numbered.retagged.size) scheduleSave();
      // 老的定时组是「组卡 + 散落在旁边的成员」：打开时自动收进组框里
      if (migrateScheduleContainers()) scheduleSave();
      // 顺手清掉已经删掉的卡片留下的高度记录
      prunePromptHeights();
      renderAll();
      applyViewport();
      // 刚读进来的样子当作基线：这一批不算「改过」，否则一打开满屏都是「刚刚修改」
      stampTouchedCards();
      loadingEl.classList.add('hidden');
      // 从库里读出来就算已保存状态，时间点用「刚刚读到」的此刻
      lastSavedAt = Date.now();
      setSaveState('saved');
      const focusId = params.get('node');
      if (focusId) {
        if (!focusNodeById(focusId)) toast('这张卡片已经不在了，可能已经被删掉');
      }
      resumeRunningTasks();
      startSchedulePolling();
      startTaskAdoption();
      // 库出过状况时提醒一句：画布页里看到的可能是重建后的空库
      checkHealth();
    } catch (error) {
      loadingEl.textContent = '打开画布失败：' + error.message;
      return;
    }

    bindEvents();
    setupPerfPanel();
    bindToolbar();
    bindFileDrop();
    bindLibraryDrawer();
    bindRail();
    setupMinimap();
    setMode(mode);
    paintThemeButton(window.UITheme ? window.UITheme.current().theme : 'light');
    paintSubmitCompress(window.UITheme ? window.UITheme.submitCompress().enabled : true);
    paintTailPrompts(window.UITheme ? window.UITheme.tailPrompts().enabled : false);
    const settingsBtn = document.getElementById('btn-settings');
    if (settingsBtn && window.UITheme) {
      settingsBtn.addEventListener('click', () => window.UITheme.openSettings());
    }

    // 关页面 / 刷新 / 切到别的站点之前：
    // 1) 还有没存上的内容 → 让浏览器弹一次原生确认，别让用户手一抖丢掉；
    // 2) 能存就顺手用 keepalive 发一次，作为最后一道保险。
    window.addEventListener('beforeunload', (event) => {
      if (!dirty) return;
      // 只要设了 returnValue，浏览器就会弹「离开此网站？」的确认框
      event.preventDefault();
      event.returnValue = '';
      return '';
    });

    window.addEventListener('pagehide', () => {
      if (!dirty) return;
      try {
        fetch('/api/canvases/' + encodeURIComponent(canvasId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          // 这里刻意不带 rev。这是关页面时的最后一道保险，页面马上就要没了，
          // 没有机会处理 409、也没机会问用户；带上已过期的 rev 只会让这次保存
          // 直接被拒、白丢最后几秒的改动。宁可覆盖，也要把用户刚敲进去的东西留住。
          body: JSON.stringify({ nodes: collectNodes(), edges: edges, viewport: viewport }),
          keepalive: true,
        });
      } catch {
        /* 忽略 */
      }
    });

    // 切回这个页面时：
    // 1) 上次是失败状态 → 本机服务可能刚恢复，自动再试一次；
    // 2) 有冲突待处理 → 不自动保存，等用户选完（顺手刷新一下「最新版到第几版」）
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (saveConflict) return;
      if (lastSaveError && dirty) saveNow(true);
    });
  }

  // 回收站面板给素材库那边也用（素材库在画布页里是同一份脚本加载的）
  window.openRecycleBin = openRecycleBin;

  bootstrap();
})();
