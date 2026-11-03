'use strict';

// 「隐藏开关」护栏。守的是一个**踩了 6 次**的坑。
//
// 背景（一次真实的 BUG）：
//   画布中央那句「这块画布还是空的」在有卡片时仍然挂着。查下来 JS 没问题 ——
//   refreshBoardEmpty() 一直在跑、hidden 属性也确实挂上了，但界面纹丝不动。
//   原因是 CSS 级联里一条容易被忽略的规则：
//       .board-empty { display: grid; }        ← 作者级样式
//       [hidden]     { display: none; }        ← 浏览器 **UA 级**样式，优先级最低
//   作者级压过 UA 级，于是 hidden 属性被架空，「隐藏」这两个字名存实亡。
//
//   更值得注意的是：这不是孤例。翻 style.css 发现作者已经**单点补过 5 次**
//   （.canvas-title-btn、.version-strip、.batch-btn… 每中一次就在出事的地方
//   补一条 xxx[hidden] { display: none }），而 .board-empty 恰好漏补 —— 于是
//   补到最后仍是「漏一个、爆一个」。根子在于：UA 样式天生压不过作者样式，
//   却没人把这个事实写进代码。
//
// 治理：在 style.css 里立一条全局规则
//       [hidden] { display: none !important; }
//   同时把 13 处单点补丁（5 处 xxx[hidden] + 8 处 xxx.hidden）一并删掉 ——
//   它们全被这条全局规则覆盖，留着只会让人误以为「hidden 在某些元素上不管用」。
//
// 本测试守四件事：
//   一、全局开关在位，且是 !important（这是唯一让 hidden 属性真正生效的写法）；
//   二、单点补丁没有复活（一旦有人再贴一张，这里立刻报警）；
//   三、这条全局规则不是摆设 —— 确实存在「自带 display 又用 hidden」的元素，
//        少了它就会重现 BUG（若集合为空，说明测试已经空跑，同样报警）；
//   四、那个具体 BUG 的现场不会复发。
//
// 运行：runtime/node.exe tools/tests/hidden-rule.test.js

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

// ---------------------------------------------------------------- CSS 解析
// 只需要两样东西：规则的选择器、规则里有没有写 display。所以不引解析器，
// 手写一个够用的小扫描（要能穿 @media 一层，Properties 里就是这种嵌套）。
function parseRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, ''); // 先去掉注释，否则注释里的花括号会打乱配对
  const out = [];

  function readBlock(start) {
    let depth = 1;
    let j = start;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') depth -= 1;
      j += 1;
    }
    return { end: j, body: src.slice(start, j - 1) };
  }

  function walk(text, media) {
    let i = 0;
    while (i < text.length) {
      const braceAt = text.indexOf('{', i);
      if (braceAt < 0) break;
      const selector = text.slice(i, braceAt).trim();
      const blk = readBlock(braceAt + 1);
      i = blk.end;
      if (selector.startsWith('@media') || selector.startsWith('@supports')) {
        walk(blk.body, selector); // 块里还是规则，进去接着扫
      } else if (!selector.startsWith('@')) {
        out.push({ selector: selector, body: blk.body, media: media || '' });
      }
      // @keyframes / @font-face 里的花括号不是选择器，跳过
    }
  }
  walk(src, '');
  return out;
}

// 取规则里 display 的声明值（含 !important），没有则返回 null
function displayDecl(body) {
  const m = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(body);
  return m ? m[1].trim() : null;
}
function isImportant(v) {
  return /\s*!important\s*$/.test(v);
}

// 从一条选择器里抽类名（只要 .foo 形式，不区分复合选择器）
function classesIn(selector) {
  return (selector.match(/\.[A-Za-z_][\w-]*/g) || []).map((s) => s.slice(1));
}

const css = readOr(path.join(WEB, 'assets', 'style.css'));
const rules = parseRules(css);

// ---------------------------------------------------------------- 一、全局开关
console.log('\n一 · 全局隐藏开关必须在位');

