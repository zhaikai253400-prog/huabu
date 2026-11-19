'use strict';

// 通道 11（星光 xingapi.top）轮询取件回归测试。
//
// 2026-11-18 的现场故障：另一台电脑用 seedance2.5-V 生成 30 秒视频，平台后台已成功，
// 画布却报「任务完成了，但返回里没找到结果文件号，检查『取件文件号路径』」。
//
// 根因（generate.js pollRemote）：原来写的是
//     let found = record.downloadPath ? null : channels.extractResult(...)
// 只要通道配了取件路径（/videos/{{taskId}}/content），就**完全不看**轮询返回体，
// 于是平台明明回了 video_url 也被无视，最后因为 downloadIdPath 为空而报错。
//
// 这个测试锁死三件事：
//   1. 配了取件路径时，返回体里的直链必须先被采用（不再白等一场）；
//   2. downloadIdPath 留空、取件路径用 {{taskId}} 时，能拿任务号兜底；
//   3. 多候选路径（a|b）按顺序取第一个有值的。

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const channels = require(path.join(ROOT, 'server', 'channels.js'));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  [OK] ' + name);
  } catch (error) {
    failed += 1;
    console.log('  [FAIL] ' + name + ' -> ' + error.message);
  }
}
const eq = (a, b, msg) => assert.strictEqual(a, b, msg || (a + ' !== ' + b));

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
const ch = cfg.channels.find((c) => c.id === 'ch_xing_seedance25');
if (!ch) throw new Error('配置里找不到 ch_xing_seedance25 通道');

console.log('R1 - 通道 11 轮询配置');
check('轮询已开启', () => eq(ch.video.poll.enabled, true));
check('状态字段取 status', () => eq(ch.video.poll.statusField, 'status'));
check('完成值含 completed', () => assert.ok(ch.video.poll.doneValues.split(',').includes('completed')));
check('任务号取 id', () => eq(ch.video.poll.taskIdPath, 'id'));
check('取件路径用 {{taskId}}', () => assert.ok(ch.video.poll.downloadPath.indexOf('{{taskId}}') >= 0));

console.log('R2 - 结果地址多候选');
check('resultUrl 第一个候选就是 video_url', () => eq(String(ch.video.poll.resultUrl).split('|')[0].trim(), 'video_url'));
check('resultUrl 允许 data.video_url 兜底', () => assert.ok(ch.video.poll.resultUrl.indexOf('data.video_url') >= 0));
check('downloadIdPath 已填（不再是空串）', () => assert.ok(String(ch.video.poll.downloadIdPath || '').trim().length > 0));

console.log('R3 - pickByPaths 按顺序取第一个有值的');
check('第一个有值就用第一个', () => {
  const node = { video_url: 'https://cdn/x.mp4', data: { video_url: 'https://cdn/y.mp4' } };
  eq(channels.pickByPaths(node, 'video_url|data.video_url'), 'https://cdn/x.mp4');
});
check('第一个空就跳到第二个', () => {
  const node = { video_url: '', data: { video_url: 'https://cdn/y.mp4' } };
  eq(channels.pickByPaths(node, 'video_url|data.video_url'), 'https://cdn/y.mp4');
});
check('第一个缺失就跳到第二个', () => {
  const node = { data: { url: 'https://cdn/z.mp4' } };
  eq(channels.pickByPaths(node, 'video_url|data.url'), 'https://cdn/z.mp4');
});
check('全都没有返回 undefined', () => {
  eq(channels.pickByPaths({ a: 1 }, 'video_url|data.url'), undefined);
});
check('单个路径也照常可用', () => {
  eq(channels.pickByPaths({ video_url: 'https://a/b.mp4' }, 'video_url'), 'https://a/b.mp4');
});
check('空配置返回 undefined', () => {
  eq(channels.pickByPaths({ a: 1 }, ''), undefined);
});

console.log('R4 - extractResult 认出平台的完成返回');
check('顶层 video_url 能取出直链', () => {
  const json = { id: 'req_1', status: 'completed', video_url: 'https://cdn.example/v.mp4' };
  const got = channels.extractResult(JSON.stringify(json), json, { resultUrl: ch.video.poll.resultUrl });
  eq(got && got.url, 'https://cdn.example/v.mp4');
});
check('嵌套 data.video_url 也能取出', () => {
  const json = { status: 'completed', data: { video_url: 'https://cdn.example/n.mp4' } };
  const got = channels.extractResult(JSON.stringify(json), json, { resultUrl: ch.video.poll.resultUrl });
  eq(got && got.url, 'https://cdn.example/n.mp4');
});
check('只有封面图时不会误当成品（由 kindMatches 拦）', () => {
  const json = { status: 'completed', video_url: 'https://cdn.example/cover.png' };
  const got = channels.extractResult(JSON.stringify(json), json, { resultUrl: ch.video.poll.resultUrl });
  assert.ok(got && /\.png$/.test(got.url));
});

console.log('R5 - 其它通道的取件号配置没被带坏');
const others = cfg.channels.filter((c) => c.video && c.video.poll && c.video.poll.enabled && c.video.poll.downloadIdPath);
check('仍有通道保留取件号路径', () => assert.ok(others.length >= 1));
check('通道 7/8/9 取件号仍是 id', () => {
  for (const id of ['ch_xm_sd25', 'ch_xm_bd', 'ch_prompt_hubs']) {
    const one = cfg.channels.find((c) => c.id === id);
    if (!one) continue;
    eq(String(one.video.poll.downloadIdPath).split('|')[0].trim(), 'id');
  }
});

console.log('---');
console.log('全部通过（' + passed + ' 项）' + (failed ? '，失败 ' + failed + ' 项' : ''));
if (failed) process.exitCode = 1;