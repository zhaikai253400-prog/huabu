'use strict';

// D5 上传重复检测的隔离测试（清单 24）。
//
// 测的是「同样的文件第二次上传时认得出来」这条路：
//   · 指纹算法本身（小文件全量、大文件抽样、大小进指纹）
//   · 索引的读 / 写 / 损坏兜底
//   · 命中判定的两种情况：素材还在（真命中）、素材被手动删了（当没命中，并顺手清记录）
//   · 记录 / 条数上限 / 清理
//
// 这里不起服务，直接对 asset-index 模块做单元测试 —— 上传路由那一层由浏览器端验证覆盖。
//
// 运行：runtime/node.exe tools/tests/asset-index.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');

// 隔离：本测试只碰自己的临时数据目录，绝不碰真实 data/
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-assetidx-'));
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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function eq(got, want, msg) {
  if (got !== want) {
    throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
  }
}

const paths = require(path.join(ROOT, 'server', 'paths.js'));
const assetIndex = require(path.join(ROOT, 'server', 'asset-index.js'));

// 隔离助手已经把 DATA_DIR 指到临时盒子了，这里再确认一次（写错地方就会污染真实库）
paths.assertDataDir(box);

const assetRoot = path.join(box, '素材');
fs.mkdirSync(assetRoot, { recursive: true });

function buf(size, fill) {
  return Buffer.alloc(size, fill || 0);
}

console.log('\nD5 · 内容指纹');

check('相同内容算出同一个指纹', () => {
  const a = Buffer.from('hello 世界', 'utf8');
  const b = Buffer.from('hello 世界', 'utf8');
  eq(assetIndex.fingerprint(a), assetIndex.fingerprint(b));
});

check('不同内容算出不同指纹', () => {
  assert(assetIndex.fingerprint(Buffer.from('aaa')) !== assetIndex.fingerprint(Buffer.from('bbb')));
});

check('空内容返回空指纹（视为「算不出来」，不参与查重）', () => {
  eq(assetIndex.fingerprint(Buffer.alloc(0)), '');
  eq(assetIndex.fingerprint(null), '');
});

check('文件大小进了指纹：内容相同但长度不同的前缀不会被误判为同一个文件', () => {
  // 大文件是抽样的，若大小不进指纹，两个「头尾相同、中间长度不同」的文件会撞上
  const head = buf(1024 * 1024, 1);
  const tail = buf(1024 * 1024, 2);
  const middle = buf(3 * 1024 * 1024, 3);
  const big1 = Buffer.concat([head, middle, tail]);
  const big2 = Buffer.concat([head, buf(5 * 1024 * 1024, 3), tail]);
  assert(assetIndex.fingerprint(big1) !== assetIndex.fingerprint(big2), '大小不同却算出同一个指纹');
});

check('大文件走抽样：头尾一样、中间巨长，指纹仍然一致（同一个人重复传同一文件）', () => {
  const head = buf(1024 * 1024, 7);
  const tail = buf(1024 * 1024, 9);
  const a = Buffer.concat([head, buf(3 * 1024 * 1024, 5), tail]);
  const b = Buffer.concat([head, buf(3 * 1024 * 1024, 5), tail]);
  eq(assetIndex.fingerprint(a), assetIndex.fingerprint(b));
});

check('小文件全量参与计算（改一个字节就变）', () => {
  const a = Buffer.from('这是一张图的字节');
  const b = Buffer.from('这是一张图的字节'.replace('一', '二'));
  assert(assetIndex.fingerprint(a) !== assetIndex.fingerprint(b));
});

console.log('\nD5 · 索引读写与损坏兜底');

check('索引文件落在数据目录里（跟着隔离走，不写别处）', () => {
  eq(path.dirname(assetIndex.indexPath()), path.resolve(box));
});

check('没有索引文件时读到空壳', () => {
  eq(assetIndex.count(), 0);
  const index = assetIndex.readIndex();
  eq(Object.keys(index.entries).length, 0);
});

check('索引文件是坏 JSON 时当空处理，不抛错', () => {
  fs.writeFileSync(assetIndex.indexPath(), '{ 这不是 JSON', 'utf8');
  const index = assetIndex.readIndex();
  eq(Object.keys(index.entries).length, 0);
  eq(assetIndex.count(), 0);
});

check('索引文件是合法 JSON 但结构不对时也当空处理', () => {
  fs.writeFileSync(assetIndex.indexPath(), JSON.stringify({ entries: 'not-an-object' }), 'utf8');
  eq(assetIndex.count(), 0);
  fs.writeFileSync(assetIndex.indexPath(), JSON.stringify(['array']), 'utf8');
  eq(assetIndex.count(), 0);
});

