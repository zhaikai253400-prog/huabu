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

console.log('\nS9 · 摘字段时必须「只摘那一个」，不能顺手抹掉别的');
//
// 这一节是补一个真实事故的护栏。
// 第 3 步最初有**两份**「摘 submittedPrompt」的实现：
//   · 读入侧：先校验、再 delete（正确）
//   · 保存漏斗侧：按白名单拷一份新对象（错误）
// history 的每一版除了提交元信息，还带 id 与 result。它们不在白名单里，
// 于是「保存一次」就把每一版的 id 和图片地址静默抹掉 ——
// versionEntriesOf() 第一句就是 entry.result.url，直接跳过，
// 「生成版本历史」整块失效。当前库里 48 条 history 全都带 submittedPrompt，
// 所以这条路随时会被走到。已合并成唯一实现 stripSubmissionPrompt。

check('保存漏斗只摘 submittedPrompt，id / result 必须留着', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  // 唯一的实现
  assert(/function stripSubmissionPrompt\(/.test(src), '缺 stripSubmissionPrompt');
  const impl = /function stripSubmissionPrompt\(meta\) \{([\s\S]*?)\n  \}/.exec(src);
  assert(impl, '抽不出 stripSubmissionPrompt');
  assert(/\.\.\.meta/.test(impl[1]) || /Object\.assign/.test(impl[1]),
    'stripSubmissionPrompt 不是「拷贝原对象再删一个字段」，可能又变成白名单挑字段');
  assert(/delete out\.submittedPrompt/.test(impl[1]), 'stripSubmissionPrompt 没删 submittedPrompt');
  // 老的、会丢字段的白名单实现必须彻底消失
  assert(!/SUBMISSION_META_KEYS/.test(src), '白名单挑字段的写法又回来了');
  assert(!/function submissionMetaPacked/.test(src), '旧的会丢字段的实现又回来了');
  assert(!/function repackedSubmissionMeta/.test(src), '重复实现又出现了（两份必然走偏）');
});

check('保存漏斗与读入迁移共用同一份实现', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const persisted = /function persistedData\(data\) \{([\s\S]*?)\n  \}/.exec(src);
  const packer = /function packSubmissionPrompts\(node\) \{([\s\S]*?)\n  \}/.exec(src);
  assert(persisted && packer, '抽不出这两个函数');
  assert(persisted[1].indexOf('stripSubmissionPrompt') >= 0, '保存漏斗没走唯一实现');
  assert(packer[1].indexOf('stripSubmissionPrompt') >= 0, '读入迁移没走唯一实现');
  const calls = (src.match(/stripSubmissionPrompt\(/g) || []).length;
  assert(calls >= 4, '调用点少于预期（应有定义 1 处 + 保存 2 处 + 读入 2 处），实际 ' + calls);
});

check('history 的 id / result 是版本面板的命脉，注释里留了案底', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  assert(/versionEntriesOf/.test(src), '找不到 versionEntriesOf');
  assert(/id 和图片地址静默抹掉|静默抹掉/.test(src),
    'stripSubmissionPrompt 附近没有记下这次事故的原因，后来人容易再犯');
});

check('前端重打包：两种拼法都对不上时保持原样', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const fn = /function stripSubmissionPrompt\(meta\) \{([\s\S]*?)\n  \}/.exec(src);
  assert(fn, '抽不出 stripSubmissionPrompt 函数体');
  assert(/actual === null/.test(fn[1]), '没有「重算不出来」的判定');
  assert(/return meta/.test(fn[1]),
    'stripSubmissionPrompt 在重算不出来时没有原样返回（会丢内容）');
  assert(/return meta/.test(fn[1]) && /const out = \{ \.\.\.meta \}/.test(fn[1]),
    '结构不对：应当先判、判不了就 return 原对象，判得了才拷贝并删字段');
});

console.log('\nS8 · tasks 表里那一份也要清（老数据 141 条 / 594KB）');

check('packTaskParams：清掉 submittedPrompt，其余参数不动', () => {
  const params = {
    sizeKey: '2K', ratio: '16:9', duration: 30,
    mainPrompt: '主', tailText: '尾', tailAppended: true, submittedPrompt: '主\n\n尾',
  };
  const out = migrate.packTaskParams(params);
  eq('submittedPrompt' in out, false, '没清掉');
  eq(out.mainPrompt, '主');
  eq(out.tailText, '尾');
  eq(out.tailAppended, true);
  eq(out.sizeKey, '2K', '别的参数被动了');
  eq(out.ratio, '16:9');
  eq(out.duration, 30);
  eq(migrate.composedPromptOf(out), '主\n\n尾', '清完之后现算不出来');
});

