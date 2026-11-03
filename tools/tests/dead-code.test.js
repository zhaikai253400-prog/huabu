'use strict';

// 选择器孤儿体检（清单 〇「死代码链」收尾后新加）。
//
// 为什么要有这个测试：
//   提示词大编辑窗那簇死代码，31 个测试文件一个都没抓到 —— 因为它的特征是
//   **代码能跑、测试全绿、只是永远不生效**。删掉它的时候又顺藤摸出两类同类残留：
//     · .prompt-tail-slot   —— 唯一产出处是被删掉的那段 HTML 模板，选择器成了孤儿；
//     · .schedule-tile      —— 早年的旧类名（现在是 .schedule-member），
//                              连带一段读 dataset.member 的 forEach 一起空转。
//   两者都不报错、不影响任何行为，只在暗处骗下一个读代码的人「这个元素存在」。
//   所以这里把它固化成常驻检查：canvas.js 里被查询的类名，全项目必须有地方产出。
//
// 判据只有一个（可证、不靠猜）：
//   「查询得到、但零处产出」的选择器 → 匹配集恒为空 → 它包住的那段代码等价于死代码。
//
// 运行：runtime/node.exe tools/tests/dead-code.test.js

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = path.join(ROOT, 'web');

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

function readOr(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
function frontendFiles(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) frontendFiles(p, out);
    else if (/\.(js|html)$/.test(name)) out.push(p);
  }
  return out;
}

// 剔掉整行注释再扫查询，否则「这里原本有 querySelector('.x')」这种说明性注释
// 会被当成真的查询。
function stripComments(src) {
  return src
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
      return line;
    })
    .join('\n');
}

const canvasRaw = readOr(path.join(WEB, 'assets', 'canvas.js'));
const canvasCode = stripComments(canvasRaw);
const css = readOr(path.join(WEB, 'assets', 'style.css'));
const allFiles = frontendFiles(WEB, []);

