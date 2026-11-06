'use strict';

// 共享工作区：在线会话 + 实时广播。
//
// 设计要点（为什么是这样）：
//   1) 数据只有一份，在主机 data\canvas.db 里。这里不存任何画布内容，只管「谁在线」。
//   2) 推送用 SSE（text/event-stream）：浏览器原生 EventSource，断线自动重连，
//      不用引依赖、不用处理 WebSocket 握手与心跳。写入仍走普通 POST。
//   3) 每个会话有一个人性化的名字（「访客 1」）和一个随机 id，用来在界面上区分
//      「谁改了这张卡」，也用来做「同一台电脑开两个标签页」的区分。
//   4) 人数上限：同一块画布最多 MAX_SESSIONS 个会话。超了就拒绝，不搞排队 ——
//      协同编辑里「进去了却看不到别人的改动」比「进不去」更糟。

const MAX_SESSIONS = 3;
// 会话多久没心跳就当作掉线。EventSource 断了浏览器会自动重连，
// 这里只是兜底：万一是电脑休眠 / 拔网线，连接不会立刻断，得靠超时清理。
const IDLE_MS = 45 * 1000;
// 心跳间隔：比 IDLE_MS 短得多，正常在线的人不会被误清
const PING_MS = 20 * 1000;

// canvasId -> Map(sessionId -> session)
const rooms = new Map();
let seq = 0;
let pingTimer = null;

function roomOf(canvasId) {
  const key = String(canvasId || "");
  if (!rooms.has(key)) rooms.set(key, new Map());
  return rooms.get(key);
}

// 会话的对外样子：只给界面要用的，不把连接对象漏出去
function publicOf(session) {
  return {
    id: session.id,
    name: session.name,
    joinedAt: session.joinedAt,
    lastSeen: session.lastSeen,
    local: session.local === true,
  };
}

function listSessions(canvasId) {
  const room = rooms.get(String(canvasId || ""));
  if (!room) return [];
  return Array.from(room.values())
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(publicOf);
}

// 正在线几个（不含已经超时但还没被清掉的）
function countOnline(canvasId) {
  const room = rooms.get(String(canvasId || ""));
  if (!room) return 0;
  const now = Date.now();
  let n = 0;
  room.forEach((session) => {
    if (now - session.lastSeen <= IDLE_MS) n += 1;
  });
  return n;
}

// 给新会话起个不重名的名字：主机叫「主机」，其余按「访客 1、2…」排
function nextName(room, local) {
  const used = new Set(Array.from(room.values()).map((one) => one.name));
  if (local && !used.has("主机")) return "主机";
  let index = 1;
  while (used.has("访客 " + index)) index += 1;
  return "访客 " + index;
}

function writeEvent(res, event, data) {
  try {
    res.write("event: " + event + "\n");
    res.write("data: " + JSON.stringify(data) + "\n\n");
    return true;
  } catch {
    return false;
  }
}

// 广播给这块画布上的所有人（包括发起这次改动的人自己）。
// 为什么要发给自己：发起方的本地状态在保存成功后本来就已经是最新的，
// 收到自己的回声会做一次「无改动」比对，代价为零；但少了这个分支，
// 前端就得区分「这是我发的」和「这是别人发的」，反而多一处容易出错的地方。
function broadcast(canvasId, event, data) {
  const room = rooms.get(String(canvasId || ""));
  if (!room) return 0;
  let sent = 0;
  room.forEach((session) => {
    if (!session.res) return;
    if (writeEvent(session.res, event, data)) sent += 1;
  });
  return sent;
}

function broadcastPresence(canvasId) {
  broadcast(canvasId, "presence", {
    sessions: listSessions(canvasId),
    count: countOnline(canvasId),
    limit: MAX_SESSIONS,
  });
}

// 建立一个 SSE 连接。返回 { ok, session } 或 { ok:false, code, error }
function join(canvasId, req, res, options) {
  const opt = options || {};
  // 先把超时的清掉，否则「上次没关干净」会把名额一直占着。
  // 注意顺序：prune() 发现房间空了会把这块画布从注册表里删掉，
  // 所以必须在 prune 之后再取 room —— 先取的话拿到的是一张已经脱管的 Map，
  // 后面写进去的会话谁也看不见（人数永远是 0，第 4 个人也能进来）。
  prune(canvasId);
  const room = roomOf(canvasId);
  // 同一个页面刷新 / 断线重连：旧连接可能还挂着（浏览器关连接是异步的）。
  // 这时不能把「自己」算成第二个人 —— 否则刷新两次就进不来了，
  // 名单里也会出现两个一模一样的自己。
  const clientId = String(opt.clientId || "");
  let reused = null;
  if (clientId) {
    room.forEach((session) => {
      if (session.clientId && session.clientId === clientId) reused = session;
    });
  }
  if (reused) {
    if (reused.res) {
      try {
        reused.res.end();
      } catch {
        /* 已经断了 */
      }
    }
    room.delete(reused.id);
  }
  if (room.size >= MAX_SESSIONS) {
    return {
      ok: false,
      code: 429,
      error: "这块共享画布已经有 " + room.size + " 个人在编辑了（上限 " + MAX_SESSIONS + " 人）。请等其中一位先关掉页面。",
    };
  }
  const id = "s" + (++seq).toString(36) + Math.random().toString(16).slice(2, 8);
  const session = {
    id: id,
    // 重连沿用原来的名字：刷新一下就从「主机」变成「访客 1」会让人以为换了个人
    name: (reused && reused.name) || nextName(room, opt.local === true),
    joinedAt: (reused && reused.joinedAt) || Date.now(),
    lastSeen: Date.now(),
    local: reused ? reused.local === true : opt.local === true,
    clientId: clientId,
    res: res,
    req: req,
  };
  room.set(id, session);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    // 关掉反向代理的缓冲（本项目没有代理，但本地有些安全软件会插一脚）
    "X-Accel-Buffering": "no",
  });
  // 先把自己的身份发过去，前端拿到才知道「我是谁」
  writeEvent(res, "hello", {
    session: publicOf(session),
    sessions: listSessions(canvasId),
    count: countOnline(canvasId),
    limit: MAX_SESSIONS,
  });
  broadcastPresence(canvasId);

  const cleanup = () => {
    const one = room.get(id);
    if (!one) return;
    room.delete(id);
    if (!room.size) rooms.delete(String(canvasId || ""));
    broadcastPresence(canvasId);
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
  return { ok: true, session: session };
}

