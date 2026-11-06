'use strict';

// 本机访问守卫专项测试。
//
// 背景：服务只听 127.0.0.1，但浏览器里任何一个网页都能往 127.0.0.1 发请求。
// 没有守卫的时候，别人的网页可以替你发起付费生成、改画布、让导出接口往任意
// 目录写文件；DNS rebinding 还能绕过「只听回环」这一层。这里守四件事：
//
//   1. **Host 必须是本机**：伪造 Host 的请求一律 403（挡 DNS rebinding）。
//   2. **带 Origin 就必须同源**：跨站 Origin 一律 403（挡 CSRF）。
//   3. **/api/* 必须有钥匙**：没钥匙 401；页面钥匙碰不到 /api/channels*。
//   4. **页面拿到的钥匙各归各位**：画布页只有 uiToken，通道页只有 adminToken，
//      且页面源码里不会漏出另一把。
//
// 前三条先跑纯函数（快、可控），第四条起一个真实服务端到端验一遍：
// 只有真跑过一遍，「页面注入」和「守卫接线」才算真的对上了。
//
// 运行：runtime/node.exe tools/tests/guard.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-guard-'));
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
async function checkAsync(name, fn) {
  try {
    await fn();
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

const guard = require(path.join(ROOT, 'server', 'guard.js'));

const ADMIN = 'a'.repeat(48);
const UI = 'b'.repeat(48);

// 造一个「只带指定头」的假请求：守卫只看 headers，不需要真的 socket
function fake(headers, method) {
  return { headers: Object.assign({ host: '127.0.0.1:17890' }, headers || {}), method: method || 'GET' };
}
function keys(extra) {
  return Object.assign({ adminToken: ADMIN, uiToken: UI, queryToken: null }, extra || {});
}

console.log('G1 · Host 必须是本机（挡 DNS rebinding）');

check('Host 指向外网域名 → 403', () => {
  const out = guard.check(fake({ host: 'evil.example' }), 'none', keys());
  eq(out.ok, false);
  eq(out.code, 403);
});

check('Host 是本机 IP / localhost / IPv6 回环 → 放行', () => {
  for (const host of ['127.0.0.1:17890', 'localhost:17890', '[::1]:17890', '::1']) {
    eq(guard.check(fake({ host }), 'none', keys()).ok, true, '本机 Host 被误拒：' + host);
  }
});

check('没有 Host → 403', () => {
  eq(guard.check({ headers: {}, method: 'GET' }, 'none', keys()).ok, false);
});

check('形似本机其实不是（127.0.0.1.evil.example）→ 403', () => {
  eq(guard.check(fake({ host: '127.0.0.1.evil.example' }), 'none', keys()).ok, false);
});

console.log('\nG1c · 局域网访问（默认关闭；打开后只认这台电脑自己的地址）');

// 取这台测试机真实的网卡地址：换台电脑跑测试也不会因为写死 192.168.x.x 而失败
function lanIpOf() {
  const nets = os.networkInterfaces();
  for (const key of Object.keys(nets)) {
    for (const one of nets[key] || []) {
      if (one && !one.internal && (one.family === 'IPv4' || one.family === 4)) return one.address;
    }
  }
  return '';
}
const LAN_IP = lanIpOf();

check('开关关着时，网卡地址照旧 403（默认行为不变）', () => {
  if (!LAN_IP) return; // 没有网卡的机器跳过
  const out = guard.check(fake({ host: LAN_IP + ':17890' }), 'none', keys());
  eq(out.ok, false, '局域网开关没开，网卡地址不该放行');
  eq(out.code, 403);
});

check('开关打开后，本机网卡地址放行，并标记为「非本机」', () => {
  if (!LAN_IP) return;
  const out = guard.check(fake({ host: LAN_IP + ':17890' }), 'none', keys({ lanEnabled: true }));
  eq(out.ok, true, '局域网地址被误拒：' + LAN_IP);
  eq(out.local, false, '来自局域网的请求必须能区分出来');
});

check('开关打开后，回环地址仍然标记为「本机」', () => {
  const out = guard.check(fake({ host: '127.0.0.1:17890' }), 'none', keys({ lanEnabled: true }));
  eq(out.ok, true);
  eq(out.local, true);
});

check('开关打开后，别人的 192.168.x.x 依旧 403（不是整段放行）', () => {
  const out = guard.check(fake({ host: '192.168.255.254:17890' }), 'none', keys({ lanEnabled: true }));
  if (LAN_IP === '192.168.255.254') return; // 极端巧合，跳过
  eq(out.ok, false, '随便一个局域网 IP 也能进，等于把服务暴露给整段子网');
});

check('开关打开后，Origin 也按同一套地址表校验', () => {
  if (!LAN_IP) return;
  eq(guard.check(fake({ host: LAN_IP + ':17890', origin: 'http://' + LAN_IP + ':17890' }), 'none', keys({ lanEnabled: true })).ok, true);
  eq(guard.check(fake({ host: LAN_IP + ':17890', origin: 'http://evil.example' }), 'none', keys({ lanEnabled: true })).ok, false);
  eq(guard.check(fake({ host: LAN_IP + ':17890', origin: 'http://192.168.255.254:17890' }), 'none', keys({ lanEnabled: true })).ok, false);
});

check('局域网地址也要带钥匙：ui 级没钥匙仍是 401', () => {
  if (!LAN_IP) return;
  const out = guard.check(fake({ host: LAN_IP + ':17890' }), 'ui', keys({ lanEnabled: true }));
  eq(out.ok, false);
  eq(out.code, 401);
});

check('lanAddresses 只列真实 IPv4，不含回环 / 169.254', () => {
  const list = guard.lanAddresses();
  assert(Array.isArray(list), 'lanAddresses 该返回数组');
  list.forEach((ip) => {
    assert(ip !== '127.0.0.1', '不该含回环地址');
    assert(ip.indexOf('169.254.') !== 0, '不该含自动地址');
  });
});

check('通道页与会话级接口被列为「只限本机」', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert(/function isLocalOnlyPath\(pathname\)/.test(indexSrc), '缺 isLocalOnlyPath');
  assert(indexSrc.indexOf("pathname === '/channels' || pathname === '/channels.html'") >= 0, '通道页没拦住');
  assert(indexSrc.indexOf("pathname.indexOf('/api/channels') === 0") >= 0, '通道接口没拦住');
  // 钩子换了：现在局域网是「只放行程序代码白名单」的白名单式拦截，
  // 比黑名单更保守（漏一条路径也进不来）。两种钩子都应该被认。
  assert(
    /verdict\.local === false && !lanCollabAllowed\(pathname\)/.test(indexSrc) ||
      /verdict\.local === false && !isLanShareablePath\(pathname\)/.test(indexSrc) ||
      /verdict\.local === false && isLocalOnlyPath\(pathname\)/.test(indexSrc),
    '拦截没接到守卫结果上'
  );
});

check('局域网只开放「程序代码」两个只读接口，画布与素材不跨机', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert(/function isLanShareablePath\(pathname\)/.test(indexSrc), '缺 isLanShareablePath');
  assert(indexSrc.indexOf("pathname === '/api/codesync/manifest'") >= 0, '清单接口没放行');
  assert(indexSrc.indexOf("pathname === '/api/codesync/file'") >= 0, '取文件接口没放行');
  // 反面：这些用户数据类接口必须不在放行名单里（用正则把函数体抽出来看）
  const fn = /function isLanShareablePath\(pathname\) \{([\s\S]*?)\n\}/.exec(indexSrc);
  assert(fn, '抽不出 isLanShareablePath 函数体');
  const body = fn[1];
  for (const bad of ['/api/library', '/api/assets', '/api/canvases', '/api/tasks', '/api/channels']) {
    assert(body.indexOf(bad) < 0, '局域网竟然放行了 ' + bad);
  }
  // 总闸：非白名单路径在 verdict.local === false 时一律 403。
  // 共享协作把「放行」扩成了一道单独的闸 lanCollabAllowed：它内部先问
  // isLanShareablePath，再问「有没有画布开着共享」。没开共享时行为与以前一致。
  assert(/verdict\.local === false && !lanCollabAllowed\(pathname\)/.test(indexSrc),
    '局域网总闸没接上，画布和素材会被别的电脑读到');
  const collab = /function lanCollabAllowed\(pathname\) \{([\s\S]*?)\n\}/.exec(indexSrc);
  assert(collab, '抽不出 lanCollabAllowed 函数体');
  assert(collab[1].indexOf('isLanShareablePath(pathname)') >= 0, 'lanCollabAllowed 丢了程序代码白名单');
  assert(collab[1].indexOf('hasShared()') >= 0,
    'lanCollabAllowed 没把「有没有共享画布」当成开关，等于共享一开就全放行或永远不放行');
});

