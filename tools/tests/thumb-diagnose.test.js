'use strict';

// E3 缩略图失败诊断（清单 35）的隔离测试。
//
// 背景：缩略图生成失败以前是彻底静默的——runFfmpeg 用 stdio:'ignore' 起 ffmpeg，
// 退出码非 0 就当 false，连 stderr 都没读；thumbFor 再把它吞成 null。
// 结果就是卡片默默回退到原图，用户只觉得「怎么这么卡」，完全不知道原因。
//
// 要守的四件事：
//   1. 失败会进环形缓冲区，去重带次数，最近的排前面；
//   2. reason 有摘要（ffmpeg 的 stderr 又长又吵，整段贴出去没人看得下去）；
//   3. 缓冲区有上限，坏素材多的时候不会把内存堆爆；
//   4. ffmpeg 找不到时给的是「没装」的说明，跟「解不动这个文件」区分开。
//
// 运行：runtime/node.exe tools/tests/thumb-diagnose.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');

// 隔离：thumbs.js 的 THUMB_DIR 跟着 paths.DATA_DIR 走，不隔离就会往真实 data/ 里写缩略图
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-thumb-'));
const paths = require(path.join(__dirname, '_isolate.js'))(box);

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

const thumbs = require(path.join(ROOT, 'server', 'thumbs.js'));
const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'logs.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const thumbSrc = fs.readFileSync(path.join(ROOT, 'server', 'thumbs.js'), 'utf8');

console.log('E3 · 确认测试确实在隔离目录里跑');
check('THUMB_DIR 落在隔离盒子里，不是项目真实 data/', () => {
  eq(thumbs.THUMB_DIR, path.join(box, 'thumbs'), 'THUMB_DIR 没跟着隔离目录走');
  assert(thumbs.THUMB_DIR.indexOf(path.join(ROOT, 'data')) !== 0, 'THUMB_DIR 指到真实 data 里了');
});

console.log('E3 · 记一条失败');

thumbs.clearFailures();
check('一开始是空的', () => eq(thumbs.listFailures().length, 0));
check('记一条以后能读出来，字段齐全', () => {
  thumbs.recordFailure('视频/a.mp4', 'moov atom not found');
  const list = thumbs.listFailures();
  eq(list.length, 1);
  eq(list[0].relPath, '视频/a.mp4');
  eq(list[0].reason, 'moov atom not found');
  eq(list[0].count, 1);
  assert(typeof list[0].at === 'number' && list[0].at > 0, '缺时间戳');
});

console.log('E3 · 同一条重复失败要合计数，别刷屏');

check('同一素材同一原因算同一条，次数加一', () => {
  thumbs.recordFailure('视频/a.mp4', 'moov atom not found');
  thumbs.recordFailure('视频/a.mp4', 'moov atom not found');
  const list = thumbs.listFailures();
  eq(list.length, 1, '重复失败不该多出一条');
  eq(list[0].count, 3);
});
check('同一素材不同原因是两条（换个原因就是另一回事）', () => {
  thumbs.recordFailure('视频/a.mp4', 'Invalid data found when processing input');
  const list = thumbs.listFailures();
  eq(list.length, 2);
  const reasons = list.map((one) => one.reason).sort();
  eq(reasons[0], 'Invalid data found when processing input');
  eq(reasons[1], 'moov atom not found');
});
check('不同素材同一原因是两条（要能看出是哪张素材坏了）', () => {
  thumbs.recordFailure('视频/b.mp4', 'moov atom not found');
  eq(thumbs.listFailures().length, 3);
});

console.log('E3 · reason 要压成摘要，别把 ffmpeg 的整页报错贴出来');

check('超长 stderr 会被截断并加省略号', () => {
  thumbs.clearFailures();
  const long = 'x'.repeat(900);
  thumbs.recordFailure('视频/长.mp4', long);
  const item = thumbs.listFailures()[0];
  assert(item.reason.length <= 201, 'reason 没截断，长度 ' + item.reason.length);
  assert(item.reason.endsWith('…'), '截断了但没有省略号');
});
check('多行 stderr 会被压成一行（换行会把日志面板搞乱）', () => {
  thumbs.clearFailures();
  thumbs.recordFailure('视频/多行.mp4', '第一行\n第二行\r\n第三行');
  const item = thumbs.listFailures()[0];
  eq(item.reason, '第一行 第二行 第三行');
});
check('空原因给一句兜底说明，不会留空', () => {
  thumbs.clearFailures();
  thumbs.recordFailure('视频/空.mp4', '');
  eq(thumbs.listFailures()[0].reason, 'ffmpeg 没有给出原因');
});
check('relPath 前后空格会被去掉', () => {
  thumbs.clearFailures();
  thumbs.recordFailure('  视频/空格.mp4  ', 'oops');
  eq(thumbs.listFailures()[0].relPath, '视频/空格.mp4');
});

