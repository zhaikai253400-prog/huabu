(function () {
  let mask = null;
  let timer = null;
  let filter = 'all';
  let lastList = [];

  const STATUS = {
    queued: { label: '排队中', tone: 'wait' },
    running: { label: '生成中', tone: 'run' },
    done: { label: '已完成', tone: 'ok' },
    failed: { label: '失败', tone: 'bad' },
    canceled: { label: '已取消', tone: 'mute' },
    interrupted: { label: '已中断', tone: 'mute' },
  };

  const KIND_LABEL = { image: '图片', video: '视频', audio: '音频' };

  const FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'active', label: '进行中' },
    { key: 'done', label: '已完成' },
    { key: 'failed', label: '失败 / 取消' },
  ];

  function close() {
    if (timer) clearInterval(timer);
    timer = null;
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    mask = null;
  }

  function statusOf(task) {
    return STATUS[task.status] || { label: task.status || '未知', tone: 'mute' };
  }

  function isActive(task) {
    return task.status === 'queued' || task.status === 'running';
  }

  function waitedText(ms) {
    const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
    if (total < 60) return total + ' 秒';
    if (total < 3600) return Math.floor(total / 60) + ' 分 ' + (total % 60) + ' 秒';
    return Math.floor(total / 3600) + ' 小时 ' + Math.floor((total % 3600) / 60) + ' 分';
  }

  function whenText(ts) {
    const diff = Date.now() - Number(ts || 0);
    if (!ts) return '未知时间';
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    const date = new Date(Number(ts));
    const pad = (value) => String(value).padStart(2, '0');
    return (
      date.getMonth() + 1 + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    );
  }

  function shortText(value, max) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function visibleTasks() {
    if (filter === 'active') return lastList.filter(isActive);
    if (filter === 'done') return lastList.filter((task) => task.status === 'done');
    if (filter === 'failed') {
      return lastList.filter((task) => task.status === 'failed' || task.status === 'canceled' || task.status === 'interrupted');
    }
    return lastList;
  }

  function buildRow(task, reload) {
    const row = document.createElement('div');
    row.className = 'task-row' + (isActive(task) ? ' active' : '');

    const top = document.createElement('div');
    top.className = 'task-top';

    const kind = document.createElement('span');
    kind.className = 'task-kind';
    kind.textContent = KIND_LABEL[task.kind] || task.kind || '任务';
    top.appendChild(kind);

    const model = document.createElement('span');
    model.className = 'task-model';
    model.textContent = task.model || '（默认模型）';
    top.appendChild(model);

    if (task.channel) {
      const channel = document.createElement('span');
      channel.className = 'muted-line';
      channel.textContent = '通道 ' + task.channel;
      top.appendChild(channel);
    }

    if (task.canvasName) {
      const canvas = document.createElement('span');
      canvas.className = 'muted-line';
      canvas.textContent = '画布 ' + task.canvasName;
      top.appendChild(canvas);
    }

    const status = statusOf(task);
    const badge = document.createElement('span');
    badge.className = 'task-status ' + status.tone;
    badge.textContent = status.label + (isActive(task) && task.stage ? '：' + task.stage : '');
    top.appendChild(badge);

    const grow = document.createElement('span');
    grow.className = 'grow';
    top.appendChild(grow);

    const time = document.createElement('span');
    time.className = 'muted-line';
    time.textContent = isActive(task)
      ? '已等 ' + waitedText(task.waitedMs)
      : (task.updatedAt ? whenText(task.updatedAt) : '') + '（共 ' + waitedText(task.waitedMs) + '）';
    top.appendChild(time);

    row.appendChild(top);

    if (task.prompt) {
      const prompt = document.createElement('div');
      prompt.className = 'task-line';
      prompt.textContent = '提示词：' + shortText(task.prompt, 60);
      row.appendChild(prompt);
    }

    if (task.error) {
      const error = document.createElement('div');
      error.className = 'task-line bad';
      error.textContent = '失败原因：' + shortText(task.error, 120);
      row.appendChild(error);
    }

    const stored = task.resultPath || (task.result && task.result.relPath) || '';
    if (stored) {
      const path = document.createElement('div');
      path.className = 'task-line';
      path.textContent = '已存到：' + stored;
      row.appendChild(path);
    }

    const actions = document.createElement('div');
    actions.className = 'task-actions';

    if (task.canvasExists) {
      const jump = document.createElement('button');
      jump.textContent = '打开所在画布';
      jump.addEventListener('click', () => {
        const query = '?id=' + encodeURIComponent(task.canvasId) + (task.nodeId ? '&node=' + encodeURIComponent(task.nodeId) : '');
        window.location.href = '/canvas' + query;
      });
      actions.appendChild(jump);
    } else if (task.canvasId) {
      const gone = document.createElement('span');
      gone.className = 'muted-line';
      gone.textContent = '这块画布已经删掉了（素材还在 素材 目录里）';
      actions.appendChild(gone);
    }

    if (isActive(task)) {
      const cancel = document.createElement('button');
      cancel.textContent = '取消这次';
      cancel.addEventListener('click', async () => {
        if (!window.confirm('取消这个任务吗？平台那边已经开始跑的话可能还是会扣费。')) return;
        try {
          await window.api.cancelTask(task.id);
          reload();
        } catch (error) {
          window.alert('取消失败：' + error.message);
        }
      });
      actions.appendChild(cancel);
    }

    if (actions.childNodes.length) row.appendChild(actions);
    return row;
  }

  async function reload() {
    if (!mask) return;
    const listBox = mask.querySelector('#task-list');
    const note = mask.querySelector('#task-note');
    try {
      const data = await window.api.tasks(120);
      lastList = data.tasks || [];
      const shown = visibleTasks();
      listBox.textContent = '';
      if (!shown.length) {
        const empty = document.createElement('div');
        empty.className = 'task-empty';
        empty.textContent = lastList.length
          ? '这个筛选下没有任务。'
          : '还没有生成任务。在画布上点「生成」以后，这里会一条条列出来。';
        listBox.appendChild(empty);
      } else {
        shown.forEach((task) => listBox.appendChild(buildRow(task, reload)));
      }
      const activeCount = lastList.filter(isActive).length;
      note.textContent =
        '共 ' + lastList.length + ' 条记录' + (activeCount ? '，其中 ' + activeCount + ' 条正在进行' : '，当前没有在跑的任务');
    } catch (error) {
      listBox.textContent = '读任务失败：' + error.message;
    }
  }

  function renderFilters() {
    const box = mask.querySelector('#task-filters');
    box.textContent = '';
    FILTERS.forEach((item) => {
      const button = document.createElement('button');
      button.className = 'lib-kind' + (filter === item.key ? ' active' : '');
      button.textContent = item.label;
      button.addEventListener('click', () => {
        filter = item.key;
        renderFilters();
        reload();
      });
      box.appendChild(button);
    });
  }

  function open() {
    if (mask) return close();
    mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal modal-task">' +
      '  <div class="modal-head"><b>生成任务</b>' +
      '    <span class="log-note" id="task-note"></span>' +
      '    <span class="grow"></span>' +
      '    <button class="ghost" id="task-close">关闭</button></div>' +
      '  <div class="log-tools">' +
      '    <div class="task-filters" id="task-filters"></div>' +
      '    <span class="grow"></span>' +
      '    <button id="task-refresh">刷新</button>' +
      '    <button id="task-auto">自动刷新：开</button>' +
      '  </div>' +
      '  <div class="task-list" id="task-list"></div>' +
      '  <div class="modal-foot">' +
      '    <span class="set-hint">任务提交后由后台盯着跑，关掉浏览器也照样跑；' +
      '      视频最长会等 6 小时（在通道的「异步接口」里改）。点「打开所在画布」会跳到那张卡片。</span>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(mask);

    const autoBtn = mask.querySelector('#task-auto');
    mask.querySelector('#task-close').addEventListener('click', close);
    mask.querySelector('#task-refresh').addEventListener('click', reload);
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
    renderFilters();
    reload();
    timer = setInterval(reload, 4000);
  }

  window.TaskPanel = { open: open, close: close };
})();