console.log('\nG1d · 局域网监听与配置');

check('listen 的绑定地址跟着开关走，不会一直开 0.0.0.0', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert(/const bindHost = config\.lan && config\.lan\.enabled \? '0\.0\.0\.0' : '127\.0\.0\.1'/.test(indexSrc), '绑定地址没跟开关');
  assert(/server\.listen\(port, bindHost,/.test(indexSrc), 'listen 没用 bindHost');
});

check('配置默认关闭，且只认明确的 true', () => {
  const configSrc = fs.readFileSync(path.join(ROOT, 'server', 'config.js'), 'utf8');
  assert(/lan: \{\s*enabled: false,?\s*\}/.test(configSrc), '默认值不是关闭');
  const normalize = require(path.join(ROOT, 'server', 'config.js')).normalizeLan;
  eq(normalize(undefined).enabled, false);
  eq(normalize({ enabled: 'yes' }).enabled, false, '非 true 的值不许打开');
  eq(normalize({ enabled: 1 }).enabled, false, '非 true 的值不许打开');
  eq(normalize({ enabled: true }).enabled, true);
});

console.log('\nG1b · 静态目录越界（前缀相同也不行）');

check('isInsideDir：真正的子路径放行', () => {
  const root = path.join('D:', '项目', 'web');
  eq(guard.isInsideDir(root, path.join(root, 'assets', 'api.js')), true);
  eq(guard.isInsideDir(root, root), true);
});

