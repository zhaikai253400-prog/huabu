'use strict';

// E4 性能基准（清单 36）的自检。
//
// 基准脚本本身也是代码，也会写错。这里不跑真实基准（那要几分钟且依赖 Chrome），
// 只守几件「写错了就白跑一场」的事：
//   1. 隔离没做对 —— 基准会把几百张测试卡片灌进真实 data/canvas.db 里（最严重的一条）；
//   2. 测量表达式结尾漏了调用括号 —— 只算出一个函数对象、没执行，
//      以前就这样静默测出过一次 undefined，白折腾半天；
//   3. 节点 id 没带档位前缀 —— 三档画布共用一个库，store 会给重复 id 改名，
//      第二档开始按 id 找卡片就全部落空；
//   4. 结果确实写成了文件、含四类指标。
//
// 运行：runtime/node.exe tools/tests/bench-script.test.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-bench-test-'));
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

const src = fs.readFileSync(path.join(ROOT, 'tools', 'bench', 'run.js'), 'utf8');

console.log('E4 · 基准脚本必须有 README 说明用法');
check('tools/bench/README.md 在', () => {
  assert(fs.existsSync(path.join(ROOT, 'tools', 'bench', 'README.md')), '缺 README.md');
});
check('README 讲了「只在同一台机器上比」', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'tools', 'bench', 'README.md'), 'utf8');
  assert(readme.indexOf('同一台机器') >= 0, '没提醒跨机器不可比');
  assert(readme.indexOf('对比') >= 0, '没讲清楚这个脚本的价值在对比');
});

console.log('E4 · 隔离：绝不能往真实 data/canvas.db 里写测试数据');

check('数据目录走 CANVAS_DATA_DIR，用的是临时副本', () => {
  assert(src.indexOf('CANVAS_DATA_DIR: dataDir') >= 0, '没有通过 CANVAS_DATA_DIR 指定隔离目录');
  assert(src.indexOf('mkdtempSync') >= 0, '没有建临时目录');
});
check('把 web / server 复制到临时目录后再起服务', () => {
  assert(src.indexOf("fs.cpSync(path.join(ROOT, sub)") >= 0, '没有复制代码到临时目录');
});
check('端口与真实服务错开（不占用 8080 之类的常用口）', () => {
  const m = src.match(/const PORT = (\d+);/);
  assert(m, '找不到 PORT 定义');
  const port = Number(m[1]);
  assert(port > 17000, '基准用的端口 ' + port + ' 太靠近常用端口了，可能撞上真实服务');
});
check('没有直接引用真实 data 目录', () => {
  assert(src.indexOf("path.join(ROOT, 'data')") < 0, '脚本直接引用了项目的真实 data 目录');
});

console.log('E4 · 测量表达式结尾必须真的调用');

check('注入的观察脚本自己会调用（IIFE 结尾有 ()）', () => {
  const at = src.indexOf('const OPEN_WATCHER');
  const body = src.slice(at, at + 1200);
  assert(body.indexOf('})();') >= 0, 'OPEN_WATCHER 结尾没有调用括号');
});
check('四个测量表达式的调用形态正确（不会只算出函数）', () => {
  // MEASURE_OPEN 不需要参数，写在源码里就直接调用；
  // 另外三个要传参（轮数 / 档位前缀），所以自身以 }) 收尾、由调用处拼上参数。
  // 这里逐个核对形态，避免「谁被改成只算出一个函数对象」这种静默失效。
  const openSrc = src.slice(src.indexOf('const MEASURE_OPEN'), src.indexOf('`;', src.indexOf('const MEASURE_OPEN'))).trim();
  assert(openSrc.endsWith('})()'), 'MEASURE_OPEN 结尾应是 })()（自己调用）');
  ['MEASURE_FRAMES', 'MEASURE_REPARAM', 'MEASURE_EXPAND'].forEach((name) => {
    const at = src.indexOf('const ' + name);
    assert(at >= 0, '找不到 ' + name);
    const body = src.slice(at, src.indexOf('`;', at)).trim();
    assert(body.endsWith('})'), name + ' 应以 }) 收尾（参数由调用处拼）');
  });
  // 调用处必须真的拼了参数并执行
  assert(src.indexOf('MEASURE_FRAMES + \'(40)\'') >= 0, 'MEASURE_FRAMES 调用处没传轮数');
  assert(src.indexOf('MEASURE_REPARAM + \'("\' + prefix + \'")\'') >= 0, 'MEASURE_REPARAM 调用处没传前缀');
  assert(src.indexOf('MEASURE_EXPAND + \'("\' + prefix + \'")\'') >= 0, 'MEASURE_EXPAND 调用处没传前缀');
});
check('eval 助手会把「只算出函数」当成错误拦住', () => {
  assert(src.indexOf("type === 'function'") >= 0, '没有拦「表达式只算出函数」这种情况');
  assert(src.indexOf('没执行') >= 0, '错误提示没说清楚原因');
});

console.log('E4 · 造测试数据：节点 id 必须带档位前缀');

