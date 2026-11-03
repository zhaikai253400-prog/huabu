(function (root, factory) {
  // 「一键整理排版」的排布算法（清单 38「拆分 canvas.js」第 6 步的一部分）。
  //
  // 这一块为什么值得单独成文件：**排版算错是不会报错的**。它不抛异常、不写坏数据，
  // 只是把卡片摆到一个看着像样、但你一眼说不出哪儿不对的位置：
  //
  //   · 分层方向反了 → 整块画布左右镜像，连线全往左倒。图还在、字还对，就是读不懂；
  //   · 环上的连线没挡住 → depthOf 无限递归，整理一次直接把页面卡死；
  //   · 列内换行的先后顺序没排好 → 连线交叉成蜘蛛网，越"整理"越乱；
  //   · 网格列数算错 → 一百张卡片排成一长条或者挤成一坨。
  //
  // 这四种都没法靠"看代码"发现，也很难靠肉眼验收（你得先有一块连线复杂的画布）。
  // 抽出来之后能直接 require 喂数据断言，这才是抽它的理由 ——
  // 不是为了"少 190 行"，是为了让这四个错**能被测出来**。
  //
  // 边界切在「只算位置，不碰画布」：
  //   进来的  units（一堆卡片怎样算一个整体）/ boxes（每个整体多大）/ edges / origin
  //   出去的  Map<unitId, {x, y}>
  // 至于"谁和谁算一个整体"要读组合与定时组成员、"每个整体多大"要读卡片真实尺寸
  // （sizeOf 还牵着成员排布与区域折叠），那些留在 canvas.js 里当参数传进来。
  //
  // 与 payload-rules.js / utils.js / task-poll.js / history.js / refs.js 同一种加载方式：
  //   浏览器：window.CanvasLayout
  //   Node  ：require('../web/assets/layout.js')
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.CanvasLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 列间距与行间距。排版"松不松"全由这两个数决定，所以跟着算法一起走 ——
  // 留在 canvas.js 里迟早会出现"算法在一个文件、间距在另一个文件"的对不上。
  const COL_GAP = 96;
  const ROW_GAP = 56;

  // 只算「整体与整体之间」的连线，组合内部的连线不参与排版。
  // edges 从参数进来（原来直接读全局 edges），这样这个文件一行都不碰画布全局。
  function unitLinks(units, edges) {
    const unitOf = new Map();
    units.forEach((unit) => unit.nodes.forEach((node) => unitOf.set(node.id, unit.id)));
    const outs = new Map();
    const ins = new Map();
    units.forEach((unit) => {
      outs.set(unit.id, []);
      ins.set(unit.id, []);
    });
    (edges || []).forEach((edge) => {
      const from = unitOf.get(edge.sourceId);
      const to = unitOf.get(edge.targetId);
      // 同一个整体内部的连线（组合里素材连素材）不算，否则整组会被自己的线撑开
      if (!from || !to || from === to) return;
      if (outs.get(from).indexOf(to) < 0) outs.get(from).push(to);
      if (ins.get(to).indexOf(from) < 0) ins.get(to).push(from);
    });
    return { outs: outs, ins: ins };
  }

  // 按连线分层：没接别人素材的排最左，由它衍生出来的往右排。
  //
  // 环（A→B→A）必须挡住，否则 depthOf 会顺着环一路递归到栈溢出 ——
  // 用户画布上只要有一个环，点"整理"整个页面就卡死，而且**不带任何错误提示**。
  // 下面用 state 三色标记（1=正在算 / 2=算完了），撞见"正在算"就返回 -1 表示此路不通。
  function flowPlan(units, boxes, origin, edges) {
    const links = unitLinks(units, edges);
    const state = new Map();
    const depth = new Map();
    const depthOf = (id) => {
      const seen = state.get(id);
      if (seen === 2) return depth.get(id);
      if (seen === 1) return -1;
      state.set(id, 1);
      let best = 0;
      (links.ins.get(id) || []).forEach((from) => {
        const value = depthOf(from);
        if (value >= 0) best = Math.max(best, value + 1);
      });
      state.set(id, 2);
      depth.set(id, best);
      return best;
    };
    units.forEach((unit) => depthOf(unit.id));

    const columns = [];
    units.forEach((unit) => {
      const level = depth.get(unit.id) || 0;
      if (!columns[level]) columns[level] = [];
      columns[level].push(unit.id);
    });
    const order = columns.map((column) => column.slice());
    order.forEach((column) => {
      column.sort((a, b) => boxes.get(a).y - boxes.get(b).y || boxes.get(a).x - boxes.get(b).x);
    });
    // 连线尽量不交叉：来回几轮重心排序。
    // 正向扫用「上游」的重心，反向扫用「下游」的重心 —— 两边都用同一边的话，
    // 第二轮会把第一轮的结果原样算回去，等于没做。
    for (let pass = 0; pass < 4; pass += 1) {
      const forward = pass % 2 === 0;
      const spot = new Map();
      order.forEach((column) => column.forEach((id, index) => spot.set(id, index)));
      const line = order.map((_, index) => index);
      if (!forward) line.reverse();
      line.forEach((index) => {
        if (forward && index === 0) return;
        if (!forward && index === order.length - 1) return;
        const column = order[index];
        const keys = new Map();
        column.forEach((id, position) => {
          const refs = (forward ? links.ins.get(id) : links.outs.get(id)) || [];
          const spots = refs.map((other) => spot.get(other)).filter((value) => typeof value === 'number');
          keys.set(id, spots.length ? spots.reduce((sum, value) => sum + value, 0) / spots.length : position);
        });
        column.sort((a, b) => keys.get(a) - keys.get(b) || boxes.get(a).y - boxes.get(b).y);
      });
    }

    const columnWidth = order.map((column) => Math.max.apply(null, column.map((id) => boxes.get(id).w)));
    const columnHeight = order.map((column) =>
      column.reduce((sum, id, position) => sum + boxes.get(id).h + (position ? ROW_GAP : 0), 0)
    );
    const tallest = Math.max.apply(null, columnHeight);
    const plan = new Map();
    let x = origin.x;
    order.forEach((column, index) => {
      // 每一列在竖直方向居中：矮的那列不会全挤在顶上，整体看着平衡
      let y = origin.y + Math.round((tallest - columnHeight[index]) / 2);
      column.forEach((id) => {
        const box = boxes.get(id);
        plan.set(id, { x: Math.round(x + (columnWidth[index] - box.w) / 2), y: Math.round(y) });
        y += box.h + ROW_GAP;
      });
      x += columnWidth[index] + COL_GAP;
    });
    return plan;
  }

  // 网格排布：保持原来的上下左右顺序，一行一行摆齐。
  // 列数按"整体的平均宽高比"推 —— 全是竖长卡片时少分几列，全是横宽卡片时多分几列，
  // 这样排出来的块大致是个正方形，而不是一长条或者一坨。
  function gridPlan(units, boxes, origin) {
    const list = units
      .slice()
      .sort((a, b) => boxes.get(a.id).y - boxes.get(b.id).y || boxes.get(a.id).x - boxes.get(b.id).x);
    const total = list.length;
    if (!total) return new Map();
    let sumW = 0;
    let sumH = 0;
    list.forEach((unit) => {
      sumW += boxes.get(unit.id).w;
      sumH += boxes.get(unit.id).h;
    });
    const shape = sumH / total / Math.max(1, sumW / total);
    // Math.max(0.2, shape)：卡片极端扁或者极端高时，别把列数推到 1 或者推到 total
    const columns = Math.max(1, Math.min(total, Math.round(Math.sqrt(total * Math.max(0.2, shape) * 1.2))));
    const columnWidth = new Array(columns).fill(0);
    const rowHeight = [];
    list.forEach((unit, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      columnWidth[column] = Math.max(columnWidth[column], boxes.get(unit.id).w);
      rowHeight[row] = Math.max(rowHeight[row] || 0, boxes.get(unit.id).h);
    });
    const plan = new Map();
    list.forEach((unit, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const box = boxes.get(unit.id);
      // 每张在自己那一格里水平居中，宽窄不一的时候右边不会参差不齐
      let x = origin.x;
      for (let step = 0; step < column; step += 1) x += columnWidth[step] + COL_GAP;
      let y = origin.y;
      for (let step = 0; step < row; step += 1) y += rowHeight[step] + ROW_GAP;
      plan.set(unit.id, { x: Math.round(x + (columnWidth[column] - box.w) / 2), y: Math.round(y) });
    });
    return plan;
  }

  return {
    COL_GAP: COL_GAP,
    ROW_GAP: ROW_GAP,
    unitLinks: unitLinks,
    flowPlan: flowPlan,
    gridPlan: gridPlan,
  };
});