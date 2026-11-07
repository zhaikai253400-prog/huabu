'use strict';

// 共享工作区（同一局域网协同编辑，最多 3 人）的服务端测试。
//
// 这块功能的风险点全在「几个人同时写同一块画布」上，所以这里不测 UI，
// 只钉住数据层与准入规则：
//
//   1. 开关共享是幂等的，且 isShared / hasShared / listSharedCanvases 说法一致；
//   2. 不同卡片并发保存 → 两边都得写进去（这是共享的基本承诺）；
//   3. 同一张卡片、基线对不上 → 只这张卡冲突，其余照写；
//   4. 新建（base 为 null）与「对方已删」（base 有值但库里没了）分得清；
//   5. 删卡片会连带删掉挂在它上面的连线，不留断线；
//   6. 第 4 个会话被 429 拒掉，同 clientId 重连不占第二个名额；
//   7. 局域网：没开共享时素材库仍 403，开了才 200。
//
// 运行：runtime/node.exe tools/tests/share.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');
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
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    failed += 1;
    console.log('  ✗ ' + name + ' —— ' + error.message);
  }
}
function eq(got, want, msg) {
  assert.strictEqual(got, want, (msg ? msg + '：' : '') + '期望 ' + want + '，实际 ' + got);
}

function makeSandbox(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-share-' + tag + '-'));
  require(path.join(__dirname, '_isolate.js'))(dir);
  delete require.cache[require.resolve(STORE_PATH)];
  delete require.cache[require.resolve(path.join(SERVER, 'migrate.js'))];
  return require(STORE_PATH);
}

function card(id, extra) {
  return Object.assign(
    { id: id, type: 'image', x: 0, y: 0, w: 260, h: 200, z: 0, data: { text: '', v: 3 } },
    extra || {}
  );
}

function seed(store, id, cards, edgeList) {
  store.saveState(
    id,
    { nodes: cards, edges: edgeList || [], viewport: { x: 0, y: 0, zoom: 1 } },
    0
  );
}

console.log('\n[1] 共享开关与查询');

{
  const store = makeSandbox('toggle');
  const id = store.createCanvas('共享测试').canvas.id;
  check('新画布默认不共享', () => eq(store.isShared(id), false));
  check('没有任何共享时 hasShared 为 false', () => eq(store.hasShared(), false));
  check('开共享返回 shared:true', () => eq(store.enableShare(id).shared, true));
  check('开共享后 isShared 为 true', () => eq(store.isShared(id), true));
  check('开共享后 hasShared 为 true', () => eq(store.hasShared(), true));
  check('重复开共享是幂等的', () => eq(store.enableShare(id).shared, true));
  check('共享清单里有这块画布', () => {
    const list = store.listSharedCanvases();
    eq(list.length, 1);
    eq(list[0].id, id);
  });
  check('关共享后 isShared 立刻变 false', () => eq(store.disableShare(id).shared, false));
  check('关掉之后 hasShared 也回到 false', () => eq(store.hasShared(), false));
  check('关共享是幂等的', () => eq(store.disableShare(id).shared, false));
  check('共享清单里已经没有了', () => eq(store.listSharedCanvases().length, 0));
}

console.log('\n[2] 不同卡片并发保存：两边都要写进去');

{
  const store = makeSandbox('parallel');
  const id = store.createCanvas('并发').canvas.id;
  seed(store, id, [card('n_a', { x: 0 }), card('n_b', { x: 300 })]);

  const baseA = (function () {
    const state = store.getState(id);
    return state.nodes.find((one) => one.id === 'n_a');
  })();
  const baseB = (function () {
    const state = store.getState(id);
    return state.nodes.find((one) => one.id === 'n_b');
  })();

  // 第一个人只改 A，第二个人只改 B —— 两边都以「自己读到的样子」为基线
  const r1 = store.applyPatch(id, {
    upserts: [{ node: Object.assign({}, baseA, { x: 111 }), base: baseA }],
  });
  const r2 = store.applyPatch(id, {
    upserts: [{ node: Object.assign({}, baseB, { x: 444 }), base: baseB }],
  });

  check('第一个人写成功', () => eq(r1.applied.upserted, 1));
  check('第二个人写成功', () => eq(r2.applied.upserted, 1));
  check('两个人各自的结果都留在库里', () => {
    const state = store.getState(id);
    eq(state.nodes.find((one) => one.id === 'n_a').x, 111);
    eq(state.nodes.find((one) => one.id === 'n_b').x, 444);
  });
  check('没有任何冲突', () => {
    eq(r1.conflicts.length, 0);
    eq(r2.conflicts.length, 0);
  });
}