check('isInsideDir：.. 跳出去 → false', () => {
  const root = path.join('D:', '项目', 'web');
  eq(guard.isInsideDir(root, path.join(root, '..', 'server', 'index.js')), false);
  eq(guard.isInsideDir(root, path.join(root, '..')), false);
});

check('isInsideDir：只是字符串前缀相同的兄弟目录 → false', () => {
  // 这正是 startsWith 判断的漏洞：web 与 web备份 前缀相同，
  // 但 /assets/../../web备份/x 并不在 web 里
  const root = path.join('D:', '项目', 'web');
  eq(guard.isInsideDir(root, path.join('D:', '项目', 'web备份', 'secret.txt')), false);
  eq(guard.isInsideDir(root, path.join('D:', '项目', 'web-old', 'x.js')), false);
});

check('静态目录判定不再用 startsWith（两处都改成了 isInsideDir）', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const bad = indexSrc.match(/resolved\.startsWith\(paths\.WEB_DIR\)/g) || [];
  eq(bad.length, 0, '还有地方用字符串前缀判断目录归属');
  const good = indexSrc.match(/guard\.isInsideDir\(paths\.WEB_DIR, resolved\)/g) || [];
  eq(good.length, 2, '应该有两处（serveStatic / serveHtmlWithTokens）');
});

console.log('\nG2 · 带 Origin 就必须同源（挡 CSRF）');

check('跨站 Origin → 403', () => {
  const out = guard.check(fake({ origin: 'http://evil.example' }), 'ui', keys({ uiToken: UI }));
  eq(out.ok, false);
  eq(out.code, 403);
});

check('本机但端口对不上（另一个本机服务）→ 403', () => {
  const out = guard.check(
    fake({ host: '127.0.0.1:17890', origin: 'http://127.0.0.1:9999' }),
    'none',
    keys()
  );
  eq(out.ok, false);
  eq(out.code, 403);
});

check('同源 Origin → 放行；完全不带 Origin（同源导航）→ 放行', () => {
  eq(guard.check(fake({ host: '127.0.0.1:17890', origin: 'http://127.0.0.1:17890' }), 'none', keys()).ok, true);
  eq(guard.check(fake({ host: '127.0.0.1:17890' }), 'none', keys()).ok, true);
});

check('Origin 是畸形的（null / 空串）→ 403', () => {
  eq(guard.check(fake({ origin: 'null' }), 'none', keys()).ok, false);
  eq(guard.check(fake({ origin: '' }), 'none', keys()).ok, false);
});

console.log('\nG3 · 接口钥匙分级');

check('ui 级：没钥匙 → 401', () => {
  const out = guard.check(fake(), 'ui', keys());
  eq(out.ok, false);
  eq(out.code, 401);
});

check('ui 级：uiToken 或 adminToken 都放行（托盘手里是 admin）', () => {
  eq(guard.check(fake({ 'x-local-token': UI }), 'ui', keys()).ok, true);
  eq(guard.check(fake({ 'x-local-token': ADMIN }), 'ui', keys()).ok, true);
});

