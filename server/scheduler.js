'use strict';

// 定时生成组：本地后台按时提交组内视频卡片。
// 浏览器关掉也照样跑；运行状态单独存 schedule_runs，不会被画布保存覆盖。

const store = require('./store');
const tasks = require('./tasks');
const generate = require('./generate');
const channels = require('./channels');
// 参数装配规则与前端、generate.js 共用同一份源码（web 目录下的 UMD 模块）
const payloadRules = require('../web/assets/payload-rules.js');

// 备用模型失败后隔几秒再提交，避免接口还在限流时马上又撞一次
const RETRY_DELAY_MS = 5000;
const MAX_BACKUPS = 3;

const TERMINAL = { done: 1, failed: 1, canceled: 1, interrupted: 1 };

let runtimeConfig = null;
let ticker = null;
let ticking = false;
const watches = new Map(); // taskId -> timer
const savedSig = new Map(); // nodeId -> 上次写库时的 items 指纹

function now() {
  return Date.now();
}

function log(message) {
  try {
    console.log('[定时组] ' + message);
  } catch {
    /* 忽略 */
  }
}

function scheduleOf(node) {
  if (!node || node.type !== 'schedule') return null;
  const data = node.data || {};
  const schedule = data.schedule && typeof data.schedule === 'object' ? data.schedule : {};
  return {
    members: Array.isArray(data.members) ? data.members.slice() : [],
    order: Array.isArray(data.order) && data.order.length
      ? data.order.slice()
      : (Array.isArray(data.members) ? data.members.slice() : []),
    schedule: schedule,
    snapshots: schedule.snapshots && typeof schedule.snapshots === 'object' ? schedule.snapshots : {},
  };
}

// 备用模型清单：优先用开始那一刻冻结的快照，没冻结就退回当前配置
function backupListOf(conf, run) {
  const sched = (conf && conf.schedule) || {};
  // 优先级：本轮运行冻结的 > 开始那一刻的快照 > 现在的配置
  let frozen = null;
  if (run && Array.isArray(run.backups) && run.backups.length) frozen = run.backups;
  else if (Array.isArray(sched.backupSnapshots) && sched.backupSnapshots.length) frozen = sched.backupSnapshots;
  else frozen = sched.backups;
  const out = [];
  const seen = new Set();
  (Array.isArray(frozen) ? frozen : []).forEach((item) => {
    if (!item || out.length >= MAX_BACKUPS) return;
    const model = String(item.model || '').trim();
    if (!model) return;
    const channelId = String(item.channelId || '');
    const key = channelId + '::' + model;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      model: model,
      channelId: channelId,
      channelName: String(item.channelName || item.channel || ''),
      note: String(item.note || ''),
      label: String(item.label || '') || model,
    });
  });
  return out;
}

// 第 0 个永远是主模型，后面按顺序是备用 1 / 2 / 3
function candidatesOf(conf, nodeId, run) {
  const snap = conf && conf.snapshots ? conf.snapshots[nodeId] : null;
  if (!snap) return [];
  const main = {
    model: String(snap.model || ''),
    channelId: String(snap.channelId || ''),
    channelName: String(snap.channelName || ''),
    note: '',
    label: String(snap.model || '') || '默认模型',
  };
  return [main].concat(backupListOf(conf, run));
}

// 备用模型被删了 / 通道停用了 / 通道里已经没这个模型：直接跳过，别拿错通道硬发
function checkBackup(candidate) {
  if (!candidate) return { ok: false, reason: '备用模型配置为空' };
  const active = channels
    .activeChannels(runtimeConfig)
    .filter((channel) => channel && Array.isArray(channel.kinds) && channel.kinds.indexOf('video') >= 0);
  if (candidate.channelId) {
    const channel = active.find((one) => one.id === candidate.channelId);
    if (!channel) return { ok: false, reason: '通道已删除或停用' };
    if (candidate.model) {
      const ids = channels.modelIds(channel.models && channel.models.video);
      if (ids.length && ids.indexOf(candidate.model) < 0) return { ok: false, reason: '这个通道里已经没有该模型' };
    }
    return { ok: true, channel: channel };
  }
  if (candidate.model) {
    const channel = active.find((one) => channels.modelIds(one.models && one.models.video).indexOf(candidate.model) >= 0);
    if (!channel) return { ok: false, reason: '找不到带这个模型的可用通道' };
    return { ok: true, channel: channel };
  }
  return { ok: false, reason: '没有可用的通道' };
}

