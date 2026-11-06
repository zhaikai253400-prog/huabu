'use strict';

// E1 卡片局部更新（清单 32 + 33）的隔离测试。
//
// 要守住的两件事：
//   1. refreshNode(node, parts) 给 parts 时「只碰列出的区块」，没列出的区块
//      —— 尤其是媒体区里的 <img> / <video> —— 必须是原来那个 DOM 节点，
//      不能被替换掉（元素被替换 = 图片重新解码、视频重新缓冲、正在放的视频中断）。
//   2. 不给 parts 时行为与从前完全一样（整卡重建），否则 47 个还没迁移的
//      调用点会一起变行为，风险太大。
//
// 前端是 IIFE，函数取不出来，所以这里把 refreshNode / refreshNodeParts 与它们
// 依赖的区块函数抠进沙箱，用一份「像 DOM 的最小替身」跑，直接断言「哪个节点被换了」。
//
// 运行：runtime/node.exe tools/tests/partial-update.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

// 隔离：本测试只跑纯逻辑，不碰数据库，仍走统一助手保持范式一致
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-partial-'));
require(path.join(__dirname, '_isolate.js'))(box);

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

const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');

function pickFunction(name) {
  const at = canvasSrc.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('源码里找不到函数 ' + name);
  let depth = 0;
  let started = false;
  for (let i = at; i < canvasSrc.length; i += 1) {
    const ch = canvasSrc[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return canvasSrc.slice(at, i + 1);
    }
  }
  throw new Error('函数 ' + name + ' 的花括号没配对');
}

// ---------- 一份「像 DOM 的最小替身」 ----------
// 只需要 refreshNodeParts 用到的那些方法：children / classList / style /
// replaceWith / insertBefore / querySelector / appendChild / remove / contains
let nodeSeq = 0;
function makeEl(className) {
  nodeSeq += 1;
  const el = {
    __id: nodeSeq,
    className: className || '',
    children: [],
    style: {},
    dataset: {},
    classList: {
      _set: new Set(String(className || '').split(/\s+/).filter(Boolean)),
      contains(name) {
        return this._set.has(name);
      },
      add(name) {
        this._set.add(name);
      },
      remove(name) {
        this._set.delete(name);
      },
      toggle(name, on) {
        if (on === undefined) {
          if (this._set.has(name)) this._set.delete(name);
          else this._set.add(name);
          return;
        }
        if (on) this._set.add(name);
        else this._set.delete(name);
      },
    },
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parentNode = this;
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at < 0) this.children.push(child);
      else this.children.splice(at, 0, child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      const at = this.parentNode.children.indexOf(this);
      if (at >= 0) this.parentNode.children.splice(at, 1);
      this.parentNode = null;
    },
    replaceWith(next) {
      const parent = this.parentNode;
      if (!parent) return;
      const at = parent.children.indexOf(this);
      if (at >= 0) parent.children.splice(at, 1, next);
      next.parentNode = parent;
      this.parentNode = null;
    },
    contains(target) {
      if (target === this) return true;
      return this.children.some((child) => child.contains && child.contains(target));
    },
    querySelector(sel) {
      const list = this.querySelectorAll(sel);
      return list.length ? list[0] : null;
    },
    querySelectorAll(sel) {
      const out = [];
      const wanted = String(sel).trim();
      const walk = (el) => {
        el.children.forEach((child) => {
          if (matches(child, wanted)) out.push(child);
          walk(child);
        });
      };
      walk(this);
      return out;
    },
  };
  return el;
}
// 只支持最简单的选择器：单个类名 .a、逗号分隔的一串 .a, .b、标签名 img
function matches(el, sel) {
  const parts = String(sel).split(',').map((one) => one.trim());
  return parts.some((part) => {
    if (!part) return false;
    if (part.startsWith('.')) return el.classList.contains(part.slice(1));
    return el.className.split(/\s+/).indexOf(part) >= 0;
  });
}

// ---------- 沙箱 ----------
const sandbox = {
  console: console,
  Array: Array,
  Object: Object,
  String: String,
  Number: Number,
  Boolean: Boolean,
  Math: Math,
};
vm.createContext(sandbox);

// 记录「区块构建函数被调用了几次」，用来验证哪个区块真的被重建了
const calls = { media: 0, status: 0, title: 0, strip: 0, panel: 0, index: 0, hover: 0 };