// 收集「产出的类名」。
// 覆盖四种写法 —— 少一种就会误报成孤儿，所以这里宁可多写：
//   className = 'a b c'              （普通 DOM）
//   class="a b"                      （HTML 模板字符串 / html 文件）
//   class=\"a b\"                    （同上，但写在双引号串里要转义）
//   setAttribute('class', 'a b')     （SVG 元素走这条，不是 className）
//   classList.add/toggle/remove('a') （可能带第二参数）
function collectProduced() {
  const produced = new Set();
  const tokenize = (v) => v.split(/\s+/).filter(Boolean);
  const RE_CLASSNAME = /className\s*=\s*(['"])([^'"]*)\1/g;
  const RE_CLASSATTR_ESC = /class\s*=\s*\\(['"])([^'"]*)\1/g;
  const RE_CLASSATTR = /class\s*=\s*(['"])([^'"]*)\1/g;
  const RE_SETATTR = /setAttribute\(\s*(['"])class\1\s*,\s*(['"])([^'"]*)\2/g;
  const RE_CLASSLIST = /classList\s*\.\s*(?:add|toggle|remove)\(([^)]*)\)/g;

  for (const file of allFiles) {
    const src = readOr(file);
    let m;
    RE_CLASSNAME.lastIndex = 0;
    while ((m = RE_CLASSNAME.exec(src))) tokenize(m[2]).forEach((t) => produced.add(t));
    RE_CLASSATTR_ESC.lastIndex = 0;
    while ((m = RE_CLASSATTR_ESC.exec(src))) tokenize(m[2]).forEach((t) => produced.add(t));
    RE_CLASSATTR.lastIndex = 0;
    while ((m = RE_CLASSATTR.exec(src))) tokenize(m[2]).forEach((t) => produced.add(t));
    RE_SETATTR.lastIndex = 0;
    while ((m = RE_SETATTR.exec(src))) tokenize(m[3]).forEach((t) => produced.add(t));
    RE_CLASSLIST.lastIndex = 0;
    while ((m = RE_CLASSLIST.exec(src))) {
      (m[1].match(/(['"])([^'"]*)\1/g) || [])
        .forEach((a) => tokenize(a.slice(1, -1)).forEach((t) => produced.add(t)));
    }
  }
  return produced;
}

// 收集「查询的类名」：closest / querySelector / querySelectorAll / matches
function collectQueried() {
  const queried = new Map(); // token -> [行号]
  const RE = /(?:closest|querySelector|querySelectorAll|matches)\(\s*(['"])([^'"]+)\1/g;
  canvasCode.split('\n').forEach((line, i) => {
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(line))) {
      (m[2].match(/\.[A-Za-z_][\w-]*/g) || []).forEach((sel) => {
        const cls = sel.slice(1);
        if (!queried.has(cls)) queried.set(cls, []);
        queried.get(cls).push(i + 1);
      });
    }
  });
  return queried;
}

// 允许「被查询但代码里查不到产出」的白名单。
// 加进来必须写清原因 —— 每一条都是一次「我确认过了」的签字。
// 典型正当理由：类名是运行时拼出来的（'is-' + kind），静态扫不到。
const ALLOWED = new Set([]);

// 从查询源码里挑出「没人产出」的那些。抽成函数，是为了让下面那条
// 注入检验能拿**同一套判据**去跑一份合成源码 —— 判据本身必须被验过。
function findOrphans(code, producedSet, allowSet) {
  const RE = /(?:closest|querySelector|querySelectorAll|matches)\(\s*(['"])([^'"]+)\1/g;
  const orphans = [];
  code.split('\n').forEach((line, i) => {
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(line))) {
      (m[2].match(/\.[A-Za-z_][\w-]*/g) || []).forEach((sel) => {
        const cls = sel.slice(1);
        if (producedSet.has(cls) || allowSet.has(cls)) return;
        orphans.push({ cls: cls, line: i + 1 });
      });
    }
  });
  return orphans;
}

console.log('\n〇 · 选择器孤儿体检（canvas.js 查询的类名必须有处产出）');

const produced = collectProduced();
const queried = collectQueried();

check('扫描器确实扫到了东西（产物与查询都非空，否则检查等于空跑）', () => {
  assert(produced.size > 100, '产出词表只有 ' + produced.size + ' 个，扫描器大概坏了');
  assert(queried.size > 30, '查询词表只有 ' + queried.size + ' 个，正则大概失配了');
});

check('判据本身是有效的：往合成源码里注入一个假查询，必须被抓出来', () => {
  // 变异检验。如果 findOrphans 写错了（比如永远是空数组），上面那条「没有孤儿」
  // 就会毫无意义地全绿 —— 全绿有两种可能：真干净，或者根本没在查。
  const injected = "el.querySelectorAll('.this-class-is-never-produced-anywhere');";
  const caught = findOrphans(injected, produced, ALLOWED);
  assert(caught.length === 1, '注入的假孤儿没被抓到（抓到 ' + caught.length + ' 个），判据失效');
  assert(caught[0].cls === 'this-class-is-never-produced-anywhere', '抓错了对象：' + caught[0].cls);
  // 反过来：真产出的类名不该被误判成孤儿
  assert(findOrphans("el.closest('.node-prompt');", produced, ALLOWED).length === 0,
    '.node-prompt 是真实在用的类名，不该被误判成孤儿');
});

check('没有「查得到、零处产出」的孤儿选择器（零匹配 = 那段代码恒空转）', () => {
  const orphans = findOrphans(canvasCode, produced, ALLOWED);
  assert(orphans.length === 0,
    '这些选择器永远匹配不到，包住的代码等价于死代码：' +
      orphans.map((o) => '.' + o.cls + '（第 ' + o.line + ' 行）').join('；'));
});

check('已清理的两簇不再回来（回归护栏）', () => {
  // 这两族当初都是「零产出却还被查询/写样式」，专门盯住它们
  ['.prompt-tail-slot', '.schedule-tile', '.schedule-tile-no', '.schedule-grid'].forEach((sel) => {
    assert(canvasCode.indexOf(sel) < 0, 'canvas.js 里又出现了查询 ' + sel);
    assert(css.indexOf(sel) < 0, 'style.css 里还留着 .' + sel.slice(1) + ' 的样式');
  });
});

check('提示词大编辑窗那簇死代码没有复活', () => {
  [
    'promptEditorEl', 'promptEditorBox', 'promptEditorNode', 'promptEditorRefsEl',
    'promptEditorParamsEl', 'promptEditorTailEl', 'syncPromptEditorRefs',
    'syncPromptEditorParams', 'syncPromptEditorTail', 'paintPromptEditorTail', 'tailSignature',
    'PROMPT_POS_KEY', 'readPromptEditorPos', 'placePromptEditor', 'setupPromptEditorDrag',
  ].forEach((name) => {
    assert(canvasCode.indexOf(name) < 0, 'canvas.js 里又出现了 ' + name);
  });
  ['.prompt-mask', '.prompt-modal', '.prompt-body', '.prompt-editor', '.prompt-refs', '.prompt-params'].forEach((sel) => {
    assert(css.indexOf(sel) < 0, 'style.css 里又出现了 ' + sel);
  });
});

console.log('');
console.log('────────────────────────────────────────────────────');
console.log((fail ? '（有失败）' : '全部通过：') + (fail ? '' : pass + ' 项'));
console.log('────────────────────────────────────────────────────');
process.exit(fail ? 1 : 0);
