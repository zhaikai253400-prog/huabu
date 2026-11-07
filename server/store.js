'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DB_FILE, RECYCLE_DIR, DATA_DIR, ensureDir } = require('./paths');
const migrate = require('./migrate');

let db = null;

// 库出过状况时留个凭证，等着界面上告诉用户一声。
// 为什么要有这个：以前坏库被悄悄挪进回收站、重建一个空库接着用，
// 用户打开画布只看到「画布都没了」，完全不知道旧库还在、更不知道在哪，
// 很容易以为数据丢了。现在把这件事记下来，页面加载时拉一次并显式提示。
let healthNotice = null;

// 数据库打不开（文件坏了 / 被别的程序占着）时，把坏库挪到回收站，重建一个空库接着用。
// 返回挪去的目录（成功时）；挪不动返回空串。
function quarantineDb() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(RECYCLE_DIR, 'db-broken-' + stamp);
  try {
    ensureDir(dir);
    let moved = 0;
    ['canvas.db', 'canvas.db-wal', 'canvas.db-shm'].forEach((name) => {
      const file = path.join(path.dirname(DB_FILE), name);
      if (fs.existsSync(file)) {
        fs.renameSync(file, path.join(dir, name));
        moved += 1;
      }
    });
    console.log('[数据库] 旧库已挪到回收站：' + dir);
    // 一个文件都没挪走，说明目录建了但内容是空的，这个路径没有参考价值
    return moved > 0 ? dir : '';
  } catch (error) {
    console.log('[数据库] 旧库挪不动：' + error.message);
    return '';
  }
}

