'use strict';

// 轮询节奏模块的隔离测试（清单 38「拆分 canvas.js」第 2 步）。
//
// web/assets/task-poll.js 是任务轮询节奏的唯一出处：八个档位常量 + 四个判据函数。
// poll-adaptive.test.js 守的是「画布页用上了它、并且留了兜底」；
// 这里守的是**模块自己**：常量之间的关系、判据的边界、以及「不依赖浏览器环境」
// 这一条 —— 它是 UMD，服务端 require 进来就能跑，不许偷偷用 window / document。
//
// 运行：runtime/node.exe tools/tests/task-poll.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-taskpoll-'));
require(path.join(__dirname, '_isolate.js'))(box);

const poll = require(path.join(ROOT, 'web', 'assets', 'task-poll.js'));

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

console.log('\nF4 · task-poll.js（轮询节奏模块）');

console.log('\n[1] 导出完整：八个档位 + 四个判据');

check('导出了八个档位常量', () => {
  [
    'POLL_ADOPT_BUSY_MS',
    'POLL_ADOPT_QUEUED_MS',
    'POLL_ADOPT_IDLE_MS',
    'POLL_TASK_MS',
    'POLL_TASK_QUEUED_MS',
    'POLL_SCHEDULE_LIVE_MS',
    'POLL_SCHEDULE_IDLE_MS',
    'POLL_SCHEDULE_EMPTY_MS',
  ].forEach((name) => {
    assert(Number.isFinite(poll[name]) && poll[name] > 0, name + ' 不是正数：' + poll[name]);
  });
});

check('导出了四个判据函数', () => {
  ['isQueuedStage', 'nextAdoptDelay', 'nextTaskPollDelay', 'nextSchedulePollDelay'].forEach((name) => {
    eq(typeof poll[name], 'function', name + ' 不是函数');
  });
});

console.log('\n[2] 档位之间的关系（越没事问得越慢）');

check('接管轮询：忙碌 < 排队 < 待机', () => {
  assert(poll.POLL_ADOPT_BUSY_MS < poll.POLL_ADOPT_QUEUED_MS, '排队档应比忙碌档慢');
  assert(poll.POLL_ADOPT_QUEUED_MS < poll.POLL_ADOPT_IDLE_MS, '待机档应比排队档还慢');
});

check('单卡轮询：排队比正常慢', () => {
  assert(poll.POLL_TASK_MS < poll.POLL_TASK_QUEUED_MS, '排队档应更慢');
});

check('定时组：live < idle < empty', () => {
  assert(poll.POLL_SCHEDULE_LIVE_MS < poll.POLL_SCHEDULE_IDLE_MS, 'live 应比 idle 快');
  assert(poll.POLL_SCHEDULE_IDLE_MS < poll.POLL_SCHEDULE_EMPTY_MS, 'idle 应比 empty 快');
});

check('定时组在最忙时问得比单卡还勤（要盯住每张的进展）', () => {
  assert(poll.POLL_SCHEDULE_LIVE_MS < poll.POLL_TASK_MS, 'live 应比单卡档更密');
});

check('待机档不会密到离谱（心跳至少 10 秒）', () => {
  assert(poll.POLL_ADOPT_IDLE_MS >= 10000, '待机心跳太密：' + poll.POLL_ADOPT_IDLE_MS);
  assert(poll.POLL_SCHEDULE_EMPTY_MS >= 10000, '空档心跳太密：' + poll.POLL_SCHEDULE_EMPTY_MS);
});

console.log('\n[3] isQueuedStage：认出后端实际会出现的排队文案');

check('「排队中」算排队', () => eq(poll.isQueuedStage('排队中'), true));
check('「已提交，正在等结果」算排队（tasks.js 的 attach 用这句）', () => {
  eq(poll.isQueuedStage('已提交，正在等结果'), true);
});
check('「生成中…（还排在队列里，已等 3 分钟）」算排队（中间没有连着的「排队」）', () => {
  eq(poll.isQueuedStage('生成中…（还排在队列里，已等 3 分钟）'), true);
});
check('「准备中」「正在保存…」不算排队', () => {
  eq(poll.isQueuedStage('准备中'), false);
  eq(poll.isQueuedStage('正在保存到 素材\\图片'), false);
});
check('空值 / null / undefined 不算排队，也不抛', () => {
  eq(poll.isQueuedStage(''), false);
  eq(poll.isQueuedStage(null), false);
  eq(poll.isQueuedStage(undefined), false);
});
check('传数字 / 对象也不抛（调用方可能漏了归一）', () => {
  eq(poll.isQueuedStage(0), false);
  eq(poll.isQueuedStage({}), false);
});

console.log('\n[4] nextAdoptDelay 的分档与边界');

