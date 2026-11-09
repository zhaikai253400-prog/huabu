'use strict';

// P2 的永久护栏：静态服务不许把"备份 / 临时 / 密钥类"文件发出去。
//
// 背景（实测）：web/assets 下曾躺着三个源码备份
//   canvas.js.bak-defaultresize-20261105-resize（633 KB）
//   style.css.bak-defaultresize-20261105-resize（153 KB）
//   canvas.html.bak-defaultresize-20261105-resize（20 KB）
// 静态服务原本只挡越界路径、**不认后缀**，所以浏览器直接访问这些路径
// 就能下载到旧源码（实测 HTTP 200）。
//
// 现在：serveStatic / serveHtmlWithTokens 都会按后缀挡掉，并返回 404。
// 这里守两件事：
//   ① 闸门还在（后缀表 + 两处都调用了）
//   ② web/ 目录里**不再有** .bak 残留（防止又攒起来）

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const rel = (f) => path.join(ROOT, f);

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
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

const idx = fs.readFileSync(rel('server/index.js'), 'utf8');

console.log('\nA2 · 静态服务不放行备份 / 临时 / 密钥类文件');

check('定义了后缀黑名单，且覆盖 bak / tmp / key / db 等', () => {
  const m = /const STATIC_DENY_SUFFIX = (\/.*\/[a-z]*);/.exec(idx);
  assert(m, '没找到 STATIC_DENY_SUFFIX 定义');
  ['bak', 'tmp', 'orig', 'old', 'key', 'db'].forEach((suffix) => {
    assert(m[1].indexOf(suffix) >= 0, '后缀表里没有 ' + suffix);
  });
});

check('**serveStatic 里真的用了这道闸**', () => {
  const fn = /function serveStatic\(res, filePath\) \{[\s\S]*?\n\}/.exec(idx);
  assert(fn, '抽不出 serveStatic');
  assert(/STATIC_DENY_SUFFIX\.test\(/.test(fn[0]),
    'serveStatic 没有检查后缀 —— .bak 又会被发出去');
  // 必须放在"读文件"之前
  const testAt = fn[0].indexOf('STATIC_DENY_SUFFIX.test');
  const readAt = fn[0].indexOf('createReadStream');
  assert(testAt >= 0 && readAt > testAt, '后缀检查排在发送之后 —— 等于没挡');
});

check('serveHtmlWithTokens 里也用了（页面那条路）', () => {
  const fn = /function serveHtmlWithTokens\([^)]*\) \{[\s\S]*?\n\}/.exec(idx);
  assert(fn, '抽不出 serveHtmlWithTokens');
  assert(/STATIC_DENY_SUFFIX\.test\(/.test(fn[0]),
    'serveHtmlWithTokens 没有检查后缀 —— canvas.html.bak-* 这类仍可下载');
});

check('**web/ 目录里不再有 .bak 残留**', () => {
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.bak/i.test(e.name)) found.push(path.relative(ROOT, p).replace(/\\/g, '/'));
    }
  }(rel('web')));
  assert(found.length === 0,
    'web/ 里又有源码备份了（它们会被静态服务当作普通资源）：' + found.join(', '));
});

check('路径穿越防护没有被削弱', () => {
  // 越界检查必须仍在后缀检查之前（先判目录，再判后缀）
  const fn = /function serveStatic\(res, filePath\) \{[\s\S]*?\n\}/.exec(idx);
  assert(fn, '抽不出 serveStatic');
  const insideAt = fn[0].indexOf('guard.isInsideDir');
  const denyAt = fn[0].indexOf('STATIC_DENY_SUFFIX.test');
  assert(insideAt >= 0, 'serveStatic 没有 isInsideDir 越界检查');
  assert(denyAt > insideAt, '后缀检查排在了越界检查之前 —— 顺序反了');
});

console.log('');
console.log('─'.repeat(52));
if (fail) { console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项'); process.exit(1); }
console.log('通过 ' + pass + ' 项，失败 0 项');