console.log('E3 · 环形缓冲区：坏素材多的时候不能把内存堆爆');

check('最多留 60 条，超了丢最老的', () => {
  thumbs.clearFailures();
  for (let i = 0; i < 80; i += 1) {
    thumbs.recordFailure('视频/坏' + i + '.mp4', 'damaged');
  }
  const list = thumbs.listFailures();
  eq(list.length, 60, '没有按上限裁剪');
  // 最新那条一定还在
  assert(list.some((one) => one.relPath === '视频/坏79.mp4'), '最新的被裁掉了');
  // 最老那批应该已经被裁掉
  assert(!list.some((one) => one.relPath === '视频/坏0.mp4'), '最老的没有被裁掉');
});
check('裁剪后再记新的不会出错，长度仍然守住上限', () => {
  thumbs.recordFailure('视频/再来.mp4', 'damaged');
  eq(thumbs.listFailures().length, 60);
});
check('listFailures 最近的排前面', () => {
  thumbs.clearFailures();
  thumbs.recordFailure('视频/先.mp4', 'earlier');
  const first = thumbs.listFailures()[0];
  thumbs.recordFailure('视频/后.mp4', 'later');
  const list = thumbs.listFailures();
  eq(list[0].relPath, '视频/后.mp4', '最新的没排在最前面');
  assert(list[1].at <= list[0].at, '时间戳没有从新到旧');
  assert(first.at > 0, '时间戳异常');
});
check('clearFailures 能清干净', () => {
  thumbs.clearFailures();
  eq(thumbs.listFailures().length, 0);
});

console.log('E3 · ffmpeg 找不到时给的是「没装」，不是文件的问题');

check('源码里区分了「没找到 ffmpeg」和文件本身的问题', () => {
  assert(thumbSrc.indexOf('没有找到 ffmpeg') >= 0, '缺「没找到 ffmpeg」的说明');
});
check('runFfmpeg 真的收了 stderr（以前是 stdio: ignore，什么都拿不到）', () => {
  assert(thumbSrc.indexOf("stdio: ['ignore', 'ignore', 'pipe']") >= 0, 'stderr 还是被忽略的');
  assert(thumbSrc.indexOf("child.stderr.on('data'") >= 0, '没有读 stderr');
});
check('stderr 只留前 4KB（ffmpeg 报错动不动几页）', () => {
  assert(thumbSrc.indexOf('err.length < 4096') >= 0, '没有对 stderr 长度设上限');
});
check('视频两帧都取失败时记的是第二次的原因', () => {
  const at = thumbSrc.indexOf('second.reason || first.reason');
  assert(at > 0, '没有优先记第二次（从 0 秒取）的原因');
});

console.log('E3 · 接到接口与面板上');

check('/api/log 会把失败清单一起返回（两个分支都要有）', () => {
  const hits = serverSrc.split('thumbFailures: thumbFailures').length - 1;
  eq(hits, 2, '接口返回失败清单的分支数不对，实际 ' + hits + ' 处');
  assert(serverSrc.indexOf('thumbs.listFailures()') >= 0, '接口没有调用 listFailures');
});
check('日志面板有失败清单这一块', () => {
  assert(canvasSrc.indexOf('renderThumbFailures') >= 0, '缺 renderThumbFailures');
  assert(canvasSrc.indexOf('log-thumb-fails') >= 0, '缺失败清单的容器');
  assert(canvasSrc.indexOf('data.thumbFailures') >= 0, '没有读接口返回的 thumbFailures');
});
check('没有失败时这块收起来（不留个空壳占地方）', () => {
  const at = canvasSrc.indexOf('function renderThumbFailures');
  const body = canvasSrc.slice(at, at + 900);
  assert(body.indexOf("classList.add('hidden')") >= 0, '没有失败时没有收起');
  assert(body.indexOf("classList.remove('hidden')") >= 0, '有失败时没有展开');
});
check('面板上要能看出「失败了几次」和「哪张素材」', () => {
  const at = canvasSrc.indexOf('function renderThumbFailures');
  const body = canvasSrc.slice(at, at + 1800);
  assert(body.indexOf('item.relPath') >= 0, '没有显示素材路径');
  assert(body.indexOf("'×' + item.count") >= 0, '没有显示重复次数');
  assert(body.indexOf('item.reason') >= 0, '没有显示失败原因');
});
check('样式存在（面板与每行都定义了）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'style.css'), 'utf8');
  assert(css.indexOf('.thumb-fail-panel') >= 0, '缺 .thumb-fail-panel 样式');
  assert(css.indexOf('.thumb-fail-row') >= 0, '缺 .thumb-fail-row 样式');
  assert(css.indexOf('.thumb-fail-file') >= 0, '缺 .thumb-fail-file 样式');
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52));
process.exit(fail ? 1 : 0);
