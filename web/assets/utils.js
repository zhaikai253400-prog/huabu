(function (root, factory) {
  // 全站零散小工具的唯一出处（清单 38「拆分 canvas.js」第 1 步）。
  //
  // 为什么先拆这一块：它是耦合度最低的一层 —— 纯函数、不碰 DOM、不读数据、
  // 不依赖任何运行时状态。抽它不会引入新风险，却能把散在各处的重复实现收成一份。
  //
  // 收拢的依据是实测出来的重复，不是为了整齐：
  //   · 「把时间补成两位」这一个函数在 8 个文件里各写了一遍（canvas/channels/
  //     chstatus/library/portal/tasks 都有），而且分成两种写法 ——
  //     String(n).padStart(2,'0') 和 n < 10 ? '0' + n : String(n)。
  //     对 0~99 这两种完全等价，分成两派纯粹是各写各的；
  //   · clamp 在 canvas.js 和 director.js 各有一份，逐字相同。
  //
  // 与 payload-rules.js 同一种加载方式：
  //   浏览器：window.CanvasUtils
  //   Node  ：require('../web/assets/utils.js')
  // 每个使用点都保留等价兜底，老页面缓存里还没有这个脚本时也不会整页打不开。
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.CanvasUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 把数字补成两位。原来是 8 处各自的 const pad。
  //
  // 注意语义边界：只补不截。传 100 出来还是 '100'，传 -1 出来是 '-1'。
  // 这一点必须保持 —— 有人拿它补月份（1~12）、有人补毫秒（0~999，本来就该是 3 位）。
  // 所以不做 String(n).slice(-2) 那种「看起来更安全」的处理。
  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  // 夹在 [min, max] 之间。canvas.js 与 director.js 原来各有一份逐字相同的实现。
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // 数字兜底：不是有限数就回落到 fallback。
  //
  // 注意 null / '' 要单独挡：Number(null) 是 0、Number('') 也是 0，都是有限数，
  // 不挡的话「这个字段没填」会被当成「值是 0」。写坐标时 0 和「没填」差得很远 ——
  // 0 会把卡片摆到原点，没填则应该用调用方给的默认位置。
  function num(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  // 取整兜底：NaN / Infinity 一律回到 fallback，避免把 NaN 写进样式或坐标。
  function int(value, fallback) {
    return Math.round(num(value, fallback));
  }

  // 把各种输入统一成一个 Date。认不出来就返回 null —— 由各函数决定怎么表示「没有」。
  //
  // 这里不能用 `new Date(Number(value) || Date.now())` 那种看起来省事的写法：
  // 空串的 Number() 是 0（→ 1970 年），坏字符串的 Number() 是 NaN（→ 被 || 兜成「现在」），
  // 两种都会把「这份数据的时间是坏的」悄悄伪装成一个正常时间。
  // 历史版本、任务列表这类地方如果拿到假时间，用户会以为备份是刚生成的。
  function toDate(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (value == null || value === '') return null;
    const raw = typeof value === 'number' ? value : String(value).trim();
    if (raw === '') return null;
    const n = Number(raw);
    const d = Number.isFinite(n) ? new Date(n) : new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // 本地时间戳，形如 2026-11-03_01-55-48-123。
  //
  // 服务端 backup.js / library.js / assets.js 各有一份 stampName（只到秒），
  // 前端多用的是「时:分:秒」。这里把两者收成一组，前端与将来的调用点共用。
  // ms 为 true 时补 3 位毫秒 —— 同一秒内可能连着写两份文件，不补会互相覆盖。
  function stamp(date, withMs, withDate) {
    const d = toDate(date == null ? Date.now() : date);
    if (!d) return '';
    const time = pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
    const ms = withMs ? '-' + String(d.getMilliseconds()).padStart(3, '0') : '';
    if (!withDate) return time + ms;
    return (
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '_' + time + ms
    );
  }

  // 时:分:秒 —— 日志、任务耗时这类地方用得最多的一种。
  function clockTime(value) {
    const d = toDate(value == null ? Date.now() : value);
    if (!d) return '';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  // 月-日 时:分 —— 列表里显示某件事发生在什么时候。
  function shortStamp(value) {
    const d = toDate(value == null ? Date.now() : value);
    if (!d) return '';
    return (
      pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    );
  }

  // 年-月-日 时:分 —— 需要写清年份的场合（历史版本、备份列表）。
  function fullStamp(value) {
    const d = toDate(value == null ? Date.now() : value);
    if (!d) return '';
    return (
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    );
  }

  // 字节数说成人话。素材库里给文件标体积用。
  function humanSize(bytes) {
    const n = num(bytes, 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  // 把一段文字截到 n 个字，超出补省略号。中文按字数算就够用，
  // 不引入「东亚字符算两个宽」那套复杂规则 —— 这里的用途都是 UI 提示，不需要精确。
  function clip(text, max) {
    const value = String(text == null ? '' : text);
    const limit = Math.max(0, Math.floor(num(max, 0)));
    if (!limit || value.length <= limit) return value;
    return value.slice(0, limit) + '…';
  }

  // 量一个字符串在等宽场景下的显示宽度（中文算 2、其余算 1）。
  // 卡片标题、标签这类要按「看起来多宽」来截的地方用。
  function textWidth(text) {
    const value = String(text == null ? '' : text);
    let width = 0;
    for (let i = 0; i < value.length; i += 1) {
      width += value.charCodeAt(i) > 0x2e80 ? 2 : 1;
    }
    return width;
  }

  // 按「看起来的宽度」截断，尽量不把中文从中间劈开。
  function clipByWidth(text, maxWidth) {
    const value = String(text == null ? '' : text);
    const limit = Math.max(0, Math.floor(num(maxWidth, 0)));
    if (!limit) return value;
    let width = 0;
    let out = '';
    for (let i = 0; i < value.length; i += 1) {
      const w = value.charCodeAt(i) > 0x2e80 ? 2 : 1;
      if (width + w > limit) return out + '…';
      width += w;
      out += value[i];
    }
    return out;
  }

  // 防抖：拖拽、输入、滚动这类高频动作统一走它。
  // 返回的函数带 cancel()，组件卸载或状态变了要能叫停。
  function debounce(fn, wait) {
    let timer = 0;
    const wrapped = function () {
      const args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = 0;
        fn.apply(null, args);
      }, Math.max(0, num(wait, 120)));
    };
    wrapped.cancel = function () {
      if (!timer) return false;
      clearTimeout(timer);
      timer = 0;
      return true;
    };
    wrapped.pending = function () {
      return Boolean(timer);
    };
    return wrapped;
  }

  // 节流：第一次立刻跑，之后按间隔放行。
  // 与防抖的取舍：要「过程里也响应」用节流（拖拽预览），要「停下来才算」用防抖（存盘）。
  function throttle(fn, wait) {
    let last = 0;
    const gap = Math.max(0, num(wait, 120));
    return function () {
      const nowAt = Date.now();
      if (last && nowAt - last < gap) return false;
      last = nowAt;
      fn.apply(null, arguments);
      return true;
    };
  }

  return {
    pad2: pad2,
    clamp: clamp,
    num: num,
    int: int,
    stamp: stamp,
    clockTime: clockTime,
    shortStamp: shortStamp,
    fullStamp: fullStamp,
    humanSize: humanSize,
    clip: clip,
    textWidth: textWidth,
    clipByWidth: clipByWidth,
    debounce: debounce,
    throttle: throttle,
  };
});
