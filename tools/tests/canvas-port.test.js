'use strict';

// F5 · 组合导入导出专项测试（清单 41 第三项）。
//
// 「组合」在这里是两块意思，两块都要守：
//
//   1. **卡片之间的参照关系**：组合的 members、定时组的 order / perCard / snapshots、
//      首尾帧的 frameOrder、快速视频的 quickRefs。它们存的都是「别的卡片的编号」。
//      导入时全部卡片都要换新号（避免和本机已有的撞号），这些字段必须跟着换；
//      漏掉一个，导进来的组合就是散的、@ 引用就是断的。
//   2. **一次搬家要能原样搬回来**：导出 → 导入 → 再导出，节点 / 连线 / 视口
//      要对得上（除了换号）。这是「换电脑也能单独搬」这句承诺的底。
//
// 另外几条边界也得站住：
//   · 残缺备份（指向不存在的卡片）不能留下断掉的引用；
//   · 两头对不上的连线要丢掉，而不是在画布上留一条断线；
//   · 坏视口（手改过 / 别的版本导出的）要洗干净再用；
//   · 导入不覆盖别人的画布，永远建成一块新的。
//
// 这个文件跑真实 store（隔离目录 + 临时库），是服务端集成测。
//
// 运行：runtime/node.exe tools/tests/canvas-port.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-port-'));
require(path.join(__dirname, '_isolate.js'))(box);

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

// 每块画布用干净的一库，互不干扰（与 optimistic-lock 同一套手法）
function makeSandbox(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-port-' + tag + '-'));
  require(path.join(__dirname, '_isolate.js'))(dir);
  delete require.cache[require.resolve(path.join(SERVER, 'store.js'))];
  delete require.cache[require.resolve(path.join(SERVER, 'migrate.js'))];
  return require(path.join(SERVER, 'store.js'));
}

function card(id, type, extra) {
  return Object.assign(
    {
      id: id,
      type: type,
      x: 0,
      y: 0,
      w: 360,
      h: 203,
      z: 0,
      data: { text: id, v: 1 },
      createdAt: 1000,
    },
    extra || {}
  );
}

function edge(id, from, to) {
  return { id: id, sourceId: from, targetId: to, role: '', sourcePort: null, targetPort: null };
}

// 造一份「带全套参照关系」的画布：两张素材 + 一个组合 + 一个定时组 + 一个快速视频 + 一条连线
function richScene() {
  return {
    format: 'local-canvas',
    version: 1,
    canvas: { name: '参照关系大集合' },
    viewport: { x: 12, y: -34, zoom: 0.8 },
    nodes: [
      card('n_img1', 'image', { x: 0, y: 0, data: { text: '图一', no: 1, v: 1 } }),
      card('n_img2', 'image', { x: 400, y: 0, data: { text: '图二', no: 2, v: 1 } }),
      card('n_vid', 'video', { x: 800, y: 0, data: { text: '视频一', no: 1, v: 1, frameOrder: ['n_img1', 'n_img2'] } }),
      card('n_grp', 'group', {
        x: 0,
        y: 300,
        data: { text: '我的组合', v: 1, members: ['n_img1', 'n_img2'] },
      }),
      card('n_quick', 'quick', {
        x: 400,
        y: 300,
        data: { text: '快一 @[图1]', v: 1, quickRefs: { 图1: 'n_img1', 图2: 'n_img2' } },
      }),
      card('n_sched', 'schedule', {
        x: 800,
        y: 300,
        data: {
          text: '定时组',
          v: 1,
          members: ['n_vid'],
          order: ['n_vid'],
          schedule: {
            perCard: { n_vid: { size: '1K' } },
            snapshots: { n_vid: { prompt: '照着 @图1 做一段', promptRaw: '照着 @[图1] 做一段' } },
          },
        },
      }),
    ],
    edges: [edge('e1', 'n_img1', 'n_vid')],
  };
}

function idsOf(state) {
  return state.nodes.map((node) => node.id).sort();
}

console.log('\nF5 · 组合导入导出');

console.log('\n[1] 导出：格式稳定，换电脑能单独搬');

