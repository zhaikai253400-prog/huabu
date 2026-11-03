'use strict';

// F5 · 任务重启恢复专项测试（清单 41 第五项，对应清单 11）。
//
// 服务重启时，库里那些还在 queued / running 的任务会分成两类走：
//
//   · **有接续信息的**（已经拿到平台任务号）：继续接着等结果，用户不用重新生成。
//     等一个十分钟的视频时重启一次服务，这一条能省掉十分钟。
//   · **没有接续信息的**（提交还没拿到任务号就重启了）：如实标成「中断」，
//     让用户重新点一次 —— 假装还在跑比坦白更难收拾。
//
// 这个文件守三件事：
//
//   1. **分流判据以库为准**：判据是 resume_json 有没有内容，不是内存状态。
//      判错了，要么白等一个永远不来的结果，要么把能接的任务当成断了。
//   2. **接续记录要足够重放**：任务号、通道、模型、查询路径、截止时间、
//      冻结的参考素材快照，一个都不能少 —— 少一样就得重新提交。
//   3. **重启接续不从头计时**：已等多久按记录里的开始时间算。
//      从头计时会让「最多等 30 分钟」变成「重启几次就能等几小时」。
//
// 跑真实 store（隔离目录 + 临时库）；接续记录的字段完整性用源码级约束 + 真实
// buildWaitRecord 两边守。
//
// 运行：runtime/node.exe tools/tests/task-resume.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-resume-'));
require(path.join(__dirname, '_isolate.js'))(box);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    fail += 1;
    console.log('  ✗ ' + name + ' —— ' + error.message);
  }
}

function makeSandbox(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-resume-' + tag + '-'));
  require(path.join(__dirname, '_isolate.js'))(dir);
  delete require.cache[require.resolve(path.join(SERVER, 'store.js'))];
  delete require.cache[require.resolve(path.join(SERVER, 'migrate.js'))];
  return require(path.join(SERVER, 'store.js'));
}

function taskOf(id, extra) {
  return Object.assign(
    {
      id: id,
      canvasId: 'c_test',
      nodeId: 'n_test',
      channel: '通道甲',
      kind: 'video',
      model: 'video-model-1',
      params: { size: '1K' },
      prompt: '一只橘猫',
      status: 'queued',
      stage: '',
      createdAt: 1000,
    },
    extra || {}
  );
}

console.log('\nF5 · 任务重启恢复');

console.log('\n[1] 分流：有接续信息的接着等，没有的如实标中断');

check('没有接续信息的运行中任务 → 标成中断（不许假装还在跑）', () => {
  const store = makeSandbox('interrupt');
  store.insertTask(taskOf('t_norsm', { status: 'running' }));
  const n = store.interruptStaleTasks();
  assert.strictEqual(n, 1, '应中断 1 条');
  const after = store.getTask('t_norsm');
  assert.strictEqual(after.status, 'failed', '应标成失败');
  assert.strictEqual(after.stage, '中断');
  assert(after.error.indexOf('重新点一次生成') >= 0, '错误提示没说清怎么办：' + after.error);
});

check('有接续信息的运行中任务不被中断（要继续接着等）', () => {
  const store = makeSandbox('keep');
  store.insertTask(taskOf('t_rsm', { status: 'running' }));
  store.updateTask('t_rsm', { resume: { remoteId: 'remote_1', kind: 'video' } });
  const n = store.interruptStaleTasks();
  assert.strictEqual(n, 0, '不该中断有接续信息的任务');
  assert.strictEqual(store.getTask('t_rsm').status, 'running', '状态被改动了');
});

check('queued 与 running 都会被检查（等待中的也算）', () => {
  const store = makeSandbox('both');
  store.insertTask(taskOf('t_q', { status: 'queued' }));
  store.insertTask(taskOf('t_r', { status: 'running' }));
  assert.strictEqual(store.interruptStaleTasks(), 2);
});

check('已经结束的任务不受影响（done 不该被翻成中断）', () => {
  const store = makeSandbox('done');
  store.insertTask(taskOf('t_done', { status: 'done', stage: '完成' }));
  store.insertTask(taskOf('t_fail', { status: 'failed', error: '平台报错' }));
  assert.strictEqual(store.interruptStaleTasks(), 0, '不该动已结束的任务');
  assert.strictEqual(store.getTask('t_done').status, 'done');
  assert.strictEqual(store.getTask('t_fail').error, '平台报错', '已失败的原因被覆盖了');
});

