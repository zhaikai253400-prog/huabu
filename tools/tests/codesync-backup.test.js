'use strict';

// P3 的永久护栏：codesync 的备份安全网失灵时必须**上报**。
//
// 背景：`backupExisting` 原来是个空 catch，注释还写着"会在结果里体现"，
// 但既没有返回值、result 里也没有对应字段 —— 备份悄悄失败，
// 用户仍看到"同步完成"，以为有备份可回退，实际没有。
//
// 而 codesync 是"覆盖程序文件"前**唯一的安全网**。所以这里守：
//   ① backupExisting 会回传成功/失败（不再是空 catch）
//   ② result 里有 backupFailed，且调用处真的往里记
//   ③ 备份**目录**建不出来时也不能直接抛（一抛整个同步就中断，
//      用户既没同步到也得不到说明）—— 这条是写测试时才发现的第二个问题
//   ④ 旧那句与事实相反的注释不能回来

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'server', 'codesync.js'), 'utf8');

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

console.log('\nA3 · codesync 备份安全网失灵必须上报');

check('backupExisting 回传成功/失败，不再吞掉错误', () => {
  const fn = /function backupExisting\(abs, rel, dir\) \{[\s\S]*?\n\}/.exec(src);
  assert(fn, '抽不出 backupExisting');
  assert(/return \{ ok: true/.test(fn[0]), '成功时不回传 ok:true');
  assert(/return \{ ok: false/.test(fn[0]), '失败时不回传 ok:false —— 又变成静默了');
  assert(/error && error\.message/.test(fn[0]), '失败原因里没带 error.message');
  assert(/catch \(error\)/.test(fn[0]), 'catch 没有捕获 error 对象');
});

check('**result 里有 backupFailed，且两处都真的往里记**', () => {
  const rb = /const result = \{[\s\S]*?\n  \};/.exec(src);
  assert(rb, '抽不出 result 初始化');
  assert(/backupFailed:\s*\[\]/.test(rb[0]), 'result 里没有 backupFailed 字段');
  // 必须**两处都记**，缺一不可：
  //   ① 单个文件备份失败（backup.ok === false）
  //   ② 备份目录整个建不出来
  // 第一版只断言"某处有 push"，结果"删掉按文件上报那处"能溜过去
  //（因为目录失败那处也有 push）。
  assert(/result\.backupFailed\.push\(\{ path: one\.path, reason: backup\.reason \}\)/.test(src),
    '单个文件备份失败时没有记进 backupFailed');
  // 认准"备份目录"那一条的原因文案 —— 用模糊的 {0,400} 范围会误匹配到
  // 上面那句按文件上报（两者相隔不到 400 字符），变异检验因此漏网。
  assert(/result\.backupFailed\.push\(\{ path: one\.path, reason: '备份目录建不出来：'/.test(src),
    '备份目录建不出来时没有记进 backupFailed');
});

check('**备份目录建不出来时不直接抛**（否则整个同步中断且无说明）', () => {
  assert(/let backupDirOk = true/.test(src), '没有 backupDirOk 这个状态标记');
  const mk = /try \{\n\s*fs\.mkdirSync\(dir, \{ recursive: true \}\);/.exec(src);
  assert(mk, 'fs.mkdirSync(dir) 没有包 try —— 失败时会抛出，同步直接中断');
  assert(/backupDirReason/.test(src), '没记下备份目录失败的原因');
  // 目录失败时也要把受影响的文件报出来
  assert(/backupDirOk\) \{[\s\S]{0,400}?backupFailed\.push/.test(src),
    '备份目录失败时没有把受影响文件记进 backupFailed');
});

check('不用一句与事实相反的注释糊过去（按行为判，不认措辞）', () => {
  // 这条**不检查注释里出现了哪些字** —— 那种断言太脆：改个措辞就红，
  // 而注释本身不影响行为。真正要守的是"注释声称的那个行为真的存在"：
  //   · 注释说"备份失败会被上报" → 那 backupFailed 必须真的存在且被填
  //   · 注释说"不会中断同步"     → 那就不能有裸的 mkdirSync / 裸的 copyFileSync
  // 所以这里改成查**行为事实**，而不是查字面。
  const rb = /const result = \{[\s\S]*?\n  \};/.exec(src);
  assert(rb && /backupFailed:\s*\[\]/.test(rb[0]),
    '注释若声称"备份失败会被上报"，result 里就必须真有 backupFailed');
  const fn = /function backupExisting\(abs, rel, dir\) \{[\s\S]*?\n\}/.exec(src);
  assert(fn && /return \{ ok: false/.test(fn[0]),
    '注释若声称"失败会被调用方看到"，就必须真的回传失败');
  // 不能有"会静默吞掉"的写法回来
  assert(!/catch\s*\{\s*\/\*\s*备份失败/.test(src),
    '备份失败又被空 catch 吞掉了');
});

check('前端会展示 backupFailed（否则服务端报了用户也看不见）', () => {
  const fe = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'codesync.js'), 'utf8');
  assert(/report\.backupFailed/.test(fe),
    '前端没有读取 report.backupFailed —— 服务端报了但界面上看不到');
  assert(/没能备份|未备份/.test(fe), '前端没有针对备份失败的提示文案');
});

console.log('');
console.log('─'.repeat(52));
if (fail) { console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项'); process.exit(1); }
console.log('通过 ' + pass + ' 项，失败 0 项');
