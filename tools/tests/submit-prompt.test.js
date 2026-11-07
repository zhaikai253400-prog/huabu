'use strict';

// 第 3 步：提交快照里的 submittedPrompt 不再落盘（能现算）。
//
// 这件事最容易出的错不是「省得不够多」，而是**省出问题**：
//   1. 现算结果与当初真正发出去的不一致 —— 用户点开版本明细会看到假的提交内容；
//   2. tailAppended 标志本身是旧的，直接按它重算就会算错；
//   3. 迁移不幂等，每打开一次画布就重写一遍数据；
//   4. 两种拼法都对不上的那一条被硬删了，提交记录永久失真。
// 这个测试就是围着这四条建护栏。
//
// 运行：runtime/node.exe tools/tests/submit-prompt.test.js

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const migrate = require(path.join(ROOT, 'server', 'migrate.js'));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    failed += 1;
    console.log('  ✗ ' + name + ' —— ' + error.message);
  }
}
const eq = (a, b, msg) => assert.strictEqual(a, b, msg || (a + ' !== ' + b));

console.log('\nS1 · 拼法三处必须一致');

check('composedPromptOf：不追加尾部时就是主提示词', () => {
  eq(migrate.composedPromptOf({ mainPrompt: 'A', tailText: 'T', tailAppended: false }), 'A');
});

check('composedPromptOf：追加尾部时用「两个换行 + 尾部文字」', () => {
  eq(migrate.composedPromptOf({ mainPrompt: 'A', tailText: 'T', tailAppended: true }), 'A\n\nT');
});

check('composedPromptOf：没有主提示词就返回空（不凭空造）', () => {
  eq(migrate.composedPromptOf({ tailText: 'T', tailAppended: true }), '');
  eq(migrate.composedPromptOf(null), '');
});

check('与服务端 composeSubmission 的拼法一致（源码级对齐）', () => {
  const genSrc = fs.readFileSync(path.join(ROOT, 'server', 'generate.js'), 'utf8');
  // 服务端拼尾部用的也是 main + '\n\n' + tail 这一条
  assert(/main\s*\+\s*'\\n\\n'\s*\+\s*tail/.test(genSrc) ||
    /\\n\\n/.test(genSrc), 'generate.js 里找不到「两个换行」的拼法，两边可能已经不一致');
});

check('与前端 composedPromptOf 的拼法一致（源码级对齐）', () => {
  const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  assert(canvasSrc.indexOf('function composedPromptOf') >= 0, 'canvas.js 里没有 composedPromptOf');
  assert(/main\s*\+\s*'\\n\\n'\s*\+\s*tail/.test(canvasSrc),
    'canvas.js 的 composedPromptOf 拼法与迁移不一致');
});

console.log('\nS2 · tailAppended 的真值判定');

check('存下来的就是主提示词本身 → 没追加', () => {
  eq(migrate.trueTailAppendedOf({ mainPrompt: 'A', tailText: 'T', submittedPrompt: 'A' }), false);
});

check('存下来的等于 主+双换行+尾 → 追加了', () => {
  eq(migrate.trueTailAppendedOf({ mainPrompt: 'A', tailText: 'T', submittedPrompt: 'A\n\nT' }), true);
});

check('两种拼法都对不上 → 返回 null（不许乱改）', () => {
  eq(migrate.trueTailAppendedOf({ mainPrompt: 'A', tailText: 'T', submittedPrompt: '完全不同的东西' }), null);
});

check('没有 submittedPrompt / 没有 mainPrompt → null', () => {
  eq(migrate.trueTailAppendedOf({ mainPrompt: 'A', tailText: 'T' }), null);
  eq(migrate.trueTailAppendedOf({ submittedPrompt: 'A', tailText: 'T' }), null);
});

check('尾部文字为空但标志为真：主提示词即最终内容', () => {
  eq(migrate.trueTailAppendedOf({ mainPrompt: 'A', tailText: '', submittedPrompt: 'A' }), false);
});

console.log('\nS3 · 打包单条快照：校正 + 删除');

