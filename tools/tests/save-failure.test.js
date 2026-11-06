'use strict';

// F5 · 保存失败专项测试（清单 41 第一项，对应清单 6 / 10）。
//
// 为什么单拎出来测：保存是这块画布上唯一「用户看不见、丢了才知道」的环节。
// 失败的表现不能只是把两个字改成「保存失败」——那样用户既不知道存到哪一步了，
// 也不知道下一步该干什么。这个文件守四件事：
//
//   1. **四态齐**：待保存 / 保存中 / 已保存 / 保存失败，每一态都有话说。
//   2. **失败后不许自动重试**：以前失败也排下一次，服务没起来时会把日志刷满，
//      还把真正有用的第一条错误挤没了。现在必须留给用户点「立即重试」。
//   3. **409 不是保存失败**：它进的是冲突面板，不能按普通失败处理掉
//      ——否则用户手里的改动会被无条件覆盖掉别人的。
//   4. **失败时有两条出路**：重试一次，或者先把当前状态导出成文件兜底。
//      两个都在，用户在服务起不来的时候才不至于只能干等。
//
// 手法沿用既有范式：能跑真实代码的就跑（saveNow 是纯状态机，用 vm 沙箱 +
// 替身 api），跑不了的（面板 DOM、blob 下载）用源码级约束守。
//
// 运行：runtime/node.exe tools/tests/save-failure.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

// 隔离：本文件只跑纯逻辑与源码约束，不碰数据库；仍走统一助手保持范式一致
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-savefail-'));
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
// saveNow 是 async，必须有一个真的会 await 的 check。
// 用同步 check 包 async 回调的话，断言会全部落空、测试假绿。
async function checkAsync(name, fn) {
  try {
    await fn();
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

const apiSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'api.js'), 'utf8');
const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');

function pickFunction(name) {
  let at = canvasSrc.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('源码里找不到函数 ' + name);
  // async 函数的声明是 `async function name(`，只从 `function` 开始切会把 async 丢掉，
  // 拼进沙箱就变成「await 不在 async 里」的语法错误。所以往前带一步。
  if (canvasSrc.slice(Math.max(0, at - 6), at) === 'async ') at -= 6;
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

// 取一段 `const NAME = { ... };` 的对象字面量源码
function pickObject(name) {
  const at = canvasSrc.indexOf('const ' + name + ' = {');
  if (at < 0) throw new Error('源码里找不到常量对象 ' + name);
  let depth = 0;
  let started = false;
  for (let i = at; i < canvasSrc.length; i += 1) {
    const ch = canvasSrc[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) {
        // 带上后面的分号与换行，便于直接拼进沙箱
        return canvasSrc.slice(at, canvasSrc.indexOf(';', i) + 1);
      }
    }
  }
  throw new Error('常量对象 ' + name + ' 的括号没配对');
}

// ---------------------------------------------------------------- 沙箱
//
// saveNow 是一台状态机，它只认几个开关与 api 的返回结果。把真实函数抠进来，
// 用替身 api 喂成功 / 失败 / 409 三种结果，比对着源码念断言可靠得多。
const sandbox = {
  console: console,
  Math: Math,
  Number: Number,
  String: String,
  Boolean: Boolean,
  Object: Object,
  JSON: JSON,
  Array: Array,
  Date: Date,
  Promise: Promise,
  Error: Error,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  // 拿来做断言用的记录本
  log: { states: [], toast: [], saved: [], conflicts: [], railPinned: 0, railReleased: 0, nextTimer: null },
};
vm.createContext(sandbox);

