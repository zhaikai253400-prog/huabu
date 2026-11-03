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
  // 尾部提示词：每套预设只存名字和正文，卡片只记「用哪一套」
  let tailPrompts = { enabled: true, defaultId: '', presets: [] };

  function normalizeTailPresets(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const list = Array.isArray(raw.presets) ? raw.presets : [];
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
    let defaultId = String(raw.defaultId || '');
    if (defaultId && !presets.some((one) => one.id === defaultId)) defaultId = presets.length ? presets[0].id : '';
    return { enabled: raw.enabled !== false, defaultId: defaultId, presets: presets };
  }

  function cloneTailPrompts(value) {
    return JSON.parse(JSON.stringify(normalizeTailPresets(value)));
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

  function applyStatus(status) {
    if (!status) return;
    apply(status.ui || (status.defaults && status.defaults.ui));
    store = status.store || store;
    if (status.shortcuts) shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, status.shortcuts);
    submitCompress = { enabled: !(status.submitCompress && status.submitCompress.enabled === false) };
    tailPrompts = normalizeTailPresets(status.tailPrompts);
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
    if (patch.assetRoot) body.assetRoot = patch.assetRoot;
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

      '    <div class="set-group"><div class="set-title">素材与归档</div>' +
      '      <div class="set-row"><label>素材根目录</label><input type="text" id="set-asset" spellcheck="false" /></div>' +
      '      <div class="set-row"><label>归档方式</label><select id="set-sub">' + optionsHtml(SUB_CHOICES, store.sub || 'none') + '</select></div>' +
      '      <div class="set-hint">换目录只影响以后新存的文件，旧素材不会搬走也不会丢。归档方式决定生成结果要不要再分一层子文件夹。</div>' +
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

  // ---------- 尾部提示词预设管理 ----------
  // 面板里改的是一份草稿，点保存才写进设置；卡片只引用预设 id，所以删预设后旧卡会明确提示。
  let tailPanelEl = null;

  function closeTailPanel() {
    if (tailPanelEl && tailPanelEl.parentNode) tailPanelEl.parentNode.removeChild(tailPanelEl);
    tailPanelEl = null;
  }

  function openTailPromptsPanel() {
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
      '      <label class="tail-switch"><input type="checkbox" id="tail-enabled" /><span>启用尾部提示词</span></label>' +
      '      <div class="set-hint">关掉后所有卡片都不再追加尾部文字。卡片上自己的开关会保留，下次打开总开关仍然按卡片的选择走。</div>' +
      '    </div>' +
      '    <div class="tail-list" id="tail-list"></div>' +
      '    <div class="tail-add"><button type="button" id="tail-add">+ 新增一套</button>' +
      '      <span class="set-hint">可以按风格预先写好多套，生成前在卡片上勾选即可。</span></div>' +
      '    <div class="tail-preview-note">尾部提示词会自动接在主提示词后面，中间空一行；主提示词里已经含这段文字时不会重复追加。</div>' +
      '  </div>' +
      '  <div class="modal-foot"><span class="set-saved" id="tail-saved"></span><span class="grow"></span>' +
      '    <button class="ghost" data-close>关闭</button>' +
      '    <button class="primary" id="tail-save">保存</button></div>' +
      '</div>';
    document.body.appendChild(mask);
    tailPanelEl = mask;

    const listEl = mask.querySelector('#tail-list');
    const enabledEl = mask.querySelector('#tail-enabled');
    const savedEl = mask.querySelector('#tail-saved');
    enabledEl.checked = draft.enabled;

    const flash = (text, bad) => {
      savedEl.textContent = text;
      savedEl.className = 'set-saved' + (bad ? ' bad' : '');
    };

    const render = () => {
      listEl.textContent = '';
      if (!draft.presets.length) {
        const empty = document.createElement('div');
        empty.className = 'tail-empty';
        empty.textContent = '还没有预设。点下面的「+ 新增一套」，先写一套常用的画面风格。';
        listEl.appendChild(empty);
        return;
      }
      draft.presets.forEach((preset, index) => {
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

        const isDefault = draft.defaultId === preset.id;
        const def = document.createElement('button');
        def.type = 'button';
        def.className = 'tail-default' + (isDefault ? ' on' : '');
        def.textContent = isDefault ? '默认' : '设为默认';
        def.title = isDefault ? '新卡片会自动选这套' : '把这套设为新卡片的默认尾部提示词';
        def.addEventListener('click', () => {
          draft.defaultId = isDefault ? '' : preset.id;
          render();
        });
        head.appendChild(def);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'tail-del';
        del.textContent = '删除';
        del.title = '删除这套预设；已经引用它的卡片会提示重新选择';
        del.addEventListener('click', () => {
          draft.presets.splice(index, 1);
          if (draft.defaultId === preset.id) draft.defaultId = draft.presets.length ? draft.presets[0].id : '';
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

    mask.querySelector('#tail-add').addEventListener('click', () => {
      const preset = {
        id: 'tail_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: '新风格 ' + (draft.presets.length + 1),
        text: '',
      };
      draft.presets.push(preset);
      if (!draft.defaultId) draft.defaultId = preset.id;
      render();
      const first = listEl.querySelector('.tail-item:last-child .tail-name');
      if (first) first.focus();
    });

    mask.querySelector('#tail-save').addEventListener('click', async () => {
      const cleaned = normalizeTailPresets({
        enabled: enabledEl.checked,
        defaultId: draft.defaultId,
        presets: draft.presets.map((one) => ({ id: one.id, name: one.name, text: one.text })),
      });
      if (!cleaned.presets.some((one) => String(one.text).trim())) {
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
    openTailPromptsPanel: openTailPromptsPanel,
    assetRoot: () => assetRoot,
  };
})();
