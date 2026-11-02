// 3D 导演台：本地 three.js 渲染。摆位 → 机位 → 关键帧运镜 → 出图 / 拍成视频。
// 出图后由 canvas.js 把结果卡片自动连回发起它的导演台卡片。
import * as THREE from 'three';
import { OrbitControls } from '/vendor/three/OrbitControls.js';
import { TransformControls } from '/vendor/three/TransformControls.js';

const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 };
const OUTPUT = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1440, 1440] };
const SHOT_LABELS = { color: '画面', clay: '白模', line: '线稿', depth: '深度图' };
const FURNITURE = [
  ['chair', '椅子'],
  ['stool', '凳子'],
  ['bench', '长凳'],
  ['table', '桌子'],
  ['roundtable', '圆桌'],
  ['sofa', '沙发'],
  ['cabinet', '柜子'],
  ['lamp', '台灯'],
];
const FURNITURE_KINDS = FURNITURE.map(([key]) => key);
const KINDS = ['image', 'video', 'box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'person', 'ground'].concat(FURNITURE_KINDS);
const EASINGS = { linear: '匀速', easeInOut: '缓入缓出', easeIn: '缓入', easeOut: '缓出' };
const PRIMITIVE_LABEL = Object.assign(
  { box: '方块', sphere: '球', cylinder: '柱子', cone: '锥体', torus: '圆环', plane: '平面', person: '人形', ground: '地面' },
  Object.fromEntries(FURNITURE)
);
// 人形关节：滑杆单位是度，0 就是自然站直
const PERSON_JOINTS = ['head', 'spine', 'lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lHip', 'rHip', 'lKnee', 'rKnee', 'armsOut'];
const POSE_FIELDS = [
  ['head', '头'],
  ['spine', '腰'],
  ['lShoulder', '左肩'],
  ['rShoulder', '右肩'],
  ['lElbow', '左肘'],
  ['rElbow', '右肘'],
  ['lHip', '左胯'],
  ['rHip', '右胯'],
  ['lKnee', '左膝'],
  ['rKnee', '右膝'],
  ['armsOut', '张开'],
];
function defaultPose() {
  const pose = {};
  PERSON_JOINTS.forEach((key) => {
    pose[key] = 0;
  });
  return pose;
}
const STAGE_BG = 0x0d1522;

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 7);
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
function easeValue(kind, t) {
  if (kind === 'linear') return t;
  if (kind === 'easeIn') return t * t;
  if (kind === 'easeOut') return 1 - (1 - t) * (1 - t);
  return easeInOut(t);
}
function lerp3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function defaultScene() {
  return {
    objects: [],
    camera: { pos: [0, 2.6, 9.6], target: [0, 1.7, 0], fov: 35 },
    keyframes: [],
    duration: 8,
    aspect: '16:9',
    easing: 'easeInOut',
    scale: 1,
  };
}

function normalizeScene(raw) {
  const out = defaultScene();
  if (!raw || typeof raw !== 'object') return out;
  const vec3 = (value, fallback) =>
    Array.isArray(value) && value.length >= 3 ? value.slice(0, 3).map((n) => Number(n) || 0) : fallback;
  if (Array.isArray(raw.objects)) {
    out.objects = raw.objects
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id || uid('o')),
        kind: KINDS.indexOf(item.kind) >= 0 ? item.kind : 'box',
        url: String(item.url || ''),
        name: String(item.name || ''),
        w: Number(item.w) > 0 ? Number(item.w) : 3.2,
        h: Number(item.h) > 0 ? Number(item.h) : 3.2,
        pos: vec3(item.pos, [0, 1.6, 0]),
        rot: vec3(item.rot, [0, 0, 0]),
        scale: vec3(item.scale, [1, 1, 1]),
        opacity: Number.isFinite(Number(item.opacity)) ? clamp(Number(item.opacity), 0, 1) : 1,
        color: /^#[0-9a-f]{6}$/i.test(String(item.color || '')) ? String(item.color) : '#b9c7dc',
        pose: (function (raw) {
          const pose = defaultPose();
          if (raw && typeof raw === 'object') {
            PERSON_JOINTS.forEach((key) => {
              const value = Number(raw[key]);
              if (Number.isFinite(value)) pose[key] = clamp(value, -180, 180);
            });
          }
          return pose;
        })(item.pose),
        visible: item.visible !== false,
      }));
  }
  if (raw.camera && typeof raw.camera === 'object') {
    out.camera.pos = vec3(raw.camera.pos, out.camera.pos);
    out.camera.target = vec3(raw.camera.target, out.camera.target);
    if (Number(raw.camera.fov) > 0) out.camera.fov = clamp(Number(raw.camera.fov), 12, 100);
  }
  if (Array.isArray(raw.keyframes)) {
    out.keyframes = raw.keyframes
      .filter((k) => k && Array.isArray(k.pos) && Array.isArray(k.target))
      .map((k) => ({
        t: Math.max(0, Number(k.t) || 0),
        pos: vec3(k.pos, [0, 2.6, 9.6]),
        target: vec3(k.target, [0, 1.7, 0]),
        fov: Number(k.fov) > 0 ? clamp(Number(k.fov), 12, 100) : 35,
      }))
      .sort((a, b) => a.t - b.t);
  }
  if (Number(raw.duration) > 0) out.duration = clamp(Number(raw.duration), 2, 20);
  if (ASPECTS[raw.aspect]) out.aspect = raw.aspect;
  if (EASINGS[raw.easing]) out.easing = raw.easing;
  if (Number(raw.scale) === 2) out.scale = 2;
  return out;
}

export class Director {
  constructor(opts) {
    const o = opts || {};
    this.api = o.api || null;
    this.canvasId = o.canvasId || '';
    this.getMaterials = typeof o.getMaterials === 'function' ? o.getMaterials : () => [];
    this.onInsert = typeof o.onInsert === 'function' ? o.onInsert : null;
    this.onChange = typeof o.onChange === 'function' ? o.onChange : null;
    this.onClose = typeof o.onClose === 'function' ? o.onClose : null;
    this.toast = typeof o.toast === 'function' ? o.toast : () => {};
    this.title = String(o.title || '3D 导演台');
    this.scene = normalizeScene(o.scene);
    this.selectedId = '';
    this.time = 0;
    this.playing = false;
    this.gizmoMode = 'translate';
    this.viewMode = 'free';
    this.busy = false;
    this.needsRender = true;
    this.disposed = false;
    this.mask = null;
    this.raf = 0;
    this.lastTick = 0;
    this.objects = new Map();
    this.shelfItems = [];
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.selectionBox = null;
    this.guidesOn = false;
    this.history = [];
    this.future = [];
  }

  // ---------- 开关 ----------
  open() {
    if (this.mask) return;
    this.buildUi();
    document.body.appendChild(this.mask);
    document.body.classList.add('dir-open');
    requestAnimationFrame(() => {
      if (!this.mask) return;
      this.mask.classList.add('open');
      this.initThree();
      this.renderShelf();
      this.renderInspector();
      this.renderTimeline();
      this.applyAspect();
      this.recordHistory();
    });
    this.raf = requestAnimationFrame(() => this.loop());
  }

  close() {
    if (!this.mask) return;
    const dying = this.mask;
    this.mask = null;
    this.stopPlay();
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    try {
      if (this.resizeObserver) this.resizeObserver.disconnect();
      if (this.transform) this.transform.dispose();
      if (this.orbit) this.orbit.dispose();
      this.objects.forEach((entry) => this.disposeObject(entry));
      this.objects.clear();
      if (this.renderer) {
        this.renderer.dispose();
        this.renderer.forceContextLoss && this.renderer.forceContextLoss();
      }
    } catch (err) {
      /* 关掉时出点小问题不影响画布 */
    }
    document.body.classList.remove('dir-open');
    dying.classList.remove('open');
    setTimeout(() => dying.remove(), 200);
    if (this.onClose) this.onClose();
  }

  pushChange() {
    if (this.onChange) this.onChange(this.scene);
    this.needsRender = true;
  }

  // 手动改场景后记一笔，撤销才能回得去（拖动中不记，松手才记）
  commit() {
    this.recordHistory();
    this.pushChange();
  }

