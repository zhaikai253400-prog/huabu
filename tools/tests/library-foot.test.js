'use strict';

// 素材库底部操作栏：按钮不许再被挤成竖排，且必须能收起。
//
// 起因：底部 6 个按钮原来挤在 400px 宽的抽屉里，中文标签被压成一字一行，
// 整条栏又高又乱。现在改成「三列网格 + 可收起」。
//
// 运行：runtime/node.exe tools/tests/library-foot.test.js

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const libSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'library.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'style.css'), 'utf8');

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

// 只取真正生效的 CSS（去掉注释），否则说明文字里的例子会把断言带偏
const css = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(selector) {
  const at = css.indexOf(selector + ' {');
  if (at < 0) return '';
  const start = css.indexOf('{', at) + 1;
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

console.log('\nA. 按钮不再被挤成竖排');

check('底部按钮用的是三列网格，不是会折行的 flex', () => {
  const body = ruleBody('.lib-foot-actions');
  assert(body, '找不到 .lib-foot-actions 规则');
  assert(/display:\s*grid/.test(body), '必须是 grid —— flex 会在 400px 里换行把中文压成竖排');
  assert(/grid-template-columns/.test(body), '要显式声明列，否则 auto-fit 仍可能换行');
});

check('按钮标签禁止换行并带省略号兜底', () => {
  const body = ruleBody('.lib-act');
  assert(/white-space:\s*nowrap/.test(body), '按钮文字必须 nowrap，一旦能换行就会变竖排');
  assert(/text-overflow:\s*ellipsis/.test(body), '万一真放不下，要省略号而不是硬折行');
});

check('窄屏下会再收一档字号，三个字也放得下', () => {
  assert(/@media\s*\(max-width:\s*480px\)/.test(css), '缺少窄屏媒体查询');
  const seg = css.slice(css.indexOf('@media (max-width: 480px)'));
  assert(/\.lib-act\s*\{[^}]*font-size/.test(seg), '窄屏里没有收字号');
});

console.log('\nB. 能收起来，且记住用户的选择');

check('底部栏有收起按钮，也有展开入口', () => {
  assert(libSrc.indexOf('id="lib-foot-min"') >= 0, '缺少收起按钮');
  assert(libSrc.indexOf('id="lib-foot-restore"') >= 0, '缺少展开按钮');
});

check('收起状态存进 localStorage，不是刷新就丢', () => {
  assert(/canvas\.lib-foot-collapsed/.test(libSrc), '没有持久化的 key');
  assert(/localStorage\.setItem\(FOOT_KEY/.test(libSrc), '没有写入');
  assert(/localStorage\.getItem\(FOOT_KEY\)/.test(libSrc), '没有读取');
});

check('收起后操作区真的不占位（否则等于没收）', () => {
  const body = ruleBody('.lib-foot.collapsed');
  assert(/display:\s*none/.test(body), '收起时必须 display:none，只改 padding 还会占着高度');
});

check('展开按钮默认隐藏，收起后才出现', () => {
  const body = ruleBody('.lib-foot-restore');
  assert(/display:\s*none/.test(body), '默认应隐藏');
  assert(/\.lib-foot-restore\.show\s*\{[^}]*display:\s*block/.test(css), '缺少 .show 时显示的规则');
});

console.log('\nC. 抽屉和门户弹窗都撑满高度（否则底部栏悬在半空）');

check('抽屉里的面板和列表都参与 flex 撑高', () => {
  assert(/\.library-drawer \.drawer-body\s*\{[^}]*display:\s*flex/.test(css), '抽屉正文没有改成 flex 列');
  assert(/\.library-drawer \.lib-grid\s*\{[^}]*flex:/.test(css), '抽屉里的列表没有设置 flex 伸缩');
});

check('门户弹窗同理，且不会出现两层滚动条', () => {
  assert(/\.modal-library \.modal-body\s*\{[^}]*overflow:\s*hidden/.test(css), 'modal-body 必须 overflow:hidden，滚动交给列表');
  assert(/\.modal-library \.lib-grid\s*\{[^}]*flex:/.test(css), '弹窗里的列表没有设置 flex');
});

check('删除按钮只在有选中时才标红', () => {
  assert(/\.lib-act-danger:not\(:disabled\)/.test(css), '红色必须挂在 :not(:disabled) 上，否则空选时也一片红');
});

console.log('\nD. 原有行为没被改坏');

check('六个操作按钮都还在，id 一个没少', () => {
  for (const id of ['lib-all', 'lib-invert', 'lib-clear', 'lib-recycle', 'lib-orphan', 'lib-delete']) {
    assert(libSrc.indexOf('id="' + id + '"') >= 0, '缺少按钮 ' + id);
  }
});

check('事件绑定齐全', () => {
  for (const id of ['lib-all', 'lib-invert', 'lib-clear', 'lib-delete', 'lib-orphan', 'lib-recycle']) {
    assert(libSrc.indexOf("host.querySelector('#" + id + "').addEventListener") >= 0, id + ' 没有绑定点击事件');
  }
});

check('全选 / 反选 / 清空仍然只作用于当前筛选结果', () => {
  const fn = libSrc.slice(libSrc.indexOf('function selectAllVisible'), libSrc.indexOf('function clearSelection'));
  assert(/state\.items\.forEach/.test(fn), '全选必须只遍历当前筛选出来的 state.items');
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