check('buildState 接收 tag 并用它做 id 前缀', () => {
  const at = src.indexOf('function buildState(');
  assert(at >= 0, '找不到 buildState');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert(body.indexOf('prefix') >= 0, 'buildState 没用前缀');
  assert(body.indexOf("prefix + 'n' + i") >= 0, '节点 id 没带前缀');
});
check('调用时传了不同的前缀给不同档位', () => {
  assert(src.indexOf("buildState(count, 'b' + count)") >= 0, '调用时没有按档位传前缀');
  assert(src.indexOf("const prefix = 'b' + count + '_'") >= 0, '没有算出前缀');
});
check('测量时按前缀找卡片，不是写死 n0 / n1', () => {
  const reparam = src.slice(src.indexOf('const MEASURE_REPARAM'), src.indexOf('const MEASURE_EXPAND'));
  assert(reparam.indexOf("prefix + 'n0'") >= 0, '改参数测量没按前缀找卡片');
  const expand = src.slice(src.indexOf('const MEASURE_EXPAND'), src.indexOf('async function measureOne'));
  assert(expand.indexOf("prefix + 'n1'") >= 0, '展开测量没按前缀找卡片');
});
check('buildState 在沙箱里跑出来的 id 确实带前缀', () => {
  // 把 buildState 抠出来直接跑，确认前缀真的体现在 id 上
  const at = src.indexOf('function buildState(');
  let depth = 0;
  let started = false;
  let end = -1;
  for (let i = at; i < src.length; i += 1) {
    if (src[i] === '{') { depth += 1; started = true; }
    else if (src[i] === '}') { depth -= 1; if (started && depth === 0) { end = i + 1; break; } }
  }
  const fnSrc = src.slice(at, end);
  // TINY_PNG 是跨行定义（值在下一行）。注意不能直接找 ';'——
  // base64 前缀里就有「png;base64」这个分号，会被提前截断。
  const tinyAt = src.indexOf('const TINY_PNG');
  const valAt = src.indexOf("'data:image/png;base64", tinyAt);
  assert(valAt > 0, 'TINY_PNG 没找到值');
  const tinyEnd = src.indexOf("';", valAt) + 2;
  const tinySrc = src.slice(tinyAt, tinyEnd);
  assert(tinySrc.indexOf('data:image/png;base64') > 0, 'TINY_PNG 没取到实际内容');
  assert(tinySrc.trim().endsWith("';"), 'TINY_PNG 切片没取完整');
  const sandbox = { Date: Date, Math: Math, Number: Number, String: String, Object: Object };
  vm.createContext(sandbox);
  vm.runInContext(tinySrc + '\n' + fnSrc + '\nvar out = buildState(5, "b30");', sandbox);
  const out = vm.runInContext('out', sandbox);
  eq(out.nodes.length, 5);
  assert(out.nodes.every((one) => one.id.indexOf('b30_') === 0), 'id 没有带上档位前缀：' + out.nodes.map((one) => one.id).join(','));
  assert(out.nodes.every((one) => one.x !== undefined && one.y !== undefined), '缺少位置字段');
  assert(out.nodes.every((one) => one.data && one.data.result && one.data.result.url), '缺少结果数据（卡片画不出来）');
  assert(out.edges.length >= 1, '没有造连线');
  assert(out.viewport && Number.isFinite(out.viewport.zoom), '没有造视口');
});

console.log('E4 · 结果文件与指标');

check('结果写到 tools/bench/result-<日期>.json', () => {
  assert(src.indexOf("'result-' + ymd + '.json'") >= 0, '结果文件名不对');
  assert(src.indexOf('OUT_DIR = __dirname') >= 0, '结果没有写在 tools/bench 里');
});
check('结果里带上了四类指标与该跑的元信息', () => {
  ['openReadyMs', 'frames', 'reparamMs', 'expandMs', 'platform', 'node'].forEach((key) => {
    assert(src.indexOf(key) >= 0, '结果里缺 ' + key);
  });
});
check('结果里注明了「只在同机对比」', () => {
  assert(src.indexOf('同机再跑一次对比') >= 0, '没有提醒跨机不可比');
});
check('三档默认值是 30 / 100 / 300', () => {
  assert(src.indexOf("'30,100,300'") >= 0, '默认档位不是 30/100/300');
  assert(src.indexOf('--sizes=') >= 0, '不支持 --sizes 参数');
});

console.log('E4 · 已有基线结果可读，且与 README 表格一致');

check('tools/bench 下有 result-*.json', () => {
  const files = fs.readdirSync(path.join(ROOT, 'tools', 'bench')).filter((n) => /^result-\d{4}-\d{2}-\d{2}\.json$/.test(n));
  assert(files.length >= 1, '还没有跑过基准，没有 result-*.json');
});
check('基线结果里三档都在，且是 JSON 能读', () => {
  const dir = path.join(ROOT, 'tools', 'bench');
  const files = fs.readdirSync(dir).filter((n) => /^result-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  const data = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  assert(Array.isArray(data.results), '结果格式不对');
  const sizes = data.results.map((one) => one.count).sort((a, b) => a - b);
  assert(sizes.indexOf(30) >= 0 && sizes.indexOf(100) >= 0 && sizes.indexOf(300) >= 0,
    '基线里缺档位：' + sizes.join(','));
});
check('每档的结果字段齐全（缺了说明那项没测到）', () => {
  const dir = path.join(ROOT, 'tools', 'bench');
  const files = fs.readdirSync(dir).filter((n) => /^result-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  const data = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  data.results.forEach((one) => {
    assert(typeof one.renderedNodes === 'number' && one.renderedNodes === one.count,
      '第 ' + one.count + ' 档渲染出的卡片数与预期不符：' + one.renderedNodes);
    assert(one.openReadyMs !== null, '第 ' + one.count + ' 档没测到打开耗时');
    assert(one.frames && one.frames.fps !== null, '第 ' + one.count + ' 档没测到帧率');
    assert(one.reparamMs !== null, '第 ' + one.count + ' 档没测到改参数耗时');
    assert(one.expandMs !== null, '第 ' + one.count + ' 档没测到展开耗时');
    assert(one.pageErrors === 0, '第 ' + one.count + ' 档页面有脚本异常：' + one.pageErrors);
  });
});

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(52));
process.exit(fail ? 1 : 0);