vm.runInContext(
  [
    'var buildCalls = globalThis.__calls;',
    'function el(cls) { return globalThis.__makeEl(cls); }',
    // 各区块构造成一个带标记元素：带 .node-media / .node-title-tag / .node-panel 类，
    // 且内部挂一个「媒体元素」用来验证有没有被换掉
    'function buildMedia(node, data, preset) {',
    '  buildCalls.media += 1;',
    '  var box = el("node-media");',
    '  var img = el("media-img");',
    '  img.setAttribute = function (k, v) { this[k] = v; };',
    '  img.getAttribute = function (k) { return this[k]; };',
    '  img.src = String((data.result && data.result.url) || "");',
    '  box.appendChild(img);',
    '  return box;',
    '}',
    'function ensureStatusBox(containerEl, data, node) {',
    '  buildCalls.status += 1;',
    '  var found = containerEl.querySelector(".node-status");',
    '  if (found) return found;',
    '  var made = el("node-status");',
    '  containerEl.appendChild(made);',
    '  return made;',
    '}',
    'function bindStatusToggle() {}',
    'function paintStatusBox() {}',
    'function taskStateText(data) { return data.running ? "在跑" : data.error || ""; }',
    'function buildTitleTag(node, data) { buildCalls.title += 1; return el("node-title-tag"); }',
    'function buildTitleStrip(node, data) { buildCalls.strip += 1; var s = el("node-headstrip"); s.appendChild(buildIndexBadge(node)); s.appendChild(buildTitleTag(node, data)); return s; }',
    'function buildIndexBadge(node) { buildCalls.index += 1; var b = el("node-index"); return b; }',
    'function buildPanel(node, data, preset, host) { buildCalls.panel += 1; var p = el("node-panel"); if (globalThis.__panelHook) globalThis.__panelHook(p); return p; }',
    'function placePanel() {}',
    'function refreshHoverBar() { buildCalls.hover += 1; }',
    'function sizeOf(node) { return { w: node.w || 100, h: node.h || 100 }; }',
    'function presetOf(type) { return { label: type }; }',
    'function nodeData(node) { return node.data; }',
    'function isLocked(node) { return Boolean(node.data && node.data.locked); }',
    'function isHidden(node) { return Boolean(node.data && node.data.hidden); }',
    // refreshNodeParts 里会把「收起来的区域」这个类跟着一起切（F1）。
    // 这里给个与生产语义一致的替身：type 为 zone 才算区域。
    'function isZone(node) { return Boolean(node && node.type === "zone"); }',
    'function isTaskActive(data) { return Boolean(data && (data.running || data.preparing)); }',
    'function elements_get(id) { return globalThis.__elements.get(id); }',
    'function elements_set(id, v) { globalThis.__elements.set(id, v); }',
    'function paintFilter() {}',
    'function refreshSelection() {}',
    // 这里原本还摆着 syncPromptEditorRefs / syncPromptEditorParams / syncPromptEditorTail
    // 三个空替身，因为 refreshNodeParts / refreshNode 里有三处调用它们。
    // 后来查出那三个函数是一簇「同生共死的闭链」（promptEditorTailEl 永远是 null，
    // 调用等价于空转），已从生产代码整簇删除 —— 调用点没了，替身自然也不该留。
    // 留着反而危险：哪天有人把调用加回来，这里有个现成替身接着，测试照样全绿。
    'function closeMention() {}',
    'function openMention() {}',
    'function buildNode(node) {',
    '  var wrapper = el("node");',
    '  wrapper.dataset = { id: node.id, type: node.type };',
    '  wrapper.appendChild(buildMedia(node, node.data, presetOf(node.type)));',
    '  wrapper.appendChild(buildTitleStrip(node, node.data));',
    // 与生产一致：只有展开的那张才建面板，其余卡片不背 35 个隐藏子元素
    '  if (node.id === expandedId) wrapper.appendChild(buildPanel(node, node.data, presetOf(node.type), wrapper));',
    '  return wrapper;',
    '}',
    // 把生产代码里的两个函数抠进来（它们引用的名字在沙箱里都有替身）
    pickFunction('directChildOf'),
    pickFunction('ensurePanel'),
    pickFunction('replaceMediaPart'),
    pickFunction('replaceStatusPart'),
    pickFunction('replaceTitlePart'),
    'var promptCaretMuteUntil = new WeakMap();',
    pickFunction('mutePromptCaretFollow'),
    pickFunction('promptScrollSnapshot'),
    pickFunction('restorePromptScrollSnapshot'),
    pickFunction('replacePanelPart'),
    pickFunction('paintRunButton'),
    pickFunction('focusPrompt'),
    pickFunction('refreshNodeParts'),
    pickFunction('refreshNode'),
    // 生产代码里 elements 是模块内的 Map，沙箱里换成两个访问函数来模拟
    'globalThis.__refreshNodeParts = refreshNodeParts;',
    'globalThis.__refreshNode = refreshNode;',
    'globalThis.__directChildOf = directChildOf;',
    'globalThis.__ensurePanel = ensurePanel;',
    'globalThis.__buildNode = buildNode;',
  ].join('\n'),
  // pickFunction 出来的代码里用了 elements.get / elements.set，喂一个 Map 进去
  Object.assign(sandbox, {
    __calls: calls,
    __makeEl: makeEl,
    __elements: new Map(),
  })
);
// elements 与 refreshNode 里对它的用法对齐（Map 本身就有 get/set/forEach）
sandbox.elements = sandbox.__elements;
// replacePanelPart 会看 document.activeElement 判断「是不是正在打字」
sandbox.document = { activeElement: null };
// 一个能反映「当前到底选没选中东西」的选区替身：
// collapsed 为 true 时 toString() 必须是空串，测试就靠这个判定「没有全选」。
sandbox.__selection = { ranges: [], removeAllRanges() { this.ranges = []; }, addRange(r) { this.ranges = [r]; }, get rangeCount() { return this.ranges.length; }, getRangeAt(i) { return this.ranges[i]; }, toString() { const r = this.ranges[0]; return r && !r.collapsed ? String(r.text || '') : ''; } };
sandbox.window = {
  getSelection: () => sandbox.__selection,
  // 还原提示词滚动位置时会排一帧再贴一次，沙箱里同步执行即可
  requestAnimationFrame: (fn) => { fn(); return 0; },
};
sandbox.document.createRange = () => {
  const range = {
    collapsed: false,
    text: '',
    startContainer: null,
    startOffset: 0,
    selectNodeContents(el) { this.startContainer = el; this.text = el.textContent || ''; this.collapsed = false; },
    setStart(el, offset) { this.startContainer = el; this.startOffset = offset; this.collapsed = false; },
    collapse(toEnd) { this.collapsed = true; this.text = ''; this.__toEnd = Boolean(toEnd); },
  };
  return range;
};
// mentionEl / mentionNode / mentionBox 这些模块级变量在沙箱里也要有
// 共享模式的两个模块级开关：refreshNode 里会读它们
// （applyingRemote：正在装远端内容，不回写 DOM；remoteStale 标记挂在元素 dataset 上）
sandbox.applyingRemote = false;
sandbox.mentionEl = null;
sandbox.mentionNode = null;
sandbox.mentionBox = null;
sandbox.mentionStale = false;
sandbox.expandedId = null;

