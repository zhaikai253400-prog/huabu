'use strict';

// 关键数据结构的版本号与迁移表（清单 39）。
//
// 为什么要有这个文件：
//   画布数据是长期躺在用户磁盘上的。卡片类型改过名、字段挪过位置，老数据不会
//   自己跟着变。历史上这类兼容是零散的 —— canvas.js 里散着 migrateNode()、
//   renumberAll()、migrateScheduleContainers()、prunePromptHeights() 四五个函数，
//   各自为政。结果是：
//     · 谁也不知道一份数据当前「是什么年代的」；
//     · 加一处兼容要在两个文件里找位置，漏一处就有一类老数据被静默丢掉；
//     · 迁移是「每次打开都跑一遍」，跑十次和跑一次的区别没人验证过。
//
// 本模块把这件事收拢成一条明确的线：
//
//   1. 每个节点的 data 上带一个整数 CURRENT_VER；
//   2. 迁移表 MIGRATIONS 里按版本号逐级登记「从 v 升到 v+1 要做什么」；
//   3. migrateNodeData() 按号逐级往上跑，跑完盖上目标版本号；
//   4. 幂等由构造保证：每一步都只看「有没有旧痕迹」，有就修、没有就跳过；
//      版本号已经是当前的节点直接原样返回，不会重跑、也不会被改写。
//
// 已经跑过的节点下一次打开是「读版本号 → 相等 → 返回」三步，零成本。
//
// 关于「可回退」：每一次真正改动数据的迁移，都必须在调用方先留一份备份
// （见 index.js 里 migrateCanvasData 的用法：改之前先 backup.forceSnapshot）。
// 迁移本身只做「老字段 → 新字段」的加法与改名，不删用户内容，
// 所以拿着迁移前的备份就能原样退回去。

// 当前数据版本。加一次不兼容的改动就 +1，并在 MIGRATIONS 里补一条。
const CURRENT_VER = 1;

// 关于「画布级版本号」的取舍：
//
// 方案里给了两个选项 —— canvases 表加一列 schema_ver，或者在 nodes.data 里存 v。
// 这里只做节点级，理由是两个版本号会各说各话：
//   一块画布打开时，服务端按节点逐个判断要不要迁移，判断依据只能是节点自己的号；
//   画布级那个号既不能替节点做决定（同一块画布上可以有新卡和老卡混着），
//   又要额外维护「什么时候该涨、涨了以后老节点怎么办」，多出来的只有对不齐的机会。
// 一个号、一个真相，够用。

// 节点内部几种「装着别的卡片编号」的结构的版本号。
//
// 这些东西的共同点：它们的形状一变（比如从数组改成映射、键从编号改成 id），
// 老数据就会静默失效 —— 组合散架、@ 引用指空，而且不报错。
// 给它们各自记一个号，将来改形状时就有明确的落点，而不用去猜
// 「用户手里这份 members 到底是哪种排布」。
const SUB_VERS = {
  groupMembers: 1,  // data.members（组合的成员编号数组）
  quickRefs: 1,     // data.quickRefs（快速视频的「编号 → 卡片」映射）
  scheduleRefs: 1,  // data.order / data.perCard / data.snapshots（定时组的成员引用）
};
// 定时组的「大容器」布局另有一个号，由前端的 SCHEDULE_LAYOUT_VERSION 管，
// 那是显示布局的事（组框怎么摆），跟数据形状不是一回事，这里不重复登记。

// 卡片类型改名表：老版本里存在的类型 → 现在对应的类型。
// 注意 migrateNode 里那套「未知类型一律当图片」的兜底仍然保留，
// 这里管的是「有明确新家」的那几个，语义上比兜底更准。
const LEGACY_TYPES = {
  prompt: 'image',   // 老「提示词卡片」：一个写字的框，现在就是图片卡的提示词
  material: 'image', // 老「素材卡片」
  generate: 'video', // 老「生成卡片」：当年就是出视频的
};

// 老字段 → 新字段。只在「新字段为空」时才搬，绝不覆盖用户已经填好的新值。
const RENAMED_FIELDS = [
  ['prompt', 'text'],
];

// 迁移步骤表：key 是「升级前的版本号」，值是把它升到 key+1 的函数。
// 函数返回 true 表示这一遍确实动了数据。
//
// 写这一步时的两条纪律：
//   · 只看旧痕迹决定要不要动，不看「版本号对不对」——幂等靠这个；
//   · 只做加法与改名，不删用户内容。
const MIGRATIONS = {
  // 0 → 1：把老卡片类型归一，补齐新增字段的默认值。
  // 老字段搬家不在这里 —— 那件事由 cleanLegacyFields 无条件负责，
  // 放两处只会让「到底谁清的」变成一笔糊涂账。
  0: function upToOne(node) {
    const data = node && node.data && typeof node.data === 'object' ? node.data : null;
    if (!data) return false;
    let changed = false;
    // 类型归一：这一步只认「有明确新家」的那几个；
    // 完全不认识的类型交给前端既有的兜底逻辑，这里不猜。
    const type = String(node.type || '');
    if (Object.prototype.hasOwnProperty.call(LEGACY_TYPES, type)) {
      node.type = LEGACY_TYPES[type];
      changed = true;
    }
    // 补齐几个「缺了就当成 false」的布尔字段。它们本来就靠 undefined 当 false 用，
    // 显式写出来是为了让导出的数据自解释，也让老数据和新数据长得一样。
    ['sized', 'locked', 'hidden'].forEach((key) => {
      if (typeof data[key] === 'boolean') return;
      data[key] = Boolean(data[key]);
      changed = true;
    });
    return changed;
  },
};

