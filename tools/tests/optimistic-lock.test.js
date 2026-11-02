'use strict';

// 乐观锁（防多标签覆盖）的隔离测试：把 DATA_DIR 指到临时目录，
// 验证 saveState 的版本号语义、冲突拒收、以及「不传 rev 就是强制写入」。
//
// 背景：两个标签页同开一块画布时，两边各自持有一份内存里的 nodes，
// 保存都是「整块删除 + 重写」。没有版本号的话，后保存的会把先保存的
// 整个盖掉，且两边都以为存成功了，用户没有任何察觉。
//
// 运行：runtime/node.exe tools/tests/optimistic-lock.test.js

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

function makeSandbox(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-lock-' + tag + '-'));
  const paths = require(path.join(SERVER, 'paths.js'));
  paths.DATA_DIR = dir;
  paths.DB_FILE = path.join(dir, 'canvas.db');
  paths.RECYCLE_DIR = path.join(dir, 'recycle');
  delete require.cache[require.resolve(STORE_PATH)];
  return require(STORE_PATH);
}

// 造一份 n 张卡片的画布内容，用 tag 标记，方便分辨最后存进去的到底是谁的
function stateOf(tag, count) {
  const nodes = [];
  for (let i = 0; i < count; i += 1) {
    nodes.push({
      id: 'n_' + tag + '_' + i,
      type: 'image',
      x: i * 40,
      y: 0,
      w: 260,
      h: 200,
      z: i,
      data: { text: tag + '-' + i },
    });
  }
  return { nodes: nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

console.log('\n[1] 新画布的 rev 从 0 开始，每次保存 +1');
{
  const store = makeSandbox('bump');
  const created = store.createCanvas('版本号测试');
  const id = created.canvas.id;
  check('新建画布 rev 为 0', () => assert.strictEqual(store.getCanvas(id).rev, 0));

  const r1 = store.saveState(id, stateOf('A', 2), 0);
  check('第一次保存在 rev 0 上成功', () => assert.ok(r1 && !r1.conflict, '不该冲突'));
  check('返回新 rev 为 1', () => assert.strictEqual(r1.rev, 1));
  check('库里 rev 也是 1', () => assert.strictEqual(store.getCanvas(id).rev, 1));

  const r2 = store.saveState(id, stateOf('B', 3), 1);
  check('第二次保存在 rev 1 上成功', () => assert.ok(r2 && !r2.conflict));
  check('返回新 rev 为 2', () => assert.strictEqual(r2.rev, 2));
}

console.log('\n[2] 用过期 rev 保存被拒，且一个字都不写');
{
  const store = makeSandbox('conflict');
  const id = store.createCanvas('冲突测试').canvas.id;
  store.saveState(id, stateOf('A', 2), 0); // rev → 1
  store.saveState(id, stateOf('B', 3), 1); // rev → 2，模拟另一个标签页先存了

  // 本机还停在 rev 1（它以为自己是第 1 版），带着 1 去存
  const stale = store.saveState(id, stateOf('LOCAL', 5), 1);
  check('返回冲突标记', () => assert.strictEqual(stale.conflict, true));
  check('带回服务端当前 rev', () => assert.strictEqual(stale.rev, 2));
  check('被拒时保存的卡片没写进去', () => {
    const state = store.getState(id);
    assert.strictEqual(state.nodes.length, 3, '库里应仍是 B 那 3 张，实际 ' + state.nodes.length);
    assert.ok(
      state.nodes.every((node) => String(node.data.text).indexOf('B') === 0),
      '库里内容应仍是 B 的'
    );
  });
  check('被拒时不推进 rev', () => assert.strictEqual(store.getCanvas(id).rev, 2));
}

console.log('\n[3] 不传 rev 就是强制写入（回滚/导入/复制走这条路）');
{
  const store = makeSandbox('force');
  const id = store.createCanvas('强制写入测试').canvas.id;
  store.saveState(id, stateOf('A', 2), 0);
  store.saveState(id, stateOf('B', 3), 1);

  const forced = store.saveState(id, stateOf('FORCED', 4));
  check('不传 rev 不会冲突', () => assert.ok(forced && !forced.conflict));
  check('内容确实被覆盖了', () => assert.strictEqual(store.getState(id).nodes.length, 4));
  check('但版本号照样 +1（好让别的标签页察觉自己过期）', () => assert.strictEqual(store.getCanvas(id).rev, 3));
}

console.log('\n[4] 拿到冲突后用最新 rev 重试就能成功');
{
  const store = makeSandbox('retry');
  const id = store.createCanvas('重试测试').canvas.id;
  store.saveState(id, stateOf('A', 2), 0); // rev 1
  store.saveState(id, stateOf('B', 3), 1); // rev 2

  const stale = store.saveState(id, stateOf('LOCAL', 4), 1);
  check('先撞一次冲突', () => assert.strictEqual(stale.conflict, true));

  // 模拟用户点「保留我的，覆盖过去」：把版本号对齐到服务端当前值再发
  const retry = store.saveState(id, stateOf('LOCAL', 4), stale.rev);
  check('对齐版本号后保存成功', () => assert.ok(retry && !retry.conflict));
  check('内容是本地的了', () => assert.strictEqual(store.getState(id).nodes.length, 4));
  check('rev 又推进了一版', () => assert.strictEqual(retry.rev, 3));
}

console.log('\n[5] getState / getCanvas 都带 rev，前端读得到');
{
  const store = makeSandbox('expose');
  const id = store.createCanvas('暴露测试').canvas.id;
  store.saveState(id, stateOf('A', 1), 0);
  check('getCanvas 带 rev', () => assert.strictEqual(store.getCanvas(id).rev, 1));
  check('getState 里的 canvas 带 rev', () => {
    const state = store.getState(id);
    assert.strictEqual(state.canvas.rev, 1);
  });
  check('列表里也带 rev', () => {
    const one = store.listCanvases().find((c) => c.id === id);
    assert.strictEqual(one.rev, 1);
  });
}

console.log('\n[6] 回滚备份会推进 rev（别的标签页应察觉自己过期）');
{
  const store = makeSandbox('restore');
  const id = store.createCanvas('回滚测试').canvas.id;
  store.saveState(id, stateOf('A', 2), 0); // rev 1
  // 回滚走的就是「不传 rev」这条强制写入路径
  const rolled = store.saveState(id, stateOf('ROLLBACK', 1));
  check('回滚成功', () => assert.ok(rolled && !rolled.conflict));
  check('rev 推进到 2', () => assert.strictEqual(store.getCanvas(id).rev, 2));
  const after = store.saveState(id, stateOf('OLD-TAB', 9), 1);
  check('老的 rev 1 已被判为过期', () => assert.strictEqual(after.conflict, true));
}

console.log('\n[7] expectedRev 传非法值时不误判冲突');
{
  const store = makeSandbox('garbage');
  const id = store.createCanvas('脏数据测试').canvas.id;
  store.saveState(id, stateOf('A', 2), 0); // rev 1
  // 前端可能因为老服务端没回 rev 而传出 undefined / null / 字符串
  check('传 undefined → 强制写入', () => assert.ok(!store.saveState(id, stateOf('X', 1), undefined).conflict));
  check('传 null → 强制写入', () => assert.ok(!store.saveState(id, stateOf('Y', 1), null).conflict));
  check('传字符串 "1" → 强制写入（不按数字硬比，避免误报）', () =>
    assert.ok(!store.saveState(id, stateOf('Z', 1), '1').conflict));
  check('传 NaN → 强制写入', () => assert.ok(!store.saveState(id, stateOf('W', 1), NaN).conflict));
}

console.log('\n[8] 不存在的画布仍返回 null');
{
  const store = makeSandbox('missing');
  check('意外 id 返回 null', () => assert.strictEqual(store.saveState('c_nope', stateOf('A', 1), 0), null));
}

console.log('\n[9] 老库升级：已有的 canvases 表会自动补上 rev 列');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-lock-migrate-'));
  const dbFile = path.join(dir, 'canvas.db');
  // 先用「旧版」表结构造一个没有 rev 列的库，并塞一块画布进去
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(dbFile);
  old.exec(`
    CREATE TABLE canvases (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, viewport TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, type TEXT NOT NULL,
      x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0,
      w REAL NOT NULL DEFAULT 260, h REAL NOT NULL DEFAULT 180,
      z INTEGER NOT NULL DEFAULT 0, data TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, source_id TEXT NOT NULL,
      target_id TEXT NOT NULL, source_port TEXT, target_port TEXT, role TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, canvas_id TEXT, node_id TEXT, channel TEXT, kind TEXT,
      model TEXT, params TEXT, prompt TEXT, remote_id TEXT, status TEXT NOT NULL,
      stage TEXT, waited_ms INTEGER NOT NULL DEFAULT 0, result_path TEXT,
      result_json TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE schedule_runs (
      node_id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, state TEXT NOT NULL,
      items_json TEXT, started_at INTEGER, updated_at INTEGER
    );
  `);
  old.prepare('INSERT INTO canvases (id, name, viewport, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'c_old',
    '老画布',
    JSON.stringify({ x: 0, y: 0, zoom: 1 }),
    1,
    1
  );
  old.close();

  const paths = require(path.join(SERVER, 'paths.js'));
  paths.DATA_DIR = dir;
  paths.DB_FILE = dbFile;
  paths.RECYCLE_DIR = path.join(dir, 'recycle');
  delete require.cache[require.resolve(STORE_PATH)];
  const store = require(STORE_PATH);
  store.init();

  check('老画布能读到，rev 默认为 0', () => {
    const one = store.getCanvas('c_old');
    assert.ok(one, '应能读到老画布');
    assert.strictEqual(one.rev, 0);
  });
  check('老画布能正常保存，rev 从 0 走到 1', () => {
    const r = store.saveState('c_old', stateOf('OLD', 2), 0);
    assert.ok(r && !r.conflict, '不该冲突');
    assert.strictEqual(r.rev, 1);
  });
  check('老画布也能触发冲突', () => {
    const r = store.saveState('c_old', stateOf('X', 1), 0);
    assert.strictEqual(r.conflict, true);
  });
}

console.log('\n' + '='.repeat(46));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
console.log('='.repeat(46));
process.exit(failed ? 1 : 0);