// 裸 [hidden] 规则：选择器就是 "[hidden]"（不带任何前缀）
const bareAttrRules = rules.filter((r) => r.selector.trim() === '[hidden]');
const bareClassRules = rules.filter((r) => r.selector.trim() === '.hidden');

check('存在全局 [hidden] 规则（hidden 属性的总开关）', () => {
  assert(bareAttrRules.length === 1,
    '期望恰好 1 条裸 [hidden] 规则，实际 ' + bareAttrRules.length + ' 条');
});

check('[hidden] 规则是 display:none 且带 !important（不带 !important 就压不过元素自带的 display）', () => {
  assert(bareAttrRules.length === 1, '先要有且只有一条裸 [hidden] 规则（见上一条）');
  const d = displayDecl(bareAttrRules[0].body);
  assert(d && d.startsWith('none'), 'display 声明是：' + d);
  assert(isImportant(d), '缺少 !important —— 这正是本 BUG 的成因，见文件头注释');
});

check('存在全局 .hidden 规则且同为 !important', () => {
  assert(bareClassRules.length === 1,
    '期望恰好 1 条裸 .hidden 规则，实际 ' + bareClassRules.length + ' 条');
  const d = displayDecl(bareClassRules[0].body);
  assert(d && d.startsWith('none') && isImportant(d), '.hidden 的声明是：' + d);
});

// ---------------------------------------------------------------- 二、补丁不许复活
console.log('');
console.log('二 · 单点补丁没有复活（补了 6 次的那个坑，别再贴第 7 张）');

// 「单点补丁」= 选择器里带 [hidden] 的规则，但不止裸 [hidden]
const attrPatches = rules.filter((r) => r.selector.includes('[hidden]') && r.selector.trim() !== '[hidden]');
// 「.X.hidden 单点补丁」= 选择器形如 .foo.hidden（单一类 + .hidden）
const classPatches = rules.filter((r) => /^\.[A-Za-z_][\w-]*\.hidden$/.test(r.selector.trim()));

check('没有 xxx[hidden] 形式的单点补丁（全局规则已覆盖它们）', () => {
  assert(attrPatches.length === 0,
    '又出现了单点补丁：' + attrPatches.map((r) => r.selector).join('；') +
      '（它们已被全局 [hidden] 覆盖，属于冗余；若真有特殊需要，请在此测试里写清理由）');
});

check('没有 .foo.hidden 形式的单点补丁', () => {
  assert(classPatches.length === 0,
    '又出现了单点补丁：' + classPatches.map((r) => r.selector).join('；'));
});

// ---------------------------------------------------------------- 三、全局规则确实是必要的
console.log('');
console.log('三 · 这条全局规则不是摆设（有真实元素靠它才藏得住）');

// 这里的关键是**别只看选择器的右端**。
// 踩过的坑：`.rail-tip span { display: block }` 是个后代选择器，只比右端 "span" 的话
// 会把页面上所有 <span> 都算成「自带 display」——包括根本不在 .rail-tip 里的
// #filter-badge。那就是测试在说谎，比测不出来更糟。
// 所以这一节自带一个极小的 HTML 解析器，把祖先链也建出来，做完整的后代匹配。

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// 只解析「元素 + 类名 + 祖先链」，够这一节用。
// 不追求通用：注释整段剔除，属性只认 class，`/>` 与 void 标签不入栈。
function parseHtml(src) {
  const text = src.replace(/<!--[\s\S]*?-->/g, '');
  const els = [];
  const stack = [];
  const RE = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = RE.exec(text))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    const selfClosed = m[4] === '/' || VOID_TAGS.has(tag);
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
      continue;
    }
    const c = /class\s*=\s*"([^"]*)"|class\s*=\s*'([^']*)'/.exec(attrs);
    const classes = (c ? (c[1] || c[2]) : '').split(/\s+/).filter(Boolean);
    const el = {
      tagName: tag,
      classes: classes,
      attrs: attrs,
      raw: m[0].slice(0, 70),
      ancestors: stack.map((s) => ({ tagName: s.tagName, classes: s.classes })),
    };
    els.push(el);
    if (!selfClosed) stack.push({ tagName: tag, classes: classes });
  }
  return els;
}