function startAttempt(item, index, candidate) {
  if (!Array.isArray(item.attempts)) item.attempts = [];
  item.attempts.push({
    index: index,
    model: (candidate && candidate.model) || '',
    channelId: (candidate && candidate.channelId) || '',
    channelName: (candidate && candidate.channelName) || '',
    note: (candidate && candidate.note) || '',
    status: 'running',
    error: '',
    at: now(),
    finishedAt: 0,
  });
}

function closeAttempt(item, index, status, error) {
  if (!Array.isArray(item.attempts)) item.attempts = [];
  const want = Number(index) || 0;
  for (let i = item.attempts.length - 1; i >= 0; i -= 1) {
    const one = item.attempts[i];
    if (Number(one.index) !== want || one.status !== 'running') continue;
    one.status = status;
    one.error = error || '';
    one.finishedAt = now();
    return;
  }
  // 这一轮没真正提交（比如备用通道在等的 5 秒里被删了）：已经有跳过记录就不再补一条
  if (item.attempts.some((one) => Number(one.index) === want)) return;
  item.attempts.push({
    index: want,
    model: item.model || '',
    status: status,
    error: error || '',
    at: now(),
    finishedAt: now(),
  });
}

function skipAttempt(item, index, candidate, reason) {
  if (!Array.isArray(item.attempts)) item.attempts = [];
  item.attempts.push({
    index: index,
    model: (candidate && candidate.model) || '',
    channelId: (candidate && candidate.channelId) || '',
    channelName: (candidate && candidate.channelName) || '',
    note: (candidate && candidate.note) || '',
    status: 'skipped',
    error: reason || '',
    at: now(),
    finishedAt: now(),
  });
}

function readScheduleNode(canvasId, nodeId) {
  const state = store.getState(canvasId);
  if (!state) return null;
  return state.nodes.find((node) => node.id === nodeId) || null;
}

function memberNodesOf(canvasId, ids) {
  const state = store.getState(canvasId);
  if (!state) return new Map();
  const map = new Map();
  state.nodes.forEach((node) => map.set(node.id, node));
  return new Map(ids.filter((id) => map.has(id)).map((id) => [id, map.get(id)]));
}

// 能参与定时生成的卡片：视频 / 快速视频，且没被隐藏
function usableMember(member) {
  if (!member) return false;
  if (member.type !== 'video' && member.type !== 'quick') return false;
  return !(member.data && member.data.hidden);
}

// 逐张算出发时刻：错峰模式按「开始时间 + 每张间隔」，逐张模式用各自填的时间
function planItems(node, members) {
  const conf = scheduleOf(node);
  if (!conf) return [];
  const sched = conf.schedule || {};
  const mode = sched.mode === 'perCard' ? 'perCard' : 'stagger';
  const startAt = Number(sched.startAt) || now();
  const gap = Math.max(0, Number(sched.intervalSec) || 0) * 1000;
  const perCard = sched.perCard && typeof sched.perCard === 'object' ? sched.perCard : {};
  const order = conf.order.filter((id) => conf.members.indexOf(id) >= 0);
  return order
    .filter((id) => usableMember(members.get(id)))
    .map((id, index) => {
      let dueAt = mode === 'perCard' ? Number(perCard[id]) || 0 : startAt + index * gap;
      if (!dueAt) dueAt = startAt + index * gap;
      return {
        nodeId: id,
        index: index,
        dueAt: dueAt,
        status: 'pending',
        taskId: '',
        error: '',
        model: '',
        channelName: '',
        attempts: [],
        backupIndex: 0,
        startedAt: 0,
        finishedAt: 0,
      };
    });
}

function ensureRun(nodeId, canvasId) {
  const run = store.getScheduleRun(nodeId);
  if (run) return run;
  return store.upsertScheduleRun({ nodeId: nodeId, canvasId: canvasId, state: 'idle', items: [] });
}

function saveRun(run) {
  const saved = store.upsertScheduleRun(run);
  savedSig.set(run.nodeId, runSignature(saved || run));
  return saved;
}

// 指纹要连状态一起比：items 没变、但 running 变成 done / stopped 时也必须落库
function runSignature(run) {
  return JSON.stringify({ state: run && run.state ? run.state : 'idle', items: (run && run.items) || [] });
}

function touchRun(run) {
  const sig = runSignature(run);
  if (savedSig.get(run.nodeId) === sig) return false;
  saveRun(run);
  return true;
}