function now() {
  return Date.now();
}

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function openDb() {
  db = new DatabaseSync(DB_FILE);
  // busy_timeout：WAL 下读写虽然能并行，但 checkpoint / 换库这类操作仍可能短暂持锁。
  // 没有等待时间时，同一瞬间的第二个写入请求会直接抛 SQLITE_BUSY，用户看到的是保存失败。
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      viewport TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      canvas_id TEXT NOT NULL,
      type TEXT NOT NULL,
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      w REAL NOT NULL DEFAULT 260,
      h REAL NOT NULL DEFAULT 180,
      z INTEGER NOT NULL DEFAULT 0,
      data TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      canvas_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      source_port TEXT,
      target_port TEXT,
      role TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      canvas_id TEXT,
      node_id TEXT,
      channel TEXT,
      kind TEXT,
      model TEXT,
      params TEXT,
      prompt TEXT,
      remote_id TEXT,
      status TEXT NOT NULL,
      stage TEXT,
      waited_ms INTEGER NOT NULL DEFAULT 0,
      result_path TEXT,
      result_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedule_runs (
      node_id TEXT PRIMARY KEY,
      canvas_id TEXT NOT NULL,
      state TEXT NOT NULL,
      items_json TEXT,
      backups_json TEXT,
      started_at INTEGER,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_canvas ON schedule_runs(canvas_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_canvas ON nodes(canvas_id);
    CREATE INDEX IF NOT EXISTS idx_edges_canvas ON edges(canvas_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `);
  // 老库升级：edges 表没有 role 字段时补上，连线上的角色才不会丢
  const edgeColumns = db.prepare('PRAGMA table_info(edges)').all().map((row) => row.name);
  if (edgeColumns.indexOf('role') < 0) db.exec('ALTER TABLE edges ADD COLUMN role TEXT');
  // 老库升级：任务表补一列，用来记住生成结果（关掉浏览器再打开也能接着看到）
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name);
  if (taskColumns.indexOf('result_json') < 0) db.exec('ALTER TABLE tasks ADD COLUMN result_json TEXT');
  // 老库升级：任务表补一列，用来记住异步任务的接续信息（服务重启后接着等结果）
  const taskColumns2 = db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name);
  if (taskColumns2.indexOf('resume_json') < 0) db.exec('ALTER TABLE tasks ADD COLUMN resume_json TEXT');
  // 老库升级：任务表补一列，存结构化的失败信息（分类 / 建议 / 平台原文）。
  // error 那列继续留着放一句话摘要，老前端读它也不受影响。
  const taskColumns3 = db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name);
  if (taskColumns3.indexOf('error_json') < 0) db.exec('ALTER TABLE tasks ADD COLUMN error_json TEXT');
  // 老库升级：定时组运行记录补一列，存这一轮冻结的备用模型清单
  const runColumns = db.prepare('PRAGMA table_info(schedule_runs)').all().map((row) => row.name);
  if (runColumns.indexOf('backups_json') < 0) db.exec('ALTER TABLE schedule_runs ADD COLUMN backups_json TEXT');
  // 老库升级：画布表补一列版本号，用来挡住「两个标签页同时改，后保存的把先保存的盖掉」。
  // 老画布从 0 起算，前端一读到就会带上这个号，行为跟新画布一致。
  const canvasColumns = db.prepare('PRAGMA table_info(canvases)').all().map((row) => row.name);
  if (canvasColumns.indexOf('rev') < 0) db.exec('ALTER TABLE canvases ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
  // 共享工作区：shared=1 表示这块画布对局域网开放；share_token 是进入它的钥匙。
  // 停止共享时把 token 换成新的（或清空），旧链接当场失效，不用记「谁拿过链接」。
  if (canvasColumns.indexOf('shared') < 0) db.exec('ALTER TABLE canvases ADD COLUMN shared INTEGER NOT NULL DEFAULT 0');
  if (canvasColumns.indexOf('share_token') < 0) db.exec('ALTER TABLE canvases ADD COLUMN share_token TEXT');
  // 顺手清掉已经不存在的那块画布留下的卡片 / 连线记录，别让它们一直躺在库里
  try {
    db.exec('DELETE FROM nodes WHERE canvas_id NOT IN (SELECT id FROM canvases)');
    db.exec('DELETE FROM edges WHERE canvas_id NOT IN (SELECT id FROM canvases)');
  } catch (error) {
    console.log('[数据库] 清理孤立记录跳过：' + error.message);
  }
  return db;
}

function init() {
  ensureDir(path.dirname(DB_FILE));
  let opened;
  try {
    opened = openDb();
  } catch (error) {
    console.log('[数据库] 打开失败，重建一个空库：' + error.message);
    try {
      if (db && db.close) db.close();
    } catch {
      /* 忽略 */
    }
    db = null;
    const oldDir = quarantineDb();
    // 重建成功才记告警：重建也失败的话 init 会往上抛，不需要这条提示误导用户
    const rebuilt = openDb();
    healthNotice = {
      level: 'error',
      code: 'DB_REBUILT',
      at: Date.now(),
      oldDir: oldDir,
      reason: String((error && error.message) || error || '未知原因'),
    };
    opened = rebuilt;
  }
  // 老任务记录里那一份 submittedPrompt 也该收掉（见 migrate.packTaskParams）。
  // 放在启动时一次做完，而不是等哪条任务被重新写一遍 —— 174 条里 141 条带着它，
  // 不主动清就永远躺在那儿，占着 594KB。
  try {
    pruneTaskSubmissionPrompts();
  } catch (error) {
    console.log('[数据库] 清理任务里的重复提示词跳过：' + error.message);
  }
  return opened;
}

// 一次性把 tasks.params 里的 submittedPrompt 收掉。
//
// 与节点那边同一套规则：先拿存下来的值校准 tailAppended，能精确重算才删；
// 两种拼法都对不上的原样保留。已清过的（没有该字段）直接跳过，所以重复跑没有代价。
// 返回清掉了几条。
//
// **动手之前先留一份原样备份**：这是在改用户的数据，而它发生在启动时、
// 不经过 saveState，没有别的地方会替它留档。项目对「真正改动数据」的规矩是
// 必须先备份（见 migrate.js 开头那段），这里照办。留档失败就不动数据。
//
// 备份只记「被摘掉的那几个字段」，不整份抄 params：
//   · 整份抄一遍实测 1906KB，而为省下的只有 594KB —— 等于用更大的代价换更小的收益；
//   · 要能原样退回去，真正需要的只有 submittedPrompt 和校正后的 tailAppended，
//     其余字段（mainPrompt / 各类参数…）我们根本没动。
// 文件名固定不带时间戳：这份记录只可能用上一次（清完就没有可清的了），
// 固定名字让它覆盖而不是越攒越多 —— 这个项目刚清理过 352 个 .bak，不该再添新的。
function pruneTaskSubmissionPrompts() {
  const database = handle();
  const rows = database.prepare('SELECT id, params FROM tasks').all();
  const pending = [];
  rows.forEach((row) => {
    let parsed = null;
    try {
      parsed = row.params ? JSON.parse(row.params) : null;
    } catch {
      return; // 坏记录不动
    }
    const packed = migrate.packTaskParams(parsed);
    if (packed === parsed) return; // 没可省的（含「重算不出来」那种）
    pending.push({
      id: row.id,
      params: JSON.stringify(packed),
      removed: String(parsed.submittedPrompt || ''),
      tailAppended: Boolean(packed.tailAppended),
    });
  });
  if (!pending.length) return 0;

  // 先留档。要用它退回去：把 removed 写回该条的 submittedPrompt 即可
  // （tailAppended 已经校准过，不必再改）。
  const file = path.join(DATA_DIR, 'backups', 'tasks-before-prune.json');
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(
      file,
      JSON.stringify({
        at: Date.now(),
        reason: '清理任务记录里重复的提交提示词',
        how: '把每条的 removed 写回该 id 对应 params.submittedPrompt 即可还原',
        rows: pending,
      }),
      'utf8'
    );
  } catch (error) {
    console.log('[数据库] 留档失败，这次不动任务记录：' + error.message);
    return 0;
  }

  const update = database.prepare('UPDATE tasks SET params = ? WHERE id = ?');
  let done = 0;
  pending.forEach((one) => {
    update.run(one.params, one.id);
    done += 1;
  });
  if (done) {
    console.log(
      '[数据库] 已清理 ' + done + ' 条任务记录里的重复提示词' +
      '（被摘掉的内容存在 data/backups/tasks-before-prune.json，可原样还原）'
    );
  }
  return done;
}

// 供 /api/health 读取。返回副本，避免调用方改到内部状态。
function getHealthNotice() {
  if (!healthNotice) return null;
  return Object.assign({}, healthNotice);
}

// 用户确认看过之后清掉，避免每次刷新都弹同样的提示
function clearHealthNotice() {
  const had = Boolean(healthNotice);
  healthNotice = null;
  return had;
}

function handle() {
  if (!db) init();
  return db;
}

function rowToCanvas(row, nodeCount) {
  return {
    id: row.id,
    name: row.name,
    viewport: row.viewport ? JSON.parse(row.viewport) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 版本号：每次整块保存 +1。前端读画布时拿到它，保存时原样带回来，
    // 对不上就说明期间有别人（另一个标签页）改过，服务端会拒收并回最新的
    rev: Number(row.rev || 0),
    // 这块画布是不是正开着共享（门户页据此显示「共享中」）
    shared: Number(row.shared || 0) === 1,
    nodeCount: nodeCount === undefined ? 0 : nodeCount,
  };
}

function listCanvases() {
  const rows = handle()
    .prepare(
      `SELECT c.*, (SELECT COUNT(1) FROM nodes n WHERE n.canvas_id = c.id) AS node_count
       FROM canvases c
       WHERE c.deleted_at IS NULL
       ORDER BY c.updated_at DESC`
    )
    .all();
  return rows.map((row) => rowToCanvas(row, Number(row.node_count || 0)));
}

function getCanvas(id) {
  const row = handle().prepare('SELECT * FROM canvases WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return null;
  const count = handle().prepare('SELECT COUNT(1) AS c FROM nodes WHERE canvas_id = ?').get(id);
  return rowToCanvas(row, Number(count.c || 0));
}

function uniqueName(name, excludeId) {
  const base = String(name || '').trim() || '未命名画布';
  const rows = handle().prepare('SELECT id, name FROM canvases WHERE deleted_at IS NULL').all();
  const taken = new Set(rows.filter((row) => row.id !== excludeId).map((row) => row.name));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(base + ' (' + index + ')')) index += 1;
  return base + ' (' + index + ')';
}

function createCanvas(name) {
  const id = newId('c');
  const stamp = now();
  const finalName = uniqueName(name, null);
  handle()
    .prepare('INSERT INTO canvases (id, name, viewport, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, finalName, JSON.stringify({ x: 0, y: 0, zoom: 1 }), stamp, stamp);
  return { canvas: getCanvas(id), renamed: finalName !== String(name || '').trim() };
}

function renameCanvas(id, name) {
  const canvas = getCanvas(id);
  if (!canvas) return null;
  const finalName = uniqueName(name, id);
  handle()
    .prepare('UPDATE canvases SET name = ?, updated_at = ? WHERE id = ?')
    .run(finalName, now(), id);
  return getCanvas(id);
}

function duplicateCanvas(id) {
  const source = getCanvas(id);
  if (!source) return null;
  const state = getState(id);
  const created = createCanvas(source.name + ' - 副本');
  // 复制也是整份换新编号，卡片里指向别人的字段（组合成员 / @ 引用 / 首尾帧顺序）要一起改
  const idMap = new Map(state.nodes.map((node) => [node.id, newId('n')]));
  const nodes = state.nodes.map((node) =>
    Object.assign({}, node, {
      id: idMap.get(node.id),
      data: JSON.parse(JSON.stringify(node.data || {})),
    })
  );
  nodes.forEach((node) => remapDataRefs(node.data, idMap));
  const edges = state.edges.map((edge) => ({
    ...edge,
    id: newId('e'),
    sourceId: idMap.get(edge.sourceId) || edge.sourceId,
    targetId: idMap.get(edge.targetId) || edge.targetId,
  }));
  saveState(created.canvas.id, { nodes, edges, viewport: state.viewport });
  return getCanvas(created.canvas.id);
}

function safeFileName(name) {
  const clean = String(name || '画布')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  return clean.slice(0, 60) || '画布';
}

function localStamp() {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' +
    pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds()) + '-' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

function deleteCanvas(id) {
  const canvas = getCanvas(id);
  if (!canvas) return false;
  // 删之前先把整块画布存一份到回收站（导出格式），误删了能用「导入画布备份」捞回来
  let recycled = '';
  try {
    const dump = exportCanvas(id);
    const dir = path.join(RECYCLE_DIR, '画布-' + localStamp());
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, safeFileName(canvas.name) + '.json'), JSON.stringify(dump, null, 2), 'utf8');
    recycled = dir;
  } catch (error) {
    console.log('[画布] 删除前备份没写成：' + error.message);
  }
  const database = handle();
  database.exec('BEGIN');
  try {
    database.prepare('DELETE FROM nodes WHERE canvas_id = ?').run(id);
    database.prepare('DELETE FROM edges WHERE canvas_id = ?').run(id);
    database.prepare('DELETE FROM schedule_runs WHERE canvas_id = ?').run(id);
    database.prepare('DELETE FROM canvases WHERE id = ?').run(id);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  // 这块画布的自动备份也一起挪进回收站，别在 data\backups 里留一堆没主的文件夹
  try {
    const backupDir = path.join(DATA_DIR, 'backups', String(id));
    if (fs.existsSync(backupDir)) {
      let target = recycled ? path.join(recycled, '历史版本') : path.join(RECYCLE_DIR, '历史版本-' + localStamp());
      if (fs.existsSync(target)) target = target + '-' + localStamp();
      ensureDir(path.dirname(target));
      fs.renameSync(backupDir, target);
    }
  } catch (error) {
    console.log('[画布] 历史版本没挪走：' + error.message);
  }
  return recycled || true;
}

function getState(canvasId) {
  const canvas = getCanvas(canvasId);
  if (!canvas) return null;
  const nodes = handle()
    .prepare('SELECT * FROM nodes WHERE canvas_id = ? ORDER BY z ASC, created_at ASC')
    .all(canvasId)
    .map((row) => ({
      id: row.id,
      type: row.type,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      z: row.z,
      data: row.data ? JSON.parse(row.data) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  const edges = handle()
    .prepare('SELECT * FROM edges WHERE canvas_id = ? ORDER BY created_at ASC')
    .all(canvasId)
    .map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      role: row.role || '',
      sourcePort: row.source_port,
      targetPort: row.target_port,
    }));
  return { canvas, nodes, edges, viewport: canvas.viewport };
}

// 整块保存画布。
//
// expectedRev 是乐观锁：调用方从 getState() 读到 rev，保存时原样带回来。
// 对不上说明这块画布在「读出来」和「存回去」之间被别处改过了——
// 典型场景是两个标签页同时开着同一块画布，后保存的会把先保存的整个盖掉。
// 对不上时这里一个字都不写，直接把服务端现状回给调用方，由它决定怎么办。
//
// 不传 expectedRev 就是强制写入（回滚备份、导入、复制画布这类「用户已经明确
// 点了按钮」的操作走这条路），但版本号照样 +1，好让别的标签页察觉自己过期了。
//
// 注意：这个函数全程同步，中间没有任何 await。node:sqlite 是同步 API，
// 单进程内没有交错执行的机会，所以「读 rev → 比对 → 写入」是原子的，
// 不需要额外加锁。以后若要在这里加 await，必须先补事务与锁。
function saveState(canvasId, payload, expectedRev) {
  const canvas = getCanvas(canvasId);
  if (!canvas) return null;
  const wantsRev = Number.isInteger(expectedRev) ? expectedRev : null;
  if (wantsRev !== null && wantsRev !== canvas.rev) {
    return {
      conflict: true,
      rev: canvas.rev,
      savedAt: canvas.updatedAt,
      nodeCount: canvas.nodeCount,
      nodeId: canvasId,
    };
  }
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const edges = Array.isArray(payload.edges) ? payload.edges : [];
  const viewport = payload.viewport || canvas.viewport || { x: 0, y: 0, zoom: 1 };
  const stamp = now();
  const database = handle();
  // 卡片编号在库里是全局唯一的。万一有别的画布占用了同样的编号（极少数情况，
  // 比如外面导入的数据），当场给它换个新编号，连线也跟着改指过去，
  // 免得整块画布直接存不进去、改动白做。
  const taken = new Set(
    database
      .prepare('SELECT id FROM nodes WHERE canvas_id <> ?')
      .all(canvasId)
      .map((row) => String(row.id))
  );
  const idMap = new Map();
  const fixedNodes = nodes.map((node) => {
    const raw = String(node.id || newId('n'));
    if (!taken.has(raw)) {
      taken.add(raw);
      return Object.assign({}, node, { id: raw });
    }
    const fresh = newId('n');
    taken.add(fresh);
    idMap.set(raw, fresh);
    return Object.assign({}, node, { id: fresh });
  });
  const fixedEdges = idMap.size
    ? edges.map((edge) =>
        Object.assign({}, edge, {
          sourceId: idMap.get(String(edge.sourceId || '')) || edge.sourceId,
          targetId: idMap.get(String(edge.targetId || '')) || edge.targetId,
        })
      )
    : edges;
  // 写库前过一道版本迁移（清单 39）：这是所有节点数据进库的唯一漏斗，
  // 老卡片（废弃类型、老 prompt 字段）在这里就地升级并盖上当前版本号。
  // 迁移是幂等的，新数据走的是「读到版本号相等就返回」，一次比较而已。
  const stampResult = migrate.migrateCanvasData(fixedNodes);
  const migratedNodes = stampResult.nodes;
  database.exec('BEGIN');
  try {
    database.prepare('DELETE FROM nodes WHERE canvas_id = ?').run(canvasId);
    database.prepare('DELETE FROM edges WHERE canvas_id = ?').run(canvasId);
    const insertNode = database.prepare(
      `INSERT INTO nodes (id, canvas_id, type, x, y, w, h, z, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    migratedNodes.forEach((node, index) => {
      insertNode.run(
        String(node.id || newId('n')),
        canvasId,
        String(node.type || 'card'),
        Number(node.x) || 0,
        Number(node.y) || 0,
        Number(node.w) || 260,
        Number(node.h) || 180,
        Number.isFinite(Number(node.z)) ? Number(node.z) : index,
        JSON.stringify(node.data || {}),
        Number(node.createdAt) || stamp,
        stamp
      );
    });
    const insertEdge = database.prepare(
      `INSERT INTO edges (id, canvas_id, source_id, target_id, source_port, target_port, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    fixedEdges.forEach((edge) => {
      insertEdge.run(
        String(edge.id || newId('e')),
        canvasId,
        String(edge.sourceId || ''),
        String(edge.targetId || ''),
        edge.sourcePort ? String(edge.sourcePort) : null,
        edge.targetPort ? String(edge.targetPort) : null,
        edge.role ? String(edge.role) : null,
        stamp
      );
    });
    database
      .prepare('UPDATE canvases SET viewport = ?, updated_at = ?, rev = rev + 1 WHERE id = ?')
      .run(JSON.stringify(viewport), stamp, canvasId);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  const nextRev = Number((database.prepare('SELECT rev FROM canvases WHERE id = ?').get(canvasId) || {}).rev || 0);
  return {
    savedAt: stamp,
    nodeCount: migratedNodes.length,
    edgeCount: fixedEdges.length,
    rev: nextRev,
    canvasId: canvasId,
    // 只有真的升级了老数据才带上这一项，平时是 undefined —— 调用方一句
    // result.migrated && ... 就能判断，不用去理解迁移内部的细节
    migrated: migratedNodes.length && stampResult.changed
      ? { count: stampResult.changes.stamp, changes: stampResult.changes, summary: summarizeMigration(stampResult.changes) }
      : undefined,
  };
}

// ---------- 共享工作区 ----------
//
// 共享的语义是「同一块画布，几台电脑一起编辑」，所以数据只有一份，就在主机的 data 里。
// 这里管三件事：开 / 关共享、列出共享画布、以及「按卡片增量写」。

// 开共享。重复点不会改变任何东西（幂等），省得「关了又开」把正在编辑的人踢掉。
function enableShare(canvasId) {
  const canvas = getCanvas(canvasId);
  if (!canvas) return null;
  handle().prepare("UPDATE canvases SET shared = 1 WHERE id = ?").run(String(canvasId));
  return { id: canvasId, name: canvas.name, rev: canvas.rev, shared: true };
}

function disableShare(canvasId) {
  const canvas = getCanvas(canvasId);
  if (!canvas) return null;
  handle().prepare("UPDATE canvases SET shared = 0 WHERE id = ?").run(String(canvasId));
  return { id: canvasId, name: canvas.name, rev: canvas.rev, shared: false };
}

// 有没有任何一块画布正开着共享。局域网协作的总开关就看这一条。
function hasShared() {
  const row = handle()
    .prepare('SELECT 1 AS ok FROM canvases WHERE deleted_at IS NULL AND shared = 1 LIMIT 1')
    .get();
  return Boolean(row);
}

function isShared(canvasId) {
  const row = handle()
    .prepare("SELECT shared FROM canvases WHERE id = ? AND deleted_at IS NULL")
    .get(String(canvasId || ""));
  return Boolean(row && Number(row.shared) === 1);
}

// 共享画布清单（不含密钥，本来也没有密钥：进不进得去由局域网和人数上限决定）
function listSharedCanvases() {
  return handle()
    .prepare(
      "SELECT c.id, c.name, c.rev, c.updated_at, " +
        "(SELECT COUNT(1) FROM nodes n WHERE n.canvas_id = c.id) AS node_count " +
        "FROM canvases c WHERE c.deleted_at IS NULL AND c.shared = 1 ORDER BY c.updated_at DESC"
    )
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      rev: Number(row.rev || 0),
      updatedAt: Number(row.updated_at) || 0,
      nodeCount: Number(row.node_count || 0),
    }));
}

// 删画布 / 关服务时清掉共享状态，别留下一个「开着但打不开」的共享。
function clearShareOf(canvasId) {
  try {
    handle().prepare("UPDATE canvases SET shared = 0 WHERE id = ?").run(String(canvasId));
  } catch {
    /* 库都没了，没什么可清的 */
  }
}

// ---------- 按卡片增量写（共享保存用） ----------
//
// 为什么不能沿用 saveState：它是「先删光再整块写回」。两个人同时编辑一块画布时，
// 谁后保存谁就把对方刚写的内容整块盖掉 —— 哪怕两人改的根本不是同一张卡片。
//
// 这里改成按卡片写：调用方只报「我改了哪几张」，服务端只动这几张。
//
// 冲突判据是「基线比对」，不用版本号也不用哈希：
//   客户端保存时，每张要写的卡片带一个 base —— 它上一次从服务端同步时看到的这张卡的样子。
//   服务端拿库里当前的样子和 base 比：
//     · 一样            → 我读之后没人动过，直接写
//     · 和我要写的一样  → 对方改成了跟我一样的内容，跳过，不算冲突
//     · 不一样          → 这张卡片对方刚改过，报冲突，由人来定怎么办
//   base 为 null / 缺省表示「我认为这张卡还不存在」（新建卡片）。
//
// 这样不需要给每张卡片加版本号，也不用维护「谁改过」的账本：
// 内容本身就是版本 —— 改回原样就等于没改过。

// 稳定序列化：对象键排序后输出。内容一样就一定得到同一个字符串，
// 不受「谁先写的哪个字段」影响。
function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = [];
    keys.forEach((key) => {
      const one = value[key];
      if (one === undefined) return;
      parts.push(JSON.stringify(key) + ":" + stableStringify(one));
    });
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(value);
}

// 一张卡片的规范形状：库里的行和前端发来的卡片都收敛成这一种，才比得了
function canonNode(node) {
  const data =
    node && node.data && typeof node.data === "object" && !Array.isArray(node.data) ? node.data : {};
  return {
    type: String((node && node.type) || "card"),
    x: Math.round(Number(node && node.x) || 0),
    y: Math.round(Number(node && node.y) || 0),
    w: Math.round(Number(node && node.w) || 0),
    h: Math.round(Number(node && node.h) || 0),
    // z（叠放次序）不参与比对，理由见 nodeSignature 上方注释
    data: data,
  };
}

function nodeSignature(node) {
  return stableStringify(canonNode(node));
}

function rowToNode(row) {
  if (!row) return null;
  let data = {};
  try {
    data = row.data ? JSON.parse(row.data) : {};
  } catch {
    data = {};
  }
  return {
    id: row.id,
    type: row.type,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    z: row.z,
    data: data,
    createdAt: row.created_at,
  };
}

// 把一张卡片写进去（有就更新，没有就插入）
function writeNode(database, canvasId, node, stamp) {
  const id = String(node.id);
  const exists = database.prepare("SELECT 1 AS ok FROM nodes WHERE id = ?").get(id);
  const data = JSON.stringify(node.data || {});
  const type = String(node.type || "card");
  const x = Math.round(Number(node.x) || 0);
  const y = Math.round(Number(node.y) || 0);
  const w = Math.round(Number(node.w) || 0);
  const h = Math.round(Number(node.h) || 0);
  const z = Number.isFinite(Number(node.z)) ? Number(node.z) : 0;
  if (exists) {
    database
      .prepare("UPDATE nodes SET canvas_id = ?, type = ?, x = ?, y = ?, w = ?, h = ?, z = ?, data = ?, updated_at = ? WHERE id = ?")
      .run(canvasId, type, x, y, w, h, z, data, stamp, id);
    return;
  }
  database
    .prepare("INSERT INTO nodes (id, canvas_id, type, x, y, w, h, z, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, canvasId, type, x, y, w, h, z, data, Number(node.createdAt) || stamp, stamp);
}

// 增量保存。payload：
//   { upserts: [{ node, base }], deletes: [nodeId],
//     edgeUpserts: [...], edgeDeletes: [edgeId], viewport }
//
// 返回 { rev, applied, conflicts }：conflicts 里的卡片这一轮一个字都没写，
// 其余卡片照常落库 —— 两个人改不同的卡片就该都成功，这是共享的基本要求。
function applyPatch(canvasId, payload) {
  const canvas = getCanvas(canvasId);
  if (!canvas) return null;
  const body = payload && typeof payload === "object" ? payload : {};
  const upserts = Array.isArray(body.upserts) ? body.upserts : [];
  const deletes = Array.isArray(body.deletes) ? body.deletes : [];
  const edgeUpserts = Array.isArray(body.edgeUpserts) ? body.edgeUpserts : [];
  const edgeDeletes = Array.isArray(body.edgeDeletes) ? body.edgeDeletes : [];
  const stamp = now();
  const database = handle();

  // 第一遍只做判断、不写库：要写的东西攒齐了一次性进事务
  const conflicts = [];
  const writes = [];
  upserts.forEach((entry) => {
    if (!entry || !entry.node || !entry.node.id) return;
    const node = entry.node;
    const id = String(node.id);
    const row = database.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    // 卡片编号在库里全局唯一；被别的画布占了就直接判冲突，不擅自改号
    if (row && String(row.canvas_id) !== String(canvasId)) {
      conflicts.push({ nodeId: id, reason: "other-canvas", server: null });
      return;
    }
    const current = rowToNode(row);
    const hasBase = Object.prototype.hasOwnProperty.call(entry, "base");
    const base = hasBase ? entry.base : undefined;
    if (!current) {
      // 库里没有：base 说「本来就有」就是被对方删了；否则就是正常新建
      if (base) {
        conflicts.push({ nodeId: id, reason: "deleted", server: null });
        return;
      }
      writes.push(node);
      return;
    }
    // 库里已经有：不给我基线（老客户端）就当作强制写，只用在明确的整批操作上
    if (!hasBase) {
      writes.push(node);
      return;
    }
    if (base && nodeSignature(current) === nodeSignature(base)) {
      writes.push(node);
      return;
    }
    if (nodeSignature(current) === nodeSignature(node)) {
      // 对方已经改成了和我一样的，什么都不用做
      return;
    }
    conflicts.push({ nodeId: id, reason: "changed", server: current });
  });

  // 删除不判冲突：删一张已经被对方删掉的卡片，结果一样，没必要打扰人
  const removed = [];
  deletes.forEach((id) => {
    const key = String(id || "");
    if (!key) return;
    const existed = database
      .prepare("SELECT 1 AS ok FROM nodes WHERE id = ? AND canvas_id = ?")
      .get(key, String(canvasId));
    if (existed) removed.push(key);
  });

  const touched =
    writes.length || removed.length || edgeUpserts.length || edgeDeletes.length || body.viewport;
  if (!touched) {
    return {
      rev: canvas.rev,
      applied: {
        upserted: 0, deleted: 0, upsertedIds: [], deletedIds: [], edges: 0,
        upsertedNodes: [], doneEdges: [], removedEdges: [],
      },
      conflicts: conflicts,
    };
  }

  database.exec("BEGIN");
  try {
    writes.forEach((node) => writeNode(database, canvasId, node, stamp));
    removed.forEach((id) => {
      database.prepare("DELETE FROM nodes WHERE id = ? AND canvas_id = ?").run(id, String(canvasId));
      // 卡片没了，挂在它上面的连线也要跟着没，否则会留下指向空卡片的线
      database
        .prepare("DELETE FROM edges WHERE canvas_id = ? AND (source_id = ? OR target_id = ?)")
        .run(String(canvasId), id, id);
    });
    edgeUpserts.forEach((edge) => {
      if (!edge || !edge.id) return;
      database
        .prepare("DELETE FROM edges WHERE id = ? AND canvas_id = ?")
        .run(String(edge.id), String(canvasId));
      database
        .prepare(
          "INSERT INTO edges (id, canvas_id, source_id, target_id, source_port, target_port, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          String(edge.id),
          String(canvasId),
          String(edge.sourceId || ""),
          String(edge.targetId || ""),
          edge.sourcePort ? String(edge.sourcePort) : null,
          edge.targetPort ? String(edge.targetPort) : null,
          edge.role ? String(edge.role) : null,
          stamp
        );
    });
    edgeDeletes.forEach((id) => {
      database
        .prepare("DELETE FROM edges WHERE id = ? AND canvas_id = ?")
        .run(String(id || ""), String(canvasId));
    });
    if (body.viewport && Number.isFinite(Number(body.viewport.zoom))) {
      database
        .prepare("UPDATE canvases SET viewport = ? WHERE id = ?")
        .run(JSON.stringify(body.viewport), String(canvasId));
    }
    database
      .prepare("UPDATE canvases SET updated_at = ?, rev = rev + 1 WHERE id = ?")
      .run(stamp, String(canvasId));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const nextRev = Number(
    (database.prepare("SELECT rev FROM canvases WHERE id = ?").get(String(canvasId)) || {}).rev || 0
  );
  return {
    rev: nextRev,
    savedAt: stamp,
    applied: {
      upserted: writes.length,
      deleted: removed.length,
      // 回传具体是哪几张：前端收到别人的改动后要按 id 决定「哪张能覆盖、哪张我正在改」
      upsertedIds: writes.map((node) => String(node.id)),
      deletedIds: removed.slice(),
      edges: edgeUpserts.length + edgeDeletes.length,
      // 原样回传：共享广播要把「改成了什么样」一并发出去，
      // 否则对方收到一个 id 还得再拉一次才知道内容
      upsertedNodes: writes.slice(),
      doneEdges: edgeUpserts.slice(),
      removedEdges: edgeDeletes.slice(),
    },
    conflicts: conflicts,
  };
}

// 把迁移统计说成一句话，给日志用。数不清就不用硬凑。
//
// 两种形状都能收：saveState 给的是 {type, field, stamp}（按改动种类计数），
// scanCanvasMigration 给的是 {count, nodes}（按卡片列举）。日志只需要一句话，
// 犯不上为它统一成一种结构。
function summarizeMigration(input) {
  const info = input && typeof input === 'object' ? input : {};
  if (info.changes) return summarizeMigration(info.changes);
  if (Array.isArray(info.nodes)) {
    const total = Number(info.count) || info.nodes.length;
    const typeSwaps = info.nodes.filter((one) => one.target).length;
    // 「版本号已是最新、只是还挂着会被清理的提交快照」那些要单独说，
    // 否则日志会误报成「补齐了版本号」（它本来就有号）。
    const subClean = info.nodes.filter((one) => one.reason === 'submissionPrompt').length;
    const versionBumps = total - typeSwaps - subClean;
    const parts = [];
    if (typeSwaps) parts.push(typeSwaps + ' 张老类型卡片归一到现在的类型');
    if (versionBumps > 0) parts.push(versionBumps + ' 张卡片补齐了版本号');
    if (subClean > 0) parts.push(subClean + ' 张卡片清理了重复的提交提示词');
    return parts.length ? parts.join('，') : total + ' 张卡片需要升级';
  }
  const parts = [];
  if (info.type) parts.push(info.type + ' 张老类型卡片归一到现在的类型');
  if (info.field) parts.push(info.field + ' 张卡片的字段整理过（老提示词字段搬进正文）');
  if (info.stamp && !parts.length) parts.push(info.stamp + ' 张卡片补上了版本号');
  return parts.length ? parts.join('，') : '节点数据补齐了版本号';
}

// 导出单块画布：一个 JSON 文件，换电脑也能单独搬
function exportCanvas(id) {
  const state = getState(id);
  if (!state) return null;
  return {
    format: 'local-canvas',
    version: 1,
    exportedAt: now(),
    canvas: { name: state.canvas.name },
    viewport: state.viewport,
    nodes: state.nodes,
    edges: state.edges,
  };
}

// 备份文件里的视口可能是坏的（手改过、别的版本导出的），先洗干净再用
function cleanViewport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const zoom = Number(raw.zoom);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: x,
    y: y,
    zoom: Number.isFinite(zoom) && zoom > 0.02 && zoom < 40 ? zoom : 1,
  };
}

// 卡片数据里除了连线，还有几处「指向别的卡片编号」的字段：
// 组合的 members、快速视频的 quickRefs、首尾帧的 frameOrder。
// 导入时卡片编号会全部换新，这些字段也必须跟着换，否则组合会散、@ 引用会断。
function remapDataRefs(data, idMap) {
  if (!data || typeof data !== 'object') return;
  // 指向已经不存在的卡片（备份本身就有残缺）就顺手摘掉，别留一条断掉的引用
  if (Array.isArray(data.members)) {
    data.members = data.members.map((id) => idMap.get(String(id))).filter(Boolean);
  }
  // 定时生成组：成员顺序、逐张时间、请求快照都指向卡片编号
  if (Array.isArray(data.order)) {
    data.order = data.order.map((id) => idMap.get(String(id))).filter(Boolean);
  }
  if (data.perCard && typeof data.perCard === 'object' && !Array.isArray(data.perCard)) {
    const next = {};
    Object.keys(data.perCard).forEach((id) => {
      const mapped = idMap.get(String(id));
      if (mapped) next[mapped] = data.perCard[id];
    });
    data.perCard = next;
  }
  if (data.snapshots && typeof data.snapshots === 'object' && !Array.isArray(data.snapshots)) {
    const next = {};
    Object.keys(data.snapshots).forEach((id) => {
      const mapped = idMap.get(String(id));
      if (mapped) next[mapped] = data.snapshots[id];
    });
    data.snapshots = next;
  }
  // 定时组的 perCard / snapshots 存在 data.schedule 里，同样要换号
  if (data.schedule && typeof data.schedule === 'object' && !Array.isArray(data.schedule)) {
    const sched = data.schedule;
    if (sched.perCard && typeof sched.perCard === 'object' && !Array.isArray(sched.perCard)) {
      const next = {};
      Object.keys(sched.perCard).forEach((id) => {
        const mapped = idMap.get(String(id));
        if (mapped) next[mapped] = sched.perCard[id];
      });
      sched.perCard = next;
    }
    if (sched.snapshots && typeof sched.snapshots === 'object' && !Array.isArray(sched.snapshots)) {
      const next = {};
      Object.keys(sched.snapshots).forEach((id) => {
        const mapped = idMap.get(String(id));
        if (mapped) next[mapped] = sched.snapshots[id];
      });
      sched.snapshots = next;
    }
  }
  if (Array.isArray(data.frameOrder)) {
    const next = data.frameOrder.map((id) => idMap.get(String(id))).filter(Boolean);
    if (next.length) data.frameOrder = next;
    else delete data.frameOrder;
  }
  if (data.quickRefs && typeof data.quickRefs === 'object' && !Array.isArray(data.quickRefs)) {
    const next = {};
    Object.keys(data.quickRefs).forEach((tag) => {
      const mapped = idMap.get(String(data.quickRefs[tag]));
      if (mapped) next[tag] = mapped;
    });
    if (Object.keys(next).length) data.quickRefs = next;
    else delete data.quickRefs;
  }
}

// 导入画布：节点编号全部换新，避免和本机已有的撞号
function importCanvas(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const rawName = String((data.canvas && data.canvas.name) || data.name || '导入的画布').trim() || '导入的画布';
  const sourceNodes = Array.isArray(data.nodes) ? data.nodes : [];
  const idMap = new Map();
  const nodes = sourceNodes.map((node) => {
    const fresh = Object.assign({}, node, { id: newId('n'), data: JSON.parse(JSON.stringify(node.data || {})) });
    idMap.set(String(node.id || ''), fresh.id);
    return fresh;
  });
  nodes.forEach((node) => remapDataRefs(node.data, idMap));
  const created = createCanvas(rawName + '（导入）');
  const sourceEdges = Array.isArray(data.edges) ? data.edges : [];
  // 两头都对不上现有卡片的连线直接丢掉，免得画布上留下一条断线
  const edges = sourceEdges
    .map((edge) => ({
      id: newId('e'),
      sourceId: idMap.get(String(edge.sourceId || '')) || '',
      targetId: idMap.get(String(edge.targetId || '')) || '',
      role: edge.role ? String(edge.role) : '',
      sourcePort: edge.sourcePort ? String(edge.sourcePort) : null,
      targetPort: edge.targetPort ? String(edge.targetPort) : null,
    }))
    .filter((edge) => edge.sourceId && edge.targetId);
  const viewport = cleanViewport(data.viewport);
  saveState(created.canvas.id, { nodes: nodes, edges: edges, viewport: viewport });
  return { canvas: getCanvas(created.canvas.id), nodeCount: nodes.length, edgeCount: edges.length };
}

// 这块画布上还有多少节点是老版本的 —— 给「迁移前先留档」用。
//
// 关键：看的是**库里现在存的**，不是调用方即将写进去的。
// 一开始我按传入的 payload 判断，结果发现判断不出来 —— 前端在打开画布时就已经
// 在内存里把老数据升级好了，等它来保存时，payload 里全是新版数据，
// 而库里还是旧版。真正需要留档的正是「即将被覆盖掉的这一版」，所以必须以库为准。
//
// 只读，不改库。
// 扫一遍「这次保存会不会动用户数据」，供保存路径决定要不要先留档。
//
// **两条判据缺一不可**（这里踩过一个坑）：
//   ① 版本号落伍（ver < CURRENT_VER）—— 会被逐级迁移改到；
//   ② 身上还挂着「会被清理的提交快照」（wouldCleanSubmissionPrompts）——
//      这一步的清理是**无条件**的，不受版本号管辖。
//
// 一开始这里只有判据①。于是有一个缺口：一个 v 已经是 2、但某个快照还带着
// 可重算 submittedPrompt 的节点（**混合节点**就会出现这种状态：能重算的版本被
// 清掉了、算不出的那一版被保留，于是整张卡盖上 v=2 却还剩着字段），
// saveState 里照样会清掉它，而这里认为「不用升级」→ **不留档就改数据**。
// 实测这个状态确实可达，只是当时保存是幂等的、恰好没造成损失。
// 但那是**靠巧合同步**，不是靠设计保证 —— 所以判据②必须补上。
//
// 判据②复用 migrate 的 wouldClean* 系列，与真正执行清理的 packSubmissionMeta
// 共用同一套判定，两处不会各说各话。
function scanCanvasMigration(canvasId) {
  const rows = handle()
    .prepare('SELECT id, type, data FROM nodes WHERE canvas_id = ?')
    .all(String(canvasId || ''));
  const stale = [];
  rows.forEach((row) => {
    let data = {};
    try {
      data = row.data ? JSON.parse(row.data) : {};
    } catch {
      data = {};
    }
    const ver = migrate.versionOf({ id: row.id, type: row.type, data: data });
    // 判据①：版本号落伍
    if (ver < migrate.CURRENT_VER) {
      stale.push({
        id: String(row.id),
        type: String(row.type),
        ver: ver,
        // 老类型有明确新家的记下来，日志里能说清「几张什么卡被换成了什么」
        target: migrate.LEGACY_TYPES[String(row.type)] || '',
      });
      return;
    }
    // 判据②：版本号已是最新，但还挂着会被清理的提交快照
    if (migrate.wouldCleanSubmissionPrompts(data)) {
      stale.push({
        id: String(row.id),
        type: String(row.type),
        ver: ver,
        target: '',
        reason: 'submissionPrompt',
      });
    }
  });
  const found = { count: stale.length, nodes: stale };
  found.summary = summarizeMigration(found);
  return found;
}

// 读一张卡片的 data：写版本历史前要先拿到旧结果，不能只靠浅合并。
function getNodeData(canvasId, nodeId) {
  const row = handle()
    .prepare('SELECT data FROM nodes WHERE id = ? AND canvas_id = ?')
    .get(String(nodeId || ''), String(canvasId || ''));
  if (!row) return null;
  try {
    const data = row.data ? JSON.parse(row.data) : {};
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// 只改一张卡片的 data：定时组在后台回填进度 / 结果时用，
// 不走 saveState()，免得把整块画布重写一遍、和前端正在编辑的内容打架。
function patchNodeData(canvasId, nodeId, patch) {
  if (!patch || typeof patch !== 'object') return null;
  const row = handle()
    .prepare('SELECT data FROM nodes WHERE id = ? AND canvas_id = ?')
    .get(String(nodeId || ''), String(canvasId || ''));
  if (!row) return null;
  let data = {};
  try {
    data = row.data ? JSON.parse(row.data) : {};
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  Object.assign(data, patch);
  // 这条路径绕过了 saveState 的迁移漏斗，但它写进去的 lastSubmission / history
  // 正是带 submittedPrompt 的那种快照（见 scheduler.js 的 applyResultToCard）。
  // 不在这里过一道，定时组生成出来的结果就会重新把那一大段重复写回库里，
  // 「省 37%」只在手写保存时成立、自动生成时又漏回去。
  migrate.migrateNodeData({ id: String(nodeId || ''), type: '', data: data });
  const stamp = now();
  handle()
    .prepare('UPDATE nodes SET data = ?, updated_at = ? WHERE id = ? AND canvas_id = ?')
    .run(JSON.stringify(data), stamp, String(nodeId || ''), String(canvasId || ''));
  return data;
}

// ---------- 定时生成组的运行记录 ----------
// 配置存在 nodes.data 里（跟着画布一起导出），运行状态单独一张表：
// 前端保存画布时会整块重写 nodes，如果把运行状态也塞在卡片里，会被覆盖掉。
function rowToScheduleRun(row) {
  if (!row) return null;
  return {
    nodeId: row.node_id,
    canvasId: row.canvas_id,
    state: row.state,
    items: row.items_json ? JSON.parse(row.items_json) : [],
    backups: row.backups_json ? JSON.parse(row.backups_json) : [],
    startedAt: Number(row.started_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

function getScheduleRun(nodeId) {
  const row = handle().prepare('SELECT * FROM schedule_runs WHERE node_id = ?').get(String(nodeId || ''));
  return rowToScheduleRun(row);
}

function listScheduleRuns(canvasId) {
  const rows = canvasId
    ? handle().prepare('SELECT * FROM schedule_runs WHERE canvas_id = ?').all(String(canvasId))
    : handle().prepare('SELECT * FROM schedule_runs').all();
  return rows.map(rowToScheduleRun);
}

function upsertScheduleRun(run) {
  const stamp = now();
  handle()
    .prepare(
      `INSERT INTO schedule_runs (node_id, canvas_id, state, items_json, backups_json, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         canvas_id = excluded.canvas_id,
         state = excluded.state,
         items_json = excluded.items_json,
         backups_json = excluded.backups_json,
         started_at = excluded.started_at,
         updated_at = excluded.updated_at`
    )
    .run(
      String(run.nodeId),
      String(run.canvasId || ''),
      String(run.state || 'idle'),
      JSON.stringify(Array.isArray(run.items) ? run.items : []),
      JSON.stringify(Array.isArray(run.backups) ? run.backups : []),
      Number(run.startedAt) || stamp,
      stamp
    );
  return getScheduleRun(run.nodeId);
}

function deleteScheduleRun(nodeId) {
  handle().prepare('DELETE FROM schedule_runs WHERE node_id = ?').run(String(nodeId || ''));
}

function deleteScheduleRunsOfCanvas(canvasId) {
  handle().prepare('DELETE FROM schedule_runs WHERE canvas_id = ?').run(String(canvasId || ''));
}

// 启动时把还在跑 / 暂停中的定时组捞出来，交给调度器接着算
function listLiveScheduleRuns() {
  const rows = handle()
    .prepare("SELECT * FROM schedule_runs WHERE state IN ('running', 'paused') ORDER BY started_at ASC")
    .all();
  return rows.map(rowToScheduleRun);
}

function stats() {
  const database = handle();
  return {
    canvases: Number(database.prepare('SELECT COUNT(1) AS c FROM canvases WHERE deleted_at IS NULL').get().c || 0),
    nodes: Number(
      database
        .prepare('SELECT COUNT(1) AS c FROM nodes n JOIN canvases c ON c.id = n.canvas_id WHERE c.deleted_at IS NULL')
        .get().c || 0
    ),
    tasks: Number(database.prepare('SELECT COUNT(1) AS c FROM tasks').get().c || 0),
  };
}

function rowToTask(row) {
  return {
    id: row.id,
    canvasId: row.canvas_id || '',
    nodeId: row.node_id || '',
    channel: row.channel || '',
    kind: row.kind || '',
    model: row.model || '',
    params: row.params ? JSON.parse(row.params) : {},
    prompt: row.prompt || '',
    remoteId: row.remote_id || '',
    status: row.status,
    stage: row.stage || '',
    waitedMs: row.waited_ms || 0,
    resultPath: row.result_path || '',
    result: row.result_json ? JSON.parse(row.result_json) : null,
    resume: row.resume_json ? JSON.parse(row.resume_json) : null,
    error: row.error || '',
    // 结构化失败信息：{ kind, title, advice, detail, retryable }。
    // 老记录 / 老前端没有这一项时为 null，前端据此回退到只显示 error 那句话。
    errorInfo: row.error_json ? JSON.parse(row.error_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertTask(task) {
  handle()
    .prepare(
      `INSERT INTO tasks (id, canvas_id, node_id, channel, kind, model, params, prompt, remote_id,
        status, stage, waited_ms, result_path, result_json, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(task.id),
      String(task.canvasId || ''),
      String(task.nodeId || ''),
      String(task.channel || ''),
      String(task.kind || ''),
      String(task.model || ''),
      JSON.stringify(migrate.packTaskParams(task.params || {})),
      String(task.prompt || ''),
      String(task.remoteId || ''),
      String(task.status || 'queued'),
      String(task.stage || ''),
      Number(task.waitedMs) || 0,
      String(task.resultPath || ''),
      task.result ? JSON.stringify(task.result) : null,
      String(task.error || ''),
      Number(task.createdAt) || now(),
      Number(task.updatedAt) || now()
    );
  return getTask(task.id);
}

const TASK_FIELDS = {
  status: 'status',
  stage: 'stage',
  waitedMs: 'waited_ms',
  remoteId: 'remote_id',
  resultPath: 'result_path',
  error: 'error',
};

function updateTask(id, patch) {
  const sets = [];
  const values = [];
  Object.keys(patch || {}).forEach((key) => {
    if (key === 'result') {
      sets.push('result_json = ?');
      values.push(patch.result ? JSON.stringify(patch.result) : null);
      return;
    }
    if (key === 'resume') {
      sets.push('resume_json = ?');
      values.push(patch.resume ? JSON.stringify(patch.resume) : null);
      return;
    }
    if (key === 'errorInfo') {
      sets.push('error_json = ?');
      values.push(patch.errorInfo ? JSON.stringify(patch.errorInfo) : null);
      return;
    }
    const column = TASK_FIELDS[key];
    if (!column) return;
    sets.push(column + ' = ?');
    const value = patch[key];
    values.push(typeof value === 'number' ? value : String(value === undefined || value === null ? '' : value));
  });
  if (!sets.length) return getTask(id);
  sets.push('updated_at = ?');
  values.push(now());
  values.push(id);
  handle()
    .prepare('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?')
    .run(...values);
  return getTask(id);
}

function getTask(id) {
  const row = handle().prepare('SELECT * FROM tasks WHERE id = ?').get(String(id || ''));
  return row ? rowToTask(row) : null;
}

function listTasks(limit, options) {
  const opts = options || {};
  const canvasId = String(opts.canvasId || '').trim();
  const activeOnly = Boolean(opts.activeOnly);
  const wheres = [];
  const values = [];
  if (canvasId) {
    wheres.push('canvas_id = ?');
    values.push(canvasId);
  }
  if (activeOnly) wheres.push(`status IN ('queued', 'running')`);
  const where = wheres.length ? ' WHERE ' + wheres.join(' AND ') : '';
  values.push(Number(limit) || 50);
  const rows = handle()
    .prepare('SELECT * FROM tasks' + where + ' ORDER BY created_at DESC LIMIT ?')
    .all(...values);
  return rows.map((row) => rowToTask(row));
}

// 服务重启后，上次没跑完的任务不会再继续，如实标出来
function interruptStaleTasks() {
  const stamp = now();
  const result = handle()
    .prepare(
      `UPDATE tasks SET status = 'failed', stage = '中断', error = ?, updated_at = ?
       WHERE status IN ('queued', 'running') AND (resume_json IS NULL OR resume_json = '')`
    )
    .run('服务重启时中断，请重新点一次生成', stamp);
  return Number(result.changes || 0);
}

// 有接续信息的任务：服务重启后可以接着等结果，不当成中断
function listResumableTasks() {
  const rows = handle()
    .prepare(
      `SELECT * FROM tasks
       WHERE status IN ('queued', 'running') AND resume_json IS NOT NULL AND resume_json != ''
       ORDER BY created_at ASC`
    )
    .all();
  return rows.map((row) => rowToTask(row));
}

// 退出前把 WAL 里的页并回主库再截断。
// 不做这一步时，-wal 会随每日写入一直长（见过 4MB 以上），下次启动还要花时间回放；
// 而且用户备份 data/ 时若只拷 canvas.db，会丢掉还没 checkpoint 的最新改动。
function close() {
  if (!db) return;
  const opened = db;
  db = null;
  try {
    opened.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    console.log('[数据库] 关闭前 checkpoint 跳过：' + error.message);
  }
  try {
    opened.close();
  } catch (error) {
    console.log('[数据库] 关闭时出错：' + error.message);
  }
}

module.exports = {
  init,
  close,
  getHealthNotice,
  clearHealthNotice,
  newId,
  listCanvases,
  getCanvas,
  createCanvas,
  renameCanvas,
  duplicateCanvas,
  deleteCanvas,
  getState,
  saveState,
  applyPatch,
  isShared,
  hasShared,
  scanCanvasMigration,
  patchNodeData,
  enableShare,
  disableShare,
  listSharedCanvases,
  clearShareOf,
  getNodeData,
  exportCanvas,
  importCanvas,
  stats,
  insertTask,
  updateTask,
  getTask,
  listTasks,
  listResumableTasks,
  interruptStaleTasks,
  pruneTaskSubmissionPrompts,
  getScheduleRun,
  listScheduleRuns,
  upsertScheduleRun,
  deleteScheduleRun,
  deleteScheduleRunsOfCanvas,
  listLiveScheduleRuns,
};

