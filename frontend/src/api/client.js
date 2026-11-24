function uiToken() {
  return window.__uiToken || '';
}
function adminToken() {
  return window.__localToken || window.__adminToken || '';
}
function sessionToken() {
  return localStorage.getItem('adminSession') || window.__adminSession || '';
}

function withToken(url, headers, preferAdmin) {
  const h = { ...headers };
  if (!url.startsWith('/api/')) return h;
  const token = preferAdmin ? adminToken() || uiToken() : uiToken() || adminToken();
  if (token) h['x-local-token'] = token;
  const session = sessionToken();
  if (session) h['x-admin-session'] = session;
  return h;
}

async function refreshTokens() {
  try {
    const res = await fetch('/', { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return false;
    const html = await res.text();
    const ui = /window\.__uiToken = '([0-9a-f]+)'/.exec(html);
    const admin = /window\.__localToken = '([0-9a-f]+)'/.exec(html);
    if (ui) window.__uiToken = ui[1];
    if (admin) window.__localToken = admin[1];
    return Boolean(ui || admin);
  } catch {
    return false;
  }
}

function httpError(message, status, data) {
  const err = new Error(message);
  err.status = Number(status) || 0;
  if (data) err.data = data;
  return err;
}

async function request(method, url, body, opts = {}) {
  const options = {
    method,
    headers: withToken(url, {}, opts.preferAdmin),
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, options);
    if (response.status === 401 && (await refreshTokens())) {
      response = await fetch(url, {
        method,
        headers: withToken(url, { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, opts.preferAdmin),
        body: options.body,
      });
    }
  } catch (e) {
    throw httpError(e.message || '本机服务暂时连不上', 0);
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
    throw httpError((data && (data.error || data.raw)) || `请求失败（${response.status}）`, response.status, data);
  }
  return data;
}

async function uploadFile(url, file) {
  const response = await fetch(url, {
    method: 'POST',
    body: file,
    headers: withToken(url, {}),
  });
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
    throw httpError((data && (data.error || data.raw)) || `上传失败（${response.status}）`, response.status, data);
  }
  return data;
}

export const api = {
  status: () => request('GET', '/api/status'),
  health: () => request('GET', '/api/health'),
  healthAck: () => request('POST', '/api/health/ack', {}),
  saveSettings: (body) => request('POST', '/api/settings', body),
  logs: (day) => request('GET', '/api/log' + (day ? `?day=${encodeURIComponent(day)}` : '')),
  logDownloadUrl: (day) =>
    `/api/log/download?day=${encodeURIComponent(day || '')}${uiToken() ? `&token=${encodeURIComponent(uiToken())}` : ''}`,
  library: (opts = {}) => {
    const parts = [];
    if (opts.kind) parts.push(`kind=${encodeURIComponent(opts.kind)}`);
    if (opts.q) parts.push(`q=${encodeURIComponent(opts.q)}`);
    if (opts.sort) parts.push(`sort=${encodeURIComponent(opts.sort)}`);
    return request('GET', '/api/library' + (parts.length ? `?${parts.join('&')}` : ''));
  },
  libraryDelete: (relPaths) => request('POST', '/api/library/delete', { relPaths }),
  libraryOrphans: () => request('GET', '/api/library/orphans'),
  libraryCleanOrphans: () => request('POST', '/api/library/orphans/clean', {}),
  recycleList: () => request('GET', '/api/library/recycle'),
  recycleRestore: (batchId, items) => request('POST', '/api/library/recycle', { batchId, items }),
  models: () => request('GET', '/api/models'),
  listChannels: () => request('GET', '/api/channels', undefined, { preferAdmin: true }),
  saveChannels: (channels) => request('POST', '/api/channels', { channels }, { preferAdmin: true }),
  probeChannel: (channel) => request('POST', '/api/channels/probe', { channel }, { preferAdmin: true }),
  exportChannels: (withKeys, onlyIds) =>
    request(
      'GET',
      `/api/channels/export?keys=${withKeys === false ? '0' : '1'}${
        Array.isArray(onlyIds) && onlyIds.length ? `&ids=${encodeURIComponent(onlyIds.join(','))}` : ''
      }`,
      undefined,
      { preferAdmin: true }
    ),
  previewImportChannels: (text) => request('POST', '/api/channels/import/preview', { text }, { preferAdmin: true }),
  importChannels: (text, mode) => request('POST', '/api/channels/import', { text, mode }, { preferAdmin: true }),
  channelBalance: (channel) => request('POST', '/api/channels/balance', { channel }, { preferAdmin: true }),
  channelRide: (channel) => request('POST', '/api/channels/ride', { channel }, { preferAdmin: true }),
  channelStatus: (fresh) => request('GET', `/api/channel-status${fresh ? '?fresh=1' : ''}`),
  testChannelImage: (payload) => request('POST', '/api/channels/test-image', payload, { preferAdmin: true }),
  testChannelUpload: (payload) => request('POST', '/api/channels/test-upload', payload, { preferAdmin: true }),
  testChannelVideo: (payload) => request('POST', '/api/channels/test-video', payload, { preferAdmin: true }),
  preflight: (payload) => request('POST', '/api/preflight', payload),
  generate: (payload) => request('POST', '/api/generate', payload),
  tailFrame: (payload) => request('POST', '/api/tailframe', payload),
  tailClip: (payload) => request('POST', '/api/tailclip', payload),
  importAsset: (file, kind, canvasId, mode) =>
    uploadFile(
      `/api/assets/import?name=${encodeURIComponent(file.name || '本地素材')}&kind=${encodeURIComponent(kind || '')}${
        canvasId ? `&canvasId=${encodeURIComponent(canvasId)}` : ''
      }&dup=${encodeURIComponent(mode || 'ask')}`,
      file
    ),
  task: (id) => request('GET', `/api/tasks/${encodeURIComponent(id)}`),
  tasks: (limit, opts = {}) => {
    const q = [];
    if (limit) q.push(`limit=${encodeURIComponent(limit)}`);
    if (opts.canvasId) q.push(`canvasId=${encodeURIComponent(opts.canvasId)}`);
    if (opts.active) q.push('active=1');
    return request('GET', '/api/tasks' + (q.length ? `?${q.join('&')}` : ''));
  },
  cancelTask: (id) => request('POST', `/api/tasks/${encodeURIComponent(id)}/cancel`, {}),
  resumeTask: (id) => request('POST', `/api/tasks/${encodeURIComponent(id)}/resume`, {}),
  listCanvases: () => request('GET', '/api/canvases'),
  createCanvas: (name) => request('POST', '/api/canvases', { name }),
  getCanvas: (id) => request('GET', `/api/canvases/${encodeURIComponent(id)}`),
  canvasMeta: (id) => request('GET', `/api/canvases/${encodeURIComponent(id)}/meta`),
  saveCanvas: (id, state, rev) => {
    const payload = rev == null ? state : { ...state, rev };
    return request('PUT', `/api/canvases/${encodeURIComponent(id)}`, payload);
  },
  renameCanvas: (id, name) => request('PATCH', `/api/canvases/${encodeURIComponent(id)}`, { name }),
  duplicateCanvas: (id) => request('POST', `/api/canvases/${encodeURIComponent(id)}/duplicate`, {}),
  deleteCanvas: (id) => request('DELETE', `/api/canvases/${encodeURIComponent(id)}`),
  exportCanvas: (id) => request('GET', `/api/canvases/${encodeURIComponent(id)}/export`),
  importCanvas: (payload) => request('POST', '/api/canvases/import', payload),
  backups: (id) => request('GET', `/api/canvases/${encodeURIComponent(id)}/backups`),
  restoreBackup: (id, name) =>
    request('POST', `/api/canvases/${encodeURIComponent(id)}/backups/restore`, { name }),
  snapshotCanvas: (id, label) =>
    request('POST', `/api/canvases/${encodeURIComponent(id)}/backups/snapshot`, { label }),
  schedules: (canvasId) => request('GET', `/api/schedules?canvasId=${encodeURIComponent(canvasId)}`),
  schedule: (nodeId) => request('GET', `/api/schedules/${encodeURIComponent(nodeId)}`),
  startSchedule: (nodeId, body) =>
    request('POST', `/api/schedules/${encodeURIComponent(nodeId)}/start`, body || {}),
  pauseSchedule: (nodeId) => request('POST', `/api/schedules/${encodeURIComponent(nodeId)}/pause`, {}),
  stopSchedule: (nodeId) => request('POST', `/api/schedules/${encodeURIComponent(nodeId)}/stop`, {}),
  forgetSchedule: (nodeId) => request('DELETE', `/api/schedules/${encodeURIComponent(nodeId)}`),
  exportPickDir: () => request('POST', '/api/export/pick-dir', {}),
  exportAssets: (items, destDir) => request('POST', '/api/export/assets', { items, destDir }),
  shareList: () => request('GET', '/api/share/list'),
  shareToggle: (id, on) => request('POST', `/api/canvases/${encodeURIComponent(id)}/share`, { on: Boolean(on) }),
  codesyncPlan: (host) => request('GET', `/api/codesync/plan?host=${encodeURIComponent(host)}`),
  codesyncPull: (host) => request('POST', '/api/codesync/pull', { host }),
  // admin extras
  adminStatus: () => request('GET', '/api/admin/status'),
  adminSetup: (password) => request('POST', '/api/admin/setup', { password }),
  adminLogin: (password) => request('POST', '/api/admin/login', { password }),
  adminLogout: () => request('POST', '/api/admin/logout', {}),
  adminDashboard: () => request('GET', '/api/admin/dashboard'),
  storageStats: () => request('GET', '/api/admin/storage'),
  portalStats: () => request('GET', '/api/portal/stats'),
};

export default api;
