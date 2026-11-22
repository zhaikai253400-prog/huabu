(function () {
  // 本机服务现在要求每个接口请求都带钥匙（挡跨站请求和别的本机程序）。
  // 页面打开时服务端会把钥匙注进 window：普通页面是 __uiToken，通道设置窗口是 __localToken。
  // 这里集中处理，页面里各处 fetch 就不用一个个改。
  function localToken() {
    return window.__localToken || window.__uiToken || '';
  }

  function withToken(url, headers) {
    const token = localToken();
    if (!token) return headers;
    // 只给本机接口加，静态资源和外部地址不动
    if (url.indexOf('/api/') !== 0) return headers;
    headers['x-local-token'] = token;
    return headers;
  }

  // 请求失败时把 HTTP 状态带上，调用方才能区分「服务暂时连不上」和「真的没有这条记录」
  // payload 是服务端回的原始响应体：409 冲突时要用里面的最新状态，不能只留一句话
  // 服务重启后钥匙会换新，手上这把就过期了。这里就地重取一把：
  // 页面 HTML 本来就是服务端注入钥匙发下来的，再要一份即可（同源请求，守卫放行）。
  // 只做一次、且有 5 秒节流，避免某次真的没有权限时打成死循环。
  let refreshing = null;
  let refreshedAt = 0;
  function refreshToken() {
    if (refreshing) return refreshing;
    if (Date.now() - refreshedAt < 5000) return Promise.resolve(false);
    // 通道设置页要的是管理钥匙，而且只有那一页能拿到；
    // 其余页面各自重取自己那一份（门户页不要跑去取画布页，省的画布页多担一条路径）
    const here = location.pathname.replace(/\.html$/, '');
    const isAdminPage = window.__localToken !== undefined || here === '/channels';
    const page = isAdminPage ? '/channels' : here === '/launcher' || here === '/' ? here : '/canvas';
    refreshing = fetch(page, { headers: { 'Cache-Control': 'no-cache' } })
      .then((res) => (res.ok ? res.text() : ''))
      .then((html) => {
        const ui = /window\.__uiToken = '([0-9a-f]+)'/.exec(html);
        const admin = /window\.__localToken = '([0-9a-f]+)'/.exec(html);
        if (!ui && !admin) return false;
        // 页面是哪一种就换哪一种：通道页只换管理钥匙，普通页只换页面钥匙
        if (window.__localToken !== undefined) {
          if (!admin) return false;
          window.__localToken = admin[1];
        } else {
          if (!ui) return false;
          window.__uiToken = ui[1];
        }
        refreshedAt = Date.now();
        return true;
      })
      .catch(() => false)
      .then((ok) => {
        refreshing = null;
        return ok;
      });
    return refreshing;
  }

  async function request(method, url, body) {
    const options = { method, headers: withToken(url, {}) };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response = null;
    try {
      response = await fetch(url, options);
      // 401 基本只有一个原因：服务重启过，钥匙换新了。换一把再试一次，
      // 用户正在画的这块画布就不用刷新页面（刷新会打断手上的操作）。
      if (response.status === 401 && (await refreshToken())) {
        // 要把 body 一起带上：PUT / POST 丢了 body 就等于把画布存空了
        response = await fetch(url, {
          method,
          headers: withToken(url, Object.assign({}, options.headers)),
          body: options.body,
        });
      }
    } catch (error) {
      // 服务正在重启 / 本机端口还没接上时，fetch 会直接抛出来；标成 0 交给调用方重试
      throw httpError((error && error.message) || '本机服务暂时连不上', 0);
    }
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!response.ok) {
      const message = (data && (data.error || data.raw)) || '请求失败（' + response.status + '）';
      throw httpError(message, response.status, data);
    }
    return data;
  }
  // 共享的实时事件流。
  //
  // 为什么不用 EventSource：它没法带自定义请求头，而本机接口都要求 x-local-token。
  // 本机页面开共享时 EventSource 会被守卫 401 掉，共享等于连不上。
  // 把钥匙拼进查询串能绕过去，但钥匙会留在历史记录 / Referer 里，不做。
  // 所以这里用 fetch + ReadableStream 自己解析 SSE：能带请求头，断线也能自己重连。
  //
  // 对外保持 EventSource 的用法（addEventListener / onerror / close / readyState），
  // 画布那边一行都不用改。
  function openEventStream(url, options) {
    const opt = options || {};
    const listeners = new Map();
    const stream = {
      readyState: 0, // 0 = 连接中，1 = 已连上，2 = 已关闭（不再重连）
      onerror: null,
      onopen: null,
      addEventListener(name, fn) {
        const key = String(name);
        if (!listeners.has(key)) listeners.set(key, []);
        listeners.get(key).push(fn);
      },
      removeEventListener(name, fn) {
        const list = listeners.get(String(name)) || [];
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      },
      close() {
        closed = true;
        stream.readyState = 2;
        if (controller) {
          try {
            controller.abort();
          } catch {
            /* 已经断了 */
          }
        }
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = 0;
        }
      },
    };

    let closed = false;
    let controller = null;
    let retryTimer = 0;
    let attempt = 0;
    // 4xx 里这几种是「再试也没用」：人满了 / 没共享 / 画布没了
    const FATAL = [400, 403, 404, 409, 429];

    function emit(name, payload) {
      const list = listeners.get(name);
      if (!list || !list.length) return;
      const event = { type: name, data: payload };
      list.slice().forEach((fn) => {
        try {
          fn(event);
        } catch (error) {
          console.error('事件处理出错：' + name, error);
        }
      });
    }

    function fail(status, message) {
      stream.readyState = 2;
      if (stream.onerror) stream.onerror(httpError(message, status));
    }

    function scheduleRetry() {
      if (closed) return;
      attempt += 1;
      // 1s、2s、4s…最多 8s：别把服务重启时的空转打成风暴
      const wait = Math.min(8000, 1000 * Math.pow(2, attempt - 1));
      retryTimer = setTimeout(() => {
        retryTimer = 0;
        connect();
      }, wait);
    }

    // 按 SSE 规范解析：空行结束一条事件，data: 多行用换行拼起来
    function makeParser(onEvent) {
      let buffer = '';
      let name = '';
      let data = [];
      return (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          let line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line) {
            if (data.length) onEvent(name || 'message', data.join('\n'));
            name = '';
            data = [];
          } else if (line.charAt(0) === ':') {
            // 注释行（心跳）
          } else {
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            let value = colon < 0 ? '' : line.slice(colon + 1);
            if (value.charAt(0) === ' ') value = value.slice(1);
            if (field === 'event') name = value;
            else if (field === 'data') data.push(value);
          }
          index = buffer.indexOf('\n');
        }
      };
    }

    async function connect() {
      if (closed) return;
      stream.readyState = 0;
      controller = new AbortController();
      const headers = withToken(url, { Accept: 'text/event-stream' });
      // 本机走 withToken；局域网访客手里没有钥匙，withToken 原样返回，服务端按共享白名单放行
      let response = null;
      try {
        response = await fetch(url, { headers, cache: 'no-store', signal: controller.signal });
      } catch (error) {
        if (closed) return;
        if (stream.onerror) stream.onerror(httpError((error && error.message) || '连接中断', 0));
        scheduleRetry();
        return;
      }
      if (response.status === 401 && (await refreshToken())) {
        try {
          response = await fetch(url, { headers: withToken(url, { Accept: 'text/event-stream' }), cache: 'no-store', signal: controller.signal });
        } catch (error) {
          if (closed) return;
          scheduleRetry();
          return;
        }
      }
      if (!response.ok) {
        let message = '连接共享失败（' + response.status + '）';
        try {
          const text = await response.text();
          const data = JSON.parse(text);
          if (data && data.error) message = data.error;
        } catch {
          /* 用默认文案 */
        }
        if (FATAL.indexOf(response.status) >= 0) {
          fail(response.status, message);
          return;
        }
        if (stream.onerror) stream.onerror(httpError(message, response.status));
        scheduleRetry();
        return;
      }
      if (!response.body) {
        // 极老的浏览器没有流式响应体：退化成「连上了但收不到事件」，比静默假死好
        fail(0, '这个浏览器不支持实时同步');
        return;
      }
      attempt = 0;
      stream.readyState = 1;
      if (stream.onopen) stream.onopen();
      const parse = makeParser((name, payload) => emit(name, payload));
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          parse(decoder.decode(chunk.value, { stream: true }));
        }
      } catch (error) {
        if (closed) return;
      }
      if (closed) return;
      // 服务端正常收了连接（共享被关 / 服务重启）：稍等一下再连，
      // 是共享被关的话下一次会拿到 403，由 FATAL 分支收尾
      stream.readyState = 0;
      if (stream.onerror) stream.onerror(httpError('实时连接已断开', 0));
      scheduleRetry();
    }

    connect();
    return stream;
  }

  function httpError(message, status, payload) {
    const error = new Error(message);
    error.status = Number(status) || 0;
    if (payload) error.data = payload;
    return error;
  }



  // 本地文件直接传原始字节，不走 JSON
  async function uploadFile(url, file) {
    const response = await fetch(url, { method: 'POST', body: file, headers: withToken(url, {}) });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!response.ok) {
      const message = (data && (data.error || data.raw)) || '上传失败（' + response.status + '）';
      throw httpError(message, response.status);
    }
    return data;
  }

  window.api = {
    status: () => request('GET', '/api/status'),
    // 库出过状况时会带 notice 回来，页面据此显示告警条
    health: () => request('GET', '/api/health'),
    healthAck: () => request('POST', '/api/health/ack', {}),
    saveSettings: (body) => request('POST', '/api/settings', body),
    logs: (day) => request('GET', '/api/log' + (day ? '?day=' + encodeURIComponent(day) : '')),
    // 下载是浏览器直接跳转（window.location.href），带不了请求头，只能把钥匙拼在查询串上
    logDownloadUrl: (day) =>
      '/api/log/download?day=' + encodeURIComponent(day || '') +
      (localToken() ? '&token=' + encodeURIComponent(localToken()) : ''),
    library: (opts) => {
      const options = opts || {};
      const parts = [];
      if (options.kind) parts.push('kind=' + encodeURIComponent(options.kind));
      if (options.q) parts.push('q=' + encodeURIComponent(options.q));
      if (options.sort) parts.push('sort=' + encodeURIComponent(options.sort));
      return request('GET', '/api/library' + (parts.length ? '?' + parts.join('&') : ''));
    },
    libraryDelete: (relPaths) => request('POST', '/api/library/delete', { relPaths }),
    libraryOrphans: () => request('GET', '/api/library/orphans'),
    libraryCleanOrphans: () => request('POST', '/api/library/orphans/clean', {}),
    // 回收站：删掉的素材只是挪进 data\recycle，还能列出来摆回去
    recycleList: () => request('GET', '/api/library/recycle'),
    recycleRestore: (batchId, items) => request('POST', '/api/library/recycle', { batchId, items }),
    models: () => request('GET', '/api/models'),
    listChannels: () => request('GET', '/api/channels'),
    saveChannels: (channels) => request('POST', '/api/channels', { channels }),
    probeChannel: (channel) => request('POST', '/api/channels/probe', { channel }),
    // 导入 / 导出：带密钥导出必须由服务端解密后再给（磁盘上是 DPAPI 密文，拷走解不开）
    exportChannels: (withKeys, onlyIds) =>
      request('GET', '/api/channels/export?keys=' + (withKeys === false ? '0' : '1') +
        (Array.isArray(onlyIds) && onlyIds.length ? '&ids=' + encodeURIComponent(onlyIds.join(',')) : '')),
    previewImportChannels: (text) => request('POST', '/api/channels/import/preview', { text }),
    importChannels: (text, mode) => request('POST', '/api/channels/import', { text, mode }),
    channelBalance: (channel) => request('POST', '/api/channels/balance', { channel }),
    channelRide: (channel) => request('POST', '/api/channels/ride', { channel }),
    // 画布左侧「通道状态」面板用：只读汇总，服务端不回传密钥
    channelStatus: (fresh) => request('GET', '/api/channel-status' + (fresh ? '?fresh=1' : '')),
    testChannelImage: (payload) => request('POST', '/api/channels/test-image', payload),
    // 试传：只验图床收不收这类素材，不产生生成费用
    testChannelUpload: (payload) => request('POST', '/api/channels/test-upload', payload),
    testChannelVideo: (payload) => request('POST', '/api/channels/test-video', payload),
    preflight: (payload) => request('POST', '/api/preflight', payload),
    generate: (payload) => request('POST', '/api/generate', payload),
    tailFrame: (payload) => request('POST', '/api/tailframe', payload),
    // 取尾段：后 N 秒整段截出来，给下一段视频当衔接参考
    tailClip: (payload) => request('POST', '/api/tailclip', payload),
    // mode 决定碰到重复文件时怎么办：
    //   'ask'（默认）—— 先不落盘，回 duplicate 让用户挑
    //   'reuse'      —— 直接用已有素材，不复制
    //   'copy'       —— 不管重复，照样存一份新的
    importAsset: (file, kind, canvasId, mode) =>
      uploadFile(
        '/api/assets/import?name=' +
          encodeURIComponent(file.name || '本地素材') +
          '&kind=' + encodeURIComponent(kind || '') +
          (canvasId ? '&canvasId=' + encodeURIComponent(canvasId) : '') +
          '&dup=' + encodeURIComponent(mode || 'ask'),
        file
      ),
    task: (id) => request('GET', '/api/tasks/' + encodeURIComponent(id)),
    // opts: { canvasId, active } —— 画布页用它在后台核对「这块画布上还在跑的任务」
    tasks: (limit, opts) => {
      const o = opts || {};
      const q = [];
      if (limit) q.push('limit=' + encodeURIComponent(limit));
      if (o.canvasId) q.push('canvasId=' + encodeURIComponent(o.canvasId));
      if (o.active) q.push('active=1');
      return request('GET', '/api/tasks' + (q.length ? '?' + q.join('&') : ''));
    },
    cancelTask: (id) => request('POST', '/api/tasks/' + encodeURIComponent(id) + '/cancel', {}),
    // 平台已经出片、本地却判了失败的任务：拿原来的任务号回去再取一次结果，
    // 不会重新提交、不会重复扣费
    resumeTask: (id) => request('POST', '/api/tasks/' + encodeURIComponent(id) + '/resume', {}),
    listCanvases: () => request('GET', '/api/canvases'),
    createCanvas: (name) => request('POST', '/api/canvases', { name }),
    getCanvas: (id) => request('GET', '/api/canvases/' + encodeURIComponent(id)),
    // 只读版本号（rev / 最后修改时间 / 卡片数），不拉整份画布内容。
    // 「检查更新」拿它和服务端比一次，几十字节的事。
    canvasMeta: (id) => request('GET', '/api/canvases/' + encodeURIComponent(id) + '/meta'),
    // rev 是乐观锁：把读画布时拿到的版本号带回去，对不上说明别人改过，
    // 服务端会回 409，调用方据此去问用户怎么办（见 canvas.js 的保存冲突处理）
    saveCanvas: (id, state, rev) => {
      const payload = rev === undefined || rev === null ? state : Object.assign({}, state, { rev: rev });
      return request('PUT', '/api/canvases/' + encodeURIComponent(id), payload);
    },
    renameCanvas: (id, name) => request('PATCH', '/api/canvases/' + encodeURIComponent(id), { name }),
    duplicateCanvas: (id) => request('POST', '/api/canvases/' + encodeURIComponent(id) + '/duplicate', {}),
    deleteCanvas: (id) => request('DELETE', '/api/canvases/' + encodeURIComponent(id)),
    exportCanvas: (id) => request('GET', '/api/canvases/' + encodeURIComponent(id) + '/export'),
    importCanvas: (payload) => request('POST', '/api/canvases/import', payload),
    backups: (id) => request('GET', '/api/canvases/' + encodeURIComponent(id) + '/backups'),
    // 定时生成组：运行状态在本地后台，浏览器关掉也会继续跑
    schedules: (canvasId) => request('GET', '/api/schedules?canvasId=' + encodeURIComponent(canvasId)),
    schedule: (nodeId) => request('GET', '/api/schedules/' + encodeURIComponent(nodeId)),
    startSchedule: (nodeId, body) =>
      request('POST', '/api/schedules/' + encodeURIComponent(nodeId) + '/start', body || {}),
    pauseSchedule: (nodeId) => request('POST', '/api/schedules/' + encodeURIComponent(nodeId) + '/pause', {}),
    stopSchedule: (nodeId) => request('POST', '/api/schedules/' + encodeURIComponent(nodeId) + '/stop', {}),
    forgetSchedule: (nodeId) => request('DELETE', '/api/schedules/' + encodeURIComponent(nodeId)),
    restoreBackup: (id, name) =>
      request('POST', '/api/canvases/' + encodeURIComponent(id) + '/backups/restore', { name }),
    // 导出素材：先弹系统窗口选目录，再把选中的目录交给服务端复制
    exportPickDir: () => request('POST', '/api/export/pick-dir', {}),
    exportAssets: (items, destDir) => request('POST', '/api/export/assets', { items: items, destDir: destDir }),
    // 关页面时「最后一道保险」用：keepalive 请求带不了自定义头也没关系，
    // 这里显式把钥匙塞进去，服务端才认
    saveCanvasOnLeave: (id, state) =>
      fetch('/api/canvases/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: withToken('/api/canvases/', { 'Content-Type': 'application/json' }),
        body: JSON.stringify(state),
        keepalive: true,
      }).catch(() => {}),
    // 批量操作前手动留个档：一口气改很多卡片，改坏了能整块退回来
    snapshotCanvas: (id, label) =>
      request('POST', '/api/canvases/' + encodeURIComponent(id) + '/backups/snapshot', { label }),
    // 程序代码同步（托盘 →「同步程序代码…」）：只搬 web/server/tools/runtime 等程序文件，
    // 画布库与素材库永远不走这里。plan 只读，pull 才写盘。
    // ---- 共享工作区 ----
    // 局域网那台电脑拿不到本页的本机钥匙（钥匙只注入本机打开的页面），
    // 注释里说的 `none` 级接口正好不带钥匙，所以这些请求在协作者那边也能通。
    shareList: () => request('GET', '/api/share/list'),
    shareToggle: (id, on) =>
      request('POST', '/api/canvases/' + encodeURIComponent(id) + '/share', { on: Boolean(on) }),
    shareState: (id) => request('GET', '/api/share/' + encodeURIComponent(id) + '/state'),
    sharePresence: (id) => request('GET', '/api/share/' + encodeURIComponent(id) + '/presence'),
    // 增量保存：只带我改过的卡片。别人改的那些一个字都不用发，服务端也不会碰。
    sharePatch: (id, payload) =>
      request('POST', '/api/share/' + encodeURIComponent(id) + '/patch', payload),
    // 关页面时的最后一推：keepalive 请求同样带不了自定义头，但共享接口本来就不要钥匙
    sharePatchOnLeave: (id, payload) =>
      fetch('/api/share/' + encodeURIComponent(id) + '/patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {}),
    // 实时事件流。自己实现的 fetch 版 SSE：能带钥匙请求头，断线按 1s→8s 退避重连。
    // clientId 是页面自己生成并存在 sessionStorage 里的随机串：
    // 刷新页面后它不变，服务端据此把旧连接顶掉、沿用原来的名字，
    // 不会因为「旧连接还没关」而把自己挤成第二个人。
    shareEvents: (id, clientId) => {
      const q = clientId ? '?client=' + encodeURIComponent(clientId) : '';
      // 不用 EventSource：它带不了钥匙请求头，本机页面会被守卫 401 掉
      return openEventStream('/api/share/' + encodeURIComponent(id) + '/events' + q);
    },
    codesyncPlan: (host) => request('GET', '/api/codesync/plan?host=' + encodeURIComponent(host)),
    codesyncPull: (host) => request('POST', '/api/codesync/pull', { host }),
  };
})();