function markNodeRunning(canvasId, nodeId, running, extra) {
  if (typeof store.patchNodeData !== 'function') return;
  try {
    store.patchNodeData(canvasId, nodeId, Object.assign({ running: Boolean(running) }, extra || {}));
  } catch (error) {
    log('写卡片状态失败：' + error.message);
  }
}

const CARD_HISTORY_LIMIT = 20;

// 生成版本历史：新结果排最前，同地址不重复；当前版本也留在历史里，切回去才回得来。
//
// 注意不存 submittedPrompt：它是 mainPrompt 再拼一段尾部提示词，能精确还原
// （见 migrate.js 的 composedPromptOf）。每版都存一份，是整份历史里最大的一笔重复。
function historyEntryOf(result, meta) {
  const info = meta && typeof meta === 'object' ? meta : {};
  return {
    id: 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    result: result,
    mainPrompt: String(info.mainPrompt || ''),
    tailPresetId: String(info.tailPresetId || ''),
    tailPresetName: String(info.tailPresetName || ''),
    tailText: String(info.tailText || ''),
    tailAppended: Boolean(info.tailAppended),
    model: String(info.model || ''),
    params: info.params && typeof info.params === 'object' ? info.params : {},
    at: Number(info.at) || now(),
  };
}

function pushHistoryEntry(history, entry) {
  const list = Array.isArray(history) ? history.slice() : [];
  if (!entry || !entry.result || !entry.result.url) return list;
  const url = String(entry.result.url);
  const withoutSame = list.filter((one) => !(one && one.result && String(one.result.url) === url));
  withoutSame.unshift(entry);
  return withoutSame.slice(0, CARD_HISTORY_LIMIT);
}

function applyResultToCard(canvasId, nodeId, task, item) {
  if (typeof store.patchNodeData !== 'function') return;
  const result = (task && task.result) || {};
  if (!result.url) {
    try {
      store.patchNodeData(canvasId, nodeId, {
        running: false,
        progress: '',
        retrying: false,
        error: task && task.error ? task.error : '',
      });
    } catch (error) {
      log('写卡片失败状态出错：' + error.message);
    }
    return;
  }
  try {
    const old = typeof store.getNodeData === 'function' ? store.getNodeData(canvasId, nodeId) || {} : {};
    const nextResult = {
      url: result.url,
      file: result.relPath || '',
      kind: result.kind || 'video',
      width: Number(result.width) || 0,
      height: Number(result.height) || 0,
      model: task.model || result.model || '',
      at: task.updatedAt || now(),
    };
    const submission = (item && item.submission) || {};
    let history = Array.isArray(old.history) ? old.history.slice() : [];
    // 老卡片第一次参与新版：先把原来那张结果补成一条历史，再覆盖
    if (old.result && old.result.url && old.result.url !== nextResult.url) {
      const already = history.some((one) => one && one.result && String(one.result.url) === String(old.result.url));
      if (!already) {
        const oldMeta = old.lastSubmission && typeof old.lastSubmission === 'object' ? old.lastSubmission : {};
        history = pushHistoryEntry(history, historyEntryOf(old.result, oldMeta));
      }
    }
    history = pushHistoryEntry(
      history,
      historyEntryOf(nextResult, {
        mainPrompt: submission.mainPrompt,
        tailPresetId: submission.tailPresetId,
        tailPresetName: submission.tailPresetName,
        tailText: submission.tailText,
        tailAppended: Boolean(submission.tailAppended),
        model: nextResult.model,
        params: submission.params,
        at: Number(task.updatedAt) || now(),
      })
    );
    store.patchNodeData(canvasId, nodeId, {
      running: false,
      progress: '',
      retrying: false,
      error: '',
      taskId: task.id || '',
      result: nextResult,
      history: history,
      lastSubmission: {
        mainPrompt: String(submission.mainPrompt || ''),
        // 同上：submittedPrompt 不落盘，读的时候按 mainPrompt + 尾部提示词现算
        tailPresetId: String(submission.tailPresetId || ''),
        tailPresetName: String(submission.tailPresetName || ''),
        tailText: String(submission.tailText || ''),
        tailAppended: Boolean(submission.tailAppended),
        model: nextResult.model,
        at: Number(task.updatedAt) || now(),
      },
    });
  } catch (error) {
    log('写卡片结果出错：' + error.message);
  }
}

function clearWatch(taskId) {
  const timer = watches.get(taskId);
  if (timer) clearInterval(timer);
  watches.delete(taskId);
}

