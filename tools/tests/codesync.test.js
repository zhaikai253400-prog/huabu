'use strict';

// 程序代码同步专项测试。
//
// 这个功能的全部风险都在「哪些文件允许出去 / 允许写回来」。
// 所以这里不测网络，只把白名单和差异计算钉死：
//   · 画布库（data/）、素材库（素材/）、备份（work/、_archive/）绝不进清单；
//   · 备份件 *.<bak-xxx> 绝不进清单；
//   · 任何 .. 穿越、绝对路径、非白名单顶层目录，一律解析成 null；
//   · 两台机器的清单做差，新增 / 更新 / 多余 / 一致四类要分得清。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');
process.chdir(ROOT);

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-codesync-'));
require(path.join(__dirname, '_isolate.js'))(box);

const codesync = require(path.join(ROOT, 'server', 'codesync.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  \u2713 ' + name);
  } catch (error) {
    fail += 1;
    console.log('  \u2717 ' + name + ' \u2014\u2014 ' + error.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '\u65ad\u8a00\u5931\u8d25');
}
function eq(got, want, msg) {
  if (got !== want) {
    throw new Error((msg || '\u503c\u4e0d\u76f8\u7b49') + '\uff1a\u62ff\u5230 ' + JSON.stringify(got) + '\uff0c\u671f\u671b ' + JSON.stringify(want));
  }
}

console.log('C1 \u00b7 \u6e05\u5355\u91cc\u53ea\u6709\u7a0b\u5e8f\u6587\u4ef6');

const files = codesync.listLocalFiles();
const paths = files.map((one) => one.path);

check('\u6e05\u5355\u4e0d\u4e3a\u7a7a\uff08\u5426\u5219\u540e\u9762\u7684\u65ad\u8a00\u90fd\u662f\u7a7a\u8f6c', () => {
  assert(paths.length > 0, '\u4e00\u4e2a\u7a0b\u5e8f\u6587\u4ef6\u90fd\u6ca1\u5217\u5230');
});

const NEVER = ['data/', '\u7d20\u6750/', 'work/', '_archive/', 'node_modules/', '.git/'];
for (const prefix of NEVER) {
  check('\u4e0d\u542b ' + prefix + '\uff08\u6570\u636e / \u7d20\u6750 / \u5907\u4efd\u4e0d\u8de8\u673a\uff09', () => {
    const bad = paths.filter((one) => one.toLowerCase().indexOf(prefix.toLowerCase()) === 0);
    eq(bad.length, 0, '\u6f0f\u8fdb\u6765\u4e86\uff1a' + bad.slice(0, 3).join(', '));
  });
}

check('\u4e0d\u542b\u4efb\u4f55\u5907\u4efd\u4ef6 / \u4e34\u65f6\u4ef6\uff08.bak / .tmp / .log / .pdb\uff09', () => {
  const bad = paths.filter((one) => /(\.bak|\.tmp|\.log|\.pdb|~$)/i.test(one));
  eq(bad.length, 0, '\u6f0f\u8fdb\u6765\u4e86\uff1a' + bad.slice(0, 3).join(', '));
});

check('\u4e0d\u542b\u4efb\u4f55\u7edd\u5bf9\u8def\u5f84\u6216 .. \u6bb5', () => {
  const bad = paths.filter((one) => one.indexOf('..') >= 0 || path.isAbsolute(one) || one.indexOf(':') >= 0);
  eq(bad.length, 0, '\u8def\u5f84\u4e0d\u5e72\u51c0\uff1a' + bad.slice(0, 3).join(', '));
});

check('\u6bcf\u4e2a\u6587\u4ef6\u90fd\u80fd\u901a\u8fc7\u767d\u540d\u5355\u53cd\u67e5', () => {
  for (const one of paths) {
    assert(codesync.resolveCodePath(one), '\u6e05\u5355\u91cc\u7684 ' + one + ' \u53cd\u67e5\u4e0d\u901a\u8fc7');
  }
});

check('\u53ea\u6709 4 \u4e2a\u4ee3\u7801\u76ee\u5f55 + \u6839\u90e8\u6587\u4ef6', () => {
  const tops = new Set(paths.map((one) => (one.indexOf('/') >= 0 ? one.split('/')[0] : one)));
  for (const top of tops) {
    const ok = codesync.CODE_DIRS.indexOf(top) >= 0 || codesync.CODE_FILES.indexOf(top) >= 0;
    assert(ok, '\u4e0d\u5c5e\u4e8e\u767d\u540d\u5355\u7684\u9876\u5c42\uff1a' + top);
  }
});

console.log('\nC2 \u00b7 \u8def\u5f84\u767d\u540d\u5355\uff08\u8d8a\u754c\u4e00\u5f8b null\uff09');