function makeNode(id, url) {
  return { id: id, type: 'image', x: 0, y: 0, w: 360, h: 240, data: { result: url ? { url: url } : null, params: {} } };
}
function mount(node) {
  const el = sandbox.__refreshNode ? null : null;
  const built = vm.runInContext('buildNode(' + JSON.stringify(node) + ')', sandbox);
  // buildNode 里读的是 node 对象，但 JSON 传进去会丢 data 引用；改用直接调用
  return built;
}
// 上面那种把 node 序列化进沙箱的办法会丢引用，这里改成把节点挂到沙箱上再调用
function buildAndMount(node, options) {
  sandbox.__node = node;
  // 既有测试都假设「面板已经在」：默认把这张卡当成展开态来建。
  // 要测懒建 / 收起态时传 { expanded: false }。
  sandbox.expandedId = options && options.expanded === false ? null : node.id;
  const built = vm.runInContext('buildNode(__node)', sandbox);
  sandbox.__elements.set(node.id, built);
  // 卡片需要有个父节点，replaceWith 才有意义
  const host = makeEl('canvas-world');
  host.appendChild(built);
  return built;
}

console.log('\nE1 · 按区块刷新：只碰列出的区块');

check('只刷状态：媒体区那个 <img> 节点没被换掉', () => {
  const node = makeNode('n1', '/media/a.png');
  const el = buildAndMount(node);
  const imgBefore = el.querySelector('.node-media').children[0];
  const mediaBefore = el.querySelector('.node-media');
  const before = { media: calls.media, title: calls.title, panel: calls.panel };
  sandbox.__refreshNode(node, ['status']);
  const imgAfter = el.querySelector('.node-media').children[0];
  eq(el.querySelector('.node-media'), mediaBefore, '媒体区整个不该被换');
  eq(imgAfter, imgBefore, '图片节点必须是原来那个');
  eq(calls.media, before.media, 'buildMedia 不该被调用');
  eq(calls.title, before.title, '标题不该被碰');
  eq(calls.panel, before.panel, '面板不该被碰');
});