// 把选择器分支拆成若干复合体（按空白），顺带去掉伪类/属性选择器。
// > + ~ 一律按「后代」近似处理 —— 比真实约束略宽，但足以挡住上面那种误报，
// 因为这个测试要证明的是「这条全局规则有必要」，宽松命中若还能抓出真实依赖，
// 结论反而更稳。
function compoundsOf(branch) {
  return branch
    .trim()
    .split(/\s+/)
    .map((tok) => tok.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, ''))
    .filter(Boolean)
    .map((tok) => ({
      tag: (/^[a-zA-Z][\w-]*/.exec(tok) || [null])[0],
      classes: (tok.match(/\.[A-Za-z_][\w-]*/g) || []).map((s) => s.slice(1)),
    }));
}

function compoundMatches(comp, node) {
  if (comp.tag && comp.tag.toLowerCase() !== node.tagName) return false;
  return comp.classes.every((c) => node.classes.indexOf(c) >= 0);
}

// 完整匹配：右端复合体打中元素本身，其余复合体要能在祖先链里按序找到。
function selectorMatches(selector, el) {
  return selector.split(',').some((branch) => {
    const comps = compoundsOf(branch);
    if (!comps.length) return false;
    const last = comps[comps.length - 1];
    if (!compoundMatches(last, el)) return false;
    let idx = el.ancestors.length - 1;
    for (let i = comps.length - 2; i >= 0; i -= 1) {
      let found = false;
      while (idx >= 0) {
        if (compoundMatches(comps[i], el.ancestors[idx])) { found = true; idx -= 1; break; }
        idx -= 1;
      }
      if (!found) return false;
    }
    return true;
  });
}

// 写了「非 none」display 的规则 —— 这些就是会压过 UA [hidden] 的元凶
const displayRules = rules.filter((r) => {
  const d = displayDecl(r.body);
  return d && !d.startsWith('none');
});

const htmlFiles = fs.readdirSync(WEB).filter((n) => n.endsWith('.html'));
let hiddenEls = [];
for (const f of htmlFiles) {
  // 递归进来的是 <template>/内联 SVG，parseHtml 按栈走即可
  hiddenEls = hiddenEls.concat(parseHtml(readOr(path.join(WEB, f))));
}
// 只留带 hidden 属性的（排除 aria-hidden —— 那是无障碍属性，不是显隐开关）
hiddenEls = hiddenEls.filter((el) => /\shidden(?=[\s/>=]|$)/.test(el.attrs));

check('扫到了带 hidden 属性的元素（扫描器没空转）', () => {
  assert(hiddenEls.length > 0, '一个带 hidden 属性的元素都没扫到，解析器大概坏了');
});

const armed = hiddenEls.filter((el) => displayRules.some((r) => selectorMatches(r.selector, el)));

check('确实存在「自带 display 又用 hidden 属性」的元素 —— 证明全局规则是必需的，不是摆设', () => {
  assert(armed.length >= 3,
    '只找到 ' + armed.length + ' 个。若真一个都没有，这条全局规则可以退休；' +
      '但在那之前先确认扫描器没坏（见上一条）。');
  armed.forEach((el) => {
    const by = displayRules.filter((r) => selectorMatches(r.selector, el))
      .map((r) => r.selector).join(' / ');
    console.log('    · ' + el.raw + '   ← ' + by);
  });
});

