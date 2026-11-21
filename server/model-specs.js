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
  // 通道 6 · 飞拓（ai.fanke2026.xyz）Seedance 2.5 系列：
  // 平台按 model 区分分辨率 / 时长 / 素材上限，卡片选项必须跟着变，否则会 400。
  'ft-video-v1-3c36fd760ae3659507ab841b317e1cf8': {
    label: 'Seedance 2.5 满血 · 1080P · 9图3音',
    resolutions: ['1080p'],
    durations: Array.from({ length: 27 }, (_, i) => String(i + 4)),
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '1080P',
    maxDurationSec: 30,
    minDurationSec: 4,
    maxRefs: 9,
    maxRefVideos: 0,
    maxRefAudios: 3,
  },
  'ft-video-v1-99d13a482c1f6f0e71db1e36c4154b70': {
    label: 'Seedance 2.5 满血 · 720P · 9图',
    resolutions: ['720p'],
    durations: ['15', '30'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '720P',
    maxDurationSec: 30,
    minDurationSec: 15,
    maxRefs: 9,
    maxRefVideos: 0,
    maxRefAudios: 0,
  },
  'ft-video-v1-b5ac5458842a7360e40630a8d5801790': {
    label: 'Seedance 2.5 满血 · 720P · 全能参考',
    resolutions: ['720p'],
    durations: Array.from({ length: 27 }, (_, i) => String(i + 4)),
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '720P',
    maxDurationSec: 30,
    minDurationSec: 4,
    maxRefs: 30,
    maxRefVideos: 10,
    maxRefAudios: 10,
  },
  // 通道 7 · xm API（ai.987xm.com）· 即梦 SD2.5 系列。
  // 注意：这两个模型的「参考素材字段形状」完全不同，平台对多余字段一律 400，
  // 所以必须各配一份请求体模板 —— 因此拆成两个通道，而不是一个通道两个模型。
  //   sd25-1-pro               参考图 images[] / 参考视频 video_refs[] / 参考音频 audio_refs[]，分辨率小写 720p
  //   bd-VIP-…-720P            参考素材统一走 media[{type,url}]，分辨率必须大写 720P，且比例不含 21:9
  'sd25-1-pro': {
    label: 'SD2.5 Pro · 720P · 30图/10视频/10音频',
    resolutions: ['720p'],
    durations: Array.from({ length: 26 }, (_, i) => String(i + 5)),
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '720P',
    maxDurationSec: 30,
    minDurationSec: 5,
    maxRefs: 30,
    maxRefVideos: 10,
    maxRefAudios: 10,
  },
  'bd-vip-sd2.5满参真人脸-720p': {
    label: 'BD VIP SD2.5 满参真人脸 · 720P · 20图/5视频/5音频',
    resolutions: ['720p'],
    durations: Array.from({ length: 26 }, (_, i) => String(i + 5)),
    ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '720P',
    maxDurationSec: 30,
    minDurationSec: 5,
    maxRefs: 20,
    maxRefVideos: 5,
    maxRefAudios: 5,
  },
  // 通道 9 · Prompt Hubs（console.prompt-hubs.com）· 即梦 SD2.5 系列四条线路
  // 平台契约（video.v1）：POST /v1/videos，素材统一走 media_inputs，
  // 每项为 {kind: image|video|audio, role: reference|audio_reference, url}。
  // 这是平台自家画布提交时用的写法（旧的扁平字段 reference_images 等虽仍被
  // 校验层接受，但转发给上游时不一定生效，所以统一走 media_inputs）。
  // 分辨率只认小写（720p / 1080p），所以模板里必须用 {{resolutionLower}}。
  // 这四个模型都不吃首尾帧（平台文档明确列了 unsupported_parameters），所以 frames: false。
  // 线路四的时长下限是 4 秒（其余三个 5 秒）；特惠只收 1080P、只收 16:9 / 9:16、不收参考视频。
  // 三个模型都实测过（2026-11-21，用真实 key 打 /v1/videos 的零费用探测）：
  //   线路四       → 400 invalid_resolution（说明模型存在、令牌有权限）
  //   特惠 903     → 400 invalid_resolution
  //   满血-flash    → 403 This token has no access（模型真实存在，只是这个令牌没勾权限）
  // 「S-2.5-满血」「S-2.5-flash」在控制台模型清单里还挂着，但实际调用是 404 model_not_found，
  //   属于站点侧的死配置，已经从通道清单里删掉，别再留规格误导卡片。
  's-2.5-线路四': {
    label: 'SD2.5 线路四 · 720P/1080P · 4–30秒 · 30图/10视频/10音频',
    // 文档原文：resolution=720p|1080p（默认 720p）。之前这里只写了 720p，
    // 于是用户选 1080P 会被 buildVars 悄悄收敛回 720P —— 花了 1080P 的钱出了 720P 的画面。
    resolutions: ['720p', '1080p'],
    durations: Array.from({ length: 27 }, (_, i) => String(i + 4)),
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '720P',
    defaultDuration: 4,
    maxDurationSec: 30,
    minDurationSec: 4,
    maxRefs: 30,
    maxRefVideos: 10,
    maxRefAudios: 10,
    // 平台对「素材总数」另有一条 ≤50 的硬上限（三类各自上限之外）
    maxRefTotal: 50,
  },
  's-2.5满血-flash': {
    label: 'SD2.5 满血 Flash · 720P · 5–30秒 · 10图/5视频/5音频',
    resolutions: ['720p'],
    durations: Array.from({ length: 26 }, (_, i) => String(i + 5)),
    ratios: ['16:9', '9:16', '4:3', '1:1', '3:4', '21:9'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '720P',
    defaultDuration: 5,
    maxDurationSec: 30,
    minDurationSec: 5,
    maxRefs: 10,
    maxRefVideos: 5,
    maxRefAudios: 5,
  },
  's-2.5-特惠-903-1080p': {
    label: 'SD2.5 特惠 903 · 1080P · 9图/3音频 · 不收视频',
    resolutions: ['1080p'],
    durations: Array.from({ length: 26 }, (_, i) => String(i + 5)),
    ratios: ['16:9', '9:16'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '1080P',
    defaultDuration: 5,
    maxDurationSec: 30,
    minDurationSec: 5,
    maxRefs: 9,
    // 0 = 这个模型完全不收参考视频（平台会直接回 this model does not accept reference videos）
    maxRefVideos: 0,
    maxRefAudios: 3,
  },
  // 通道 10 · 520ruo（api.520ruo.com）· Seedance 2.5 Flash
  // 平台文档（https://520ruo.com/api-guide 第「Seedance 2.5 Flash 详细接入」节）：
  //   · 按条计费：480p 1.50 元 / 720p 3.00 元，同一清晰度下 5 秒与 30 秒同价；
  //   · 只支持 480p / 720p，传 1080p、4k 会被直接拒绝且不降级收费；
  //   · 时长 4–30 秒整数，默认 5；
  //   · 比例 9:16 / 16:9 / 1:1 / 4:3 / 3:4 / 21:9，默认 9:16；
  //   · images 必填 1–10 张，且只收 Base64 / data URI / {base64,mimeType}，**不接受 URL**
  //     （文档原话：「本站当前图片URL传入尚未开放」）；
  //   · audio 可选 0–5 段；video / video_refs 已关闭，传了会被拒。
  // 因为它必须带参考图，所以 modes 里没有 text（纯文生会被平台判 400），minRefs 记 1。
  'seedance_2.5_flash': {
    label: 'Seedance 2.5 Flash · 480P/720P · 4–30秒 · 1–10图/5音频',
    resolutions: ['480p', '720p'],
    durations: Array.from({ length: 27 }, (_, i) => String(i + 4)),
    ratios: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9'],
    modes: ['reference'],
    frames: false,
    defaultResolution: '480P',
    defaultDuration: 5,
    maxDurationSec: 30,
    minDurationSec: 4,
    maxRefs: 10,
    // 至少 1 张参考图：这个模型是图生视频，纯文字会被平台拒
    minRefs: 1,
    // 0 = 完全不收参考视频（文档：视频参考已关闭）
    maxRefVideos: 0,
    maxRefAudios: 5,
  },
  // 通道 10 · 520ruo 的两个按条视频模型（2026-11-20 实测 + 官方文档）。
  //
  // 与旧的 seedance_2.5_flash 完全不同的一套契约，别照抄：
  //   · 参考素材走 image_refs / video_refs / audio_refs，元素是**公网 HTTP(S) 直链**
  //     （旧那个只收 Base64、不收 URL，正好相反）；
  //   · 纯文生可以直接跑（不需要参考图），也没有「必须至少一张图」的限制；
  //   · 任务提交返回 { id, status }，查询 GET /v1/videos/{id}，完成的地址在 url，
  //     兜底下载 GET /v1/videos/{id}/content。
  //
  // 实测记录（2026-11-20，真实提交，本账号）：
  //   ruo-seedance-2.5        纯文生 200 / 带 image_refs 200 / 空数组 200
  //   seedance-2.5-premium-video 空数组 403（insufficient_user_quota，说明参数校验已通过，
  //                              只是余额 1 元不够 3 元的单条预扣）
  // 两家都接受空数组，所以模板里保留 image_refs: [] 是安全的。
  //
  // 素材上限（文档 4.4 / 各模型小节）：
  //   ruo-seedance-2.5：30 图、10 音频（每段 2–30 秒、合计 ≤30 秒）、**不收参考视频**；
  //     比例额外支持 adaptive。
  //   seedance-2.5-premium-video：30 图、10 视频、10 音频；比例不含 adaptive。
  //   两者画布素材合计上限都是 60 MiB（走 URL 时不占这个额度，但本通道仍按 URL 走）。
  'ruo-seedance-2.5': {
    label: 'ruo Seedance 2.5 · 480P/720P/1080P · 4–30秒 · 2/3/5元每条',
    resolutions: ['480p', '720p', '1080p'],
    durations: Array.from({ length: 27 }, (_, i) => String(i + 4)),
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '720P',
    // 文档：默认 5 秒（不是 30）
    defaultDuration: 5,
    maxDurationSec: 30,
    minDurationSec: 4,
    maxRefs: 30,
    maxRefVideos: 0,
    maxRefAudios: 10,
    maxRefTotal: 40,
  },
  'seedance-2.5-premium-video': {
    label: 'Seedance 2.5 Pro 按条 · 480P/720P/1080P · 4–30秒 · 3/4/6元每条',
    resolutions: ['480p', '720p', '1080p'],
    durations: Array.from({ length: 27 }, (_, i) => String(i + 4)),
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '720P',
    // 文档：2.5 默认 30 秒
    defaultDuration: 30,
    maxDurationSec: 30,
    minDurationSec: 4,
    maxRefs: 30,
    maxRefVideos: 10,
    maxRefAudios: 10,
    maxRefTotal: 50,
  },
  // 通道 11 · 星光 API（xingapi.top）· Seedance 2.5 系列三个公开模型。
  // 平台契约（对接文档 2026-10-30，第 4 节「视频：创建生成任务」）：
  //   · POST /v1/videos/generations 建任务，返回 { id, object, status }；
  //   · GET  /v1/videos/{task_id} 查询，完成后结果在 video_url / download_url / content_url / url；
  //   · GET  /v1/videos/{task_id}/content 统一下载端点，可能 302 到存储，需跟随跳转；
  //   · 参考素材走三个独立的 URL 字符串数组 images / videos / audios，
  //     只收公网 HTTPS 直链（本机路径、blob:、局域网地址一律不收），所以通道里
  //     开了 picui 图床代传，本地素材先传上去再填地址。
  // 三个模型的差别（/v1/pricing 的 description 原话）：
  //   seedance2.5-M    30图片10视频10音频 · 480P/720P · 5–30秒 · 按条   —— 无 480P 档位价，只开 720P
  //   seedance2.5-M-S  30图片10视频10音频 · 480P/720P · 4–30秒 · 按秒
  //   seedance2.5-V    30图片10视频10音频 · 720P · 5–30秒 · 按条 · 15000 字符提示词上限
  // 三个都不吃首尾帧（文档 unsupported_parameters 未列 first_frame 类字段），所以 frames: false。
  'seedance2.5-m': {
    label: 'Seedance 2.5 M · 720P · 5–30秒 · 30图/10视频/10音频 · 按条',
    resolutions: ['720p'],
    durations: Array.from({ length: 26 }, (_, i) => String(i + 5)),
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '720P',
    defaultDuration: 5,
    maxDurationSec: 30,
    minDurationSec: 5,
    maxRefs: 30,
    maxRefVideos: 10,
    maxRefAudios: 10,
  },
  'seedance2.5-m-s': {
    label: 'Seedance 2.5 M-S · 480P/720P · 4–30秒 · 30图/10视频/10音频 · 按秒',
    resolutions: ['480p', '720p'],
    durations: Array.from({ length: 27 }, (_, i) => String(i + 4)),
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '720P',
    defaultDuration: 5,
    maxDurationSec: 30,
    minDurationSec: 4,
    maxRefs: 30,
    maxRefVideos: 10,
    maxRefAudios: 10,
  },
  'seedance2.5-v': {
    label: 'Seedance 2.5 V · 720P · 5–30秒 · 30图/10视频/10音频 · 按条',
    resolutions: ['720p'],
    durations: Array.from({ length: 26 }, (_, i) => String(i + 5)),
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    modes: ['reference', 'text'],
    frames: false,
    defaultResolution: '720P',
    defaultDuration: 5,
    maxDurationSec: 30,
    minDurationSec: 5,
    maxRefs: 30,
    maxRefVideos: 10,
    maxRefAudios: 10,
  },
  // 通道 4 · 元梦「源梦创作工作室」（yuanmengstudio.com/vr/api/studio）
  // 这四个模型来自 GET /catalog 的 videos[]，规格是平台实时返回的，写死在这里只为
  // 让卡片选项和校验对齐（/catalog 仍然是最权威来源，变了要同步改这段）。
  //
  // 共同点：
  //   · **必须至少 1 张参考图**（minImages: 1），纯文字提交会被 400 拒掉 → minRefs: 1；
  //   · 4–30 秒整数（文档正文写 5–30，但 /catalog 的 duration 是 [4,30]，以 catalog 为准）；
  //   · 仅 16:9 / 9:16 / 1:1 三种画幅，没有 4:3 / 3:4；
  //   · 每个模型只对应**一个**分辨率，所以 resolutions 只写它自己那一档：
  //     这样卡片传来的任何值都会被收敛过去，不会把另一个模型的分辨率发出去。
  'seedance2.5-480': {
    label: 'Seedance 2.5 · 480P',
    resolutions: ['480p'],
    durations: Array.from({ length: 27 }, (_, i) => String(i + 4)),
    ratios: ['16:9', '9:16', '1:1'],
    modes: ['reference'],
    frames: false,
    defaultResolution: '480P',
    defaultDuration: 5,
    minDurationSec: 4,
    maxDurationSec: 30,
    maxRefs: 30,
    maxRefVideos: 5,
    maxRefAudios: 5,
    maxRefTotal: 30,
    minRefs: 1,
  },
  'seedance2.5-720': {
    label: 'Seedance 2.5 · 720P',
    resolutions: ['720p'],
    durations: Array.from({ length: 27 }, (_, i) => String(i + 4)),
    ratios: ['16:9', '9:16', '1:1'],
    modes: ['reference'],
    frames: false,
    defaultResolution: '720P',
    defaultDuration: 5,
    minDurationSec: 4,
    maxDurationSec: 30,
    maxRefs: 30,
    maxRefVideos: 5,
    maxRefAudios: 5,
    maxRefTotal: 30,
    minRefs: 1,
  },
  'seedance2.5-flash-480': {
    label: 'Seedance 2.5 Flash · 480P',
    resolutions: ['480p'],
    durations: Array.from({ length: 27 }, (_, i) => String(i + 4)),
    ratios: ['16:9', '9:16', '1:1'],
    modes: ['reference'],
    frames: false,
    defaultResolution: '480P',
    defaultDuration: 5,
    minDurationSec: 4,
    maxDurationSec: 30,
    maxRefs: 10,
    maxRefVideos: 5,
    maxRefAudios: 5,
    maxRefTotal: 20,
    minRefs: 1,
  },
  'seedance2.5-flash-720': {
    label: 'Seedance 2.5 Flash · 720P',
    resolutions: ['720p'],
    durations: Array.from({ length: 27 }, (_, i) => String(i + 4)),
    ratios: ['16:9', '9:16', '1:1'],
    modes: ['reference'],
    frames: false,
    defaultResolution: '720P',
    defaultDuration: 5,
    minDurationSec: 4,
    maxDurationSec: 30,
    maxRefs: 10,
    maxRefVideos: 5,
    maxRefAudios: 5,
    maxRefTotal: 20,
    minRefs: 1,
  },
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
// 同名不同契约：同一串模型名在别家平台可能完全是另一套尺寸。
// gpt-image-2.5-flare 在 aicopy / visionary 上是 1K/2K/4K 多比例，
// 而 xinbiapi（Model Router）只收 1024*1024 / 1536*1024 / 1024*1536 三个固定像素。
// 所以规格除了按模型名查，还要允许通道自己覆盖一份 —— 这里带通道 id 的键优先。
const CHANNEL_SPECS = {
  // 通道2 · xinbiapi · gpt-image-2.5-flare
  // 平台 parameterSchema：required=[resolution]，enum 只有这三个值，且必须是星号写法；
  // 图片编辑（IMAGE_EDIT）必须带 1–8 张参考图，纯文生（IMAGE_GENERATE）不收参考图。
  'ch_28d57084': {
    'gpt-image-2.5-flare': {
      sizes: ['1024*1024', '1536*1024', '1024*1536'],
      ratios: ['1:1', '3:2', '2:3'],
      defaultResolution: '1024*1024',
      maxRefs: 8,
      // 平台只认 resolution 一个参数，别把卡片上的其它键塞进 parameters
      paramKeys: ['resolution'],
    },
  },
};

// channelId 可省略：省略时按模型名查（老调用点不用改）。
// 带了 channelId 就先看这个通道有没有覆盖，没有才回落到通用表。
function forModel(model, channelId) {
  const key = String(model === undefined || model === null ? '' : model).trim().toLowerCase();
  if (!key) return null;
  const chKey = String(channelId === undefined || channelId === null ? '' : channelId).trim();
  if (chKey && CHANNEL_SPECS[chKey] && CHANNEL_SPECS[chKey][key]) return CHANNEL_SPECS[chKey][key];
  return VIDEO_SPECS[key] || IMAGE_SPECS[key] || null;
}

module.exports = { VIDEO_SPECS, IMAGE_SPECS, CHANNEL_SPECS, forModel };
