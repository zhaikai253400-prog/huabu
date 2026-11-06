'use strict';

// backup.js 的隔离测试：把 DATA_DIR 指到临时目录、把 store 换成假对象，
// 这样可以在不碰真实 data/ 的前提下验证分级备份、保留上限、清理逻辑。
//
// 运行：runtime/node.exe tools/tests/backup.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');

const SERVER = path.resolve(__dirname, '..', '..', 'server');

// ---- 准备隔离环境 ----
// 走统一隔离助手：环境变量 + 派生路径逐个校验，避免「只改 DATA_DIR」的老坑
// （本文件用假 store，风险较低，但对齐同一范式，未来新增测试照抄即可）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-backup-test-'));
const paths = require(path.join(__dirname, '_isolate.js'))(TMP);

// store 换成假对象：只提供 getState，返回我们喂进去的画布
let fakeState = null;
const storePath = require.resolve(path.join(SERVER, 'store.js'));
const realStore = require.cache[storePath];
require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: {
    getState: () => fakeState,
  },
};

const backup = require(path.join(SERVER, 'backup.js'));

function makeState(name, nodeCount) {
  const nodes = [];
  for (let i = 0; i < nodeCount; i += 1) {
    nodes.push({ id: 'n' + i, type: 'image', x: i * 10, y: 0, w: 260, h: 200, z: i, data: { text: '卡' + i } });
  }
  return { canvas: { name: name }, viewport: { x: 0, y: 0, zoom: 1 }, nodes: nodes, edges: [] };
}

const CID = 'c_test001';
const dir = backup.dirOf(CID);
const dailyDir = backup.dailyDirOf(CID);

let pass = 0;
let fail = 0;
function check(label, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + label);
  } catch (error) {
    fail += 1;
    console.log('  ✗ ' + label + '\n      ' + error.message);
  }
}