// 任务结束后：成功 / 取消直接记结果；失败先看还有没有备用模型可以顶
function handleTaskEnd(run, item, task) {
  applyResultToCard(run.canvasId, item.nodeId, task, item);
  if (task.status === 'done') finishItem(run, item, 'done', '');
  else if (task.status === 'canceled') finishItem(run, item, 'canceled', '已取消');
  else finishItem(run, item, 'failed', task.error || '生成失败');
}

function watchTask(run, item) {
  const key = item.taskId;
  if (!key || watches.has(key)) return;
  const timer = setInterval(() => {
    const task = store.getTask(item.taskId);
    if (!task) {
      clearWatch(key);
      applyResultToCard(run.canvasId, item.nodeId, { error: '生成任务记录找不到了（服务可能重启过）' }, item);
      finishItem(run, item, 'failed', '生成任务记录找不到了（服务可能重启过）');
      return;
    }
    if (!TERMINAL[task.status]) return;
    clearWatch(key);
    handleTaskEnd(run, item, task);
  }, 1600);
  watches.set(key, timer);
}

function finishItem(run, item, status, error) {
  const live = store.getScheduleRun(run.nodeId) || run;
  const items = Array.isArray(live.items) ? live.items : [];
  const hit = items.find((one) => one.nodeId === item.nodeId);
  if (!hit) return;
  if (hit.status === 'done' || hit.status === 'failed' || hit.status === 'canceled') return;
  // 调用方手里这份可能有刚记下、还没落库的尝试记录，先合并过来
  if (Array.isArray(item.attempts) && item.attempts.length) hit.attempts = item.attempts.slice();
  if (Number(item.backupIndex) > 0) hit.backupIndex = Number(item.backupIndex);
  if (status === 'failed') {
    closeAttempt(hit, hit.backupIndex, 'failed', error);
    if (scheduleRetry(live, hit, error)) {
      live.items = items;
      saveRun(live);
      return;
    }
    // 走完主模型和全部备用还是失败：给一句能看懂的总结
    if (Number(hit.backupIndex) > 0) {
      error = '主模型和 ' + Number(hit.backupIndex) + ' 个备用都失败了：' + (error || '生成失败');
      markNodeRunning(live.canvasId, hit.nodeId, false, { error: error, retrying: false });
    }
  } else if (status === 'done') {
    closeAttempt(hit, hit.backupIndex, 'done', '');
  } else if (status === 'canceled') {
    closeAttempt(hit, hit.backupIndex, 'canceled', error || '已取消');
  }
  hit.status = status;
  hit.error = error || '';
  hit.finishedAt = now();
  live.items = items;
  if (live.state === 'running' && items.every((one) => one.status !== 'pending' && one.status !== 'running')) {
    live.state = 'done';
    log('定时组全部跑完：' + live.nodeId);
  }
  saveRun(live);
}

// 主模型失败：按顺序找下一个可用备用；全部没有就返回 false，由外层标最终失败
function scheduleRetry(live, item, error) {
  // 暂停 / 停止 / 取消之后绝不重试：避免用户以为停了却还在扣费
  if (!live || live.state !== 'running') return false;
  if (item.status === 'canceled' || item.status === 'done') return false;
  const node = readScheduleNode(live.canvasId, live.nodeId);
  if (!node || node.type !== 'schedule') return false;
  const conf = scheduleOf(node);
  if (!conf) return false;
  const list = candidatesOf(conf, item.nodeId, live);
  if (list.length < 2) return false;
  const from = Math.max(0, Number(item.backupIndex) || 0);
  let chosen = -1;
  for (let index = from + 1; index < list.length; index += 1) {
    const candidate = list[index];
    const check = checkBackup(candidate);
    if (!check.ok) {
      skipAttempt(item, index, candidate, check.reason);
      log('第 ' + (item.index + 1) + ' 张跳过备用 ' + index + '：' + check.reason);
      continue;
    }
    chosen = index;
    break;
  }
  if (chosen < 0) return false;
  const candidate = list[chosen];
  item.status = 'pending';
  item.backupIndex = chosen;
  item.taskId = '';
  item.model = candidate.model || '';
  item.channelName = candidate.channelName || '';
  item.error = '主模型失败：' + (error || '生成失败') + '；' + Math.round(RETRY_DELAY_MS / 1000) + ' 秒后改用备用 ' + chosen + '（' + (candidate.label || candidate.model) + '）';
  item.dueAt = now() + RETRY_DELAY_MS;
  item.startedAt = 0;
  item.finishedAt = 0;
  markNodeRunning(live.canvasId, item.nodeId, false, { error: item.error, retrying: true });
  log('第 ' + (item.index + 1) + ' 张将改用备用 ' + chosen + '：' + (candidate.label || candidate.model));
  return true;
}

