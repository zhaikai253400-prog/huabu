'use strict';

// 从一段视频的尾部截出「后 N 秒」，给下一段视频当衔接参考。
//
// 为什么不用 -c copy（流拷贝）：
//   流拷贝确实快（40 毫秒），但它只能从关键帧开始切。实测本机素材的关键帧
//   间隔平均 2.2 秒、最大 3 秒，末尾很容易多切出一截 —— 参考片段带着重复画面，
//   正好是衔接最怕的东西。重编码多花 0.2~1 秒，换来帧级精确的 5.000 / 10.000 秒。
//
// 为什么保留音轨：参考视频带不带音频对模型没影响，但用户以后要把这些片段
//   剪成片时，没声音就得重做一遍。多保留一条 AAC 的成本可以忽略。

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('./paths');

// 跑一次外部工具，失败时把 stderr 最后几行当错误信息带出来（与 lastframe.js 同款）
function runTool(bin, args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    execFile(
      bin,
      args,
      { timeout: timeoutMs || 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
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

// 拿视频时长（秒）。读不出来返回 0，调用方据此决定要不要报错。
async function probeDuration(ffprobe, file) {
  try {
    const out = await runTool(
      ffprobe,
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1',
        file,
      ],
      30000
    );
    const value = Number(String(out.stdout).trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (error) {
    return 0;
  }
}

// 拿视频的宽高和帧率：卡片要按这个比例摆，转码也要按这个参数走。
// 读不出来时各项为 0 / 空，不影响截取本身。
async function probeVideo(ffprobe, file) {
  const info = { width: 0, height: 0, duration: 0, fps: 0 };
  if (!ffprobe) return info;
  try {
    const out = await runTool(
      ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,avg_frame_rate',
        '-show_entries', 'format=duration',
        '-of', 'default=nw=1',
        file,
      ],
      30000
    );
    String(out.stdout || '').split(/\r?\n/).forEach(function (line) {
      const hit = line.match(/^(\w+)=(.*)$/);
      if (!hit) return;
      const key = hit[1];
      const value = String(hit[2] || '').trim();
      if (key === 'width') info.width = Number(value) || 0;
      else if (key === 'height') info.height = Number(value) || 0;
      else if (key === 'duration') info.duration = Number(value) || 0;
      else if (key === 'avg_frame_rate') {
        const pair = value.split('/');
        const a = Number(pair[0]);
        const b = Number(pair[1] || 1);
        if (a > 0 && b > 0) info.fps = a / b;
      }
    });
  } catch (error) {
    /* 读不出来就用空信息，截取照样能跑 */
  }
  return info;
}

module.exports = { runTool: runTool, probeDuration: probeDuration, probeVideo: probeVideo };