check('只刷标题：媒体区与面板都不动', () => {
  const node = makeNode('n2', '/media/b.png');
  const el = buildAndMount(node);
  const mediaBefore = el.querySelector('.node-media');
  const panelBefore = el.querySelector('.node-panel');
  const before = { media: calls.media, panel: calls.panel };
  sandbox.__refreshNode(node, ['title']);
  eq(el.querySelector('.node-media'), mediaBefore, '媒体区不该被换');
  eq(el.querySelector('.node-panel'), panelBefore, '面板不该被换');
  eq(calls.media, before.media);
  eq(calls.panel, before.panel);
  assert(el.querySelector('.node-title-tag') !== null, '标题牌还该在');
});

check('只刷面板：媒体区不动（这是「改参数时视频不黑闪」的关键）', () => {
  const node = makeNode('n3', '/media/c.png');
  const el = buildAndMount(node);
  const mediaBefore = el.querySelector('.node-media');
  const imgBefore = el.querySelector('.node-media').children[0];
  const before = { media: calls.media };
  sandbox.__refreshNode(node, ['panel']);
  eq(el.querySelector('.node-media'), mediaBefore, '媒体区不该被换');
  eq(el.querySelector('.node-media').children[0], imgBefore, '图片节点不该被换');
  eq(calls.media, before.media, 'buildMedia 不该被调用');
  assert(calls.panel > 0, '面板该被重建');
});

check('刷媒体 + 状态：媒体区换了（结果 URL 变了本来就得换）', () => {
  const node = makeNode('n4', '/media/d.png');
  const el = buildAndMount(node);
  const mediaBefore = el.querySelector('.node-media');
  const before = { media: calls.media };
  sandbox.__refreshNode(node, ['media', 'status']);
  assert(el.querySelector('.node-media') !== mediaBefore, '结果换了，媒体区该重建');
  assert(calls.media > before.media, 'buildMedia 该被调用');
});

check('同时列出 title + panel 时两个都刷', () => {
  const node = makeNode('n5', '/media/e.png');
  const el = buildAndMount(node);
  const titleBefore = el.querySelector('.node-title-tag');
  const panelBefore = el.querySelector('.node-panel');
  sandbox.__refreshNode(node, ['title', 'panel']);
  assert(el.querySelector('.node-title-tag') !== titleBefore, '标题该重画');
  assert(el.querySelector('.node-panel') !== panelBefore, '面板该重画');
});

check('刷了 media 时不重复刷 status（状态框随媒体区一起新建了）', () => {
  const node = makeNode('n6', '/media/f.png');
  buildAndMount(node);
  calls.status = 0;
  sandbox.__refreshNode(node, ['media', 'status']);
  eq(calls.status, 0, '媒体区重建已经带上状态框，不该再单独刷一次');
});

check('hover 能单独刷（提示词改完只更新那条窄条）', () => {
  const node = makeNode('n7', '/media/g.png');
  const el = buildAndMount(node);
  const mediaBefore = el.querySelector('.node-media');
  calls.hover = 0;
  sandbox.__refreshNode(node, ['hover']);
  eq(calls.hover, 1, '该刷新悬停条');
  eq(el.querySelector('.node-media'), mediaBefore, '媒体区仍然不动');
});

check('空的 parts 数组退回整卡重建（不是「什么都不做」）', () => {
  const node = makeNode('n8', '/media/h.png');
  const el = buildAndMount(node);
  const host = el.parentNode;
  const mediaBefore = el.querySelector('.node-media');
  sandbox.__refreshNode(node, []);
  const now = sandbox.__elements.get('n8');
  assert(now !== el, '空数组该当成「没指定」→ 整卡重建');
  assert(now.querySelector('.node-media') !== mediaBefore, '整卡重建后媒体区是新的');
  assert(host.children.indexOf(now) >= 0, '新卡片该挂回原来的位置');
});

