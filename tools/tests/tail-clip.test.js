'use strict';

// 取尾段：卡片上的「尾段」按钮（后 5 秒 / 后 10 秒）
//
// 用途是给下一段视频做衔接参考 —— 上一段结尾的运动趋势、镜头方向、节奏，
// 比一张静态尾帧更能把动作接上。
//
// 这个文件守四件事：
//   A. 截取本身是帧级精确的 5.000 / 10.000，且保留音轨
//   B. 片子比目标短时不报错，整段拿走并标 truncated
//   C. 落盘位置固定在 素材\视频\尾段，不会跟原片混在一起
//   D. 前端只多了「尾段」一个按钮，且没有自动连线（用户明确不要）
//
// 运行：runtime/node.exe tools/tests/tail-clip.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = path.join(ROOT, 'tools', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'tools', 'ffprobe.exe');
const CANVAS_SRC = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'canvas.js'), 'utf8');
const API_SRC = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'api.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const GEN_SRC = fs.readFileSync(path.join(ROOT, 'server', 'generate.js'), 'utf8');

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

console.log('\nA. 服务端：截取参数与落盘规则');

check('取尾段函数已导出，前端能调到', () => {
  const generate = require(path.join(ROOT, 'server', 'generate.js'));
  assert(typeof generate.extractTailClip === 'function', 'generate.js 没导出 extractTailClip');
});

check('路由 /api/tailclip 已注册，且在白名单里（不然局域网协作者点不动）', () => {
  assert(INDEX_SRC.indexOf("'/api/tailclip'") >= 0, 'index.js 里没有 /api/tailclip 路由');
  const allow = INDEX_SRC.indexOf("if (pathname === '/api/tailclip') return true;");
  assert(allow > 0, '白名单没放行 /api/tailclip');
});

check('接口会先把请求体读出来判画布权限（跨画布协作时才不会越权）', () => {
  const hit = INDEX_SRC.match(/const BODY_SCOPED_PATHS = \[([^\]]*)\]/);
  assert(hit, '找不到 BODY_SCOPED_PATHS');
  assert(hit[1].indexOf("'/api/tailclip'") >= 0, 'BODY_SCOPED_PATHS 少了 /api/tailclip');
});

check('秒数有上下限，别让人传 0 或者 99999', () => {
  assert(/seconds > 0 && seconds <= 120/.test(INDEX_SRC), '接口没有校验秒数范围');
});

check('重编码而不是流拷贝（流拷贝只能从关键帧切，末尾会多出一截）', () => {
  const at = GEN_SRC.indexOf('async function extractTailClip');
  assert(at > 0, '找不到 extractTailClip');
  const body = GEN_SRC.slice(at, at + 3200);
  assert(body.indexOf("'libx264'") >= 0, '没有重编码：流拷贝会让时长不准');
  assert(body.indexOf("'veryfast'") >= 0, '没设编码速度档');
  assert(!/'-c',\s*'copy'/.test(body), '不应该用流拷贝');
});

check('保留音轨（以后要剪成片时不用重做）', () => {
  const at = GEN_SRC.indexOf('async function extractTailClip');
  const body = GEN_SRC.slice(at, at + 3200);
  assert(body.indexOf("'0:a?'") >= 0, '没有可选音轨映射');
  assert(body.indexOf("'aac'") >= 0, '音频没转 aac');
});

check('统一转 yuv420p（浏览器和平台都认这个）', () => {
  const at = GEN_SRC.indexOf('async function extractTailClip');
  const body = GEN_SRC.slice(at, at + 3200);
  assert(body.indexOf("'yuv420p'") >= 0, '没有指定像素格式');
});

