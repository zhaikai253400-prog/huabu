'use strict';

// store.js 健康告警的隔离测试。
//
// 背景：坏库被 quarantineDb() 悄悄挪进回收站、空库顶上，用户只看到「画布没了」。
// 现在 store 会把这件事记进 healthNotice，页面据此显示告警条。
//
// 关键事实（实测得出，决定了测试怎么造数据）：
//   只要 canvas.db-wal 还在，即使主库文件被写坏，SQLite 也能从 WAL 恢复全部内容、
//   完全不报错。所以要触发「重建」分支，必须造一个「主库坏且没有可用 WAL」的目录。
//
// 运行：runtime/node.exe tools/tests/store-health.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');

const SERVER = path.resolve(__dirname, '..', '..', 'server');
const STORE_PATH = path.join(SERVER, 'store.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    failed += 1;
    console.log('  ✗ ' + name + ' —— ' + error.message);
  }
}

// paths 是单例，所有模块共享它，直接改字段就能把整条链路指到临时目录
const paths = require(path.join(SERVER, 'paths.js'));

// 每个场景一个全新目录，避免上一组残留的 WAL 干扰下一组
function makeSandbox(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-health-' + tag + '-'));
  const box = {
    dir: dir,
    dbFile: path.join(dir, 'canvas.db'),
    recycleDir: path.join(dir, 'recycle'),
  };
  paths.DATA_DIR = dir;
  paths.DB_FILE = box.dbFile;
  paths.RECYCLE_DIR = box.recycleDir;
  return box;
}

// store 是单例，模块级 db / healthNotice 会跨用例残留，每次取一份干净的
function freshStore() {
  delete require.cache[require.resolve(STORE_PATH)];
  return require(STORE_PATH);
}

// 造一个真正打不开的库：主库是垃圾内容，且不留 WAL
function writeBrokenDb(box) {
  fs.writeFileSync(box.dbFile, 'this is definitely not a sqlite database file');
  ['canvas.db-wal', 'canvas.db-shm'].forEach((name) => {
    const file = path.join(box.dir, name);
    if (fs.existsSync(file)) fs.rmSync(file);
  });
}

console.log('\n[1] 坏库重建后能看到告警');
{
  const box = makeSandbox('broken');
  writeBrokenDb(box);
  const store = freshStore();
  store.init();

  const notice = store.getHealthNotice();
  check('有告警', () => assert.ok(notice, '期望拿到 notice'));
  check('code 是 DB_REBUILT', () => assert.strictEqual(notice.code, 'DB_REBUILT'));
  check('level 是 error', () => assert.strictEqual(notice.level, 'error'));
  check('带重建时间戳', () => assert.ok(Number(notice.at) > 0, 'at 应为正数时间戳'));
  check('带失败原因', () =>
    assert.ok(/not a database|malformed|corrupt/i.test(notice.reason), '原因应含 sqlite 报错，实际：' + notice.reason));
  check('旧库目录指向回收站里', () => {
    assert.ok(notice.oldDir, '期望有 oldDir');
    assert.ok(notice.oldDir.indexOf('db-broken-') >= 0, 'oldDir 应含 db-broken-，实际：' + notice.oldDir);
    assert.ok(fs.existsSync(path.join(notice.oldDir, 'canvas.db')), '坏库文件应真的被搬进那个目录');
  });
  check('原位置换成了可用的空库', () => {
    const stats = store.stats();
    assert.strictEqual(stats.canvases, 0, '新库应该是空的');
    assert.ok(fs.existsSync(box.dbFile), '原位置应有新库文件');
  });
}

console.log('\n[2] clearHealthNotice 的行为');
{
  const box = makeSandbox('clear');
  writeBrokenDb(box);
  const store = freshStore();
  store.init();
  check('先确认这次也有告警', () => assert.ok(store.getHealthNotice(), '期望有告警'));
  check('第一次 clear 返回 true', () => assert.strictEqual(store.clearHealthNotice(), true));
  check('清完之后读不到', () => assert.strictEqual(store.getHealthNotice(), null));
  check('第二次 clear 返回 false', () => assert.strictEqual(store.clearHealthNotice(), false));
}

console.log('\n[3] 正常库不产生告警');
{
  const box = makeSandbox('clean');
  const store = freshStore();
  store.init();
  check('没有告警', () => assert.strictEqual(store.getHealthNotice(), null));
  check('能正常建画布', () => {
    const created = store.createCanvas('测试画布');
    assert.ok(created && created.canvas && created.canvas.id, '应返回带 id 的画布');
  });
  check('清一个不存在的告警也不报错', () => assert.strictEqual(store.clearHealthNotice(), false));
  check('库仍在原位，没被误搬走', () => assert.ok(fs.existsSync(box.dbFile)));
}

console.log('\n[4] getHealthNotice 返回副本');
{
  const box = makeSandbox('copy');
  writeBrokenDb(box);
  const store = freshStore();
  store.init();
  const first = store.getHealthNotice();
  check('先拿到告警', () => assert.ok(first, '期望有告警'));
  first.code = '被外部改掉了';
  check('外部修改不影响内部状态', () => assert.strictEqual(store.getHealthNotice().code, 'DB_REBUILT'));
}

console.log('\n[5] 主库坏但 WAL 完整时不重建（数据可恢复，不该误报）');
{
  const box = makeSandbox('wal');
  // 先用正常库写点东西，留下 WAL
  const first = freshStore();
  first.init();
  const created = first.createCanvas('WAL 保护测试');
  const canvasId = created.canvas.id;
  // 模拟「主库文件被外部破坏」，WAL 保持不动
  fs.writeFileSync(box.dbFile, 'garbage, but WAL still holds the pages');

  const second = freshStore();
  second.init();
  check('没有告警（WAL 能救回来就不算坏库）', () => assert.strictEqual(second.getHealthNotice(), null));
  check('数据还在', () => {
    const canvas = second.getCanvas(canvasId);
    assert.ok(canvas, '画布应仍能读到，实际为空');
    assert.strictEqual(canvas.name, 'WAL 保护测试');
  });
}

console.log('\n' + '='.repeat(46));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
console.log('='.repeat(46));
process.exit(failed ? 1 : 0);