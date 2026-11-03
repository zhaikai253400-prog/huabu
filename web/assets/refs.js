(function (root, factory) {
  // 提示词里的 @ 引用语法（清单 38「拆分 canvas.js」第 4 步）。
  //
  // 这一块为什么值得单独成文件：**同一个正则原来在 11 个地方各写了一遍**
  // （换号、摘引用、显示、还原胶囊、快速视频取素材、组合名输入框、送接口…），
  // 服务端的 generate.js 里还有第 12 份。它们全都长这样：
  //
  //     /@\[([^\]\n]+)\]/g
  //
  // 抄这么多遍的真正风险不是啰嗦，而是**这套语法有两个容易写错的点**，任何一处抄错
  // 都不报错、只是在某些数据上悄悄算错：
  //
  //   1. 「快速视频」必须排在「视频」前面。用 /@(视频|快速视频)(\d+)/ 这种顺序去匹配
  //      「@快速视频1」，会先撞上「视频」→ 认成「视频1」→ 用户引的是快速视频，
  //      系统却去找一张普通视频卡。这个错在只有普通视频的画布上永远复现不了。
  //   2. 内部写法 @[图1] 与给人看的写法 @图1 是两种文本，得能互相转换，
  //      而且「还原成给人看的」不能把本来就在里的 @ 搞成两个。
  //
  // 所以这里收的不是「共用的函数」，是**一套语法**：正则、写法、识别、转换。
  //
  // 与 payload-rules.js / utils.js / task-poll.js / history.js 同一种加载方式：
  //   浏览器：window.CanvasRefs
  //   Node  ：require('../web/assets/refs.js')
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.CanvasRefs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 内部写法的正则**每次新建一个实例**。带 /g 的正则是有状态的（lastIndex 记住
  // 上次位置），共用一个实例会让「交替调用」的场景漏掉匹配 —— 这类 bug 在测试里
  // 很容易蒙混过去，所以在源头就堵住。
  // 需要自己逐段处理（比如渲染胶囊要按下标切片）时用 rawPattern()。
  function rawPattern() {
    return /@\[([^\]\n]+)\]/g;
  }

  // 遍历内部写法，把每个标签交给回调。
  // 这是唯一一处碰正则的地方，回调只关心「这个标签要怎么办」。
  function eachRaw(text, visit) {
    const source = String(text == null ? '' : text);
    if (source.indexOf('@[') < 0) return false; // 绝大多数提示词里没有引用，先跳过
    let hit = false;
    const re = rawPattern();
    let match;
    while ((match = re.exec(source)) !== null) {
      hit = true;
      visit(match[1], match[0], match.index);
    }
    return hit;
  }

  // 把每个标签重写一遍：map 返回字符串就替换，返回空 / 假值就保留原样
  function mapRaw(text, mapper) {
    const source = String(text == null ? '' : text);
    if (source.indexOf('@[') < 0) return source;
    return source.replace(rawPattern(), (all, tag) => {
      const next = mapper(tag);
      return typeof next === 'string' ? next : all;
    });
  }

  // 提示词里出现的所有标签，按出现顺序、去重
  function tagsOf(text) {
    const out = [];
    eachRaw(text, (tag) => {
      if (out.indexOf(tag) < 0) out.push(tag);
    });
    return out;
  }

  // ---------- 二、给人看的写法：@图1 ----------
  // 类型词按长度从长到短排，「快速视频」必须在「视频」前面（见文件头第 1 点）。
  // 用非捕获组：这里只要认出整段，取的是 kind + num。
  const SHOWN_RE = () => /@(快速视频|视频|音频|图)(\d+)/g;

  // 给人看：@[图1] → @图1
  function toShown(text) {
    return mapRaw(text, (tag) => '@' + tag);
  }

  // 反过来：@图1 → @[图1]，但只认 known 里真实存在的标签。
  // 不认的保持原样 —— 用户可能就是在写一句带 @ 的普通文字，
  // 随手把它变成引用会让素材条上多出一张他没想用的图。
  function toRaw(text, known) {
    const source = String(text == null ? '' : text);
    if (source.indexOf('@') < 0) return source;
    const live = known instanceof Set ? known : new Set(Array.isArray(known) ? known : []);
    return source.replace(SHOWN_RE(), (all, kind, num) => {
      const tag = kind + num;
      return live.has(tag) ? '@[' + tag + ']' : all;
    });
  }

  // 从一段文字里认出引用标签：先按内部写法找，找不到再按给人看的写法找。
  // 用于「用户手打的 @图1」也要能当成引用处理（快速视频卡片走的就是这条路）。
  function parse(text, known) {
    const raw = tagsOf(text);
    if (raw.length) return raw;
    const source = String(text == null ? '' : text);
    if (source.indexOf('@') < 0) return [];
    const live = known instanceof Set ? known : new Set(Array.isArray(known) ? known : []);
    const out = [];
    const re = SHOWN_RE();
    let match;
    while ((match = re.exec(source)) !== null) {
      const tag = match[1] + match[2];
      if (live.size && !live.has(tag)) continue;
      if (out.indexOf(tag) < 0) out.push(tag);
    }
    return out;
  }

  // ---------- 三、编号变了 / 素材没了 ----------

  // 换号：给一张「旧号 → 新号」的表，把提示词里的引用一起换过去。
  // 没有对应新号的保持原样（那张素材这次没动）—— 注意这里要返回**非字符串**
  // 才能让 mapRaw 保留原文；返回 '' 会被当成「替换成空」，引用直接消失。
  function retag(text, renamed) {
    const map = renamed instanceof Map ? renamed : new Map(Object.entries(renamed || {}));
    if (!map.size) return String(text == null ? '' : text);
    return mapRaw(text, (tag) => {
      const to = map.get(tag);
      return to ? '@[' + to + ']' : null;
    });
  }

  // 换号（给人看的写法）：定时组快照里存的是 `@图1` 这种文字，也要跟着换。
  // 与上面那条只差「认哪种写法」，映射表是同一张。
  function retagShown(text, renamed) {
    const map = renamed instanceof Map ? renamed : new Map(Object.entries(renamed || {}));
    const source = String(text == null ? '' : text);
    if (!map.size || source.indexOf('@') < 0) return source;
    return source.replace(SHOWN_RE(), (all, kind, num) => {
      const to = map.get(kind + num);
      return to ? '@' + to : all;
    });
  }

  // 摘掉指向「已经没了的素材」的引用。两种写法都要摘：
  // 卡片正文存的是内部写法，定时组快照里存的「给人看」的写法。
  // 摘完会剩下多余空格（`用 和 @[图2] 合成` → `用 和 合成`），
  // 所以顺手把连续空格收成一个、去掉首尾 —— 但只收「两个及以上」，
  // 单个空格是用户自己排的版，别动。
  function tidy(text) {
    return String(text == null ? '' : text)
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 返回 null 表示「没有引用被摘掉」，调用方据此跳过写回（免得平白标一次已修改）
  function strip(text, gone, style) {
    const dead = gone instanceof Set ? gone : new Set(Array.isArray(gone) ? gone : []);
    if (!dead.size) return null;
    const source = String(text == null ? '' : text);
    let hit = false;
    const mode = style === 'shown' ? 'shown' : 'raw';
    const next = source.replace(mode === 'shown' ? SHOWN_RE() : rawPattern(), (all, one, two) => {
      // 两种写法的捕获组不一样：内部写法只有 1 组（标签），
      // 给人看的有 2 组（类型词 + 编号），得拼回来才是标签
      const tag = mode === 'shown' ? one + two : one;
      if (!dead.has(tag)) return all;
      hit = true;
      return '';
    });
    return hit ? tidy(next) : null;
  }

  // 把提示词里的引用**全部**抹掉，只剩正文。
  // 导出文件名那种场合要的不是「摘掉某个编号」，而是「别让 @[图1] 进文件名」。
  // 这里用 `*` 而不是 `+`：`@[]` 这种空壳也要一并抹掉。
  function dropAll(text, filler) {
    const source = String(text == null ? '' : text);
    if (source.indexOf('@[') < 0) return source;
    return source.replace(/@\[[^\]\n]*\]/g, typeof filler === 'string' ? filler : '');
  }

  // 提示词里有哪些引用是「已经失效」的：known 是当前真实存在的标签
  function broken(text, known) {
    const live = known instanceof Set ? known : new Set(Array.isArray(known) ? known : []);
    const out = [];
    eachRaw(text, (tag) => {
      if (!live.has(tag) && out.indexOf(tag) < 0) out.push(tag);
    });
    return out;
  }

  // 切换成「只有标签本身」的中文类型词，供 @ 菜单筛选时对前缀用
  // （「@快」这种半截类型：按字符串前缀比，不涉及正则）
  function startsWithTag(tag, token) {
    if (!token) return true;
    return String(tag || '').indexOf(String(token)) === 0;
  }

  // ---------- 四、送接口前的收拾 ----------
  // 平台不认识 @[图1]：去掉方括号与 @，只留「图1」这样的名字；
  // 剩下零散的「@图」这种半截引用也一并去掉，别让平台看见一个孤零零的 @。
  function forApi(text) {
    return String(text == null ? '' : text)
      .replace(rawPattern(), (all, tag) => String(tag).replace(/^@+/, '').trim())
      .replace(/@(?=[图视音])/g, '');
  }

  return {
    rawPattern: rawPattern,
    eachRaw: eachRaw,
    mapRaw: mapRaw,
    tagsOf: tagsOf,
    toShown: toShown,
    toRaw: toRaw,
    parse: parse,
    retag: retag,
    retagShown: retagShown,
    strip: strip,
    dropAll: dropAll,
    tidy: tidy,
    broken: broken,
    startsWithTag: startsWithTag,
    forApi: forApi,
  };
});