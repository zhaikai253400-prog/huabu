'use strict';

// 各视频模型能接受的参数。渠道里没列到的模型不在这里，就继续用卡片上的默认选项。
// resolutions 用小写，跟卡片里存的值一致；发给平台前再转成大写。
const VIDEO_SPECS = {
  'minimax-h3': {
    label: 'MiniMax H3',
    resolutions: ['768p'],
    durations: ['5', '10', '15'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    modes: ['reference', 'frames', 'text'],
    frames: true,
    defaultResolution: '768P',
    maxDurationSec: 15,
    minDurationSec: 1,
    maxRefs: 12,
  },
  'seedance-2.5': {
    label: 'Seedance 2.5',
    resolutions: ['720p'],
    durations: ['5', '10', '15', '30'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    modes: ['reference', 'frames', 'text'],
    // 这个模型没有真正的首尾帧任务，首帧仍然按参考图送
    frames: false,
    defaultResolution: '720P',
    maxDurationSec: 30,
    minDurationSec: 5,
    maxRefs: 54,
  },
  'chaomeng-video-88b0bf9d5c3f': {
    label: '超梦 2.5 · 1080P · 9图3音频',
    resolutions: ['1080p'],
    durations: Array.from({ length: 26 }, (_, i) => String(i + 5)),
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '1080P',
    maxDurationSec: 30,
    minDurationSec: 5,
    maxRefs: 9,
    maxRefAudios: 3,
    maxRefVideos: 0,
  },
  // 通道 2 上的 Wan3.0 super：平台有 480P/720P/1080P，这里只放开 720P（约 0.1687 元/秒）
  'wan3.0-super': {
    label: 'Wan3.0 Super',
    resolutions: ['720p'],
    durations: ['5', '10', '15', '30'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: ['reference', 'frames', 'text'],
    frames: true,
    defaultResolution: '720P',
    maxDurationSec: 30,
    minDurationSec: 2,
    maxRefs: 20,
    maxRefAudios: 5,
    maxRefVideos: 5,
    // 平台对这个模型查得很严：只认这三项，多带 outputCount 会直接 422
    paramKeys: ['resolution', 'duration', 'ratio'],
  },
  'wan3.0-video': {
    label: 'Wan3.0',
    resolutions: ['480p', '720p', '1080p'],
    durations: ['5', '10', '15', '30'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: ['reference', 'frames', 'text'],
    frames: true,
    defaultResolution: '720P',
    maxDurationSec: 30,
    minDurationSec: 2,
    maxRefs: 20,
  },
  // 通道 4 · 元梦「视频生成车站」上的万相 3.0 排队通道：
  // 时长 2~30 秒（-1 = 平台智能决定），清晰度只影响画幅不影响计费，计费 1 条 = 1 次
  'wan3.0-station': {
    label: '万相3.0 · 元梦车站',
    resolutions: ['480p', '720p', '1080p'],
    durations: ['5', '10', '15', '30'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    modes: ['reference', 'frames', 'text'],
    // 首帧 / 首尾帧是另一套字段，通道里给视频配了「首尾帧专用请求体」
    frames: true,
    defaultResolution: '1080P',
    maxDurationSec: 30,
    minDurationSec: 2,
    maxRefs: 10,
    maxRefAudios: 5,
    maxRefVideos: 5,
  },
};

// 生图卡片能选哪些尺寸 / 比例：图片卡片的「尺寸」对应接口的 resolution（1K / 2K / 4K）
// 这里列到的模型，卡片上的选项会自动跟着变（例如 lite 只有 1K）
const IMAGE_SPECS = {
  'gpt-image-2': {
    sizes: ['1K', '2K', '4K'],
    ratios: ['1:1','3:2','2:3','4:3','3:4','5:4','4:5','16:9','9:16','2:1','1:2','3:1','1:3','21:9','9:21'],
    defaultResolution: '1K',
    maxRefs: 9,
  },
  'gpt-image-2.5-flare': {
    sizes: ['1K', '2K', '4K'],
    ratios: ['1:1','3:2','2:3','4:3','3:4','5:4','4:5','16:9','9:16','2:1','1:2','21:9','9:21'],
    defaultResolution: '1K',
    maxRefs: 9,
  },
  'gpt-image-2.5-sunburst': {
    sizes: ['1K', '2K', '4K'],
    ratios: ['1:1','3:2','2:3','4:3','3:4','5:4','4:5','16:9','9:16','2:1','1:2','21:9','9:21'],
    defaultResolution: '1K',
    maxRefs: 9,
  },
  'nano-banana-2.1': {
    sizes: ['1K', '2K', '4K'],
    ratios: ['1:1','4:3','3:4','3:2','2:3','16:9','9:16','21:9','5:4','4:5','1:4','4:1'],
    defaultResolution: '1K',
    maxRefs: 9,
  },
  // 平台模型清单里就是这个名字（下划线、驼峰），发送时不能改成 nano-banana-pro
  'nano_banana_pro': {
    sizes: ['1K', '2K', '4K'],
    ratios: ['1:1','4:3','3:4','3:2','2:3','16:9','9:16','21:9','5:4','4:5'],
    defaultResolution: '1K',
    maxRefs: 13,
  },
  'nano-banana-pro-cl': {
    sizes: ['1K', '2K', '4K'],
    ratios: ['1:1','4:3','3:4','3:2','2:3','16:9','9:16','21:9','5:4','4:5'],
    defaultResolution: '1K',
    maxRefs: 13,
  },
  // Lite 平台固定 1K，卡片上就别给 2K / 4K 了
  'nano-banana-2-lite': {
    sizes: ['1K'],
    ratios: ['1:1','4:3','3:4','3:2','2:3','16:9','9:16','21:9','5:4','4:5'],
    defaultResolution: '1K',
    maxRefs: 13,
  },
};
function forModel(model) {
  const key = String(model === undefined || model === null ? '' : model).trim().toLowerCase();
  if (!key) return null;
  return VIDEO_SPECS[key] || IMAGE_SPECS[key] || null;
}

module.exports = { VIDEO_SPECS, IMAGE_SPECS, forModel };
