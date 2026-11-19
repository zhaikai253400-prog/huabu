(function () {
  // 小工具从共用模块取（清单 38）。兜底一份等价实现：老页面缓存里可能还没有 utils.js
  const util = window.CanvasUtils || { pad2: (value) => String(value).padStart(2, '0') };
  const pad2 = util.pad2;
  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const chipsEl = document.getElementById('chips');
  const countEl = document.getElementById('count-label');
  const inputEl = document.getElementById('new-name');
  const createBtn = document.getElementById('btn-create');
  const loadingEl = document.getElementById('loading');
  const importInput = document.getElementById('import-file');
  const toolsHint = document.getElementById('tools-hint');
  const alertEl = document.getElementById('alert-bar');
  // 局域网访客打开页面时服务端注入的是空钥匙（见 serveHtmlWithTokens）：
  // 他们能用共享画布，但不能开关共享 —— 那是主机的权力。
  const isGuest = !window.__uiToken;

  // 统一的转义，凡是把服务端文本塞进 innerHTML 的地方都过一遍
  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"]/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    })[c]);
  }

  // 复制文本。navigator.clipboard 只在安全上下文（https / localhost）里可用，
  // 有些环境（无头浏览器、被策略禁掉）拿不到，所以要有一层兜底，
  // 否则用户点「复制」只看到失败，还得自己去路径那一行手选。
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* 落到下面的兜底 */
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      // 放到视口外，避免页面跳动
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

  // 库打不开、被挪走、重建过 —— 这件事必须让用户看见。
  // 以前只写进控制台，用户打开页面只看到「画布都没了」，会以为数据丢了。
  async function loadHealth() {
    if (!alertEl) return;
    let data = null;
    try {
      data = await window.api.health();
    } catch {
      // 老版本服务端没有这个接口，静默跳过，不影响门户页其他功能
      return;
    }
    const notice = data && data.notice;
    if (!notice) {
      alertEl.classList.add('hidden');
      alertEl.textContent = '';
      return;
    }
    const when = whenText(notice.at);
    const reason = notice.reason || '未知原因';
    alertEl.textContent = '';
    const head = document.createElement('div');
    head.className = 'alert-head';
    head.textContent = '⚠ 数据库异常，已重建空库（' + when + '）';
    const body = document.createElement('div');
    body.className = 'alert-body';
    body.textContent = '原因：' + reason + '。重建后的库是空的，但旧数据没有删——';
    const pathLine = document.createElement('div');
    pathLine.className = 'alert-path';
    pathLine.textContent = notice.oldDir
      ? '旧数据库已完整保存在：' + notice.oldDir
      : '旧数据库已挪到回收站目录：' + (data.dataDir || '') + '\\recycle\\db-broken-*';
    const actions = document.createElement('div');
    actions.className = 'alert-actions';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制旧库路径';
    copyBtn.addEventListener('click', async () => {
      const text = notice.oldDir || (data.dataDir || '') + '\\recycle';
      const ok = await copyText(text);
      copyBtn.textContent = ok ? '已复制' : '复制失败，请手动选中上面的路径';
    });
    const ackBtn = document.createElement('button');
    ackBtn.className = 'ghost';
    ackBtn.textContent = '我知道了';
    ackBtn.addEventListener('click', async () => {
      try {
        await window.api.healthAck();
      } catch {
        /* 清不掉也不影响本次隐藏，下次还会提示 */
      }
      alertEl.classList.add('hidden');
      alertEl.textContent = '';
    });
    actions.appendChild(copyBtn);
    actions.appendChild(ackBtn);
    body.appendChild(pathLine);
    alertEl.appendChild(head);
    alertEl.appendChild(body);
    alertEl.appendChild(actions);
    alertEl.classList.remove('hidden');
  }

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

  // 历史版本分两类：
  //   recent —— 改动后隔几分钟自动存一份，只留最近 10 份（「刚才手滑了」用）
  //   daily  —— 每天留一份，保留 30 天（「昨天还好好的」用）
  // 另外「删除前 / 回滚前 / 批量前」这些关键动作也会强制留一份，同样落在 recent 里。
  async function openBackups(canvas) {
    let list = [];
    try {
      const data = await window.api.backups(canvas.id);
      list = data.backups || [];
    } catch (error) {
      window.alert('读历史版本失败：' + error.message);
      return;
    }
    const rowOf = (item) =>
      '<div class="backup-row"><span>' + escapeHtml(item.label) + '</span>' +
      '<span class="muted-line">' + sizeText(item.bytes) + '</span>' +
      '<button data-name="' + escapeHtml(item.name) + '">回滚到这里</button></div>';
    const recent = list.filter((one) => one.kind !== 'daily');
    const daily = list.filter((one) => one.kind === 'daily');
    let rows = '';
    if (recent.length) {
      rows += '<div class="backup-group-title">最近改动</div>' + recent.map(rowOf).join('');
    }
    if (daily.length) {
      rows += '<div class="backup-group-title">每日留存（保留 30 天）</div>' + daily.map(rowOf).join('');
    }
    if (!recent.length && !daily.length) {
      rows = '<div class="muted-line">还没有历史版本。画布改动后每隔几分钟自动存一份，最多留 10 份；每天还会另外留一份长期备份。删除画布、回滚历史版本、批量操作前也会强制留一份。</div>';
    }
    openModal(
      '<div class="modal modal-narrow"><div class="modal-head"><b>「' + canvas.name + '」的历史版本</b>' +
        '<span class="grow"></span><button class="ghost" data-close>关闭</button></div>' +
        '<div class="modal-body">' + rows + '</div></div>',
      (mask) => {
        mask.querySelectorAll('[data-name]').forEach((button) => {
          button.addEventListener('click', async () => {
            const name = button.getAttribute('data-name');
            if (!window.confirm('把画布回滚到 ' + name + ' 这一版吗？当前内容会被这一版覆盖。\n（覆盖前会自动把当前版本也留一份，回滚错了还能再退回来）')) return;
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
    const pad = pad2;
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

  // 共享地址：/api/status 里已经算好了本机网卡地址和实际端口，
  // 这里只负责拼成一条能直接发给别人的 URL。
  async function shareUrlOf(id) {
    try {
      const status = await window.api.status();
      const lan = (status && status.lan) || {};
      if (!lan.enabled) return '';
      const ip = (lan.addresses || [])[0];
      if (!ip) return '';
      return 'http://' + ip + ':' + lan.port + '/canvas?id=' + encodeURIComponent(id);
    } catch {
      return '';
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
        if (canvas.shared) {
          const badge = document.createElement('span');
          badge.className = 'canvas-share-badge';
          badge.textContent = '共享中';
          badge.title = '这块画布正对同一局域网开放，最多 3 人一起编辑';
          thumb.appendChild(badge);
        }

        const meta = document.createElement('div');
        meta.className = 'canvas-meta';
        const name = document.createElement('div');
        name.className = 'canvas-name';
        name.textContent = canvas.name;
        if (canvas.shared) {
          const tag = document.createElement('span');
          tag.className = 'canvas-share-badge';
          tag.textContent = '共享中';
          name.appendChild(tag);
        }
        const sub = document.createElement('div');
        sub.className = 'canvas-sub';
        sub.textContent = '最后修改：' + whenText(canvas.updatedAt);

        // 画布 ID：另一台电脑直接打开 /canvas?id=xxx 就能进同一块画布，
        // 不用在列表里翻。点一下复制完整值。
        const idRow = document.createElement('div');
        idRow.className = 'canvas-id-row';
        const idTag = document.createElement('span');
        idTag.className = 'canvas-id-tag';
        idTag.textContent = canvas.id;
        idTag.title = '画布 ID（点一下复制）';
        const idCopy = document.createElement('button');
        idCopy.type = 'button';
        idCopy.className = 'canvas-id-copy';
        idCopy.textContent = '复制 ID';
        const copyId = async (event) => {
          if (event) event.stopPropagation();
          const ok = await copyText(canvas.id);
          idCopy.textContent = ok ? '已复制' : '复制失败';
          setTimeout(() => {
            idCopy.textContent = '复制 ID';
          }, 1400);
        };
        idTag.addEventListener('click', copyId);
        idCopy.addEventListener('click', copyId);
        idRow.appendChild(idTag);
        idRow.appendChild(idCopy);

        const actions = document.createElement('div');
        actions.className = 'canvas-actions';
        // 参数顺序固定为 (文案, 样式类, 处理函数, 悬停提示)。
        // 之前把提示和函数传反了，字符串被当成处理函数，点一下就抛
        // "handler is not a function"，这里用形参名 + 单测把顺序钉死。
        const makeButton = (label, className, handler, hint) => {
          if (typeof handler !== 'function') {
            throw new TypeError('makeButton: 第 3 个参数必须是处理函数，实际收到 ' + typeof handler);
          }
          const button = document.createElement('button');
          button.type = 'button';
          button.className = className || '';
          button.textContent = label;
          if (hint) button.title = hint;
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            handler();
          });
          return button;
        };
        // 按钮排版：原来是 7 个按钮平铺一行，卡片最窄只有 250px，每个被挤到 34px 宽，
        // 中文就竖过来了（一字一行、72px 高）。现在「打开画布」独占一整行，
        // 其余按三列网格铺开，所有文案都能横排。
        actions.appendChild(makeButton('打开画布', 'primary wide', () => openCanvas(canvas.id), '进入这块画布'));
        actions.appendChild(
          makeButton('重命名', '', async () => {
            const next = window.prompt('新的画布名字', canvas.name);
            if (next === null) return;
            if (!next.trim()) return;
            await window.api.renameCanvas(canvas.id, next.trim());
            refresh();
          }, '改画布名字')
        );
        actions.appendChild(
          makeButton('复制', '', async () => {
            await window.api.duplicateCanvas(canvas.id);
            refresh();
          }, '复制一份同样的画布')
        );
        actions.appendChild(
          makeButton('导出', '', async () => {
            try {
              const payload = await window.api.exportCanvas(canvas.id);
              downloadJson('画布-' + canvas.name + '.json', payload);
            } catch (error) {
              window.alert('导出失败：' + error.message);
            }
          }, '导出成 JSON 备份文件')
        );
        if (!isGuest) {
          actions.appendChild(
            makeButton(canvas.shared ? '已共享' : '共享', canvas.shared ? 'shared-on' : '', async () => {
              try {
                await window.api.shareToggle(canvas.id, !canvas.shared);
                if (!canvas.shared) {
                  // 刚开共享：把局域网地址直接摆出来，省得用户自己拼
                  const address = await shareUrlOf(canvas.id);
                  if (address) {
                    const ok = await copyText(address);
                    window.alert(
                      '已开启共享（最多 3 人同时编辑）。\n\n把下面这个地址发给同一局域网的人：\n' +
                        address +
                        (ok ? '\n\n（已复制到剪贴板）' : '')
                    );
                  } else {
                    window.alert('已开启共享（最多 3 人同时编辑）。\n\n先在「显示与设置」里打开局域网访问，才能把地址给别的电脑。');
                  }
                }
                refresh();
              } catch (error) {
                window.alert((canvas.shared ? '关闭共享' : '开启共享') + '失败：' + error.message);
              }
            }, canvas.shared ? '已开启共享，点一下关闭' : '开启局域网共享（最多 3 人同时编辑）')
          );
        }
        actions.appendChild(makeButton('历史', '', () => openBackups(canvas), '查看并回滚历史版本'));
        actions.appendChild(
          makeButton('删除', 'danger', async () => {
            if (!window.confirm('确定删除画布“' + canvas.name + '”吗？')) return;
            await window.api.deleteCanvas(canvas.id);
            refresh();
          }, '删掉这块画布')
        );

        meta.appendChild(name);
        meta.appendChild(sub);
        meta.appendChild(idRow);
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
  loadHealth();

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