console.log('\n[3] 同一张卡片：基线对不上只这张冲突，其余照写');

{
  const store = makeSandbox('conflict');
  const id = store.createCanvas('冲突').canvas.id;
  seed(store, id, [card('n_a', { x: 0 }), card('n_b', { x: 300 })]);

  const baseA = store.getState(id).nodes.find((one) => one.id === 'n_a');
  const baseB = store.getState(id).nodes.find((one) => one.id === 'n_b');

  // 甲先改 A
  store.applyPatch(id, { upserts: [{ node: Object.assign({}, baseA, { x: 10 }), base: baseA }] });

  // 乙手里还是「A 在 0」的老基线，同时改 A 和 B
  const out = store.applyPatch(id, {
    upserts: [
      { node: Object.assign({}, baseA, { x: 99 }), base: baseA },
      { node: Object.assign({}, baseB, { x: 900 }), base: baseB },
    ],
  });

  check('只有 A 冲突', () => {
    eq(out.conflicts.length, 1);
    eq(out.conflicts[0].nodeId, 'n_a');
    eq(out.conflicts[0].reason, 'changed');
  });
  check('冲突那张保留甲的版本', () => eq(store.getState(id).nodes.find((one) => one.id === 'n_a').x, 10));
  check('没冲突的 B 照常写入', () => eq(store.getState(id).nodes.find((one) => one.id === 'n_b').x, 900));
  check('冲突里带服务端当前内容，前端才能「用对方的」', () => {
    const server = out.conflicts[0].server;
    assert(server, '冲突里没带 server');
    eq(server.x, 10);
  });
}

console.log('\n[4] 新建 / 对方已删');

{
  const store = makeSandbox('create');
  const id = store.createCanvas('新建').canvas.id;
  seed(store, id, [card('n_a')]);

  const created = store.applyPatch(id, {
    upserts: [{ node: card('n_new', { x: 120 }), base: null }],
  });
  check('base 为 null 是新建', () => {
    eq(created.conflicts.length, 0);
    eq(created.applied.upserted, 1);
  });
  check('新建的卡片真的进库了', () => assert(store.getState(id).nodes.some((one) => one.id === 'n_new')));

  // 甲删掉 n_a
  store.applyPatch(id, { deletes: ['n_a'] });
  // 乙还在用老基线改 n_a
  const out = store.applyPatch(id, {
    upserts: [{ node: card('n_a', { x: 777 }), base: card('n_a') }],
  });
  check('对方已删 → reason 是 deleted', () => {
    eq(out.conflicts.length, 1);
    eq(out.conflicts[0].reason, 'deleted');
    eq(out.conflicts[0].server, null);
  });
  check('已删的卡片不会被偷偷重建', () => {
    eq(store.getState(id).nodes.some((one) => one.id === 'n_a'), false);
  });
}

console.log('\n[5] 删卡片连带删连线');

{
  const store = makeSandbox('edges');
  const id = store.createCanvas('连线').canvas.id;
  seed(
    store,
    id,
    [card('n_a', { x: 0 }), card('n_b', { x: 300 })],
    [{ id: 'e_1', sourceId: 'n_a', targetId: 'n_b', role: '' }]
  );
  const out = store.applyPatch(id, { deletes: ['n_a'] });
  check('返回的 deletedIds 里有它', () => eq(out.applied.deletedIds.join(','), 'n_a'));
  check('卡片没了', () => eq(store.getState(id).nodes.length, 1));
  check('挂在它上面的连线一起没了', () => eq(store.getState(id).edges.length, 0));
}

