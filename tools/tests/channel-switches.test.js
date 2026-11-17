'use strict';

// 通道页补入口 + 提示词清洗 + 双 @ 修复
//
// 三件事都有同一个性质：**错了不报错，只是悄悄不生效**。
//   · 通道页少了开关 → 只能在 config.json 手改，改错一个字符就静默不生效；
//   · 提示词带 ```text 围栏 → 原样发给模型，白占 token 还干扰理解；
//   · atPrefix 通道拿到「@@图片1」→ 平台只认单个 @，参考图等于没接上。
// 所以每一条都用「真实输入 → 真实输出」锁死，而不是只看源码里有没有那段字。

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const generate = require(path.join(ROOT, 'server', 'generate.js'));
const frontSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'channels.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (error) { failed += 1; console.log('  ✗ ' + name + ' — ' + error.message); }
}
const eq = (a, b, msg) => assert.strictEqual(a, b, msg || (JSON.stringify(a) + ' !== ' + JSON.stringify(b)));

const two = [{ name: '图42', kind: 'image' }, { name: '图45', kind: 'image' }];
const map = (text, opts) => generate.remapRefNamesInPrompt(text, two, opts);

console.log('\nP1 · 已经带 @ 的名字不再叠成两个 @');

check('atPrefix 通道：@图42 → @图片1（不是 @@图片1）', () => {
  eq(map('@图42 站在门口', { atPrefix: true }), '@图片1 站在门口');
});
check('atPrefix 通道：一句里两个 @ 引用都只有一层 @', () => {
  eq(map('@图42 与 @图45', { atPrefix: true }), '@图片1 与 @图片2');
});
check('不带 atPrefix 的通道：@图42 → 图片1（@ 一并去掉）', () => {
  eq(map('@图42 站在门口', {}), '图片1 站在门口');
});
check('裸写法（不带 @）照旧能换', () => {
  eq(map('图42 和 图45', {}), '图片1 和 图片2');
  eq(map('图42 和 图45', { atPrefix: true }), '@图片1 和 @图片2');
});
check('没带上来的名字不动（图4 不在本次素材里）', () => {
  eq(map('@图4 与 图42', {}), '@图4 与 图片1');
});

console.log('\nP2 · 提示词里的 Markdown 围栏会被去掉');

const clean = (text) => generate.promptForApi(text);

check('```text 开头 + ``` 结尾：两头都去掉，正文一字不动', () => {
  eq(clean('```text\n镜号一｜30秒\n场景：图45\n```'), '镜号一｜30秒\n场景：图45');
});
check('语言标记不是 text 也认（```markdown / ``` 裸围栏）', () => {
  eq(clean('```markdown\n正文\n```'), '正文');
  eq(clean('```\n正文\n```'), '正文');
});
check('只有开头围栏、只有结尾围栏，都能收拾', () => {
  eq(clean('```text\n只有开头'), '只有开头');
  eq(clean('正文\n```'), '正文');
});
check('没有围栏的提示词一个字符都不改', () => {
  const plain = '镜号一｜30秒\n\n场景：荒废祠堂（白天·内）\n人物：图42 是林振南';
  eq(clean(plain), plain);
});
check('正文中间的反引号不当围栏处理', () => {
  const inside = '画面里出现 ` 这个符号，还有 ``` 三个';
  eq(clean(inside), inside);
});
check('去围栏之后 @[图1] 照旧被收拾（两步不打架）', () => {
  eq(clean('```text\n@[图1] 站在门口\n```'), '图1 站在门口');
});
check('围栏前后多出来的空行也一并去掉（连版复制常带进来）', () => {
  eq(clean('\n\n```text\n正文\n```\n\n'), '正文');
});
check('CRLF 换行的围栏同样认', () => {
  eq(clean('```text\r\n正文一\r\n正文二\r\n```'), '正文一\r\n正文二');
});
check('语言标记与反引号之间夹空格也认', () => {
  eq(clean('``` text\n正文\n```'), '正文');
});
check('四个反引号（嵌套代码块）也认', () => {
  eq(clean('````md\n正文\n````'), '正文');
});

console.log('\nP3 · 通道页有了三个开关的界面入口');

check('refPromptIndex 有勾选框', () => {
  assert(frontSrc.indexOf('channel.refPromptIndex === true') >= 0, '源码里没有 refPromptIndex 的勾选状态');
  assert(frontSrc.indexOf('channel.refPromptIndex = checked') >= 0, '勾选后没写回 channel.refPromptIndex');
});
check('refPromptAt 有勾选框（且只在主开关开着时出现）', () => {
  assert(frontSrc.indexOf('channel.refPromptAt === true') >= 0, '源码里没有 refPromptAt 的勾选状态');
  assert(frontSrc.indexOf('channel.refPromptAt = checked') >= 0, '勾选后没写回 channel.refPromptAt');
  assert(
    frontSrc.indexOf('if (channel.refPromptIndex === true) {') >= 0,
    'refPromptAt 没有跟着主开关一起显示 / 隐藏'
  );
});
check('关掉主开关会把 @ 前缀一并关掉（不留孤儿状态）', () => {
  assert(frontSrc.indexOf('if (!checked) channel.refPromptAt = false;') >= 0, '关主开关时没清 refPromptAt');
});
check('maxBodyMB 有输入框', () => {
  assert(frontSrc.indexOf('spec.maxBodyMB') >= 0, '源码里没有 maxBodyMB 输入框');
});
check('maxBodyMB 留空按 0 处理（不是 NaN 写进配置）', () => {
  assert(
    frontSrc.indexOf('spec.maxBodyMB = v === \'\' ? 0 : Number(v)') >= 0,
    'maxBodyMB 留空时没有归 0，会把 NaN 存进 config.json'
  );
});

console.log('\nP4 · 提示词清洗是唯一入口，不会被别的路径绕过');

check('promptForApi 走的是 stripPromptFence', () => {
  const body = generate.promptForApi.toString();
  assert(body.indexOf('stripPromptFence') >= 0, 'promptForApi 没有经过 stripPromptFence');
});
check('composePrompt 用的是 promptForApi（所以单卡 / 批量 / 定时组都沾光）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'generate.js'), 'utf8');
  const at = src.indexOf('function composePrompt(');
  const body = src.slice(at, at + 400);
  assert(body.indexOf('promptForApi(rawMain)') >= 0, 'composePrompt 没有走 promptForApi');
});

console.log('\n────────────────────────────────────────────────────');
if (failed) {
  console.log('失败 ' + failed + ' 项，通过 ' + passed + ' 项');
  process.exit(1);
}
console.log('全部通过（' + passed + ' 项）');
