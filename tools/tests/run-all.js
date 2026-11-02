'use strict';

// 跑一遍 tools/tests/ 下的所有测试，任一失败就整体失败。
//
// 运行：runtime/node.exe tools/tests/run-all.js
//
// 为什么不引测试框架：这个项目坚持零第三方依赖，用 node:child_process
// 顺序拉起每个测试脚本、看退出码就够了。

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const here = __dirname;
const files = fs
  .readdirSync(here)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.log('没有找到测试文件');
  process.exit(0);
}

const results = [];
for (const file of files) {
  console.log('\n' + '─'.repeat(52));
  console.log('▶ ' + file);
  console.log('─'.repeat(52));
  const run = spawnSync(process.execPath, [path.join(here, file)], {
    stdio: 'inherit',
    cwd: path.resolve(here, '..', '..'),
  });
  results.push({ file: file, ok: run.status === 0 });
}

console.log('\n' + '═'.repeat(52));
console.log('汇总');
console.log('═'.repeat(52));
let bad = 0;
for (const one of results) {
  console.log((one.ok ? '  ✓ ' : '  ✗ ') + one.file);
  if (!one.ok) bad += 1;
}
console.log('\n共 ' + results.length + ' 个测试文件，失败 ' + bad + ' 个');
process.exit(bad ? 1 : 0);