check('页面藏起来：返回 0（先不排，切回来补一次）', () => {
  eq(poll.nextAdoptDelay({ hidden: true, busy: true, queuedOnly: false }), 0);
  eq(poll.nextAdoptDelay({ hidden: true, busy: false }), 0);
});
check('有任务在实际生成：忙碌档', () => {
  eq(poll.nextAdoptDelay({ hidden: false, busy: true, queuedOnly: false }), poll.POLL_ADOPT_BUSY_MS);
});
check('任务全在排队：排队档', () => {
  eq(poll.nextAdoptDelay({ hidden: false, busy: true, queuedOnly: true }), poll.POLL_ADOPT_QUEUED_MS);
});
check('没有任务在跑：待机档', () => {
  eq(poll.nextAdoptDelay({ hidden: false, busy: false, queuedOnly: false }), poll.POLL_ADOPT_IDLE_MS);
});
check('busy 缺省按「没任务」处理（不会误判成忙碌）', () => {
  eq(poll.nextAdoptDelay({ hidden: false }), poll.POLL_ADOPT_IDLE_MS);
  eq(poll.nextAdoptDelay(null), poll.POLL_ADOPT_IDLE_MS);
  eq(poll.nextAdoptDelay(), poll.POLL_ADOPT_IDLE_MS);
});
check('busy 为真但 queuedOnly 缺省：走忙碌档（不猜成排队）', () => {
  eq(poll.nextAdoptDelay({ hidden: false, busy: true }), poll.POLL_ADOPT_BUSY_MS);
});

console.log('\n[5] nextTaskPollDelay 的分档');

check('正常生成中：正常档', () => {
  eq(poll.nextTaskPollDelay({ hidden: false, queued: false }), poll.POLL_TASK_MS);
});
check('还在排队：排队档', () => {
  eq(poll.nextTaskPollDelay({ hidden: false, queued: true }), poll.POLL_TASK_QUEUED_MS);
});
check('页面藏起来：返回 0（等切回来统一唤醒）', () => {
  eq(poll.nextTaskPollDelay({ hidden: true, queued: false }), 0);
  eq(poll.nextTaskPollDelay({ hidden: true, queued: true }), 0);
});
check('空状态不抛', () => {
  eq(poll.nextTaskPollDelay(null), poll.POLL_TASK_MS);
});

console.log('\n[6] nextSchedulePollDelay 的分档');

check('有成员正在跑：live 档', () => {
  eq(poll.nextSchedulePollDelay({ hidden: false, groups: 3, live: true }), poll.POLL_SCHEDULE_LIVE_MS);
});
check('有定时组但都空闲：idle 档', () => {
  eq(poll.nextSchedulePollDelay({ hidden: false, groups: 3, live: false }), poll.POLL_SCHEDULE_IDLE_MS);
});
check('本画布没有定时组：empty 档（留着是为了发现新建的组）', () => {
  eq(poll.nextSchedulePollDelay({ hidden: false, groups: 0, live: false }), poll.POLL_SCHEDULE_EMPTY_MS);
});
check('页面藏起来：返回 0', () => {
  eq(poll.nextSchedulePollDelay({ hidden: true, groups: 3, live: true }), 0);
});
check('live 优先于 groups（有成员在跑就按 live）', () => {
  eq(poll.nextSchedulePollDelay({ hidden: false, groups: 0, live: true }), poll.POLL_SCHEDULE_LIVE_MS);
});

console.log('\n[7] 这是纯模块：不许依赖浏览器环境');

const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'task-poll.js'), 'utf8');

check('模块里没有 window / document / navigator', () => {
  // UMD 的 wrapper 里会出现 root，但不该出现这几个浏览器专有的东西。
  // 只看代码行 —— 注释里为了说明加载方式写了 window.CanvasTaskPoll，不算依赖。
  const code = src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  ['window.', 'document.', 'navigator.'].forEach((needle) => {
    assert(code.indexOf(needle) < 0, '模块里用了 ' + needle + '，服务端 require 会炸');
  });
});

check('没有定时器 / 网络调用（纯判断，不产生副作用）', () => {
  ['setTimeout', 'setInterval', 'fetch(', 'XMLHttpRequest'].forEach((needle) => {
    assert(src.indexOf(needle) < 0, '模块里有副作用：' + needle);
  });
});

check('是 UMD：浏览器挂 window.CanvasTaskPoll，Node 走 module.exports', () => {
  assert(src.indexOf('root.CanvasTaskPoll = api') >= 0, '没有给浏览器挂全局名');
  assert(src.indexOf('module.exports = api') >= 0, '没有导出给 Node');
  eq(typeof poll, 'object', 'require 进来不是对象');
});

check('模块加载两次拿到的是同一份（不重复定义常量）', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'web', 'assets', 'task-poll.js'))];
  const again = require(path.join(ROOT, 'web', 'assets', 'task-poll.js'));
  eq(again.POLL_TASK_MS, poll.POLL_TASK_MS);
  eq(again.isQueuedStage('排队中'), true);
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