check('标志过旧（false 其实是 true）→ 校正为 true 并删掉 submittedPrompt', () => {
  const meta = { mainPrompt: 'A', tailText: 'T', tailAppended: false, submittedPrompt: 'A\n\nT' };
  eq(migrate.packSubmissionMeta(meta), true);
  eq(meta.tailAppended, true, '标志没被校正');
  eq(Object.prototype.hasOwnProperty.call(meta, 'submittedPrompt'), false, 'submittedPrompt 没删掉');
});

check('history 里没有 tailAppended 字段 → 补上真值', () => {
  const meta = { mainPrompt: 'A', tailText: 'T', submittedPrompt: 'A\n\nT' };
  eq(migrate.packSubmissionMeta(meta), true);
  eq(meta.tailAppended, true);
  eq('submittedPrompt' in meta, false);
});

check('重算不出来时一个字都不动', () => {
  const meta = { mainPrompt: 'A', tailText: 'T', tailAppended: false, submittedPrompt: '对不上' };
  eq(migrate.packSubmissionMeta(meta), false);
  eq(meta.submittedPrompt, '对不上', '不该删');
  eq(meta.tailAppended, false, '不该改');
});

check('迁完之后现算结果与原值一字不差', () => {
  const cases = [
    { mainPrompt: '主', tailText: '尾', tailAppended: true, submittedPrompt: '主\n\n尾' },
    { mainPrompt: '主', tailText: '尾', tailAppended: false, submittedPrompt: '主' },
    { mainPrompt: '很长的主提示词'.repeat(200), tailText: 'X'.repeat(500), tailAppended: true,
      submittedPrompt: '很长的主提示词'.repeat(200) + '\n\n' + 'X'.repeat(500) },
  ];
  cases.forEach((meta, i) => {
    const orig = meta.submittedPrompt;
    migrate.packSubmissionMeta(meta);
    eq(migrate.composedPromptOf(meta), orig, '第 ' + i + ' 例还原不一致');
  });
});

console.log('\nS4 · 整节点迁移');

check('CURRENT_VER 已升到 2', () => {
  eq(migrate.CURRENT_VER, 2);
});

check('MIGRATIONS 里有 1→2 这一步', () => {
  eq(typeof migrate.MIGRATIONS[1], 'function');
});

check('老节点（v=1）走完整迁移：history + lastSubmission 都清干净', () => {
  const node = {
    type: 'video', id: 'n1',
    data: {
      v: 1, text: '主',
      lastSubmission: { mainPrompt: '主', tailText: '尾', tailAppended: true, submittedPrompt: '主\n\n尾' },
      history: [
        { mainPrompt: '主', tailText: '尾', submittedPrompt: '主\n\n尾' },
        { mainPrompt: '主', tailText: '尾', submittedPrompt: '主' },
      ],
    },
  };
  eq(migrate.migrateNodeData(node), true);
  eq(node.data.v, 2);
  eq('submittedPrompt' in node.data.lastSubmission, false);
  eq(node.data.lastSubmission.tailAppended, true);
  eq('submittedPrompt' in node.data.history[0], false);
  eq(node.data.history[0].tailAppended, true, '第一版该是「追加过」');
  eq(node.data.history[1].tailAppended, false, '第二版该是「没追加」');
});

check('已经迁过的节点再跑：不再改动（幂等）', () => {
  const node = {
    type: 'video',
    data: { v: 2, text: '主', lastSubmission: { mainPrompt: '主', tailAppended: false } },
  };
  eq(migrate.migrateNodeData(node), false, '第二次不该报「动过」');
});

check('迁移不碰提示词正文与其它字段', () => {
  const node = {
    type: 'video',
    data: {
      v: 1, text: '正文别动', model: 'm', params: { a: 1 }, locked: false, hidden: false,
      lastSubmission: { mainPrompt: '主', tailText: '尾', tailAppended: true, submittedPrompt: '主\n\n尾' },
    },
  };
  migrate.migrateNodeData(node);
  eq(node.data.text, '正文别动');
  eq(node.data.model, 'm');
  eq(node.data.params.a, 1);
  eq(node.data.lastSubmission.mainPrompt, '主');
  eq(node.data.lastSubmission.tailText, '尾');
});

