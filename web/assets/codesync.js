(function () {
  // 「同步程序代码」页面（托盘右键 → 同步程序代码…）。
  //
  // 这里只做两台电脑之间的单向拉取：另一台（主机）开着局域网共享程序代码，
  // 这台电脑填上它的地址，对比 -> 拉取。画布和素材库各自一份，永远不参与传输。
  //
  // 三个动作严格分层：
  //   对比（GET /api/codesync/plan）—— 只读，什么都不写；
  //   同步（POST /api/codesync/pull）—— 只写白名单里的程序文件，覆盖前先备份；
  //   重启（用户自己点托盘）—— 页面不碰进程。
  // 所以「点了同步才知道会改什么」这件事不存在：必须先对比，才允许同步。

  const HOST_KEY = 'canvas.codesync.host.v1';

  const hostEl = document.getElementById('sync-host');
  const hintEl = document.getElementById('sync-hint');
  const checkBtn = document.getElementById('btn-check');
  const pullBtn = document.getElementById('btn-pull');
  const saveHostBtn = document.getElementById('btn-save-host');
  const resultEl = document.getElementById('sync-result');
  const statsEl = document.getElementById('sync-stats');
  const groupsEl = document.getElementById('sync-groups');
  const emptyEl = document.getElementById('sync-empty');
  const restartEl = document.getElementById('sync-restart');
  const restartHowBtn = document.getElementById('btn-restart-tip');
  const restartHowEl = document.getElementById('sync-restart-how');

  let lastPlan = null;
  let busy = false;

  function readHost() {
    try {
      return String(window.localStorage.getItem(HOST_KEY) || '');
    } catch {
      return '';
    }
  }
  function writeHost(value) {
    try {
      window.localStorage.setItem(HOST_KEY, String(value || ''));
      return true;
    } catch {
      return false;
    }
  }

  function setHint(text, kind) {
    if (!hintEl) return;
    hintEl.textContent = text;
    hintEl.className = 'hint' + (kind ? ' ' + kind : '');
  }

  function sizeText(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function setBusy(on, label) {
    busy = on;
    checkBtn.disabled = on;
    pullBtn.disabled = on || !lastPlan || (!lastPlan.add.length && !lastPlan.update.length);
    if (saveHostBtn) saveHostBtn.disabled = on;
    if (on && label) setHint(label);
  }

  // 一组文件明细：标题 + 条数 + （默认收起时只显示前 12 条）
  function group(title, list, kind) {
    if (!list.length) return null;
    const box = document.createElement('div');
    box.className = 'sync-group';
    const head = document.createElement('div');
    head.className = 'sync-group-head';
    head.textContent = title + '（' + list.length + '）';
    box.appendChild(head);

    const ul = document.createElement('div');
    ul.className = 'sync-file-list';
    list.slice(0, 200).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'sync-file' + (kind ? ' ' + kind : '');
      const name = document.createElement('code');
      name.textContent = typeof item === 'string' ? item : item.path;
      row.appendChild(name);
      if (typeof item === 'object' && item.size !== undefined) {
        const size = document.createElement('span');
        size.className = 'sync-file-size';
        size.textContent = sizeText(item.size);
        row.appendChild(size);
      }
      ul.appendChild(row);
    });
    if (list.length > 200) {
      const more = document.createElement('div');
      more.className = 'sync-file-more';
      more.textContent = '还有 ' + (list.length - 200) + ' 个，省略显示';
      ul.appendChild(more);
    }
    box.appendChild(ul);
    return box;
  }

  function renderPlan(report) {
    lastPlan = report;
    resultEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
    statsEl.textContent = '';
    groupsEl.textContent = '';

    const total = report.add.length + report.update.length;
    const stat = (label, value, kind) => {
      const one = document.createElement('div');
      one.className = 'sync-stat' + (kind ? ' ' + kind : '');
      const num = document.createElement('b');
      num.textContent = String(value);
      const cap = document.createElement('span');
      cap.textContent = label;
      one.appendChild(num);
      one.appendChild(cap);
      statsEl.appendChild(one);
    };
    stat('新增', report.add.length, report.add.length ? 'add' : '');
    stat('更新', report.update.length, report.update.length ? 'update' : '');
    stat('已一致', report.same, '');
    stat('对方文件', report.remote.count, '');

    const blocks = [
      group('新增', report.add, 'add'),
      group('更新', report.update, 'update'),
      group('这台电脑多出来的（不会删）', report.extra, 'extra'),
    ].filter(Boolean);
    blocks.forEach((one) => groupsEl.appendChild(one));
    if (!blocks.length) {
      const ok = document.createElement('div');
      ok.className = 'sync-allgood';
      ok.textContent = '两边程序文件一致，不需要同步。';
      groupsEl.appendChild(ok);
    }

    if (!total) {
      setHint('已经是最新的（对方 ' + report.remote.count + ' 个程序文件）', 'ok');
    } else {
      setHint('会新增 ' + report.add.length + ' 个、更新 ' + report.update.length + ' 个文件', 'warn');
    }
    setBusy(false);
  }

  async function check() {
    if (busy) return;
    const host = hostEl.value.trim();
    if (!host) {
      setHint('先填另一台电脑的地址', 'warn');
      hostEl.focus();
      return;
    }
    writeHost(host);
    lastPlan = null;
    pullBtn.disabled = true;
    restartEl.classList.add('hidden');
    setBusy(true, '正在读取对方清单…');
    try {
      const report = await window.api.codesyncPlan(host);
      renderPlan(report);
    } catch (error) {
      setBusy(false);
      setHint('对比失败：' + ((error && error.message) || '对方没有响应'), 'warn');
      resultEl.classList.add('hidden');
      emptyEl.classList.remove('hidden');
    }
  }

  async function pull() {
    if (busy || !lastPlan) return;
    const total = lastPlan.add.length + lastPlan.update.length;
    if (!total) return;
    const yes = window.confirm(
      '将把 ' + total + ' 个程序文件写进这台电脑：\n' +
      '  ' + lastPlan.host + '\n\n' +
      '不会动画布、素材库和通道密钥，覆盖前会先备份到 data\\codesync-backup。\n' +
      '继续吗？'
    );
    if (!yes) return;

    setBusy(true, '正在同步，请稍等…');
    resultEl.classList.add('hidden');
    try {
      const report = await window.api.codesyncPull(lastPlan.host);
      lastPlan = null;
      resultEl.classList.remove('hidden');
      emptyEl.classList.add('hidden');
      statsEl.textContent = '';
      groupsEl.textContent = '';

      const stat = (label, value, kind) => {
        const one = document.createElement('div');
        one.className = 'sync-stat' + (kind ? ' ' + kind : '');
        const num = document.createElement('b');
        num.textContent = String(value);
        const cap = document.createElement('span');
        cap.textContent = label;
        one.appendChild(num);
        one.appendChild(cap);
        statsEl.appendChild(one);
      };
      stat('已更新', report.updated.length, report.updated.length ? 'update' : '');
      stat('已新增', report.added.length, report.added.length ? 'add' : '');
      stat('失败', report.failed.length, report.failed.length ? 'warn' : '');
      stat('跳过', report.skipped.length, '');

      const blocks = [
        group('已更新', report.updated, 'update'),
        group('已新增', report.added, 'add'),
        group('失败', report.failed.map((one) => ({ path: one.path, size: 0 })), 'warn'),
        group('这台电脑多出来的（保留不动）', report.skipped, 'extra'),
      ].filter(Boolean);
      blocks.forEach((one) => groupsEl.appendChild(one));

      if (report.failed.length) {
        const why = document.createElement('div');
        why.className = 'sync-note warn';
        why.textContent =
          '有 ' + report.failed.length + ' 个文件没写成功：' +
          (report.failed[0].reason || '') +
          '。最常见的原因是程序还开着、文件被占用 —— 右键托盘「退出（停止画布服务）」后再点一次同步。';
        groupsEl.appendChild(why);
      }

      setHint(
        '完成：更新 ' + report.updated.length + '，新增 ' + report.added.length +
          (report.failed.length ? '，失败 ' + report.failed.length : ''),
        report.failed.length ? 'warn' : 'ok'
      );
      restartEl.classList.toggle('hidden', !report.needRestart);
      if (report.backupDir) {
        const note = document.createElement('div');
        note.className = 'sync-note';
        note.textContent = '老文件已备份到：' + report.backupDir;
        groupsEl.appendChild(note);
      }
    } catch (error) {
      setHint('同步失败：' + ((error && error.message) || '未知原因'), 'warn');
    } finally {
      setBusy(false);
      pullBtn.disabled = true;
    }
  }

  // 主题跟着画布设置走：不至于从画布跳过来时突然变白
  if (window.UITheme && window.UITheme.load) window.UITheme.load().catch(function () {});

  if (hostEl) hostEl.value = readHost();
  checkBtn.addEventListener('click', check);
  pullBtn.addEventListener('click', pull);
  if (saveHostBtn) {
    saveHostBtn.addEventListener('click', () => {
      const ok = writeHost(hostEl.value.trim());
      saveHostBtn.textContent = ok ? '已记住' : '没记住';
      setTimeout(() => {
        saveHostBtn.textContent = '记住';
      }, 1400);
    });
  }
  if (hostEl) {
    hostEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        check();
      }
    });
  }
  if (restartHowBtn) {
    restartHowBtn.addEventListener('click', () => restartHowEl.classList.toggle('hidden'));
  }

  const ready = window.UITheme && window.UITheme.load ? window.UITheme.load() : Promise.resolve();
  ready.catch(() => {});
})();
