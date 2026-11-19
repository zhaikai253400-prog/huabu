'use strict';

// 门户「我的画布」卡片上的操作按钮排版。
//
// 用户报的问题：7 个按钮平铺一行，卡最窄 250px，每个只剩 34px，
// 中文被压成一字一行（72px 高），有的甚至看不见。
//
// 这个文件守三件事：
//   A. 改成网格 + 不许折行（white-space: nowrap 是根因修复）
//   B. 「打开画布」独占整行，其余三列
//   C. 长标签已简化，且每颗按钮都有 tooltip 说清完整含义
//
// 运行：runtime/node.exe tools/tests/portal-actions.test.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORTAL = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'portal.js'), 'utf8');
const CSS_RAW = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'style.css'), 'utf8');
// 注释里会提到旧写法，不能拿来断言：先剥注释
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');

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

// 取某个选择器的声明块
function ruleBody(selector) {
  const at = CSS.indexOf(selector + ' {');
  if (at < 0) return '';
  const start = CSS.indexOf('{', at) + 1;
  const end = CSS.indexOf('}', start);
  return CSS.slice(start, end);
}

console.log('\nA. 根因：不许折行 + 不再用 flex 平铺');

check('按钮禁止折行（这是中文竖排的根因）', () => {
  const body = ruleBody('.canvas-actions button');
  assert(/white-space:\s*nowrap/.test(body), '没有 white-space: nowrap，中文还会竖过来');
});

check('挤不下时用省略号，而不是把字压成两行', () => {
  const body = ruleBody('.canvas-actions button');
  assert(/text-overflow:\s*ellipsis/.test(body), '没有省略号兜底');
  assert(/overflow:\s*hidden/.test(body), '没有 overflow: hidden，省略号不会生效');
});

check('不再用 flex 一行平铺（7 个按钮平铺就是原来翻车的原因）', () => {
  const body = ruleBody('.canvas-actions');
  assert(body.length > 0, '找不到 .canvas-actions 规则');
  assert(!/display:\s*flex/.test(body), '还在用 flex 平铺');
  assert(/display:\s*grid/.test(body), '没用网格');
});

console.log('\nB. 布局：打开占整行，其余三列');

check('网格是三列', () => {
  const body = ruleBody('.canvas-actions');
  assert(/grid-template-columns:\s*repeat\(3/.test(body), '不是三列');
});

check('主按钮独占整行（grid-column: 1 / -1）', () => {
  const body = ruleBody('.canvas-actions button.wide');
  assert(/grid-column:\s*1\s*\/\s*-1/.test(body), '主按钮没占整行');
});

check('主按钮视觉上更重（加粗 + 强调色）', () => {
  const body = ruleBody('.canvas-actions button.wide');
  assert(/font-weight:\s*600/.test(body), '主按钮没加粗');
  assert(PORTAL.indexOf("makeButton('打开画布', 'primary wide'") > 0, '打开按钮没用 primary wide 类');
});

console.log('\nC. 文案：长标签已简化，且都有 tooltip');

check('长标签缩成两字（复制一份→复制、导出备份→导出、历史版本→历史）', () => {
  assert(PORTAL.indexOf("makeButton('复制'") > 0, '没有「复制」');
  assert(PORTAL.indexOf("makeButton('导出'") > 0, '没有「导出」');
  assert(PORTAL.indexOf("makeButton('历史'") > 0, '没有「历史」');
  // 只看按钮标签：提示文案（tooltip）和弹窗里说全名是对的，不该被这条挡住
  for (const longLabel of ['复制一份', '导出备份', '历史版本']) {
    assert(PORTAL.indexOf("makeButton('" + longLabel + "'") < 0, '按钮标签还是长的：「' + longLabel + '」');
  }
});

check('共享开着时显示「已共享」，不再用 4 个字的「关闭共享」', () => {
  assert(/canvas\.shared \? '已共享' : '共享'/.test(PORTAL), '共享按钮文案不对');
  // 弹窗里说「关闭共享失败」是给人看的完整说明，这里只禁按钮标签
  assert(PORTAL.indexOf("makeButton('关闭共享'") < 0, '按钮标签还留着「关闭共享」');
});

check('共享开着时有明确的已启用态（描边变强调色）', () => {
  assert(/shared-on/.test(PORTAL), '按钮没加 shared-on 类');
  const body = ruleBody('.canvas-actions button.shared-on');
  assert(/var\(--accent\)/.test(body), '已共享态没上强调色');
});

check('makeButton 支持 tooltip，且每颗按钮都传了', () => {
  assert(/const makeButton = \(label, className, handler, hint\)/.test(PORTAL), 'makeButton 没有 hint 参数');
  assert(/if \(hint\) button\.title = hint;/.test(PORTAL), '没把 hint 写到 title 上');
  const labels = ['打开画布', '重命名', '复制', '导出', '历史', '删除'];
  for (const label of labels) {
    const re = new RegExp("makeButton\\('" + label + "'[^\\n]*'[^']*'");
    assert(re.test(PORTAL), '「' + label + '」没有 tooltip');
  }
});

check('按钮之间不再有 7 个都挤在一行的情况（结构上只有 1 个 wide）', () => {
  const wide = PORTAL.match(/makeButton\([^)]*'[^']*wide/g) || [];
  assert(wide.length === 1, 'wide 按钮应该正好 1 个，现在是 ' + wide.length);
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