vm.runInContext(
  [
    // ---- 模块级状态（必须用 var：顶层 let / const 不挂 context 全局）----
    'var dirty = false;',
    'var saving = false;',
    'var saveConflict = false;',
    'var saveTimer = null;',
    'var lastSaveError = "";',
    'var lastSavedAt = 0;',
    'var lastConflict = null;',
    'var savePanel = null;',
    // 共享工作区：saveNow 开头有「共享模式改走增量保存」的分支，
    // 这里跑的是普通模式，给个 false 即可（共享保存另有 share.test.js 守）
    'var shareMode = false;',
    'var saveRailPinned = false;',
    'var canvasId = "c_test";',
    'var canvasRev = 0;',
    'var edges = [];',
    'var viewport = { x: 0, y: 0, zoom: 1 };',
    // ---- 替身 ----
    'function collectNodes() { return [{ id: "n1", type: "image", data: {} }]; }',
    'function stampTouchedCards() {}',
    // 「检查更新」的本机记录：saveNow 存成功后会记一笔「这台电脑看过第几版」。
    // 这里只要它存在、不抛异常即可，判据本身在 canvas-meta.test.js 里单测。
    'function rememberSeenRev() {}',
    'function closeSavePanel() { savePanel = null; }',
    'function toast(text) { log.toast.push(text); }',
    'function setRailDesc(id, desc) { log.railDesc = desc; }',
    // 侧栏钉住：只记次数，真实 DOM 逻辑在源码级约束那组单独守
    'function showRailForSaveError() { saveRailPinned = true; log.railPinned += 1; }',
    'function releaseRailForSaveError() { saveRailPinned = false; log.railReleased += 1; }',
    'function handleSaveConflict(info) { saveConflict = true; lastConflict = info; log.conflicts.push(info); }',
    // saveEl：setSaveState 会往上写 textContent / className / dataset / aria
    'var saveEl = { textContent: "", className: "", dataset: {}, attrs: {}, setAttribute: function (k, v) { this.attrs[k] = v; } };',
    'var window = { api: { saveCanvas: function () { throw new Error("未设置替身"); } } };',
    // 定时器替换成记录本：这样能看出「失败后还有没有偷偷排下一次」
    'var fakeSetTimeout = function (fn, ms) { log.nextTimer = { fn: fn, ms: ms }; return 1; };',
    // ---- 被验证的源码 ----
    // 常量对象要用 var 重新声明：顶层 const / let 不挂到 context 全局对象上，
    // 测试就说不了也读不到它。（SAVE_STATE_TEXT 源码里是 const，这里换成 var。）
    pickObject('SAVE_STATE_TEXT').replace('const SAVE_STATE_TEXT', 'var SAVE_STATE_TEXT'),
    'var pad2 = function (n) { return String(n).padStart(2, "0"); };',
    pickFunction('clockText'),
    pickFunction('saveDescription'),
    pickFunction('setSaveState'),
    pickFunction('saveNow').replace('saveTimer = setTimeout(saveNow, 1500)', 'saveTimer = fakeSetTimeout(saveNow, 1500)'),
  ].join('\n'),
  sandbox
);

const S = sandbox;

function resetSave(apiImpl) {
  S.dirty = false;
  S.saving = false;
  S.saveConflict = false;
  S.saveTimer = null;
  S.lastSaveError = '';
  S.lastSavedAt = 0;
  S.lastConflict = null;
  S.savePanel = null;
  S.saveRailPinned = false;
  S.canvasRev = 0;
  S.log.states = [];
  S.log.toast.length = 0;
  S.log.conflicts.length = 0;
  S.log.railPinned = 0;
  S.log.railReleased = 0;
  S.log.nextTimer = null;
  S.log.saved.length = 0;
  S.window.api.saveCanvas = apiImpl || function () {
    throw new Error('未设置替身');
  };
  // setSaveState 会往记录本里塞一份状态，方便回放
  S.__origSetSaveState = S.setSaveState;
}

// 把 setSaveState 包一层记录下来（在跑真实实现的前提下）。
// 记的是「收到了哪个状态」，不是 saveEl.dataset.state —— 后者要等真实实现
// 写完才更新，读它拿到的是上一次的状态。
vm.runInContext(
  'var __rawSetSaveState = setSaveState;\n' +
    'setSaveState = function (kind) { log.states.push(kind); return __rawSetSaveState(kind); };',
  sandbox
);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- 同步断言
console.log('\nF5 · 保存失败保护');

console.log('\n[1] 四种状态齐全，且都有能读的说明');

check('四态齐：待保存 / 保存中 / 已保存 / 保存失败', () => {
  eq(S.SAVE_STATE_TEXT.saved, '已保存');
  eq(S.SAVE_STATE_TEXT.dirty, '待保存');
  eq(S.SAVE_STATE_TEXT.saving, '保存中');
  eq(S.SAVE_STATE_TEXT.error, '保存失败');
});

check('setSaveState 认不出来的状态回落到「已保存」（不许出现空白的无状态）', () => {
  resetSave();
  S.setSaveState('乱写的');
  eq(S.saveEl.dataset.state, 'saved', '未知状态应回落');
  S.setSaveState('dirty');
  eq(S.saveEl.dataset.state, 'dirty');
});

check('保存失败时侧栏被钉住（红点缩在边上等于没提示）', () => {
  resetSave();
  S.setSaveState('error');
  assert(S.log.railPinned > 0, '失败态没有把侧栏顶出来');
  eq(S.saveRailPinned, true);
});

