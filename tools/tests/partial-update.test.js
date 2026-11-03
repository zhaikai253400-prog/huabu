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
const calls = { media: 0, status: 0, title: 0, panel: 0, index: 0, hover: 0 };

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
    'function buildIndexBadge(node) { buildCalls.index += 1; var b = el("node-index"); return b; }',
    'function buildPanel(node, data, preset, host) { buildCalls.panel += 1; return el("node-panel"); }',
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
    '  wrapper.appendChild(buildIndexBadge(node));',
    '  wrapper.appendChild(buildTitleTag(node, node.data));',
    '  wrapper.appendChild(buildPanel(node, node.data, presetOf(node.type), wrapper));',
    '  return wrapper;',
    '}',
    // 把生产代码里的两个函数抠进来（它们引用的名字在沙箱里都有替身）
    pickFunction('directChildOf'),
    pickFunction('replaceMediaPart'),
    pickFunction('replaceStatusPart'),
    pickFunction('replaceTitlePart'),
    pickFunction('replacePanelPart'),
    pickFunction('refreshNodeParts'),
    pickFunction('refreshNode'),
    // 生产代码里 elements 是模块内的 Map，沙箱里换成两个访问函数来模拟
    'globalThis.__refreshNodeParts = refreshNodeParts;',
    'globalThis.__refreshNode = refreshNode;',
    'globalThis.__directChildOf = directChildOf;',
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
sandbox.window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
sandbox.document.createRange = () => ({ selectNodeContents() {}, collapse() {} });
// mentionEl / mentionNode / mentionBox 这些模块级变量在沙箱里也要有
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
function buildAndMount(node) {
  sandbox.__node = node;
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

console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
