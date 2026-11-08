(function (root, factory) {
  // 前后端共享的纯规则模块：不碰 DOM、不读数据库、不依赖任何运行时，
  // 所以浏览器直接 <script> 加载、服务端直接 require 都行。
  //   浏览器：window.CanvasPayloadRules
  //   Node  ：require('../web/assets/payload-rules.js')
  //
  // 为什么放在 web/assets 下而不是 server/：服务端的静态文件服务只放行
  // web 目录，放这里浏览器就能拿到同一份源码，不用为它开一条特殊路由。
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.CanvasPayloadRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 视频卡片的三种模式。图片 / 音频没有模式概念，统一归一成空串。
  const MODES = ['reference', 'frames', 'text'];

  // 只有这两种卡片支持尾部提示词（对应前端的 TAIL_KINDS）
  const TAIL_KINDS = { video: 1, quick: 1 };

  function kindOf(nodeType) {
    const type = String(nodeType || 'image');
    // 快速视频在接口眼里就是视频
    return type === 'quick' ? 'video' : type;
  }

  function isTailKind(nodeType) {
    return Boolean(TAIL_KINDS[String(nodeType || '')]);
  }

  // 模式归一化 —— 本次统一的核心。
  // 之前三条路各写各的：单卡传 ''、定时组快照传 'reference'、服务端再兜一次 'reference'，
  // 结果同一张卡片在通道模板里拿到的 {{mode}} 可能一个是空串、一个是 reference。
  function normalizeMode(nodeType, rawMode) {
    const kind = kindOf(nodeType);
    // 图片 / 音频不接受模式，硬塞值会让通道模板里的判断走偏。
    //
    // 判据必须是「**视频这一类**」，不能借用 isTailKind（「支持不支持尾部提示词」）——
    // 那两件事本来无关，绑在一起会出事：给图片卡加上尾部提示词之后，
    // isTailKind('image') 变成 true，这行就不再提前返回，图片的 mode
    // 会一路走到最后被填成 'reference'（本该是空串），
    // 于是通道模板里的 {{mode}} 判断走偏 —— 正是这个文件开头统一过的那个 bug。
    if (kind !== 'video') return '';
    if (nodeType === 'quick') return 'reference';
    const value = String(rawMode == null ? '' : rawMode);
    return MODES.indexOf(value) >= 0 ? value : 'reference';
  }

  // 张数：接口最多一次 4 张，最少 1 张。服务端本来就卡 1~4，这里提到共用层
  function clampCount(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(4, n);
  }

  function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function toText(value) {
    return String(value == null ? '' : value);
  }

  // 参考素材只留接口要的四个字段，顺带把没有地址的剔掉
  function normalizeRefs(list) {
    return (Array.isArray(list) ? list : [])
      .filter((item) => item && (item.url || item.src))
      .map((item) => ({
        url: toText(item.url || item.src),
        kind: toText(item.kind),
        name: toText(item.name),
        role: toText(item.role),
      }));
  }

  // 尾部提示词选择。服务端 generate.js 里原来有一份一模一样的实现，
  // 现在两边都走这里，避免「前端认 true、服务端只认对象」这类漂移。
  function normalizeTailChoice(value) {
    if (value === true) return { enabled: true, presetId: '' };
    if (value === false || value == null) return { enabled: false, presetId: '' };
    if (typeof value !== 'object') return { enabled: false, presetId: '' };
    return { enabled: value.enabled !== false, presetId: toText(value.presetId) };
  }

  // 把「卡片语义字段」装配成提交 payload。
  // 三条入口（单卡 / 批量 / 定时组）都从这里出，参数规则就只有一份了。
  //
  // input 允许两种写法：
  //   params 里放卡片上的参数（来自 node.data.params）
  //   或直接把 sizeKey / ratio / count ... 平铺写在顶层
  function assemble(input) {
    const src = input && typeof input === 'object' ? input : {};
    const nodeType = toText(src.nodeType || 'image');
    const params = src.params && typeof src.params === 'object' ? src.params : {};
    const pick = (flat, key) => (src[flat] != null ? src[flat] : params[key]);
    const tailOn = isTailKind(nodeType);

    const out = {
      canvasId: toText(src.canvasId),
      nodeId: toText(src.nodeId),
      kind: kindOf(nodeType),
      prompt: toText(src.prompt),
      promptRaw: toText(src.promptRaw == null ? src.prompt : src.promptRaw),
      model: toText(src.model),
      channelId: toText(src.channelId),
      sizeKey: toText(pick('sizeKey', 'size')),
      ratio: toText(pick('ratio', 'ratio')),
      count: clampCount(pick('count', 'count')),
      duration: toNumber(pick('duration', 'duration')),
      resolution: toText(pick('resolution', 'resolution')),
      mode: normalizeMode(nodeType, pick('mode', 'mode')),
      refs: normalizeRefs(src.refs),
      // 不支持尾部的卡片一律关掉，别让旧数据里的残留字段漏出去
      tailPrompt: tailOn ? normalizeTailChoice(src.tailPrompt) : { enabled: false, presetId: '' },
    };
    // 通道名是可选的：单卡提交靠 channelId 找通道，定时组多带一份名字用于日志
    if (src.channelName != null) out.channelName = toText(src.channelName);
    return out;
  }

  return {
    MODES: MODES,
    TAIL_KINDS: TAIL_KINDS,
    kindOf: kindOf,
    isTailKind: isTailKind,
    normalizeMode: normalizeMode,
    normalizeRefs: normalizeRefs,
    normalizeTailChoice: normalizeTailChoice,
    clampCount: clampCount,
    assemble: assemble,
  };
});