check('resume_json 是空串 / 只有空白时也算「没有接续信息」', () => {
  const store = makeSandbox('emptyresume');
  store.insertTask(taskOf('t_blank', { status: 'running' }));
  // 直接写库模拟历史遗留的空串
  store.updateTask('t_blank', { resume: '' });
  assert.strictEqual(store.interruptStaleTasks(), 1, '空串应被当成没有接续信息');
});

check('listResumableTasks 只挑出有接续信息且还在跑的', () => {
  const store = makeSandbox('list');
  store.insertTask(taskOf('t_a', { status: 'running' }));
  store.updateTask('t_a', { resume: { remoteId: 'r1' } });
  store.insertTask(taskOf('t_b', { status: 'queued' }));
  store.updateTask('t_b', { resume: { remoteId: 'r2' } });
  store.insertTask(taskOf('t_c', { status: 'running' })); // 没接续信息
  store.insertTask(taskOf('t_d', { status: 'done' }));
  store.updateTask('t_d', { resume: { remoteId: 'r3' } });
  const list = store.listResumableTasks();
  const ids = list.map((item) => item.id).sort();
  assert.deepStrictEqual(ids, ['t_a', 't_b'], '挑出来的不对：' + ids.join(','));
});

check('接续列表按开始时间正序（先提交的先接着等）', () => {
  const store = makeSandbox('order');
  store.insertTask(taskOf('t_late', { createdAt: 3000, status: 'running' }));
  store.updateTask('t_late', { resume: { remoteId: 'r1' } });
  store.insertTask(taskOf('t_early', { createdAt: 1000, status: 'running' }));
  store.updateTask('t_early', { resume: { remoteId: 'r2' } });
  assert.deepStrictEqual(store.listResumableTasks().map((item) => item.id), ['t_early', 't_late']);
});

console.log('\n[2] 接续记录的往返');

check('resume 写库再读出来，字段一字不差', () => {
  const store = makeSandbox('roundtrip');
  store.insertTask(taskOf('t1', { status: 'running' }));
  const record = {
    kind: 'video',
    channelId: 'ch_1',
    channelName: '通道甲',
    model: 'video-model-1',
    size: '1K',
    prompt: '一只橘猫在窗台上',
    refs: [{ kind: 'image', url: '/素材/a.png', role: 'reference_image', remoteId: 'rf_1' }],
    remoteId: 'remote_abc',
    queryPath: '/videos/status',
    statusField: 'data.status',
    doneValues: 'succeeded',
    failValues: 'failed',
    resultUrl: 'data.url',
    intervalSec: 5,
    maxWaitSec: 1800,
    startedAt: 111,
    deadlineAt: 222,
    attempt: 3,
    params: { size: '1K', duration: 5 },
    version: 1,
  };
  store.updateTask('t1', { resume: record });
  const back = store.getTask('t1').resume;
  assert.deepStrictEqual(back, record, '接续记录往返后不一致');
});

check('没有接续记录时读出 null（不是空对象）', () => {
  const store = makeSandbox('null');
  store.insertTask(taskOf('t1'));
  assert.strictEqual(store.getTask('t1').resume, null);
});

check('可以清掉接续记录（任务跑完后再接续就没意义了）', () => {
  const store = makeSandbox('clear');
  store.insertTask(taskOf('t1', { status: 'running' }));
  store.updateTask('t1', { resume: { remoteId: 'r1' } });
  store.updateTask('t1', { resume: null });
  assert.strictEqual(store.getTask('t1').resume, null);
  // 清掉之后再中断，就该被判成中断了
  assert.strictEqual(store.interruptStaleTasks(), 1);
});

check('接续记录与 remote_id 列能分别写入、各自都不丢', () => {
  const store = makeSandbox('remoteid');
  store.insertTask(taskOf('t1', { status: 'running' }));
  // attach 会一次写这两样（见 [3.2]）；这里先确认底层两列都写得进去
  store.updateTask('t1', { resume: { remoteId: 'remote_xyz' }, remoteId: 'remote_xyz' });
  const after = store.getTask('t1');
  assert.strictEqual(after.remoteId, 'remote_xyz', 'remote_id 列没写进去');
  assert.strictEqual(after.resume.remoteId, 'remote_xyz', '接续记录里的任务号没写进去');
});

check('resume_json 列是升级加出来的（老库也能用）', () => {
  const storeSrc = fs.readFileSync(path.join(SERVER, 'store.js'), 'utf8');
  assert(
    storeSrc.indexOf("ALTER TABLE tasks ADD COLUMN resume_json TEXT") >= 0,
    '没有为老库补 resume_json 列的升级语句'
  );
});

console.log('\n[3] 接续记录的内容：够不够重放一次');

