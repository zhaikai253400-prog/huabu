(function () {
  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const chipsEl = document.getElementById('chips');
  const countEl = document.getElementById('count-label');
  const inputEl = document.getElementById('new-name');
  const createBtn = document.getElementById('btn-create');
  const loadingEl = document.getElementById('loading');
  const importInput = document.getElementById('import-file');
  const toolsHint = document.getElementById('tools-hint');

  function openModal(html, onReady) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = html;
    document.body.appendChild(mask);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) mask.remove();
    });
    const closeBtn = mask.querySelector('[data-close]');
    if (closeBtn) closeBtn.addEventListener('click', () => mask.remove());
    if (onReady) onReady(mask, () => mask.remove());
    return mask;
  }

  // 画布名字里可能有 : / * 这类字符，直接当文件名会让系统存不下来，先换掉
  function safeFileName(name) {
    return String(name || '画布').replace(/[\\/:*?"<>|]/g, '_').trim() || '画布';
  }

  function downloadJson(name, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safeFileName(name);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  // 备份文件往往很小，直接四舍五入到 KB 会显示成 0 KB，这里小文件按字节显示
  function sizeText(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return size + ' 字节';
    return Math.round(size / 1024) + ' KB';
  }

  // 历史版本：自动备份每 5 分钟存一次，只留最近 10 份
  async function openBackups(canvas) {
    let list = [];
    try {
      const data = await window.api.backups(canvas.id);
      list = data.backups || [];
    } catch (error) {
      window.alert('读历史版本失败：' + error.message);
      return;
    }
    const rows = list.length
      ? list
          .map(
            (item) =>
              '<div class="backup-row"><span>' + item.label + '</span>' +
              '<span class="muted-line">' + sizeText(item.bytes) + '</span>' +
              '<button data-name="' + item.name + '">回滚到这里</button></div>'
          )
          .join('')
      : '<div class="muted-line">还没有历史版本。画布改动后每隔几分钟自动存一份，最多留 10 份。</div>';
    openModal(
      '<div class="modal modal-narrow"><div class="modal-head"><b>「' + canvas.name + '」的历史版本</b>' +
        '<span class="grow"></span><button class="ghost" data-close>关闭</button></div>' +
        '<div class="modal-body">' + rows + '</div></div>',
      (mask) => {
        mask.querySelectorAll('[data-name]').forEach((button) => {
          button.addEventListener('click', async () => {
            const name = button.getAttribute('data-name');
            if (!window.confirm('把画布回滚到 ' + name + ' 这一版吗？当前内容会被这一版覆盖。')) return;
            try {
              await window.api.restoreBackup(canvas.id, name);
              mask.remove();
              refresh();
            } catch (error) {
              window.alert('回滚失败：' + error.message);
            }
          });
        });
      }
    );
  }

  function shortPath(value) {
    if (!value) return '-';
    return value.length > 32 ? '…' + value.slice(-30) : value;
  }

  function whenText(ts) {
    const diff = Date.now() - Number(ts || 0);
    if (!ts) return '未知时间';
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    const date = new Date(Number(ts));
    const pad = (value) => String(value).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function chip(label, value, tone) {
    const el = document.createElement('div');
    el.className = 'chip' + (tone ? ' ' + tone : '');
    el.innerHTML = label + '：<b></b>';
    el.querySelector('b').textContent = value;
    return el;
  }

  let channelCount = 0;

  async function loadStatus() {
    try {
      const status = await window.api.status();
      channelCount = status.channels || 0;
      chipsEl.textContent = '';
      chipsEl.appendChild(chip('服务端口', String(status.port)));
      chipsEl.appendChild(chip('画布数量', String(status.stats.canvases)));
      chipsEl.appendChild(chip('素材目录', shortPath(status.assetRoot), status.writable ? 'ok' : 'warn'));
      chipsEl.appendChild(
        chip('尾帧工具', status.tools.ffmpeg ? '已就绪' : '未安装（暂用近似提取）', status.tools.ffmpeg ? 'ok' : 'warn')
      );
      chipsEl.appendChild(chip('接口通道', channelCount + ' 个', channelCount ? 'ok' : 'warn'));
      const bad = (status.checks || []).filter((item) => !item.ok);
      toolsHint.textContent = bad.length
        ? '有 ' + bad.length + ' 项要留意：' + bad.map((item) => item.label).join('、') + '（点「显示与设置」看详情）'
        : '一切就绪，字体、缩放、素材目录都在「显示与设置」里调。';
      toolsHint.className = bad.length ? 'hint warn' : 'hint';
    } catch (error) {
      chipsEl.textContent = '';
      chipsEl.appendChild(chip('服务状态', '读取失败：' + error.message, 'warn'));
    }
  }

  function openCanvas(id) {
    window.location.href = '/canvas?id=' + encodeURIComponent(id);
  }

  async function refresh() {
    loadingEl.classList.remove('hidden');
    try {
      const data = await window.api.listCanvases();
      const list = data.canvases || [];
      countEl.textContent = list.length ? '共 ' + list.length + ' 块' : '';
      emptyEl.style.display = list.length ? 'none' : 'block';
      listEl.textContent = '';
      for (const canvas of list) {
        const card = document.createElement('div');
        card.className = 'canvas-card';

        const thumb = document.createElement('div');
        thumb.className = 'canvas-thumb';
        thumb.textContent = canvas.nodeCount ? '卡片 ' + canvas.nodeCount + ' 个' : '空白画布';

        const meta = document.createElement('div');
        meta.className = 'canvas-meta';
        const name = document.createElement('div');
        name.className = 'canvas-name';
        name.textContent = canvas.name;
        const sub = document.createElement('div');
        sub.className = 'canvas-sub';
        sub.textContent = '最后修改：' + whenText(canvas.updatedAt);

        const actions = document.createElement('div');
        actions.className = 'canvas-actions';
        const makeButton = (label, className, handler) => {
          const button = document.createElement('button');
          button.className = className || '';
          button.textContent = label;
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            handler();
          });
          return button;
        };
        actions.appendChild(makeButton('打开', 'primary', () => openCanvas(canvas.id)));
        actions.appendChild(
          makeButton('重命名', '', async () => {
            const next = window.prompt('新的画布名字', canvas.name);
            if (next === null) return;
            if (!next.trim()) return;
            await window.api.renameCanvas(canvas.id, next.trim());
            refresh();
          })
        );
        actions.appendChild(
          makeButton('复制一份', '', async () => {
            await window.api.duplicateCanvas(canvas.id);
            refresh();
          })
        );
        actions.appendChild(
          makeButton('导出备份', '', async () => {
            try {
              const payload = await window.api.exportCanvas(canvas.id);
              downloadJson('画布-' + canvas.name + '.json', payload);
            } catch (error) {
              window.alert('导出失败：' + error.message);
            }
          })
        );
        actions.appendChild(makeButton('历史版本', '', () => openBackups(canvas)));
        actions.appendChild(
          makeButton('删除', 'danger', async () => {
            if (!window.confirm('确定删除画布“' + canvas.name + '”吗？')) return;
            await window.api.deleteCanvas(canvas.id);
            refresh();
          })
        );

        meta.appendChild(name);
        meta.appendChild(sub);
        meta.appendChild(actions);
        card.appendChild(thumb);
        card.appendChild(meta);
        card.addEventListener('click', () => openCanvas(canvas.id));
        listEl.appendChild(card);
      }
    } catch (error) {
      listEl.textContent = '';
      emptyEl.style.display = 'block';
      emptyEl.textContent = '读取失败：' + error.message;
    } finally {
      loadingEl.classList.add('hidden');
    }
  }

  async function create() {
    const name = inputEl.value.trim();
    if (!name) {
      inputEl.focus();
      inputEl.placeholder = '先输入画布名字，例如：第1集';
      return;
    }
    createBtn.disabled = true;
    createBtn.textContent = '正在创建…';
    try {
      const created = await window.api.createCanvas(name);
      openCanvas(created.canvas.id);
    } catch (error) {
      window.alert('创建失败：' + error.message);
      createBtn.disabled = false;
      createBtn.textContent = '创建并进入';
    }
  }

  createBtn.addEventListener('click', create);
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') create();
  });

  loadStatus();
  refresh();

  document.getElementById('btn-settings').addEventListener('click', () => {
    if (window.UITheme) window.UITheme.openSettings();
  });
  document.getElementById('btn-logs').addEventListener('click', () => {
    if (window.LogViewer) window.LogViewer.open();
  });
  document.getElementById('btn-tasks').addEventListener('click', () => {
    if (window.TaskPanel) window.TaskPanel.open();
  });
  document.getElementById('btn-library').addEventListener('click', () => {
    const mask = openModal(
      '<div class="modal modal-library"><div class="modal-head"><b>素材库</b>' +
        '<span class="grow"></span><button class="ghost" data-close>关闭</button></div>' +
        '<div class="modal-body"><div id="portal-lib"></div></div></div>'
    );
    window.AssetLibrary.mount(mask.querySelector('#portal-lib'), { draggable: false });
  });
  document.getElementById('btn-import').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const result = await window.api.importCanvas(payload);
      await refresh();
      await loadStatus();
      if (window.confirm('已导入「' + result.canvas.name + '」（' + result.nodeCount + ' 个卡片），现在打开吗？')) {
        openCanvas(result.canvas.id);
      }
    } catch (error) {
      window.alert('导入失败：' + (error.message || '这个文件不是画布备份'));
    }
  });
  if (window.UITheme) window.UITheme.load();

  setTimeout(() => inputEl.focus(), 150);
})();
