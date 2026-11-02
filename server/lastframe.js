'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('./paths');

// 跑一次外部工具，失败时把 stderr 最后几行当作错误信息带出来
function runTool(bin, args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    execFile(
      bin,
      args,
      { timeout: timeoutMs || 180000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      function (error, stdout, stderr) {
        if (error) {
          const tail = String(stderr || '')
            .split(/\r?\n/)
            .map(function (line) { return line.trim(); })
            .filter(Boolean)
            .slice(-2)
            .join(' ');
          const wrapped = new Error(tail || error.message);
          wrapped.code = error.code;
          reject(wrapped);
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

function clearDir(dir) {
  fs.readdirSync(dir).forEach(function (name) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch (error) {
      /* 删不掉就算了，不影响取图 */
    }
  });
}

function framesIn(dir) {
  return fs
    .readdirSync(dir)
    .filter(function (name) { return /^f_\d+\.png$/i.test(name); })
    .sort();
}

async function probeDuration(ffprobe, file) {
  try {
    const out = await runTool(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      30000
    );
    const value = Number(String(out.stdout).trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (error) {
    return 0;
  }
}

// 从窗口尾部开始解，取解出来的最后一张；解不到就把窗口放大再试
// -sseof 从「结束前 N 秒」开始，配合 passthrough 只写尾部这些帧，最后一张就是真正的最后一帧
async function decodeTail(ffmpeg, file, work, windowSec) {
  clearDir(work);
  const seek = windowSec > 0 ? ['-sseof', '-' + windowSec] : [];
  const outPat = path.join(work, 'f_%06d.png');
  const tail = ['-an', '-sn', '-f', 'image2', outPat];
  try {
    await runTool(ffmpeg, ['-y', '-v', 'error'].concat(seek, ['-i', file, '-fps_mode', 'passthrough'], tail), 300000);
  } catch (error) {
    // 老一点的 ffmpeg 没有 -fps_mode，退回旧写法再来一次
    await runTool(ffmpeg, ['-y', '-v', 'error'].concat(seek, ['-i', file, '-vsync', '0'], tail), 300000);
  }
  const frames = framesIn(work);
  return frames;
}

// 精确抽最后一帧：结果写到 outAbs（PNG），返回用了多长的尾部窗口
async function extractLastFrame(videoAbs, outAbs) {
  const tools = paths.toolsInfo();
  if (!tools.ffmpeg) {
    throw new Error('还没放视频解码工具：把 ffmpeg.exe 放进 tools 目录，尾帧就能精确到最后一帧');
  }
  if (!videoAbs || !fs.existsSync(videoAbs)) throw new Error('找不到这段视频的文件');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-tail-'));
  try {
    const duration = tools.ffprobe ? await probeDuration(tools.ffprobe, videoAbs) : 0;
    // 先按视频长度挑一个合适的尾部窗口，再从大到小兜底
    const windows = [];
    if (duration > 0) windows.push(Math.min(Math.max(duration * 0.25, 0.8), 6));
    windows.push(1, 3, 10);
    const tried = [];
    for (const size of windows) {
      const key = Math.round(size * 100) / 100;
      if (tried.indexOf(key) >= 0) continue;
      tried.push(key);
      let frames = [];
      try {
        frames = await decodeTail(tools.ffmpeg, videoAbs, work, key);
      } catch (error) {
        frames = [];
      }
      if (frames.length) {
        fs.copyFileSync(path.join(work, frames[frames.length - 1]), outAbs);
        return { windowSec: key, frames: frames.length };
      }
    }
    // 最后兜底：整段解一遍，取最后一张
    const frames = await decodeTail(tools.ffmpeg, videoAbs, work, 0);
    if (frames.length) {
      fs.copyFileSync(path.join(work, frames[frames.length - 1]), outAbs);
      return { windowSec: 0, frames: frames.length };
    }
    throw new Error('这段视频里没解出画面，可能文件坏了，或者里面没有画面轨');
  } finally {
    try {
      clearDir(work);
      fs.rmdirSync(work);
    } catch (error) {
      /* 临时目录清不掉不影响结果 */
    }
  }
}

module.exports = { extractLastFrame, probeDuration, runTool };
