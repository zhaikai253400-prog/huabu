(function () {
  let mask = null;
  let timer = null;
  let currentDay = '';

  function close() {
    if (timer) clearInterval(timer);
    timer = null;
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    mask = null;
  }

  function renderLines(box, data) {
    box.textContent = '';
    const lines = data.lines || [];
    if (!lines.length) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = '这一天还没有日志。';
      box.appendChild(empty);
      return;
    }
    box.textContent = lines.join('\n');
  }

  // 缩略图生成失败：卡片会静默回退到原图，不单独列出来用户只会觉得「怎么这么卡」。
  // 这里单独一块，把「哪张素材、为什么、失败了几次」摆清楚。
  function renderThumbFailures(box, list) {
    const items = list || [];
    box.textContent = '';
    if (!items.length) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const head = document.createElement('div');
    head.className = 'thumb-fail-head';
    head.textContent =
      '缩略图生成失败 ' + items.length + ' 条（这些卡片会直接加载原图，所以打开时会偏卡）';
    box.appendChild(head);
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'thumb-fail-row';
      const file = document.createElement('span');
      file.className = 'thumb-fail-file';
      file.textContent = item.relPath || '(未知素材)';
      file.title = item.relPath || '';
      const reason = document.createElement('span');
      reason.className = 'thumb-fail-reason';
      reason.textContent = item.reason || '';
      reason.title = item.reason || '';
      const meta = document.createElement('span');
      meta.className = 'thumb-fail-meta';
      const when = item.at ? new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      meta.textContent = (item.count > 1 ? '×' + item.count + ' · ' : '') + when;
      row.appendChild(file);
      row.appendChild(reason);
      row.appendChild(meta);
      box.appendChild(row);
    });
  }

  async function reload() {
    if (!mask) return;
    const select = mask.querySelector('#log-day');
    const box = mask.querySelector('#log-body');
    const failBox = mask.querySelector('#log-thumb-fails');
    const day = select.value;
    currentDay = day;
    try {
      const data = await window.api.logs(day);
      if (data.days && data.days.length) {
        const keep = select.value;
        select.innerHTML = data.days
          .map((item) => '<option value="' + item + '">' + item + '</option>')
          .join('');
        select.value = keep && data.days.indexOf(keep) >= 0 ? keep : data.days[0];
      }
      renderThumbFailures(failBox, data.thumbFailures);
      renderLines(box, data);
      const failCount = (data.thumbFailures || []).length;
      mask.querySelector('#log-note').textContent =
        '共 ' + (data.lines || []).length + ' 行' +
        (failCount ? '，缩略图失败 ' + failCount + ' 条' : '') +
        (data.live ? '（运行时那几行）' : '');
    } catch (error) {
      box.textContent = '读日志失败：' + error.message;
    }
  }

  function open() {
    if (mask) return close();
    mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal modal-log">' +
      '  <div class="modal-head"><b>运行日志</b>' +
      '    <span class="log-note" id="log-note"></span>' +
      '    <span class="grow"></span>' +
      '    <button class="ghost" id="log-close">关闭</button></div>' +
      '  <div class="log-tools">' +
      '    <select id="log-day"></select>' +
      '    <button id="log-refresh">刷新</button>' +
      '    <button id="log-auto">自动刷新：开</button>' +
      '    <button id="log-export">导出这一天</button>' +
      '    <span class="grow"></span>' +
      '    <span class="set-hint">日志文件在 data\\logs 里，按天分文件</span>' +
      '  </div>' +
      '  <pre class="log-body" id="log-body"></pre>' +
      '  <div class="thumb-fail-panel hidden" id="log-thumb-fails"></div>' +
      '</div>';
    document.body.appendChild(mask);

    const select = mask.querySelector('#log-day');
    const autoBtn = mask.querySelector('#log-auto');
    select.innerHTML = '<option value="">读取中…</option>';
    select.addEventListener('change', reload);
    mask.querySelector('#log-refresh').addEventListener('click', reload);
    mask.querySelector('#log-close').addEventListener('click', close);
    mask.querySelector('#log-export').addEventListener('click', () => {
      const day = select.value;
      if (!day) return;
      // 直接跳转带不了请求头，钥匙只能拼在查询串上（服务端只对 GET 接受这种形式）
      window.location.href = window.api.logDownloadUrl(day);
    });
    autoBtn.addEventListener('click', () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        autoBtn.textContent = '自动刷新：关';
      } else {
        timer = setInterval(reload, 4000);
        autoBtn.textContent = '自动刷新：开';
      }
    });
    mask.addEventListener('click', (event) => {
      if (event.target === mask) close();
    });
    reload();
    timer = setInterval(reload, 4000);
  }

  window.LogViewer = { open: open, close: close };
})();
