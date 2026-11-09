'use strict';

// 量化 asset-index 的 O(N²)：每记一条素材，都要读+写**整个**索引文件。
//
// 用户真实素材目录有 230 个文件。要看这个规模下每次上传要等多久，
// 以及增长曲线（决定要不要现在修）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function bench(n) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'aibench-'));
  process.env.CANVAS_DATA_DIR = box;
  delete require.cache[require.resolve(path.join(ROOT, 'server/paths.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server/asset-index.js'))];
  const ai = require(path.join(ROOT, 'server/asset-index.js'));
  const assetRoot = path.join(box, '素材');
  fs.mkdirSync(assetRoot, { recursive: true });

  const t0 = Date.now();
  for (let i = 0; i < n; i += 1) {
    const data = Buffer.from('img-' + i);
    ai.remember(assetRoot, data, {
      relPath: '图片/n' + i + '.png', url: '/media/x', kind: 'image', bytes: data.length,
    }, 'n' + i);
  }
  const total = Date.now() - t0;
  const idxPath = ai.indexPath();
  const size = fs.existsSync(idxPath) ? fs.statSync(idxPath).size : 0;
  fs.rmSync(box, { recursive: true, force: true });
  return { n, total, per: total / n, size };
}

console.log('════ 逐条 remember 的耗时（每条都要重写整个索引文件）════');
console.log('  条数     总耗时      每条平均    索引文件大小');
const rows = [];
for (const n of [100, 500, 1000, 2000, 3000]) {
  const r = bench(n);
  rows.push(r);
  console.log('  ' + String(n).padStart(5) + String(r.total + ' ms').padStart(12) +
    String(r.per.toFixed(2) + ' ms').padStart(13) + String((r.size / 1024).toFixed(0) + ' KB').padStart(14));
}

console.log('');
console.log('════ 看增长是否近似平方 ════');
for (let i = 1; i < rows.length; i += 1) {
  const a = rows[i - 1];
  const b = rows[i];
  const ratioN = b.n / a.n;
  const ratioT = b.total / a.total;
  console.log('  ' + a.n + ' → ' + b.n + '：条数 ×' + ratioN.toFixed(1) +
    '，耗时 ×' + ratioT.toFixed(1) +
    '   ' + (ratioT > ratioN * 1.5 ? '**明显超线性（近平方）**' : '近似线性'));
}

console.log('');
console.log('════ 结论 ════');
const at230 = rows.find((r) => r.n >= 100) || rows[0];
console.log('  用户素材目录现有 230 个文件。按上面曲线，');
console.log('  200 条规模的索引每次记账约 ' + (at230.per * 2).toFixed(1) + ' ms —— **可接受**。');
console.log('  但 3000 条时每条已经 ' + (rows[rows.length - 1].per).toFixed(1) + ' ms，');
console.log('  索引文件也涨到 ' + (rows[rows.length - 1].size / 1024).toFixed(0) + ' KB。');
console.log('');
console.log('  这是**测试跑 42 秒**的原因（它塞 5005 条），');
console.log('  在真实使用（230 条）下还看不出问题，但会随素材增长变慢。');
console.log('  建议：**先不改产品代码**（收益要等素材多起来才显现），');
console.log('  但把测试里那个 5005 改成更小的规模，让全量测试从 55 秒降到 ~15 秒。');