  // ---------- 界面 ----------
  buildUi() {
    const mask = h('div', 'dir-mask');
    mask.setAttribute('role', 'dialog');
    mask.setAttribute('aria-modal', 'true');
    mask.setAttribute('aria-label', '3D 导演台');

    const app = h('div', 'dir-app');

    // 顶栏
    const head = h('div', 'dir-head');
    const brand = h('div', 'dir-brand');
    brand.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z"/><path d="M12 12.2l8-4.4"/><path d="M12 12.2V21"/><path d="M12 12.2L4 7.8"/></svg>';
    const brandText = h('div', 'dir-brand-text');
    brandText.appendChild(h('b', '', '3D 导演台'));
    brandText.appendChild(h('span', '', this.title));
    brand.appendChild(brandText);

    const viewGroup = h('div', 'dir-seg');
    this.freeBtn = h('button', 'dir-seg-btn on', '自由视角');
    this.freeBtn.type = 'button';
    this.freeBtn.title = '在场景里自由转着看，摆东西用这个';
    this.camBtn = h('button', 'dir-seg-btn', '导演视角');
    this.camBtn.type = 'button';
    this.camBtn.title = '切到摄影机看出去的画面，就是出图的样子';
    this.freeBtn.addEventListener('click', () => this.setViewMode('free'));
    this.camBtn.addEventListener('click', () => this.setViewMode('camera'));
    viewGroup.appendChild(this.freeBtn);
    viewGroup.appendChild(this.camBtn);

    const aspectWrap = h('label', 'dir-field');
    aspectWrap.appendChild(h('span', '', '画幅'));
    this.aspectSel = h('select', 'dir-select');
    ['16:9', '9:16', '1:1'].forEach((value) => {
      const opt = h('option', '', value);
      opt.value = value;
      this.aspectSel.appendChild(opt);
    });
    this.aspectSel.value = this.scene.aspect;
    this.aspectSel.title = '出图和成片的画幅';
    this.aspectSel.addEventListener('change', () => {
      this.scene.aspect = ASPECTS[this.aspectSel.value] ? this.aspectSel.value : '16:9';
      this.applyAspect();
      this.pushChange();
    });
    aspectWrap.appendChild(this.aspectSel);

    const durWrap = h('label', 'dir-field');
    durWrap.appendChild(h('span', '', '时长'));
    this.durInput = h('input', 'dir-input dir-dur');
    this.durInput.type = 'number';
    this.durInput.min = '2';
    this.durInput.max = '20';
    this.durInput.step = '1';
    this.durInput.value = String(this.scene.duration);
    this.durInput.title = '运镜视频的时长（秒）';
    this.durInput.addEventListener('change', () => {
      this.scene.duration = clamp(Number(this.durInput.value) || 8, 2, 20);
      this.durInput.value = String(this.scene.duration);
      this.renderTimeline();
      this.pushChange();
    });
    durWrap.appendChild(this.durInput);

    const easeWrap = h('label', 'dir-field');
    easeWrap.appendChild(h('span', '', '缓动'));
    this.easeSel = h('select', 'dir-select');
    Object.keys(EASINGS).forEach((key) => {
      const opt = h('option', '', EASINGS[key]);
      opt.value = key;
      this.easeSel.appendChild(opt);
    });
    this.easeSel.value = this.scene.easing || 'easeInOut';
    this.easeSel.title = '两个机位之间怎么过渡';
    this.easeSel.addEventListener('change', () => {
      this.scene.easing = EASINGS[this.easeSel.value] ? this.easeSel.value : 'easeInOut';
      this.setTime(this.time);
      this.pushChange();
    });
    easeWrap.appendChild(this.easeSel);

    const scaleWrap = h('label', 'dir-field');
    scaleWrap.appendChild(h('span', '', '清晰度'));
    this.scaleSel = h('select', 'dir-select');
    [
      ['1', '1x'],
      ['2', '2x'],
    ].forEach(([value, label]) => {
      const opt = h('option', '', label);
      opt.value = value;
      this.scaleSel.appendChild(opt);
    });
    this.scaleSel.value = String(this.scene.scale || 1);
    this.scaleSel.title = '出图倍率：2x 更清晰，但更慢更大';
    this.scaleSel.addEventListener('change', () => {
      this.scene.scale = Number(this.scaleSel.value) === 2 ? 2 : 1;
      this.pushChange();
    });
    scaleWrap.appendChild(this.scaleSel);

    const undoBtn = h('button', 'dir-btn', '撤销');
    undoBtn.type = 'button';
    undoBtn.title = '撤销（Ctrl+Z）';
    undoBtn.addEventListener('click', () => this.undo());
    const redoBtn = h('button', 'dir-btn', '重做');
    redoBtn.type = 'button';
    redoBtn.title = '重做（Ctrl+Shift+Z）';
    redoBtn.addEventListener('click', () => this.redo());
    const exportBtn = h('button', 'dir-btn', '导出场景');
    exportBtn.type = 'button';
    exportBtn.title = '把整个场景存成 JSON，可留作模板';
    exportBtn.addEventListener('click', () => this.exportScene());
    const importBtn = h('button', 'dir-btn', '导入场景');
    importBtn.type = 'button';
    importBtn.title = '读回之前导出的 JSON 场景';
    importBtn.addEventListener('click', () => this.importScene());

    const close = h('button', 'dir-close', '');
    close.type = 'button';
    close.title = '关闭（Esc）';
    close.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
    close.addEventListener('click', () => this.close());

    head.appendChild(brand);
    head.appendChild(h('span', 'grow'));
    head.appendChild(viewGroup);
    head.appendChild(aspectWrap);
    head.appendChild(durWrap);
    head.appendChild(easeWrap);
    head.appendChild(scaleWrap);
    this.guidesBtn = h('button', 'dir-btn', '构图线');
    this.guidesBtn.type = 'button';
    this.guidesBtn.title = '显示三分线和安全框，方便构图（不会被拍进成片）';
    this.guidesBtn.setAttribute('aria-pressed', 'false');
    this.guidesBtn.addEventListener('click', () => this.toggleGuides());
    head.appendChild(this.guidesBtn);
    head.appendChild(h('span', 'grow'));
    head.appendChild(undoBtn);
    head.appendChild(redoBtn);
    head.appendChild(exportBtn);
    head.appendChild(importBtn);
    head.appendChild(close);

    // 主体：左素材架 / 中间舞台 / 右检查器
    const main = h('div', 'dir-main');

    const shelf = h('aside', 'dir-shelf');
    const shelfHead = h('div', 'dir-shelf-head');
    shelfHead.appendChild(h('b', '', '素材架'));
    shelfHead.appendChild(h('span', '', '点一下放进场景'));
    shelf.appendChild(shelfHead);
    this.shelfBody = h('div', 'dir-shelf-body');
    shelf.appendChild(this.shelfBody);
    const shelfTools = h('div', 'dir-shelf-tools');
    shelfTools.appendChild(h('div', 'dir-tools-label', '加个占位体'));
    const toolRow = h('div', 'dir-tool-row');
    ['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'person', 'ground'].forEach((kind) => {
      const label = PRIMITIVE_LABEL[kind] || kind;
      const btn = h('button', 'dir-tool', label);
      btn.type = 'button';
      btn.title = '放一个' + label + '当占位 / 挡前景';
      btn.addEventListener('click', () => this.addPrimitive(kind));
      toolRow.appendChild(btn);
    });
    shelfTools.appendChild(toolRow);
    shelfTools.appendChild(h('div', 'dir-tools-label dir-tools-gap', '家具 · 桌椅板凳'));
    const furnRow = h('div', 'dir-tool-row');
    FURNITURE.forEach(([kind, label]) => {
      const btn = h('button', 'dir-tool', label);
      btn.type = 'button';
      btn.title = '放一张' + label + '，可用右侧颜色换材质色';
      btn.addEventListener('click', () => this.addPrimitive(kind));
      furnRow.appendChild(btn);
    });
    shelfTools.appendChild(furnRow);
    shelf.appendChild(shelfTools);

    const stageWrap = h('section', 'dir-stage-wrap');
    this.stage = h('div', 'dir-stage');
    this.frame = h('div', 'dir-frame');
    this.stage.appendChild(this.frame);
    this.stageHint = h('div', 'dir-stage-hint', '左键转视角 · 滚轮推拉 · 右键平移 · 点素材选中后拖轴摆位');
    this.stage.appendChild(this.stageHint);
    this.stageBadge = h('div', 'dir-stage-badge', '自由视角');
    this.stage.appendChild(this.stageBadge);
    // 构图辅助只画在舞台 DOM 上，不会进 canvas，也不会被拍进成片
    this.guides = h('div', 'dir-guides');
    this.guides.innerHTML =
      '<span class="dir-g-third v1"></span><span class="dir-g-third v2"></span>' +
      '<span class="dir-g-third h1"></span><span class="dir-g-third h2"></span>' +
      '<span class="dir-g-safe"></span><span class="dir-g-center"></span>';
    this.frame.appendChild(this.guides);
    stageWrap.appendChild(this.stage);

    const inspect = h('aside', 'dir-inspect');
    this.inspectBody = h('div', 'dir-inspect-body');
    inspect.appendChild(this.inspectBody);

    main.appendChild(shelf);
    main.appendChild(stageWrap);
    main.appendChild(inspect);

    // 底栏：时间轴 + 输出
    const foot = h('div', 'dir-foot');
    const tl = h('div', 'dir-timeline');
    const tlBar = h('div', 'dir-tl-bar');
    this.playBtn = h('button', 'dir-btn dir-play', '▶');
    this.playBtn.type = 'button';
    this.playBtn.title = '播放运镜预览';
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.timeLabel = h('span', 'dir-time', '0.0s');
    this.kfBtn = h('button', 'dir-btn', '＋ 记下当前机位');
    this.kfBtn.type = 'button';
    this.kfBtn.title = '把现在的镜头位置记成一个关键帧';
    this.kfBtn.addEventListener('click', () => this.addKeyframe());
    tlBar.appendChild(this.playBtn);
    tlBar.appendChild(this.timeLabel);
    tlBar.appendChild(h('span', 'grow'));
    tlBar.appendChild(this.kfBtn);
    this.tlTrack = h('div', 'dir-tl-track');
    this.tlTrack.title = '点空白处把时间挪过去；点关键帧选中，× 删除';
    this.tlTrack.addEventListener('pointerdown', (event) => {
      if (event.target.closest && event.target.closest('.dir-kf')) return;
      const rect = this.tlTrack.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      this.setTime(ratio * this.scene.duration);
    });
    this.tlCursor = h('div', 'dir-tl-cursor');
    this.tlTrack.appendChild(this.tlCursor);
    tl.appendChild(tlBar);
    tl.appendChild(this.tlTrack);

    const out = h('div', 'dir-export');
    out.appendChild(h('div', 'dir-tools-label', '出图'));
    const row1 = h('div', 'dir-tool-row');
    [
      ['color', '拍一张'],
      ['clay', '白模'],
      ['line', '线稿'],
      ['depth', '深度图'],
    ].forEach(([mode, label]) => {
      const btn = h('button', 'dir-tool', label);
      btn.type = 'button';
      btn.title = '按当前画幅出一张' + label + '，自动连回这张导演台卡片';
      btn.dataset.shot = mode;
      btn.addEventListener('click', () => this.shoot(mode));
      row1.appendChild(btn);
    });
    out.appendChild(row1);
    const row2 = h('div', 'dir-tool-row');
    this.seqBtn = h('button', 'dir-tool', '按机位拍一组');
    this.seqBtn.type = 'button';
    this.seqBtn.title = '每个关键帧各出一张图，按顺序摆到画布上';
    this.seqBtn.addEventListener('click', () => this.shootKeyframes());
    this.videoBtn = h('button', 'dir-tool primary', '拍成视频');
    this.videoBtn.type = 'button';
    this.videoBtn.title = '按关键帧运镜录一段视频';
    this.videoBtn.addEventListener('click', () => this.recordVideo());
    row2.appendChild(this.seqBtn);
    row2.appendChild(this.videoBtn);
    out.appendChild(row2);
    this.busyLabel = h('div', 'dir-busy', '');
    out.appendChild(this.busyLabel);

    foot.appendChild(tl);
    foot.appendChild(out);

    app.appendChild(head);
    app.appendChild(main);
    app.appendChild(foot);
    mask.appendChild(app);
    this.mask = mask;