check('packTaskParams：没有该字段时原样返回（引用不变，调用方据此跳过写库）', () => {
  const params = { mainPrompt: '主', sizeKey: '2K' };
  eq(migrate.packTaskParams(params), params, '不该产生新对象');
});

check('packTaskParams：重算不出来时一个字都不动', () => {
  const params = { mainPrompt: '主', tailText: '尾', submittedPrompt: '对不上', sizeKey: '2K' };
  eq(migrate.packTaskParams(params), params, '不该动');
  eq(params.submittedPrompt, '对不上');
});

check('packTaskParams：非对象 / 数组原样返回', () => {
  eq(migrate.packTaskParams(null), null);
  eq(migrate.packTaskParams('x'), 'x');
  const arr = [1, 2];
  eq(migrate.packTaskParams(arr), arr);
});

check('startup 会清老任务记录（不是等它被重写才清）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'store.js'), 'utf8');
  const initFn = /function init\(\) \{([\s\S]*?)\n\}/.exec(src);
  assert(initFn, '抽不出 init 函数体');
  assert(initFn[1].indexOf('pruneTaskSubmissionPrompts') >= 0,
    'init 没调清理：老库里那 141 条会一直躺着占 594KB');
  assert(/function pruneTaskSubmissionPrompts\(\)/.test(src), '缺 pruneTaskSubmissionPrompts');
  const prune = /function pruneTaskSubmissionPrompts\(\) \{([\s\S]*?)\n\}/.exec(src);
  assert(prune, '抽不出 pruneTaskSubmissionPrompts 函数体');
  assert(prune[1].indexOf('packTaskParams') >= 0, 'prune 没用 packTaskParams');
  // 清理失败不能挡住启动
  assert(/catch[\s\S]{0,120}清理任务里的重复提示词跳过/.test(src),
    '启动时清理失败没有兜住，会把整个服务带下去');
});

check('新写入的任务记录也走同一条清理', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'store.js'), 'utf8');
  assert(/JSON\.stringify\(migrate\.packTaskParams\(task\.params/.test(src),
    'insertTask 没走 packTaskParams：新任务又会带上那一份重复');
});

check('前端从任务拿快照时走现算（submissionMetaFromTask → submissionMetaOf）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const fn = /function submissionMetaFromTask\(task, data\) \{([\s\S]*?)\n  \}/.exec(src);
  assert(fn, '抽不出 submissionMetaFromTask 函数体');
  assert(fn[1].indexOf('submissionMetaOf') >= 0, '没走统一的快照构造');
  assert(fn[1].indexOf('tailAppended') >= 0, '得把 tailAppended 传下去，否则现算不出来');
});

console.log('\nS10 · 前后端对拍（两处实现必须真跑出同样的结果）');
//
// 前端跑在浏览器里，引不到 server/migrate.js，所以「拼提交提示词」这件事
// 前后端各写了一份。项目自己的注释写着「保持一致靠测试里的对拍，不靠自觉」——
// 下面就是把这句话兑现：把前端那份从源码里抽出来在沙箱里跑，
// 与后端那份喂同一批输入，逐个比结果。
//
// 为什么必须是「跑出来比」而不是「看源码像不像」：
// 上一节 S9 那个缺陷就是两份实现看着都合理、跑起来才不一样。

// 从 canvas.js 里抽出某个顶层函数的体
function frontBody(name) {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  const m = new RegExp('function ' + name + '\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\}').exec(src);
  assert(m, '抽不出前端函数 ' + name);
  return m[1];
}

const feCompose = new Function(
  'function composedPromptOf(meta) {' + frontBody('composedPromptOf') + '\n  }\n' +
  'return composedPromptOf;'
)();