check('坏索引不影响重新记录（写回去就正常了）', () => {
  assetIndex.clear();
  const data = Buffer.from('一张图的字节');
  const asset = { relPath: '图片/x.png', url: '/media/图片/x.png', kind: 'image', bytes: data.length, width: 8, height: 8 };
  assetIndex.remember(assetRoot, data, asset, 'x.png');
  eq(assetIndex.count(), 1);
});

console.log('\nD5 · 命中判定');

check('同一个文件第二次上传能命中', () => {
  assetIndex.clear();
  const data = Buffer.from('内容一样的图片');
  const asset = { relPath: '图片/a.png', url: '/media/图片/a.png', kind: 'image', bytes: data.length, width: 8, height: 8 };
  assetIndex.remember(assetRoot, data, asset, 'a.png');
  // 把素材真写出来，模拟文件确实存在
  fs.mkdirSync(path.join(assetRoot, '图片'), { recursive: true });
  fs.writeFileSync(path.join(assetRoot, '图片', 'a.png'), data);

  const hit = assetIndex.findDuplicate(assetRoot, Buffer.from('内容一样的图片'));
  assert(hit, '应该命中');
  eq(hit.relPath, '图片/a.png');
  eq(hit.name, 'a.png');
});

check('内容不一样的文件不会命中', () => {
  const hit = assetIndex.findDuplicate(assetRoot, Buffer.from('另一张图'));
  eq(hit, null);
});

check('命中的那份已被手动删掉时，当没命中（并顺手清掉这条记录）', () => {
  assetIndex.clear();
  const data = Buffer.from('会被删掉的图');
  const asset = { relPath: '图片/gone.png', url: '/media/图片/gone.png', kind: 'image', bytes: data.length };
  assetIndex.remember(assetRoot, data, asset, 'gone.png');
  // 故意不把文件写出来，模拟用户手动清了素材目录
  const hit = assetIndex.findDuplicate(assetRoot, data);
  eq(hit, null, '文件没了就不该命中，否则卡片会指向不存在的路径');
  eq(assetIndex.count(), 0, '这条无效记录该被顺手清掉');
});

check('dryRun 模式下不写索引（只查询、不产生副作用）', () => {
  assetIndex.clear();
  const data = Buffer.from('空跑用的图');
  assetIndex.remember(assetRoot, data, { relPath: '图片/dry.png', url: '/media/图片/dry.png', kind: 'image', bytes: data.length }, 'dry.png');
  const before = fs.readFileSync(assetIndex.indexPath(), 'utf8');
  assetIndex.findDuplicate(assetRoot, data, { dryRun: true });
  eq(fs.readFileSync(assetIndex.indexPath(), 'utf8'), before, 'dryRun 不该改索引文件');
});

check('空内容不命中（算不出指纹就没有可比的东西）', () => {
  eq(assetIndex.findDuplicate(assetRoot, Buffer.alloc(0)), null);
});

console.log('\nD5 · 记录细节');

check('记下的字段齐全（relPath / url / name / kind / 尺寸 / 大小 / 时间）', () => {
  assetIndex.clear();
  const data = Buffer.from('字段齐全的图');
  assetIndex.remember(
    assetRoot,
    data,
    { relPath: '图片/full.png', url: '/media/图片/full.png', kind: 'image', bytes: data.length, width: 640, height: 480 },
    '原文件名.png'
  );
  const index = assetIndex.readIndex();
  const entry = Object.values(index.entries)[0];
  eq(entry.relPath, '图片/full.png');
  eq(entry.url, '/media/图片/full.png');
  eq(entry.name, '原文件名.png');
  eq(entry.kind, 'image');
  eq(entry.width, 640);
  eq(entry.height, 480);
  eq(entry.bytes, data.length);
  assert(Number(entry.at) > 0, '该记下时间');
});

check('同一个文件重复记只留一条（按指纹去重）', () => {
  assetIndex.clear();
  const data = Buffer.from('重复记录的图');
  const asset = { relPath: '图片/r.png', url: '/media/图片/r.png', kind: 'image', bytes: data.length };
  assetIndex.remember(assetRoot, data, asset, 'r.png');
  assetIndex.remember(assetRoot, data, asset, 'r.png');
  assetIndex.remember(assetRoot, data, asset, 'r.png');
  eq(assetIndex.count(), 1);
});

