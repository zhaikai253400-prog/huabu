(function (root, factory) {
  // 轮询节奏的判据（清单 38「拆分 canvas.js」第 2 步）。
  //
  // 为什么挑这一块先拆：它是画布逻辑里少见的**整块纯判断** ——
  // 不碰 DOM、不读 nodes、不依赖任何运行时状态，输入几个布尔量、输出一个毫秒数。
  // 抽出来最直接的收益是**可测性**：原来这四个函数只能靠「源码切片 + vm 沙箱」
  // 测（切片一碰到花括号配对出错就整段失效），现在能直接 require 进来。
  //
  // 这一块同时也是「一天白问上万次」的源头：页面以前是无条件按固定节奏问接口，
  // 不管有没有任务在跑、也不管是不是缩在后台。现在的做法是「跑完一轮自己决定
  // 下一轮隔多久」，判据就集中在这里 —— 所以它们值得单独有个家。
  //
  // 与 payload-rules.js / utils.js 同一种加载方式：
  //   浏览器：window.CanvasTaskPoll
  //   Node  ：require('../web/assets/task-poll.js')
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.CanvasTaskPoll = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- 三套节奏的档位 ----------
  // 接管轮询：问「本画布还有哪些任务在跑」（交给卡片补齐状态）
  const POLL_ADOPT_BUSY_MS = 5000; // 本画布有任务在跑：跟原来一样
  const POLL_ADOPT_QUEUED_MS = 10000; // 任务都还在平台排队：拉长一倍
  const POLL_ADOPT_IDLE_MS = 30000; // 本画布没有任务在跑：降到 30 秒心跳

  // 单张卡片：问「这条任务出结果了吗」
  const POLL_TASK_MS = 2000; // 正常跟进
  const POLL_TASK_QUEUED_MS = 10000; // 还在排队，问那么勤也没用

  // 定时组：问「到点该跑的那批跑了没」
  const POLL_SCHEDULE_LIVE_MS = 1500; // 有成员正在跑
  const POLL_SCHEDULE_IDLE_MS = 5000; // 有定时组但都空闲
  const POLL_SCHEDULE_EMPTY_MS = 15000; // 本画布没有定时组

  // 「还在平台排队」的判据。后端的 stage 文案实际有这几种：
  //   「排队中」（server/tasks.js 建任务时）
  //   「已提交，正在等结果」（server/tasks.js 的 attach）
  //   「生成中…（还排在队列里，已等 3 分钟）」（server/generate.js 拉列表还没找到自己那条）
  // 注意第三种是「排在队列里」，中间并没有连着的「排队」两字，所以关键词取
  // 「排队」「队列」「正在等结果」三个，单靠「排队」会漏掉第三种。
  function isQueuedStage(stage) {
    const text = String(stage || '');
    return text.indexOf('排队') >= 0 || text.indexOf('队列') >= 0 || text.indexOf('正在等结果') >= 0;
  }

  // 下一轮「接管别处提交的任务」该隔多久。
  // hidden：页面藏起来了，先不排，切回来时 immediately 补一次。
  function nextAdoptDelay(state) {
    const s = state || {};
    if (s.hidden) return 0;
    if (s.busy) return s.queuedOnly ? POLL_ADOPT_QUEUED_MS : POLL_ADOPT_BUSY_MS;
    return POLL_ADOPT_IDLE_MS;
  }

  // 单张卡片下一轮该隔多久。hidden 同样先不排，等切回页面统一唤醒。
  function nextTaskPollDelay(state) {
    const s = state || {};
    if (s.hidden) return 0;
    if (s.queued) return POLL_TASK_QUEUED_MS;
    return POLL_TASK_MS;
  }

  // 定时组下一轮该隔多久。越没事问得越慢：live < idle < empty。
  function nextSchedulePollDelay(state) {
    const s = state || {};
    if (s.hidden) return 0;
    if (s.live) return POLL_SCHEDULE_LIVE_MS;
    if (s.groups) return POLL_SCHEDULE_IDLE_MS;
    return POLL_SCHEDULE_EMPTY_MS;
  }

  return {
    POLL_ADOPT_BUSY_MS: POLL_ADOPT_BUSY_MS,
    POLL_ADOPT_QUEUED_MS: POLL_ADOPT_QUEUED_MS,
    POLL_ADOPT_IDLE_MS: POLL_ADOPT_IDLE_MS,
    POLL_TASK_MS: POLL_TASK_MS,
    POLL_TASK_QUEUED_MS: POLL_TASK_QUEUED_MS,
    POLL_SCHEDULE_LIVE_MS: POLL_SCHEDULE_LIVE_MS,
    POLL_SCHEDULE_IDLE_MS: POLL_SCHEDULE_IDLE_MS,
    POLL_SCHEDULE_EMPTY_MS: POLL_SCHEDULE_EMPTY_MS,
    isQueuedStage: isQueuedStage,
    nextAdoptDelay: nextAdoptDelay,
    nextTaskPollDelay: nextTaskPollDelay,
    nextSchedulePollDelay: nextSchedulePollDelay,
  };
});