// 清掉超时的会话（连接可能还挂着，但人已经不在了）
function prune(canvasId) {
  const key = String(canvasId || "");
  const room = rooms.get(key);
  if (!room) return 0;
  const now = Date.now();
  const dead = [];
  room.forEach((session, id) => {
    if (now - session.lastSeen > IDLE_MS) dead.push(id);
  });
  dead.forEach((id) => {
    const session = room.get(id);
    room.delete(id);
    if (session && session.res) {
      try {
        session.res.end();
      } catch {
        /* 已经断了 */
      }
    }
  });
  if (!room.size) rooms.delete(key);
  return dead.length;
}

function touch(canvasId, sessionId) {
  const room = rooms.get(String(canvasId || ""));
  if (!room) return false;
  const session = room.get(String(sessionId || ""));
  if (!session) return false;
  session.lastSeen = Date.now();
  return true;
}

function sessionOf(canvasId, sessionId) {
  const room = rooms.get(String(canvasId || ""));
  if (!room) return null;
  const session = room.get(String(sessionId || ""));
  return session ? publicOf(session) : null;
}

// 全局心跳：定期给每个连接写一行注释，防止中间的防火墙 / 安全软件
// 因为「长时间没有数据」把连接掐了。顺便把超时的会话收掉。
function startHeartbeat() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    const now = Date.now();
    Array.from(rooms.keys()).forEach((canvasId) => {
      prune(canvasId);
      const room = rooms.get(canvasId);
      if (!room) return;
      room.forEach((session) => {
        if (!session.res) return;
        try {
          // SSE 注释行：客户端不会派发事件，但连接上确实有数据流过
          session.res.write(": ping " + now + "\n\n");
          // 写成功就说明这条连接还活着：顺手刷新 lastSeen，否则 45 秒后
          // 好人也会被当成掉线的清掉，名额一直被占着
          session.lastSeen = now;
        } catch {
          /* 下一个 close 事件会把它清掉 */
        }
      });
    });
  }, PING_MS);
  if (pingTimer.unref) pingTimer.unref();
}

function stopHeartbeat() {
  if (!pingTimer) return;
  clearInterval(pingTimer);
  pingTimer = null;
}

// 关掉某一块画布的共享：正在这块画布上的远端会话要立刻断开。
// 只把 shared 置 0 是不够的 —— 已经连上的人还能继续推改动，
// 直到他自己关页面为止。共享是「开了才让进」，关了就要当场收回。
function closeCanvas(canvasId, event, data) {
  const key = String(canvasId || "");
  const room = rooms.get(key);
  if (!room) return 0;
  const count = room.size;
  room.forEach((session) => {
    if (!session.res) return;
    try {
      writeEvent(session.res, event || "bye", data || { reason: "这块画布已关闭共享" });
      session.res.end();
    } catch {
      /* 已经断了 */
    }
  });
  rooms.delete(key);
  return count;
}

// 服务要关了：把所有连接体面地断掉，浏览器那边会显示「已断开」，
// 而不是一直转圈等到超时。
function closeAll() {
  Array.from(rooms.keys()).forEach((canvasId) => {
    const room = rooms.get(canvasId);
    if (!room) return;
    room.forEach((session) => {
      if (!session.res) return;
      try {
        writeEvent(session.res, "bye", { reason: "服务已关闭" });
        session.res.end();
      } catch {
        /* 忽略 */
      }
    });
  });
  rooms.clear();
  stopHeartbeat();
}

module.exports = {
  MAX_SESSIONS,
  IDLE_MS,
  join,
  prune,
  touch,
  sessionOf,
  listSessions,
  countOnline,
  broadcast,
  broadcastPresence,
  startHeartbeat,
  stopHeartbeat,
  closeCanvas,
  closeAll,
  // 测试用：把内部状态清空
  _reset() {
    closeAll();
  },
};
