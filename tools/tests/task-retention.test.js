'use strict';

// 守 `pruneOrphanTasks` 的两件相反的事：
//   ① **该删的才删** —— 真正无信息价值的记录要能收掉（否则这个函数白写）
//   ② **不该删的一条都不能动** —— 这条更重要：表里有 50 条带 result_path 的
//      （任务面板靠它告诉用户"文件存到哪了"）和 12 条带 error 的
//      （"通道密钥不对或已过期"这类排查线索 + 用户原始 prompt）。
//      误删这些是**不可逆的信息损失**，比多留几条严重得多。
//
// 做法：造一个隔离库，把各种形态的任务记录都塞进去，跑一次真实的
// `store.init()`，然后逐条核对"谁被删了、谁还在"。
//
// 运行：runtime/node.exe tools/tests/task-retention.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..', '..');

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

// 用真实的 store 模块，但把它指到一个隔离目录。
// 注意 require 缓存：store.js 内部持有数据库连接，换目录后必须重新 require
// （照 share.test.js / store-health.test.js 的做法），否则会连到上一个测试的库。
const STORE_PATH = path.join(ROOT, 'server', 'store.js');
const MIGRATE_PATH = path.join(ROOT, 'server', 'migrate.js');
const PATHS_PATH = path.join(ROOT, 'server', 'paths.js');

