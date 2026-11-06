(function () {
  // 「检查画布更新」页面（托盘右键菜单 → 打开的就是这里）。
  //
  // 为什么单独开一个页面，而不是在画布标题栏放个按钮：
  //   · 用户一年点不了几次，常驻在画布上只会占地方、还会被误点；
  //   · 它要回答的是「我所有画布里，哪些在别处改过」，本来就不属于某一块画布；
  //   · 只在打开时读一次、关掉就没了，没有轮询、没有后台任务。
  //
  // 数据来源只有两个，都是只读的：
  //   GET /api/canvases        —— 列表 + 每块画布的 rev / 卡片数 / 最后修改时间
  //   localStorage（本机）     —— 这台电脑上次看到这块画布时的 rev
  // 两者一减就是「别处动过几版」。不读 nodes，不发任何写请求。

  const listEl = document.getElementById('update-list');
  const emptyEl = document.getElementById('update-empty');
  const hintEl = document.getElementById('update-hint');
  const refreshBtn = document.getElementById('btn-refresh');
  const openBtn = document.getElementById('btn-open-canvas');

  const Upd = window.CanvasUpdate || null;
  const util = window.CanvasUtils || {};

  // 时间显示：更新页只在检查更新时看一眼，写成「几分钟前 + 具体时刻」最有用。
  function timeText(ts) {
    const n = Number(ts) || 0;
    if (!n) return '未知时间';
    const diff = Date.now() - n;
    if (diff < 0) return util.fullStamp ? util.fullStamp(n) : new Date(n).toLocaleString();
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    const d = new Date(n);
    const pad2 = util.pad2 || ((v) => String(v).padStart(2, '0'));
    return (
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    );
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 落到兜底 */ }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return Boolean(ok);
    } catch {
      return false;
    }
  }

  function openCanvas(id) {
    window.location.href = '/canvas?id=' + encodeURIComponent(id);
  }

  // 一行画布：名字 / 状态 / 版本对照 / 最后修改 / 两个动作
  function buildRow(canvas) {
    const result = Upd
      ? Upd.compare(canvas.id, canvas.rev)
      : { state: 'unknown', seen: null, theirs: Number(canvas.rev) || 0, gap: 0 };

    const row = document.createElement('div');
    row.className = 'update-row';
    row.dataset.state = result.state;

    const main = document.createElement('div');
    main.className = 'update-row-main';

    const title = document.createElement('div');
    title.className = 'update-row-name';
    title.textContent = canvas.name;
    main.appendChild(title);

    const facts = document.createElement('div');
    facts.className = 'update-row-facts';

    const now = document.createElement('span');
    now.className = 'update-fact';
    now.textContent = '服务端第 ' + (Number(canvas.rev) || 0) + ' 版 · ' +
      (Number(canvas.nodeCount) || 0) + ' 张卡片';
    facts.appendChild(now);

    const seen = document.createElement('span');
    seen.className = 'update-fact';
    seen.textContent = result.seen
      ? '这台电脑看过第 ' + result.seen.rev + ' 版（' + timeText(result.seen.at) + '）'
      : '这台电脑还没打开过';
    facts.appendChild(seen);

    const when = document.createElement('span');
    when.className = 'update-fact';
    when.textContent = '最后修改 ' + timeText(canvas.updatedAt);
    facts.appendChild(when);

    const idLine = document.createElement('button');
    idLine.type = 'button';
    idLine.className = 'update-id';
    idLine.textContent = canvas.id;
    idLine.title = '点一下复制画布 ID（另一台电脑用它直接打开）';
    idLine.addEventListener('click', async () => {
      const ok = await copyText(canvas.id);
      idLine.textContent = ok ? '已复制 ' + canvas.id : canvas.id;
      setTimeout(() => { idLine.textContent = canvas.id; }, 1400);
    });
    facts.appendChild(idLine);

    main.appendChild(facts);

    const badge = document.createElement('span');
    badge.className = 'update-badge';
    badge.textContent = Upd ? Upd.describe(result) : '还不清楚';

    const actions = document.createElement('div');
    actions.className = 'update-row-actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'primary';
    open.textContent = '打开';
    open.addEventListener('click', () => openCanvas(canvas.id));
    actions.appendChild(open);

    row.appendChild(main);
    row.appendChild(badge);
    row.appendChild(actions);
    return row;
  }

  async function refresh() {
    if (hintEl) hintEl.textContent = '正在读取…';
    if (refreshBtn) refreshBtn.disabled = true;
    try {
      const data = await window.api.listCanvases();
      const list = (data && data.canvases) || [];
      // 有新版本的排前面：这个页面的用途就是找它们，别的都是背景
      const scored = list.map((canvas) => ({
        canvas: canvas,
        result: Upd ? Upd.compare(canvas.id, canvas.rev) : { state: 'unknown', gap: 0 },
      }));
      const weight = { new: 0, never: 1, same: 2, unknown: 3 };
      scored.sort((a, b) => {
        const wa = weight[a.result.state] === undefined ? 3 : weight[a.result.state];
        const wb = weight[b.result.state] === undefined ? 3 : weight[b.result.state];
        if (wa !== wb) return wa - wb;
        return (Number(b.canvas.updatedAt) || 0) - (Number(a.canvas.updatedAt) || 0);
      });

      listEl.textContent = '';
      scored.forEach((one) => listEl.appendChild(buildRow(one.canvas)));
      emptyEl.classList.toggle('hidden', scored.length > 0);

      const news = scored.filter((one) => one.result.state === 'new');
      const nevers = scored.filter((one) => one.result.state === 'never');
      if (!scored.length) {
        hintEl.textContent = '还没有画布';
      } else if (news.length) {
        hintEl.textContent = '有 ' + news.length + ' 块画布在别处改过';
        hintEl.className = 'hint warn';
      } else if (nevers.length) {
        hintEl.textContent = '没有发现新版本（' + nevers.length + ' 块这台电脑还没打开过）';
        hintEl.className = 'hint';
      } else {
        hintEl.textContent = '全部是最新的';
        hintEl.className = 'hint ok';
      }
    } catch (error) {
      hintEl.textContent = '读取失败：' + ((error && error.message) || '本机服务没回应');
      hintEl.className = 'hint warn';
      listEl.textContent = '';
      emptyEl.classList.add('hidden');
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  if (refreshBtn) refreshBtn.addEventListener('click', refresh);
  if (openBtn) openBtn.addEventListener('click', () => { window.location.href = '/'; });

  // 主题跟着画布页的设置走：从画布页跳过来时不至于突然变白
  const ready = window.UITheme && window.UITheme.load ? window.UITheme.load() : Promise.resolve();
  ready.then(refresh).catch(refresh);
})();