const BLOCKED = [
  'data/config.json',
  'data/canvas.db',
  '\u7d20\u6750/\u56fe\u7247/a.png',
  'work/index.js.bak-codesync',
  '_archive/old.js',
  '.git/config',
  'node_modules/x/index.js',
  '../secret.txt',
  'server/../../x.js',
  'server/../data/config.json',
  'web/assets/api.js.bak-codesync',
  '/etc/passwd',
  'C:/Windows/win.ini',
  '',
  '   ',
  'server',
  'random.txt',
  '使用说明.txt.bak',
];
for (const bad of BLOCKED) {
  check('\u62d2\u7edd ' + JSON.stringify(bad), () => {
    assert(codesync.resolveCodePath(bad) === null, '\u5c45\u7136\u653e\u884c\u4e86\uff1a' + bad);
  });
}

check('\u5141\u8bb8 server/index.js \u8fd9\u7c7b\u767d\u540d\u5355\u6587\u4ef6', () => {
  const abs = codesync.resolveCodePath('server/index.js');
  assert(abs && path.isAbsolute(abs), '\u6b63\u5e38\u6587\u4ef6\u88ab\u62e6\u4e86');
  assert(abs.startsWith(ROOT + path.sep), '\u89e3\u6790\u51fa\u6765\u7684\u8def\u5f84\u4e0d\u5728\u7a0b\u5e8f\u76ee\u5f55\u91cc');
});

check('\u53cd\u659c\u6760\u5199\u6cd5\u4e5f\u80fd\u8ba4\uff08Windows \u4e60\u60ef\uff09', () => {
  assert(codesync.resolveCodePath('server\\\\index.js') !== null, '\u53cd\u659c\u6760\u6ca1\u5f52\u4e00\u5316');
});

check('\u542b \\0 \u7684\u8def\u5f84\u62d2\u7edd', () => {
  assert(codesync.resolveCodePath('server/index.js\0.txt') === null);
});

check('isCodeFile \u5bf9\u4e0d\u5b58\u5728\u7684\u767d\u540d\u5355\u6587\u4ef6\u8fd4\u56de false', () => {
  eq(codesync.isCodeFile('server/__no_such_file__.js'), false);
  eq(codesync.isCodeFile('data/config.json'), false);
});

console.log('\nC3 \u00b7 diffManifests \u5dee\u5f02\u8ba1\u7b97');

const remote = [
  { path: 'a.js', size: 10, mtime: 100 },
  { path: 'b.js', size: 20, mtime: 200 },
  { path: 'c.js', size: 30, mtime: 300 },
];
const local = [
  { path: 'a.js', size: 10, mtime: 100 },
  { path: 'b.js', size: 21, mtime: 200 },
  { path: 'd.js', size: 40, mtime: 400 },
];

check('\u65b0\u589e / \u66f4\u65b0 / \u591a\u4f59 / \u4e00\u81f4 \u56db\u7c7b\u5404\u5f52\u5404\u4f4d', () => {
  const out = codesync.diffManifests(remote, local);
  eq(out.add.length, 1, '\u65b0\u589e\u6570\u4e0d\u5bf9');
  eq(out.add[0].path, 'c.js');
  eq(out.update.length, 1, '\u66f4\u65b0\u6570\u4e0d\u5bf9\uff08\u5927\u5c0f\u53d8\u4e86\uff09');
  eq(out.update[0].path, 'b.js');
  eq(out.extra.length, 1, '\u672c\u673a\u591a\u51fa\u6765\u7684\u5e94\u8be5\u5355\u72ec\u5217');
  eq(out.extra[0], 'd.js');
  eq(out.same, 1, '\u4e00\u81f4\u6570\u4e0d\u5bf9');
});

check('\u65f6\u95f4\u53d8\u4e86\u4e5f\u7b97\u66f4\u65b0\uff08\u540c\u5927\u5c0f\u4e0d\u540c mtime\uff09', () => {
  const out = codesync.diffManifests([{ path: 'a.js', size: 10, mtime: 999 }], [{ path: 'a.js', size: 10, mtime: 100 }]);
  eq(out.update.length, 1);
  eq(out.same, 0);
});

check('\u5b8c\u5168\u4e00\u81f4\u65f6 add / update \u90fd\u662f\u7a7a\u7684', () => {
  const out = codesync.diffManifests(remote, remote.map((one) => Object.assign({}, one)));
  eq(out.add.length, 0);
  eq(out.update.length, 0);
  eq(out.extra.length, 0);
  eq(out.same, 3);
});

check('\u7a7a\u6e05\u5355\u4e0d\u4f1a\u62a5\u9519', () => {
  const out = codesync.diffManifests([], []);
  eq(out.add.length, 0);
  eq(out.same, 0);
});

console.log('\nC4 \u00b7 \u5730\u5740\u89c4\u8303\u5316');

check('\u4e0d\u5e26\u534f\u8bae\u65f6\u9ed8\u8ba4\u8865 http://', () => {
  eq(codesync.normalizeBaseUrl('192.168.3.13:17890'), 'http://192.168.3.13:17890');
});

check('\u5df2\u5e26 http / https \u65f6\u4fdd\u6301\u539f\u6837', () => {
  eq(codesync.normalizeBaseUrl('http://192.168.3.13:17890'), 'http://192.168.3.13:17890');
  eq(codesync.normalizeBaseUrl('https://canvas.example'), 'https://canvas.example');
});

