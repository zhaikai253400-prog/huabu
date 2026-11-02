(function () {
  // 请求失败时把 HTTP 状态带上，调用方才能区分「服务暂时连不上」和「真的没有这条记录」
  function httpError(message, status) {
    const error = new Error(message);
    error.status = Number(status) || 0;
    return error;
  }

  async function request(method, url, body) {
    const options = { method, headers: {} };
    // 通道相关的请求只从本机设置窗口发出，带上启动时写好的临时钥匙
    if (window.__localToken && url.indexOf('/api/channels') === 0) {
      options.headers['x-local-token'] = window.__localToken;
    }
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response = null;
    try {
      response = await fetch(url, options);
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
      throw httpError(message, response.status);
    }
    return data;
  }

  // 本地文件直接传原始字节，不走 JSON
  async function uploadFile(url, file) {
    const response = await fetch(url, { method: 'POST', body: file });
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
    saveSettings: (body) => request('POST', '/api/settings', body),
    logs: (day) => request('GET', '/api/log' + (day ? '?day=' + encodeURIComponent(day) : '')),
    logDownloadUrl: (day) => '/api/log/download?day=' + encodeURIComponent(day || ''),
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
    models: () => request('GET', '/api/models'),
    listChannels: () => request('GET', '/api/channels'),
    saveChannels: (channels) => request('POST', '/api/channels', { channels }),
    probeChannel: (channel) => request('POST', '/api/channels/probe', { channel }),
    channelBalance: (channel) => request('POST', '/api/channels/balance', { channel }),
    channelRide: (channel) => request('POST', '/api/channels/ride', { channel }),
    // 画布左侧「通道状态」面板用：只读汇总，服务端不回传密钥
    channelStatus: (fresh) => request('GET', '/api/channel-status' + (fresh ? '?fresh=1' : '')),
    testChannelImage: (payload) => request('POST', '/api/channels/test-image', payload),
    testChannelVideo: (payload) => request('POST', '/api/channels/test-video', payload),
    preflight: (payload) => request('POST', '/api/preflight', payload),
    generate: (payload) => request('POST', '/api/generate', payload),
    tailFrame: (payload) => request('POST', '/api/tailframe', payload),
    importAsset: (file, kind, canvasId) =>
      uploadFile(
        '/api/assets/import?name=' +
          encodeURIComponent(file.name || '本地素材') +
          '&kind=' + encodeURIComponent(kind || '') +
          (canvasId ? '&canvasId=' + encodeURIComponent(canvasId) : ''),
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
    listCanvases: () => request('GET', '/api/canvases'),
    createCanvas: (name) => request('POST', '/api/canvases', { name }),
    getCanvas: (id) => request('GET', '/api/canvases/' + encodeURIComponent(id)),
    saveCanvas: (id, state) => request('PUT', '/api/canvases/' + encodeURIComponent(id), state),
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
  };
})();
