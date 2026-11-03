'use strict';

// E2 轮询频率自适应（清单 34）的隔离测试。
//
// 背景：页面以前是「固定节奏无条件问接口」——
//   · 接管轮询：setInterval 5 秒，不管本画布有没有任务在跑，也不管页面是不是
//     缩在后台，一天下来能白问上万次；
//   · 单卡轮询：setTimeout 固定 2 秒，任务还在平台排队时问得再勤也快不了；
//   · 定时组轮询：setInterval 1.5 秒，是本文件里最密的那个。
//
// 现在改成「跑完一轮自己决定下一轮隔多久」，判据都是不碰 DOM 的纯函数。
// 这里守三件事：
//   1. 三个 nextXxxDelay 的分档数值与档位边界（hidden / 排队 / 空闲 / 无任务）；
//   2. isQueuedStage 能认出后端实际出现的几种排队文案；
//   3. 源码层面确实换成自调度了 —— 老的固定 setInterval 不许留着，
//      页面切回来要有唤醒路径（否则「藏起来停排」会变成「切回来永远不动」）。
//
// 运行：runtime/node.exe tools/tests/poll-adaptive.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-poll-'));
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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function eq(got, want, msg) {
  if (got !== want) {
    throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
  }
}

const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');

function pickFunction(name) {
  const at = canvasSrc.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('源码里找不到函数 ' + name);
  let depth = 0;
  let started = false;
  for (let i = at; i < canvasSrc.length; i += 1) {
    const ch = canvasSrc[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return canvasSrc.slice(at, i + 1);
    }
  }
  throw new Error('函数 ' + name + ' 的花括号没配对');
}

// 常量直接从源码取值，避免测试里再抄一份、改了常量测试却还绿
function pickConst(name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);');
  const m = canvasSrc.match(re);
  if (!m) throw new Error('源码里找不到常量 ' + name);
  return m[1].trim();
}

const CONSTS = [
  'POLL_ADOPT_BUSY_MS',
  'POLL_ADOPT_QUEUED_MS',
  'POLL_ADOPT_IDLE_MS',
  'POLL_TASK_MS',
  'POLL_TASK_QUEUED_MS',
  'POLL_SCHEDULE_LIVE_MS',
  'POLL_SCHEDULE_IDLE_MS',
  'POLL_SCHEDULE_EMPTY_MS',
];

const sandbox = {
  console: console,
  String: String,
  Number: Number,
  Math: Math,
};
vm.createContext(sandbox);
vm.runInContext([]
  .concat(CONSTS.map((name) => 'var ' + name + ' = ' + pickConst(name) + ';'))
  .concat([
    pickFunction('isQueuedStage'),
    pickFunction('nextAdoptDelay'),
    pickFunction('nextTaskPollDelay'),
    pickFunction('nextSchedulePollDelay'),
  ])
  .join('\n'), sandbox);

const {
  isQueuedStage,
  nextAdoptDelay,
  nextTaskPollDelay,
  nextSchedulePollDelay,
} = sandbox;

// 从源码里读出各档的实际数值，后面断言用它，避免测试里硬编码
const N = {};
CONSTS.forEach((name) => {
  N[name] = vm.runInContext(name, sandbox);
});

console.log('E2 · isQueuedStage：认出后端实际的排队文案');
check('「排队中」算排队', () => eq(isQueuedStage('排队中'), true));
check('「已提交，正在等结果」算排队', () => {
  // server/tasks.js 的 attach 里就是这句，属于接口侧排队
  eq(isQueuedStage('已提交，正在等结果'), true);
});
check('「生成中…（还排在队列里，已等 3 分钟）」算排队', () => {
  eq(isQueuedStage('生成中…（还排在队列里，已等 3 分钟）'), true);
});
check('「准备中」「正在保存…」不算排队', () => {
  eq(isQueuedStage('准备中'), false);
  eq(isQueuedStage('正在保存到 素材\\图片'), false);
});
check('空值 / undefined 不算排队，也不会抛', () => {
  eq(isQueuedStage(''), false);
  eq(isQueuedStage(null), false);
  eq(isQueuedStage(undefined), false);
});

console.log('E2 · 接管轮询：按「有没有任务在跑」分档');
check('页面藏起来：先不排下一轮（返回 0）', () => {
  eq(nextAdoptDelay({ hidden: true, busy: true, queuedOnly: false }), 0);
  eq(nextAdoptDelay({ hidden: true, busy: false }), 0);
});
check('有任务在实际生成：保持原来的 5 秒', () => {
  eq(nextAdoptDelay({ hidden: false, busy: true, queuedOnly: false }), N.POLL_ADOPT_BUSY_MS);
});
check('任务全在平台排队：拉长到 10 秒', () => {
  eq(nextAdoptDelay({ hidden: false, busy: true, queuedOnly: true }), N.POLL_ADOPT_QUEUED_MS);
});
check('本画布没有任务在跑：降到 30 秒心跳', () => {
  eq(nextAdoptDelay({ hidden: false, busy: false, queuedOnly: false }), N.POLL_ADOPT_IDLE_MS);
});
check('待机档确实比忙碌档慢，且比排队档还慢', () => {
  assert(N.POLL_ADOPT_IDLE_MS > N.POLL_ADOPT_QUEUED_MS, '待机应比排队档更慢');
  assert(N.POLL_ADOPT_QUEUED_MS > N.POLL_ADOPT_BUSY_MS, '排队档应比忙碌档更慢');
});
check('busy 缺省时按「没任务」处理，不会误判成忙碌', () => {
  eq(nextAdoptDelay({ hidden: false }), N.POLL_ADOPT_IDLE_MS);
  eq(nextAdoptDelay(null), N.POLL_ADOPT_IDLE_MS);
});

