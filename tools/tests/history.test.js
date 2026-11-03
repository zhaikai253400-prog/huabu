'use strict';

// 清单 38 第 3 步 · 撤销栈模块专项测试。
//
// undo-delete.test.js 测的是「删除 → 撤销」这条路走不走得通（画布层的语义）；
// 这个文件只测**栈本身**：压、退、进、截断、清空，以及那些「顺序错了就静默出错」的规矩。
//
// 为什么值得单独一个文件：栈的错全都是**无声**的。
//   - 截断方向反了（pop 而不是 shift）：没有报错，要等用户按满 60 次撤销、
//     发现「越撤越回到未来」才可能察觉；
//   - 压新的不清 future：撤销两步再改一笔，按重做会跳进一条早就不存在的分支；
//   - undo 不把当前存进 future：只能撤销不能重做 —— 这正是改之前的状态，
//     代码里跑了一年多都没人察觉，因为「没有重做」看起来像设计选择。
//
// 运行：runtime/node.exe tools/tests/history.test.js

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const mod = require(path.join(ROOT, 'web', 'assets', 'history.js'));

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
function eq(got, want, msg) {
  if (got !== want) {
    throw new Error((msg || '值不相等') + '：拿到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
  }
}
function depth(stack) {
  const sizes = stack.sizes();
  return { past: sizes.past, future: sizes.future };
}

console.log('\n清单 38 第 3 步 · 撤销栈（history.js）');

console.log('\n[1] 导出与基本形状');

check('导出 HISTORY_LIMIT 与 createStack 两样东西', () => {
  assert(typeof mod.HISTORY_LIMIT === 'number', 'HISTORY_LIMIT 应是数字');
  assert(typeof mod.createStack === 'function', 'createStack 应是函数');
  eq(Object.keys(mod).sort().join(','), 'HISTORY_LIMIT,createStack', '导出项多了或少了');
});

check('上限是 60 这个量级（够退回去，又不至于把内存吃光）', () => {
  assert(mod.HISTORY_LIMIT >= 20 && mod.HISTORY_LIMIT <= 200, '上限值可疑：' + mod.HISTORY_LIMIT);
});

check('每次 createStack 都是独立的一个栈（不能共用同一份数组）', () => {
  const a = mod.createStack(10);
  const b = mod.createStack(10);
  a.push('x');
  eq(depth(a).past, 1);
  eq(depth(b).past, 0, '两个栈共用了一份数据');
});

check('不传上限时用默认值', () => {
  const stack = mod.createStack();
  for (let i = 0; i < mod.HISTORY_LIMIT + 5; i += 1) stack.push('s' + i);
  eq(depth(stack).past, mod.HISTORY_LIMIT, '没按默认上限截断');
});

console.log('\n[2] push：压一条、截断、清未来');

check('压进去的能原样取出来（不做任何改写）', () => {
  const stack = mod.createStack(10);
  stack.push('{"a":1}');
  eq(stack.undo('now'), '{"a":1}', '取出来的不是压进去那一份');
});

check('超过上限从最老的一头丢（shift，不是 pop）', () => {
  const stack = mod.createStack(3);
  ['a', 'b', 'c', 'd', 'e'].forEach((s) => stack.push(s));
  eq(depth(stack).past, 3, '没截到上限');
  // 只剩 c / d / e：退三次依次拿到 e、d、c，再退就没了
  eq(stack.undo('x'), 'e');
  eq(stack.undo('x'), 'd');
  eq(stack.undo('x'), 'c');
  eq(stack.undo('x'), null, '还退得出东西，说明丢错了方向');
});

check('压新的会清空「未来」（否则重做会跳进已作废的分支）', () => {
  const stack = mod.createStack(10);
  stack.push('a');
  stack.undo('b'); // 现在 future 里有 b
  eq(depth(stack).future, 1, '前置条件不成立：撤销后该有一条未来');
  stack.push('c');
  eq(depth(stack).future, 0, '压了新快照却没清未来');
});

check('压进去的是 undefined 也不崩（记录本身不校验内容）', () => {
  const stack = mod.createStack(10);
  stack.push(undefined);
  eq(depth(stack).past, 1);
});

console.log('\n[3] undo：退一步，并把「现在」存进未来');

check('撤销一次：过去少一条、未来多一条（逐字段）', () => {
  const stack = mod.createStack(10);
  stack.push('a');
  stack.undo('now');
  const d = depth(stack);
  eq(d.past, 0, '过去没少');
  eq(d.future, 1, '未来没多');
});

check('空栈撤销返回 null（调用方据此决定要不要提示用户）', () => {
  const stack = mod.createStack(10);
  eq(stack.undo('now'), null);
});

check('连续撤销：逐级往回退，退到底返回 null', () => {
  const stack = mod.createStack(10);
  ['a', 'b', 'c'].forEach((s) => stack.push(s));
  eq(stack.undo('n1'), 'c');
  eq(stack.undo('n2'), 'b');
  eq(stack.undo('n3'), 'a');
  eq(stack.undo('n4'), null);
});

check('撤销时没传「现在」：不往未来塞垃圾（宁可不能重做，也不要塞进 undefined）', () => {
  const stack = mod.createStack(10);
  stack.push('a');
  eq(stack.undo(), 'a');
  eq(depth(stack).future, 0, '漏传 current 时不该往未来塞东西');
  eq(stack.redo('x'), null, '未来里应该是空的');
});

check('未来也有上限，不会无限涨', () => {
  const stack = mod.createStack(3);
  ['a', 'b', 'c', 'd', 'e'].forEach((s) => stack.push(s));
  for (let i = 0; i < 10; i += 1) stack.undo('cur' + i);
  eq(depth(stack).future, 3, '未来没截到上限');
});

console.log('\n[4] redo：再走回来');

check('重做一次：未来少一条、过去多一条', () => {
  const stack = mod.createStack(10);
  stack.push('a');
  stack.undo('now');
  eq(stack.redo('back'), 'now', '重做取回来的不是撤销时存的那一份');
  const d = depth(stack);
  eq(d.past, 1, '过去没长回来');
  eq(d.future, 0, '未来没少');
});

check('空「未来」时重做返回 null（不许把数据改成空）', () => {
  const stack = mod.createStack(10);
  eq(stack.redo('now'), null);
});

check('重做时没传「现在」：不往过去塞垃圾', () => {
  const stack = mod.createStack(10);
  stack.push('a');
  stack.undo('now');
  eq(stack.redo(), 'now');
  eq(depth(stack).past, 0, '漏传 current 时不该往过去塞东西');
});

check('「撤销 → 重做」是一个闭往返：栈的两头回到原样', () => {
  const stack = mod.createStack(10);
  stack.push('a');
  stack.push('b');
  const before = depth(stack);
  stack.undo('now');
  stack.redo('now');
  const after = depth(stack);
  eq(after.past, before.past, '往返之后过去对不上');
  eq(after.future, before.future, '往返之后未来对不上');
});

check('多步：退三步再进三步，回到同一个地方', () => {
  const stack = mod.createStack(10);
  ['s1', 's2', 's3'].forEach((s) => stack.push(s));
  // 模拟真实数据流动：每次撤销/重做都要把「现在」交出去
  let cur = 's4';
  const trail = [cur];
  for (let i = 0; i < 3; i += 1) {
    cur = stack.undo(cur);
    trail.push(cur);
  }
  eq(cur, 's1', '退三步没到 s1');
  for (let i = 0; i < 3; i += 1) {
    cur = stack.redo(cur);
    trail.push(cur);
  }
  eq(cur, 's4', '进三步没回到 s4');
});

console.log('\n[5] canUndo / canRedo / sizes / reset');

check('canUndo / canRedo 与深度一致', () => {
  const stack = mod.createStack(10);
  eq(stack.canUndo(), false);
  eq(stack.canRedo(), false);
  stack.push('a');
  eq(stack.canUndo(), true);
  stack.undo('now');
  eq(stack.canUndo(), false);
  eq(stack.canRedo(), true);
});

check('sizes 只报数字，不把数组本身交出去（外面没法绕过规矩改栈）', () => {
  const stack = mod.createStack(10);
  stack.push('a');
  const sizes = stack.sizes();
  eq(typeof sizes.past, 'number');
  eq(typeof sizes.future, 'number');
  assert(!Array.isArray(sizes.past), 'sizes 把数组本身交出去了');
});

check('reset 清空两头（换画布时不能把上一块画布的历史带过来）', () => {
  const stack = mod.createStack(10);
  stack.push('a');
  stack.push('b');
  stack.undo('now');
  stack.reset();
  const d = depth(stack);
  eq(d.past, 0);
  eq(d.future, 0);
  eq(stack.canUndo(), false);
  eq(stack.canRedo(), false);
});

check('reset 之后还能继续正常用（不是把栈弄坏了）', () => {
  const stack = mod.createStack(10);
  stack.push('a');
  stack.reset();
  stack.push('b');
  eq(stack.undo('now'), 'b');
});

console.log('\n[6] 纯模块：不依赖浏览器环境');

check('源码里除了注释没有 window / document / 定时器 / fetch', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'history.js'), 'utf8');
  const body = src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
  ['window.', 'document.', 'navigator.', 'setTimeout', 'setInterval', 'fetch('].forEach((needle) => {
    assert(body.indexOf(needle) < 0, '模块里用了 ' + needle + '（应该是纯的，才能直接 require）');
  });
});

check('UMD 双导出：浏览器挂 window.CanvasHistory，Node 走 module.exports', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'history.js'), 'utf8');
  assert(src.indexOf('root.CanvasHistory = api') >= 0, '没挂 window.CanvasHistory');
  assert(src.indexOf('module.exports = api') >= 0, '没有 module.exports');
});

check('重复 require 拿到同一份（模块缓存没被绕过）', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'web', 'assets', 'history.js'))];
  const again = require(path.join(ROOT, 'web', 'assets', 'history.js'));
  eq(again.HISTORY_LIMIT, mod.HISTORY_LIMIT);
  assert(typeof again.createStack === 'function');
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);