check('原来那份还在时不覆盖：先入库的那一份说了算', () => {
  assetIndex.clear();
  const data = Buffer.from('先来的那份还在');
  fs.mkdirSync(path.join(assetRoot, '图片'), { recursive: true });
  fs.writeFileSync(path.join(assetRoot, '图片', 'first.png'), data);
  assetIndex.remember(assetRoot, data, { relPath: '图片/first.png', url: '/media/图片/first.png', kind: 'image', bytes: data.length }, 'first.png');
  // 之后用户选「仍然存一份」，又落了一份同样的内容
  fs.writeFileSync(path.join(assetRoot, '图片', 'second.png'), data);
  assetIndex.remember(assetRoot, data, { relPath: '图片/second.png', url: '/media/图片/second.png', kind: 'image', bytes: data.length }, 'second.png');
  eq(assetIndex.count(), 1);
  const entry = Object.values(assetIndex.readIndex().entries)[0];
  eq(entry.relPath, '图片/first.png', '最先那份还在，就不该被后来的副本顶掉');
  const hit = assetIndex.findDuplicate(assetRoot, data);
  assert(hit, '应该命中');
  eq(hit.relPath, '图片/first.png', '弹框里说的和切过去拿到的必须是同一份');
});

check('原来那份没了，记录才挪到新副本上（重复检测不至于白丢）', () => {
  assetIndex.clear();
  const data = Buffer.from('先来的那份被删了');
  fs.mkdirSync(path.join(assetRoot, '图片'), { recursive: true });
  const firstPath = path.join(assetRoot, '图片', 'gone.png');
  fs.writeFileSync(firstPath, data);
  assetIndex.remember(assetRoot, data, { relPath: '图片/gone.png', url: '/media/图片/gone.png', kind: 'image', bytes: data.length }, 'gone.png');
  fs.rmSync(firstPath, { force: true });
  const keptPath = path.join(assetRoot, '图片', 'kept.png');
  fs.writeFileSync(keptPath, data);
  assetIndex.remember(assetRoot, data, { relPath: '图片/kept.png', url: '/media/图片/kept.png', kind: 'image', bytes: data.length }, 'kept.png');
  eq(assetIndex.count(), 1);
  const entry = Object.values(assetIndex.readIndex().entries)[0];
  eq(entry.relPath, '图片/kept.png', '老的那份没了，就该认新的这份');
});

check('换了个文件名 / 路径、老的那份也不在时，同一份内容仍然只记一条（最新的那次为准）', () => {
  assetIndex.clear();
  const data = Buffer.from('改过名字的同一个文件');
  assetIndex.remember(assetRoot, data, { relPath: '图片/old.png', url: '/media/图片/old.png', kind: 'image', bytes: data.length }, 'old.png');
  assetIndex.remember(assetRoot, data, { relPath: '图片/new.png', url: '/media/图片/new.png', kind: 'image', bytes: data.length }, 'new.png');
  eq(assetIndex.count(), 1);
  const entry = Object.values(assetIndex.readIndex().entries)[0];
  eq(entry.relPath, '图片/new.png', '该以最新一次为准');
});

check('记坏了（asset 缺 relPath）不写脏数据', () => {
  assetIndex.clear();
  const data = Buffer.from('缺路径的图');
  const fp = assetIndex.remember(assetRoot, data, { url: '/media/x.png' }, 'x.png');
  eq(fp, '', '缺 relPath 该直接放弃');
  eq(assetIndex.count(), 0);
});

check('索引写不进去也不抛错（磁盘满 / 权限问题不该让上传失败）', () => {
  assetIndex.clear();
  const data = Buffer.from('写不进索引的图');
  // 把索引路径变成一个目录，写文件就会失败
  fs.mkdirSync(assetIndex.indexPath(), { recursive: true });
  let threw = false;
  try {
    assetIndex.remember(assetRoot, data, { relPath: '图片/z.png', url: '/media/图片/z.png', kind: 'image', bytes: data.length }, 'z.png');
  } catch (error) {
    threw = true;
  }
  fs.rmSync(assetIndex.indexPath(), { recursive: true, force: true });
  assert(!threw, '索引写失败不该把异常抛给调用方');
});

console.log('\nD5 · 上限与清理');

check('条数超过上限时砍掉最早的，不让索引无限长大', () => {
  assetIndex.clear();
  // 上限 5000，这里塞 5005 条不同内容
  const total = 5005;
  for (let i = 0; i < total; i += 1) {
    const data = Buffer.from('图-' + i);
    assetIndex.remember(assetRoot, data, { relPath: '图片/n' + i + '.png', url: '/media/x', kind: 'image', bytes: data.length }, 'n' + i);
  }
  const n = assetIndex.count();
  assert(n <= 5000, '条数该被压到 5000 以内，实际 ' + n);
  assert(n >= 4990, '不该砍掉太多，实际 ' + n);
});