check('\u5c3e\u90e8\u659c\u6760\u4e0e\u67e5\u8be2\u4e32 / \u951a\u70b9\u88ab\u5254\u6389', () => {
  eq(codesync.normalizeBaseUrl('http://a:1///?x=1#y'), 'http://a:1');
});

check('file:// / ftp:// \u4e00\u5f8b\u62d2\u7edd', () => {
  let bad = 0;
  for (const one of ['file:///C:/', 'ftp://a/b']) {
    try {
      codesync.normalizeBaseUrl(one);
    } catch {
      bad += 1;
    }
  }
  eq(bad, 2, '\u975e http \u534f\u8bae\u5c45\u7136\u88ab\u63a5\u53d7');
});

check('\u7a7a\u5730\u5740\u62a5\u9519\u4e14\u63d0\u793a\u600e\u4e48\u586b', () => {
  let message = '';
  try {
    codesync.normalizeBaseUrl('   ');
  } catch (error) {
    message = error.message;
  }
  assert(message.indexOf('http://') >= 0, '\u62a5\u9519\u91cc\u6ca1\u7ed9\u4f8b\u5b50');
});

console.log('\nC5 \u00b7 manifest \u5f62\u72b6');

check('manifest \u5e26 count / totalBytes / digest\uff0c\u4e14\u4e0e\u6587\u4ef6\u6570\u5bf9\u5f97\u4e0a', () => {
  const out = codesync.manifest();
  eq(out.ok, true);
  eq(out.count, out.files.length);
  assert(out.digest && out.digest.length === 16, 'digest \u957f\u5ea6\u4e0d\u5bf9');
  assert(out.totalBytes > 0, '\u603b\u5b57\u8282\u6570\u4e0d\u5bf9');
  eq(out.root, ROOT, '\u58f0\u660e\u7684\u6839\u76ee\u5f55\u4e0d\u5bf9');
});

check('digest \u968f\u6587\u4ef6\u6e05\u5355\u53d8\u5316\u800c\u53d8', () => {
  const a = codesync.digestOf([{ path: 'a.js', size: 1, mtime: 1 }]);
  const b = codesync.digestOf([{ path: 'a.js', size: 2, mtime: 1 }]);
  assert(a !== b, '\u4e0d\u540c\u6e05\u5355\u7b97\u51fa\u4e86\u540c\u4e00\u4e2a digest');
});

console.log('\nC6 · 拉取落盘（真起一个假主机，只服务一个探针文件）');

const http = require('node:http');
const REL = 'tools/__csync_probe__.txt';
const ABS = path.join(ROOT, 'tools', '__csync_probe__.txt');
const BODY = Buffer.from('探针：拉取写盘验证\n', 'utf8');

function withStub(fn) {
  return new Promise((resolve, reject) => {
    const stub = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/codesync/manifest') {
        const list = codesync
          .listLocalFiles()
          .filter((one) => one.path !== REL)
          .concat([{ path: REL, size: BODY.length, mtime: 1700000000000 }]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, host: 'STUB', count: list.length, digest: 'stub', files: list }));
        return;
      }
      if (url.pathname === '/api/codesync/file' && url.searchParams.get('path') === REL) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': BODY.length });
        res.end(BODY);
        return;
      }
      res.writeHead(403);
      res.end('{}');
    });
    stub.listen(0, '127.0.0.1', () => {
      fn('127.0.0.1:' + stub.address().port)
        .then((out) => { stub.close(); resolve(out); })
        .catch((error) => { stub.close(); reject(error); });
    });
  });
}

(async () => {
  let report = null;
  let planAgain = null;
  try {
    await withStub(async (host) => {
      report = await codesync.pull(host);
      planAgain = await codesync.plan(host);
    });
  } catch (error) {
    check('拉取过程不报错', () => { throw error; });
  }

  check('拉取一个新文件：算为 added，不算 failed', () => {
    assert(report, '没拿到拉取结果');
    eq(report.added.length, 1, '新增数不对：' + JSON.stringify(report.failed));
    eq(report.added[0], REL);
    eq(report.failed.length, 0, '拉取失败：' + JSON.stringify(report.failed));
  });

  check('文件内容与对方一致', () => {
    assert(fs.existsSync(ABS), '文件没写进来');
    eq(fs.readFileSync(ABS, 'utf8'), BODY.toString('utf8'));
  });

  check('拉取后 mtime 也跟着过来（否则每次对比都全量需要更新）', () => {
    const st = fs.statSync(ABS);
    eq(Math.round(st.mtimeMs), 1700000000000);
  });

  check('拉完再对比应该是「一致」，不会反复重下', () => {
    assert(planAgain, '没拿到第二次对比结果');
    eq(planAgain.add.length, 0);
    eq(planAgain.update.length, 0, '拉完又被判成需要更新，会反复全量下载');
    eq(planAgain.same, planAgain.local.count);
  });

  try {
    if (fs.existsSync(ABS)) fs.unlinkSync(ABS);
    if (report && report.backupDir && fs.existsSync(report.backupDir)) {
      fs.rmSync(report.backupDir, { recursive: true, force: true });
    }
  } catch { /* 清理失败不影响结论 */ }

  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
