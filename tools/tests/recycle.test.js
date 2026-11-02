'use strict';

// D1 删除后恢复入口的隔离测试（清单 18）。
//
// 覆盖两层：
//   服务端 —— 回收站的列出与还原（含目录穿越防护、同名不覆盖）
//   前端源码 —— toast 真的支持操作按钮，「删除卡片 / 断开连线」都给了撤销入口
//
// 运行：runtime/node.exe tools/tests/recycle.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-recycle-'));
const paths = require(path.join(__dirname, '_isolate.js'))(box);

const library = require(path.join(SERVER, 'library.js'));

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
  if (got !== want) throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
}

// 造一个素材目录 + 一批回收站文件
const assetRoot = path.join(box, '素材');
paths.ensureDir(assetRoot);
paths.ensureDir(paths.RECYCLE_DIR);

function writeFile(full, text) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
}

const batchId = '素材-2026-11-03_01-55-00';
writeFile(path.join(paths.RECYCLE_DIR, batchId, '图片', '猫.png'), 'PNGCAT');
writeFile(path.join(paths.RECYCLE_DIR, batchId, '视频', '雨.mp4'), 'MP4RAIN');
// 坏库挪存档是「目录」形态（store.js 里 createDirSync 出来的），照真实形状造
writeFile(path.join(paths.RECYCLE_DIR, 'db-broken-20261103', 'canvas.db'), 'BROKENDB');

console.log('\nD1 · 回收站目录（服务端列出）');

check('列出所有批次，带条数与体积', () => {
  const out = library.listRecycle();
  eq(out.total, 3, '文件总数');
  eq(out.batches.length, 2, '批次数量');
});

check('批次按删除时间倒序（最新的在前面）', () => {
  const out = library.listRecycle();
  const times = out.batches.map((item) => item.at);
  times.forEach((at) => assert(at > 0, '每个批次的时间都要算得出来'));
  const sorted = times.slice().sort((a, b) => b - a);
  eq(times.join(','), sorted.join(','), '应按下时间倒序');
});

check('批次内保留原相对路径（还原时按同样结构摆回去）', () => {
  const out = library.listRecycle();
  const batch = out.batches.find((item) => item.id === batchId);
  const rels = batch.items.map((item) => item.rel).sort();
  eq(rels.join(','), '图片/猫.png,视频/雨.mp4');
});

check('认不出的批次名也能列出来（用目录改动时间兜底）', () => {
  const out = library.listRecycle();
  const other = out.batches.find((item) => item.id === 'db-broken-20261103');
  assert(other, 'db-broken 批次应该被列出');
  eq(other.count, 1);
});

console.log('\nD1 · 还原（挑着摆回去）');

check('整批还原：文件回到素材目录，回收站里不再有', () => {
  const res = library.restoreRecycle(assetRoot, batchId, null);
  eq(res.ok, true);
  eq(res.moved, 2, '还原个数');
  assert(fs.existsSync(path.join(assetRoot, '图片', '猫.png')), '猫.png 应回到素材目录');
  assert(fs.existsSync(path.join(assetRoot, '视频', '雨.mp4')), '雨.mp4 应回到素材目录');
  const left = library.listRecycle();
  eq(left.batches.find((item) => item.id === batchId), undefined, '这一批应该空了、不再列出');
});

check('同名已存在时不覆盖，报出来让用户自己决定', () => {
  const again = library.restoreRecycle(assetRoot, batchId, null);
  // 这一批已经空了，什么都不会动
  eq(again.moved, 0);
  // 再造一个会撞名的场景
  const second = '素材-2026-11-03_02-00-00';
  writeFile(path.join(paths.RECYCLE_DIR, second, '图片', '猫.png'), 'NEWCAT');
  const res = library.restoreRecycle(assetRoot, second, null);
  eq(res.moved, 0, '不该覆盖已有的猫.png');
  eq(res.skipped.length, 1, '应该报一个同名冲突');
  eq(fs.readFileSync(path.join(assetRoot, '图片', '猫.png'), 'utf8'), 'PNGCAT', '原有文件内容不能被改');
});