console.log('\n[6] 会话上限 3 人，同 clientId 重连不额外占位');

{
  const share = require(path.join(SERVER, 'share.js'));
  share._reset();
  function fakeRes() {
    const chunks = [];
    return {
      chunks: chunks,
      writeHead() {},
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
      end() {},
      on() {},
    };
  }
  function fakeReq() {
    return { on() {} };
  }
  function joinOne(clientId) {
    return share.join('c_test', fakeReq(), fakeRes(), { local: false, clientId: clientId });
  }

  const a = joinOne('k1');
  const b = joinOne('k2');
  const c = joinOne('k3');
  check('前三个进得来', () => {
    eq(a.ok, true);
    eq(b.ok, true);
    eq(c.ok, true);
  });
  check('在线人数是 3', () => eq(share.countOnline('c_test'), 3));

  const d = joinOne('k4');
  check('第四个被拒，状态码 429', () => {
    eq(d.ok, false);
    eq(d.code, 429);
    assert(d.error && d.error.indexOf('3') >= 0, '错误提示里该说清上限');
  });

  // 同一个页面刷新（同 clientId）应该顶掉旧连接，而不是被自己的旧连接挤出去
  const again = joinOne('k1');
  check('同 clientId 重连还能进来', () => eq(again.ok, true));
  check('人数没变多', () => eq(share.countOnline('c_test'), 3));
  check('名单里不会出现两个自己', () => {
    const mine = share.listSessions('c_test').filter((one) => one.name === again.session.name);
    eq(mine.length, 1);
  });

  // 换一个 clientId 才会真的多一个人
  share._reset();
}

console.log('\n[7] 主机 / 访客的称呼');

{
  const share = require(path.join(SERVER, 'share.js'));
  share._reset();
  function fakeRes() {
    return { writeHead() {}, write() { return true; }, end() {}, on() {} };
  }
  function fakeReq() {
    return { on() {} };
  }
  const host = share.join('c_name', fakeReq(), fakeRes(), { local: true, clientId: 'h' });
  const guest = share.join('c_name', fakeReq(), fakeRes(), { local: false, clientId: 'g' });
  check('本机叫「主机」', () => eq(host.session.name, '主机'));
  check('别人叫「访客 1」', () => eq(guest.session.name, '访客 1'));
  check('hello 里带 local 标记，前端据此决定能不能关共享', () => eq(host.session.local, true));
  share._reset();
}

console.log('\n[8] 局域网准入：没开共享一律 403，开了才放行');

// 起一个真实服务（隔离目录 + 随机端口），Host 伪装成本机网卡地址来模拟局域网访问
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      resolve();
    }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

async function request(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port,
        path: options.path,
        method: options.method || 'GET',
        headers: Object.assign({ Host: options.host }, options.headers || {}),
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: body }));
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const LAN_IP = (function () {
  const guard = require(path.join(SERVER, 'guard.js'));
  const list = guard.lanAddresses();
  return list.length ? list[0] : '';
})();