console.log('\nE1 · 不传 parts：行为与从前一致（整卡重建）');

check('不传 parts 时整卡重建，元素被换掉', () => {
  const node = makeNode('n9', '/media/i.png');
  const el = buildAndMount(node);
  const host = el.parentNode;
  const before = el.__id;
  sandbox.__refreshNode(node);
  const now = sandbox.__elements.get('n9');
  assert(now.__id !== before, '该是一个新元素');
  assert(host.children.indexOf(now) >= 0, '新元素该在原来父节点下');
  eq(host.children.length, 1, '旧元素该被换掉，不是并排留着');
});

check('不传 parts 时 elements 映射指向新元素（后续按 id 取到的才会是对的）', () => {
  const node = makeNode('n10', '/media/j.png');
  buildAndMount(node);
  sandbox.__refreshNode(node);
  const now = sandbox.__elements.get('n10');
  assert(now && now.classList.contains('node'), '映射该指向卡片元素');
});

check('卡片不存在时什么都不做，也不抛错', () => {
  const node = makeNode('n-missing', '/media/k.png');
  // 不 mount
  sandbox.__refreshNode(node, ['status']);
  sandbox.__refreshNode(node);
  assert(true, '没抛错就算过');
});

console.log('\nE1 · 编辑面板按需构建');

check('未展开的卡片不建面板（300 张卡省掉 35 个子元素/张）', () => {
  const node = makeNode('n-lazy-1', '/media/lazy1.png');
  const before = calls.panel;
  const el = buildAndMount(node, { expanded: false });
  eq(calls.panel, before, '收起态不该调用 buildPanel');
  eq(el.querySelector('.node-panel'), null, '收起态不该有 .node-panel');
});

check('展开时 ensurePanel 现场补建，且只建一次', () => {
  const node = makeNode('n-lazy-2', '/media/lazy2.png');
  const el = buildAndMount(node, { expanded: false });
  const before = calls.panel;
  const panel = sandbox.__ensurePanel(el, node);
  assert(panel && panel.classList.contains('node-panel'), '该补出一块面板');
  eq(calls.panel, before + 1, 'buildPanel 该被调用一次');
  const again = sandbox.__ensurePanel(el, node);
  eq(again, panel, '重复调用必须复用同一块面板');
  eq(calls.panel, before + 1, '复用时不该再建');
});

check('补建的面板插在端口 / 拉伸把手之前，DOM 顺序与整卡构建一致', () => {
  const node = makeNode('n-lazy-3', '/media/lazy3.png');
  const el = buildAndMount(node, { expanded: false });
  const port = el.appendChild(makeEl('port'));
  sandbox.__ensurePanel(el, node);
  const classes = el.children.map((one) => one.className);
  const panelAt = classes.indexOf('node-panel');
  const portAt = classes.indexOf('port');
  assert(panelAt >= 0, '面板该在');
  assert(portAt >= 0, '端口该在');
  assert(panelAt < portAt, '面板该排在端口前面，实际 ' + classes.join(' | '));
});

check('生产 buildNode 也只在展开时建面板', () => {
  const at = canvasSrc.indexOf('function buildNode(node)');
  assert(at >= 0, '缺少 buildNode');
  const body = canvasSrc.slice(at, at + 4000);
  assert(body.indexOf('if (node.id === expandedId) el.appendChild(buildPanel(') >= 0, '该按 expandedId 条件建面板');
});

console.log('\nE1 · 布局样式顺手同步');

check('把 parts 刷新时也带上尺寸与生成中标记（这些是轻量的样式更新）', () => {
  const node = makeNode('n11', '/media/l.png');
  const el = buildAndMount(node);
  node.w = 500;
  node.h = 300;
  node.data.running = true;
  sandbox.__refreshNode(node, ['status']);
  eq(el.style.width, '500px', '宽度该跟着节点走');
  eq(el.style.height, '300px', '高度该跟着节点走');
  assert(el.classList.contains('is-generating'), '生成中标记该补上');
});

check('跑完之后标记要摘掉', () => {
  const node = makeNode('n12', '/media/m.png');
  const el = buildAndMount(node);
  node.data.running = true;
  sandbox.__refreshNode(node, ['status']);
  assert(el.classList.contains('is-generating'));
  node.data.running = false;
  sandbox.__refreshNode(node, ['status']);
  assert(!el.classList.contains('is-generating'), '不该留在「生成中」的样子');
});