console.log('\n[3.1] buildWaitRecord 直接跑（纯函数）');

const generateSrc = fs.readFileSync(path.join(SERVER, 'generate.js'), 'utf8');

function pickFunction(src, name) {
  let at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('源码里找不到函数 ' + name);
  if (src.slice(Math.max(0, at - 6), at) === 'async ') at -= 6;
  let depth = 0;
  let started = false;
  for (let i = at; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error('函数 ' + name + ' 的花括号没配对');
}

const waitSandbox = { console: console, Math: Math, Number: Number, String: String, Array: Array, Boolean: Boolean, Date: Date };
vm.createContext(waitSandbox);
vm.runInContext(
  [pickFunction(generateSrc, 'waitRefsOf'), pickFunction(generateSrc, 'buildWaitRecord')].join('\n'),
  waitSandbox
);
const W = waitSandbox;

function fakeChannel() {
  return {
    id: 'ch_1',
    name: '通道甲',
    poll: {
      path: '/videos/status',
      listField: '',
      listIdField: 'id',
      method: 'GET',
      statusField: 'data.status',
      doneValues: 'succeeded',
      failValues: 'failed',
      resultUrl: 'data.url',
      resultB64: '',
      errorField: 'data.error',
      downloadPath: '',
      downloadIdPath: '',
      downloadUrlField: '',
      intervalSec: 5,
      maxWaitSec: 1800,
    },
  };
}

check('接续记录里有远端任务号（重放的第一块砖）', () => {
  const rec = W.buildWaitRecord(fakeChannel(), 'video', fakeChannel(), { params: {} }, 'm1', '1K', '一只猫', 'remote_1', []);
  assert.strictEqual(rec.remoteId, 'remote_1');
});

check('接续记录里有通道与模型（重启后要能找到同一个通道）', () => {
  const rec = W.buildWaitRecord(fakeChannel(), 'video', fakeChannel(), { params: {} }, 'm1', '1K', '一只猫', 'remote_1', []);
  assert.strictEqual(rec.channelId, 'ch_1');
  assert.strictEqual(rec.channelName, '通道甲');
  assert.strictEqual(rec.model, 'm1');
  assert.strictEqual(rec.kind, 'video');
});

check('接续记录里有查询路径与取值规则（平台配置不同，必须冻结当时那份）', () => {
  const rec = W.buildWaitRecord(fakeChannel(), 'video', fakeChannel(), { params: {} }, 'm1', '1K', '一只猫', 'remote_1', []);
  assert.strictEqual(rec.queryPath, '/videos/status');
  assert.strictEqual(rec.statusField, 'data.status');
  assert.strictEqual(rec.doneValues, 'succeeded');
  assert.strictEqual(rec.failValues, 'failed');
  assert.strictEqual(rec.resultUrl, 'data.url');
  assert.strictEqual(rec.errorField, 'data.error');
});

check('接续记录里有截止时间与已等时长（不能重启一次就从头计时）', () => {
  const before = Date.now();
  const rec = W.buildWaitRecord(fakeChannel(), 'video', fakeChannel(), { params: {} }, 'm1', '1K', '一只猫', 'remote_1', []);
  assert(rec.startedAt >= before, '没有记开始时间');
  assert(rec.deadlineAt > rec.startedAt, '没有记截止时间');
  assert.strictEqual(rec.deadlineAt - rec.startedAt, rec.maxWaitSec * 1000, '截止时间与最长等待对不上');
  assert.strictEqual(rec.attempt, 0, '尝试次数应从 0 算起');
});

check('接续记录里有冻结的参考素材快照（重启后卡片展示「本次提交」还完整）', () => {
  const refs = [{ src: '/素材/a.png', name: 'a.png', kind: 'image', role: 'reference_image', remoteId: 'rf_1' }];
  const rec = W.buildWaitRecord(fakeChannel(), 'video', fakeChannel(), { params: {} }, 'm1', '1K', '一只猫', 'remote_1', refs);
  assert(Array.isArray(rec.refs), '没有冻结参考素材');
  assert.strictEqual(rec.refs.length, 1);
  assert.strictEqual(rec.refs[0].src, '/素材/a.png', '原始地址没冻结');
  assert.strictEqual(rec.refs[0].role, 'reference_image', '角色没冻结');
  assert.strictEqual(rec.refs[0].remoteId, 'rf_1', '上传后的远端编号没留下（排查时要用）');
});

check('冻结参考素材时丢掉字节本身（几 MB 的 buffer 不该进库）', () => {
  const refs = [{ src: '/素材/a.png', buffer: Buffer.alloc(1024), mime: 'image/png' }];
  const rec = W.buildWaitRecord(fakeChannel(), 'video', fakeChannel(), { params: {} }, 'm1', '1K', '猫', 'r', refs);
  const keys = Object.keys(rec.refs[0]).sort();
  assert(keys.indexOf('buffer') < 0, '把字节也存进去了，库会被撑大：' + keys.join(','));
  assert(keys.indexOf('mime') < 0, '存了用不上的字段');
  assert(keys.join(',') === 'kind,name,remoteId,role,src', '冻结的字段清单变了：' + keys.join(','));
});

check('接续记录带版本号（以后改形状时能据此兼容）', () => {
  const rec = W.buildWaitRecord(fakeChannel(), 'video', fakeChannel(), { params: {} }, 'm1', '1K', '一只猫', 'remote_1', []);
  assert.strictEqual(rec.version, 1);
});

check('最大等待时间有下限兜底（配置写坏了也不会立刻判死）', () => {
  const ch = fakeChannel();
  ch.poll.maxWaitSec = 0;
  const rec = W.buildWaitRecord(ch, 'video', ch, { params: {} }, 'm1', '1K', '猫', 'r', []);
  assert(rec.maxWaitSec >= 30, '下限没兜住：' + rec.maxWaitSec);
});

check('轮询间隔有下限（配置成 0 也不会连打接口）', () => {
  const ch = fakeChannel();
  ch.poll.intervalSec = 0;
  const rec = W.buildWaitRecord(ch, 'video', ch, { params: {} }, 'm1', '1K', '猫', 'r', []);
  assert(rec.intervalSec >= 1, '间隔下限没兜住：' + rec.intervalSec);
});

console.log('\n[3.2] 接续的执行路径（源码级约束）');

check('resumeTask 先校验接续信息，缺任务号就明确报错', () => {
  const body = pickFunction(generateSrc, 'resumeTask');
  assert(body.indexOf('record.remoteId') >= 0, '没有检查远端任务号');
  assert(body.indexOf('没有可接续的信息') >= 0, '缺任务号时的提示不清');
});

check('resumeTask 用当时的通道配置去查（通道删了要说清）', () => {
  const body = pickFunction(generateSrc, 'resumeTask');
  assert(body.indexOf('findChannel') >= 0, '没有按记录里的通道去找');
  assert(body.indexOf('通道已经删掉了') >= 0, '通道缺失时的提示不清');
});

check('resumeTask 复用同一个 pollRemote（不另写一套轮询）', () => {
  const body = pickFunction(generateSrc, 'resumeTask');
  assert(body.indexOf('pollRemote(') >= 0, '没有复用轮询');
});

check('接续完成的结果标了 resumed（前端据此区分「这次没重新提交」）', () => {
  const body = pickFunction(generateSrc, 'resumeTask');
  assert(body.indexOf('resumed: true') >= 0, '没有标 resumed');
});

check('接续完成也报 refCount（卡片展示才完整）', () => {
  const body = pickFunction(generateSrc, 'resumeTask');
  assert(body.indexOf('refCount') >= 0, '没有报参考素材数量');
});

check('提交时就立刻记下接续信息（不能等结果出来才记）', () => {
  const at = generateSrc.indexOf('const record = buildWaitRecord(');
  assert(at >= 0, '找不到构造接续记录的位置');
  const after = generateSrc.slice(at, at + 600);
  assert(after.indexOf('ctx.attach(record)') >= 0, '构造完没有立刻存起来');
  assert(after.indexOf('pollRemote(') >= 0, '没有接着去轮询');
  assert(after.indexOf('ctx.attach(record)') < after.indexOf('pollRemote('), '存的顺序应在轮询之前');
});

check('ctx.attach 把接续信息写进库（并且同步远端任务号）', () => {
  const tasksSrc = fs.readFileSync(path.join(SERVER, 'tasks.js'), 'utf8');
  const at = tasksSrc.indexOf('attach: function (record)');
  assert(at >= 0, '找不到 attach');
  const body = tasksSrc.slice(at, at + 400);
  assert(body.indexOf('resume: record') >= 0, '没有写 resume');
  assert(body.indexOf('remoteId:') >= 0, '没有同步远端任务号');
});

console.log('\n[4] 启动时的顺序：先接续，再中断');

check('启动流程先 resumeAll 再 interruptStaleTasks（顺序反了会把能接的任务全掐掉）', () => {
  const indexSrc = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
  const resumeAt = indexSrc.indexOf('tasks.resumeAll(');
  const interruptAt = indexSrc.indexOf('store.interruptStaleTasks()');
  assert(resumeAt >= 0, '没有接续流程');
  assert(interruptAt >= 0, '没有中断流程');
  assert(resumeAt < interruptAt, '顺序反了：先标中断会把有接续信息的任务也一起掐掉');
});

check('接续与中断都留下日志（重启后知道发生了什么）', () => {
  const indexSrc = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
  const resumeAt = indexSrc.indexOf('tasks.resumeAll(');
  const block = indexSrc.slice(resumeAt, resumeAt + 700);
  assert(block.indexOf('继续接着等结果') >= 0, '接续没有日志');
  assert(block.indexOf('已标记为中断') >= 0, '中断没有日志');
});

check('resumeAll 逐条重放，并返回条数', () => {
  const tasksSrc = fs.readFileSync(path.join(SERVER, 'tasks.js'), 'utf8');
  const body = pickFunction(tasksSrc, 'resumeAll');
  assert(body.indexOf('listResumableTasks()') >= 0, '没有从库里取待接续列表');
  assert(body.indexOf('generate.resumeTask(') >= 0, '没有走接续执行');
  assert(body.indexOf('return list.length') >= 0, '没有返回条数');
});

console.log('\n[5] 端到端：一次重启之后，能接的接上、不能接的标中断');

check('一次完整重启的结果符合预期', () => {
  const store = makeSandbox('e2e');
  // 三条：能接续的、没接续信息的、已经跑完的
  store.insertTask(taskOf('t_keep', { status: 'running', createdAt: 1000 }));
  store.updateTask('t_keep', { resume: { remoteId: 'remote_keep', kind: 'video', model: 'm1' } });
  store.insertTask(taskOf('t_dead', { status: 'queued', createdAt: 2000 }));
  store.insertTask(taskOf('t_done', { status: 'done', createdAt: 3000 }));

  // 启动流程：先接续，再中断
  const resumable = store.listResumableTasks();
  assert.strictEqual(resumable.length, 1, '待接续数量不对');
  assert.strictEqual(resumable[0].id, 't_keep');
  const interrupted = store.interruptStaleTasks();
  assert.strictEqual(interrupted, 1, '应中断 1 条');

  assert.strictEqual(store.getTask('t_keep').status, 'running', '能接的没接上');
  assert.strictEqual(store.getTask('t_dead').status, 'failed', '不能接的没标出来');
  assert.strictEqual(store.getTask('t_done').status, 'done', '已完成的被动了');
});

check('重启两次不会互相影响（接续是幂等的）', () => {
  const store = makeSandbox('twice');
  store.insertTask(taskOf('t_keep', { status: 'running' }));
  store.updateTask('t_keep', { resume: { remoteId: 'r1' } });
  store.insertTask(taskOf('t_dead', { status: 'running' }));
  // 第一次重启
  assert.strictEqual(store.listResumableTasks().length, 1);
  assert.strictEqual(store.interruptStaleTasks(), 1);
  // 第二次重启：能接的还在，已中断的不再重复处理
  assert.strictEqual(store.listResumableTasks().length, 1, '第二次仍应能接上');
  assert.strictEqual(store.interruptStaleTasks(), 0, '已经标过中断的不该再数一次');
});

check('接续过程中任务被用户取消后，不再出现在待接续列表里', () => {
  const store = makeSandbox('cancel');
  store.insertTask(taskOf('t1', { status: 'running' }));
  store.updateTask('t1', { resume: { remoteId: 'r1' } });
  assert.strictEqual(store.listResumableTasks().length, 1);
  store.updateTask('t1', { status: 'failed', stage: '已取消' });
  assert.strictEqual(store.listResumableTasks().length, 0, '已取消的任务还挂在待接续里');
});

check('前端打开画布时会重新盯上还在跑的任务（页面关了也要能接回）', () => {
  const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const body = pickFunction(canvasSrc, 'resumeRunningTasks');
  assert(body.indexOf('data.running') >= 0, '没有检查还在跑的任务');
  assert(body.indexOf('watchTask(') >= 0, '没有重新盯上那个任务');
  assert(body.indexOf('data.taskId') >= 0, '没有用任务号去接');
});

check('前端遇到「在跑但没有任务号」的卡片会如实收尾（不是一直转圈）', () => {
  const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const body = pickFunction(canvasSrc, 'resumeRunningTasks');
  assert(body.indexOf('data.running = false') >= 0, '没有把这种卡片收尾');
  assert(body.indexOf('scheduleSave()') >= 0, '收尾之后没有安排保存（刷新一下又变回在跑）');
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
