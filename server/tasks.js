'use strict';

const store = require('./store');
const generate = require('./generate');
const errorKinds = require('./error-kinds');

const active = new Map();

// 把异常整理成能存进库、也能直接给前端用的结构。
// 没有分类的（比如「提交前检查没通过」这类前端自己抛的）返回 null。
function infoOf(error, message) {
  if (!error || !error.kind) return null;
  const meta = errorKinds.meta(error.kind);
  return {
    kind: error.kind,
    title: message || meta.title,
    advice: error.advice || meta.advice,
    detail: error.detail || '',
    retryable: error.retryable !== undefined ? error.retryable : meta.retryable,
  };
}

function now() {
  return Date.now();
}

function makeCtx(id, controller) {
  return {
    id: id,
    signal: controller.signal,
    progress: function (patch) {
      store.updateTask(id, patch);
    },
    // 记下异步任务的接续信息：服务重启后靠它接着等，不用重新提交
    attach: function (record) {
      store.updateTask(id, {
        resume: record,
        remoteId: (record && record.remoteId) || '',
        stage: '已提交，正在等结果',
      });
    },
  };
}

// 跑一条任务：库里已经有这条记录，这里只管把它跑完
function runJob(id, startedAt, job) {
  const controller = new AbortController();
  active.set(id, controller);
  const ctx = makeCtx(id, controller);
  Promise.resolve()
    .then(function () {
      store.updateTask(id, { status: 'running', stage: '准备中' });
      return job(ctx);
    })
    .then(function (result) {
      store.updateTask(id, {
        status: 'done',
        stage: '完成',
        resultPath: result && result.relPath ? result.relPath : '',
        result: result || {},
        error: '',
        waitedMs: now() - startedAt,
      });
    })
    .catch(function (error) {
      const aborted = controller.signal.aborted;
      const message = (error && error.message) || String(error);
      store.updateTask(id, {
        status: aborted ? 'canceled' : 'failed',
        stage: aborted ? '已取消' : '失败',
        error: message,
        // 带分类的错误（见 server/error-kinds.js）会额外记下结构化信息，
        // 前端据此显示更具体的提示与建议；没有分类时存 null，前端回退到 error 那句话。
        errorInfo: aborted ? null : infoOf(error, message),
        waitedMs: now() - startedAt,
      });
    })
    .finally(function () {
      active.delete(id);
    });
  return ctx;
}

// 起一个后台任务：先把任务记进库，再异步跑，前端轮询状态就行
function start(input, job) {
  const stamp = now();
  const created = store.insertTask({
    id: store.newId('t'),
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    channel: input.channel,
    kind: input.kind,
    model: input.model,
    params: input.params,
    prompt: input.prompt,
    status: 'queued',
    stage: '排队中',
    createdAt: stamp,
    updatedAt: stamp,
  });
  runJob(created.id, stamp, job);
  return store.getTask(created.id);
}

// 服务重启后：有接续信息的任务接着等结果，其余的交给中断标记处理
function resumeAll(config) {
  const list = store.listResumableTasks();
  list.forEach(function (task) {
    runJob(task.id, Number(task.createdAt) || now(), function (ctx) {
      return generate.resumeTask(config, task, ctx);
    });
  });
  return list.length;
}

// 重新拉取一条已结束（失败 / 已取消）的任务：不重新提交、不重新扣费，
// 拿当初记下的任务号回去再查一次结果。平台那边已经出片、只是本地配置错导致判失败的场景，
// 靠这个把片子捡回来。
function resumeOne(config, id) {
  const task = store.getTask(String(id));
  if (!task) throw new Error('任务不存在');
  if (active.has(String(id))) throw new Error('这条任务还在跑，不用重新拉取');
  const record = task.resume;
  if (!record || !record.remoteId) {
    throw new Error('这条任务没有留下任务号，没法回去取结果');
  }
  // 先把状态拉回「跑着」，卡片才会重新轮询起来
  store.updateTask(id, { status: 'running', stage: '重新拉取中…', error: '' });
  // 从「现在」重新计时：这条任务早就过了原来的最长等待时间，
  // 拿旧的时间戳去判会立刻又报超时（一个请求都不发）。
  runJob(task.id, now(), function (ctx) {
    return generate.resumeTask(config, store.getTask(id), ctx, { refetch: true });
  });
  return store.getTask(id);
}

function cancel(id) {
  const controller = active.get(String(id));
  if (!controller) return false;
  controller.abort(new Error('已取消'));
  return true;
}

function isActive(id) {
  return active.has(String(id));
}

module.exports = { start, cancel, isActive, resumeAll, resumeOne };