check('锁定的卡片刷新时带上锁定类', () => {
  const node = makeNode('n13', '/media/n.png');
  const el = buildAndMount(node);
  node.data.locked = true;
  sandbox.__refreshNode(node, ['status']);
  assert(el.classList.contains('is-locked'));
});

console.log('\nE1 · 关键调用点已迁移（源码级约束）');

check('refreshNode 支持按区块刷新，且不传 parts 时保持旧行为', () => {
  const at = canvasSrc.indexOf('function refreshNode(node, parts)');
  assert(at >= 0, 'refreshNode 该收 parts 参数');
  const body = canvasSrc.slice(at, at + 400);
  assert(body.indexOf('Array.isArray(parts)') >= 0, '该判断 parts 是不是数组');
  assert(body.indexOf('refreshNodeParts(node, parts)') >= 0, '该转到按区块刷新');
  assert(canvasSrc.indexOf('function refreshNodeParts(') >= 0, '缺少按区块刷新的实现');
});

check('区块函数一共五个：media / status / title / panel / hover', () => {
  ['replaceMediaPart', 'replaceStatusPart', 'replaceTitlePart', 'replacePanelPart'].forEach((name) => {
    assert(canvasSrc.indexOf('function ' + name + '(') >= 0, '缺少 ' + name);
  });
  const at = canvasSrc.indexOf('function refreshNodeParts(');
  const body = canvasSrc.slice(at, at + 1800);
  ["'media'", "'status'", "'title'", "'panel'", "'hover'"].forEach((part) => {
    assert(body.indexOf(part) >= 0, '没接上区块 ' + part);
  });
});

check('「只改状态」的调用点已改成按区块刷（进度 / 失败 / 取消 这些高频路径）', () => {
  // 任务失败
  const failAt = canvasSrc.indexOf('function failTask(');
  assert(failAt >= 0, '缺少 failTask');
  const failBody = canvasSrc.slice(failAt, failAt + 900);
  assert(failBody.indexOf("refreshNode(node, ['status'])") >= 0, '失败只该刷状态');

  // 提交失败
  const subAt = canvasSrc.indexOf('async function submitGenerate(');
  const subBody = canvasSrc.slice(subAt, subAt + 4200);
  assert(subBody.indexOf("refreshNode(node, ['status'])") >= 0, '提交失败只该刷状态');

  // 取消
  const cancelAt = canvasSrc.indexOf('async function cancelGenerate(');
  const cancelBody = canvasSrc.slice(cancelAt, cancelAt + 1200);
  assert(cancelBody.indexOf("refreshNode(node, ['status'])") >= 0, '取消只该刷状态');
});

check('出结果时按「URL 有没有变」决定要不要换媒体区', () => {
  const at = canvasSrc.indexOf('function applyTaskResult(');
  assert(at >= 0, '缺少 applyTaskResult');
  const body = canvasSrc.slice(at, at + 5000);
  assert(body.indexOf('urlChanged') >= 0, '该判断 URL 有没有变');
  assert(body.indexOf("refreshNode(node, ['status', 'panel'])") >= 0, 'URL 没变时只刷状态与面板');
});

check('改标题只刷标题 / 面板 / 悬停条，不动媒体区', () => {
  const at = canvasSrc.indexOf('function commitRename(');
  assert(at >= 0, '缺少 commitRename');
  const body = canvasSrc.slice(at, at + 700);
  assert(body.indexOf("refreshNode(node, ['title', 'panel', 'hover'])") >= 0, '改标题不该重建整张卡片');
  assert(body.indexOf('refreshNode(node)') < 0, '不该退回整卡重建');
});

check('媒体区重建时先等新图解码好再换（不黑闪）', () => {
  const at = canvasSrc.indexOf('function replaceMediaPart(');
  assert(at >= 0, '缺少 replaceMediaPart');
  const body = canvasSrc.slice(at, at + 1600);
  assert(body.indexOf('complete') >= 0, '该判断新图有没有解码完');
  assert(body.indexOf("addEventListener('load'") >= 0, '该等 load 事件');
  assert(body.indexOf("addEventListener('error'") >= 0, '加载失败也要能换进去，不能永远卡着');
});

check('面板正在打字时不动（免得光标被打断）', () => {
  const at = canvasSrc.indexOf('function replacePanelPart(');
  const body = canvasSrc.slice(at, at + 400);
  assert(body.indexOf('activeElement') >= 0, '该判断有没有正在输入');
});