// 判据自检：确认上面那套匹配真能区分「祖先在不在」，而不是退回只看右端
check('匹配器认得祖先链（.rail-tip span 不该命中不在 .rail-tip 里的 span）', () => {
  const sample = parseHtml(
    '<div class="rail-tip"><span class="inside">x</span></div>' +
    '<button class="rail-btn"><span class="outside">y</span></button>'
  );
  const inside = sample.find((e) => e.classes.indexOf('inside') >= 0);
  const outside = sample.find((e) => e.classes.indexOf('outside') >= 0);
  assert(inside && outside, '样例没解析出来');
  assert(selectorMatches('.rail-tip span', inside) === true, '该命中的没命中');
  assert(selectorMatches('.rail-tip span', outside) === false,
    '不该命中的命中了 —— 匹配器退化成「只看右端」，会误报');
});

// ---------------------------------------------------------------- 四、现场不会复发
console.log('');
console.log('四 · 那个具体 BUG 的现场不会复发');

const canvasHtml = readOr(path.join(WEB, 'canvas.html'));
const canvasJs = readOr(path.join(WEB, 'assets', 'canvas.js'));
// 去掉注释再找，否则说明性注释里的字样会被当成代码
const canvasJsCode = canvasJs
  .split('\n')
  .map((line) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
    return line;
  })
  .join('\n');

check('board-empty 用的是 .hidden 类，不是裸 hidden 属性（当初就是后者失效）', () => {
  assert(/class="board-empty hidden"/.test(canvasHtml),
    'canvas.html 里 #board-empty 的 class 不是 "board-empty hidden"');
  assert(!/class="board-empty"[^>]*\shidden(?=[\s/>=]|$)/.test(canvasHtml),
    'canvas.html 里 #board-empty 又写回了裸 hidden 属性 —— 它自带 display:grid，会失效');
});

check('refreshBoardEmpty 走 classList 而不是 .hidden 属性赋值', () => {
  assert(/refreshBoardEmpty/.test(canvasJsCode), 'canvas.js 里找不到 refreshBoardEmpty');
  assert(!/boardEmptyEl\.hidden\s*=/.test(canvasJsCode),
    'boardEmptyEl.hidden = ... 又回来了 —— 这个元素自带 display:grid，属性写法不生效');
  assert(/boardEmptyEl\.classList\.toggle\(\s*'hidden'/.test(canvasJsCode),
    'refreshBoardEmpty 里没看到 boardEmptyEl.classList.toggle(\'hidden\', ...)');
});

// ---------------------------------------------------------------- 判据自检
console.log('');
console.log('五 · 判据本身经过检验（往合成 CSS 里注入补丁，必须抓到）');

check('注入一条单点补丁，第二部分的判据必须抓到（否则那两条检查等于空跑）', () => {
  const injected = '.some-node[hidden] { display: none; }\n.foo.hidden { display: none; }';
  const injRules = parseRules(injected);
  const injAttr = injRules.filter((r) => r.selector.includes('[hidden]') && r.selector.trim() !== '[hidden]');
  const injClass = injRules.filter((r) => /^\.[A-Za-z_][\w-]*\.hidden$/.test(r.selector.trim()));
  assert(injAttr.length === 1, 'xxx[hidden] 判据失效，抓到 ' + injAttr.length + ' 条');
  assert(injClass.length === 1, '.foo.hidden 判据失效，抓到 ' + injClass.length + ' 条');
});

check('注入一条缺 !important 的全局规则，第一部分必须抓到（判据认得出 !important）', () => {
  const injRules = parseRules('[hidden] { display: none; }');
  const d = displayDecl(injRules[0].body);
  assert(d && !isImportant(d), '没 !important 的 [hidden] 竟然被判成合格，判据失效');
  const okRules = parseRules('[hidden] { display: none !important; }');
  assert(isImportant(displayDecl(okRules[0].body)), '带 !important 的反而被判成不合格，判据失效');
});

console.log('');
console.log('────────────────────────────────────────────────────');
console.log((fail ? '（有失败）' : '全部通过：') + (fail ? '' : pass + ' 项'));
console.log('────────────────────────────────────────────────────');
process.exit(fail ? 1 : 0);
