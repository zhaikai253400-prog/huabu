(function (root, factory) {
  // 「检查画布更新」的共用小逻辑（托盘入口 → /update 页面，画布页也会记一笔）。
  //
  // 为什么要有这一层：版本号 rev 存在服务端，但「这台电脑上次看到第几版」只有
  // 本机知道。把这件事放进 localStorage 并收成一个模块，两边用同一套键名与判据，
  // 才不会出现「画布页记的键」和「更新页读的键」对不上的问题。
  //
  // 与 utils.js 同一种加载方式：
  //   浏览器：window.CanvasUpdate
  //   Node  ：require('../web/assets/canvas-update.js')
  //
  // 只做本机记录，不发任何请求：检查更新是手动点的，这里绝不轮询。
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.CanvasUpdate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 键名带版本号：以后要换结构，直接换新键，老数据自然失效，不用写迁移。
  const SEEN_KEY = 'canvas.seenRevs.v1';

  function safeStorage(store) {
    // 无痕窗口 / 被策略禁掉时 localStorage 会抛异常。这里吞掉，
    // 让「记不住」退化成「每次都显示还没打开过」，而不是让整个页面挂掉。
    try {
      if (store) return store;
      if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    } catch { /* 拿不到就当没有 */ }
    return null;
  }

  function readAll(store) {
    const bag = safeStorage(store);
    if (!bag) return {};
    try {
      const raw = bag.getItem(SEEN_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch {
      // 存坏了就当成空的：这只是个提示用的记录，不值得为它报错
      return {};
    }
  }

  function writeAll(map, store) {
    const bag = safeStorage(store);
    if (!bag) return false;
    try {
      bag.setItem(SEEN_KEY, JSON.stringify(map));
      return true;
    } catch {
      return false;
    }
  }

  // 记下「这块画布，这台电脑看到过第 rev 版」。
  // 只往大里记：撤销、重新载入旧版本时不该把记录改小，
  // 否则用户明明看过新版，检查更新还会一直提示「有新版本」。
  function rememberSeen(id, rev, store) {
    const key = String(id || '');
    const value = Number(rev);
    if (!key || !Number.isFinite(value) || value < 0) return null;
    const map = readAll(store);
    const old = map[key];
    if (old && Number(old.rev) >= value) return old;
    map[key] = { rev: value, at: Date.now() };
    writeAll(map, store);
    return map[key];
  }

  // 读这台电脑记录过的版本；从没打开过就回 null（和「第 0 版」是两回事）。
  function seenRevOf(id, store) {
    const map = readAll(store);
    const one = map[String(id || '')];
    if (!one) return null;
    const rev = Number(one.rev);
    if (!Number.isFinite(rev) || rev < 0) return null;
    return { rev: rev, at: Number(one.at) || 0 };
  }

  // 比对「本机看过第几版」和「服务端现在是第几版」。
  //
  // 三种结论必须分开，不能合并成一句「有更新」：
  //   never —— 这台电脑没打开过这块画布，说「有新版本」是没有依据的
  //   new   —— 服务端比本机记录的新，说明另一台电脑动过
  //   same  —— 一致
  // 另外 rev 只是个自增计数器，不是「改动条数」，所以只说差几版。
  function compare(id, serverRev, store) {
    const seen = seenRevOf(id, store);
    const theirs = Number(serverRev);
    if (!seen) return { state: 'never', seen: null, theirs: theirs, gap: 0 };
    const gap = (Number.isFinite(theirs) ? theirs : 0) - seen.rev;
    return {
      state: gap > 0 ? 'new' : 'same',
      seen: seen,
      theirs: Number.isFinite(theirs) ? theirs : 0,
      gap: gap > 0 ? gap : 0,
    };
  }

  // 一句话说清结论。放在模块里，是为了画布页和更新页说的是同一句话。
  function describe(result) {
    if (!result || !result.state) return '还不清楚';
    if (result.state === 'never') return '这台电脑还没打开过';
    if (result.state === 'new') return '有新版本 · 新 ' + result.gap + ' 版';
    return '已是最新';
  }

  return {
    SEEN_KEY: SEEN_KEY,
    readAll: readAll,
    rememberSeen: rememberSeen,
    seenRevOf: seenRevOf,
    compare: compare,
    describe: describe,
  };
});