function submitItem(run, item, node) {
  const conf = scheduleOf(node);
  const snap = conf && conf.snapshots ? conf.snapshots[item.nodeId] : null;
  const member = readScheduleNode(run.canvasId, item.nodeId);
  if (!member) {
    item.status = 'failed';
    item.error = '这张卡片已经不在画布上了';
    item.finishedAt = now();
    return;
  }
  if (!usableMember(member)) {
    item.status = 'failed';
    item.error = '这张卡片已隐藏或不是视频卡片';
    item.finishedAt = now();
    return;
  }
  if (!snap || !String(snap.prompt || '').trim()) {
    item.status = 'failed';
    item.error = '没有可用的提示词快照，先点「刷新快照」';
    item.finishedAt = now();
    return;
  }
  const list = candidatesOf(conf, item.nodeId, run);
  const backupIndex = Math.max(0, Math.min(Math.max(0, list.length - 1), Number(item.backupIndex) || 0));
  const candidate = list[backupIndex] || {
    model: snap.model || '',
    channelId: snap.channelId || '',
    channelName: snap.channelName || '',
  };
  // 排到备用时再确认一次：这 5 秒里通道可能被删了
  if (backupIndex > 0) {
    const check = checkBackup(candidate);
    if (!check.ok) {
      skipAttempt(item, backupIndex, candidate, check.reason);
      item.status = 'running';
      item.error = '备用 ' + backupIndex + ' 不可用：' + check.reason;
      markNodeRunning(run.canvasId, item.nodeId, false, { error: item.error, retrying: true });
      finishItem(run, item, 'failed', item.error);
      return;
    }
  }
  const model = backupIndex > 0 ? candidate.model || '' : snap.model || '';
  const channelId = backupIndex > 0 ? candidate.channelId || '' : snap.channelId || '';
  const channelName = backupIndex > 0 ? candidate.channelName || '' : snap.channelName || '';
  const params = snap.params && typeof snap.params === 'object' ? snap.params : {};
  // 尾部提示词在开始那一刻就冻结：运行期间改预设不会串味，暂停再继续也还是同一套。
  // 类型必须显式传：组里可能既有视频卡也有图片卡（`nodeType` 那段注释也这么说），
  // 而图片和视频用的是两个互不相通的预设池 —— 不传类型就会让图片卡错拿到视频那套。
  const memberKind = member.type;
  let frozenTail = item && item.frozenTail;
  if (!frozenTail || typeof frozenTail !== 'object') {
    try {
      frozenTail = generate.resolveTail(runtimeConfig, { tailPrompt: snap.tailPrompt }, memberKind);
      item.frozenTail = frozenTail;
    } catch (error) {
      item.status = 'failed';
      item.error = error.message;
      item.finishedAt = now();
      markNodeRunning(run.canvasId, item.nodeId, false, { error: item.error });
      return;
    }
  }
  let submission = null;
  try {
    submission = generate.composeSubmission(runtimeConfig, {
      promptRaw: snap.promptRaw || snap.prompt,
      prompt: snap.prompt,
      tailPrompt: snap.tailPrompt,
      frozenTail: frozenTail,
    }, memberKind);
  } catch (error) {
    item.status = 'failed';
    item.error = error.message;
    item.finishedAt = now();
    markNodeRunning(run.canvasId, item.nodeId, false, { error: item.error });
    return;
  }
  // C5：定时组的 payload 不再自己拼，改走与单卡 / 批量同一套装配规则
  // （web/assets/payload-rules.js）。原来这里把没选模式的快照写死成 'reference'，
  // 而单卡那条路原样传空串，同一张卡片在 {{mode}} 上会忽空忽有。
  // nodeType 用卡片自己的类型：组里既有 video 卡也有 quick 卡，两者规则不同。
  const payload = payloadRules.assemble({
    canvasId: run.canvasId,
    nodeId: item.nodeId,
    nodeType: member.type,
    channelId: channelId,
    channelName: channelName,
    model: model,
    prompt: submission.apiPrompt,
    promptRaw: submission.mainPrompt,
    params: params,
    refs: Array.isArray(snap.refs) ? snap.refs : [],
  });
  // 定时组的尾部提示词在开始那一刻就冻结，运行期间改预设不串味：
  // 它是「取用哪一套」，不属于参数规则，所以装配完再挂上去。
  payload.frozenTail = frozenTail;
  try {
    item.status = 'running';
    item.startedAt = now();
    item.backupIndex = backupIndex;
    item.model = model;
    item.channelName = channelName;
    item.error = '';
    item.finishedAt = 0;
    item.submission = {
      mainPrompt: submission.mainPrompt,
      // 不存 submittedPrompt：它能由 mainPrompt + 尾部提示词精确还原
      // （见 migrate.js 的 composedPromptOf）。items_json 整份进 schedule_runs 表，
      // 存一份就是同一段提示词的又一次复制。
      tailPresetId: submission.tailPresetId || '',
      tailPresetName: submission.tailPresetName || '',
      tailText: submission.tailText || '',
      tailAppended: Boolean(submission.tailAppended),
      params: Object.assign({}, params),
      model: model,
    };
    startAttempt(item, backupIndex, { model: model, channelId: channelId, channelName: channelName, note: candidate.note || '' });
    markNodeRunning(run.canvasId, item.nodeId, true, { error: '', retrying: backupIndex > 0 });
    const task = tasks.start(
      {
        canvasId: run.canvasId,
        nodeId: item.nodeId,
        channel: channelName || '',
        kind: 'video',
        model: model || '',
        params: Object.assign({}, params, {
          mainPrompt: submission.mainPrompt,
          // 不存 submittedPrompt：能由 mainPrompt + 尾部提示词精确还原
          tailPresetId: submission.tailPresetId || '',
          tailPresetName: submission.tailPresetName || '',
          tailText: submission.tailText || '',
          tailAppended: Boolean(submission.tailAppended),
        }),
        prompt: String(submission.apiPrompt || '').slice(0, 120),
      },
      (ctx) => generate.runKind(runtimeConfig, 'video', payload, ctx)
    );
    item.taskId = task.id;
    log('已提交第 ' + (item.index + 1) + ' 张：' + (model || '默认模型') + (backupIndex > 0 ? '（备用 ' + backupIndex + '）' : ''));
    watchTask(run, item);
  } catch (error) {
    closeAttempt(item, backupIndex, 'failed', error.message);
    markNodeRunning(run.canvasId, item.nodeId, false, { error: error.message });
    item.status = 'failed';
    item.error = error.message;
    item.finishedAt = now();
    finishItem(run, item, 'failed', error.message);
  }
}