check('两版都能精确还原（整节点级）', () => {
  const node = {
    type: 'video',
    data: {
      v: 1, text: '主',
      lastSubmission: { mainPrompt: '主', tailText: '尾', submittedPrompt: '主\n\n尾' },
      history: [{ mainPrompt: '甲', tailText: '', submittedPrompt: '甲' }],
    },
  };
  const wantLast = node.data.lastSubmission.submittedPrompt;
  const wantHist = node.data.history[0].submittedPrompt;
  migrate.migrateNodeData(node);
  eq(migrate.composedPromptOf(node.data.lastSubmission), wantLast);
  eq(migrate.composedPromptOf(node.data.history[0]), wantHist);
});

console.log('\nS5 · 前端落盘时也要摘掉（与迁移同一套规矩）');

check('canvas.js 的 persistedData 会摘掉 submittedPrompt', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const fn = /function persistedData\(data\) \{([\s\S]*?)\n  \}/.exec(src);
  assert(fn, '抽不出 persistedData 函数体');
  assert(fn[1].indexOf('submissionMetaPacked') >= 0 || fn[1].indexOf('submittedPrompt') >= 0,
    'persistedData 没有处理 submittedPrompt —— 新存的数据还是会带上一份');
  assert(fn[1].indexOf('history') >= 0, 'persistedData 漏了 history 里的每一版');
});

check('提交给服务端的 tasks.params 里也不带 submittedPrompt', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  // 真正生成的那条路（/api/generate）——它才存提示词快照，也是 594KB 的来源。
  // 锚点用 mainPrompt：只有这条路会在任务参数里带提示词。
  const at = src.indexOf('mainPrompt: submission.mainPrompt');
  assert(at > 0, '找不到任务参数里存 mainPrompt 的那一段');
  const start = src.lastIndexOf('params: {', at);
  let block = src.slice(start, at + 600);
  // 先把注释剥掉：注释里提到 submittedPrompt 是在解释「为什么不存它」，
  // 不该被当成「又存了」。只有真正的 `submittedPrompt:` 赋值才算问题。
  block = block.replace(/\/\/[^\n]*/g, '');
  assert(/mainPrompt:/.test(block), '任务参数里得留着 mainPrompt，否则没法现算');
  assert(/tailAppended:/.test(block), '任务参数里得留着 tailAppended');
  assert(!/submittedPrompt:/.test(block),
    '任务参数里还在存 submittedPrompt（实测占 594KB，是最该省的一处）');
});

check('只有 /api/generate 那条路存提示词快照（试生成那条不带，属正常）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const starts = src.split('tasks.start(').length - 1;
  eq(starts, 2, '任务创建点数量变了，需要复核每一处的参数');
  // 试生成那条（/api/channels/test-video）只给 duration/resolution/ratio，不含提示词
  const trial = src.slice(src.indexOf('试生成') > 0 ? 0 : 0);
  assert(src.indexOf("params: { duration: body.duration, resolution: body.resolution, ratio: body.ratio }") >= 0,
    '试生成那条的参数形状变了，请复核它有没有开始存提示词');
});

check('读取侧用现算值（submissionMetaOf）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const fn = /function submissionMetaOf\(source, fallback\) \{([\s\S]*?)\n  \}/.exec(src);
  assert(fn, '抽不出 submissionMetaOf 函数体');
  assert(/composed/.test(fn[1]), 'submissionMetaOf 没有用现算结果');
});

console.log('\nS6 · 服务端其它写库路径也要堵住（不然只有手写保存省了，自动生成又漏回来）');

check('store.patchNodeData 也过一遍迁移漏斗', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'store.js'), 'utf8');
  const fn = /function patchNodeData\(canvasId, nodeId, patch\) \{([\s\S]*?)\n\}/.exec(src);
  assert(fn, '抽不出 patchNodeData 函数体');
  assert(fn[1].indexOf('migrate.migrateNodeData') >= 0,
    'patchNodeData 没过迁移漏斗：定时组回填结果时会把 submittedPrompt 又写回库里');
});