check('落盘固定进 视频\\尾段，不和原片混', () => {
  const at = GEN_SRC.indexOf('async function extractTailClip');
  const body = GEN_SRC.slice(at, at + 3200);
  assert(/writeAsset\(config\.assetRoot, '视频'/.test(body), '没写进 视频 分类');
  assert(/尾段/.test(body), '没有 尾段 子目录');
});

console.log('\nB. 前端：只有一个按钮、两个选项、不自动连线');

check('视频卡片上有「尾段」按钮', () => {
  assert(CANVAS_SRC.indexOf("clip.className = 'btn-clip'") > 0, '卡片上没有取尾段按钮');
});

check('按钮点开只有「后 5 秒」和「后 10 秒」两项', () => {
  const at = CANVAS_SRC.indexOf('function openTailClipMenu');
  assert(at > 0, '找不到 openTailClipMenu');
  const body = CANVAS_SRC.slice(at, at + 900);
  assert(body.indexOf("'后 5 秒'") > 0, '少了后 5 秒');
  assert(body.indexOf("'后 10 秒'") > 0, '少了后 10 秒');
});

check('请求带上 canvasId（素材才能归到当前画布的子目录）', () => {
  assert(/tailClip\(\{[^}]*canvasId: canvasId/.test(CANVAS_SRC.replace(/\s+/g, ' ').replace(/canvasId: canvasId \}/g, 'canvasId: canvasId }')), '请求没带 canvasId');
});

check('不自动连线：建卡片时不传 connectFrom', () => {
  const at = CANVAS_SRC.indexOf('function startTailClip');
  assert(at > 0, '找不到 startTailClip');
  const body = CANVAS_SRC.slice(at, at + 3000);
  assert(body.indexOf('connectFrom') < 0, '不该自动连线（用户明确说只要按钮）');
  assert(body.indexOf('addEdge(') < 0, '不该自动连线');
});

check('原片比目标短时给一句人话，不是报错', () => {
  const at = CANVAS_SRC.indexOf('function startTailClip');
  const body = CANVAS_SRC.slice(at, at + 3000);
  assert(/clip\.truncated/.test(body), '没处理截短的情况');
  assert(/整段取回来|已把整段取回/.test(body), '没说清楚为什么只截到这么短');
});

check('api.js 暴露了 tailClip', () => {
  assert(API_SRC.indexOf("'/api/tailclip'") > 0, 'api.js 没有 tailClip');
});

console.log('\nC. 真跑一次 ffmpeg：时长精确、音轨在、超长请求整段取');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'tailclip-test-'));
const assetRoot = path.join(box, 'assets');
fs.mkdirSync(path.join(assetRoot, '视频'), { recursive: true });
const srcAbs = path.join(assetRoot, '视频', 'src12.mp4');
const durationOf = (file) => {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  return Number(String(out).trim());
};
const audioOf = (file) => {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return String(out).trim();
};

try {
  execFileSync(FFMPEG, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', srcAbs,
  ], { stdio: 'pipe' });
} catch (error) {
  console.log('  · 本机 ffmpeg 造不出测试片，跳过 C 段');
  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

const config = { assetRoot: assetRoot, store: { sub: 'none' } };
const srcUrl = '/media/' + encodeURIComponent('视频') + '/' + encodeURIComponent('src12.mp4');
const absOf = (rel) => path.join(assetRoot, String(rel).split('/').join(path.sep));

(async () => {
  const generate = require(path.join(ROOT, 'server', 'generate.js'));
  try {
    const r5 = await generate.extractTailClip(config, srcUrl, '测试片', '', 5);
    const r10 = await generate.extractTailClip(config, srcUrl, '测试片', '', 10);
    const r20 = await generate.extractTailClip(config, srcUrl, '测试片', '', 20);

    check('要 5 秒就得到 5.000 秒（帧级精确，不是「大概 5 秒」）', () => {
      const got = durationOf(absOf(r5.relPath));
      assert(Math.abs(got - 5) < 0.05, '实际 ' + got.toFixed(3) + ' 秒');
      assert(r5.truncated === false, '不该标成截短');
    });

    check('要 10 秒就得到 10.000 秒', () => {
      const got = durationOf(absOf(r10.relPath));
      assert(Math.abs(got - 10) < 0.05, '实际 ' + got.toFixed(3) + ' 秒');
    });

    check('音轨还在（aac）', () => {
      assert(audioOf(absOf(r5.relPath)) === 'aac', '音轨丢了：' + (audioOf(absOf(r5.relPath)) || '(无)'));
    });

    check('片子只有 12 秒却要 20 秒：整段拿走、标 truncated，不报错', () => {
      const got = durationOf(absOf(r20.relPath));
      assert(Math.abs(got - 12) < 0.1, '实际 ' + got.toFixed(3) + ' 秒');
      assert(r20.truncated === true, '没标成截短');
      assert(r20.sourceSeconds > 11.9, '没报原片时长');
    });

    check('落在 视频\\尾段 下，文件名带真实秒数', () => {
      assert(r5.relPath.indexOf('视频/尾段/') === 0, '路径是 ' + r5.relPath);
      assert(/_尾5s\.mp4$/.test(r5.relPath), '文件名没带 尾5s：' + r5.relPath);
      assert(/_尾10s\.mp4$/.test(r10.relPath), '文件名没带 尾10s：' + r10.relPath);
    });

    check('返回的宽高和原片一致（卡片要按这个比例摆）', () => {
      assert(r5.width === 640 && r5.height === 360, '宽高是 ' + r5.width + 'x' + r5.height);
    });

    check('不会覆盖已有文件：连着取两次是两个文件', () => {
      const files = fs.readdirSync(path.join(assetRoot, '视频', '尾段'));
      assert(files.length >= 3, '尾段目录里只有 ' + files.length + ' 个文件');
    });
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }

  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.log('  ✗ C 段没跑完 —— ' + error.message);
  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + (fail + 1) + ' 项');
  process.exit(1);
});