console.log('E2 · 单卡轮询：排队时不必追那么勤');
check('正常生成中：2 秒', () => {
  eq(nextTaskPollDelay({ hidden: false, queued: false }), N.POLL_TASK_MS);
});
check('还在排队：10 秒', () => {
  eq(nextTaskPollDelay({ hidden: false, queued: true }), N.POLL_TASK_QUEUED_MS);
});
check('页面藏起来：不排（等切回来统一唤醒）', () => {
  eq(nextTaskPollDelay({ hidden: true, queued: false }), 0);
  eq(nextTaskPollDelay({ hidden: true, queued: true }), 0);
});

console.log('E2 · 定时组轮询：1.5 秒的无条件查询是最费的那个');
check('有成员正在跑：保持 1.5 秒', () => {
  eq(nextSchedulePollDelay({ hidden: false, groups: 3, live: true }), N.POLL_SCHEDULE_LIVE_MS);
});
check('有定时组但都空闲：降到 5 秒', () => {
  eq(nextSchedulePollDelay({ hidden: false, groups: 3, live: false }), N.POLL_SCHEDULE_IDLE_MS);
});
check('本画布没有定时组：15 秒心跳', () => {
  eq(nextSchedulePollDelay({ hidden: false, groups: 0, live: false }), N.POLL_SCHEDULE_EMPTY_MS);
});
check('页面藏起来：不排', () => {
  eq(nextSchedulePollDelay({ hidden: true, groups: 3, live: true }), 0);
});
check('三档递减：live < idle < empty（越没事越慢）', () => {
  assert(N.POLL_SCHEDULE_LIVE_MS < N.POLL_SCHEDULE_IDLE_MS, 'live 应比 idle 快');
  assert(N.POLL_SCHEDULE_IDLE_MS < N.POLL_SCHEDULE_EMPTY_MS, 'idle 应比 empty 快');
});

console.log('E2 · 源码层面：确实换成自调度了');
check('接管轮询不再用固定的 setInterval', () => {
  assert(canvasSrc.indexOf('setInterval(adoptActiveTasks') < 0, '老的 setInterval 还在');
  assert(canvasSrc.indexOf('let taskAdoptTimer = null') >= 0, '自调度用的 timer 变量不见了');
});
check('接管轮询有「跑完一轮再定下一次」的调度函数', () => {
  assert(canvasSrc.indexOf('function scheduleAdoptRound(') >= 0, '缺 scheduleAdoptRound');
  assert(canvasSrc.indexOf('function runAdoptRound(') >= 0, '缺 runAdoptRound');
  assert(canvasSrc.indexOf('nextAdoptDelay(') >= 0, '调度没有用上分档函数');
});
check('单卡轮询用 nextTaskPollDelay 决定间隔', () => {
  const watch = pickFunction('watchTask');
  assert(watch.indexOf('nextTaskPollDelay(') >= 0, 'watchTask 还是写死的间隔');
  assert(watch.indexOf('setTimeout(tick, 2000)') < 0, 'watchTask 里还留着写死的 2 秒');
});
check('定时组轮询不再用固定的 setInterval', () => {
  assert(canvasSrc.indexOf('setInterval(() => {\n      pollSchedules();') < 0, '老的定时组 setInterval 还在');
  assert(canvasSrc.indexOf('function runScheduleRound(') >= 0, '缺 runScheduleRound');
  assert(canvasSrc.indexOf('nextSchedulePollDelay(') >= 0, '定时组调度没有用上分档函数');
});
check('页面切回来有唤醒路径（否则「停排」会变成「永远不动」）', () => {
  const starter = pickFunction('startTaskAdoption');
  assert(starter.indexOf('visibilitychange') >= 0, 'startTaskAdoption 没监听 visibilitychange');
  assert(starter.indexOf('runAdoptRound()') >= 0, '切回来没有立刻补一次接管轮询');
  assert(starter.indexOf('resumeWatches()') >= 0, '切回来没有把单卡轮询叫起来');
  assert(canvasSrc.indexOf('function resumeWatches(') >= 0, '缺 resumeWatches');
});
check('小地图的兜底重画在后台跳过（画了也没人看）', () => {
  // 兜底那处是 2500ms 的周期重画，按这个特征定位，
  // 别抓到前面普通的「改了卡片就重画小地图」那几处。
  const at = canvasSrc.indexOf('}, 2500);');
  assert(at > 0, '找不到小地图兜底重画（2500ms 周期）');
  const near = canvasSrc.slice(Math.max(0, at - 300), at);
  assert(near.indexOf('if (mmShown) scheduleMinimap();') >= 0, '兜底重画的内容变了');
  assert(near.indexOf('document.hidden') >= 0, '小地图兜底没有先判断页面是否可见');
});
check('断线时不掉进待机档（否则会错过刚提交的任务）', () => {
  const adopt = pickFunction('adoptActiveTasks');
  const catchAt = adopt.indexOf('catch (error)');
  assert(catchAt > 0, 'adoptActiveTasks 里找不到 catch');
  const tail = adopt.slice(catchAt, catchAt + 200);
  assert(tail.indexOf('busy: true') >= 0, '接口失败时没有保持忙碌档');
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52));
process.exit(fail ? 1 : 0);