check('只还原指定的那几个文件', () => {
  const third = '素材-2026-11-03_03-00-00';
  writeFile(path.join(paths.RECYCLE_DIR, third, '图片', '甲.png'), 'A');
  writeFile(path.join(paths.RECYCLE_DIR, third, '图片', '乙.png'), 'B');
  const res = library.restoreRecycle(assetRoot, third, ['图片/甲.png']);
  eq(res.moved, 1);
  assert(fs.existsSync(path.join(assetRoot, '图片', '甲.png')), '甲应该被还原');
  assert(!fs.existsSync(path.join(assetRoot, '图片', '乙.png')), '乙不该被还原');
  const left = library.listRecycle();
  const batch = left.batches.find((item) => item.id === third);
  eq(batch.count, 1, '这一批还剩 1 个');
  eq(batch.items[0].name, '乙.png');
});

check('批次不存在时报错，不瞎动文件', () => {
  const res = library.restoreRecycle(assetRoot, '不存在的批次', null);
  eq(res.ok, false);
  assert(String(res.error || '').length > 0, '要给出原因');
});

check('目录穿越被挡住（batchId 里塞 ..\\ 也出不去回收站）', () => {
  const res = library.restoreRecycle(assetRoot, '../../..', null);
  eq(res.ok, false, '这种 batchId 必须被拒');
});

check('回收站为空时安全返回', () => {
  // 把剩下的都还原掉再看。注意「同名被跳过」的那些还留在回收站里（这是对的，
  // 它们没被还原成功就不该凭空消失），所以这里只断言批次列表不再为空壳。
  const now = library.listRecycle();
  now.batches.forEach((batch) => library.restoreRecycle(assetRoot, batch.id, null));
  const after = library.listRecycle();
  after.batches.forEach((batch) => {
    eq(batch.count > 0, true, '列出来的批次必须还有文件');
  });
  // 再清一遍，把同名冲突的也挪走，确认空回收站能安全返回
  fs.rmSync(paths.RECYCLE_DIR, { recursive: true, force: true });
  paths.ensureDir(paths.RECYCLE_DIR);
  const empty = library.listRecycle();
  eq(empty.total, 0);
  eq(empty.batches.length, 0);
});

console.log('\nD1 · 前端入口（源码级约束）');

const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');

check('toast 支持第三个参数 actions', () => {
  const body = canvasSrc.split('function toast(message, stayMs, actions) {')[1] || '';
  assert(body.length > 0, 'toast 签名里应该有 actions');
  const fn = body.split('\n  }\n')[0];
  assert(fn.indexOf('toast-actions') >= 0, '要渲染出按钮容器');
  assert(fn.indexOf('toast-action') >= 0, '要渲染出按钮');
});

check('带按钮的提示条悬停会暂停计时', () => {
  assert(canvasSrc.indexOf('toastPauseLeft') >= 0, '缺少暂停计时的状态');
  assert(canvasSrc.indexOf('mouseenter') >= 0 && canvasSrc.indexOf('mouseleave') >= 0, '缺少悬停绑定');
});

check('删除卡片后给了「撤销删除」与「查看回收站」', () => {
  const at = canvasSrc.indexOf("'已删除 ' + removed + ' 张卡片'");
  assert(at >= 0, '找不到删除提示');
  const around = canvasSrc.slice(Math.max(0, at - 200), at + 500);
  assert(around.indexOf('撤销删除') >= 0, '缺少撤销入口');
  assert(around.indexOf('查看回收站') >= 0, '缺少回收站入口');
});

check('断开连线后给了撤销入口', () => {
  const at = canvasSrc.indexOf("toast('已断开这条连线'");
  assert(at >= 0, '找不到断线提示');
  const around = canvasSrc.slice(at, at + 200);
  assert(around.indexOf('撤销删除') >= 0, '缺少撤销入口');
});

check('回收站面板能列、能挑、能还原', () => {
  assert(canvasSrc.indexOf('async function openRecycleBin()') >= 0, '缺少面板函数');
  assert(canvasSrc.indexOf('window.openRecycleBin = openRecycleBin') >= 0, '没暴露给素材库');
  const api = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'api.js'), 'utf8');
  assert(api.indexOf('recycleList') >= 0 && api.indexOf('recycleRestore') >= 0, '缺少接口封装');
});

check('画布页样式里给了提示条按钮与回收站面板', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'style.css'), 'utf8');
  ['.toast.has-actions', '.toast-action', '.recycle-row', '.modal-recycle'].forEach((sel) => {
    assert(css.indexOf(sel) >= 0, '缺少样式 ' + sel);
  });
});

console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
