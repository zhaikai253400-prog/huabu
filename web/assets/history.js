(function (root, factory) {
  // 撤销 / 重做栈（清单 38「拆分 canvas.js」第 3 步）。
  //
  // 这里只管**栈本身**：压一条、退一条、再进一条、上限到了扔最老的。
  // 「快照拍什么」和「恢复之后要重画什么」都留在 canvas.js —— 前者要读 nodes / edges，
  // 后者要调 renderAll / renumberAll / scheduleSave，都是画布层的活。
  //
  // 边界切在这里的理由是可测性：栈是四个纯动作的组合，给它一个字符串就能测完；
  // 而原来这三个动作跟快照、跟渲染糊在一个函数里，只能靠源码切片验「有没有写那句话」。
  //
  // 与 payload-rules.js / utils.js / task-poll.js 同一种加载方式：
  //   浏览器：window.CanvasHistory
  //   Node  ：require('../web/assets/history.js')
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.CanvasHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 60 步够退回到「刚才那样」，再多也没人真的会一路按回去；
  // 每步是一整块画布的 JSON，六十步在几百张卡片的画布上已经几十 MB 了。
  const HISTORY_LIMIT = 60;

  // 造一个独立的栈。用工厂而不是直接导出数组，是为了让「怎么改栈」只有这一条路：
  // 外面拿不到 past / future 那两个数组，也就没法绕过「压新的要清掉未来」这条规矩。
  function createStack(limit) {
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : HISTORY_LIMIT;
    const past = [];
    const future = [];

    return {
      // 改完一步就压一条。三个动作的顺序有意义：
      //   1) 先压进去；
      //   2) 再截断 —— 截断要用 shift 扔最老的，用 pop 扔的是刚压进去的那条（方向反了，
      //      症状是「越撤销越回到未来」，而且只在超过 60 步后才出现，很难查）；
      //   3) 最后清空 future —— 压了新快照，之前撤销掉的那些就再也回不来了，
      //      留着的话「撤销 → 改一下 → 重做」会跳到一条已经不存在的分支上。
      push(snap) {
        past.push(snap);
        if (past.length > max) past.shift();
        future.length = 0;
      },

      // 退一步。current 是「现在这样」，撤销前必须先存进 future，
      // 否则重做无处可去 —— 这也是原来只能撤销、不能重做的原因。
      // 返回 null 表示没得退了（调用方据此决定要不要提示）。
      undo(current) {
        if (!past.length) return null;
        // 只收字符串：万一调用方漏传，宁可不存，也不要把 undefined 塞进栈里
        // （那会让 redo 拿到一个 JSON.parse 不了的东西）。
        if (typeof current === 'string') {
          future.push(current);
          if (future.length > max) future.shift();
        }
        return past.pop();
      },

      // 进一步。current 是「现在这样」，要压回 past，否则重做之后就没法再撤销回来。
      redo(current) {
        if (!future.length) return null;
        if (typeof current === 'string') {
          past.push(current);
          if (past.length > max) past.shift();
        }
        return future.pop();
      },

      canUndo() {
        return past.length > 0;
      },

      canRedo() {
        return future.length > 0;
      },

      // 按钮禁用状态与测试都靠它看深度，不直接暴露数组
      sizes() {
        return { past: past.length, future: future.length };
      },

      // 换画布 / 重新载入时清干净，别把上一块画布的历史带过来
      reset() {
        past.length = 0;
        future.length = 0;
      },
    };
  }

  return { HISTORY_LIMIT: HISTORY_LIMIT, createStack: createStack };
});