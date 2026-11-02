'use strict';

const store = require('./store');
const generate = require('./generate');

const active = new Map();

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
      store.updateTask(id, {
        status: aborted ? 'canceled' : 'failed',
        stage: aborted ? '已取消' : '失败',
        error: (error && error.message) || String(error),
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

function cancel(id) {
  const controller = active.get(String(id));
  if (!controller) return false;
  controller.abort(new Error('已取消'));
  return true;
}

function isActive(id) {
  return active.has(String(id));
}

module.exports = { start, cancel, isActive, resumeAll };