const COMPOSE_CASES = [
  ['追加了尾部', { mainPrompt: 'A', tailText: 'T', tailAppended: true }],
  ['没追加', { mainPrompt: 'A', tailText: 'T', tailAppended: false }],
  ['尾部为空但标志为真', { mainPrompt: 'A', tailText: '', tailAppended: true }],
  ['尾部 undefined', { mainPrompt: 'A', tailText: undefined, tailAppended: true }],
  ['main 为空', { mainPrompt: '', tailText: 'T', tailAppended: true }],
  ['main undefined', { mainPrompt: undefined, tailText: 'T', tailAppended: true }],
  ['两个都空', { mainPrompt: '', tailText: '', tailAppended: true }],
  ['标志 undefined', { mainPrompt: 'A', tailText: 'T' }],
  ['main 含换行', { mainPrompt: '行1\n行2', tailText: 'T', tailAppended: true }],
  ['尾部含换行', { mainPrompt: 'A', tailText: '尾1\n尾2', tailAppended: true }],
  ['中文与 emoji', { mainPrompt: '猫🐱', tailText: '尾✨', tailAppended: true }],
  ['超长', { mainPrompt: 'x'.repeat(50000), tailText: 'y'.repeat(20000), tailAppended: true }],
  ['null 输入', null],
  ['非对象输入', '字符串'],
  ['数字字段', { mainPrompt: 123, tailText: 456, tailAppended: true }],
];

check('拼提交提示词：前后端 ' + COMPOSE_CASES.length + ' 组输入结果全等', () => {
  COMPOSE_CASES.forEach(([name, meta]) => {
    const be = migrate.composedPromptOf(meta);
    const fe = feCompose(meta);
    assert.strictEqual(fe, be, '「' + name + '」不一致：后端=' + JSON.stringify(String(be).slice(0, 40)) +
      ' 前端=' + JSON.stringify(String(fe).slice(0, 40)));
  });
});

// 判 tailAppended 真值：前端那份在 stripSubmissionPrompt 里头，照它的逻辑重跑一遍。
// 这里**有意从源码文本里抠出判据**，而不是另抄一份 —— 抄一份就失去对拍的意义了。
const feStrip = new Function(
  'function stripSubmissionPrompt(meta) {' + frontBody('stripSubmissionPrompt') + '\n  }\n' +
  'return stripSubmissionPrompt;'
)();

check('判 tailAppended 真值：前后端 8 组输入结果全等', () => {
  const cases = [
    ['sub === main', { mainPrompt: 'A', tailText: 'T', submittedPrompt: 'A' }],
    ['sub === main+双换行+tail', { mainPrompt: 'A', tailText: 'T', submittedPrompt: 'A\n\nT' }],
    ['对不上', { mainPrompt: 'A', tailText: 'T', submittedPrompt: 'X' }],
    ['没有 sub', { mainPrompt: 'A', tailText: 'T' }],
    ['没有 main', { mainPrompt: '', tailText: 'T', submittedPrompt: 'A' }],
    ['tail 空且 sub === main', { mainPrompt: 'A', tailText: '', submittedPrompt: 'A' }],
    ['tail 空且 sub === main+双换行', { mainPrompt: 'A', tailText: '', submittedPrompt: 'A\n\n' }],
    ['main 含换行', { mainPrompt: '行1\n行2', tailText: 'T', submittedPrompt: '行1\n行2\n\nT' }],
  ];
  cases.forEach(([name, meta]) => {
    const be = migrate.trueTailAppendedOf(meta);
    // 前端不单独暴露这个判定函数，所以用它的**返回引用**反推：
    //   · 返回同一个对象 → 没算出真值（原样保留）
    //   · 返回新对象     → 算出来了，tailAppended 就是判定结果
    // 用引用判断而不是看字段在不在：字段在不在分不清「没算出来」与「本来就没有」。
    const input = { ...meta };
    const out = feStrip(input);
    const fe = out === input ? null : out.tailAppended;
    assert.strictEqual(fe, be, '「' + name + '」不一致：后端=' + be + ' 前端=' + fe);
  });
});

check('对拍失败时不是「两边一致地错」：与最终文档里写的规则也一致', () => {
  // 规则写在 generate.composeSubmission 里，用「两个换行」拼。
  // 这里连同注释一起守住拼法，防止有人改了一边却让两边同时变。
  const genSrc = fs.readFileSync(path.join(ROOT, 'server', 'generate.js'), 'utf8');
  assert(genSrc.indexOf("'\\n\\n'") >= 0, 'generate.js 里找不到「两个换行」的拼法');
  const migSrc = fs.readFileSync(path.join(ROOT, 'server', 'migrate.js'), 'utf8');
  assert(migSrc.indexOf("'\\n\\n'") >= 0, 'migrate.js 里找不到「两个换行」的拼法');
  const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
  assert(canvasSrc.indexOf("'\\n\\n'") >= 0, 'canvas.js 里找不到「两个换行」的拼法');
});

console.log('\n' + '─'.repeat(52));
if (failed) {
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('通过 ' + passed + ' 项，失败 0 项');
