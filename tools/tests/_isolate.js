'use strict';

// 测试数据目录隔离助手。
//
// 为什么需要它：server/paths.js 里 DB_FILE / RECYCLE_DIR / LOG_DIR 这些路径
// 都是模块加载时一次算定的。历史上有过两次「以为隔离了、其实写进真实库」的事故，
// 根因都是只改了 paths.DATA_DIR 而漏改派生的 DB_FILE。
//
// 本模块无论调用时机早晚都安全：
//   · 若在 require paths 之前调用 -> 走环境变量 CANVAS_DATA_DIR，全部路径一起跟着走；
//   · 若 paths 已被提前加载 -> 显式改写每一个派生路径，再逐个校验。
// 两种情况下最后都会调 paths.assertDataDir(dir) 做硬校验，不通过直接抛错。
//
// 用法：
//   const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-xxx-'));
//   const paths = require('./_isolate.js')(box);
//   // 之后才能放心 require store / generate 等
//
// 传入的目录必须存在且不是项目里的真实 data/ 目录。

const fs = require('node:fs');
const path = require('node:path');

const PATHS_MODULE = path.join(__dirname, '..', '..', 'server', 'paths.js');

function isolate(dir) {
  if (!dir) throw new Error('isolate(dir)：必须传入隔离目录');
  const want = path.resolve(dir);

  // 安全底线：拒绝把项目真实的 data/ 目录当作隔离目标。
  const realData = path.join(path.resolve(__dirname, '..', '..'), 'data');
  if (want === realData || realData.indexOf(want) === 0) {
    throw new Error('isolate() 拒绝使用项目真实数据目录作为隔离目标：' + want);
  }
  fs.mkdirSync(want, { recursive: true });

  // 供任何后续（含子进程）require paths 时使用。
  process.env.CANVAS_DATA_DIR = want;

  const paths = require(PATHS_MODULE);

  // 若 paths 在本进程里已经被提前加载过（或上一个沙箱用过），环境变量就来不及生效了。
  // 注意：必须改写「导出对象」上的字段 —— store/generate 等模块都是通过
  // require('./paths').DB_FILE 这种方式取值的，改导出对象才对它们有效。
  // （paths 模块内部的 assertDataDir 检查的是模块作用域常量，只适用于「进程启动前
  //   就设好环境变量」的场景，不能用来校验这种事后改属性的情况。）
  const derived = {
    DATA_DIR: want,
    DB_FILE: path.join(want, 'canvas.db'),
    RUNTIME_FILE: path.join(want, 'runtime.json'),
    CONFIG_FILE: path.join(want, 'config.json'),
    LOG_DIR: path.join(want, 'logs'),
    RECYCLE_DIR: path.join(want, 'recycle'),
  };
  for (const key of Object.keys(derived)) {
    if (path.resolve(String(paths[key])) !== derived[key]) {
      paths[key] = derived[key];
    }
  }

  // 硬校验：逐个复核导出对象，任何一个字段没指到隔离目录就拒绝运行。
  for (const key of Object.keys(derived)) {
    const got = path.resolve(String(paths[key]));
    if (got !== derived[key]) {
      throw new Error('隔离不彻底：paths.' + key + ' 仍是 ' + paths[key] + '，期望 ' + derived[key]);
    }
  }

  return paths;
}

module.exports = isolate;