check('admin 级：uiToken → 401（画布页拿不到平台密钥这条承诺靠它）', () => {
  const out = guard.check(fake({ 'x-local-token': UI }), 'admin', keys());
  eq(out.ok, false);
  eq(out.code, 401);
});

check('admin 级：adminToken → 放行', () => {
  eq(guard.check(fake({ 'x-local-token': ADMIN }), 'admin', keys()).ok, true);
});

check('钥匙不许是前缀 / 大小写变体（常量时间比较不能顺手放水）', () => {
  eq(guard.check(fake({ 'x-local-token': ADMIN.slice(0, 47) }), 'admin', keys()).ok, false);
  eq(guard.check(fake({ 'x-local-token': ADMIN.toUpperCase() }), 'admin', keys()).ok, false);
});

check('查询串钥匙只用于 GET 下载，服务端传 null 时就不认', () => {
  eq(guard.check(fake({}), 'ui', keys({ queryToken: UI })).ok, true);
  eq(guard.check(fake({}), 'ui', keys({ queryToken: null })).ok, false);
});

check('/api/status 与 /api/health 是探针，不要求钥匙（但要过 Host）', () => {
  // tokenNeedOf 就在 index.js 里，这里直接按它的规则核对，避免出现「以为不要求、
  // 其实接线接了 ui」的错位
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert(/pathname === '\/api\/status' \|\| pathname === '\/api\/health'\) return 'none'/.test(indexSrc),
    'status / health 没有设成 none，托盘和单实例检测会挂');
  assert(/pathname\.indexOf\('\/api\/channels'\) === 0\) return 'admin'/.test(indexSrc),
    'channels 没有设成 admin');
});

console.log('\nG4 · 页面注入（源码级）');

const pageOf = (name) => fs.readFileSync(path.join(ROOT, 'web', name), 'utf8');

check('三个普通页面都注入了 __uiToken，且在 api.js 之前', () => {
  for (const name of ['canvas.html', 'index.html', 'launcher.html']) {
    const src = pageOf(name);
    const tok = src.indexOf("window.__uiToken = '__UI_TOKEN__'");
    const api = src.indexOf('/assets/api.js');
    assert(tok >= 0, name + ' 没有页面钥匙占位符');
    assert(api > tok, name + ' 的钥匙脚本必须在 api.js 之前，否则 api.js 读到空值');
  }
});

check('通道页注入的是 __LOCAL_TOKEN__（管理钥匙）', () => {
  assert(pageOf('channels.html').indexOf("window.__localToken = '__LOCAL_TOKEN__'") >= 0);
});

check('页面源码里没有硬编码真实钥匙的痕迹（占位符之外）', () => {
  for (const name of ['canvas.html', 'index.html', 'launcher.html', 'channels.html']) {
    const src = pageOf(name);
    const leaks = src.match(/[0-9a-f]{48}/g) || [];
    eq(leaks.length, 0, name + ' 里出现疑似写死的钥匙');
  }
});

check('api.js 有钥匙自愈：401 时重取页面钥匙并重试一次（带 body）', () => {
  // 托盘「重启服务」会换新钥匙，旧页面不自愈就只能 401 到底、逼用户刷新丢改动
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'api.js'), 'utf8');
  assert(/response\.status === 401 && \(await refreshToken\(\)\)/.test(src), '没有 401 自愈');
  assert(src.indexOf('window.__uiToken = ui[1]') >= 0, '自愈没把新钥匙写回 __uiToken');
  assert(src.indexOf('window.__localToken = admin[1]') >= 0, '通道页没把管理钥匙写回 __localToken');
  const from = src.indexOf('await refreshToken()');
  assert(src.slice(from, from + 600).indexOf('body: options.body') >= 0,
    '重试时丢了 body：PUT 会把画布存空');
  assert(src.indexOf('/channels') >= 0 && src.indexOf('isAdminPage') >= 0,
    '通道页自愈会拿错页面的钥匙');
});