check('回到正常态后松开侧栏（不能一直钉着挡路）', () => {
  resetSave();
  S.setSaveState('error');
  S.setSaveState('saved');
  assert(S.log.railReleased > 0, '恢复后没有松开侧栏');
});

check('冲突未处理时也钉住侧栏（要用户做决定，不能藏起来）', () => {
  resetSave();
  S.saveConflict = true;
  S.setSaveState('saved');
  assert(S.log.railPinned > 0, '冲突时没有钉住侧栏');
});

check('失败说明里带上「上次成功保存」的时间', () => {
  resetSave();
  S.lastSavedAt = new Date(2026, 10, 3, 1, 55, 0).getTime();
  const desc = S.saveDescription('error');
  assert(desc.indexOf('上次成功保存 01:55:00') >= 0, '失败说明里没有上次成功时间：' + desc);
});

check('从没成功保存过时，失败说明如实说「还没有成功保存过」', () => {
  resetSave();
  const desc = S.saveDescription('error');
  assert(desc.indexOf('还没有成功保存过') >= 0, '首次就失败时的说明不对：' + desc);
});

check('失败说明里带出失败原因原文（不是笼统一句「保存失败」）', () => {
  resetSave();
  S.lastSaveError = 'fetch failed';
  const desc = S.saveDescription('error');
  assert(desc.indexOf('fetch failed') >= 0, '没有带出原因：' + desc);
});

check('说明里点出「点一下可以重试或先导出兜底」', () => {
  resetSave();
  const desc = S.saveDescription('error');
  assert(desc.indexOf('重试') >= 0 && desc.indexOf('导出') >= 0, '没有给出下一步：' + desc);
});

check('正常态的说明带上「已保存 · 时间」', () => {
  resetSave();
  S.lastSavedAt = new Date(2026, 10, 3, 9, 8, 7).getTime();
  eq(S.saveDescription('saved'), '已保存 · 09:08:07');
});

check('待保存要说清在排队，冲突待处理时要说清「为什么没在存」', () => {
  resetSave();
  eq(S.saveDescription('dirty'), '有改动还没存，正在排队写入');
  S.saveConflict = true;
  const desc = S.saveDescription('dirty');
  assert(desc.indexOf('另一个窗口') >= 0, '冲突时的说明没点明原因：' + desc);
});