check('clear() 能清干净', () => {
  assetIndex.clear();
  eq(assetIndex.count(), 0);
});

console.log('\nD5 · 服务端源码级约束');

const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const assetIndexSrc = fs.readFileSync(path.join(ROOT, 'server', 'asset-index.js'), 'utf8');

check('上传路由支持三种模式（ask 先不落盘 / reuse 直接用 / 不带参数照旧存）', () => {
  const at = indexSrc.indexOf("pathname === '/api/assets/import'");
  assert(at >= 0, '没找到上传路由');
  const body = indexSrc.slice(at, at + 2600);
  assert(body.indexOf("dup === 'ask'") >= 0, '缺少 ask 模式');
  assert(body.indexOf("dup === 'reuse'") >= 0, '缺少 reuse 模式');
  assert(body.indexOf('duplicate: {') >= 0, '命中时没把已有素材的信息回给前端');
  assert(body.indexOf('reused: true') >= 0, '复用已有素材时没告诉前端「这是复用的」');
});

check('ask 模式下确实没落盘（命中后立刻返回，不往下走到 importAsset）', () => {
  const at = indexSrc.indexOf("pathname === '/api/assets/import'");
  const body = indexSrc.slice(at, at + 2600);
  const askAt = body.indexOf('duplicate: {');
  const saveAt = body.indexOf('assets.importAsset(');
  assert(askAt >= 0 && saveAt >= 0, '缺少关键分支');
  assert(askAt < saveAt, '命中后该先返回，不该继续存盘');
});

check('不带 dup 参数的老调用方行为不变（仍然直接存）', () => {
  const at = indexSrc.indexOf("pathname === '/api/assets/import'");
  const body = indexSrc.slice(at, at + 2600);
  // 查重被包在 if (dup === 'ask' || dup === 'reuse') 里
  const guardAt = body.indexOf("if (dup === 'ask' || dup === 'reuse')");
  const findAt = body.indexOf('assetIndex.findDuplicate(');
  assert(guardAt >= 0, '缺少 dup 判断');
  assert(findAt > guardAt, '查重该在 dup 判断之内');
});

check('存下之后会记进索引（否则下次认不出来）', () => {
  const at = indexSrc.indexOf("pathname === '/api/assets/import'");
  const body = indexSrc.slice(at, at + 2600);
  const saveAt = body.indexOf('assets.importAsset(');
  const rememberAt = body.indexOf('assetIndex.remember(');
  assert(rememberAt > saveAt, '存盘之后该记一笔');
});

check('指纹对大视频走抽样，不是整份读', () => {
  assert(assetIndexSrc.indexOf('SAMPLE_THRESHOLD') >= 0, '缺少抽样阈值');
  assert(assetIndexSrc.indexOf('subarray(0, SAMPLE_SIZE)') >= 0, '没取头部样本');
  assert(assetIndexSrc.indexOf('subarray(buffer.length - SAMPLE_SIZE)') >= 0, '没取尾部样本');
  assert(assetIndexSrc.indexOf('hash.update(String(buffer.length)') >= 0, '文件大小该进指纹');
});

check('索引损坏有兜底（读不动就当空，不抛错）', () => {
  const at = assetIndexSrc.indexOf('function readIndex(');
  const body = assetIndexSrc.slice(at, at + 900);
  assert(body.indexOf('catch') >= 0, 'readIndex 没有兜底');
  assert(body.indexOf('return { version: 1, entries: {} }') >= 0, '坏索引该返回空壳');
});

check('命中但文件已不在时不命中（避免卡片指向不存在的路径）', () => {
  const at = assetIndexSrc.indexOf('function findDuplicate(');
  const body = assetIndexSrc.slice(at, at + 1200);
  // 文件存在性判断收口在 stillThere 里，findDuplicate 与 remember 都复用它
  assert(body.indexOf('stillThere(') >= 0, '没检查文件是否还在');
  const helperAt = assetIndexSrc.indexOf('function stillThere(');
  assert(helperAt > 0, '缺少 stillThere 助手');
  assert(assetIndexSrc.slice(helperAt, helperAt + 400).indexOf('fs.existsSync') >= 0, 'stillThere 里该真的去问文件系统');
});

check('索引只认 node 内置模块（守住零第三方依赖）', () => {
  // 全项目的约束：服务端只用 node:*
  const requires = (assetIndexSrc.match(/require\('([^']+)'\)/g) || []).map((one) => one.slice(9, -2));
  requires.forEach((name) => {
    assert(name.indexOf('node:') === 0 || name.indexOf('./') === 0, '引入了非内置模块：' + name);
  });
});

console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
