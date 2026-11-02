'use strict';

// C3 提交快照的隔离测试：验证「本次提交到底送出去了什么」被完整冻结下来。
//
// 覆盖两件事：
//   1. 参考素材进快照 —— 冻结的是名字 / 类型 / 角色 / 地址，不含几 MB 的字节
//   2. 服务重启接续时，refCount 能从快照里读回来（卡片显示「N 个参考素材」靠它）
//
// 运行：runtime/node.exe tools/tests/submit-snapshot.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SERVER = path.resolve(__dirname, '..', '..', 'server');

// 隔离：本测试只调纯函数，不碰数据库，但仍走统一助手保持范式一致
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-snapshot-'));
require(path.join(__dirname, '_isolate.js'))(box);

const generate = require(path.join(SERVER, 'generate.js'));

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

// 造一组「看起来像 prepareRefs 产物」的参考素材：
// 关键点是含大块 buffer，用来确认冻结时把它剔掉了
function fakeRefs() {
  const list = [
    {
      name: '首帧图.png',
      kind: 'image',
      role: 'first_frame',
      src: '/media/视频/a1b2.png',
      dataUrl: 'data:image/png;base64,' + 'A'.repeat(5000),
      buffer: Buffer.alloc(3 * 1024 * 1024, 7),
      remoteUrl: '',
      remoteId: '',
    },
    {
      name: '参考视频.mp4',
      kind: 'video',
      role: 'reference_video',
      src: '/media/视频/c3d4.mp4',
      dataUrl: '',
      buffer: Buffer.alloc(2 * 1024 * 1024, 9),
      remoteUrl: 'https://cdn.example.com/uploaded-x.mp4',
      remoteId: 'up_7788',
    },
  ];
  list.refStats = { beforeBytes: 5 * 1024 * 1024, afterBytes: 5 * 1024 * 1024, compressedCount: 0, byKind: {} };
  return list;
}

function fakeChannel() {
  return {
    id: 'ch-x',
    name: '测试通道',
    poll: { path: '/v1/tasks/{{taskId}}', intervalSec: 3, maxWaitSec: 600 },
  };
}

const spec = {
  poll: {
    enabled: true,
    path: '/v1/tasks/{{taskId}}',
    method: 'GET',
    statusField: 'status',
    doneValues: 'succeeded',
    intervalSec: 3,
    maxWaitSec: 600,
  },
  resultUrl: 'data.url',
};
const payload = { kind: 'video', params: { ratio: '16:9' }, sizeKey: '1080p' };

console.log('\n[1] 参考素材被冻结进快照');
{
  const refs = fakeRefs();
  const record = generate.buildWaitRecord(
    fakeChannel(),
    'video',
    spec,
    payload,
    'veo-3',
    '1920x1080',
    '一只猫在跳舞',
    'task-abc',
    refs
  );

  check('快照带 refs 字段', () => assert(Array.isArray(record.refs), '期望是数组'));
  check('素材数量对得上', () => assert(record.refs.length === 2, '实际 ' + record.refs.length));
  check('保留了原始地址', () =>
    assert(record.refs[0].src === '/media/视频/a1b2.png', '实际 ' + record.refs[0].src));
  check('保留了名字 / 类型 / 角色', () => {
    assert(record.refs[0].name === '首帧图.png', '名字不对：' + record.refs[0].name);
    assert(record.refs[0].kind === 'image', '类型不对：' + record.refs[0].kind);
    assert(record.refs[0].role === 'first_frame', '角色不对：' + record.refs[0].role);
  });
  check('上传后的远端编号也留下（便于排查）', () =>
    assert(record.refs[1].remoteId === 'up_7788', '实际 ' + record.refs[1].remoteId));
}

console.log('\n[2] 快照里不许夹带大块字节');
{
  const refs = fakeRefs();
  const record = generate.buildWaitRecord(
    fakeChannel(),
    'video',
    spec,
    payload,
    'veo-3',
    '1920x1080',
    '一只猫在跳舞',
    'task-abc',
    refs
  );
  const text = JSON.stringify(record);
  check('整体体积很小（没把 buffer / dataUrl 写进去）', () =>
    assert(text.length < 1200, '快照序列化后 ' + text.length + ' 字符，疑似夹带了字节'));
  check('没有 buffer 字段', () => {
    for (const item of record.refs) {
      assert(item.buffer === undefined, '第 ' + item.name + ' 条带了 buffer');
    }
  });
  check('没有 dataUrl 字段', () => {
    for (const item of record.refs) {
      assert(item.dataUrl === undefined, '第 ' + item.name + ' 条带了 dataUrl');
    }
  });
}

console.log('\n[3] 没传参考素材时不崩、给空数组');
{
  const record = generate.buildWaitRecord(
    fakeChannel(),
    'image',
    spec,
    payload,
    'gpt-image-2',
    '1024x1024',
    '一张海报',
    'task-xyz',
    undefined
  );
  check('refs 是空数组（不是 undefined）', () => assert(Array.isArray(record.refs), '期望数组'));
  check('长度为 0', () => assert(record.refs.length === 0, '实际 ' + record.refs.length));
}

console.log('\n[4] 快照的既有字段一个没丢（回归）');
{
  const record = generate.buildWaitRecord(
    fakeChannel(),
    'video',
    spec,
    payload,
    'veo-3',
    '1920x1080',
    '一只猫在跳舞',
    'task-abc',
    fakeRefs()
  );
  // 这些是重启接续要用的，别因为它们不在本次改动范围就被顺手弄丢
  const mustHave = ['kind', 'channelId', 'channelName', 'model', 'size', 'prompt', 'remoteId', 'queryPath', 'intervalSec', 'maxWaitSec', 'startedAt', 'deadlineAt', 'params'];
  mustHave.forEach((key) => {
    check('保留字段 ' + key, () => assert(record[key] !== undefined, key + ' 丢了'));
  });
  check('deadlineAt = startedAt + maxWaitSec', () =>
    assert(record.deadlineAt === record.startedAt + 600 * 1000, '时间算错了'));
  check('params 原样带过来', () => assert(record.params.ratio === '16:9', 'params 不对'));
}

console.log('\n[5] waitRefsOf 的边界处理');
{
  check('传 null 得到空数组', () => assert(generate.waitRefsOf(null).length === 0, '应为空'));
  check('传字符串数组也能收（老格式）', () => {
    const out = generate.waitRefsOf(['/media/图片/x.png']);
    assert(out.length === 1, '实际 ' + out.length);
    assert(out[0].src === '', '字符串项没有 src，应为空串，实际 ' + JSON.stringify(out[0]));
  });
  check('缺字段的项不会产出 undefined', () => {
    const out = generate.waitRefsOf([{}]);
    const keys = ['src', 'name', 'kind', 'role', 'remoteId'];
    keys.forEach((key) => assert(typeof out[0][key] === 'string', key + ' 不是字符串'));
  });
}

console.log('\n' + '='.repeat(46));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(46));
fs.rmSync(box, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
