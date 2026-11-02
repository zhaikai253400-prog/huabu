(function () {
  const KINDS = [
    { value: 'all', label: '全部' },
    { value: 'image', label: '图片' },
    { value: 'video', label: '视频' },
    { value: 'audio', label: '音频' },
    { value: 'frame', label: '尾帧' },
  ];
  const SORTS = [
    { value: 'time', label: '按时间（新在前）' },
    { value: 'name', label: '按名字' },
    { value: 'size', label: '按大小（大在前）' },
  ];

  const state = { kind: 'all', q: '', sort: 'time', items: [], stats: null, selected: new Set() };
  let host = null;
  let opts = {};

  // 从素材库往画布拖：自己处理指针，避免浏览器原生拖拽在不同元素上时好时坏
  const drag = {
    card: null,
    item: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    active: false,
    ghost: null,
    overCanvas: false,
    suppressClick: false,
  };
  let dragBound = false;

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB';
    return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function whenText(ms) {
    const time = Number(ms) || 0;
    if (!time) return '';
    const diff = Date.now() - time;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    const date = new Date(time);
    const pad = (value) => String(value).padStart(2, '0');
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function shellHtml() {
    return (
      '<div class="lib-head">' +
      '  <div class="lib-title">素材库 <span class="lib-stats" id="lib-stats"></span></div>' +
      '  <button class="ghost" id="lib-refresh" title="重新读一遍素材目录">刷新</button>' +
      '</div>' +
      '<div class="lib-tools">' +
      '  <div class="lib-kinds" id="lib-kinds"></div>' +
      '  <input type="search" id="lib-q" placeholder="搜名字 / 路径" autocomplete="off" />' +
      '  <select id="lib-sort"></select>' +
      '</div>' +
      '<div class="lib-grid" id="lib-grid"></div>' +
      '<div class="lib-foot">' +
      '  <span class="lib-pick" id="lib-pick">没有选中</span>' +
      '  <span class="grow"></span>' +
      '  <button id="lib-orphan" title="清理没有被任何画布引用的素材">清理孤儿文件</button>' +
      '  <button class="danger" id="lib-delete">删除选中（进回收站）</button>' +
      '</div>'
    );
  }

  function renderKinds() {
    const box = host.querySelector('#lib-kinds');
    box.textContent = '';
    KINDS.forEach((item) => {
      const button = document.createElement('button');
      button.className = 'lib-kind' + (state.kind === item.value ? ' active' : '');
      const count = state.stats && state.stats.byKind ? Number(state.stats.byKind[item.value] || 0) : 0;
      button.textContent = item.label + (item.value === 'all' ? '' : ' ' + count);
      button.addEventListener('click', () => {
        state.kind = item.value;
        reload();
      });
      box.appendChild(button);
    });
  }

  // 指针松开时，判断下面是不是画布。素材库抽屉压在画布上面，落在抽屉上不算。
  function canvasUnder(clientX, clientY) {
    const viewport = document.getElementById('viewport');
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const hit = document.elementFromPoint(clientX, clientY);
    if (hit && !viewport.contains(hit)) return null;
    return viewport;
  }

  function makeGhost(item) {
    const ghost = document.createElement('div');
    ghost.className = 'lib-drag-ghost';
    const thumb = document.createElement('div');
    thumb.className = 'lib-drag-ghost-thumb';
    if (item.kind === 'image' || item.kind === 'frame') {
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = '';
      img.draggable = false;
      thumb.appendChild(img);
    } else if (item.kind === 'video') {
      const video = document.createElement('video');
      video.src = item.url;
      video.muted = true;
      video.preload = 'metadata';
      video.draggable = false;
      thumb.appendChild(video);
    } else {
      const audio = document.createElement('span');
      audio.className = 'lib-drag-ghost-audio';
      audio.textContent = '♪ 音频';
      thumb.appendChild(audio);
    }
    const name = document.createElement('div');
    name.className = 'lib-drag-ghost-name';
    name.textContent = item.name;
    ghost.appendChild(thumb);
    ghost.appendChild(name);
    document.body.appendChild(ghost);
    return ghost;
  }

  function moveGhost(clientX, clientY) {
    if (!drag.ghost) return;
    drag.ghost.style.left = clientX + 'px';
    drag.ghost.style.top = clientY + 'px';
    const viewport = canvasUnder(clientX, clientY);
    drag.overCanvas = Boolean(viewport);
    drag.ghost.classList.toggle('over', drag.overCanvas);
    document.querySelectorAll('.viewport.asset-drop').forEach((el) => {
      if (el !== viewport) el.classList.remove('asset-drop');
    });
    if (viewport) viewport.classList.add('asset-drop');
  }

  function clearDragVisuals() {
    document.querySelectorAll('.viewport.asset-drop').forEach((el) => el.classList.remove('asset-drop'));
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    if (drag.card) drag.card.classList.remove('dragging');
    document.body.classList.remove('lib-dragging');
    drag.card = null;
    drag.item = null;
    drag.pointerId = null;
    drag.active = false;
    drag.ghost = null;
    drag.overCanvas = false;
  }

  function bindDragOnce() {
    if (dragBound) return;
    dragBound = true;
    document.addEventListener(
      'pointermove',
      (event) => {
        if (!drag.card || drag.pointerId !== event.pointerId) return;
        if (!drag.active) {
          const dx = event.clientX - drag.startX;
          const dy = event.clientY - drag.startY;
          if (Math.hypot(dx, dy) < 5) return;
          drag.active = true;
          drag.card.classList.add('dragging');
          drag.ghost = makeGhost(drag.item);
          document.body.classList.add('lib-dragging');
        }
        event.preventDefault();
        moveGhost(event.clientX, event.clientY);
      },
      { passive: false }
    );

    const finish = (event, cancelled) => {
      if (!drag.card || drag.pointerId !== event.pointerId) return;
      const wasActive = drag.active;
      const item = drag.item;
      const target = wasActive && !cancelled ? canvasUnder(event.clientX, event.clientY) : null;
      clearDragVisuals();
      if (!wasActive) return;
      // 拖过之后浏览器还会补一个 click，不能让它再当成“点一下加卡片”
      drag.suppressClick = true;
      setTimeout(() => {
        drag.suppressClick = false;
      }, 120);
      if (target && item && opts.onDrop) {
        opts.onDrop(item, { clientX: event.clientX, clientY: event.clientY });
      }
    };

    document.addEventListener('pointerup', (event) => finish(event, false));
    document.addEventListener('pointercancel', (event) => finish(event, true));
    window.addEventListener('blur', () => {
      if (drag.card) clearDragVisuals();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && drag.card) {
        drag.suppressClick = true;
        clearDragVisuals();
      }
    });
  }

  function beginCardDrag(event, card, item) {
    if (!opts.onDrop || event.button !== 0) return;
    if (event.target.closest && event.target.closest('input, button, a')) return;
    bindDragOnce();
    drag.card = card;
    drag.item = item;
    drag.pointerId = event.pointerId;
    drag.startX = event.clientX;
    drag.startY = event.clientY;
    drag.active = false;
    drag.ghost = null;
    drag.overCanvas = false;
  }

  function cardFor(item) {
    const card = document.createElement('div');
    card.className = 'lib-card';
    card.title = item.relPath + '\n拖到画布上，就能在落点放一张卡片';
    card.draggable = false;
    card.addEventListener('dragstart', (event) => event.preventDefault());
    if (opts.onDrop) card.addEventListener('pointerdown', (event) => beginCardDrag(event, card, item));

    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'lib-check';
    pick.checked = state.selected.has(item.relPath);
    pick.addEventListener('click', (event) => event.stopPropagation());
    pick.addEventListener('change', () => {
      if (pick.checked) state.selected.add(item.relPath);
      else state.selected.delete(item.relPath);
      card.classList.toggle('picked', pick.checked);
      renderFoot();
    });

    const thumb = document.createElement('div');
    thumb.className = 'lib-thumb';
    if (item.kind === 'image' || item.kind === 'frame') {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = item.url;
      img.alt = item.name;
      img.draggable = false;
      thumb.appendChild(img);
    } else if (item.kind === 'video') {
      const video = document.createElement('video');
      video.src = item.url;
      video.muted = true;
      video.preload = 'metadata';
      video.draggable = false;
      thumb.appendChild(video);
      const play = document.createElement('div');
      play.className = 'lib-play';
      play.textContent = '▶';
      thumb.appendChild(play);
    } else {
      const text = document.createElement('div');
      text.className = 'lib-audio';
      text.textContent = '♪ 音频';
      thumb.appendChild(text);
    }

    const meta = document.createElement('div');
    meta.className = 'lib-meta';
    const name = document.createElement('div');
    name.className = 'lib-name';
    name.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'lib-sub';
    sub.textContent = item.folder + ' · ' + formatBytes(item.size) + ' · ' + whenText(item.mtime);
    meta.appendChild(name);
    meta.appendChild(sub);

    card.appendChild(pick);
    card.appendChild(thumb);
    card.appendChild(meta);
    card.classList.toggle('picked', state.selected.has(item.relPath));
    card.addEventListener('click', (event) => {
      if (event.target === pick) return;
      if (drag.suppressClick) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (opts.onPick) opts.onPick(item);
    });
    return card;
  }

  function addItem(item) {
    if (opts.onAdd) opts.onAdd(item);
  }

  function renderGrid() {
    const grid = host.querySelector('#lib-grid');
    grid.textContent = '';
    if (!state.items.length) {
      const empty = document.createElement('div');
      empty.className = 'lib-empty';
      empty.textContent = state.stats && state.stats.count
        ? '这个筛选下没有素材，换一个类型或清空搜索试试。'
        : '素材目录还是空的。生成的图片 / 视频 / 尾帧会自动出现在这里，也可以直接把文件拖进画布。';
      grid.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    state.items.forEach((item) => frag.appendChild(cardFor(item)));
    grid.appendChild(frag);
  }

  function renderStats() {
    const el = host.querySelector('#lib-stats');
    const stats = state.stats || { count: 0, bytes: 0 };
    el.textContent = stats.count + ' 个 · 共 ' + formatBytes(stats.bytes);
  }

  function renderFoot() {
    const el = host.querySelector('#lib-pick');
    const count = state.selected.size;
    el.textContent = count ? '已选中 ' + count + ' 个' : '没有选中';
  }

  async function reload() {
    if (!host) return;
    try {
      const data = await window.api.library({ kind: state.kind, q: state.q, sort: state.sort });
      state.items = data.items || [];
      state.stats = data.stats || null;
      renderKinds();
      renderGrid();
      renderStats();
      renderFoot();
    } catch (error) {
      const grid = host.querySelector('#lib-grid');
      grid.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'lib-empty bad';
      empty.textContent = '读取素材目录失败：' + error.message;
      grid.appendChild(empty);
    }
  }

  // 素材库里的确认框：不用浏览器自带弹窗（那个只会贴在窗口最上面），
  // 改成盖在画布上的自建弹窗，并居中到真正看得见的画布区域。
  function askDialog(options) {
    const config = Object.assign({ title: '请确认', message: '', okText: '确定', cancelText: '取消', info: false }, options || {});
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask canvas-confirm-mask';
      // 右侧素材库抽屉开着时，把弹窗往左让出抽屉的宽度，这样才是画布正中间
      const drawer = document.getElementById('library-drawer');
      if (drawer && !drawer.classList.contains('hidden')) {
        const width = drawer.getBoundingClientRect().width;
        if (width > 0 && width < window.innerWidth * 0.6) mask.style.paddingRight = width + 24 + 'px';
      }

      const dialog = document.createElement('div');
      dialog.className = 'modal confirm-modal';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      const head = document.createElement('div');
      head.className = 'modal-head';
      const title = document.createElement('b');
      title.textContent = config.title;
      head.appendChild(title);

      const body = document.createElement('div');
      body.className = 'modal-body';
      const text = document.createElement('div');
      text.className = 'confirm-text';
      text.textContent = config.message;
      body.appendChild(text);

      const foot = document.createElement('div');
      foot.className = 'modal-foot';
      const grow = document.createElement('span');
      grow.className = 'grow';
      foot.appendChild(grow);

      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        resolve(value);
      };

      if (!config.info) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = config.cancelText;
        cancel.addEventListener('click', () => finish(false));
        foot.appendChild(cancel);
      }
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'primary';
      ok.textContent = config.okText;
      ok.addEventListener('click', () => finish(true));
      foot.appendChild(ok);

      dialog.appendChild(head);
      dialog.appendChild(body);
      dialog.appendChild(foot);
      mask.appendChild(dialog);
      document.body.appendChild(mask);

      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          finish(true);
        }
      };
      document.addEventListener('keydown', onKey, true);
      mask.addEventListener('pointerdown', (event) => event.stopPropagation());
      mask.addEventListener('click', (event) => {
        if (event.target === mask) finish(false);
      });
      setTimeout(() => ok.focus(), 0);
    });
  }

  async function deleteSelected() {
    const list = Array.from(state.selected);
    if (!list.length) {
      await askDialog({
        title: '还没有选中素材',
        message: '先在下面勾选要删的素材，再来点删除。',
        okText: '知道了',
        info: true,
      });
      return;
    }
    const ok = await askDialog({
      title: '删除素材',
      message: '把选中的 ' + list.length + ' 个素材移到回收站吗？\n\n文件不会直接销毁，在 data\\recycle 里还能找回来。',
      okText: '移到回收站',
      cancelText: '取消',
    });
    if (!ok) return;
    try {
      const result = await window.api.libraryDelete(list);
      state.selected.clear();
      await reload();
      if (result.failed && result.failed.length) {
        await askDialog({
          title: '有素材没删掉',
          message: '有 ' + result.failed.length + ' 个没删掉，可能正被别处占用，可以稍后再试。',
          okText: '知道了',
          info: true,
        });
      }
    } catch (error) {
      await askDialog({ title: '删除失败', message: error.message, okText: '知道了', info: true });
    }
  }

  async function cleanOrphans() {
    try {
      const report = await window.api.libraryOrphans();
      const count = report.orphans ? report.orphans.length : 0;
      if (!count) {
        await askDialog({ title: '没有可清理的素材', message: '很干净，没有发现没被引用的素材。', okText: '知道了', info: true });
        return;
      }
      const names = (report.orphans.slice(0, 8).map((item) => item.relPath) || []).join('\n');
      const more = count > 8 ? '\n… 还有 ' + (count - 8) + ' 个' : '';
      const ok = await askDialog({
        title: '清理孤儿文件',
        message: '发现 ' + count + ' 个没有被任何画布引用的素材（共 ' + formatBytes(report.stats.bytes) + '）：\n\n' + names + more + '\n\n把它们移到回收站吗？',
        okText: '移到回收站',
        cancelText: '取消',
      });
      if (!ok) return;
      const result = await window.api.libraryCleanOrphans();
      await reload();
      await askDialog({
        title: '清理完成',
        message: '已清理 ' + result.moved + ' 个文件，都放在 ' + (result.recycle || '回收站目录') + ' 里。',
        okText: '知道了',
        info: true,
      });
    } catch (error) {
      await askDialog({ title: '清理失败', message: error.message, okText: '知道了', info: true });
    }
  }

  function mount(el, options) {
    host = el;
    opts = options || {};
    host.classList.add('lib-panel');
    host.innerHTML = shellHtml();
    const sortEl = host.querySelector('#lib-sort');
    sortEl.innerHTML = SORTS.map((item) => '<option value="' + item.value + '">' + item.label + '</option>').join('');
    sortEl.value = state.sort;
    sortEl.addEventListener('change', () => {
      state.sort = sortEl.value;
      reload();
    });
    const qEl = host.querySelector('#lib-q');
    qEl.value = state.q;
    let timer = null;
    qEl.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        state.q = qEl.value.trim();
        reload();
      }, 250);
    });
    host.querySelector('#lib-refresh').addEventListener('click', reload);
    host.querySelector('#lib-delete').addEventListener('click', deleteSelected);
    host.querySelector('#lib-orphan').addEventListener('click', cleanOrphans);
    reload();
  }

  window.AssetLibrary = {
    mount: mount,
    reload: reload,
    formatBytes: formatBytes,
    selected: () => Array.from(state.selected),
  };
})();
