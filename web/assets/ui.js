(function () {
  const DEFAULTS = { scale: 1, theme: 'light', fontFamily: 'Microsoft YaHei UI', fontSize: 14 };
  const FONT_CHOICES = [
    { value: 'Microsoft YaHei UI', label: '微软雅黑 UI（默认，最清晰）' },
    { value: 'Microsoft YaHei', label: '微软雅黑' },
    { value: 'DengXian', label: '等线' },
    { value: 'SimHei', label: '黑体' },
    { value: 'SimSun', label: '宋体' },
    { value: 'KaiTi', label: '楷体' },
    { value: 'HarmonyOS Sans SC', label: '鸿蒙黑体（装了才有效）' },
    { value: 'system-ui', label: '系统默认' },
  ];
  const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20];
  const SUB_CHOICES = [
    { value: 'none', label: '直接放分类文件夹（默认）' },
    { value: 'date', label: '再按日期分一层，例如 图片/2026-10-29/' },
    { value: 'canvas', label: '再按画布名字分一层，例如 视频/第3集/' },
  ];

  const SHORTCUT_LABELS = [
    { key: 'select', label: '选择工具' },
    { key: 'hand', label: '平移工具' },
    { key: 'fit', label: '适应窗口' },
    { key: 'reset', label: '回到原点' },
    { key: 'undo', label: '撤销' },
    { key: 'redo', label: '重做' },
    { key: 'remove', label: '删除卡片' },
    { key: 'tidy', label: '一键整理排版' },
    { key: 'export', label: '导出卡片素材到本地' },
  ];

  const DEFAULT_SHORTCUTS = {
    select: 'v',
    hand: 'h',
    fit: 'shift+1',
    reset: 'ctrl+0',
    undo: 'ctrl+z',
    redo: 'ctrl+shift+z',
    remove: 'delete',
    tidy: 'ctrl+shift+l',
    export: 'ctrl+shift+e',
  };

  const KEY_ALIAS = { delete: '删除', backspace: '退格', escape: 'Esc', ' ': '空格', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' };

  function prettyKey(combo) {
    const parts = String(combo || '').split('+').filter(Boolean);
    return parts
      .map((part) => {
        if (part === 'ctrl') return 'Ctrl';
        if (part === 'alt') return 'Alt';
        if (part === 'shift') return 'Shift';
        return KEY_ALIAS[part] || part.toUpperCase();
      })
      .join(' + ');
  }

  // 把按键事件换算成统一写法，和存起来的快捷键比较
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
    if (!key) return '';
    return mods.concat(key).join('+');
  }

  let current = Object.assign({}, DEFAULTS);
  let store = { sub: 'none' };
  let shortcuts = Object.assign({}, DEFAULT_SHORTCUTS);
  let checks = [];
  let assetRoot = '';
  let submitCompress = { enabled: true };
  // 尾部提示词：按类型分成两个池子（视频 / 图片），互不相通。
  // 每套预设只存名字和正文，卡片只记「用哪一套」。
  // 视频组默认开（常用）、图片组默认关（不常用，需要时单独打开）。
  // 这只影响全新安装；已有配置按 normalizeTailPresets 迁移，不会被动到。
  let tailPrompts = {
    enabled: true,
    groups: {
      video: { enabled: true, defaultId: '', presets: [] },
      image: { enabled: false, defaultId: '', presets: [] },
    },
  };
  // 设置面板当前在编辑哪一组
  let tailEditingGroup = 'video';
  // 新建卡片默认值：图片 / 视频 / 快速视频各自用哪个模型、哪些参数。
  // 存在服务端 config.json 里（跟着 data/ 走，换电脑还在），这里只做前端缓存。
  const EMPTY_CARD_DEFAULTS = {
    image: { model: '', channelId: '', params: {} },
    video: { model: '', channelId: '', params: {} },
    quick: { model: '', channelId: '', params: {} },
  };
  let cardDefaults = JSON.parse(JSON.stringify(EMPTY_CARD_DEFAULTS));
  // 局域网访问：开关 + 这台电脑的网卡地址（服务端算好，前端只负责显示和复制）
  let lan = { enabled: false, addresses: [], port: 0 };

  const TAIL_GROUP_META = {
    video: { label: '视频', hint: '视频卡和快速视频卡用这一组。可以写运镜、时长、音效、嘴型这类只对视频有意义的规则。' },
    image: { label: '图片', hint: '图片卡用这一组。写构图、画风、光影、画幅这类对出图有意义的描述；别把视频的音频规则写进来。' },
  };

  function emptyTailGroup(enabled) {
    return { enabled: enabled !== false, defaultId: '', presets: [] };
  }

  // 归一：既认新结构（groups），也认老结构（扁平 presets → 全部归 video 池）。
  // 与服务端 config.normalizeTailPrompts 的迁移规则保持一致。
  function normalizeTailPresets(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const one = (src) => {
      const list = Array.isArray(src && src.presets) ? src.presets : [];
      const presets = [];
      const seen = new Set();
      list.slice(0, 30).forEach((item) => {
        if (!item || typeof item !== 'object') return;
        let id = String(item.id || '').trim() || 'tail_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        if (seen.has(id)) id = id + '_' + presets.length;
        seen.add(id);
        presets.push({
          id: id,
          name: String(item.name || '').trim().slice(0, 40) || '未命名风格',
          text: String(item.text || '').slice(0, 20000),
        });
      });
      let defaultId = String((src && src.defaultId) || '');
      if (defaultId && !presets.some((one_) => one_.id === defaultId)) defaultId = presets.length ? presets[0].id : '';
      return { defaultId: defaultId, presets: presets };
    };
    // 顶层 enabled 是 2 版「一个开关管两组」留下的；3 版起每组各有一个。
    // 迁移：某组没写自己的 enabled 就沿用顶层 —— 升级后行为与之前完全一致。
    const legacyEnabled = raw.enabled !== false;
    const enabledOf = (src) =>
      src && typeof src === 'object' && typeof src.enabled === 'boolean' ? src.enabled : legacyEnabled;
    const groups = { video: emptyTailGroup(), image: emptyTailGroup() };
    if (raw.groups && typeof raw.groups === 'object') {
      groups.video = one(raw.groups.video);
      groups.image = one(raw.groups.image);
      groups.video.enabled = enabledOf(raw.groups.video);
      groups.image.enabled = enabledOf(raw.groups.image);
    } else {
      // 老结构：那时只有视频 / 快速视频支持尾部提示词，所以全部归 video 池。
      // 只有一个开关，两组都跟着它，升级前后行为不变。
      groups.video = one(raw);
      groups.image = one(null);
      groups.video.enabled = legacyEnabled;
      groups.image.enabled = legacyEnabled;
    }
    // 顶层 enabled 只当 video 组的兼容视图，老调用方读它仍然有意义
    return { enabled: groups.video.enabled, groups: groups };
  }

  function cloneTailPrompts(value) {
    return JSON.parse(JSON.stringify(normalizeTailPresets(value)));
  }

  // 新建卡片默认值的归一化：规则在共享模块里（画布页与服务端同一份）。
  // 老页面缓存里可能没有这个脚本，这里留一份等价的最小实现。
  const cardDefaultsRules = window.CanvasCardDefaults || null;

  function normalizeCardDefaults(value) {
    if (cardDefaultsRules && typeof cardDefaultsRules.normalize === 'function') {
      return cardDefaultsRules.normalize(value);
    }
    const out = JSON.parse(JSON.stringify(EMPTY_CARD_DEFAULTS));
    const src = value && typeof value === 'object' ? value : {};
    Object.keys(out).forEach((type) => {
      const one = src[type] && typeof src[type] === 'object' ? src[type] : {};
      out[type].model = String(one.model || '');
      out[type].channelId = String(one.channelId || '');
      out[type].params = one.params && typeof one.params === 'object' ? Object.assign({}, one.params) : {};
    });
    return out;
  }

  function cloneCardDefaults(value) {
    return JSON.parse(JSON.stringify(normalizeCardDefaults(value)));
  }

  function tailGroupOf(value) {
    return value === 'image' ? 'image' : 'video';
  }

  function fontStack(family) {
    const clean = String(family || '').trim() || 'Microsoft YaHei UI';
    return clean + ', "Microsoft YaHei", "Segoe UI", "PingFang SC", sans-serif';
  }

  function apply(ui) {
    current = Object.assign({}, DEFAULTS, ui || {});
    const root = document.documentElement;
    root.style.setProperty('--ui-scale', String(current.scale));
    root.style.setProperty('--font-base', current.fontSize + 'px');
    root.style.setProperty('--font', fontStack(current.fontFamily));
    root.setAttribute('data-theme', current.theme === 'dark' ? 'dark' : 'light');
  }

  // 尾部预设的结构版本。前端保存前跟服务端给的号比对：
  // 不一致说明"页面是新的、服务进程还是旧的"（或反之）。
  // 这种时候**不能盲目保存** —— 2026-11-08 就是这么把用户那套 335 字的预设清空的：
  // 新前端发 {enabled, groups}，旧服务端只认扁平 presets，于是读成空并落盘。
  const TAIL_SCHEMA_VERSION = 3;
  let tailSchemaMismatch = false;

  function applyStatus(status) {
    if (!status) return;
    apply(status.ui || (status.defaults && status.defaults.ui));
    store = status.store || store;
    if (status.shortcuts) shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, status.shortcuts);
    submitCompress = { enabled: !(status.submitCompress && status.submitCompress.enabled === false) };
    tailPrompts = normalizeTailPresets(status.tailPrompts);
    cardDefaults = normalizeCardDefaults(status.cardDefaults);
    // 服务端没报版本号 = 它是改动前的旧进程；报了但不是 2 = 结构对不上
    tailSchemaMismatch = Number(status.tailSchemaVersion) !== TAIL_SCHEMA_VERSION;
    if (status.lan && typeof status.lan === 'object') {
      lan = {
        enabled: status.lan.enabled === true,
        addresses: Array.isArray(status.lan.addresses) ? status.lan.addresses : [],
        port: Number(status.lan.port) || 0,
      };
    }
    checks = status.checks || [];
    assetRoot = status.assetRoot || '';
  }

  async function load() {
    try {
      const status = await window.api.status();
      applyStatus(status);
    } catch (error) {
      apply(current);
    }
    document.dispatchEvent(new CustomEvent('ui-ready', { detail: current }));
    return current;
  }

  async function save(patch) {
    const body = {};
    if (patch.ui) body.ui = Object.assign({}, current, patch.ui);
    if (patch.store) body.store = Object.assign({}, store, patch.store);
    if (patch.shortcuts) body.shortcuts = Object.assign({}, shortcuts, patch.shortcuts);
    if (patch.submitCompress) body.submitCompress = Object.assign({}, submitCompress, patch.submitCompress);
    if (patch.tailPrompts) body.tailPrompts = cloneTailPrompts(patch.tailPrompts);
    if (patch.cardDefaults) body.cardDefaults = cloneCardDefaults(patch.cardDefaults);
    if (patch.assetRoot) body.assetRoot = patch.assetRoot;
    if (patch.lan) body.lan = { enabled: Boolean(patch.lan.enabled) };
    const status = await window.api.saveSettings(body);
    applyStatus(status);
    document.dispatchEvent(new CustomEvent('ui-ready', { detail: current }));
    return current;
  }

  function optionsHtml(list, value) {
    return list
      .map((item) => {
        const picked = String(item.value) === String(value) ? ' selected' : '';
        return '<option value="' + item.value + '"' + picked + '>' + item.label + '</option>';
      })
      .join('');
  }

  function checkListHtml() {
    if (!checks.length) return '<div class="muted-line">暂时没读到自检结果。</div>';
    return checks
      .map(
        (item) =>
          '<div class="check-row ' + (item.ok ? 'ok' : 'warn') + '">' +
          '<span class="check-dot"></span>' +
          '<b>' + item.label + '</b>' +
          '<span class="check-detail">' + item.detail + '</span>' +
          '</div>'
      )
      .join('');
  }

  let panelEl = null;

  function closePanel() {
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    panelEl = null;
  }

  function openSettings() {
    if (panelEl) return closePanel();
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal modal-settings">' +
      '  <div class="modal-head"><b>显示与设置</b>' +
      '    <button class="ghost" data-close>关闭</button></div>' +
      '  <div class="modal-body">' +
      '    <div class="set-group"><div class="set-title">界面显示</div>' +
      '      <div class="set-row"><label>主题</label><select id="set-theme">' +
      '<option value="light">浅色（默认）</option><option value="dark">深色</option></select></div>' +
      '      <div class="set-row"><label>整体缩放</label>' +
      '        <input type="range" id="set-scale" min="90" max="150" step="5" />' +
      '        <span class="set-value" id="set-scale-value">100%</span></div>' +
      '      <div class="set-row"><label>字体</label><select id="set-font">' + optionsHtml(FONT_CHOICES, current.fontFamily) + '</select></div>' +
      '      <div class="set-row"><label>字号</label><select id="set-size">' +
      FONT_SIZES.map((size) => '<option value="' + size + '">' + size + ' px</option>').join('') +
      '</select></div>' +
      '      <div class="set-hint">缩放管整体大小，字号管文字大小，两个一起调，2K / 4K 屏看着都不累。</div>' +
      '    </div>' +

      '    <div class="set-group"><div class="set-title">新建卡片默认值</div>' +
      '      <div class="set-row"><label>图片 / 视频</label>' +
      '        <span class="cd-summary" id="set-cd-summary">—</span>' +
      '        <button class="ghost" id="set-cd-open">设置…</button></div>' +
      '      <div class="set-hint">指定新建图片卡、视频卡默认用哪个模型、多少 K、什么比例。设好之后新建卡片就不用每次重选了；已有卡片不受影响。也可以直接在卡片上右键「设为新建默认」。</div>' +
      '    </div>' +

      '    <div class="set-group"><div class="set-title">素材与归档</div>' +
      '      <div class="set-row"><label>素材根目录</label><input type="text" id="set-asset" spellcheck="false" /></div>' +
      '      <div class="set-row"><label>归档方式</label><select id="set-sub">' + optionsHtml(SUB_CHOICES, store.sub || 'none') + '</select></div>' +
      '      <div class="set-hint">换目录只影响以后新存的文件，旧素材不会搬走也不会丢。归档方式决定生成结果要不要再分一层子文件夹。</div>' +
      '    </div>' +

      '    <div class="set-group"><div class="set-title">另一台电脑同步程序</div>' +
      '      <div class="set-row"><label>允许局域网（仅程序文件）</label>' +
      '        <label class="lan-check"><input type="checkbox" id="set-lan" /><span id="set-lan-state">关闭</span></label>' +
      '      </div>' +
      '      <div class="lan-body" id="set-lan-body"></div>' +
      '      <div class="set-hint">打开后，另一台电脑可以从这台电脑拉取程序文件（另一台右键托盘 →「同步程序代码…」）。只传程序，画布和素材库各自一份，不会被同步。改完要重启服务才生效。</div>' +
      '    </div>' +

      '    <div class="set-group"><div class="set-title">启动自检</div>' + checkListHtml() +
      '      <div class="set-hint">素材库、日志、导入备份都在门户页顶部那一排按钮里。</div>' +
      '    </div>' +

      '    <div class="set-group"><div class="set-title">画布快捷键</div>' +
      '      <div class="set-hint">点右边的键位，然后直接按你想用的组合键就改好了。按 Esc 取消。</div>' +
      '      <div id="set-keys"></div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="modal-foot"><button id="set-reset">恢复默认</button>' +
      '    <span class="grow"></span><span class="set-saved" id="set-saved"></span></div>' +
      '</div>';
    document.body.appendChild(mask);
    panelEl = mask;

    const themeEl = mask.querySelector('#set-theme');
    const scaleEl = mask.querySelector('#set-scale');
    const scaleLabel = mask.querySelector('#set-scale-value');
    const fontEl = mask.querySelector('#set-font');
    const sizeEl = mask.querySelector('#set-size');
    const assetEl = mask.querySelector('#set-asset');
    const subEl = mask.querySelector('#set-sub');
    const savedEl = mask.querySelector('#set-saved');
    const lanEl = mask.querySelector('#set-lan');
    const lanStateEl = mask.querySelector('#set-lan-state');
    const lanBodyEl = mask.querySelector('#set-lan-body');

    const keysBox = mask.querySelector('#set-keys');
    let capturing = null;
    const renderKeys = () => {
      keysBox.textContent = '';
      SHORTCUT_LABELS.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'set-row set-key-row';
        const label = document.createElement('label');
        label.textContent = item.label;
        const button = document.createElement('button');
        button.className = 'key-button' + (capturing === item.key ? ' capturing' : '');
        button.textContent = capturing === item.key ? '按下新的按键…' : prettyKey(shortcuts[item.key]);
        button.addEventListener('click', () => {
          capturing = item.key;
          renderKeys();
        });
        row.appendChild(label);
        row.appendChild(button);
        keysBox.appendChild(row);
      });
    };
    const captureKey = async (event) => {
      if (!capturing) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        capturing = null;
        renderKeys();
        return;
      }
      const combo = comboOf(event);
      if (!combo || combo === 'shift' || combo === 'ctrl' || combo === 'alt') return;
      const action = capturing;
      shortcuts = Object.assign({}, shortcuts, { [action]: combo });
      capturing = null;
      renderKeys();
      try {
        await save({ shortcuts: { [action]: combo } });
        flash('快捷键已改：' + prettyKey(combo), false);
      } catch (error) {
        flash('保存失败：' + error.message, true);
      }
    };
    mask.addEventListener('keydown', captureKey);
    renderKeys();

    themeEl.value = current.theme;
    scaleEl.value = String(Math.round(current.scale * 100));
    scaleLabel.textContent = Math.round(current.scale * 100) + '%';
    sizeEl.value = String(current.fontSize);
    assetEl.value = assetRoot;

    // 局域网地址：点一下就复制，省得手动选中
    const copyText = (text) => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
          return true;
        }
      } catch { /* 非安全上下文，走下面的兜底 */ }
      try {
        const box = document.createElement('textarea');
        box.value = text;
        box.style.position = 'fixed';
        box.style.opacity = '0';
        document.body.appendChild(box);
        box.select();
        document.execCommand('copy');
        document.body.removeChild(box);
        return true;
      } catch {
        return false;
      }
    };

    const renderLan = () => {
      lanEl.checked = lan.enabled;
      lanStateEl.textContent = lan.enabled ? '已打开' : '关闭';
      lanStateEl.className = lan.enabled ? 'lan-on' : '';
      lanBodyEl.textContent = '';
      if (!lan.enabled) return;
      const port = lan.port || Number(location.port) || 17890;
      if (!lan.addresses.length) {
        const warn = document.createElement('div');
        warn.className = 'lan-warn';
        warn.textContent = '这台电脑现在没有可用的局域网地址（网线或 Wi-Fi 没连上），连上后重启服务再看。';
        lanBodyEl.appendChild(warn);
        return;
      }
      lan.addresses.forEach((ip) => {
        const url = 'http://' + ip + ':' + port;
        const row = document.createElement('div');
        row.className = 'lan-addr';
        const text = document.createElement('code');
        text.textContent = url;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ghost';
        btn.textContent = '复制';
        btn.addEventListener('click', () => {
          btn.textContent = copyText(url) ? '已复制' : '请手动选中';
          setTimeout(() => { btn.textContent = '复制'; }, 1500);
        });
        row.appendChild(text);
        row.appendChild(btn);
        lanBodyEl.appendChild(row);
      });
      const note = document.createElement('div');
      note.className = 'set-hint';
      note.textContent = '另一台电脑在托盘右键 →「同步程序代码…」里填上面这个地址，点「对比一下」再「开始同步」。打不开多半是 Windows 防火墙拦了：允许 node.exe 访问专用网络即可。';
      lanBodyEl.appendChild(note);
    };
    renderLan();

    let timer = null;
    const flash = (text, bad) => {
      savedEl.textContent = text;
      savedEl.className = 'set-saved' + (bad ? ' bad' : '');
    };

    const persist = (patch, note) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          await save(patch);
          flash(note + '（已保存）', false);
        } catch (error) {
          flash('保存失败：' + error.message, true);
        }
      }, 250);
    };

    themeEl.addEventListener('change', () => {
      apply(Object.assign({}, current, { theme: themeEl.value }));
      persist({ ui: { theme: themeEl.value } }, '主题已切换');
    });
    scaleEl.addEventListener('input', () => {
      const value = Number(scaleEl.value) / 100;
      scaleLabel.textContent = scaleEl.value + '%';
      apply(Object.assign({}, current, { scale: value }));
      persist({ ui: { scale: value } }, '缩放已改');
    });
    fontEl.addEventListener('change', () => {
      apply(Object.assign({}, current, { fontFamily: fontEl.value }));
      persist({ ui: { fontFamily: fontEl.value } }, '字体已换');
    });
    sizeEl.addEventListener('change', () => {
      const value = Number(sizeEl.value);
      apply(Object.assign({}, current, { fontSize: value }));
      persist({ ui: { fontSize: value } }, '字号已改');
    });
    subEl.addEventListener('change', () => {
      store = Object.assign({}, store, { sub: subEl.value });
      persist({ store: { sub: subEl.value } }, '归档方式已改');
    });
    assetEl.addEventListener('change', () => {
      const value = assetEl.value.trim();
      if (!value) return;
      persist({ assetRoot: value }, '素材目录已改');
    });
    const cdSummaryEl = mask.querySelector('#set-cd-summary');
    const paintCdSummary = () => {
      if (!cdSummaryEl) return;
      const bits = [];
      ['image', 'video'].forEach((type) => {
        const one = cardDefaults[type] || {};
        const params = Object.keys(one.params || {}).map((key) => one.params[key]);
        if (!one.model && !params.length) return;
        bits.push((type === 'image' ? '图片' : '视频') + ' ' + (one.model || '渠道默认') + (params.length ? ' · ' + params.join(' / ') : ''));
      });
      cdSummaryEl.textContent = bits.length ? bits.join('　｜　') : '还没设，新卡片跟着渠道默认走';
    };
    paintCdSummary();
    const onCdChanged = () => paintCdSummary();
    document.addEventListener('card-defaults-changed', onCdChanged);
    // 面板关掉时解绑：否则开关几次就挂了一堆同样的监听
    const unbindCd = () => document.removeEventListener('card-defaults-changed', onCdChanged);
    mask.querySelector('[data-close]').addEventListener('click', unbindCd);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) unbindCd();
    });
    const cdOpenBtn = mask.querySelector('#set-cd-open');
    if (cdOpenBtn) cdOpenBtn.addEventListener('click', () => openCardDefaultsPanel());

    lanEl.addEventListener('change', async () => {
      lan = Object.assign({}, lan, { enabled: lanEl.checked });
      renderLan();
      try {
        await save({ lan: { enabled: lanEl.checked } });
        flash(lanEl.checked ? '已允许另一台电脑拉取程序，重启服务后生效' : '已不允许另一台电脑访问，重启服务后生效', false);
      } catch (error) {
        lan = Object.assign({}, lan, { enabled: !lanEl.checked });
        renderLan();
        flash('保存失败：' + error.message, true);
      }
    });

    mask.querySelector('#set-reset').addEventListener('click', async () => {
      apply(DEFAULTS);
      shortcuts = Object.assign({}, DEFAULT_SHORTCUTS);
      renderKeys();
      themeEl.value = DEFAULTS.theme;
      scaleEl.value = '100';
      scaleLabel.textContent = '100%';
      fontEl.value = DEFAULTS.fontFamily;
      sizeEl.value = String(DEFAULTS.fontSize);
      try {
        await save({ ui: DEFAULTS, shortcuts: DEFAULT_SHORTCUTS });
        flash('已恢复默认', false);
      } catch (error) {
        flash('恢复失败：' + error.message, true);
      }
    });

    mask.querySelector('[data-close]').addEventListener('click', closePanel);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) closePanel();
    });
  }

  // ---------- 新建卡片默认值 ----------
  //
  // 为什么单独做一个面板而不是塞进「显示与设置」：这里要选模型、还要让参数
  // 跟着模型收敛（只开 1K 的模型就不该给 2K），属性多、交互重，
  // 混在主题 / 字体那堆里会很长。入口还在设置面板里，点一下进来。
  let cardDefaultsPanelEl = null;
  let modelCache = null;

  function closeCardDefaultsPanel() {
    if (cardDefaultsPanelEl && cardDefaultsPanelEl.parentNode) {
      cardDefaultsPanelEl.parentNode.removeChild(cardDefaultsPanelEl);
    }
    cardDefaultsPanelEl = null;
  }

  const CARD_TYPE_META = {
    image: { label: '图片卡片', hint: '新建图片卡时默认用这套模型和参数。' },
    video: { label: '视频卡片', hint: '新建视频卡时默认用这套模型和参数。快速视频默认跟这里走。' },
    quick: { label: '快速视频卡片', hint: '留空就跟随上面的视频卡片设置；只有你想让它单独一套时才改这里。' },
  };

  function modelListOf(kind) {
    const list = (modelCache && modelCache[kind === 'quick' ? 'video' : kind]) || [];
    return list.filter((item) => item && item.id);
  }

  function specOfModel(kind, model, channelId) {
    const list = modelListOf(kind);
    const hit =
      (channelId && list.find((item) => item.id === model && item.channelId === channelId)) ||
      list.find((item) => item.id === model);
    return (hit && hit.spec) || null;
  }

  function optionsOfParam(kind, key, spec) {
    if (cardDefaultsRules && typeof cardDefaultsRules.optionsFor === 'function') {
      const got = cardDefaultsRules.optionsFor(kind, key, spec);
      if (got && got.length) return got;
    }
    const defs = (cardDefaultsRules && cardDefaultsRules.UI_OPTIONS_OF ? cardDefaultsRules.UI_OPTIONS_OF(kind) : []);
    const def = defs.find((one) => one.key === key);
    return def ? def.options.slice() : [];
  }

  function openCardDefaultsPanel() {
    if (cardDefaultsPanelEl) return closeCardDefaultsPanel();
    const draft = cloneCardDefaults(cardDefaults);

    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal modal-defaults">' +
      '  <div class="modal-head"><b>新建卡片默认值</b>' +
      '    <button class="ghost" data-close>关闭</button></div>' +
      '  <div class="modal-body">' +
      '    <div class="set-hint">只影响<b>之后新建</b>的卡片，画布上已有的卡片不会被改动。设置存在 data 里，换电脑、同步更新都还在。</div>' +
      '    <div id="cd-sections"></div>' +
      '  </div>' +
      '  <div class="modal-foot">' +
      '    <button id="cd-reset">全部恢复默认</button>' +
      '    <span class="grow"></span>' +
      '    <span class="set-saved" id="cd-saved"></span>' +
      '    <button class="primary" id="cd-save">保存</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(mask);
    cardDefaultsPanelEl = mask;

    const sectionsEl = mask.querySelector('#cd-sections');
    const savedEl = mask.querySelector('#cd-saved');
    const flash = (text, bad) => {
      savedEl.textContent = text;
      savedEl.className = 'set-saved' + (bad ? ' bad' : '');
    };

    // 某一类当前可用的参数档位（跟着这个模型收敛）
    const defsFor = (type) => {
      const one = draft[type];
      const spec = specOfModel(type, one.model, one.channelId);
      const base = cardDefaultsRules && cardDefaultsRules.UI_OPTIONS_OF
        ? cardDefaultsRules.UI_OPTIONS_OF(type)
        : [{ key: 'size', label: '尺寸', options: ['1K', '2K', '4K'] }];
      return base.map((def) => {
        const options = optionsOfParam(type, def.key, spec);
        return Object.assign({}, def, {
          options: cardDefaultsRules && cardDefaultsRules.optionsFor
            ? options.length ? options : def.options
            : def.options,
        });
      });
    };

    // 这个模型对当前选择会做什么收敛（面板要提前说出来，不能等建完卡才发现变了）
    const warnFor = (type) => {
      if (!cardDefaultsRules || typeof cardDefaultsRules.explainPreset !== 'function') return '';
      const one = draft[type];
      const spec = specOfModel(type, one.model, one.channelId);
      const got = cardDefaultsRules.explainPreset(type, one, spec);
      return got.changed ? '按这个模型，新建时会调整：' + got.text : '';
    };

    const render = () => {
      sectionsEl.textContent = '';
      ['image', 'video', 'quick'].forEach((type) => {
        const meta = CARD_TYPE_META[type];
        const one = draft[type];
        const box = document.createElement('div');
        box.className = 'set-group cd-group';

        const title = document.createElement('div');
        title.className = 'set-title';
        title.textContent = meta.label;
        box.appendChild(title);

        const hint = document.createElement('div');
        hint.className = 'set-hint';
        hint.textContent = meta.hint;
        box.appendChild(hint);

        // 模型下拉：第一个选项是「跟随渠道默认」
        const row = document.createElement('div');
        row.className = 'set-row';
        const label = document.createElement('label');
        label.textContent = '默认模型';
        row.appendChild(label);
        const select = document.createElement('select');
        select.className = 'cd-model';
        const follow = document.createElement('option');
        follow.value = '';
        follow.textContent = type === 'quick' ? '跟随视频卡片' : '跟随渠道默认';
        select.appendChild(follow);
        modelListOf(type).forEach((item) => {
          const opt = document.createElement('option');
          opt.value = item.channelId + '::' + item.id;
          opt.textContent = item.label || item.id;
          select.appendChild(opt);
        });
        if (!modelListOf(type).length) {
          follow.textContent = '还没有配置模型（先去接口通道设置里配）';
        }
        // 回显：模型 + 通道都要对上才算选中
        if (one.model) {
          const want = one.channelId ? one.channelId + '::' + one.model : '';
          let matched = '';
          if (want && Array.from(select.options).some((o) => o.value === want)) matched = want;
          else {
            const byName = Array.from(select.options).find((o) => o.value.split('::').slice(1).join('::') === one.model);
            if (byName) matched = byName.value;
          }
          select.value = matched;
          if (!matched) {
            // 模型已经不在清单里：仍然显示出来，让用户看到「这个模型没了」，而不是静默变成跟随默认
            const ghost = document.createElement('option');
            ghost.value = '__gone__';
            ghost.textContent = one.model + '（当前渠道里找不到）';
            select.insertBefore(ghost, select.firstChild);
            select.value = '__gone__';
          }
        }
        select.addEventListener('change', () => {
          if (select.value === '__gone__') return;
          const parts = select.value ? select.value.split('::') : [''];
          one.channelId = select.value ? parts[0] : '';
          one.model = select.value ? parts.slice(1).join('::') : '';
          // 换模型后参数可能不适用：立刻按新模型收敛一遍
          const spec = specOfModel(type, one.model, one.channelId);
          defsFor(type).forEach((def) => {
            const value = one.params[def.key];
            if (value === undefined) return;
            if (def.options.indexOf(value) >= 0) return;
            one.params[def.key] = def.options[0];
          });
          if (spec) {
            const seeded = cardDefaultsRules && cardDefaultsRules.seedParams
              ? cardDefaultsRules.seedParams(type, one, spec).params
              : null;
            if (seeded) one.params = Object.assign({}, one.params, seeded);
          }
          render();
        });
        row.appendChild(select);
        box.appendChild(row);

        // 参数：每个键一行「标签 + 下拉」
        defsFor(type).forEach((def) => {
          const prow = document.createElement('div');
          prow.className = 'set-row';
          const plabel = document.createElement('label');
          plabel.textContent = def.label;
          prow.appendChild(plabel);
          const psel = document.createElement('select');
          const current = one.params[def.key] === undefined ? '' : one.params[def.key];
          const empty = document.createElement('option');
          empty.value = '';
          empty.textContent = '跟随默认';
          psel.appendChild(empty);
          def.options.forEach((value, index) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = (def.texts && def.texts[index]) || value;
            psel.appendChild(opt);
          });
          // 用户选的这一档这个模型不支持（例如设了 2K，但模型只开 1024*1024）：
          // 不能默默显示成「跟随默认」—— 那会让用户以为设置没存上。
          // 保留原值单列一项，并说清新建时会收敛成什么。
          if (current && def.options.indexOf(current) < 0) {
            const spec = specOfModel(type, one.model, one.channelId);
            let willUse = def.options[0];
            if (cardDefaultsRules && cardDefaultsRules.seedParams) {
              const seeded = cardDefaultsRules.seedParams(type, one, spec);
              if (seeded.params[def.key]) willUse = seeded.params[def.key];
            }
            const ghost = document.createElement('option');
            ghost.value = current;
            ghost.textContent = current + '（该模型不支持，新建时按 ' + willUse + '）';
            psel.insertBefore(ghost, psel.children[1] || null);
          }
          psel.value = current && (def.options.indexOf(current) >= 0 || Array.from(psel.options).some((o) => o.value === current))
            ? current
            : '';
          psel.addEventListener('change', () => {
            if (!psel.value) delete one.params[def.key];
            else one.params[def.key] = psel.value;
            render();
          });
          prow.appendChild(psel);
          box.appendChild(prow);
        });

        const warn = warnFor(type);
        if (warn) {
          const line = document.createElement('div');
          line.className = 'cd-warn';
          line.textContent = warn;
          box.appendChild(line);
        }

        sectionsEl.appendChild(box);
      });
    };

    render();

    mask.querySelector('#cd-save').addEventListener('click', async () => {
      // 把「当前渠道里找不到」的模型拦在保存前，避免下次新建卡片时才报错
      const gone = ['image', 'video', 'quick'].filter((type) => draft[type].model && !modelListOf(type).some((item) => item.id === draft[type].model));
      if (gone.length) {
        flash('有模型在当前渠道里找不到了，先换个模型再保存', true);
        return;
      }
      try {
        await save({ cardDefaults: cloneCardDefaults(draft) });
        cardDefaults = normalizeCardDefaults(draft);
        flash('已保存，新建卡片会按这套来', false);
        // 设置面板里的摘要、画布页的默认值缓存都靠这个事件刷新
        document.dispatchEvent(new CustomEvent('card-defaults-changed'));
      } catch (error) {
        flash('保存失败：' + error.message, true);
      }
    });

    mask.querySelector('#cd-reset').addEventListener('click', () => {
      Object.keys(draft).forEach((type) => {
        draft[type] = { model: '', channelId: '', params: {} };
      });
      render();
      flash('已清空，点「保存」才会生效', false);
    });

    mask.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeCardDefaultsPanel));
    mask.addEventListener('click', (event) => {
      if (event.target === mask) closeCardDefaultsPanel();
    });

    // 模型清单是异步拉的：先画一版（可能只有「跟随渠道默认」），拿到再重画
    if (!modelCache) {
      const load = window.api && window.api.models ? window.api.models() : Promise.resolve(null);
      load
        .then((data) => {
          if (!data) return;
          modelCache = {
            image: Array.isArray(data.image) ? data.image : [],
            video: Array.isArray(data.video) ? data.video : [],
            audio: Array.isArray(data.audio) ? data.audio : [],
          };
          if (cardDefaultsPanelEl === mask) render();
        })
        .catch(() => {
          /* 拉不到就保持「跟随渠道默认」 */
        });
    }
  }

  // ---------- 尾部提示词预设管理 ----------
  // 面板里改的是一份草稿，点保存才写进设置；卡片只引用预设 id，所以删预设后旧卡会明确提示。
  let tailPanelEl = null;

  function closeTailPanel() {
    if (tailPanelEl && tailPanelEl.parentNode) tailPanelEl.parentNode.removeChild(tailPanelEl);
    tailPanelEl = null;
  }

  function openTailPromptsPanel(group) {
    if (group) tailEditingGroup = tailGroupOf(group);
    if (tailPanelEl) return closeTailPanel();
    const draft = cloneTailPrompts(tailPrompts);
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal modal-tail">' +
      '  <div class="modal-head"><b>尾部提示词</b>' +
      '    <button class="ghost" data-close>关闭</button></div>' +
      '  <div class="modal-body tail-body">' +
      '    <div class="tail-master">' +
      '      <div class="tail-master-summary" id="tail-summary"></div>' +
      '      <div class="set-hint">视频和图片<b>各有一个开关</b>，互不影响。关掉哪一组，就只有那一类卡片不再追加；卡片上自己的选择会保留，重新打开就会恢复。</div>' +
      '    </div>' +
      '    <div class="tail-group-switch">' +
      '      <label class="tail-switch"><input type="checkbox" id="tail-group-enabled" />' +
      '        <span id="tail-group-enabled-label">启用本组</span></label>' +
      '      <span class="set-hint" id="tail-group-enabled-hint"></span>' +
      '    </div>' +
      // 版本不一致的红条：默认不显示，打开面板时按实际状态决定
      '    <div class="tail-version-warn" id="tail-version-warn" hidden>' +
      '      服务端还是旧版本（页面已经更新了）。这时候保存会把预设写空，请先<b>重启画布服务</b>，再刷新本页。' +
      '    </div>' +
      '    <div class="tail-tabs" id="tail-tabs">' +
      '      <button type="button" class="tail-tab" data-group="video">视频</button>' +
      '      <button type="button" class="tail-tab" data-group="image">图片</button>' +
      '      <span class="tail-tab-hint" id="tail-tab-hint"></span>' +
      '    </div>' +
      '    <div class="tail-list" id="tail-list"></div>' +
      '    <div class="tail-add"><button type="button" id="tail-add">+ 新增一套</button>' +
      '      <span class="set-hint">可以按风格预先写好多套，生成前在卡片上勾选即可。</span></div>' +
      '    <div class="tail-preview-note">尾部提示词会自动接在主提示词后面，中间空一行；主提示词里已经含这段文字时不会重复追加。' +
      '      <b>视频和图片是分开的两组，互不相通</b> —— 图片卡只会用到「图片」这一组里的预设。</div>' +
      '  </div>' +
      '  <div class="modal-foot"><span class="set-saved" id="tail-saved"></span><span class="grow"></span>' +
      '    <button class="ghost" data-close>关闭</button>' +
      '    <button class="primary" id="tail-save">保存</button></div>' +
      '</div>';
    document.body.appendChild(mask);
    tailPanelEl = mask;

    const listEl = mask.querySelector('#tail-list');
    const groupEnabledEl = mask.querySelector('#tail-group-enabled');
    const groupEnabledLabel = mask.querySelector('#tail-group-enabled-label');
    const groupEnabledHint = mask.querySelector('#tail-group-enabled-hint');
    const summaryEl = mask.querySelector('#tail-summary');
    const savedEl = mask.querySelector('#tail-saved');
    const tabsEl = mask.querySelector('#tail-tabs');
    const tabHintEl = mask.querySelector('#tail-tab-hint');

    // 版本不一致时直接把红条亮出来（保存按钮也会拒绝），
    // 免得用户点半天才发现存不上、或者更糟——把预设写空。
    const warnEl = mask.querySelector('#tail-version-warn');
    if (warnEl && tailSchemaMismatch) warnEl.hidden = false;

    const flash = (text, bad) => {
      savedEl.textContent = text;
      savedEl.className = 'set-saved' + (bad ? ' bad' : '');
    };

    // 当前编辑的那一组（引用，直接改 draft.groups[group]）
    const groupOf = () => draft.groups[tailGroupOf(tailEditingGroup)];

    // 顶部摘要 + 当前这一组自己的开关
    const paintGroupState = () => {
      const g = tailGroupOf(tailEditingGroup);
      const meta = TAIL_GROUP_META[g];
      const on = draft.groups[g].enabled !== false;
      if (groupEnabledEl) groupEnabledEl.checked = on;
      if (groupEnabledLabel) groupEnabledLabel.textContent = '启用' + meta.label + '尾部提示词';
      if (groupEnabledHint) {
        groupEnabledHint.textContent = on
          ? meta.label + '卡片生成时会按各自的选择追加预设文字'
          : meta.label + '卡片一律不追加（另一组不受影响）';
      }
      if (summaryEl) {
        const v = draft.groups.video.enabled !== false;
        const i = draft.groups.image.enabled !== false;
        summaryEl.innerHTML =
          '<span class="tail-sum-chip' + (v ? ' on' : '') + '">视频 ' + (v ? '开' : '关') + '</span>' +
          '<span class="tail-sum-chip' + (i ? ' on' : '') + '">图片 ' + (i ? '开' : '关') + '</span>';
      }
    };

    const paintTabs = () => {
      Array.from(tabsEl.querySelectorAll('.tail-tab')).forEach((tab) => {
        const g = tailGroupOf(tab.dataset.group);
        const count = draft.groups[g].presets.length;
        const on = draft.groups[g].enabled !== false;
        // 标签上直接标出「开 / 关」，不用切过去才知道
        tab.textContent = TAIL_GROUP_META[g].label + (count ? '（' + count + '）' : '') + (on ? '' : ' · 关');
        tab.classList.toggle('on', g === tailGroupOf(tailEditingGroup));
        tab.classList.toggle('off', !on);
        // 图片卡那一组还没建过预设时给个提示点，免得用户以为坏了
        tab.classList.toggle('empty', count === 0);
      });
      tabHintEl.textContent = TAIL_GROUP_META[tailGroupOf(tailEditingGroup)].hint;
      paintGroupState();
    };

    const render = () => {
      paintTabs();
      listEl.textContent = '';
      const group = groupOf();
      if (!group.presets.length) {
        const empty = document.createElement('div');
        empty.className = 'tail-empty';
        empty.textContent = tailGroupOf(tailEditingGroup) === 'image'
          ? '「图片」这一组还没有预设。图片卡要的措辞和视频不同，点下面的「+ 新增一套」单独写一套（例如构图 / 画风 / 光影 / 画幅）。'
          : '还没有预设。点下面的「+ 新增一套」，先写一套常用的画面风格。';
        listEl.appendChild(empty);
        return;
      }
      group.presets.forEach((preset, index) => {
        const item = document.createElement('div');
        item.className = 'tail-item';
        item.dataset.id = preset.id;

        const head = document.createElement('div');
        head.className = 'tail-item-head';
        const name = document.createElement('input');
        name.type = 'text';
        name.className = 'tail-name';
        name.maxLength = 40;
        name.placeholder = '这套叫什么，例如「电影感冷调」';
        name.value = preset.name;
        name.addEventListener('input', () => { preset.name = name.value; });
        head.appendChild(name);

        const isDefault = group.defaultId === preset.id;
        const def = document.createElement('button');
        def.type = 'button';
        def.className = 'tail-default' + (isDefault ? ' on' : '');
        def.textContent = isDefault ? '默认' : '设为默认';
        def.title = isDefault
          ? '新建' + TAIL_GROUP_META[tailGroupOf(tailEditingGroup)].label + '卡片会自动选这套'
          : '把这套设为新建' + TAIL_GROUP_META[tailGroupOf(tailEditingGroup)].label + '卡片的默认';
        def.addEventListener('click', () => {
          group.defaultId = isDefault ? '' : preset.id;
          render();
        });
        head.appendChild(def);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'tail-del';
        del.textContent = '删除';
        del.title = '删除这套预设；已经引用它的卡片会提示重新选择';
        del.addEventListener('click', () => {
          group.presets.splice(index, 1);
          if (group.defaultId === preset.id) group.defaultId = group.presets.length ? group.presets[0].id : '';
          render();
        });
        head.appendChild(del);
        item.appendChild(head);

        const text = document.createElement('textarea');
        text.className = 'tail-text';
        text.rows = 5;
        text.maxLength = 20000;
        text.placeholder = '例如：电影级质感，冷蓝色调，柔和体积光，浅景深，镜头缓慢推进，画面稳定，无明显噪点。';
        text.value = preset.text;
        item.appendChild(text);

        const meta = document.createElement('div');
        meta.className = 'tail-item-meta';
        const count = document.createElement('span');
        const paintCount = () => {
          count.textContent = Array.from(text.value).length + ' 字';
        };
        paintCount();
        text.addEventListener('input', () => { preset.text = text.value; paintCount(); });
        meta.appendChild(count);
        item.appendChild(meta);

        listEl.appendChild(item);
      });
    };

    // 切换「视频 / 图片」两组
    tabsEl.addEventListener('click', (event) => {
      const tab = event.target && event.target.closest ? event.target.closest('.tail-tab') : null;
      if (!tab) return;
      tailEditingGroup = tailGroupOf(tab.dataset.group);
      render();
    });

    // 本组开关：只改当前编辑的这一组，另一组原样不动
    if (groupEnabledEl) {
      groupEnabledEl.addEventListener('change', () => {
        const g = tailGroupOf(tailEditingGroup);
        draft.groups[g].enabled = groupEnabledEl.checked;
        paintTabs();
      });
    }

    mask.querySelector('#tail-add').addEventListener('click', () => {
      const group = groupOf();
      const isImage = tailGroupOf(tailEditingGroup) === 'image';
      const preset = {
        id: 'tail_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        // 名字默认带上分组，避免两边出现两个同名「新风格 1」分不清
        name: (isImage ? '图片风格 ' : '新风格 ') + (group.presets.length + 1),
        text: '',
      };
      group.presets.push(preset);
      if (!group.defaultId) group.defaultId = preset.id;
      render();
      const first = listEl.querySelector('.tail-item:last-child .tail-name');
      if (first) first.focus();
    });

    mask.querySelector('#tail-save').addEventListener('click', async () => {
      // 版本不一致时**拦在保存之前**：这时字段名对不上，写下去会把预设清空。
      // 让用户先重启服务，比让他丢一次数据强。
      if (tailSchemaMismatch) {
        flash('服务端还是旧版本，请先重启画布服务再保存（否则会把预设写空）', true);
        return;
      }
      const cleaned = normalizeTailPresets({
        // 顶层 enabled 只作兼容视图（= 视频组），真正的开关在每组里
        enabled: draft.groups.video.enabled !== false,
        groups: {
          video: {
            enabled: draft.groups.video.enabled !== false,
            defaultId: draft.groups.video.defaultId,
            presets: draft.groups.video.presets.map((one) => ({ id: one.id, name: one.name, text: one.text })),
          },
          image: {
            enabled: draft.groups.image.enabled !== false,
            defaultId: draft.groups.image.defaultId,
            presets: draft.groups.image.presets.map((one) => ({ id: one.id, name: one.name, text: one.text })),
          },
        },
      });
      // 只有**两组都空**才拦。只建了视频那组是正常状态（图片可以先不用），
      // 反过来也一样 —— 不能因为另一组没内容就不让保存。
      const anyText = cleaned.groups.video.presets.some((one) => String(one.text).trim()) ||
        cleaned.groups.image.presets.some((one) => String(one.text).trim());
      if (!anyText) {
        flash('至少要有一套写了内容的尾部提示词', true);
        return;
      }
      try {
        await save({ tailPrompts: cleaned });
        flash('已保存', false);
        document.dispatchEvent(new CustomEvent('tail-prompts-changed'));
      } catch (error) {
        flash('保存失败：' + error.message, true);
      }
    });

    mask.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeTailPanel));
    mask.addEventListener('click', (event) => {
      if (event.target === mask) closeTailPanel();
    });
    render();
  }

  window.UITheme = {
    DEFAULTS: DEFAULTS,
    FONT_CHOICES: FONT_CHOICES,
    apply: apply,
    applyStatus: applyStatus,
    load: load,
    save: save,
    openSettings: openSettings,
    current: () => current,
    store: () => store,
    shortcuts: () => shortcuts,
    submitCompress: () => submitCompress,
    tailPrompts: () => tailPrompts,
    cardDefaults: () => cardDefaults,
    openCardDefaultsPanel: openCardDefaultsPanel,
    openTailPromptsPanel: openTailPromptsPanel,
    lan: () => lan,
    assetRoot: () => assetRoot,
  };
})();
