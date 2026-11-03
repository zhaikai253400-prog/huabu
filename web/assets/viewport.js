(function (root, factory) {
  // 画布的坐标映射数学（清单 38「拆分 canvas.js」第 7 步）。
  //
  // 这一步抽的不是「一坨功能」也不是「一套语法」，而是**一套坐标映射**。
  // 画布是无限平面，屏幕与世界之间来回换算全靠两个数：平移 (x, y) 与缩放 zoom。
  // 这套换算散在十几个地方，而它有一类**写反了也不报错**的错误：
  //
  //   · 分子分母写反（乘 zoom 写成除 zoom）→ 缩放方向反了，滚轮越滚越远；
  //   · x 与 y 写串、left 与 top 写串 → 画面在斜着跑，方向还「看着挺合理」；
  //   · 锚点缩放里「先算世界坐标再乘新 zoom」写成「先乘再减」→ 缩放中心不再是鼠标处，
  //     而是画面的左上角，鼠标位置越远偏得越多；
  //   · 缩放上下限写成一个数（MIN_ZOOM 当 MAX_ZOOM 用）→ 只能缩小不能放大。
  //
  // 这几种都能过肉眼验收（你很难盯着一个数字说它错了），只能靠算式对拆。
  //
  // 抽之前，同一段「锚点缩放」在 zoomAt 与 applyZoomStep 里**逐字重复**，
  // 「视口中心对应的世界坐标」重复三处（其中一处是 centerOfView()，
  // 另两处没用它、各自又抄了一遍）。这次一并收进这里。
  //
  // 边界切在「只算数，不碰 DOM / 不动画面」：算完把结果交给调用方去写 style、
  // 去排下一次重绘。所以这个文件里没有 window / document，服务端能直接 require。
  //
  // 与 payload-rules.js / utils.js / task-poll.js / history.js / refs.js / layout.js
  // 同一种加载方式：
  //   浏览器：window.CanvasViewport
  //   Node  ：require('../web/assets/viewport.js')
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.CanvasViewport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 缩放上下限。放在这里而不是 canvas.js，是因为「算 zoom 的三处」都要用它，
  // 跟着算式走能保证上下限不会在某一处被漏掉。
  // 原来三处各自引用 canvas.js 里的同名常量，这次一起搬过来。
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 4;

  function clampNum(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // 屏幕坐标 → 世界坐标。
  // 传入的 clientX / clientY 是相对**浏览器视口**的，所以要先减掉画布视口自己
  // 在页面里的偏移 (left / top)，再减平移、最后除缩放。少减一次就会整体偏一格。
  function toWorld(origin, viewport, clientX, clientY) {
    const o = origin || { left: 0, top: 0 };
    const vp = viewport || { x: 0, y: 0, zoom: 1 };
    const zoom = vp.zoom || 1;
    return {
      x: (clientX - o.left - vp.x) / zoom,
      y: (clientY - o.top - vp.y) / zoom,
    };
  }

  // 世界坐标 → 屏幕坐标（toWorld 的逆运算）。
  // 顺序是「先乘 zoom 再加平移，最后加回页面偏移」，正好与 toWorld 倒过来。
  function toScreen(origin, viewport, worldX, worldY) {
    const o = origin || { left: 0, top: 0 };
    const vp = viewport || { x: 0, y: 0, zoom: 1 };
    const zoom = vp.zoom || 1;
    return {
      x: worldX * zoom + vp.x + o.left,
      y: worldY * zoom + vp.y + o.top,
    };
  }

  // 视口中心对应的世界坐标。(viewW / viewH 是可视区的**内容**尺寸，
  // 不是浏览器窗口尺寸 —— 侧栏占掉的那部分不算。)
  function centerOf(viewW, viewH, viewport) {
    const vp = viewport || { x: 0, y: 0, zoom: 1 };
    const zoom = vp.zoom || 1;
    return {
      x: (viewW / 2 - vp.x) / zoom,
      y: (viewH / 2 - vp.y) / zoom,
    };
  }

  // 以某个屏幕点为锚点缩放：缩放前后，锚点下面的世界坐标**原地不动**。
  // 这是滚轮缩放的手感来源，也是这段数学最容易写错的地方 ——
  // 必须「先用旧 zoom 把锚点换成世界坐标，再用新 zoom 把它换回屏幕」。
  //
  // anchorX / anchorY 是相对画布视口的坐标（已经减掉 left / top）。
  function zoomAround(viewport, anchorX, anchorY, factor, nextZoom) {
    const vp = viewport || { x: 0, y: 0, zoom: 1 };
    const zoom = vp.zoom || 1;
    const worldX = (anchorX - vp.x) / zoom;
    const worldY = (anchorY - vp.y) / zoom;
    const next = Number.isFinite(nextZoom)
      ? nextZoom
      : clampNum(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    return {
      zoom: next,
      x: anchorX - worldX * next,
      y: anchorY - worldY * next,
    };
  }

  // 把 zoom 收进合法区间。滚轮连续放大到 4 倍之后就不该再大了。
  function clampZoom(zoom) {
    const value = Number(zoom);
    if (!Number.isFinite(value)) return 1;
    return clampNum(value, MIN_ZOOM, MAX_ZOOM);
  }

  // 由外接矩形算出「刚好框住」的缩放与平移。view 是可视区尺寸。
  // 留出 gap 的边距，剩下的空间按较小的那个比例缩放（长边决定 zoom，短边留白）。
  function fitTransformOf(bounds, view, pad) {
    const gap = Math.max(24, Number(pad) || 70);
    const width = Math.max(60, (Number(view && view.w) || 0) - gap * 2);
    const height = Math.max(60, (Number(view && view.h) || 0) - gap * 2);
    // bounds.w / bounds.h 兜 1：空包围盒或者 0 尺寸的卡片不能让比例算成 Infinity
    const zoom = clampNum(
      Math.min(width / (bounds.w || 1), height / (bounds.h || 1)),
      MIN_ZOOM,
      MAX_ZOOM
    );
    return {
      zoom: zoom,
      x: gap + (width - bounds.w * zoom) / 2 - bounds.minX * zoom,
      y: gap + (height - bounds.h * zoom) / 2 - bounds.minY * zoom,
    };
  }

  // 把某张卡片居中到视口里（缩放不变）。用于「跳到这张卡」这类操作：
  // 不缩放是因为只选一张时若硬拉近或拉远，用户会立刻丢失周边上下文。
  function centerOn(box, node, viewW, viewH, viewport) {
    const vp = viewport || { x: 0, y: 0, zoom: 1 };
    const zoom = Number.isFinite(vp.zoom) && vp.zoom > 0 ? vp.zoom : 1;
    return {
      zoom: zoom,
      x: viewW / 2 - (node.x + box.w / 2) * zoom,
      y: viewH / 2 - (node.y + box.h / 2) * zoom,
    };
  }

  // 按某一个点平移（不缩放）。滚轮缩放之外的「移到这儿」都用它。
  function panTo(worldX, worldY, viewW, viewH, zoom) {
    const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    return {
      x: viewW / 2 - worldX * z,
      y: viewH / 2 - worldY * z,
    };
  }

  return {
    MIN_ZOOM: MIN_ZOOM,
    MAX_ZOOM: MAX_ZOOM,
    toWorld: toWorld,
    toScreen: toScreen,
    centerOf: centerOf,
    clampZoom: clampZoom,
    zoomAround: zoomAround,
    fitTransformOf: fitTransformOf,
    centerOn: centerOn,
    panTo: panTo,
  };
});