function jsonFiles(d) {
  try {
    return fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

console.log('临时数据目录: ' + TMP + '\n');

// ---- 1. 基本写入与长期备份 ----
console.log('[1] 基本写入与每日长期备份');
fakeState = makeState('测试画布', 3);

check('maybeBackup(force) 写出一份短期备份', () => {
  const name = backup.maybeBackup(CID, true);
  assert.ok(name, '应返回文件名');
  assert.strictEqual(jsonFiles(dir).length, 1);
});

check('同时产生了今天的长期备份', () => {
  const daily = jsonFiles(dailyDir);
  assert.strictEqual(daily.length, 1, '应有 1 份长期备份，实际 ' + daily.length);
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const expect = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate()) + '.json';
  assert.strictEqual(daily[0], expect, '长期备份应按日期命名');
});

check('同一天重复调用不会重复写长期备份', () => {
  backup.maybeBackup(CID, true);
  backup.maybeBackup(CID, true);
  assert.strictEqual(jsonFiles(dailyDir).length, 1, '长期备份应仍为 1 份');
});

// ---- 2. 短期 5 分钟节流 ----
console.log('\n[2] 短期节流（5 分钟内不重复写）');
check('force=false 时被节流跳过', () => {
  const before = jsonFiles(dir).length;
  const name = backup.maybeBackup(CID, false);
  assert.strictEqual(name, null, '应返回 null 表示跳过');
  assert.strictEqual(jsonFiles(dir).length, before, '不应新增文件');
});

check('force=true 时跳过节流', () => {
  const before = jsonFiles(dir).length;
  const name = backup.maybeBackup(CID, true);
  assert.ok(name, '应写出文件');
  assert.strictEqual(jsonFiles(dir).length, before + 1);
});
// ---- 3. 短期保留上限 ----
console.log('\n[3] 短期只保留最近 10 份');
check('连续写 15 份后短期仍为 10 份', () => {
  for (let i = 0; i < 15; i += 1) {
    // 直接调 forceSnapshot 绕过节流，模拟多次关键动作
    backup.forceSnapshot(CID, fakeState, 'test' + i);
  }
  const shortFiles = jsonFiles(dir).filter((n) => /^\d{4}-\d{2}-\d{2}_/.test(n) || n.startsWith('test'));
  const all = jsonFiles(dir);
  assert.ok(all.length >= backup.MAX_BACKUPS, '至少应有 10 份');
});

check('prune 会把短期压到 MAX_BACKUPS 以内', () => {
  // forceSnapshot 内部会 prune，所以直接看结果
  const all = jsonFiles(dir);
  // 注意：daily 在子目录，不混在里面的 jsonFiles(dir) 计数里
  assert.ok(all.length <= backup.MAX_BACKUPS, '短期应不超过 ' + backup.MAX_BACKUPS + ' 份，实际 ' + all.length);
});

// ---- 4. 强制快照 ----
console.log('\n[4] 强制快照（删除前 / 回滚前 / 批量前）');
check('forceSnapshot 带 label 前缀', () => {
  const name = backup.forceSnapshot(CID, makeState('改乱前', 5), '批量前');
  assert.ok(name, '应返回文件名');
  assert.ok(name.indexOf('批量前-') === 0, '文件名应带 label 前缀，实际 ' + name);
});

check('forceSnapshot 内容确实是传入的那一刻', () => {
  const state = makeState('回滚前版本', 7);
  const name = backup.forceSnapshot(CID, state, '回滚前');
  const read = backup.readBackup(CID, name);
  assert.strictEqual(read.canvas.name, '回滚前版本');
  assert.strictEqual(read.nodes.length, 7);
});

check('state 为 null 时安全返回 null', () => {
  assert.strictEqual(backup.forceSnapshot(CID, null, 'x'), null);
});

check('label 里的非法字符被清掉', () => {
  const name = backup.forceSnapshot(CID, fakeState, 'a/b\\c:d*e');
  assert.ok(/^[a-z]+-/.test(name), '非法字符应被替换，实际 ' + name);
});

// ---- 5. listBackups ----
console.log('\n[5] 历史版本列表');
check('列表区分 recent 与 daily', () => {
  const list = backup.listBackups(CID);
  const recent = list.filter((x) => x.kind === 'recent');
  const daily = list.filter((x) => x.kind === 'daily');
  assert.ok(recent.length > 0, '应有 recent');
  assert.ok(daily.length > 0, '应有 daily');
});

check('每项都带向后兼容字段', () => {
  backup.listBackups(CID).forEach((item) => {
    assert.strictEqual(typeof item.name, 'string');
    assert.strictEqual(typeof item.label, 'string');
    assert.strictEqual(typeof item.bytes, 'number');
    assert.strictEqual(typeof item.mtime, 'number');
  });
});

check('daily 排在 recent 之后', () => {
  const list = backup.listBackups(CID);
  const firstDaily = list.findIndex((x) => x.kind === 'daily');
  const lastRecent = list.map((x) => x.kind).lastIndexOf('recent');
  assert.ok(lastRecent < firstDaily, 'daily 应在 recent 后面');
});

// 回归：daily 文件名是纯日期 2026-11-03，曾被当成「日期+时间」替换成 2026:11:03
check('daily 的 label 显示为日期，不被误替换成冒号', () => {
  const daily = backup.listBackups(CID).find((x) => x.kind === 'daily');
  assert.ok(daily, '应有 daily 项');
  assert.ok(daily.label.indexOf(':') < 0, 'daily 的 label 不该出现冒号，实际: ' + daily.label);
  assert.ok(/\d{4}-\d{2}-\d{2}/.test(daily.label), '应保留完整日期，实际: ' + daily.label);
});

check('带毫秒的快照 label 仍能转成 HH:MM:SS', () => {
  const name = backup.forceSnapshot(CID, fakeState, '批量前');
  const item = backup.listBackups(CID).find((x) => x.name === name);
  assert.ok(item, '应能在列表里找到刚存的快照');
  assert.ok(/\d\d:\d\d:\d\d/.test(item.label), '时间应显示为 HH:MM:SS，实际: ' + item.label);
  assert.ok(item.label.indexOf('提前') > 0 || item.label.indexOf('批量前') === 0, '中文前缀应保留，实际: ' + item.label);
});

// ---- 6. readBackup 安全性 ----
console.log('\n[6] readBackup 路径安全');
check('拒绝路径穿越', () => {
  assert.strictEqual(backup.readBackup(CID, '../../../etc/passwd'), null);
  assert.strictEqual(backup.readBackup(CID, 'a/b.json'), null);
  assert.strictEqual(backup.readBackup(CID, 'x.txt'), null);
});

check('拒绝 Windows 盘符与 ADS 流写法', () => {
  assert.strictEqual(backup.readBackup(CID, 'C:/windows/x.json'), null);
  assert.strictEqual(backup.readBackup(CID, 'a.json:stream'), null);
  assert.strictEqual(backup.readBackup(CID, '..\\..\\x.json'), null);
});

// 这条是回归测试：曾经用 \w 校验文件名，导致「删除前-xxx.json」
// 这种带中文的快照读不出来，用户点「回滚到这里」会直接失败。
check('能读到中文名快照（回滚删除前版本的关键路径）', () => {
  const name = backup.forceSnapshot(CID, makeState('中文快照内容', 4), '删除前');
  assert.ok(name.indexOf('删除前-') === 0, '应生成中文前缀文件名');
  const read = backup.readBackup(CID, name);
  assert.ok(read, '中文名快照必须能读出来，否则回滚会失败');
  assert.strictEqual(read.canvas.name, '中文快照内容');
});

check('能读到 daily 子目录里的文件', () => {
  const dailyName = jsonFiles(dailyDir)[0];
  const read = backup.readBackup(CID, dailyName);
  assert.ok(read, '应能读到 daily 里的文件');
  assert.strictEqual(read.canvas.name, '测试画布');
});

check('不存在的文件返回 null', () => {
  assert.strictEqual(backup.readBackup(CID, 'nope-not-here.json'), null);
});

// ---- 7. 长期过期清理 ----
console.log('\n[7] 长期备份过期清理');
check('超过 30 天的 daily 会在新的一天首次检查时被清掉', () => {
  const pad = (n) => String(n).padStart(2, '0');
  const dayOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.json';

  const old = new Date();
  old.setDate(old.getDate() - 45);
  const oldName = dayOf(old);
  fs.writeFileSync(path.join(dailyDir, oldName), JSON.stringify({ savedAt: 1 }), 'utf8');
  assert.ok(jsonFiles(dailyDir).indexOf(oldName) >= 0, '过期文件应已放入');

  // maybeDaily 有「今天已查过就跳过」的短路（一天只查一次，避免每次保存都 readdir）。
  // 所以这里把模块重新加载一遍，模拟「到了新的一天」，再触发一次检查。
  delete require.cache[require.resolve(path.join(SERVER, 'backup.js'))];
  const fresh = require(path.join(SERVER, 'backup.js'));
  fresh.maybeBackup(CID, true);

  assert.ok(jsonFiles(dailyDir).indexOf(oldName) < 0, '过期文件应被清理，实际还在: ' + jsonFiles(dailyDir).join(','));
});

check('清理只删过期的那份，不误伤其他', () => {
  const pad = (n) => String(n).padStart(2, '0');
  const dayOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.json';
  const todayName = dayOf(new Date());
  assert.ok(jsonFiles(dailyDir).indexOf(todayName) >= 0, '今天的长期备份不该被误删');
});

check('30 天内的 daily 会被保留', () => {
  const keep = new Date();
  keep.setDate(keep.getDate() - 10);
  const pad = (n) => String(n).padStart(2, '0');
  const keepName = keep.getFullYear() + '-' + pad(keep.getMonth() + 1) + '-' + pad(keep.getDate()) + '.json';
  fs.writeFileSync(path.join(dailyDir, keepName), JSON.stringify({ savedAt: 1 }), 'utf8');
  backup.maybeBackup(CID, true);
  assert.ok(jsonFiles(dailyDir).indexOf(keepName) >= 0, '10 天前的应保留');
});

// ---- 7. 同一毫秒内连写两份不能互相覆盖 ----
console.log('\n[7] 同一毫秒内连写两份不能互相覆盖');
check('同一毫秒连写两份强制快照，两份都要在', () => {
  // 删除前 + 回滚前这种连续动作完全可能落在同一毫秒。
  // 以前只靠毫秒时间戳命名，后一份会把前一份直接覆盖掉（一次留痕白丢）。
  const a = backup.forceSnapshot(CID, fakeState, 'same-ms');
  const b = backup.forceSnapshot(CID, fakeState, 'same-ms');
  assert.ok(a && b, '两次都应返回文件名');
  assert.notStrictEqual(a, b, '两次写出的文件名不能相同');
  const all = jsonFiles(dir);
  assert.ok(all.indexOf(a) >= 0, '第一份应仍在，实际没了: ' + a);
  assert.ok(all.indexOf(b) >= 0, '第二份应已写出: ' + b);
});

check('撞名后加序号的文件仍能正常读回来', () => {
  const name = backup.forceSnapshot(CID, fakeState, 'same-ms');
  const back = backup.readBackup(CID, name);
  assert.ok(back, '应能读回');
  assert.strictEqual(back.nodes.length, fakeState.nodes.length);
});

check('撞名后的标签不带尾部序号', () => {
  backup.forceSnapshot(CID, fakeState, 'same-ms');
  const one = backup.listBackups(CID).filter((x) => x.name.indexOf('same-ms') === 0)[0];
  assert.ok(one, '应找得到 same-ms 快照');
  assert.ok(!/-\d+$/.test(one.label), '标签不该带序号，实际: ' + one.label);
});

// ---- 清理 ----
if (realStore) require.cache[storePath] = realStore;
fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + '='.repeat(46));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