check('页面里不再有裸 fetch（钥匙必须统一由 api.js 补）', () => {
  for (const name of ['canvas.js', 'logs.js', 'portal.js', 'library.js', 'tasks.js', 'chstatus.js']) {
    const file = path.join(ROOT, 'web', 'assets', name);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const hits = src.match(/\bfetch\(/g) || [];
    eq(hits.length, 0, name + ' 里还有裸 fetch，可能漏带钥匙');
  }
});

// ---------- 端到端：真起一个隔离服务，把上面的规则再走一遍 HTTP ----------

// 端口不写死：两次 run-all 挨得近时，上一轮的服务可能还没退干净，
// 写死端口会让新一轮因为「端口被占」假失败。改成每次向系统要一个空端口。
let PORT = 0;

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

// 收尾要等子进程真的退出：只发信号就往下走，下一轮可能撞上还在监听的旧服务。
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

function request(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: opts.path,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        setHost: false,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('请求超时')));
    req.end(opts.body == null ? undefined : JSON.stringify(opts.body));
  });
}

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      // 守卫第一道就是查 Host，探测请求自己也得按规矩带一个
      const r = await request({ path: '/api/health', headers: { host: '127.0.0.1:' + PORT } });
      if (r.status === 200) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  console.log('\nG5 · 端到端（隔离目录里起真实服务）');
  PORT = await pickFreePort();

  const dataDir = path.join(box, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(box, '素材'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ port: PORT, assetRoot: path.join(box, '素材') }, null, 2),
    'utf8'
  );

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--no-browser'], {
    cwd: box,
    env: Object.assign({}, process.env, {
      http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '',
      CANVAS_DATA_DIR: dataDir,
    }),
    stdio: 'ignore',
  });

  const up = await waitUp();
  if (!up) {
    console.log('  ✗ 隔离服务没起来，后面的端到端检查无法进行');
    fail += 1;
    await stopChild(child);
    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(1);
  }

  const admin = fs.readFileSync(path.join(dataDir, 'admin-token.txt'), 'utf8').trim();
  const ui = fs.readFileSync(path.join(dataDir, 'ui-token.txt'), 'utf8').trim();
  const api = (path, headers, method, body) => request({ path, headers, method, body });

  await checkAsync('两把钥匙都生成了，且互不相同', async () => {
    assert(admin.length >= 32 && ui.length >= 32, '钥匙太短');
    assert(admin !== ui, '两把钥匙生成成了一样的');
  });

  await checkAsync('/api/status 不带钥匙也能探活（托盘 / 单实例检测靠它）', async () => {
    const r = await api('/api/status', { host: '127.0.0.1:' + PORT });
    eq(r.status, 200, r.body.slice(0, 120));
  });

  await checkAsync('无钥匙 GET /api/tasks → 401', async () => {
    const r = await api('/api/tasks', { host: '127.0.0.1:' + PORT });
    eq(r.status, 401, r.body.slice(0, 120));
  });

  await checkAsync('带页面钥匙 GET /api/tasks → 200', async () => {
    const r = await api('/api/tasks', { host: '127.0.0.1:' + PORT, 'x-local-token': ui });
    eq(r.status, 200, r.body.slice(0, 120));
  });

  await checkAsync('页面钥匙碰 /api/channels → 401（关键：画布页拿不到平台密钥）', async () => {
    const r = await api('/api/channels', { host: '127.0.0.1:' + PORT, 'x-local-token': ui });
    eq(r.status, 401, r.body.slice(0, 120));
  });

  await checkAsync('管理钥匙碰 /api/channels → 200', async () => {
    const r = await api('/api/channels', { host: '127.0.0.1:' + PORT, 'x-local-token': admin });
    eq(r.status, 200, r.body.slice(0, 120));
  });

  await checkAsync('跨站 Origin 的 POST /api/settings → 403，且设置没被写进去', async () => {
    const r = await api(
      '/api/settings',
      {
        host: '127.0.0.1:' + PORT,
        origin: 'http://evil.example',
        'x-local-token': ui,
        'content-type': 'application/json',
      },
      'POST',
      { ui: { scale: 3 } }
    );
    eq(r.status, 403, r.body.slice(0, 120));
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert(!cfg.ui || cfg.ui.scale !== 3, '跨站请求居然改到了配置');
  });

  await checkAsync('伪造 Host 的 /api/status → 403', async () => {
    const r = await api('/api/status', { host: 'evil.example' });
    eq(r.status, 403, r.body.slice(0, 120));
  });

  await checkAsync('伪造 Host 的静态页面也 → 403（DNS rebinding 挡在页面之前）', async () => {
    const r = await api('/', { host: 'evil.example' });
    eq(r.status, 403, r.body.slice(0, 120));
  });

  await checkAsync('画布页 / 门户页 / 启动器都 200，且注入的是页面钥匙', async () => {
    for (const p of ['/', '/canvas', '/launcher']) {
      const r = await api(p, { host: '127.0.0.1:' + PORT });
      eq(r.status, 200, p + ' → ' + r.status);
      assert(r.body.indexOf("window.__uiToken = '" + ui + "'") >= 0, p + ' 没注入页面钥匙');
      assert(r.body.indexOf(admin) < 0, p + ' 里漏出了管理钥匙');
      assert(r.body.indexOf('__UI_TOKEN__') < 0, p + ' 占位符没被替换');
    }
  });

  await checkAsync('通道页 200，注入的是管理钥匙，且没有页面钥匙', async () => {
    const r = await api('/channels', { host: '127.0.0.1:' + PORT });
    eq(r.status, 200);
    assert(r.body.indexOf("window.__localToken = '" + admin + "'") >= 0, '通道页没拿到管理钥匙');
    assert(r.body.indexOf(ui) < 0, '通道页里漏出了页面钥匙');
    // 通道页不该出现页面钥匙的赋值——它只有 __LOCAL_TOKEN__ 那一行
    assert(r.body.indexOf('window.__uiToken') < 0, '通道页出现了页面钥匙');
  });

  await checkAsync('静态资源与素材不要求钥匙（但仍是本机 Host）', async () => {
    const r = await api('/assets/api.js', { host: '127.0.0.1:' + PORT });
    eq(r.status, 200, '静态脚本被误拦了');
  });

  await checkAsync('编码过的 ../ 也读不到 web 目录外的文件（真 HTTP）', async () => {
    for (const p of ['/..%2fserver%2findex.js', '/..%2fdata%2fconfig.json', '/assets/..%2f..%2fserver%2fstore.js']) {
      const r = await api(p, { host: '127.0.0.1:' + PORT });
      eq(r.status, 403, p + ' 没有被拦住（' + r.status + '）');
    }
  });

  await checkAsync('所有响应都带 nosniff / no-referrer / 禁止套框', async () => {
    // 覆盖三类出口：接口、页面、静态资源。早退的错误响应也要有——
    // 403 的正文是纯文本，没有 nosniff 时老浏览器仍可能按 HTML 解析。
    const targets = [
      { path: '/api/status', headers: { host: '127.0.0.1:' + PORT } },
      { path: '/', headers: { host: '127.0.0.1:' + PORT } },
      { path: '/assets/api.js', headers: { host: '127.0.0.1:' + PORT } },
      { path: '/', headers: { host: 'evil.example' } },
    ];
    for (const t of targets) {
      const r = await api(t.path, t.headers);
      eq(r.headers['x-content-type-options'], 'nosniff', t.path + ' 缺 nosniff');
      eq(r.headers['referrer-policy'], 'no-referrer', t.path + ' 缺 no-referrer');
      eq(r.headers['x-frame-options'], 'DENY', t.path + ' 缺 X-Frame-Options');
      assert(/frame-ancestors 'none'/.test(r.headers['content-security-policy'] || ''), t.path + ' 缺 frame-ancestors');
    }
  });

  await checkAsync('日志下载：查询串钥匙有效（浏览器直接导航带不了请求头）', async () => {
    const r = await api('/api/log/download?day=2000-01-01&token=' + ui, { host: '127.0.0.1:' + PORT });
    // 那天没有日志，服务端应回 404 而不是 401 —— 401 说明钥匙没被认
    assert(r.status !== 401, '查询串里的钥匙没被认，下载会一直失败：' + r.body.slice(0, 120));
  });

  await checkAsync('别的接口不接受查询串钥匙（钥匙不该进 URL 历史）', async () => {
    const r = await api('/api/tasks?token=' + ui, { host: '127.0.0.1:' + PORT });
    eq(r.status, 401, '查询串钥匙在普通接口上被认了：' + r.body.slice(0, 120));
  });

  await checkAsync('日志下载：POST 不接受查询串钥匙（只有 GET 用于直接导航）', async () => {
    const r = await api(
      '/api/log/download?token=' + ui,
      { host: '127.0.0.1:' + PORT, 'content-type': 'application/json' },
      'POST',
      {}
    );
    assert(r.status === 401 || r.status === 405, 'POST 居然凭查询串过了守卫：' + r.status);
  });

  await stopChild(child);

  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.log('测试异常：' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