check('导出带 format / version / exportedAt / canvas.name', () => {
  const store = makeSandbox('fmt');
  const created = store.createCanvas('导出格式');
  store.saveState(created.canvas.id, { nodes: [card('n1', 'image')], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
  const out = store.exportCanvas(created.canvas.id);
  assert(out, '导出为空');
  assert.strictEqual(out.format, 'local-canvas');
  assert.strictEqual(out.version, 1);
  assert.ok(out.exportedAt > 0, '缺导出时间');
  assert.strictEqual(out.canvas.name, '导出格式');
});

check('导出带 nodes / edges / viewport，且形状就是导入端认的形状', () => {
  const store = makeSandbox('shape');
  const created = store.createCanvas('形状');
  store.saveState(created.canvas.id, {
    nodes: [card('n1', 'image'), card('n2', 'video')],
    edges: [edge('e1', 'n1', 'n2')],
    viewport: { x: 5, y: 6, zoom: 0.5 },
  });
  const out = store.exportCanvas(created.canvas.id);
  assert.strictEqual(out.nodes.length, 2);
  assert.strictEqual(out.edges.length, 1);
  assert.deepStrictEqual(out.viewport, { x: 5, y: 6, zoom: 0.5 });
  // 卡片身上的关键字段都得在
  out.nodes.forEach((node) => {
    ['id', 'type', 'x', 'y', 'w', 'h', 'z', 'data'].forEach((key) => {
      assert.ok(Object.prototype.hasOwnProperty.call(node, key), '导出的卡片缺字段 ' + key);
    });
  });
});

check('导出不存在的画布返回 null（路由据此回 404）', () => {
  const store = makeSandbox('missing');
  assert.strictEqual(store.exportCanvas('c_并不存在'), null);
});

console.log('\n[2] 导入：编号全换新，参照关系跟着换');

check('导入后节点编号与本机已有的不撞号', () => {
  const store = makeSandbox('freshids');
  const host = store.createCanvas('本机已有');
  store.saveState(host.canvas.id, { nodes: [card('shared', 'image')], edges: [], viewport: null });
  const out = store.importCanvas(richScene());
  const imported = store.getState(out.canvas.id);
  const taken = new Set(idsOf(store.getState(host.canvas.id)));
  imported.nodes.forEach((node) => {
    assert(!taken.has(node.id), '导进来的编号撞上了本机已有的：' + node.id);
  });
});

check('导入永远建成一块新画布（不覆盖别人的）', () => {
  const store = makeSandbox('newcanvas');
  const host = store.createCanvas('本机已有');
  store.saveState(host.canvas.id, { nodes: [card('shared', 'image', { data: { text: '原样' } })], edges: [], viewport: null });
  const beforeCount = store.listCanvases().length;
  const out = store.importCanvas(richScene());
  assert.strictEqual(store.listCanvases().length, beforeCount + 1, '没有新建画布');
  // 原画布一个字都没动
  const hostState = store.getState(host.canvas.id);
  assert.strictEqual(hostState.nodes.length, 1);
  assert.strictEqual(hostState.nodes[0].data.text, '原样');
});

check('画布名带上「（导入）」，便于和原画布区分', () => {
  const store = makeSandbox('name');
  const out = store.importCanvas(richScene());
  assert(out.canvas.name.indexOf('（导入）') >= 0, '名字没标出来源：' + out.canvas.name);
});

check('组合的 members 跟着换号（不换的话组合会散）', () => {
  const store = makeSandbox('members');
  const out = store.importCanvas(richScene());
  const state = store.getState(out.canvas.id);
  const group = state.nodes.find((node) => node.type === 'group');
  const imageIds = state.nodes.filter((node) => node.type === 'image').map((node) => node.id);
  assert.strictEqual(group.data.members.length, 2, '组合成员数不对');
  group.data.members.forEach((id) => {
    assert(imageIds.indexOf(id) >= 0, 'member 指向了一张不存在的卡片：' + id);
  });
  // 成员必须是导入后的新编号，不是文件里的老编号
  assert(group.data.members.indexOf('n_img1') < 0, 'member 还是老编号，没换过来');
});

check('定时组的 members / order / perCard / snapshots 一起换号', () => {
  const store = makeSandbox('schedule');
  const out = store.importCanvas(richScene());
  const state = store.getState(out.canvas.id);
  const sched = state.nodes.find((node) => node.type === 'schedule');
  const videoId = state.nodes.find((node) => node.type === 'video').id;
  assert.deepStrictEqual(sched.data.members, [videoId], 'members 没换号');
  assert.deepStrictEqual(sched.data.order, [videoId], 'order 没换号');
  assert.deepStrictEqual(Object.keys(sched.data.schedule.perCard), [videoId], 'perCard 的钥匙没换号');
  assert.deepStrictEqual(Object.keys(sched.data.schedule.snapshots), [videoId], 'snapshots 的钥匙没换号');
  // 快照内容里的 @ 文字保持原样（换号是前端按新号重排的事）
  assert.strictEqual(sched.data.schedule.snapshots[videoId].promptRaw, '照着 @[图1] 做一段');
});

check('首尾帧的 frameOrder 跟着换号', () => {
  const store = makeSandbox('frameorder');
  const out = store.importCanvas(richScene());
  const state = store.getState(out.canvas.id);
  const video = state.nodes.find((node) => node.type === 'video');
  const imageIds = state.nodes.filter((node) => node.type === 'image').map((node) => node.id);
  assert.strictEqual(video.data.frameOrder.length, 2);
  video.data.frameOrder.forEach((id) => {
    assert(imageIds.indexOf(id) >= 0, 'frameOrder 指向了不存在的卡片：' + id);
  });
});

check('快速视频的 quickRefs 跟着换号（@ 引用不能断）', () => {
  const store = makeSandbox('quickrefs');
  const out = store.importCanvas(richScene());
  const state = store.getState(out.canvas.id);
  const quick = state.nodes.find((node) => node.type === 'quick');
  const imageIds = state.nodes.filter((node) => node.type === 'image').map((node) => node.id);
  const values = Object.keys(quick.data.quickRefs).map((tag) => quick.data.quickRefs[tag]);
  assert.strictEqual(values.length, 2);
  values.forEach((id) => {
    assert(imageIds.indexOf(id) >= 0, 'quickRefs 指向了不存在的卡片：' + id);
  });
});

check('连线的两头都换到了新编号，并且连的是原来那两张', () => {
  const store = makeSandbox('edges');
  const out = store.importCanvas(richScene());
  const state = store.getState(out.canvas.id);
  assert.strictEqual(state.edges.length, 1, '连线数不对');
  const imageId = state.nodes.find((node) => node.type === 'image' && node.data.text === '图一').id;
  const videoId = state.nodes.find((node) => node.type === 'video').id;
  assert.strictEqual(state.edges[0].sourceId, imageId, '连线的起点连错了卡片');
  assert.strictEqual(state.edges[0].targetId, videoId, '连线的终点连错了卡片');
});

check('导入报回节点数与连线数（界面上要显示「搬了几张」）', () => {
  const store = makeSandbox('counts');
  const out = store.importCanvas(richScene());
  assert.strictEqual(out.nodeCount, 6);
  assert.strictEqual(out.edgeCount, 1);
});

console.log('\n[3] 导入：残缺备份与坏数据');

check('指向不存在的卡片的 member 被摘掉（不留断引用）', () => {
  const store = makeSandbox('badmember');
  const payload = {
    canvas: { name: '残缺' },
    nodes: [card('n_a', 'image'), card('n_g', 'group', { data: { text: '组', members: ['n_a', 'n_不存在'] } })],
    edges: [],
  };
  const out = store.importCanvas(payload);
  const state = store.getState(out.canvas.id);
  const group = state.nodes.find((node) => node.type === 'group');
  assert.strictEqual(group.data.members.length, 1, '残缺 member 没被摘掉');
});

check('两头对不上的连线被丢掉（画布上不留断线）', () => {
  const store = makeSandbox('badedges');
  const payload = {
    canvas: { name: '断线' },
    nodes: [card('n_a', 'image')],
    edges: [edge('e1', 'n_a', 'n_不在'), edge('e2', 'n_也不在', 'n_a'), edge('e3', '', '')],
  };
  const out = store.importCanvas(payload);
  const state = store.getState(out.canvas.id);
  assert.strictEqual(state.edges.length, 0, '断线没被丢掉，留下了 ' + state.edges.length + ' 条');
  assert.strictEqual(out.edgeCount, 0);
});

check('坏视口洗干净（手改过 / 别的版本导出的）', () => {
  const store = makeSandbox('viewport');
  [
    { in: null, want: null },
    { in: { x: 'a', y: 1, zoom: 1 }, want: null },
    { in: { x: 1, y: 2, zoom: 0 }, want: { x: 1, y: 2, zoom: 1 } },
    { in: { x: 1, y: 2, zoom: 999 }, want: { x: 1, y: 2, zoom: 1 } },
    { in: { x: 1, y: 2, zoom: 2 }, want: { x: 1, y: 2, zoom: 2 } },
  ].forEach((item) => {
    const out = store.importCanvas({ canvas: { name: '视口' }, nodes: [card('n1', 'image')], edges: [], viewport: item.in });
    const state = store.getState(out.canvas.id);
    if (item.want === null) {
      // 坏视口不给用：落回画布自己的默认值
      assert(state.viewport && Number.isFinite(Number(state.viewport.zoom)), '坏视口没兜住');
    } else {
      assert.deepStrictEqual(state.viewport, item.want, '视口清洗结果不对');
    }
  });
});

check('空备份 / 缺字段不炸（给个能跑的默认）', () => {
  const store = makeSandbox('garbage');
  [null, {}, { nodes: null }, { nodes: [], edges: null }, { name: '只有名字' }].forEach((payload) => {
    const out = store.importCanvas(payload);
    assert(out && out.canvas && out.canvas.id, '空备份炸了：' + JSON.stringify(payload));
    assert(out.nodeCount === 0, '空备份却搬出了卡片');
  });
});

check('没名字的备份用「导入的画布」兜底', () => {
  const store = makeSandbox('noname');
  const out = store.importCanvas({ nodes: [card('n1', 'image')], edges: [] });
  assert(out.canvas.name.indexOf('导入的画布') >= 0, '没有兜底名：' + out.canvas.name);
});

console.log('\n[4] 往返：导出 → 导入 → 再导出');

check('往返后节点数、连线数、卡片类型一一对得上', () => {
  const store = makeSandbox('roundtrip');
  const source = store.importCanvas(richScene()); // 直接用导入当起点，省得手搭
  const exported = store.exportCanvas(source.canvas.id);
  const back = store.importCanvas(exported);
  const a = store.getState(source.canvas.id);
  const b = store.getState(back.canvas.id);
  assert.strictEqual(b.nodes.length, a.nodes.length, '节点数对不上');
  assert.strictEqual(b.edges.length, a.edges.length, '连线数对不上');
  const typesA = a.nodes.map((node) => node.type).sort().join(',');
  const typesB = b.nodes.map((node) => node.type).sort().join(',');
  assert.strictEqual(typesB, typesA, '卡片类型对不上');
});

check('往返后参照关系依然成立（组合还是那个组合）', () => {
  const store = makeSandbox('roundtrip2');
  const source = store.importCanvas(richScene());
  const back = store.importCanvas(store.exportCanvas(source.canvas.id));
  const a = store.getState(source.canvas.id);
  const b = store.getState(back.canvas.id);
  [a, b].forEach((state) => {
    const group = state.nodes.find((node) => node.type === 'group');
    const ids = new Set(state.nodes.map((node) => node.id));
    assert.strictEqual(group.data.members.length, 2, '组合成员数不对');
    group.data.members.forEach((id) => assert(ids.has(id), '组合成员指向不存在的卡片'));
  });
});

check('往返后卡片自己的内容没变（提示词、尺寸、坐标）', () => {
  const store = makeSandbox('roundtrip3');
  const source = store.importCanvas(richScene());
  const back = store.importCanvas(store.exportCanvas(source.canvas.id));
  const pick = (state) => state.nodes.find((node) => node.data.text === '图一');
  const a = pick(store.getState(source.canvas.id));
  const b = pick(store.getState(back.canvas.id));
  assert.strictEqual(b.x, a.x);
  assert.strictEqual(b.y, a.y);
  assert.strictEqual(b.w, a.w);
  assert.strictEqual(b.h, a.h);
  assert.strictEqual(b.data.text, a.data.text);
});

check('往返之后再导出，两份导出文件形状一致（换号除外）', () => {
  const store = makeSandbox('roundtrip4');
  const source = store.importCanvas(richScene());
  const once = store.exportCanvas(source.canvas.id);
  const back = store.importCanvas(once);
  const twice = store.exportCanvas(back.canvas.id);
  assert.strictEqual(twice.format, once.format);
  assert.strictEqual(twice.version, once.version);
  assert.strictEqual(twice.nodes.length, once.nodes.length);
  assert.strictEqual(twice.edges.length, once.edges.length);
  // 视口是「跟着画布走」的，往返后应保持
  assert.deepStrictEqual(twice.viewport, once.viewport);
});

console.log('\n[5] 导入后立刻留档（改乱了也能回到「刚导入时」）');

check('导入接口会给新画布立刻留一份长期备份', () => {
  const indexSrc = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
  const at = indexSrc.indexOf("pathname === '/api/canvases/import'");
  assert(at >= 0, '找不到导入路由');
  const body = indexSrc.slice(at, at + 700);
  assert(body.indexOf('backup.maybeBackup(imported.canvas.id, true)') >= 0, '导入后没有立刻留档');
  assert(body.indexOf('log(') >= 0, '导入完没有留下日志');
});

check('导入接口挡掉「没有节点数组」的文件，并给一句人话', () => {
  const indexSrc = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
  const at = indexSrc.indexOf("pathname === '/api/canvases/import'");
  const body = indexSrc.slice(at, at + 700);
  assert(body.indexOf('Array.isArray(body.nodes)') >= 0, '没有校验节点数组');
  assert(body.indexOf('这个文件不是画布备份') >= 0, '错误提示不是人话');
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
