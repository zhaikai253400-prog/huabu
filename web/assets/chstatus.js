(function () {
  // 小工具从共用模块取（清单 38）。兜底一份等价实现：老页面缓存里可能还没有 utils.js
  const util = window.CanvasUtils || { pad2: (value) => String(value).padStart(2, '0') };
  const pad2 = util.pad2;
  // 画布左侧「通道状态」面板：只读汇总，问平台要余额和班次，不扣次数
  let mask = null;
  let loading = false;

  const KIND_LABEL = { image: '图片', video: '视频', audio: '音频' };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clockText(stamp) {
    const d = new Date(stamp || Date.now());
    if (isNaN(d.getTime())) return '';
    const pad = pad2;
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // 平台只在真的发车以后给的时间才可信；候车时那个时间会滚动，写出来反而误导
  function departText(ride) {
    if (!ride || !ride.departAt) return '';
    const state = String(ride.state || '');
    if (state !== 'running' && state !== 'done') return '';
    const d = new Date(ride.departAt);
    if (isNaN(d.getTime())) return '';
    const pad = pad2;
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return (sameDay ? '' : pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ') +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' 已发车';
  }

  function rideLines(ride) {
    if (!ride) return ['现在没有排班（平台还没开下一班）'];
    const lines = [];
    const state = String(ride.state || '');
    const stateLabel = ride.stateText && ride.stateText !== ride.state ? ride.stateText : state || '状态未知';
    lines.push('班次 ' + (ride.id || '?') + ' · ' + stateLabel);

    const boarded = ride.onboard === null || ride.onboard === undefined ? null : Number(ride.onboard);
    const need = ride.trigger === null || ride.trigger === undefined ? null : Number(ride.trigger);
    const waiting = state === 'open' || state === 'accepting' || state === 'boarded';
    const departed = state === 'running' || state === 'done';

    if (waiting && boarded !== null && need !== null && need > 0) {
      const left = Math.max(0, need - boarded);
      lines.push(
        '已上车 ' + boarded + ' / ' + need + ' 条' + (left > 0 ? '，还差 ' + left + ' 条就发车' : '，够数了马上就发')
      );
      lines.push('攒够一车才走，说不准几点');
    } else if (departed && boarded !== null) {
      lines.push('本班 ' + boarded + ' 条');
      const when = departText(ride);
      if (when) lines.push(when);
      if (need !== null && need > 0) lines.push('下一班凑满 ' + need + ' 条再发');
    } else if (boarded !== null) {
      lines.push('已上车 ' + boarded + ' 条' + (need !== null && need > 0 ? ' / 满 ' + need + ' 条发车' : ''));
    } else if (need !== null && need > 0) {
      lines.push('满 ' + need + ' 条发车');
    }
    return lines;
  }

  function balanceText(balance) {
    if (!balance) return '余额没读出来';
    if (balance.credits === null || balance.credits === undefined) return '余额没认出来（检查取值路径）';
    return '剩余 ' + balance.credits + (balance.unit ? ' ' + balance.unit : '');
  }

  function tasksText(tasks) {
    if (!tasks) return '';
    return (
      '完成 ' + (tasks.done || 0) +
      ' · 失败 ' + (tasks.failed || 0) +
      ' · 进行中 ' + (tasks.running || 0) +
      ' · 排队 ' + (tasks.pending || 0)
    );
  }

  function row(label, value, tone) {
    const line = el('div', 'chstatus-row');
    line.appendChild(el('span', 'chstatus-label', label));
    line.appendChild(el('span', 'chstatus-value' + (tone ? ' ' + tone : ''), value));
    return line;
  }

  function buildCard(channel, stamp) {
    const card = el('div', 'chstatus-card' + (channel.enabled ? '' : ' off'));

    const top = el('div', 'chstatus-top');
    top.appendChild(el('b', 'chstatus-name', channel.name));
    (channel.kinds || []).forEach((kind) => {
      top.appendChild(el('span', 'chstatus-tag', KIND_LABEL[kind] || kind));
    });
    const count = channel.modelCounts && channel.modelCounts.video
      ? channel.modelCounts.video
      : channel.modelCounts && channel.modelCounts.image
        ? channel.modelCounts.image
        : 0;
    if (count) top.appendChild(el('span', 'chstatus-tag', count + ' 个模型'));
    if (!channel.enabled) top.appendChild(el('span', 'chstatus-tag warn', '已停用'));
    top.appendChild(el('span', 'grow'));
    if (stamp) top.appendChild(el('span', 'chstatus-time', clockText(stamp)));
    card.appendChild(top);

    if (channel.notes) card.appendChild(el('div', 'chstatus-notes', channel.notes));

    if (channel.balanceEnabled) {
      if (channel.balance) {
        const tone = channel.balance.credits === null || channel.balance.credits === undefined ? 'warn' : 'ok';
        card.appendChild(row('余额', balanceText(channel.balance), tone));
        if (channel.balance.name) card.appendChild(row('账号', channel.balance.name));
        const t = tasksText(channel.balance.tasks);
        if (t) card.appendChild(row('任务', t));
        if (channel.balance.note) card.appendChild(row('说明', channel.balance.note));
      } else {
        card.appendChild(row('余额', '查询失败：' + (channel.balanceError || '原因不明'), 'bad'));
      }
    }

    if (channel.rideEnabled) {
      if (channel.ride || channel.rideError === '') {
        const lines = rideLines(channel.ride);
        lines.forEach((text, index) => {
          card.appendChild(row(index === 0 ? '班次' : '', text, index === 0 ? 'ok' : ''));
        });
      } else {
        card.appendChild(row('班次', '查询失败：' + (channel.rideError || '原因不明'), 'bad'));
      }
    }

    if (!channel.balanceEnabled && !channel.rideEnabled) {
      card.appendChild(row('状态', '这个通道还没开通余额 / 班次查询（在「接口通道设置」里打开）', 'mute'));
    }
    return card;
  }

  function render(data) {
    if (!mask) return;
    const list = mask.querySelector('#chstatus-list');
    const note = mask.querySelector('#chstatus-note');
    list.textContent = '';
    const items = (data && data.channels) || [];
    if (!items.length) {
      list.appendChild(el('div', 'chstatus-empty', '还没有配置接口通道。在启动器的「接口通道设置」里加一个。'));
      note.textContent = '';
      return;
    }
    const stamp = (data && data.at) || Date.now();
    items.forEach((channel) => list.appendChild(buildCard(channel, stamp)));
    note.textContent = '查询于 ' + clockText(stamp) + ' · 只读，不扣次数';
  }

  async function reload(button) {
    if (!mask || loading) return;
    loading = true;
    const list = mask.querySelector('#chstatus-list');
    const note = mask.querySelector('#chstatus-note');
    if (button) button.disabled = true;
    if (!list.childNodes.length) {
      list.textContent = '';
      list.appendChild(el('div', 'chstatus-empty', '正在问各通道要余额和班次…'));
    }
    note.textContent = '正在查询…';
    try {
      const data = await window.api.channelStatus(true);
      render(data);
    } catch (error) {
      list.textContent = '';
      const box = el('div', 'chstatus-empty bad', '查询失败：' + error.message);
      list.appendChild(box);
      const retry = el('button', 'chstatus-retry', '再试一次');
      retry.addEventListener('click', () => reload(retry));
      list.appendChild(retry);
      note.textContent = '';
    } finally {
      loading = false;
      if (button) button.disabled = false;
    }
  }

  function close() {
    if (!mask) return;
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    mask = null;
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  function open() {
    if (mask) return close();
    mask = el('div', 'chstatus-mask');
    mask.innerHTML =
      '<div class="chstatus-panel" role="dialog" aria-label="通道状态">' +
      '  <div class="chstatus-head">' +
      '    <b>通道状态</b>' +
      '    <span class="chstatus-note" id="chstatus-note"></span>' +
      '    <span class="grow"></span>' +
      '    <button id="chstatus-refresh">刷新</button>' +
      '    <button class="icon-btn" id="chstatus-close" title="关闭（Esc）">×</button>' +
      '  </div>' +
      '  <div class="chstatus-list" id="chstatus-list"></div>' +
      '  <div class="chstatus-foot">余额和班次都是直接问平台要的，只读查询，不扣次数。' +
      '    有班次的通道会显示已上车多少条、还差多少才发车。</div>' +
      '</div>';
    document.body.appendChild(mask);
    mask.querySelector('#chstatus-close').addEventListener('click', close);
    const refreshBtn = mask.querySelector('#chstatus-refresh');
    refreshBtn.addEventListener('click', () => reload(refreshBtn));
    mask.addEventListener('click', (event) => {
      if (event.target === mask) close();
    });
    document.addEventListener('keydown', onKey, true);
    reload(refreshBtn);
  }

  const button = document.getElementById('btn-channel-status');
  if (button) button.addEventListener('click', open);

  window.ChannelStatusPanel = { open: open, close: close };
})();
