'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DB_FILE, RECYCLE_DIR, DATA_DIR, ensureDir } = require('./paths');

let db = null;

function now() {
  return Date.now();
}

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

// 数据库打不开（文件坏了 / 被别的程序占着）时，把坏库挪到回收站，重建一个空库接着用
function quarantineDb() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(RECYCLE_DIR, 'db-broken-' + stamp);
  try {
    ensureDir(dir);
    ['canvas.db', 'canvas.db-wal', 'canvas.db-shm'].forEach((name) => {
      const file = path.join(path.dirname(DB_FILE), name);
      if (fs.existsSync(file)) fs.renameSync(file, path.join(dir, name));
    });
    console.log('[数据库] 旧库已挪到回收站：' + dir);
  } catch (error) {
    console.log('[数据库] 旧库挪不动：' + error.message);
  }
}

function openDb() {
  db = new DatabaseSync(DB_FILE);
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
  // 老库升级：定时组运行记录补一列，存这一轮冻结的备用模型清单
  const runColumns = db.prepare('PRAGMA table_info(schedule_runs)').all().map((row) => row.name);
  if (runColumns.indexOf('backups_json') < 0) db.exec('ALTER TABLE schedule_runs ADD COLUMN backups_json TEXT');
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
  try {
    return openDb();
  } catch (error) {
    console.log('[数据库] 打开失败，重建一个空库：' + error.message);
    try {
      if (db && db.close) db.close();
    } catch {
      /* 忽略 */
    }
    db = null;
    quarantineDb();
    return openDb();
  }
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

function saveState(canvasId, payload) {
  const canvas = getCanvas(canvasId);
  if (!canvas) return null;
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
  database.exec('BEGIN');
  try {
    database.prepare('DELETE FROM nodes WHERE canvas_id = ?').run(canvasId);
    database.prepare('DELETE FROM edges WHERE canvas_id = ?').run(canvasId);
    const insertNode = database.prepare(
      `INSERT INTO nodes (id, canvas_id, type, x, y, w, h, z, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    fixedNodes.forEach((node, index) => {
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
      .prepare('UPDATE canvases SET viewport = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(viewport), stamp, canvasId);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { savedAt: stamp, nodeCount: nodes.length, edgeCount: edges.length };
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
      JSON.stringify(task.params || {}),
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

module.exports = {
  init,
  newId,
  listCanvases,
  getCanvas,
  createCanvas,
  renameCanvas,
  duplicateCanvas,
  deleteCanvas,
  getState,
  saveState,
  patchNodeData,
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
  getScheduleRun,
  listScheduleRuns,
  upsertScheduleRun,
  deleteScheduleRun,
  deleteScheduleRunsOfCanvas,
  listLiveScheduleRuns,
};