// 一份数据的版本号。没写过的按 0 算 —— 老数据本来就没这个字段。
function versionOf(node) {
  const data = node && node.data && typeof node.data === 'object' ? node.data : null;
  if (!data) return 0;
  const raw = Number(data.v);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  // 比当前版本还高的数据（用户装过更新的版本、后来又退回来了）不认，
  // 原样留着不动 —— 硬往下「降级」只会把不认识的新字段抹掉。
  return Math.floor(raw);
}

// 把一张卡片升到当前版本。返回 true 表示真的改过东西（调用方据此决定要不要存盘）。
//
// 传进来的 node 会被就地修改（和 store.saveState 里的处理方式一致），
// 因为迁移的调用点都在「马上就要整块写回」的位置。
//
// 版本号只用来挡「按版本逐级升级」的那部分（类型归一、补默认值）。
// **废字段清理不挡** —— 这里踩过坑：废字段清理如果也放在版本号里面，
// 那么一个「已经盖了当前版本号、但身上还挂着老字段」的节点就永远清不干净，
// 而这种情况是真实存在的：前端读到卡片的瞬间就会给它盖号，
// 盖章和清理之间只隔几行代码，一旦顺序变了就漏。废字段就那么几个，
// 每次扫一遍是几次 hasOwnProperty，比「想清楚顺序」便宜得多。
function migrateNodeData(node) {
  if (!node || typeof node !== 'object') return false;
  if (!node.data || typeof node.data !== 'object' || Array.isArray(node.data)) node.data = {};
  let changed = cleanLegacyFields(node);
  const from = versionOf(node);
  if (from >= CURRENT_VER) return changed;
  for (let v = from; v < CURRENT_VER; v += 1) {
    const step = MIGRATIONS[v];
    if (typeof step !== 'function') continue;
    if (step(node) === true) changed = true;
  }
  node.data.v = CURRENT_VER;
  return true;
}

// 清掉已经改名、现在没人读的老字段。搬到新字段只在「新字段为空」时发生，
// 绝不覆盖用户在新版里填好的内容。返回 true 表示动过。
function cleanLegacyFields(node) {
  const data = node && node.data && typeof node.data === 'object' ? node.data : null;
  if (!data) return false;
  let changed = false;
  RENAMED_FIELDS.forEach((pair) => {
    const from = pair[0];
    const to = pair[1];
    if (!Object.prototype.hasOwnProperty.call(data, from)) return;
    const legacy = data[from];
    const hasNew = typeof data[to] === 'string' && data[to] !== '';
    if (!hasNew && legacy != null && String(legacy) !== '') data[to] = String(legacy);
    delete data[from];
    changed = true;
  });
  return changed;
}

// 整块画布的迁移。返回 { changed, nodes }：changed=false 时调用方一个字都不用写。
//
// 这条路径是「批量修老数据」，所以额外做两件事：
//   · 已经是最新的节点原样返回，连字段顺序都不动（避免无意义的存盘）；
//   · 统计每一类修了多少张，返回给调用方写日志 —— 迁移是少数「用户看不见但动了
//     他数据」的操作，必须有据可查。
function migrateCanvasData(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const changes = { type: 0, field: 0, stamp: 0 };
  let changed = false;
  list.forEach((node) => {
    const beforeVer = versionOf(node);
    const beforeType = String(node.type || '');
    const beforeKeys = node.data && typeof node.data === 'object' ? Object.keys(node.data).join(',') : '';
    if (!migrateNodeData(node)) return;
    changed = true;
    if (String(node.type || '') !== beforeType) changes.type += 1;
    const afterKeys = node.data && typeof node.data === 'object' ? Object.keys(node.data).join(',') : '';
    if (beforeKeys !== afterKeys) changes.field += 1;
    if (beforeVer < CURRENT_VER) changes.stamp += 1;
  });
  return { changed: changed, changes: changes, nodes: list };
}

module.exports = {
  CURRENT_VER,
  SUB_VERS,
  LEGACY_TYPES,
  RENAMED_FIELDS,
  MIGRATIONS,
  versionOf,
  cleanLegacyFields,
  migrateNodeData,
  migrateCanvasData,
};