check('按区块查找用直接子元素，不往下钻（避免命中面板里的同名元素）', () => {
  const at = canvasSrc.indexOf('function directChildOf(');
  assert(at >= 0, '缺少 directChildOf');
  const body = canvasSrc.slice(at, at + 300);
  assert(body.indexOf('el.children') >= 0, '该只看直接子元素');
  assert(body.indexOf('querySelector') < 0, '不该用会往下钻的选择器');
});

check('产出说明（区块划分）写在源码里，后续迁移有据可依', () => {
  const at = canvasSrc.indexOf('卡片各区块的「按需重建」');
  assert(at >= 0, '缺少说明注释');
  const body = canvasSrc.slice(at, at + 1400);
  assert(body.indexOf('media') >= 0 && body.indexOf('status') >= 0 && body.indexOf('panel') >= 0, '说明该列出区块');
  assert(body.indexOf('47 个调用点') >= 0 || body.indexOf('调用点') >= 0, '该说明迁移策略');
});


console.log('\nE2 · 生成按钮跟着任务状态走（失败后不能停在「取消生成」）');

// 卡片里挂一个真的按钮，模拟 buildActions 建出来的那颗
function mountWithRunButton(node, running) {
  const el = buildAndMount(node);
  const run = makeEl('primary btn-run');
  run.tagName = 'BUTTON';
  run.disabled = false;
  run.textContent = running ? '取消生成' : '生成';
  if (running) run.classList.add('cancel');
  el.appendChild(run);
  return { el: el, run: run };
}

check('任务失败后只刷状态区，按钮也要回到「生成」', () => {
  const node = makeNode('n-btn-1', '/media/x.png');
  node.data.running = true;
  const host = mountWithRunButton(node, true);
  eq(host.run.textContent, '取消生成', '前置条件：正在跑时按钮是取消态');
  node.data.running = false;
  node.data.error = '通道密钥不对';
  sandbox.__refreshNode(node, ['status']);
  eq(host.run.textContent, '生成', '失败后按钮必须换回「生成」');
  eq(host.run.classList.contains('cancel'), false, '取消态的样式要摘掉');
  eq(host.run.disabled, false, '失败后按钮要能再点');
});

check('任务跑完 / 被取消后按钮也回到「生成」', () => {
  const node = makeNode('n-btn-2', '/media/y.png');
  node.data.running = true;
  const host = mountWithRunButton(node, true);
  node.data.running = false;
  sandbox.__refreshNode(node, ['status']);
  eq(host.run.textContent, '生成', '跑完或取消后按钮该是「生成」');
});

check('准备中按钮显示「准备中…」且暂时不可点', () => {
  const node = makeNode('n-btn-3', '/media/z.png');
  const host = mountWithRunButton(node, false);
  node.data.preparing = '正在检查参考素材…';
  sandbox.__refreshNode(node, ['status']);
  eq(host.run.textContent, '准备中…', '准备中该显示进度文案');
  eq(host.run.disabled, true, '准备中不该被重复点击');
  node.data.preparing = '';
  sandbox.__refreshNode(node, ['status']);
  eq(host.run.textContent, '生成', '准备结束要回到「生成」');
  eq(host.run.disabled, false, '准备结束后可以再点');
});

console.log('\nE3 · 面板重绘要保住提示词滚动位置（连入卡片时不跳回顶部）');

// 造一个「长提示词框」：滚到 120px，可滚范围 800px
function withPromptScroll(el, top, scrollHeight, clientHeight) {
  const box = makeEl('node-prompt');
  box.scrollTop = top;
  box.scrollHeight = scrollHeight;
  box.clientHeight = clientHeight;
  el.appendChild(box);
  return box;
}

check('只换面板时，新提示词框接着停在原来的位置', () => {
  const node = makeNode('n-scroll-1', '/media/s.png');
  const el = buildAndMount(node);
  // 提示词框在面板里（生产结构就是这样）
  const oldBox = withPromptScroll(el.querySelector('.node-panel'), 120, 1000, 200);
  // 新面板里也是同一份长提示词（同样的内容高度）
  sandbox.__panelHook = (panel) => {
    const fresh = makeEl('node-prompt');
    fresh.scrollHeight = 1000;
    fresh.clientHeight = 200;
    fresh.scrollTop = 0;
    panel.appendChild(fresh);
    sandbox.__lastBox = fresh;
  };
  sandbox.__refreshNode(node, ['panel']);
  sandbox.__panelHook = null;
  const newBox = el.querySelector('.node-panel').querySelector('.node-prompt');
  assert(newBox !== oldBox, '面板该换成新的提示词框');
  assert(oldBox !== newBox, '旧提示词框该被换掉');
  eq(newBox.scrollTop, 120, '连入卡片后面板重绘，不该跳回顶部');
});