(async function main() {
  if (!LAN_IP) {
    console.log('\n[8] 跳过：这台机器没有可用的局域网网卡地址');
  } else {
    // 真服务：独立数据目录 + 独立素材目录 + 随机空闲端口。
    // 端口来自 config.json（服务不认环境变量里的端口），并且要 --no-browser，
    // 否则测试会把用户的浏览器拉起来。
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-share-e2e-'));
    const dataDir = path.join(box, 'data');
    const assetDir = path.join(box, '素材');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(assetDir, { recursive: true });
    const port = await pickFreePort();
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ port: port, assetRoot: assetDir, lan: { enabled: true } }, null, 2),
      'utf8'
    );
    const child = spawn(process.execPath, [path.join(SERVER, 'index.js'), '--no-browser'], {
      cwd: box,
      env: Object.assign({}, process.env, {
        http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '',
        CANVAS_DATA_DIR: dataDir,
      }),
      stdio: 'ignore',
    });

    const up = await (async function wait() {
      for (let i = 0; i < 80; i += 1) {
        const ok = await new Promise((resolve) => {
          const probe = http.request(
            { host: '127.0.0.1', port: port, path: '/api/health', method: 'GET' },
            (res) => { res.resume(); resolve(res.statusCode === 200); }
          );
          probe.on('error', () => resolve(false));
          probe.end();
        });
        if (ok) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    })();

    try {
      if (!up) throw new Error('测试服务没起来（端口 ' + port + '）');

      // 本机侧用管理钥匙：建画布、开共享都是 ui/admin 级接口
      const adminToken = fs.readFileSync(path.join(dataDir, 'admin-token.txt'), 'utf8').trim();
      const LOCAL = {
        host: '127.0.0.1:' + port,
        'x-local-token': adminToken,
        'Content-Type': 'application/json',
      };
      const created = await request(port, {
        path: '/api/canvases',
        method: 'POST',
        host: LOCAL.host,
        headers: LOCAL,
        body: JSON.stringify({ name: '局域网共享测试' }),
      });
      eq(created.status, 200, '本机建画布');
      const canvasId = JSON.parse(created.body).canvas.id;

      const lanHost = LAN_IP + ':' + port;
      const before = await request(port, { path: '/api/library', host: lanHost });
      check('没开共享时，局域网访问素材库仍是 403', () => eq(before.status, 403));

      const beforeCanvas = await request(port, {
        path: '/api/canvases/' + canvasId,
        host: lanHost,
      });
      check('没开共享时，局域网读画布也是 403', () => eq(beforeCanvas.status, 403));

      const on = await request(port, {
        path: '/api/canvases/' + canvasId + '/share',
        method: 'POST',
        host: LOCAL.host,
        headers: LOCAL,
        body: JSON.stringify({ on: true }),
      });
      eq(on.status, 200, '开共享');

      const afterLib = await request(port, { path: '/api/library?limit=5', host: lanHost });
      check('开了共享后，局域网能浏览素材库（只读）', () => eq(afterLib.status, 200));

      // 素材库的「会动」接口一律不给：共享一块画布 ≠ 能让别人删掉主机整个素材库
      const lanDelete = await request(port, {
        path: '/api/library/delete',
        method: 'POST',
        host: lanHost,
        headers: { Host: lanHost, 'Content-Type': 'application/json' },
        body: JSON.stringify({ relPaths: ['图片/随便一个.png'] }),
      });
      check('局域网不能删主机素材（403）', () => eq(lanDelete.status, 403));

      const lanClean = await request(port, {
        path: '/api/library/orphans/clean',
        method: 'POST',
        host: lanHost,
        headers: { Host: lanHost, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      check('局域网不能清主机孤儿素材（403）', () => eq(lanClean.status, 403));

      const lanRestore = await request(port, {
        path: '/api/library/recycle',
        method: 'POST',
        host: lanHost,
        headers: { Host: lanHost, 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: 'x', items: [] }),
      });
      check('局域网不能从主机回收站还原素材（403）', () => eq(lanRestore.status, 403));

      const afterState = await request(port, {
        path: '/api/share/' + canvasId + '/state',
        host: lanHost,
      });
      check('开了共享后，局域网能拉共享画布状态', () => eq(afterState.status, 200));
      check('共享状态里带在线人数与上限', () => {
        const data = JSON.parse(afterState.body);
        eq(data.limit, 3);
        assert(Number.isFinite(data.online), 'online 该是数字');
        eq(data.local, false, '局域网访客的 local 应为 false');
      });

      // 生成类接口：不报画布 → 拒；报一块「没共享」的画布 → 拒；报共享那块 → 放行到业务层。
      // 这几条正是「共享一开就全放行」那个洞的回归护栏。
      const genNoCanvas = await request(port, {
        path: '/api/generate',
        method: 'POST',
        host: lanHost,
        headers: { Host: lanHost, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'image', model: 'm', prompt: 'x' }),
      });
      check('局域网不报画布就调生成 → 403', () => eq(genNoCanvas.status, 403));

      const genOther = await request(port, {
        path: '/api/generate',
        method: 'POST',
        host: lanHost,
        headers: { Host: lanHost, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'image', model: 'm', prompt: 'x', canvasId: 'c_不存在' }),
      });
      check('局域网拿「没共享」的画布调生成 → 403', () => eq(genOther.status, 403));

      // 正面：报的正是共享那块 → 应当过闸进到业务层。
      // 这个测试服务没配任何通道，所以业务层会回 400（还没有能生成的通道）。
      // 关键区别是「403 = 被权限拦下」vs「400 = 权限过了、业务上不成立」。
      const genShared = await request(port, {
        path: '/api/generate',
        method: 'POST',
        host: lanHost,
        headers: { Host: lanHost, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'image', model: 'm', prompt: 'x', canvasId: canvasId }),
      });
      check('局域网对「共享那块画布」能过权限闸（不再 403）', () => {
        assert(genShared.status !== 403, '不该被权限拦下，实际 ' + genShared.status);
      });
      // 顺带确认请求体没被判权限那一步吃掉：业务层必须真的读到了 body
      check('判权限先读体之后，业务层仍能读到完整 body', () => {
        const data = JSON.parse(genShared.body);
        assert(
          String(data.error || '').indexOf('通道') >= 0,
          '业务层没读到 body（画布编号丢了？），拿到的是：' + genShared.body.slice(0, 120)
        );
      });

      const patch = await request(port, {
        path: '/api/share/' + canvasId + '/patch',
        method: 'POST',
        host: lanHost,
        headers: { Host: lanHost, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: 'lan-test',
          upserts: [{ node: card('n_lan', { x: 30, y: 40, data: { text: '来自局域网', v: 3 } }), base: null }],
        }),
      });
      check('局域网协作者能写卡片', () => eq(patch.status, 200));

      // 局域网不能碰「没共享的那块画布」
      const other = await request(port, {
        path: '/api/canvases',
        method: 'POST',
        host: LOCAL.host,
        headers: LOCAL,
        body: JSON.stringify({ name: '另一块没共享的' }),
      });
      const otherId = JSON.parse(other.body).canvas.id;
      const denied = await request(port, {
        path: '/api/canvases/' + otherId,
        host: lanHost,
      });
      check('局域网碰不到没共享的那块画布', () => eq(denied.status, 403));

      // 局域网不能自己开共享（扩权）
      const lift = await request(port, {
        path: '/api/canvases/' + otherId + '/share',
        method: 'POST',
        host: lanHost,
        headers: { Host: lanHost, 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: true }),
      });
      check('局域网不能自己开共享（403）', () => eq(lift.status, 403));

      // 共享关掉后立刻收回
      await request(port, {
        path: '/api/canvases/' + canvasId + '/share',
        method: 'POST',
        host: LOCAL.host,
        headers: LOCAL,
        body: JSON.stringify({ on: false }),
      });
      const closed = await request(port, {
        path: '/api/share/' + canvasId + '/state',
        host: lanHost,
      });
      check('关掉共享后，局域网又进不来了', () => eq(closed.status, 403));

      // ---- SSE 长连接（共享协作的实时通道）----
      //
      // 这一节是补一个真实盲区：项目原先没有任何 SSE 测试，而
      // `requestHandler` 后来为了「按画布授权」改成了 async，并在外面包了一层
      // `Promise.resolve(...).catch(...)`。**长连接最怕处理器提前结束或把流收掉** ——
      // 一旦包装层在 promise resolve 之后顺手 res.end()，协作就变成「连不上」，
      // 而且不报错、只是实时同步不工作。所以这里必须真开一条流盯着。
      const openSse = (canvasIdToWatch, client) => new Promise((resolve, reject) => {
        const r = http.request(
          {
            host: '127.0.0.1', port: port,
            path: '/api/share/' + canvasIdToWatch + '/events?client=' + encodeURIComponent(client),
            method: 'GET',
            headers: Object.assign({ Accept: 'text/event-stream' }, LOCAL),
          },
          (res) => {
            const state = { status: res.statusCode, headers: res.headers, events: [], ended: false, error: null };
            res.setEncoding('utf8');
            let buf = '';
            res.on('data', (chunk) => {
              buf += chunk;
              let idx;
              while ((idx = buf.indexOf('\n\n')) >= 0) {
                const raw = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                let name = 'message';
                const dataLines = [];
                raw.split('\n').forEach((line) => {
                  if (line.indexOf('event:') === 0) name = line.slice(6).trim();
                  else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
                });
                state.events.push({ name: name, data: dataLines.join('\n') });
              }
            });
            res.on('end', () => { state.ended = true; });
            res.on('error', (e) => { state.error = String((e && e.message) || e); });
            state.close = () => { try { r.destroy(); } catch { /* 已断 */ } };
            resolve(state);
          }
        );
        r.on('error', reject);
        r.end();
      });

      const sseCanvas = await request(port, {
        path: '/api/canvases',
        method: 'POST',
        host: LOCAL.host,
        headers: LOCAL,
        body: JSON.stringify({ name: 'SSE 验收' }),
      });
      const sseId = JSON.parse(sseCanvas.body).canvas.id;
      await request(port, {
        path: '/api/canvases/' + sseId + '/share',
        method: 'POST',
        host: LOCAL.host,
        headers: LOCAL,
        body: JSON.stringify({ on: true }),
      });

      const stream = await openSse(sseId, 'sse_1');
      check('SSE 握手 200', () => eq(stream.status, 200));
      check('SSE 的 Content-Type 是 text/event-stream', () => {
        assert(String(stream.headers['content-type'] || '').indexOf('text/event-stream') >= 0,
          '实际 ' + stream.headers['content-type']);
      });
      check('SSE 不带 Content-Length（长连接的必要特征）', () => {
        eq(stream.headers['content-length'], undefined);
      });

      await new Promise((r) => setTimeout(r, 600));
      check('收到 hello（说明流真的在用，不是只建了连接）', () => {
        assert(stream.events.some((e) => e.name === 'hello'),
          '已收事件：' + JSON.stringify(stream.events.map((e) => e.name)));
      });

      // 关键：过一会儿流必须还开着。包装层若把 promise 收尾当成「请求结束」，
      // 这里就会看到 ended=true。
      await new Promise((r) => setTimeout(r, 2000));
      check('**2 秒后流仍然没有被关闭**（async 包装最可能弄坏的地方）', () => {
        eq(stream.ended, false);
        eq(stream.error, null);
      });

      // 广播链路：另一个人改动，要推到这个流上
      await request(port, {
        path: '/api/share/' + sseId + '/patch',
        method: 'POST',
        host: LOCAL.host,
        headers: LOCAL,
        body: JSON.stringify({
          clientId: 'sse_2',
          upserts: [{
            node: card('n_sse_1', { x: 10, y: 20, data: { text: '来自另一个协作者', v: 3 } }),
            base: null,
          }],
        }),
      });
      await new Promise((r) => setTimeout(r, 900));
      check('**别人的改动推到了已连上的流（change 事件）**', () => {
        assert(stream.events.some((e) => e.name === 'change'),
          '已收事件：' + JSON.stringify(stream.events.map((e) => e.name)));
      });

      stream.close();
      await new Promise((r) => setTimeout(r, 700));
      const presence = await request(port, {
        path: '/api/share/' + sseId + '/presence',
        host: LOCAL.host,
        headers: LOCAL,
      });
      check('断开后在线人数落回 0（不留幽灵占位）', () => {
        eq(JSON.parse(presence.body).count, 0);
      });
    } finally {
      await stopChild(child);
    }
  }

  console.log('\n' + '─'.repeat(52));
  if (failed) {
    console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
    process.exit(1);
  }
  console.log('通过 ' + passed + ' 项，失败 0 项');
})();