function freshStore(dir) {
  process.env.CANVAS_DATA_DIR = dir;
  delete require.cache[require.resolve(STORE_PATH)];
  delete require.cache[require.resolve(MIGRATE_PATH)];
  delete require.cache[require.resolve(PATHS_PATH)];
  // eslint-disable-next-line global-require
  return require(STORE_PATH);
}

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'task-retention-'));
const dataDir = path.join(box, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const store = freshStore(dataDir);
store.init();

// 直接读库核对（另开一个只读连接，不干扰 store 自己的连接）
const { DatabaseSync } = require('node:sqlite');
const DB_FILE = path.join(dataDir, 'canvas.db');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const OLD = now - 10 * DAY;   // 超过 7 天
const FRESH = now - 1 * DAY;  // 7 天内

// 造两块画布 + 两张卡片，作为"还在"的引用目标
const aliveCanvas = store.createCanvas('还在的画布');
store.saveState(aliveCanvas.canvas.id, {
  nodes: [{ id: 'n_alive_1', type: 'image', x: 0, y: 0, w: 360, h: 203, data: { v: 2, text: 'x' } }],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});
const aliveNodeId = 'n_alive_1';

const h = new DatabaseSync(DB_FILE);
// 注意：必须把 error_json / resume_json 也写进去。
// 我第一版漏了这两列，于是 k5（只带 error_json）和 k11（只带 resume_json）
// 实际是空记录、被正常删掉了 —— 测试却报成"代码误删有用的记录"，
// 白白排查了一轮。加列时**插值与断言要一起改**。
const insert = h.prepare(
  `INSERT INTO tasks (id, canvas_id, node_id, channel, kind, model, params, prompt, remote_id,
                      status, stage, waited_ms, result_path, result_json, error,
                      error_json, resume_json, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
function add(row) {
  insert.run(
    row.id, row.canvas_id || '', row.node_id || '', '', row.kind || 'image', row.model || 'm',
    row.params || '{}', row.prompt || '', '', row.status, row.stage || '', 0,
    row.result_path || '', row.result_json || '', row.error || '',
    row.error_json || '', row.resume_json || '', row.created_at, row.created_at
  );
}

// ---------- 应当被删：彻底没有信息价值 ----------
const DOOMED = [
  { id: 'd1', status: 'done', created_at: OLD, canvas_id: 'c_gone', node_id: 'n_gone' },
  { id: 'd2', status: 'failed', created_at: OLD, canvas_id: 'c_gone', node_id: 'n_gone' },
  { id: 'd3', status: 'canceled', created_at: OLD, canvas_id: 'c_gone', node_id: '' },
  { id: 'd4', status: 'failed', created_at: OLD, canvas_id: '', node_id: '' },
];
// ---------- 必须保留 ----------
const KEEP = [
  // ① 画布与卡片都还在（卡片上要显示生成状态）
  { id: 'k1', status: 'done', created_at: OLD, canvas_id: aliveCanvas.canvas.id, node_id: aliveNodeId },
  { id: 'k2', status: 'failed', created_at: OLD, canvas_id: aliveCanvas.canvas.id, node_id: aliveNodeId },
  // ② 画布已删但有 result_path（面板靠它说"文件存到哪了"）
  { id: 'k3', status: 'done', created_at: OLD, canvas_id: 'c_gone', node_id: 'n_gone',
    result_path: '视频/2026-10-29_03-21-57_一只小猫.mp4' },
  // ③ 画布已删但有 error（"通道密钥不对或已过期"这类排查线索）
  { id: 'k4', status: 'failed', created_at: OLD, canvas_id: 'c_gone', node_id: 'n_gone',
    error: '通道密钥不对或已过期', prompt: '画幅比例：16:9横版' },
  // ④ 只有 error_json（结构化失败信息，同样有用）
  { id: 'k5', status: 'failed', created_at: OLD, canvas_id: 'c_gone', node_id: 'n_gone',
    error_json: '{"kind":"AUTH","title":"通道密钥不对或已过期"}' },
  // ⑤ 有 result_json（结果数据）
  { id: 'k6', status: 'done', created_at: OLD, canvas_id: 'c_gone', node_id: 'n_gone',
    result_json: '{"url":"/素材/图片/a.png"}' },
  // ⑥ 非终态：排队 / 在跑，绝不能删（删了前端一直转圈）
  { id: 'k7', status: 'running', created_at: OLD, canvas_id: 'c_gone', node_id: 'n_gone' },
  { id: 'k8', status: 'queued', created_at: OLD, canvas_id: 'c_gone', node_id: 'n_gone' },
  { id: 'k9', status: 'pending', created_at: OLD, canvas_id: 'c_gone', node_id: 'n_gone' },
  // ⑦ 画布已删、无内容，但**还不到 7 天**（给刚删掉的画布留回旋余地）
  { id: 'k10', status: 'done', created_at: FRESH, canvas_id: 'c_gone', node_id: 'n_gone' },
  // ⑧ 有 resume_json（服务重启后要接着等结果）
  { id: 'k11', status: 'failed', created_at: OLD, canvas_id: 'c_gone', node_id: 'n_gone',
    resume_json: '{"remoteId":"abc"}' },
  // ⑨ **画布还在、但节点已不存在**且无内容 —— 专门用来钉住「画布这一个条件」。
  // k1/k2 单独一条守不住它：它们两端都还在，去掉画布条件后仍被节点条件挡住，
  // 于是"放宽画布条件"这种退化测不出来（变异检验 M7 就是这么漏网的）。
  // 这一条只靠画布条件才能保住 —— 因为 deleteCanvas 是硬删，
  // 但节点可能先被删（用户删卡片但留着画布），那种记录仍属于"这块画布的历史"。
  { id: 'k12', status: 'done', created_at: OLD, canvas_id: aliveCanvas.canvas.id, node_id: 'n_never_existed' },
  // ⑩ **节点还在、画布已删**且无内容 —— 对称地钉住「节点这一个条件」
  // （直接往库里插一个属于已删画布的节点来构造）。
  { id: 'k13', status: 'done', created_at: OLD, canvas_id: 'c_gone', node_id: 'n_orphan_node' },
];
DOOMED.forEach(add);
KEEP.forEach(add);

// 为了让 k13（节点还在、画布已删）真正"节点还在"，单独造一个属于不存在画布的节点。
// 这样去掉"画布已不存在"这条条件时，k13 会被删掉 → 测试就能抓到那种退化。
h.prepare(
  `INSERT INTO nodes (id, canvas_id, type, x, y, w, h, z, data, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`
).run('n_orphan_node', 'c_gone', 'image', 0, 0, 360, 203, 0, '{"v":2}', now, now);

// k12 需要一个"画布在、节点不在"的语境：它引用的 n_never_existed 从来不存在，天然满足。
// 但 k1/k2 引用的 aliveNodeId 必须真的存在，否则它们会被节点条件放行、失去守画布的能力。
const aliveNodeExists = h.prepare('SELECT 1 AS ok FROM nodes WHERE id = ?').get(aliveNodeId);
assert.ok(aliveNodeExists, '前置条件：aliveNodeId 必须真的在库里（否则 k1/k2 守不住画布条件）');

// 造一块"已删画布"的节点引用：让 k? 里引用 c_gone 的 node 确实不存在
// （c_gone 从来没建过，所以 canvas/node 都不存在 —— 符合预期）

const before = h.prepare('SELECT COUNT(1) AS n FROM tasks').get().n;

console.log('T1 · 清理规则：该删的删掉');
store.pruneOrphanTasks();

const left = new Set(h.prepare('SELECT id FROM tasks').all().map((r) => r.id));
check('4 条无信息价值的记录被清掉', () => {
  DOOMED.forEach((d) => assert.ok(!left.has(d.id), d.id + ' 应当被删掉，但还在'));
});

console.log('\nT2 · 一条有用的都不能误删（这一条最重要）');
const reasons = {
  k1: '画布与卡片都还在',
  k2: '画布与卡片都还在',
  k3: '有 result_path（文件存到哪了）',
  k4: '有 error（失败原因）',
  k5: '有 error_json（结构化失败信息）',
  k6: '有 result_json（结果数据）',
  k7: 'status=running（正在跑）',
  k8: 'status=queued（排队中）',
  k9: 'status=pending（等待中）',
  k10: '还不到 7 天',
  k11: '有 resume_json（要接着等结果）',
  k12: '画布还在（节点没了也要留，那是这块画布的历史）',
  k13: '节点还在（画布没了也要留，这条记录还指着真实节点）',
};
for (const [id, why] of Object.entries(reasons)) {
  check('保留 ' + id + '（' + why + '）', () => {
    assert.ok(left.has(id), id + ' 被误删了！它' + why + '，删了是不可逆的信息损失');
  });
}

console.log('\nT3 · 数量对得上（没有多删也没有漏删）');
check('剩余条数 = 原有 - 应删', () => {
  assert.strictEqual(left.size, before - DOOMED.length,
    '原 ' + before + ' 条，应删 ' + DOOMED.length + ' 条，剩 ' + (before - DOOMED.length) + '，实际剩 ' + left.size);
});

console.log('\nT4 · 留档：删之前必须留一份能还原的');
const backupFile = path.join(dataDir, 'backups', 'tasks-before-orphan-prune.json');
check('留档文件写出来了', () => {
  assert.ok(fs.existsSync(backupFile), '没有留档就直接删了数据 —— 违反项目「改数据前先备份」的规矩');
});
check('留档里含全部被删记录，且是完整行（能原样插回）', () => {
  const saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  assert.strictEqual(saved.rows.length, DOOMED.length, '留档条数不对');
  const ids = saved.rows.map((r) => r.id).sort();
  assert.deepStrictEqual(ids, DOOMED.map((d) => d.id).sort(), '留档的不是被删的那几条');
  // 完整行：至少要有建表时的关键列
  const first = saved.rows[0];
  for (const col of ['id', 'canvas_id', 'node_id', 'status', 'created_at']) {
    assert.ok(Object.prototype.hasOwnProperty.call(first, col), '留档行缺少列 ' + col);
  }
});
check('留档里给了还原方法说明', () => {
  const saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  assert.ok(typeof saved.how === 'string' && saved.how.length > 5, '没有写怎么还原');
  assert.ok(saved.at > 0, '没有记时间');
});

console.log('\nT5 · 幂等：再跑一次不该再删东西、也不该覆盖留档');
check('第二次跑返回 0（没有可删的）', () => {
  const again = store.pruneOrphanTasks();
  assert.strictEqual(again, 0, '第二次还删了 ' + again + ' 条');
});
check('第二次没动留档（仍是上一次那份）', () => {
  const saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  assert.strictEqual(saved.rows.length, DOOMED.length, '留档被改动了');
});

console.log('\nT6 · 空表 / 全是有用记录时不能出错、不能乱删');
check('把有用的全留下后，函数安全返回 0', () => {
  const n = store.pruneOrphanTasks();
  assert.strictEqual(n, 0, '不该删却删了 ' + n + ' 条');
  const rest = h.prepare('SELECT COUNT(1) AS n FROM tasks').get().n;
  assert.strictEqual(rest, KEEP.length, '剩余条数应为 ' + KEEP.length + '，实际 ' + rest);
});

store.close();
try { fs.rmSync(box, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log('\n' + '─'.repeat(52));
if (fail) {
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(1);
}
console.log('通过 ' + pass + ' 项，失败 0 项');