// 同时生成张数：0 / unlimited = 不限制，1~10 张，缺省或乱填按 2 张
function concurrencyOf(sched) {
  const raw = sched ? sched.concurrency : undefined;
  if (raw === 'unlimited' || raw === 'all') return Infinity;
  if (raw == null || raw === '') return 2;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  if (n <= 0) return Infinity;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function tickRun(run) {
  if (run.state !== 'running') return;
  const node = readScheduleNode(run.canvasId, run.nodeId);
  if (!node || node.type !== 'schedule') {
    run.state = 'stopped';
    touchRun(run);
    return;
  }
  const conf = scheduleOf(node);
  if (!conf) {
    run.state = 'stopped';
    touchRun(run);
    return;
  }
  // 成员被删 / 隐藏了：还没提交的直接取消，别卡在 pending
  const members = memberNodesOf(run.canvasId, conf.members);
  run.items.forEach((item) => {
    if (item.status !== 'pending') return;
    if (usableMember(members.get(item.nodeId))) return;
    item.status = 'canceled';
    item.error = '卡片已删除、隐藏或不是视频卡片';
    item.finishedAt = now();
  });
  const sched = conf.schedule || {};
  const limit = concurrencyOf(sched);
  let running = run.items.filter((item) => item.status === 'running').length;
  const due = run.items
    .filter((item) => item.status === 'pending' && item.dueAt <= now())
    .sort((a, b) => a.dueAt - b.dueAt || a.index - b.index);
  for (const item of due) {
    if (running >= limit) break;
    submitItem(run, item, node);
    if (item.status === 'running') running += 1;
  }
  // 运行中的卡片被删掉了：不占并发额度
  run.items.forEach((item) => {
    if (item.status !== 'running') return;
    if (readScheduleNode(run.canvasId, item.nodeId)) return;
    item.status = 'canceled';
    item.error = '卡片已删除';
    item.finishedAt = now();
  });
  if (run.state === 'running' && run.items.length && run.items.every((one) => one.status !== 'pending' && one.status !== 'running')) {
    run.state = 'done';
    log('定时组全部跑完：' + run.nodeId);
  }
  touchRun(run);
}

function tick() {
  if (ticking) return;
  ticking = true;
  try {
    store.listScheduleRuns().forEach((run) => {
      if (run.state === 'running') tickRun(run);
    });
  } catch (error) {
    log('检查定时任务出错：' + error.message);
  } finally {
    ticking = false;
  }
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(tick, 1000);
  if (ticker.unref) ticker.unref();
}

// ---------- 对外接口 ----------

function init(config) {
  runtimeConfig = config;
  startTicker();
  // 服务重启：上次还在跑的组接着跑；已经提交过的任务重新挂上 watcher
  const live = store.listLiveScheduleRuns();
  live.forEach((run) => {
    if (run.state !== 'running') return;
    log('恢复定时组：' + run.nodeId);
    savedSig.set(run.nodeId, runSignature(run));
    run.items.forEach((item) => {
      if (item.status !== 'running') return;
      if (!item.taskId) {
        item.status = 'failed';
        item.error = '服务重启时这条任务还没提交成功，已跳过（避免重复扣费）';
        item.finishedAt = now();
        markNodeRunning(run.canvasId, item.nodeId, false);
        return;
      }
      const task = store.getTask(item.taskId);
      if (!task) {
        item.status = 'failed';
        item.error = '服务重启后找不到这条任务，已跳过';
        item.finishedAt = now();
        markNodeRunning(run.canvasId, item.nodeId, false);
        return;
      }
      if (TERMINAL[task.status]) {
        if (task.status === 'failed') {
          applyResultToCard(run.canvasId, item.nodeId, task, item);
          item.status = 'running';
          finishItem(run, item, 'failed', task.error || '生成失败');
          return;
        }
        applyResultToCard(run.canvasId, item.nodeId, task, item);
        item.status = task.status === 'done' ? 'done' : 'canceled';
        item.error = '';
        item.finishedAt = now();
        if (item.status === 'done') closeAttempt(item, item.backupIndex, 'done', '');
        return;
      }
      watchTask(run, item);
    });
    saveRun(run);
  });
  return live.length;
}

function statusOf(canvasId, nodeId) {
  const run = store.getScheduleRun(nodeId);
  const node = readScheduleNode(canvasId, nodeId);
  const conf = scheduleOf(node);
  const items = run ? run.items : [];
  const members = conf ? conf.order.filter((id) => conf.members.indexOf(id) >= 0) : [];
  const detailed = members.map((id, index) => {
    const item = items.find((one) => one.nodeId === id);
    const member = readScheduleNode(canvasId, id);
    const task = item && item.taskId ? store.getTask(item.taskId) : null;
    return {
      nodeId: id,
      index: index,
      dueAt: item ? item.dueAt : 0,
      status: item ? item.status : 'pending',
      taskId: item ? item.taskId : '',
      error: item ? item.error : '',
      model: item ? item.model || '' : '',
      backupIndex: item ? Number(item.backupIndex) || 0 : 0,
      attempts: item && Array.isArray(item.attempts) ? item.attempts : [],
      startedAt: item ? item.startedAt : 0,
      finishedAt: item ? item.finishedAt : 0,
      type: member ? member.type : '',
      title: member ? (member.data && (member.data.title || member.data.text)) || '' : '',
      hidden: Boolean(member && member.data && member.data.hidden),
      task: task
        ? { id: task.id, status: task.status, stage: task.stage, error: task.error, result: task.result }
        : null,
    };
  });
  return {
    nodeId: nodeId,
    canvasId: canvasId,
    backups: run && Array.isArray(run.backups) ? run.backups : [],
    state: run ? run.state : 'idle',
    startedAt: run ? run.startedAt : 0,
    updatedAt: run ? run.updatedAt : 0,
    // Infinity 不能直接走 JSON（会变成 null，前端会误读成「同时 2 张」）：不限制统一输出 0
    concurrency: (function (value) {
      const limit = concurrencyOf(conf && conf.schedule);
      return Number.isFinite(limit) ? limit : 0;
    })(),
    items: detailed,
  };
}

function listOf(canvasId) {
  const runs = store.listScheduleRuns(canvasId);
  return runs.map((run) => statusOf(run.canvasId, run.nodeId));
}

function start(canvasId, nodeId, options) {
  const node = readScheduleNode(canvasId, nodeId);
  if (!node) throw new Error('这张定时组卡片已经不在画布上了');
  if (node.type !== 'schedule') throw new Error('这张卡片不是定时生成组');
  const conf = scheduleOf(node);
  if (!conf) throw new Error('定时组配置读不出来');
  const members = memberNodesOf(canvasId, conf.members);
  const valid = conf.order.filter((id) => usableMember(members.get(id)));
  if (valid.length < 2) throw new Error('组里至少要有两张视频卡片才能开始');
  const sched = conf.schedule || {};
  const opts = options && typeof options === 'object' ? options : {};
  if (opts.startAt) sched.startAt = Number(opts.startAt);
  const items = planItems(node, members);
  if (items.length < 2) throw new Error('组里至少要有两张视频卡片才能开始');
  const previous = store.getScheduleRun(nodeId);
  const keep = previous && previous.state === 'paused' ? previous : null;
  const nextItems = keep && keep.items.length === items.length
    ? keep.items.map((item) => {
        const fresh = items.find((one) => one.nodeId === item.nodeId);
        if (item.status !== 'pending' || !fresh) return item;
        return Object.assign({}, item, { dueAt: fresh.dueAt, index: fresh.index });
      })
    : items;
  // 开始前把每张待执行卡片的尾部提示词冻住；引用的预设已删除就直接报错，不带病开跑。
  // 同样要按卡片自己的类型选池：图片卡和视频卡用的是两个互不相通的池子。
  nextItems.forEach((item) => {
    if (item.frozenTail && typeof item.frozenTail === 'object') return;
    if (item.status !== 'pending') return;
    const snap = conf.snapshots ? conf.snapshots[item.nodeId] : null;
    const member = readScheduleNode(canvasId, item.nodeId);
    item.frozenTail = generate.resolveTail(runtimeConfig, {
      tailPrompt: snap && snap.tailPrompt,
    }, member ? member.type : '');
  });
  const frozen = backupListOf(conf, null);
  const run = store.upsertScheduleRun({
    nodeId: nodeId,
    canvasId: canvasId,
    state: 'running',
    items: nextItems,
    backups: frozen,
    startedAt: previous && previous.startedAt ? previous.startedAt : now(),
  });
  savedSig.set(nodeId, runSignature(run));
  log(
    '定时组开始：' + valid.length + ' 张，' +
      (sched.mode === 'perCard' ? '逐张定时' : '错峰 ' + (Number(sched.intervalSec) || 0) + ' 秒') +
      (frozen.length ? '，备用模型 ' + frozen.length + ' 个' : '')
  );
  tickRun(run);
  return statusOf(canvasId, nodeId);
}

function pause(canvasId, nodeId) {
  const run = store.getScheduleRun(nodeId);
  if (!run) throw new Error('这个定时组还没开始');
  if (run.state !== 'running') return statusOf(canvasId, nodeId);
  run.state = 'paused';
  saveRun(run);
  log('定时组已暂停：' + nodeId);
  return statusOf(canvasId, nodeId);
}

function stop(canvasId, nodeId) {
  const run = store.getScheduleRun(nodeId);
  if (!run) throw new Error('这个定时组还没开始');
  const stamp = now();
  run.items.forEach((item) => {
    if (item.status !== 'pending') return;
    item.status = 'canceled';
    item.error = '已停止';
    item.finishedAt = stamp;
  });
  run.state = 'stopped';
  saveRun(run);
  log('定时组已停止（已提交的继续跑完）：' + nodeId);
  return statusOf(canvasId, nodeId);
}

// 组卡片被删掉 / 画布被删掉时清掉运行记录与 watcher
function forget(canvasId, nodeId) {
  const run = store.getScheduleRun(nodeId);
  if (run) {
    (run.items || []).forEach((item) => {
      if (item.taskId) clearWatch(item.taskId);
    });
    if (run.state === 'running') {
      run.state = 'stopped';
      saveRun(run);
    }
  }
  savedSig.delete(nodeId);
  store.deleteScheduleRun(nodeId);
}

function forgetCanvas(canvasId) {
  store.listScheduleRuns(canvasId).forEach((run) => {
    (run.items || []).forEach((item) => {
      if (item.taskId) clearWatch(item.taskId);
    });
    savedSig.delete(run.nodeId);
    if (run.state === 'running') {
      run.state = 'stopped';
      saveRun(run);
    }
  });
  store.deleteScheduleRunsOfCanvas(canvasId);
}

module.exports = { init, statusOf, listOf, start, pause, stop, forget, forgetCanvas, concurrencyOf };