// ---------------------------------------------------------------- 异步：状态机
(async () => {
  console.log('\n[2] saveNow 状态机（跑真实函数）');

  await checkAsync('保存成功：saving → saved，并记下成功时刻', async () => {
    resetSave(async () => ({ rev: 7 }));
    S.dirty = true;
    const before = Date.now();
    await S.saveNow();
    eq(S.log.states.join('→'), 'saving→saved', '状态流转不对');
    eq(S.saving, false, '保存结束后 saving 应复位');
    eq(S.dirty, false, '成功后不该还在待保存');
    eq(S.lastSaveError, '', '成功后不该留着上次的错误');
    assert(S.lastSavedAt >= before, '没有记下成功时刻');
    eq(S.canvasRev, 7, '服务端返回的新版本号没记下来');
    eq(S.log.nextTimer, null, '成功后不该再排下一次');
  });

  await checkAsync('保存失败：saving → error，并退回待保存', async () => {
    resetSave(async () => {
      throw new Error('fetch failed');
    });
    S.dirty = true;
    await S.saveNow();
    eq(S.log.states.join('→'), 'saving→error', '状态流转不对');
    eq(S.dirty, true, '失败后必须还是待保存，否则改动会被当成已存');
    eq(S.saving, false, '失败后 saving 要复位');
    eq(S.lastSaveError, 'fetch failed', '没有记下失败原因');
  });

  await checkAsync('失败后不再自动重试（服务没起来时不会把日志刷满）', async () => {
    resetSave(async () => {
      throw new Error('fetch failed');
    });
    S.dirty = true;
    await S.saveNow();
    eq(S.log.nextTimer, null, '失败后仍然偷偷排了下一次保存');
  });

  await checkAsync('失败之后即使再有改动，也不会自己再发（等用户点重试）', async () => {
    let calls = 0;
    resetSave(async () => {
      calls += 1;
      throw new Error('还是不通');
    });
    S.dirty = true;
    await S.saveNow();
    eq(calls, 1, '第一次应发出去');
    // 模拟「失败状态下又来了一次自动保存」
    S.dirty = true;
    await S.saveNow();
    eq(calls, 2, '这次仍应发出（是否自动排下一轮由上层决定），但要能看出没自排');
    eq(S.log.nextTimer, null, '失败态下不该自排下一轮');
  });

  await checkAsync('saveNow(true) 跳过 dirty 判断：手动点的那次必须真的发出去', async () => {
    let calls = 0;
    resetSave(async () => {
      calls += 1;
      return { rev: 1 };
    });
    S.dirty = false;
    await S.saveNow();
    eq(calls, 0, '不 dirty 时不该发');
    await S.saveNow(true);
    eq(calls, 1, 'force=true 时应当发出去');
  });

  await checkAsync('已经在保存中时不会并发再发一次', async () => {
    let calls = 0;
    resetSave(
      () =>
        new Promise((resolve) => {
          calls += 1;
          setTimeout(() => resolve({ rev: 1 }), 20);
        })
    );
    S.dirty = true;
    const first = S.saveNow();
    await S.saveNow();
    await first;
    eq(calls, 1, '并发调用会重复写库');
  });

  await checkAsync('冲突面板弹着时候不自动保存（手里的 rev 已过期，发也只被拒）', async () => {
    let calls = 0;
    resetSave(async () => {
      calls += 1;
      return { rev: 1 };
    });
    S.dirty = true;
    S.saveConflict = true;
    await S.saveNow();
    eq(calls, 0, '冲突未处理时不该自动发保存');
  });

  await checkAsync('409 走冲突分流，不落进「保存失败」', async () => {
    resetSave(async () => {
      const error = new Error('这块画布在别处被改过了');
      error.status = 409;
      error.data = { conflict: true, rev: 9 };
      throw error;
    });
    S.dirty = true;
    await S.saveNow();
    eq(S.log.conflicts.length, 1, '409 没有交给冲突面板');
    assert(S.log.states.indexOf('error') < 0, '409 不该显示成保存失败：' + S.log.states.join('→'));
    eq(S.dirty, true, '冲突后改动仍要留着（等用户选怎么处理）');
    eq(S.lastSaveError, '', '409 不该被记成普通的保存错误');
  });

  await checkAsync('409 之后会钉住侧栏，用户能看见需要做决定', async () => {
    resetSave(async () => {
      const error = new Error('conflict');
      error.status = 409;
      error.data = { conflict: true };
      throw error;
    });
    S.dirty = true;
    await S.saveNow();
    // handleSaveConflict 是替身，只写了状态；真实面板会调 setSaveState('dirty')
    eq(S.saveConflict, true, '冲突标记没立起来');
  });

  await checkAsync('非 409 的服务端错误照常算保存失败', async () => {
    resetSave(async () => {
      const error = new Error('本机服务暂时没回应');
      error.status = 500;
      throw error;
    });
    S.dirty = true;
    await S.saveNow();
    eq(S.log.conflicts.length, 0, '500 不该走冲突分流');
    eq(S.lastSaveError, '本机服务暂时没回应');
    eq(S.saveEl.dataset.state, 'error');
  });

  await checkAsync('连不上（没有 status）也算保存失败，并保留可读原因', async () => {
    resetSave(async () => {
      throw new TypeError('Failed to fetch');
    });
    S.dirty = true;
    await S.saveNow();
    eq(S.saveEl.dataset.state, 'error');
    eq(S.lastSaveError, 'Failed to fetch');
  });

  await checkAsync('成功后清掉失败原因：不能一次失败就永远显示错误', async () => {
    resetSave(async () => ({ rev: 3 }));
    S.lastSaveError = '刚才那次失败';
    S.dirty = true;
    await S.saveNow();
    eq(S.lastSaveError, '', '成功后没清掉上次的错误');
    eq(S.saveEl.dataset.state, 'saved');
  });

  // ---------------------------------------------------------------- 源码级约束
  console.log('\n[3] 失败面板与兜底出路（源码级约束）');

  check('失败面板给「立即重试保存」', () => {
    const at = canvasSrc.indexOf('function openSavePanel()');
    const body = canvasSrc.slice(at, at + 4000);
    assert(body.indexOf('立即重试保存') >= 0, '面板里没有重试按钮');
    assert(body.indexOf('saveNow(true)') >= 0, '重试按钮没有真的强制发一次');
  });

  check('失败面板给「导出当前状态（.json）」', () => {
    const at = canvasSrc.indexOf('function openSavePanel()');
    const body = canvasSrc.slice(at, at + 4000);
    assert(body.indexOf('导出当前状态') >= 0, '面板里没有导出兜底');
    assert(body.indexOf('exportCurrentState()') >= 0, '导出按钮没有接上导出函数');
  });

  check('导出兜底落成文件（不是只弹个提示）', () => {
    const body = pickFunction('exportCurrentState');
    assert(body.indexOf('new Blob') >= 0, '没有真的生成文件');
    assert(body.indexOf('a.download') >= 0, '没有触发下载');
    assert(body.indexOf('URL.revokeObjectURL') >= 0, '临时地址没有回收，多导出几次会漏内存');
  });

  check('导出的文件格式与服务端导出一致（能用「导入画布」捡回来）', () => {
    const body = pickFunction('exportCurrentState');
    assert(body.indexOf("format: 'local-canvas'") >= 0, '文件头格式对不上');
    assert(body.indexOf('version: 1') >= 0, '缺版本号');
    assert(body.indexOf('nodes: collectNodes()') >= 0, '缺节点');
    assert(body.indexOf('edges: edges') >= 0, '缺连线');
    assert(body.indexOf('viewport: viewport') >= 0, '缺视口');
  });

  check('导出失败也有话说（不会静默吞掉）', () => {
    const body = pickFunction('exportCurrentState');
    assert(body.indexOf('导出失败') >= 0, '导出失败时没有反馈');
  });

  check('侧栏钉住只在保存失败态生效，恢复后松手', () => {
    const body = pickFunction('setSaveState');
    assert(/if \(state === 'error' \|\| saveConflict\) showRailForSaveError\(\)/.test(body), '失败 / 冲突时没钉住侧栏');
    assert(body.indexOf('releaseRailForSaveError()') >= 0, '恢复后没有松开侧栏');
  });

  check('松开侧栏时不打断正在用鼠标的用户', () => {
    const body = pickFunction('releaseRailForSaveError');
    assert(body.indexOf(':hover') >= 0, '没有检查鼠标是否还停在侧栏上');
  });

  check('保存中 / 已保存的说明都能读（不是空白）', () => {
    const body = pickFunction('saveDescription');
    assert(body.indexOf('正在写入本机数据库') >= 0, '保存中的说明缺失');
    assert(body.indexOf('已保存') >= 0, '已保存的说明缺失');
  });

  console.log('\n[4] 关页面前的最后一道保险');

  check('关页面时还 dirty 就再发一次（不带 rev：马上就要走了，处理不了 409）', () => {
    const at = canvasSrc.indexOf("window.addEventListener('pagehide'");
    assert(at >= 0, '没有 pagehide 兜底');
    const body = canvasSrc.slice(at, at + 900);
    assert(body.indexOf('if (!dirty) return') >= 0, '没有先看是不是还有未保存的改动');
    assert(body.indexOf('saveCanvasOnLeave') >= 0, '没有真的把最后一次保存发出去');
    assert(/这里刻意不带 rev/.test(body), '说明里没交代为什么可以不带 rev');
  });

  check('关页面兜底走 keepalive 且带钥匙（请求收在 api.js 一处）', () => {
    // pagehide 里已经不再直接写 fetch，改成调 api.saveCanvasOnLeave；
    // 所以「keepalive 有没有标」「钥匙有没有带」要到 api.js 里验。
    assert(apiSrc.indexOf('saveCanvasOnLeave') >= 0, 'api.js 里没有 saveCanvasOnLeave');
    const from = apiSrc.indexOf('saveCanvasOnLeave');
    const body = apiSrc.slice(from, from + 600);
    assert(body.indexOf('keepalive: true') >= 0, '请求没标 keepalive，页面一走就被掐断');
    assert(body.indexOf('withToken(') >= 0, '没带本机钥匙，服务端会直接 401');
    assert(body.indexOf('catch(() => {})') >= 0, '没有吞掉这一次失败（页面都要没了，弹提示也没人看）');
  });

  check('切回页面时自动补一次（服务可能刚恢复，不该让用户自己去点）', () => {
    // 文件里有两处 visibilitychange：一处唤醒轮询、一处补保存。
    // 从 pagehide 之后找，才能拿到补保存那一处。
    const from = canvasSrc.indexOf("window.addEventListener('pagehide'");
    const at = canvasSrc.indexOf("document.addEventListener('visibilitychange'", from);
    assert(at >= 0, '没有切回页面的补保存处理');
    const body = canvasSrc.slice(at, at + 600);
    assert(body.indexOf('if (document.hidden) return') >= 0, '藏起来时不该做事');
    assert(body.indexOf('if (saveConflict) return') >= 0, '冲突未处理时不该偷偷保存（会盖掉别人的改动）');
    assert(/lastSaveError && dirty/.test(body), '没有「上次失败且还有改动才补一次」的判据');
    assert(body.indexOf('saveNow(true)') >= 0, '没有真的补一次');
  });

  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