check('滚动快照按像素还原；框高变了再按比例', () => {
  const host = makeEl('node-host');
  const box = makeEl('node-prompt');
  box.scrollTop = 300;
  box.scrollHeight = 1000;
  box.clientHeight = 200;
  host.appendChild(box);
  const snap = vm.runInContext('promptScrollSnapshot', sandbox)(host);
  eq(snap.top, 300, '快照要记下当前像素位置');
  eq(snap.max, 800, '快照要记下可滚范围');

  // 同样的框：按像素原样贴回
  box.scrollTop = 0;
  vm.runInContext('restorePromptScrollSnapshot', sandbox)(host, snap);
  eq(box.scrollTop, 300, '框高没变时按像素还原');

  // 框变高（可滚范围 400）：按比例 -> 300/800*400 = 150
  box.scrollHeight = 600;
  box.scrollTop = 0;
  vm.runInContext('restorePromptScrollSnapshot', sandbox)(host, snap);
  eq(Math.round(box.scrollTop), 150, '框高变了按比例还原，别跳到框外');
});

console.log('\nE4 · 展开提示词只能放光标，绝不能整段选中');

// 造一张展开的卡片：卡片里有 .node-prompt，内容是一段长提示词
function mountPromptCard(id, text) {
  const node = makeNode(id, '/media/p.png');
  const el = makeEl('node');
  el.dataset = { id: node.id, type: node.type };
  const panel = makeEl('node-panel');
  const box = makeEl('node-prompt');
  box.textContent = text;
  box.scrollTop = 0;
  box.scrollHeight = 1000;
  box.clientHeight = 200;
  box.focused = 0;
  box.focus = function () { this.focused += 1; };
  panel.appendChild(box);
  el.appendChild(panel);
  sandbox.__elements.set(node.id, el);
  sandbox.__node = node;
  return { node, el, box };
}

check('点「展开」后没有被选中的文字（手一抖不会全删）', () => {
  const { node, box } = mountPromptCard('n-focus-1', '一只橘猫坐在窗台上，午后的光从左边照进来');
  sandbox.__selection.ranges = [];
  vm.runInContext('focusPrompt', sandbox)(node);
  eq(box.focused, 1, '提示词框应该拿到焦点');
  eq(sandbox.__selection.toString(), '', '展开后不能有任何被选中的文字');
  eq(sandbox.__selection.getRangeAt(0).collapsed, true, '光标必须是折叠状态');
  eq(sandbox.__selection.getRangeAt(0).__toEnd, false, 'collapse(false) = 折叠到末尾，接着往下写');
});

check('用户自己选了一段：展开时原样保留，不被抢走', () => {
  const { node, box } = mountPromptCard('n-focus-2', '前半段后半段');
  box.textContent = '前半段后半段';
  sandbox.__selection.ranges = [];
  vm.runInContext('focusPrompt', sandbox)(node);
  // 用户手动选了中间一段
  const custom = { collapsed: false, text: '半段后', startContainer: box, startOffset: 1 };
  sandbox.__selection.ranges = [custom];
  vm.runInContext('focusPrompt', sandbox)(node);
  eq(sandbox.__selection.getRangeAt(0), custom, '已经在框内的选区不该被重置');
  eq(box.focused, 2, '依然要把焦点给它');
});

check('展开时用户正在看的那一段不能被顶走', () => {
  const { node, box } = mountPromptCard('n-focus-3', '很长很长的提示词');
  box.scrollTop = 260;
  sandbox.__selection.ranges = [];
  vm.runInContext('focusPrompt', sandbox)(node, { keepScroll: true });
  // 快照在 focus 之前取，focus 引起的「光标跟随」会把框滚到末尾，
  // 必须再贴回 260，否则展开一下就看到最后一行了。
  eq(box.scrollTop, 260, '展开前后滚动位置要一样');
  eq(sandbox.__selection.toString(), '', '还原滚动也不能顺手全选');
});

console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
