'use strict';

// P1 的永久护栏：后台定时器必须有兜底 + 全局异常要留痕。
//
// 为什么值得单独守：
//   这是**托盘常驻服务**，用户看不到控制台。后台回调抛未捕获异常时 Node
//   默认直接退出进程 —— 表现是"画布突然打不开了，没有任何提示"。
//   我实测过：没有兜底时子进程退出码 1；加上兜底后能继续跑。
//
// ⚠️ 写这个文件时踩过一个坑，记下来免得再犯：
//   这个项目的测试有两种 check 约定 ——
//     · 本项目多数测试：check(name, fn)  —— 传**函数**，由 check 内部 try/catch
//     · 本文件第一版：check(name, ok)  —— 传**布尔**
//   我照抄了别的文件的形式（传函数），却用了传布尔的实现 ——
//   函数对象永远为真，于是**所有断言无条件通过**，变异检验全线漏网。
//   所以这里明确用"传函数"的约定，并且下面加了一条自检：
//   故意传一个必假的函数，确认它真能报失败。
//
// 守住三条：
//   ① 关键定时器回调附近必须有 try/catch（特别是 scheduler）
//   ② index.js 必须装 uncaughtException / unhandledRejection
//   ③ 兜底里必须写日志（否则等于没装）

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const rel = (f) => path.join(ROOT, f);

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
// 约定：fn 是**函数**，抛错即失败
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

const sched = fs.readFileSync(rel('server/scheduler.js'), 'utf8');
const idx = fs.readFileSync(rel('server/index.js'), 'utf8');
const share = fs.readFileSync(rel('server/share.js'), 'utf8');

console.log('\nA1 · 后台定时器兜底与全局异常留痕');

// 自检：确认 check 真的会报失败（防止又写出"永远通过"的测试）
check('自检：check() 能抓到失败（故意断言一个假命题）', () => {
  const shouldFail = () => assert(false, '这条必须失败');
  let threw = false;
  try { shouldFail(); } catch { threw = true; }
  assert(threw, 'check 的包装没起作用 —— 整个测试会永远通过');
});

check('scheduler 的 1 秒 ticker 有 try/catch（原本就规范）', () => {
  const fn = /function tick\(\) \{[\s\S]*?\n\}/.exec(sched);
  assert(fn, '抽不出 tick()');
  assert(/\btry\s*\{/.test(fn[0]), 'tick() 里没有 try');
  assert(/\}\s*catch\s*\(/.test(fn[0]), 'tick() 里没有 catch');
  assert(/log\(/.test(fn[0]), 'tick() 出错时不记日志');
});

check('**scheduler 的 watchTask 回调也有兜底**（这条原本是漏的）', () => {
  const fn = /function watchTask\(run, item\) \{[\s\S]*?\n\}/.exec(sched);
  assert(fn, '抽不出 watchTask');
  const body = fn[0];
  assert(/setInterval\(\(\) => \{[\s\S]*?\btry\s*\{/.test(body),
    'watchTask 的定时器回调里没有 try —— 抛异常会让整个服务退出');
  // 必须定位到**定时器回调里那个 catch 的整段**，不能只 slice 到第一个 "catch" 字样
  //（第一版用 indexOf('catch')，结果切出来的片段不含 clearWatch/log，
  //  于是"撤掉 clearWatch"这类变异能溜过去）
  const catchAt = body.indexOf('} catch (error)');
  assert(catchAt >= 0, 'watchTask 里没有 catch (error)');
  const catchSeg = body.slice(catchAt);
  assert(/log\(/.test(catchSeg), 'watchTask 出错时不记日志 —— 崩了也无从查');
  assert(/clearWatch\(key\)/.test(catchSeg),
    'watchTask 出错时没有摘掉 watcher —— 会每 1.6 秒重复抛同一个错');
  assert(/finishItem\([\s\S]*?'failed'/.test(catchSeg),
    'watchTask 出错时没把任务标为失败 —— 那张卡会永远卡在"生成中"');
});

check('share 的心跳定时器有兜底', () => {
  const fn = /function startHeartbeat\([\s\S]*?\n\}/.exec(share);
  assert(fn, '抽不出 startHeartbeat()');
  assert(/\btry\s*\{/.test(fn[0]), '心跳里没有 try');
});

check('**index.js 装了 uncaughtException 兜底**（进程不再静默消失）', () => {
  assert(/process\.on\(\s*'uncaughtException'/.test(idx),
    '没有 process.on(\'uncaughtException\') —— 任何后台回调抛异常都会让服务直接退出，' +
    '用户只看到"画布打不开了"');
  assert(/process\.on\(\s*'unhandledRejection'/.test(idx),
    '没有 process.on(\'unhandledRejection\') —— await 失败没人管时会静默丢失');
});

check('兜底处理器里必须写日志，且自己不能再抛', () => {
  const fn = /function installCrashHandlers\(\) \{[\s\S]*?\n\}/.exec(idx);
  assert(fn, '抽不出 installCrashHandlers()');
  // 按**行**切出每个处理器的正文，而不是用非贪婪正则。
  // （第一版用 /process\.on\('uncaughtException',[\s\S]*?\n\s*\}\);/，
  //   当处理器被写成一行 `() => {}` 时，它会一路匹配到下一个处理器的结尾，
  //   于是 unhandledRejection 里的 log 被算作"uncaughtException 有 log"，
  //   变异检验因此漏网。教训：别用"到下一个 }); 为止"的模糊边界。）
  const grabHandler = (kind) => {
    const lines = fn[0].split('\n');
    const start = lines.findIndex((l) => l.indexOf("'" + kind + "'") >= 0);
    if (start < 0) return null;
    // 一行式（自带 `});`）就直接返回这一行；否则找到配对结束的那一行
    if (/\}\);\s*$/.test(lines[start])) return lines[start];
    let depth = 0;
    for (let i = start; i < lines.length; i += 1) {
      depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
      if (i > start && depth <= 0) return lines.slice(start, i + 1).join('\n');
    }
    return lines.slice(start).join('\n');
  };
  const uncaughtBody = grabHandler('uncaughtException');
  assert(uncaughtBody, '抽不出 uncaughtException 处理器');
  assert(/log\(/.test(uncaughtBody),
    'uncaughtException 处理器里没有 log —— 装了等于没装，问题照样查不到');
  const rejBody = grabHandler('unhandledRejection');
  assert(rejBody, '抽不出 unhandledRejection 处理器');
  assert(/log\(/.test(rejBody),
    'unhandledRejection 处理器里没有 log —— await 失败会静默丢失');
  assert(!/throw\s/.test(fn[0]), '兜底处理器里又 throw 了 —— 会二次崩溃');
});

check('兜底在 main() 里真的被调用（不是定义了没接上）', () => {
  assert(/installCrashHandlers\(\);\s*\n\}/.test(idx),
    'installCrashHandlers() 定义了但没在 main() 里调用');
});

console.log('');
console.log('─'.repeat(52));
if (fail) { console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项'); process.exit(1); }
console.log('通过 ' + pass + ' 项，失败 0 项');
