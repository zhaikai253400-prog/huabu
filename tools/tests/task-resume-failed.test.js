'use strict';
// 任务重新拉取（捡回已判失败但平台已出片的任务）回归测试。
//
// 现场：另一台电脑的星光通道 11 因为取件配置错，平台已经出片却判了失败。
// 任务号其实一直彘在 resume_json 里，只是 listResumableTasks 只认
// queued/running，失败的永远不会被扫到。所以另开一条“重新拉取”的路。

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  [OK] ' + name); }
  catch (e) { failed++; console.log('  [FAIL] ' + name + ' -> ' + e.message); }
}

const ROOT = path.resolve(__dirname, '..', '..');
const tasksSrc = fs.readFileSync(path.join(ROOT, 'server', 'tasks.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(ROOT, 'server', 'store.js'), 'utf8');

console.log('A - 重新拉取接口存在');
check('路由里有 resume 动作', () => assert.ok(/cancel\|resume/.test(indexSrc)));
check('路由处理了 POST resume', () => assert.ok(indexSrc.includes("taskMatch[2] === 'resume'")));
check('调用了 tasks.resumeOne', () => assert.ok(indexSrc.includes('tasks.resumeOne(config, taskId)')));

console.log('B - resumeOne 实现要点');
check('tasks.js 导出 resumeOne', () => assert.ok(tasksSrc.includes('resumeOne')));
check('会把状态拉回 running', () => assert.ok(tasksSrc.includes("status: 'running'")));
check('走的是 generate.resumeTask（不重新提交）', () => assert.ok(tasksSrc.includes('generate.resumeTask')));
check('没有 resume 记录时明确报错', () => assert.ok(tasksSrc.includes('没有留下任务号')));
check('不会重复拉正在跑的任务', () => assert.ok(tasksSrc.includes('active.has')));

console.log('C - 失败时任务号确实保留');
check('runJob 失败分支不清 resume', () => {
  const i = tasksSrc.indexOf('aborted ? \'canceled\' : \'failed\'');
  assert.ok(i > 0, '找不到失败分支');
  const seg = tasksSrc.slice(i, i + 500);
  assert.ok(!/resume:\s*(null|\'\'|undefined)/.test(seg), 'failed 分支不应把 resume 清成空');
});
check('listResumableTasks 仍只扫 queued/running（保持原意）', () =>
  assert.ok(storeSrc.includes("WHERE status IN ('queued', 'running')")));

console.log('D - 厂商不重复扣费的保证');
check('resumeOne 里没有提交请求路径', () => {
  const i = tasksSrc.indexOf('function resumeOne');
  const seg = tasksSrc.slice(i, i + 700);
  assert.ok(seg.indexOf('spec.path') < 0);
  assert.ok(seg.indexOf('submit') < 0);
});


console.log('E - 已经超时的任务重新拉取要真的发请求（不能一进来就判超时）');
const generateSrc = fs.readFileSync(path.join(ROOT, 'server', 'generate.js'), 'utf8');
check('pollRemote 按 startedAt + maxWaitSec 现算截止时间', () => {
  const i = generateSrc.indexOf('async function pollRemote(');
  assert.ok(i > 0, '找不到 pollRemote');
  const seg = generateSrc.slice(i, i + 1400);
  assert.ok(seg.indexOf('record.refetch') >= 0, '没有识别「重新拉取」');
  assert.ok(seg.indexOf('maxWaitMs') >= 0, '没有按 maxWaitSec 现算时长');
  assert.ok(seg.indexOf('Date.now() + 60 * 1000') >= 0, '没有兜底的 60 秒取件窗口');
});
check('resumeOne 从 now() 重新计时并传 refetch', () => {
  const i = tasksSrc.indexOf('function resumeOne');
  const seg = tasksSrc.slice(i, i + 700);
  assert.ok(seg.indexOf('runJob(task.id, now()') >= 0, '还在用旧 createdAt 计时');
  assert.ok(seg.indexOf('refetch: true') >= 0, '没有标记 refetch');
});
check('resumeTask 透传 refetch 到轮询记录', () => {
  const i = generateSrc.indexOf('async function resumeTask(');
  const seg = generateSrc.slice(i, i + 800);
  assert.ok(seg.indexOf('opts.refetch') >= 0, 'resumeTask 没有读 options.refetch');
  assert.ok(seg.indexOf('refetch: true') >= 0, '没有把 refetch 写进轮询记录');
});

console.log('F - 平台回相对地址时也能下载（520ruo 出片却拿不到）');
check('有 absolutizeMediaUrl 且 fetchMedia 里先补齐地址', () => {
  assert.ok(generateSrc.indexOf('function absolutizeMediaUrl(') >= 0, '没有补齐函数');
  const i = generateSrc.indexOf('async function fetchMedia(');
  const seg = generateSrc.slice(i, i + 300);
  assert.ok(seg.indexOf('absolutizeMediaUrl(found, channel)') >= 0, 'fetchMedia 没有调用补齐');
});
check('拼相对地址时不会拼出 /v1/v1', () => {
  const i = generateSrc.indexOf('function absolutizeMediaUrl(');
  const seg = generateSrc.slice(i, i + 1400);
  assert.ok(seg.indexOf('alreadyFull') >= 0, '没有判断平台是否已写全路径前缀');
  assert.ok(seg.indexOf('parsed.origin') >= 0, '没有单独取 origin');
});

console.log('---');
console.log('全部通过（' + passed + ' 项）' + (failed ? '，失败 ' + failed + ' 项' : ''));
if (failed) process.exitCode = 1;