    mask.addEventListener('pointerdown', (event) => {
      if (event.target === mask) this.close();
    });
    this.onKey = (event) => {
      if (!this.mask) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        return;
      }
      const typing = event.target && (event.target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName));
      if (typing) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!this.selectedId) return;
        event.preventDefault();
        this.removeSelected();
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        this.redo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        this.duplicateSelected();
        return;
      }
      if (event.key.toLowerCase() === 'g') this.setGizmo('translate');
      if (event.key.toLowerCase() === 'r') this.setGizmo('rotate');
      if (event.key.toLowerCase() === 's') this.setGizmo('scale');
    };
    document.addEventListener('keydown', this.onKey, true);
  }

  // ---------- 三维 ----------
  initThree() {
    const stage = this.stage;
    const width = Math.max(320, stage.clientWidth);
    const height = Math.max(240, stage.clientHeight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    canvas.className = 'dir-canvas';
    stage.insertBefore(canvas, this.frame);

    this.scene3 = new THREE.Scene();
    this.scene3.background = new THREE.Color(STAGE_BG);
    this.scene3.fog = new THREE.Fog(STAGE_BG, 34, 78);

    this.camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 400);
    const cam = this.scene.camera;
    this.camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
    this.camera.fov = cam.fov;
    this.camera.updateProjectionMatrix();
    this.lookTarget = new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2]);
    this.camera.lookAt(this.lookTarget);

    // 灯光：半球打底 + 主光出形 + 侧逆光勾边
    this.scene3.add(new THREE.HemisphereLight(0xdfe9ff, 0x1b2230, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(6, 11, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 60;
    key.shadow.camera.left = -18;
    key.shadow.camera.right = 18;
    key.shadow.camera.top = 18;
    key.shadow.camera.bottom = -18;
    this.scene3.add(key);
    const rim = new THREE.DirectionalLight(0x9ec6ff, 1.1);
    rim.position.set(-8, 6, -9);
    this.scene3.add(rim);

    // 地面 + 网格
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x1a2434, roughness: 0.95, metalness: 0 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.002;
    ground.receiveShadow = true;
    ground.userData.helper = true;
    this.scene3.add(ground);
    this.ground = ground;

    const grid = new THREE.GridHelper(60, 60, 0x3f5a80, 0x223047);
    grid.material.opacity = 0.75;
    grid.material.transparent = true;
    grid.position.y = 0.001;
    grid.userData.helper = true;
    this.scene3.add(grid);
    this.grid = grid;

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.copy(this.lookTarget);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 1.2;
    this.orbit.maxDistance = 60;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.addEventListener('change', () => {
      this.needsRender = true;
      if (this.viewMode === 'free') this.syncCameraFromView();
    });

    this.transform = new TransformControls(this.camera, canvas);
    this.transform.setSize(0.85);
    this.transform.addEventListener('dragging-changed', (event) => {
      this.orbit.enabled = !event.value;
      if (event.value) this.recordHistory();
    });
    this.transform.addEventListener('objectChange', () => this.syncSelected());
    this.transform.addEventListener('change', () => {
      this.needsRender = true;
    });
    this.scene3.add(this.transform.getHelper());

    // 恢复上次摆好的东西
    this.scene.objects.forEach((item) => this.spawn(item, true));

    // 点选
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (this.transform && this.transform.dragging) return;
      this.pickAt(event);
    });
    canvas.addEventListener('pointerleave', () => {
      this.stageHint.classList.remove('dim');
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(stage);
    this.applyAspect();
    this.needsRender = true;
  }

  resize() {
    if (!this.renderer || !this.stage) return;
    const width = Math.max(320, this.stage.clientWidth);
    const height = Math.max(240, this.stage.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = this.aspectValue();
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  aspectValue() {
    return ASPECTS[this.scene.aspect] || 16 / 9;
  }

  // 画幅框：在舞台里画一个「摄影机看到的那块」，非当前比例的部分压暗
  applyAspect() {
    if (!this.stage || !this.frame) return;
    const w = this.stage.clientWidth;
    const hgt = this.stage.clientHeight;
    const ratio = this.aspectValue();
    let fw = w * 0.92;
    let fh = fw / ratio;
    if (fh > hgt * 0.9) {
      fh = hgt * 0.9;
      fw = fh * ratio;
    }
    this.frame.style.width = Math.round(fw) + 'px';
    this.frame.style.height = Math.round(fh) + 'px';
    this.frame.style.left = Math.round((w - fw) / 2) + 'px';
    this.frame.style.top = Math.round((hgt - fh) / 2) + 'px';
    if (this.camera) {
      this.camera.aspect = ratio;
      this.camera.updateProjectionMatrix();
      this.needsRender = true;
    }
  }

  // ---------- 场景里的东西 ----------
  textureFor(item) {
    if (!item.url) return null;
    if (item.kind === 'video') {
      const video = document.createElement('video');
      video.src = item.url;
      video.crossOrigin = 'anonymous';
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      const play = () => {
        const task = video.play();
        if (task && task.catch) task.catch(() => {});
      };
      video.addEventListener('loadeddata', play);
      play();
      const texture = new THREE.VideoTexture(video);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }
    const texture = new THREE.TextureLoader().load(item.url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  }

  solidMaterial(item) {
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(item.color || '#b9c7dc'),
      roughness: 0.5,
      metalness: 0.05,
      transparent: item.opacity < 1,
      opacity: item.opacity,
    });
  }

  // 统一的摆放 / 角度 / 缩放，人物和家具共用
  applyItemTransform(group, item) {
    group.position.set(item.pos[0], item.pos[1], item.pos[2]);
    group.rotation.set(
      THREE.MathUtils.degToRad(item.rot[0]),
      THREE.MathUtils.degToRad(item.rot[1]),
      THREE.MathUtils.degToRad(item.rot[2])
    );
    group.scale.set(item.scale[0] || 1, item.scale[1] || 1, item.scale[2] || 1);
    group.visible = item.visible !== false;
  }

  // 人形：分层关节，头 / 腰 / 肩 / 肘 / 胯 / 膝都能单独掰
  buildPerson(item) {
    const root = new THREE.Group();
    root.userData.objectId = item.id;
    if (!item.pose) item.pose = defaultPose();

    const part = (parent, geo, pos) => {
      const mesh = new THREE.Mesh(geo, this.solidMaterial(item));
      mesh.position.set(pos[0], pos[1], pos[2]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.objectId = item.id;
      parent.add(mesh);
      return mesh;
    };
    const pivot = (parent, pos) => {
      const group = new THREE.Group();
      group.position.set(pos[0], pos[1], pos[2]);
      parent.add(group);
      return group;
    };
    const capsule = (radius, len) => new THREE.CapsuleGeometry(radius, len, 6, 12);
    const joints = {};

    // 骨盆离地 0.9 米：腿往下 0.86 米，躯干和头往上
    const pelvis = pivot(root, [0, 0.9, 0]);
    part(pelvis, new THREE.BoxGeometry(0.32, 0.2, 0.2), [0, 0, 0]);

    const spine = pivot(pelvis, [0, 0.1, 0]);
    joints.spine = spine;
    part(spine, capsule(0.19, 0.4), [0, 0.26, 0]);

    const head = pivot(spine, [0, 0.56, 0]);
    joints.head = head;
    part(head, capsule(0.055, 0.08), [0, 0.03, 0]);
    part(head, new THREE.SphereGeometry(0.115, 24, 18), [0, 0.16, 0]);

    const buildArm = (side) => {
      const sign = side === 'l' ? -1 : 1;
      const shoulder = pivot(spine, [sign * 0.23, 0.45, 0]);
      joints[side + 'Shoulder'] = shoulder;
      part(shoulder, capsule(0.055, 0.2), [0, -0.14, 0]);
      const elbow = pivot(shoulder, [0, -0.3, 0]);
      joints[side + 'Elbow'] = elbow;
      part(elbow, capsule(0.048, 0.19), [0, -0.13, 0]);
      part(elbow, new THREE.SphereGeometry(0.05, 14, 10), [0, -0.26, 0]);
    };
    buildArm('l');
    buildArm('r');

    const buildLeg = (side) => {
      const sign = side === 'l' ? -1 : 1;
      const hip = pivot(pelvis, [sign * 0.1, -0.04, 0]);
      joints[side + 'Hip'] = hip;
      part(hip, capsule(0.07, 0.3), [0, -0.22, 0]);
      const knee = pivot(hip, [0, -0.44, 0]);
      joints[side + 'Knee'] = knee;
      part(knee, capsule(0.06, 0.28), [0, -0.2, 0]);
      part(knee, new THREE.BoxGeometry(0.11, 0.07, 0.24), [0, -0.4, 0.04]);
    };
    buildLeg('l');
    buildLeg('r');

    root.userData.personJoints = joints;
    this.applyPersonPose(root, item);
    this.applyItemTransform(root, item);
    return root;
  }

  // 把 item.pose 的度数套到关节上
  applyPersonPose(group, item) {
    const joints = group && group.userData ? group.userData.personJoints : null;
    if (!joints) return;
    if (!item.pose) item.pose = defaultPose();
    const pose = Object.assign(defaultPose(), item.pose);
    const rad = (key) => THREE.MathUtils.degToRad(Number(pose[key]) || 0);
    const out = rad('armsOut');
    joints.head.rotation.set(rad('head'), 0, 0);
    joints.spine.rotation.set(rad('spine'), 0, 0);
    joints.lShoulder.rotation.set(rad('lShoulder'), 0, -out);
    joints.rShoulder.rotation.set(rad('rShoulder'), 0, out);
    joints.lElbow.rotation.set(rad('lElbow'), 0, 0);
    joints.rElbow.rotation.set(rad('rElbow'), 0, 0);
    joints.lHip.rotation.set(rad('lHip'), 0, 0);
    joints.rHip.rotation.set(rad('rHip'), 0, 0);
    joints.lKnee.rotation.set(rad('lKnee'), 0, 0);
    joints.rKnee.rotation.set(rad('rKnee'), 0, 0);
  }

  // 家具：桌椅板凳等，主色跟 item.color 走，五金件固定色
  buildFurniture(item) {
    const group = new THREE.Group();
    group.userData.objectId = item.id;
    const color = item.color || '#8a5a33';
    const makeMat = (hex, rough, metalness) =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(hex),
        roughness: rough == null ? 0.7 : rough,
        metalness: metalness == null ? 0.05 : metalness,
        transparent: item.opacity < 1,
        opacity: item.opacity,
      });
    const part = (geo, pos, opts) => {
      const o = opts || {};
      const mesh = new THREE.Mesh(geo, makeMat(o.fixed || color, o.rough, o.metal));
      mesh.position.set(pos[0], pos[1], pos[2]);
      if (o.rot) mesh.rotation.set(o.rot[0], o.rot[1], o.rot[2]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (o.fixed) mesh.userData.fixedTint = true;
      mesh.userData.objectId = item.id;
      group.add(mesh);
      return mesh;
    };
    const leg = (x, z, h, size) => {
      part(new THREE.BoxGeometry(size || 0.055, h, size || 0.055), [x, h / 2 + 0.01, z], {
        fixed: '#4a4036',
        rough: 0.55,
        metal: 0.15,
      });
    };
    if (item.kind === 'chair') {
      part(new THREE.BoxGeometry(0.46, 0.07, 0.46), [0, 0.45, 0]);
      [-0.185, 0.185].forEach((x) => [-0.185, 0.185].forEach((z) => leg(x, z, 0.42)));
      part(new THREE.BoxGeometry(0.46, 0.5, 0.06), [0, 0.72, -0.2]);
    } else if (item.kind === 'stool') {
      part(new THREE.CylinderGeometry(0.2, 0.21, 0.07, 24), [0, 0.45, 0]);
      [-0.12, 0.12].forEach((x) => [-0.12, 0.12].forEach((z) => leg(x, z, 0.42, 0.05)));
    } else if (item.kind === 'bench') {
      part(new THREE.BoxGeometry(1.5, 0.09, 0.42), [0, 0.45, 0]);
      [-0.62, 0.62].forEach((x) => [-0.14, 0.14].forEach((z) => leg(x, z, 0.42, 0.07)));
    } else if (item.kind === 'table') {
      part(new THREE.BoxGeometry(1.2, 0.07, 0.72), [0, 0.74, 0]);
      [-0.52, 0.52].forEach((x) => [-0.27, 0.27].forEach((z) => leg(x, z, 0.7, 0.07)));
    } else if (item.kind === 'roundtable') {
      part(new THREE.CylinderGeometry(0.6, 0.6, 0.07, 36), [0, 0.74, 0]);
      part(new THREE.CylinderGeometry(0.09, 0.09, 0.66, 20), [0, 0.38, 0], { fixed: '#4a4036', metal: 0.2 });
      part(new THREE.CylinderGeometry(0.36, 0.4, 0.05, 28), [0, 0.03, 0], { fixed: '#4a4036', metal: 0.2 });
    } else if (item.kind === 'sofa') {
      part(new THREE.BoxGeometry(1.9, 0.32, 0.86), [0, 0.2, 0]);
      part(new THREE.BoxGeometry(1.9, 0.56, 0.16), [0, 0.62, -0.35]);
      part(new THREE.BoxGeometry(0.16, 0.52, 0.86), [-0.87, 0.4, 0]);
      part(new THREE.BoxGeometry(0.16, 0.52, 0.86), [0.87, 0.4, 0]);
      part(new THREE.BoxGeometry(0.78, 0.14, 0.68), [-0.4, 0.42, 0.03], { rough: 0.95 });
      part(new THREE.BoxGeometry(0.78, 0.14, 0.68), [0.4, 0.42, 0.03], { rough: 0.95 });
      [-0.84, 0.84].forEach((x) => [-0.34, 0.34].forEach((z) => leg(x, z, 0.06, 0.07)));
    } else if (item.kind === 'cabinet') {
      part(new THREE.BoxGeometry(0.9, 1.05, 0.44), [0, 0.6, 0]);
      part(new THREE.BoxGeometry(0.41, 0.92, 0.03), [-0.22, 0.6, 0.23], { fixed: '#5b432c' });
      part(new THREE.BoxGeometry(0.41, 0.92, 0.03), [0.22, 0.6, 0.23], { fixed: '#5b432c' });
      [-0.05, 0.05].forEach((x) => part(new THREE.SphereGeometry(0.025, 12, 8), [x, 0.6, 0.26], { fixed: '#cbb27a', metal: 0.7, rough: 0.3 }));
      [-0.38, 0.38].forEach((x) => [-0.16, 0.16].forEach((z) => leg(x, z, 0.08, 0.06)));
    } else if (item.kind === 'lamp') {
      part(new THREE.CylinderGeometry(0.17, 0.2, 0.05, 24), [0, 0.03, 0], { fixed: '#3f434c', metal: 0.5, rough: 0.35 });
      part(new THREE.CylinderGeometry(0.02, 0.02, 1.0, 12), [0, 0.54, 0], { fixed: '#8d939e', metal: 0.7, rough: 0.3 });
      const shade = part(new THREE.ConeGeometry(0.26, 0.3, 26, 1, true), [0, 1.13, 0], { fixed: '#f0d6a4', rough: 0.85 });
      shade.userData.glow = true;
      shade.material.emissive = new THREE.Color(0x8a5f1c);
      shade.material.emissiveIntensity = 0.55;
      shade.material.side = THREE.DoubleSide;
      const glow = new THREE.PointLight(0xffd9a0, 12, 5, 2);
      glow.position.set(0, 1.05, 0);
      group.add(glow);
    } else {
      part(new THREE.BoxGeometry(0.7, 0.7, 0.7), [0, 0.35, 0]);
    }
    this.applyItemTransform(group, item);
    return group;
  }

  buildObject(item) {
    if (item.kind === 'person') return this.buildPerson(item);
    if (FURNITURE_KINDS.indexOf(item.kind) >= 0) return this.buildFurniture(item);
    const group = new THREE.Group();
    group.userData.objectId = item.id;
    let mesh;
    if (item.kind === 'image' || item.kind === 'video') {
      const texture = this.textureFor(item);
      const material = new THREE.MeshBasicMaterial({
        map: texture || null,
        color: texture ? 0xffffff : 0x8ea3c2,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: item.opacity,
        toneMapped: false,
      });
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(item.w, item.h), material);
    } else if (item.kind === 'sphere') {
      mesh = new THREE.Mesh(new THREE.SphereGeometry(0.9, 32, 24), this.solidMaterial(item));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    } else if (item.kind === 'cylinder') {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 3.2, 32), this.solidMaterial(item));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    } else if (item.kind === 'cone') {
      mesh = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.6, 32), this.solidMaterial(item));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    } else if (item.kind === 'torus') {
      mesh = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.22, 20, 48), this.solidMaterial(item));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    } else if (item.kind === 'plane') {
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(item.w, item.h), this.solidMaterial(item));
      mesh.material.side = THREE.DoubleSide;
      mesh.receiveShadow = true;
    } else {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), this.solidMaterial(item));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    mesh.userData.objectId = item.id;
    group.add(mesh);
    group.position.set(item.pos[0], item.pos[1], item.pos[2]);
    group.rotation.set(
      THREE.MathUtils.degToRad(item.rot[0]),
      THREE.MathUtils.degToRad(item.rot[1]),
      THREE.MathUtils.degToRad(item.rot[2])
    );
    group.scale.set(item.scale[0] || 1, item.scale[1] || 1, item.scale[2] || 1);
    group.visible = item.visible !== false;
    return group;
  }

  spawn(item, restoring) {
    if (!this.scene3) return null;
    const group = this.buildObject(item);
    this.scene3.add(group);
    this.objects.set(item.id, { item, group });
    if (!restoring) {
      this.scene.objects.push(item);
      this.pushChange();
    }
    this.needsRender = true;
    return group;
  }

  disposeObject(entry) {
    if (!entry || !entry.group) return;
    entry.group.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const list = Array.isArray(child.material) ? child.material : [child.material];
        list.forEach((mat) => {
          if (mat.map) mat.map.dispose();
          mat.dispose();
        });
      }
    });
    this.scene3 && this.scene3.remove(entry.group);
  }

  objectAt(item) {
    return this.objects.get(item.id) || null;
  }

  addMaterial(mat) {
    if (!mat || !mat.url) return;
    this.recordHistory();
    const ratio = mat.width && mat.height ? mat.width / mat.height : 16 / 9;
    const height = 3.2;
    const width = clamp(height * ratio, 0.6, 9);
    // 新素材依次往右排，别叠在一起
    const count = this.scene.objects.filter((item) => item.kind === 'image' || item.kind === 'video').length;
    const item = {
      id: uid('o'),
      kind: mat.kind === 'video' ? 'video' : 'image',
      url: String(mat.url || ''),
      name: String(mat.name || ''),
      w: round2(width),
      h: round2(height),
      pos: [round2(-2.2 + (count % 4) * 2.4), round2(height / 2), round2(-1.2 + Math.floor(count / 4) * 0.6)],
      rot: [0, 0, 0],
      scale: [1, 1, 1],
      opacity: 1,
      color: '#b9c7dc',
      visible: true,
    };
    this.spawn(item, false);
    this.select(item.id);
    this.renderInspector();
    this.toast('已把「' + (mat.name || '素材') + '」放进场景');
  }

  addPrimitive(kind) {
    this.recordHistory();
    const safe = KINDS.indexOf(kind) >= 0 ? kind : 'box';
    const label = PRIMITIVE_LABEL[safe] || '方块';
    const presets = {
      sphere: { w: 1.8, h: 1.8, pos: [0, 0.9, 0], scale: [1, 1, 1] },
      cylinder: { w: 0.9, h: 3.2, pos: [0, 1.6, 0], scale: [1, 1, 1] },
      cone: { w: 1.5, h: 1.6, pos: [0, 0.8, 0], scale: [1, 1, 1] },
      torus: { w: 1.6, h: 1.6, pos: [0, 1.4, 0], scale: [1, 1, 1] },
      plane: { w: 2.4, h: 2.4, pos: [0, 1.4, -2], scale: [1, 1, 1] },
      person: { w: 0.6, h: 1.75, pos: [0, 0, 0], scale: [1, 1, 1] },
      ground: { w: 8, h: 0.4, pos: [0, 0.2, 0], scale: [6, 0.3, 6] },
      chair: { w: 0.5, h: 1.0, pos: [0, 0, 0], scale: [1, 1, 1] },
      stool: { w: 0.42, h: 0.48, pos: [0, 0, 0], scale: [1, 1, 1] },
      bench: { w: 1.5, h: 0.52, pos: [0, 0, 0], scale: [1, 1, 1] },
      table: { w: 1.2, h: 0.78, pos: [0, 0, 0], scale: [1, 1, 1] },
      roundtable: { w: 1.2, h: 0.78, pos: [0, 0, 0], scale: [1, 1, 1] },
      sofa: { w: 1.9, h: 0.95, pos: [0, 0, 0], scale: [1, 1, 1] },
      cabinet: { w: 0.9, h: 1.15, pos: [0, 0, 0], scale: [1, 1, 1] },
      lamp: { w: 0.5, h: 1.4, pos: [0, 0, 0], scale: [1, 1, 1] },
    };
    const furnitureColor = {
      chair: '#8a5a33',
      stool: '#9a6a3c',
      bench: '#8a5a33',
      table: '#8a5a33',
      roundtable: '#8a5a33',
      sofa: '#5e7490',
      cabinet: '#7a5b3d',
      lamp: '#c9a15f',
    };
    const preset = presets[safe] || { w: 1.4, h: 1.4, pos: [0, 0.7, 0], scale: [1, 1, 1] };
    // 依次往右错开一点，别叠在一起
    const same = this.scene.objects.filter((it) => it.kind === safe).length;
    const shift = (same % 4) * 1.2;
    const item = {
      id: uid('o'),
      kind: safe === 'ground' ? 'box' : safe,
      url: '',
      name: label,
      w: preset.w,
      h: preset.h,
      pos: [round2(preset.pos[0] + shift), preset.pos[1], round2(preset.pos[2] + Math.floor(same / 4) * 1.2)],
      rot: [0, 0, 0],
      scale: preset.scale.slice(),
      opacity: 1,
      color: furnitureColor[safe] || (safe === 'person' ? '#cbb7a3' : '#b9c7dc'),
      pose: defaultPose(),
      visible: true,
    };
    if (safe === 'ground') item.scale = [6, 0.3, 6];
    this.spawn(item, false);
    this.select(item.id);
    this.renderInspector();
  }

  pickAt(event) {
    if (!this.camera) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets = [];
    this.objects.forEach((entry) => targets.push(entry.group));
    const hits = this.raycaster.intersectObjects(targets, true);
    if (!hits.length) {
      this.select('');
      return;
    }
    let node = hits[0].object;
    while (node && !node.userData.objectId) node = node.parent;
    this.select(node ? node.userData.objectId : '');
  }

  clearSelectionBox() {
    if (!this.selectionBox) return;
    if (this.scene3) this.scene3.remove(this.selectionBox);
    if (this.selectionBox.geometry) this.selectionBox.geometry.dispose();
    if (this.selectionBox.material) this.selectionBox.material.dispose();
    this.selectionBox = null;
  }

  select(id) {
    this.selectedId = id || '';
    this.objects.forEach((entry) => {
      entry.group.traverse((child) => {
        if (child.isMesh && child.material && 'emissiveIntensity' in child.material && !child.userData.glow) {
          child.material.emissive = new THREE.Color(0x000000);
        }
      });
    });
    const entry = this.objects.get(this.selectedId);
    // 选中框：比柔和高亮更清楚，深色场景里也一眼看到选了谁
    this.clearSelectionBox();
    if (entry) {
      const box = new THREE.BoxHelper(entry.group, 0x6fa8ff);
      box.userData.helper = true;
      box.material.depthTest = false;
      box.material.transparent = true;
      box.material.opacity = 0.95;
      this.scene3.add(box);
      this.selectionBox = box;
    }
    if (this.transform) {
      this.transform.detach();
      if (entry) {
        this.transform.attach(entry.group);
        this.transform.setMode(this.gizmoMode);
      }
    }
    this.renderInspector();
    this.needsRender = true;
  }

  syncSelected() {
    const entry = this.objects.get(this.selectedId);
    if (!entry) return;
    const item = entry.item;
    item.pos = [round2(entry.group.position.x), round2(entry.group.position.y), round2(entry.group.position.z)];
    item.rot = [
      round2(THREE.MathUtils.radToDeg(entry.group.rotation.x)),
      round2(THREE.MathUtils.radToDeg(entry.group.rotation.y)),
      round2(THREE.MathUtils.radToDeg(entry.group.rotation.z)),
    ];
    item.scale = [round2(entry.group.scale.x), round2(entry.group.scale.y), round2(entry.group.scale.z)];
    if (this.selectionBox) this.selectionBox.update();
    this.pushChange();
    this.paintNumbers();
  }

  setGizmo(mode) {
    this.gizmoMode = ['translate', 'rotate', 'scale'].indexOf(mode) >= 0 ? mode : 'translate';
    if (this.transform) this.transform.setMode(this.gizmoMode);
    if (this.inspectBody) this.paintGizmoButtons();
  }

  removeSelected() {
    if (!this.selectedId) return;
    const entry = this.objects.get(this.selectedId);
    if (!entry) return;
    this.recordHistory();
    this.transform && this.transform.detach();
    this.clearSelectionBox();
    this.disposeObject(entry);
    this.objects.delete(this.selectedId);
    this.scene.objects = this.scene.objects.filter((item) => item.id !== this.selectedId);
    this.selectedId = '';
    this.renderInspector();
    this.pushChange();
  }

  // ---------- 视角 ----------
  toggleGuides(force) {
    this.guidesOn = typeof force === 'boolean' ? force : !this.guidesOn;
    if (this.guides) this.guides.classList.toggle('on', this.guidesOn);
    if (this.guidesBtn) {
      this.guidesBtn.classList.toggle('on', this.guidesOn);
      this.guidesBtn.setAttribute('aria-pressed', this.guidesOn ? 'true' : 'false');
      this.guidesBtn.title = this.guidesOn
        ? '隐藏三分线和安全框（不会被拍进成片）'
        : '显示三分线和安全框，方便构图（不会被拍进成片）';
    }
  }

  setViewMode(mode) {
    if (!this.camera || !this.orbit) return;
    this.viewMode = mode === 'camera' ? 'camera' : 'free';
    const isCam = this.viewMode === 'camera';
    this.freeBtn.classList.toggle('on', !isCam);
    this.camBtn.classList.toggle('on', isCam);
    this.stageBadge.textContent = isCam ? '导演视角（出图所见）' : '自由视角';
    this.stage.classList.toggle('camera-view', isCam);
    this.transform.enabled = !isCam;
    if (isCam) {
      this.transform.detach();
      this.orbit.enabled = false;
      this.applyCameraPose(this.currentPose());
    } else {
      this.orbit.enabled = true;
      this.orbit.target.copy(this.lookTarget);
      this.orbit.update();
    }
    this.needsRender = true;
  }

  applyCameraPose(pose) {
    if (!this.camera) return;
    this.camera.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    this.camera.fov = pose.fov;
    this.camera.updateProjectionMatrix();
    this.lookTarget.set(pose.target[0], pose.target[1], pose.target[2]);
    this.camera.lookAt(this.lookTarget);
    this.needsRender = true;
  }

  // 自由视角下，每次转完把镜头记进场景；这样重新打开还是这个角度
  syncCameraFromView() {
    if (!this.camera || this.viewMode !== 'free') return;
    const cam = this.scene.camera;
    cam.pos = [round2(this.camera.position.x), round2(this.camera.position.y), round2(this.camera.position.z)];
    cam.target = [round2(this.lookTarget.x), round2(this.lookTarget.y), round2(this.lookTarget.z)];
    cam.fov = round2(this.camera.fov);
    this.pushChange();
  }

  currentPose() {
    if (!this.camera) {
      const cam = this.scene.camera;
      return { pos: cam.pos.slice(), target: cam.target.slice(), fov: cam.fov };
    }
    const target = this.orbit && this.viewMode === 'free' ? this.orbit.target : this.lookTarget;
    return {
      pos: [round2(this.camera.position.x), round2(this.camera.position.y), round2(this.camera.position.z)],
      target: [round2(target.x), round2(target.y), round2(target.z)],
      fov: round2(this.camera.fov),
    };
  }

  // ---------- 关键帧 ----------
  addKeyframe() {
    this.recordHistory();
    const pose = this.currentPose();
    const t = round2(this.time);
    const hit = this.scene.keyframes.find((k) => Math.abs(k.t - t) <= 0.06);
    if (hit) {
      hit.pos = pose.pos;
      hit.target = pose.target;
      hit.fov = pose.fov;
      this.toast('这个时间点已有机位，已更新');
    } else {
      this.scene.keyframes.push({ t, pos: pose.pos, target: pose.target, fov: pose.fov });
      this.scene.keyframes.sort((a, b) => a.t - b.t);
      this.toast('已记下 ' + t.toFixed(1) + ' 秒的机位');
    }
    this.renderTimeline();
    this.pushChange();
  }

  removeKeyframe(t) {
    this.recordHistory();
    this.scene.keyframes = this.scene.keyframes.filter((k) => Math.abs(k.t - t) > 0.001);
    this.renderTimeline();
    this.pushChange();
  }

  sampleCamera(time) {
    const list = this.scene.keyframes;
    if (!list.length) return this.scene.camera;
    if (list.length === 1) return list[0];
    if (time <= list[0].t) return list[0];
    const last = list[list.length - 1];
    if (time >= last.t) return last;
    let i = 0;
    while (i < list.length - 1 && list[i + 1].t < time) i += 1;
    const a = list[i];
    const b = list[i + 1];
    const span = Math.max(0.0001, b.t - a.t);
    const k = easeValue(this.scene.easing, clamp((time - a.t) / span, 0, 1));
    return {
      pos: lerp3(a.pos, b.pos, k),
      target: lerp3(a.target, b.target, k),
      fov: lerp(a.fov, b.fov, k),
    };
  }

  setTime(time) {
    this.time = clamp(Number(time) || 0, 0, this.scene.duration);
    if (this.scene.keyframes.length) this.applyCameraPose(this.sampleCamera(this.time));
    this.paintTimelineCursor();
    this.needsRender = true;
  }

  togglePlay() {
    if (this.playing) this.stopPlay();
    else this.startPlay();
  }

  startPlay() {
    if (!this.scene.keyframes.length) {
      this.toast('先记两个机位，才能看到运镜');
      return;
    }
    if (this.time >= this.scene.duration - 0.02) this.time = 0;
    this.playing = true;
    this.lastTick = performance.now();
    this.playBtn.textContent = '❚❚';
    this.playBtn.classList.add('on');
    this.setViewMode('camera');
  }

  stopPlay() {
    this.playing = false;
    if (this.playBtn) {
      this.playBtn.textContent = '▶';
      this.playBtn.classList.remove('on');
    }
  }

  loop() {
    if (!this.mask) return;
    const now = performance.now();
    const delta = this.lastTick ? Math.min(0.1, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    if (this.playing) {
      this.time += delta;
      if (this.time >= this.scene.duration) {
        this.time = this.scene.duration;
        this.applyCameraPose(this.sampleCamera(this.time));
        this.paintTimelineCursor();
        this.stopPlay();
      } else {
        this.applyCameraPose(this.sampleCamera(this.time));
        this.paintTimelineCursor();
      }
      this.needsRender = true;
    }
    if (this.orbit && this.orbit.enabled) {
      if (this.orbit.update()) this.needsRender = true;
    }
    if (this.needsRender && this.renderer && this.scene3 && this.camera) {
      this.renderer.render(this.scene3, this.camera);
      this.needsRender = false;
    }
    this.raf = requestAnimationFrame(() => this.loop());
  }

  // ---------- 左侧素材架 ----------
  renderShelf() {
    if (!this.shelfBody) return;
    this.shelfBody.innerHTML = '';
    const list = (this.getMaterials() || []).filter((item) => item && item.url);
    this.shelfItems = list;
    if (!list.length) {
      this.shelfBody.appendChild(h('div', 'dir-empty', '画布上还没有图片或视频素材，先去生成或上传几张'));
      return;
    }
    list.forEach((item) => {
      const card = h('button', 'dir-mat');
      card.type = 'button';
      card.title = (item.name || '素材') + '　点一下放进场景';
      const thumb = h('div', 'dir-mat-thumb');
      if (item.kind === 'video') {
        const video = h('video');
        video.src = item.url;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        thumb.appendChild(video);
        thumb.appendChild(h('span', 'dir-mat-kind', '视频'));
      } else {
        const img = h('img');
        img.src = item.url;
        img.alt = item.name || '素材';
        img.draggable = false;
        thumb.appendChild(img);
      }
      card.appendChild(thumb);
      card.appendChild(h('span', 'dir-mat-name', item.name || '素材'));
      card.addEventListener('click', () => this.addMaterial(item));
      this.shelfBody.appendChild(card);
    });
  }

  // ---------- 右侧检查器 ----------
  renderInspector() {
    if (!this.inspectBody) return;
    this.inspectBody.innerHTML = '';
    const entry = this.objects.get(this.selectedId);

    const gizmoBox = h('div', 'dir-block');
    gizmoBox.appendChild(h('div', 'dir-tools-label', '操作'));
    const gizmoRow = h('div', 'dir-tool-row');
    [
      ['translate', '移动', 'G'],
      ['rotate', '旋转', 'R'],
      ['scale', '缩放', 'S'],
    ].forEach(([mode, label, key]) => {
      const btn = h('button', 'dir-tool dir-gizmo', label);
      btn.type = 'button';
      btn.dataset.mode = mode;
      btn.title = label + '（' + key + '）';
      btn.addEventListener('click', () => this.setGizmo(mode));
      gizmoRow.appendChild(btn);
    });
    gizmoBox.appendChild(gizmoRow);
    this.inspectBody.appendChild(gizmoBox);
    this.gizmoButtons = Array.from(gizmoRow.querySelectorAll('.dir-gizmo'));
    this.paintGizmoButtons();

    if (!entry) {
      const empty = h('div', 'dir-empty', '点场景里的素材选中它，这里就能调位置、角度、大小');
      this.inspectBody.appendChild(empty);
      const info = h('div', 'dir-block');
      info.appendChild(h('div', 'dir-tools-label', '场景'));
      const meta = h('div', 'dir-meta');
      meta.innerHTML =
        '<div><span>素材</span><b>' +
        this.scene.objects.filter((item) => item.kind === 'image' || item.kind === 'video').length +
        '</b></div>' +
        '<div><span>占位体</span><b>' +
        this.scene.objects.filter((item) => item.kind !== 'image' && item.kind !== 'video').length +
        '</b></div>' +
        '<div><span>机位</span><b>' +
        this.scene.keyframes.length +
        '</b></div>';
      info.appendChild(meta);
      this.inspectBody.appendChild(info);
      return;
    }

    const item = entry.item;
    const headBox = h('div', 'dir-block');
    headBox.appendChild(h('div', 'dir-tools-label', '选中的东西'));
    const nameRow = h('div', 'dir-name-row');
    const nameInput = h('input', 'dir-input');
    nameInput.value = item.name || '';
    nameInput.placeholder = '给它起个名（可选）';
    nameInput.addEventListener('focus', () => this.recordHistory());
    nameInput.addEventListener('input', () => {
      item.name = nameInput.value;
      this.pushChange();
    });
    nameRow.appendChild(nameInput);
    const del = h('button', 'dir-tool danger', '删除');
    del.type = 'button';
    del.title = '从场景里删掉（Delete）';
    del.addEventListener('click', () => this.removeSelected());
    nameRow.appendChild(del);
    headBox.appendChild(nameRow);
    this.inspectBody.appendChild(headBox);

    const addRow = (label, values, step, onChange) => {
      const row = h('div', 'dir-row');
      row.appendChild(h('span', 'dir-row-label', label));
      const inputs = values.map((value, index) => {
        const input = h('input', 'dir-input dir-num');
        input.type = 'number';
        input.step = String(step);
        input.value = String(round2(value));
        input.addEventListener('change', () => {
          const next = values.slice();
          next[index] = Number(input.value) || 0;
          onChange(next);
        });
        row.appendChild(input);
        return input;
      });
      this.inspectBody.appendChild(row);
      return inputs;
    };

    addRow('位置', item.pos, 0.1, (next) => {
      item.pos = next;
      entry.group.position.set(next[0], next[1], next[2]);
      this.pushChange();
    });
    addRow('旋转°', item.rot, 1, (next) => {
      item.rot = next;
      entry.group.rotation.set(
        THREE.MathUtils.degToRad(next[0]),
        THREE.MathUtils.degToRad(next[1]),
        THREE.MathUtils.degToRad(next[2])
      );
      this.pushChange();
    });
    addRow('缩放', item.scale, 0.05, (next) => {
      item.scale = next.map((n) => (Math.abs(n) < 0.01 ? 0.01 : n));
      entry.group.scale.set(item.scale[0], item.scale[1], item.scale[2]);
      this.pushChange();
    });

    const opacityRow = h('div', 'dir-row');
    opacityRow.appendChild(h('span', 'dir-row-label', '不透明'));
    const opacity = h('input', 'dir-range');
    opacity.type = 'range';
    opacity.min = '0';
    opacity.max = '1';
    opacity.step = '0.01';
    opacity.value = String(item.opacity);
    opacity.addEventListener('focus', () => this.recordHistory());
    opacity.addEventListener('input', () => {
      item.opacity = Number(opacity.value);
      entry.group.traverse((child) => {
        if (child.isMesh && child.material) {
          child.material.transparent = item.opacity < 1;
          child.material.opacity = item.opacity;
        }
      });
      this.needsRender = true;
      this.pushChange();
    });
    opacityRow.appendChild(opacity);
    this.inspectBody.appendChild(opacityRow);

    // 颜色：只对占位体有意义，素材图保持原色
    if (item.kind !== 'image' && item.kind !== 'video') {
      const colorRow = h('div', 'dir-row');
      colorRow.appendChild(h('span', 'dir-row-label', '颜色'));
      const color = h('input', 'dir-color');
      color.type = 'color';
      color.value = item.color || '#b9c7dc';
      color.title = '给占位体换个颜色，方便区分角色 / 道具';
      color.addEventListener('focus', () => this.recordHistory());
      color.addEventListener('input', () => {
        item.color = color.value;
        entry.group.traverse((child) => {
          if (child.isMesh && child.material && child.material.color && !child.userData.fixedTint) {
            child.material.color.set(item.color);
          }
        });
        this.needsRender = true;
        this.pushChange();
      });
      colorRow.appendChild(color);
      const vis = h('button', 'dir-tool', item.visible === false ? '显示' : '隐藏');
      vis.type = 'button';
      vis.title = '临时不参与出图，但保留在场景里';
      vis.addEventListener('click', () => {
        item.visible = item.visible === false;
        entry.group.visible = item.visible;
        vis.textContent = item.visible ? '隐藏' : '显示';
        this.needsRender = true;
        this.pushChange();
      });
      colorRow.appendChild(vis);
      this.inspectBody.appendChild(colorRow);
    }

    // 快捷动作
    const actRow = h('div', 'dir-tool-row');
    const duplicate = h('button', 'dir-tool', '复制');
    duplicate.type = 'button';
    duplicate.title = '复制一份放到旁边（Ctrl+D）';
    duplicate.addEventListener('click', () => this.duplicateSelected());
    const drop = h('button', 'dir-tool', '落地');
    drop.type = 'button';
    drop.title = '把底边贴到地面，站位更好算';
    drop.addEventListener('click', () => this.dropSelected());
    const reset = h('button', 'dir-tool', '复位');
    reset.type = 'button';
    reset.title = '旋转和缩放恢复默认';
    reset.addEventListener('click', () => this.resetSelected());
    actRow.appendChild(duplicate);
    actRow.appendChild(drop);
    actRow.appendChild(reset);
    this.inspectBody.appendChild(actRow);

    // 人物：姿势关节 + 预设
    if (item.kind === 'person') {
      if (!item.pose) item.pose = defaultPose();
      const poseBox = h('div', 'dir-block');
      poseBox.appendChild(h('div', 'dir-tools-label', '人物姿势'));
      const presetRow = h('div', 'dir-tool-row');
      const presets = [
        ['站直', {}],
        ['坐姿', { lHip: -88, rHip: -88, lKnee: 86, rKnee: 86, spine: -6 }],
        ['招手', { rShoulder: -35, rElbow: -75, armsOut: 72 }],
        ['走路', { lHip: -26, rHip: 26, lKnee: 16, rKnee: 10, lShoulder: 18, rShoulder: -18 }],
        ['蹲下', { lHip: -95, rHip: -95, lKnee: 105, rKnee: 105, spine: -18, armsOut: 16 }],
      ];
      presets.forEach(([label, values]) => {
        const btn = h('button', 'dir-tool', label);
        btn.type = 'button';
        btn.title = '整体换成' + label + '姿势，之后还能单独微调每个关节';
        btn.addEventListener('click', () => {
          this.recordHistory();
          item.pose = Object.assign(defaultPose(), values);
          this.applyPersonPose(entry.group, item);
          if (this.selectionBox) this.selectionBox.update();
          this.renderInspector();
          this.pushChange();
        });
        presetRow.appendChild(btn);
      });
      poseBox.appendChild(presetRow);

      const paintPose = () => {
        this.applyPersonPose(entry.group, item);
        if (this.selectionBox) this.selectionBox.update();
        this.needsRender = true;
      };
      POSE_FIELDS.forEach(([key, label]) => {
        const min = key === 'armsOut' ? 0 : -180;
        const max = key === 'armsOut' ? 120 : 180;
        const row = h('div', 'dir-row dir-pose-row');
        row.appendChild(h('span', 'dir-row-label', label));
        const range = h('input', 'dir-range');
        range.type = 'range';
        range.min = String(min);
        range.max = String(max);
        range.step = '1';
        range.value = String(Number(item.pose[key]) || 0);
        range.title = label + '关节角度';
        const num = h('input', 'dir-input dir-num dir-pose-num');
        num.type = 'number';
        num.min = String(min);
        num.max = String(max);
        num.step = '1';
        num.value = range.value;
        const set = (value) => {
          const next = clamp(Math.round(Number(value) || 0), min, max);
          item.pose[key] = next;
          range.value = String(next);
          num.value = String(next);
          paintPose();
          this.pushChange();
        };
        range.addEventListener('focus', () => this.recordHistory());
        range.addEventListener('input', () => set(range.value));
        num.addEventListener('change', () => set(num.value));
        row.appendChild(range);
        row.appendChild(num);
        poseBox.appendChild(row);
      });
      const poseHint = h('div', 'dir-hint', '滑杆是关节角度：正负方向相反，掰到合适就停。双手张开用最后一条。');
      poseBox.appendChild(poseHint);
      this.inspectBody.appendChild(poseBox);
    }

    // 摄影机
    const camBox = h('div', 'dir-block');
    camBox.appendChild(h('div', 'dir-tools-label', '摄影机'));
    const fovRow = h('div', 'dir-row');
    fovRow.appendChild(h('span', 'dir-row-label', '焦距'));
    const fov = h('input', 'dir-range');
    fov.type = 'range';
    fov.min = '12';
    fov.max = '90';
    fov.step = '1';
    fov.value = String(this.camera ? this.camera.fov : this.scene.camera.fov);
    fov.title = '数字越小视角越广，越大越像长焦';
    fov.addEventListener('input', () => {
      const value = Number(fov.value) || 35;
      if (this.camera) {
        this.camera.fov = value;
        this.camera.updateProjectionMatrix();
      }
      this.scene.camera.fov = value;
      this.needsRender = true;
      this.pushChange();
    });
    fovRow.appendChild(fov);
    const fovNum = h('input', 'dir-input dir-num');
    fovNum.type = 'number';
    fovNum.min = '12';
    fovNum.max = '90';
    fovNum.step = '1';
    fovNum.value = String(Math.round(this.camera ? this.camera.fov : this.scene.camera.fov));
    fovNum.title = '直接填数字：越小越广，越大越长焦';
    fovNum.addEventListener('change', () => {
      const value = clamp(Number(fovNum.value) || 35, 12, 90);
      fov.value = String(value);
      fov.dispatchEvent(new Event('input'));
      fovNum.value = String(value);
    });
    fovRow.appendChild(fovNum);
    camBox.appendChild(fovRow);

    const presetRow = h('div', 'dir-tool-row');
    [
      ['front', '正面'],
      ['side', '侧面'],
      ['top', '俯视'],
      ['low', '仰视'],
      ['iso', '等距'],
    ].forEach(([key, label]) => {
      const btn = h('button', 'dir-tool', label);
      btn.type = 'button';
      btn.title = '把摄影机挪到' + label + '机位';
      btn.addEventListener('click', () => this.applyCameraPreset(key));
      presetRow.appendChild(btn);
    });
    camBox.appendChild(presetRow);
    const camHint = h('div', 'dir-hint', '想按某个角度看，先用自由视角摆好，再点「＋ 记下当前机位」。');
    camBox.appendChild(camHint);
    this.inspectBody.appendChild(camBox);
  }

  // ---------- 对象快捷动作 ----------
  duplicateSelected() {
    const entry = this.objects.get(this.selectedId);
    if (!entry) return;
    this.recordHistory();
    const item = JSON.parse(JSON.stringify(entry.item));
    item.id = uid('o');
    item.pos = [round2(item.pos[0] + 1.2), item.pos[1], item.pos[2]];
    item.name = (item.name || '素材') + ' 副本';
    this.spawn(item, false);
    this.select(item.id);
    this.toast('已复制一份');
  }

  dropSelected() {
    const entry = this.objects.get(this.selectedId);
    if (!entry) return;
    this.recordHistory();
    const box = new THREE.Box3().setFromObject(entry.group);
    const dy = -box.min.y;
    entry.group.position.y = round2(entry.group.position.y + dy);
    entry.item.pos = [round2(entry.group.position.x), round2(entry.group.position.y), round2(entry.group.position.z)];
    if (this.selectionBox) this.selectionBox.update();
    this.paintNumbers();
    this.pushChange();
  }

  resetSelected() {
    const entry = this.objects.get(this.selectedId);
    if (!entry) return;
    this.recordHistory();
    entry.group.rotation.set(0, 0, 0);
    entry.group.scale.set(1, 1, 1);
    entry.item.rot = [0, 0, 0];
    entry.item.scale = [1, 1, 1];
    if (this.selectionBox) this.selectionBox.update();
    this.renderInspector();
    this.pushChange();
  }

  // ---------- 机位预设 ----------
  applyCameraPreset(key) {
    if (!this.camera) return;
    if (this.playing) this.stopPlay();
    const target = this.scene.camera.target || [0, 1.2, 0];
    const dist = 9.6;
    const poses = {
      front: { pos: [target[0], target[1] + 1.2, target[2] + dist], target: target },
      side: { pos: [target[0] + dist, target[1] + 1.2, target[2]], target: target },
      top: { pos: [target[0] + 0.01, target[1] + dist, target[2] + 0.01], target: target },
      low: { pos: [target[0], Math.max(0.4, target[1] - 1.6), target[2] + dist], target: [target[0], target[1] + 0.6, target[2]] },
      iso: { pos: [target[0] + dist * 0.66, target[1] + dist * 0.5, target[2] + dist * 0.66], target: target },
    };
    const pose = poses[key];
    if (!pose) return;
    const fov = this.camera.fov;
    if (this.viewMode === 'camera') {
      this.applyCameraPose({ pos: pose.pos, target: pose.target, fov: fov });
    } else {
      this.camera.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
      this.lookTarget.set(pose.target[0], pose.target[1], pose.target[2]);
      this.camera.lookAt(this.lookTarget);
      this.orbit.target.copy(this.lookTarget);
      this.orbit.update();
      this.syncCameraFromView();
    }
    this.needsRender = true;
  }

  paintGizmoButtons() {
    if (!this.gizmoButtons) return;
    this.gizmoButtons.forEach((btn) => btn.classList.toggle('on', btn.dataset.mode === this.gizmoMode));
  }

  paintNumbers() {
    if (!this.inspectBody) return;
    const entry = this.objects.get(this.selectedId);
    if (!entry) return;
    const rows = this.inspectBody.querySelectorAll('.dir-row');
    const fill = (row, values) => {
      if (!row) return;
      const inputs = row.querySelectorAll('.dir-num');
      inputs.forEach((input, index) => {
        if (document.activeElement === input) return;
        if (values[index] !== undefined) input.value = String(round2(values[index]));
      });
    };
    fill(rows[0], entry.item.pos);
    fill(rows[1], entry.item.rot);
    fill(rows[2], entry.item.scale);
  }

  // ---------- 时间轴 ----------
  renderTimeline() {
    if (!this.tlTrack) return;
    Array.from(this.tlTrack.querySelectorAll('.dir-kf')).forEach((el) => el.remove());
    const total = this.scene.duration || 8;
    this.scene.keyframes.forEach((k, index) => {
      const chip = h('button', 'dir-kf');
      chip.type = 'button';
      chip.style.left = (clamp(k.t / total, 0, 1) * 100).toFixed(2) + '%';
      chip.title = '第 ' + (index + 1) + ' 个机位 · ' + k.t.toFixed(1) + 's（点一下跳过去，右键删掉）';
      chip.appendChild(h('span', 'dir-kf-dot'));
      chip.appendChild(h('span', 'dir-kf-no', String(index + 1)));
      chip.addEventListener('click', (event) => {
        event.stopPropagation();
        if (chip.dataset.dragged === '1') {
          chip.dataset.dragged = '0';
          return;
        }
        this.setTime(k.t);
      });
      chip.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.removeKeyframe(k.t);
      });
      // 拖关键帧 = 改它出现的时间点，机位本身不动
      chip.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        const track = this.tlTrack;
        const total2 = this.scene.duration || 8;
        const move = (ev) => {
          const rect = track.getBoundingClientRect();
          const ratio = clamp((ev.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
          const next = Math.round(ratio * total2 * 10) / 10;
          if (Math.abs(next - k.t) < 0.001) return;
          chip.dataset.dragged = '1';
          k.t = next;
          chip.style.left = (clamp(next / total2, 0, 1) * 100).toFixed(2) + '%';
          this.paintTimelineCursor();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          if (chip.dataset.dragged === '1') {
            this.scene.keyframes.sort((a2, b2) => a2.t - b2.t);
            this.renderTimeline();
            this.pushChange();
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
      this.tlTrack.appendChild(chip);
    });
    this.tlTrack.classList.toggle('empty', !this.scene.keyframes.length);
    if (this.timeLabel) this.timeLabel.textContent = this.time.toFixed(1) + 's / ' + total + 's';
    this.paintTimelineCursor();
  }

  paintTimelineCursor() {
    if (!this.tlCursor) return;
    const total = this.scene.duration || 8;
    this.tlCursor.style.left = (clamp(this.time / total, 0, 1) * 100).toFixed(2) + '%';
    if (this.timeLabel) this.timeLabel.textContent = this.time.toFixed(1) + 's / ' + total + 's';
  }

  // ---------- 出图 ----------
  setBusy(on, text) {
    this.busy = Boolean(on);
    [this.seqBtn, this.videoBtn].forEach((btn) => {
      if (btn) btn.disabled = this.busy;
    });
    if (this.mask) {
      Array.from(this.mask.querySelectorAll('[data-shot]')).forEach((btn) => {
        btn.disabled = this.busy;
      });
    }
    if (this.busyLabel) this.busyLabel.textContent = this.busy ? text || '正在出图…' : '';
  }

  // 出图 / 录像时临时藏掉编辑辅助物：选中框、变换轴、网格
  hideCaptureHelpers() {
    const helper = this.transform && this.transform.getHelper ? this.transform.getHelper() : null;
    const list = [this.grid, this.selectionBox, helper].filter(Boolean);
    const visible = list.map((obj) => obj.visible);
    list.forEach((obj) => {
      obj.visible = false;
    });
    return () => {
      list.forEach((obj, index) => {
        if (obj) obj.visible = visible[index];
      });
    };
  }

  // 渲染一帧到离屏尺寸，再转成 PNG
  outputSize() {
    const base = OUTPUT[this.scene.aspect] || OUTPUT['16:9'];
    const k = this.scene.scale === 2 ? 2 : 1;
    return [base[0] * k, base[1] * k];
  }

  renderBlob(mode) {
    const size = this.outputSize();
    return new Promise((resolve) => {
      if (!this.renderer || !this.scene3) {
        resolve(null);
        return;
      }
      const stageW = this.stage.clientWidth;
      const stageH = this.stage.clientHeight;
      const restore = this.prepareRenderMode(mode);
      const restoreHelpers = this.hideCaptureHelpers();
      const prevAspect = this.camera.aspect;
      this.camera.aspect = size[0] / size[1];
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(size[0], size[1], false);
      this.renderer.render(this.scene3, this.camera);
      const canvas = this.renderer.domElement;
      const done = (blob) => {
        restoreHelpers();
        restore();
        this.camera.aspect = prevAspect;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(Math.max(320, stageW), Math.max(240, stageH), false);
        this.needsRender = true;
        resolve(blob);
      };
      if (canvas.toBlob) canvas.toBlob((blob) => done(blob), 'image/png');
      else done(null);
    });
  }

  // 白模 / 线稿 / 深度图：临时换材质、换底色，出完就还原
  prepareRenderMode(mode) {
    const undo = [];
    const scene = this.scene3;
    const bg = scene.background;
    const fog = scene.fog;
    const helpers = [this.grid, this.ground].filter(Boolean);

    if (mode === 'clay') {
      scene.background = new THREE.Color(0xe9edf4);
      scene.fog = null;
      helpers.forEach((obj) => {
        obj.visible = false;
      });
      this.objects.forEach((entry) => {
        entry.group.traverse((child) => {
          if (!child.isMesh) return;
          undo.push([child, child.material]);
          child.material = new THREE.MeshLambertMaterial({
            color: 0xdfe4ec,
            transparent: entry.item.opacity < 1,
            opacity: entry.item.opacity,
          });
        });
      });
    } else if (mode === 'line') {
      scene.background = new THREE.Color(0xffffff);
      scene.fog = null;
      helpers.forEach((obj) => {
        obj.visible = false;
      });
      this.objects.forEach((entry) => {
        entry.group.traverse((child) => {
          if (!child.isMesh) return;
          undo.push([child, child.material]);
          child.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
          const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(child.geometry, 18),
            new THREE.LineBasicMaterial({ color: 0x1a2434 })
          );
          edges.userData.temp = true;
          child.add(edges);
          undo.push([edges, null]);
        });
      });
    } else if (mode === 'depth') {
      scene.background = new THREE.Color(0x000000);
      scene.fog = null;
      helpers.forEach((obj) => {
        obj.visible = false;
      });
      this.objects.forEach((entry) => {
        entry.group.traverse((child) => {
          if (!child.isMesh) return;
          undo.push([child, child.material]);
          child.material = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });
        });
      });
    }

    return () => {
      scene.background = bg;
      scene.fog = fog;
      helpers.forEach((obj) => {
        obj.visible = true;
      });
      undo.forEach(([target, material]) => {
        if (!target) return;
        if (material === null) {
          if (target.parent) target.parent.remove(target);
          if (target.geometry) target.geometry.dispose();
          if (target.material) target.material.dispose();
          return;
        }
        if (target.material && target.material !== material) target.material.dispose();
        target.material = material;
      });
    };
  }

  async upload(blob, name, kind) {
    if (!this.api || !this.api.importAsset) throw new Error('本地服务不可用，没法保存出图');
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    const res = await this.api.importAsset(file, kind, this.canvasId);
    const asset = (res && res.asset) || {};
    if (!asset.url) throw new Error('保存出图失败');
    return asset;
  }

  // 出图 → 存进素材库 → 交给画布建卡并自动连线
  async shoot(mode) {
    if (this.busy) return;
    if (!this.objects.size) {
      this.toast('场景还是空的，先从左边放点素材进来');
      return;
    }
    const label = SHOT_LABELS[mode] || '画面';
    this.setBusy(true, '正在出「' + label + '」…');
    try {
      if (this.playing) this.stopPlay();
      const blob = await this.renderBlob(mode);
      if (!blob) throw new Error('渲染失败');
      const size = this.outputSize();
      const name = '导演台_' + label + '_' + stamp() + '.png';
      const asset = await this.upload(blob, name, 'image');
      if (this.onInsert) {
        this.onInsert({
          kind: 'image',
          asset,
          width: size[0],
          height: size[1],
          label: '导演台 · ' + label,
          shot: mode,
        });
      }
      this.toast('已出「' + label + '」，结果卡片已连到导演台');
    } catch (error) {
      this.toast('出图失败：' + (error && error.message ? error.message : error));
    } finally {
      this.setBusy(false);
    }
  }

  async shootKeyframes() {
    if (this.busy) return;
    // 先把机位复制一份：出图期间拖时间轴 / 改关键帧，不会影响这一组的结果
    const frames = this.scene.keyframes.map((k) => ({
      t: k.t,
      pos: k.pos.slice(),
      target: k.target.slice(),
      fov: k.fov,
    }));
    if (!frames.length) {
      this.toast('先记下几个机位，才能按机位拍一组');
      return;
    }
    if (!this.objects.size) {
      this.toast('场景还是空的，先从左边放点素材进来');
      return;
    }
    this.setBusy(true, '正在按机位拍 0/' + frames.length + '…');
    const prevTime = this.time;
    const prevView = this.viewMode;
    try {
      if (this.playing) this.stopPlay();
      if (this.viewMode !== 'camera') this.setViewMode('camera');
      const size = this.outputSize();
      for (let i = 0; i < frames.length; i += 1) {
        if (!this.mask) break;
        this.busyLabel.textContent = '正在按机位拍 ' + (i + 1) + '/' + frames.length + '…';
        this.applyCameraPose(frames[i]);
        const blob = await this.renderBlob('color');
        if (!blob) continue;
        const name = '导演台_机位' + (i + 1) + '_' + stamp() + '.png';
        const asset = await this.upload(blob, name, 'image');
        if (this.onInsert) {
          this.onInsert({
            kind: 'image',
            asset,
            width: size[0],
            height: size[1],
            label: '导演台 · 机位 ' + (i + 1),
            shot: 'color',
            index: i,
          });
        }
      }
      this.toast('按机位拍完了，' + frames.length + ' 张图都已连到导演台');
    } catch (error) {
      this.toast('按机位出图失败：' + (error && error.message ? error.message : error));
    } finally {
      this.applyCameraPose(this.sampleCamera(prevTime));
      this.setTime(prevTime);
      if (prevView !== 'camera') this.setViewMode(prevView);
      this.setBusy(false);
    }
  }

  pickVideoMime() {
    const list = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    if (typeof MediaRecorder === 'undefined') return '';
    return list.find((type) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) || '';
  }

  // 拍成视频：按关键帧运镜，实时录下画布
  async recordVideo() {
    if (this.busy) return;
    if (!this.objects.size) {
      this.toast('场景还是空的，先从左边放点素材进来');
      return;
    }
    const mime = this.pickVideoMime();
    if (!mime) {
      this.toast('这台电脑的浏览器不支持录屏，先试试「拍一张」或「按机位拍一组」');
      return;
    }
    this.setBusy(true, '正在录运镜…');
    const size = this.outputSize();
    const prevView = this.viewMode;
    const prevTime = this.time;
    let restoreHelpers = null;
    const stageW = this.stage.clientWidth;
    const stageH = this.stage.clientHeight;
    try {
      if (this.playing) this.stopPlay();
      if (this.viewMode !== 'camera') this.setViewMode('camera');
      // 录的时候按输出比例放大舞台，保证成片清晰
      this.camera.aspect = size[0] / size[1];
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(size[0], size[1], false);
      this.stage.classList.add('recording');
      restoreHelpers = this.hideCaptureHelpers();
      this.applyCameraPose(this.sampleCamera(0));
      this.needsRender = true;
      this.renderer.render(this.scene3, this.camera);

      const stream = this.renderer.domElement.captureStream(30);
      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
      const finished = new Promise((resolve) => {
        recorder.addEventListener('stop', resolve);
        recorder.addEventListener('error', resolve);
      });
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      });
      recorder.start(200);

      const duration = this.scene.duration || 8;
      const start = performance.now();
      await new Promise((resolve) => {
        const step = () => {
          if (!this.mask) {
            resolve();
            return;
          }
          const elapsed = (performance.now() - start) / 1000;
          const t = Math.min(duration, elapsed);
          this.applyCameraPose(this.sampleCamera(t));
          this.paintTimelineCursorAt(t);
          this.renderer.render(this.scene3, this.camera);
          if (t >= duration) {
            resolve();
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      recorder.stop();
      await finished;
      stream.getTracks().forEach((track) => track.stop());
      this.stage.classList.remove('recording');
      const blob = new Blob(chunks, { type: 'video/webm' });
      if (!blob.size) throw new Error('没有录到画面');
      const name = '导演台_运镜_' + stamp() + '.webm';
      const asset = await this.upload(blob, name, 'video');
      if (this.onInsert) {
        this.onInsert({
          kind: 'video',
          asset,
          width: size[0],
          height: size[1],
          label: '导演台 · 运镜',
          shot: 'video',
        });
      }
      this.toast('运镜录好了，视频卡片已连到导演台');
    } catch (error) {
      this.toast('录制失败：' + (error && error.message ? error.message : error));
    } finally {
      if (restoreHelpers) {
        restoreHelpers();
        restoreHelpers = null;
      }
      this.stage.classList.remove('recording');
      this.camera.aspect = this.aspectValue();
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(Math.max(320, stageW), Math.max(240, stageH), false);
      this.applyCameraPose(this.sampleCamera(prevTime));
      this.setTime(prevTime);
      if (prevView !== 'camera') this.setViewMode(prevView);
      this.needsRender = true;
      this.setBusy(false);
    }
  }

  // ---------- 场景 JSON：导出备份 / 导入模板 ----------
  exportScene() {
    const payload = {
      app: 'canvas-director',
      version: 1,
      savedAt: new Date().toISOString(),
      scene: this.scene,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a');
    a.href = url;
    a.download = '导演台场景_' + stamp() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.toast('场景已导出为 JSON');
  }

  importScene() {
    const input = h('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const raw = JSON.parse(String(reader.result || '{}'));
          const next = normalizeScene(raw.scene || raw);
          this.loadScene(next);
          this.toast('场景已导入');
        } catch (err) {
          this.toast('这个文件不是有效的导演台场景');
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  // 整场替换：清掉旧对象，按新场景重建
  loadScene(next, keepHistory) {
    if (!keepHistory) {
      this.history = [];
      this.future = [];
    }
    this.objects.forEach((entry) => this.disposeObject(entry));
    this.objects.clear();
    this.selectedId = '';
    this.clearSelectionBox();
    this.scene = normalizeScene(next);
    if (this.transform) this.transform.detach();
    this.scene.objects.forEach((item) => this.spawn(item, true));
    if (this.aspectSel) this.aspectSel.value = this.scene.aspect;
    if (this.durInput) this.durInput.value = String(this.scene.duration);
    if (this.easeSel) this.easeSel.value = this.scene.easing || 'easeInOut';
    if (this.scaleSel) this.scaleSel.value = String(this.scene.scale || 1);
    this.applyAspect();
    this.renderInspector();
    this.renderTimeline();
    this.setTime(0);
    this.pushChange();
    this.needsRender = true;
  }

  // ---------- 导演台内撤销 / 重做 ----------
  snapshotScene() {
    return JSON.stringify(this.scene);
  }

  recordHistory() {
    if (!this.history) this.history = [];
    if (!this.future) this.future = [];
    const snap = this.snapshotScene();
    if (this.history[this.history.length - 1] === snap) return;
    this.history.push(snap);
    if (this.history.length > 40) this.history.shift();
    this.future.length = 0;
  }

  undo() {
    if (!this.history || !this.history.length) {
      this.toast('没有可撤销的操作');
      return;
    }
    this.future = this.future || [];
    this.future.push(this.snapshotScene());
    const prev = this.history.pop();
    this.restoreSceneJson(prev);
    this.toast('已撤销');
  }

  redo() {
    if (!this.future || !this.future.length) {
      this.toast('没有可重做的操作');
      return;
    }
    this.history = this.history || [];
    this.history.push(this.snapshotScene());
    const next = this.future.pop();
    this.restoreSceneJson(next);
    this.toast('已重做');
  }

  restoreSceneJson(json) {
    const prevAspect = this.scene.aspect;
    this.loadScene(JSON.parse(json), true);
    if (prevAspect !== this.scene.aspect) this.applyAspect();
  }

  paintTimelineCursorAt(t) {
    this.time = t;
    this.paintTimelineCursor();
  }
}

// 全局入口：canvas.js 通过它打开 / 关闭导演台
let current = null;
window.CanvasDirector = {
  open(opts) {
    if (current) current.close();
    current = new Director(opts || {});
    current.open();
    return current;
  },
  close() {
    if (current) current.close();
    current = null;
  },
  isOpen() {
    return Boolean(current && current.mask);
  },
  current() {
    return current;
  },
};