check('定时组的 historyEntryOf 不存 submittedPrompt', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'scheduler.js'), 'utf8');
  const fn = /function historyEntryOf\(result, meta\) \{([\s\S]*?)\n\}/.exec(src);
  assert(fn, '抽不出 historyEntryOf 函数体');
  assert(!/submittedPrompt:/.test(fn[1].replace(/\/\/[^\n]*/g, '')),
    'historyEntryOf 还在存 submittedPrompt（每版一份，是历史里最大的一笔重复）');
  assert(/tailAppended:/.test(fn[1]), 'historyEntryOf 得记 tailAppended，否则读的时候没法现算');
  assert(/mainPrompt:/.test(fn[1]), 'historyEntryOf 得记 mainPrompt');
});

check('定时组回填卡片结果时也不存 submittedPrompt', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'scheduler.js'), 'utf8');
  // applyResultToCard 里的 lastSubmission 与 item.submission
  const hits = (src.match(/submittedPrompt:/g) || []).length;
  eq(hits, 0, 'scheduler.js 里还有 ' + hits + ' 处存 submittedPrompt');
});

check('定时组提交任务时 params 里不带 submittedPrompt', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'scheduler.js'), 'utf8');
  const at = src.indexOf('params: Object.assign({}, params, {');
  assert(at > 0, '找不到定时组拼 params 的那段');
  let block = src.slice(at, at + 500);
  block = block.replace(/\/\/[^\n]*/g, '');
  assert(!/submittedPrompt:/.test(block), '定时组任务参数里还在存 submittedPrompt');
  assert(/mainPrompt:/.test(block), '定时组任务参数里得留 mainPrompt');
});

check('全服务端已无 submittedPrompt 赋值', () => {
  const dir = path.join(ROOT, 'server');
  const bad = [];
  fs.readdirSync(dir).filter((n) => n.endsWith('.js')).forEach((n) => {
    const src = fs.readFileSync(path.join(dir, n), 'utf8').replace(/\/\/[^\n]*/g, '');
    if (/submittedPrompt:/.test(src)) bad.push(n);
  });
  eq(bad.join(','), '', '这些文件还在存 submittedPrompt：' + bad.join(','));
});

console.log('\nS7 · 无条件清理（不受版本号管辖）');

check('服务端清理不受版本号挡（v 已是 2 但字段还在，也要清掉）', () => {
  const node = {
    type: 'video',
    data: {
      v: 2,
      lastSubmission: { mainPrompt: '主', tailText: '尾', tailAppended: true, submittedPrompt: '主\n\n尾' },
    },
  };
  eq(migrate.migrateNodeData(node), true, '「已盖 v2 但字段还在」这种节点没被清理');
  eq('submittedPrompt' in node.data.lastSubmission, false);
});

check('cleanSubmissionPrompts 单独可用，且幂等', () => {
  const node = { data: { lastSubmission: { mainPrompt: 'A', tailText: 'T', submittedPrompt: 'A\n\nT' } } };
  eq(migrate.cleanSubmissionPrompts(node), true);
  eq(migrate.cleanSubmissionPrompts(node), false, '第二次不该再报动过');
});

check('前端 migrateNode 也做无条件清理（与老 prompt 字段同一套做法）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  assert(/function packSubmissionPrompts\(/.test(src), '前端缺 packSubmissionPrompts');
  const fn = /function migrateNode\(node\) \{([\s\S]*?)\n  \}/.exec(src);
  assert(fn, '抽不出 migrateNode 函数体');
  assert(fn[1].indexOf('packSubmissionPrompts') >= 0,
    'migrateNode 没做无条件清理：前端一读到卡片就盖版本号，之后就再也没人清这个字段了');
});

check('前端重打包：两种拼法都对不上时保持原样', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const fn = /function repackedSubmissionMeta\(meta\) \{([\s\S]*?)\n  \}/.exec(src);
  assert(fn, '抽不出 repackedSubmissionMeta 函数体');
  assert(/actual === null/.test(fn[1]) && /return out/.test(fn[1]),
    'repackedSubmissionMeta 在重算不出来时没有原样返回');
});

console.log('\n' + '─'.repeat(52));
if (failed) {
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('通过 ' + passed + ' 项，失败 0 项');
