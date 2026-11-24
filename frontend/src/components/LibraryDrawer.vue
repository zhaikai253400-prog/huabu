<template>
  <Drawer
    :model-value="modelValue"
    width="420"
    class-name="lib-drawer"
    :closable="false"
    :styles="drawerStyles"
    @update:model-value="onVisible"
  >
    <div class="lib">
      <header class="lib-head">
        <div class="title">
          <b>素材库</b>
          <span class="count">{{ formatCount(stats.count || total) }}</span>
        </div>
        <div class="head-acts">
          <button class="icon-btn" title="上传" @click="fileInput?.click()"><Icon type="ios-cloud-upload-outline" /></button>
          <button class="icon-btn" title="关闭" @click="close"><Icon type="md-close" /></button>
        </div>
      </header>

      <div class="search">
        <Icon type="ios-search" class="s-ico" />
        <input v-model="q" placeholder="搜索名称、标签或提示词" @keydown.esc="q = ''" @input="onSearch" />
        <kbd>ESC</kbd>
      </div>

      <div class="tabs">
        <button :class="{ on: kind === '' }" @click="setKind('')">全部</button>
        <button :class="{ on: kind === 'image' }" @click="setKind('image')"><i class="dot green" />图片</button>
        <button :class="{ on: kind === 'video' }" @click="setKind('video')"><i class="dot orange" />视频</button>
        <button :class="{ on: kind === 'audio' }" @click="setKind('audio')"><i class="dot purple" />音频</button>
      </div>

      <div class="toolbar">
        <Select
          v-model="sort"
          size="small"
          transfer
          transfer-class-name="dark-select-drop"
          style="width:118px"
          @on-change="load"
        >
          <Option value="time">最新上传</Option>
          <Option value="name">按名称</Option>
          <Option value="size">按体积</Option>
        </Select>
        <div class="view-toggle">
          <button :class="{ on: view === 'grid' }" title="网格" @click="view = 'grid'"><Icon type="md-grid" /></button>
          <button :class="{ on: view === 'list' }" title="列表" @click="view = 'list'"><Icon type="md-list" /></button>
        </div>
        <a class="orphan-link" @click="cleanOrphans">清孤儿 {{ orphanCount || '' }}</a>
      </div>

      <div
        class="dropzone"
        :class="{ over: dropOver }"
        @dragover.prevent="dropOver = true"
        @dragleave="dropOver = false"
        @drop.prevent="onDropFiles"
      >
        <div class="dz-main">拖入文件或粘贴图片链接</div>
        <div class="dz-sub">支持 png / jpg / mp4 / mov / mp3 / wav · 单文件 ≤ 200MB</div>
        <input
          ref="linkInput"
          v-model="pasteUrl"
          class="link-input"
          placeholder="粘贴 https://… 后回车"
          @keydown.enter.prevent="pasteLink"
        />
      </div>

      <div class="sec-head">
        <b>最近上传 · {{ shown }}</b>
        <span class="hint">拖到画布即建卡</span>
      </div>

      <div class="body" :class="view" @scroll="onScroll">
        <div
          v-for="item in visibleItems"
          :key="item.relPath"
          class="card"
          :class="{ picked: selected.has(item.relPath), dragging: drag.item?.relPath === item.relPath && drag.active }"
          @pointerdown="beginCardDrag($event, item)"
        >
          <div class="thumb">
            <img v-if="isImageLike(item)" :src="thumbOf(item)" alt="" loading="lazy" draggable="false" />
            <video v-else-if="item.kind === 'video'" :src="item.url" muted preload="metadata" draggable="false" />
            <div v-else class="wave">
              <span v-for="n in 16" :key="n" :style="{ height: waveH(n) }" />
            </div>
            <span v-if="item.kind === 'video'" class="play">▶</span>
            <label class="check" @click.stop>
              <input type="checkbox" :checked="selected.has(item.relPath)" @change="togglePick(item)" />
            </label>
          </div>
          <div class="meta">
            <div class="name" :title="item.name">{{ item.name }}</div>
            <div class="sub">
              <i class="dot" :class="dotClass(item.kind)" />
              {{ metaLine(item) }}
            </div>
            <div class="acts" @click.stop>
              <button class="primary" @click="createCard(item)">建卡</button>
              <button v-if="item.kind === 'video'" class="ghost" title="提取尾帧" @click="extractTail(item)">帧</button>
              <button class="ghost" title="打开" @click="openItem(item)"><Icon type="ios-open-outline" /></button>
              <button class="ghost danger" title="删除" @click="removeOne(item)"><Icon type="ios-trash-outline" /></button>
            </div>
          </div>
        </div>
        <div v-if="!visibleItems.length && !loading" class="empty">
          {{ stats.count ? '这个筛选下没有素材' : '素材目录还是空的，生成结果会自动出现在这里' }}
        </div>
      </div>

      <footer class="lib-foot">
        <div class="foot-top">
          <span>已加载 {{ visibleItems.length }} / {{ formatCount(stats.count || total) }} · 占 {{ formatBytes(stats.bytes) }}</span>
          <span class="links">
            <a @click="cleanOrphans">清理孤儿</a>
            <a @click="batchMode = !batchMode">{{ batchMode ? '完成' : '批量管理' }}</a>
          </span>
        </div>
        <div v-if="batchMode && selected.size" class="batch-bar">
          <span>已选 {{ selected.size }}</span>
          <button @click="removeSelected">删除选中</button>
        </div>
        <button v-if="hasMore" class="more" :disabled="loading" @click="loadMore">
          {{ loading ? '加载中…' : '滚动加载更多' }}
        </button>
      </footer>
    </div>
    <input ref="fileInput" type="file" multiple hidden accept="image/*,video/*,audio/*" @change="onFilePick" />
  </Drawer>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { Message, Modal } from 'view-ui-plus';
import { api } from '@/api/client';
import { useCanvasStore } from '@/stores/canvas';
import { useRoute } from 'vue-router';

const props = defineProps({ modelValue: Boolean });
const emit = defineEmits(['update:modelValue', 'create-card', 'drop-on-canvas']);

const route = useRoute();
const canvas = useCanvasStore();
const drag = reactive({
  item: null,
  pointerId: null,
  startX: 0,
  startY: 0,
  active: false,
  overCanvas: false,
  suppressClick: false,
});
let ghostEl = null;
let dragBound = false;

const items = ref([]);
const stats = reactive({ count: 0, bytes: 0 });
const total = ref(0);
const shown = ref(0);
const q = ref('');
const kind = ref('');
const sort = ref('time');
const view = ref('grid');
const selected = ref(new Set());
const orphanCount = ref(0);
const batchMode = ref(false);
const dropOver = ref(false);
const pasteUrl = ref('');
const loading = ref(false);
const pageSize = ref(24);
const fileInput = ref(null);
const linkInput = ref(null);
let searchTimer = 0;

const drawerStyles = {
  background: '#12161d',
  color: '#e8ecf3',
  padding: '0',
};

const visibleItems = computed(() => items.value.slice(0, pageSize.value));
const hasMore = computed(() => visibleItems.value.length < items.value.length);

function formatCount(n) {
  return Number(n || 0).toLocaleString('en-US');
}
function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 ** 2) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 ** 3) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}
function isImageLike(item) {
  return item.kind === 'image' || item.kind === 'frame' || item.kind === 'tail';
}
function thumbOf(item) {
  return item.thumbUrl || item.url || '';
}
function dotClass(k) {
  if (k === 'image' || k === 'frame' || k === 'tail') return 'green';
  if (k === 'video') return 'orange';
  if (k === 'audio') return 'purple';
  return '';
}
function metaLine(item) {
  const type =
    item.kind === 'video' ? '视频' : item.kind === 'audio' ? '音频' : item.kind === 'frame' || item.kind === 'tail' ? '尾帧' : '图片';
  const extra = item.width && item.height ? `${item.width}×${item.height}` : item.duration ? `${item.duration}s` : item.folder || '';
  return [type, extra, formatBytes(item.size)].filter(Boolean).join(' · ');
}
function waveH(n) {
  const h = 8 + ((n * 17) % 22);
  return `${h}px`;
}
function close() {
  emit('update:modelValue', false);
}
function onVisible(v) {
  emit('update:modelValue', v);
}
function setKind(k) {
  kind.value = k;
  pageSize.value = 24;
  load();
}
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    pageSize.value = 24;
    load();
  }, 220);
}
function togglePick(item) {
  const next = new Set(selected.value);
  if (next.has(item.relPath)) next.delete(item.relPath);
  else next.add(item.relPath);
  selected.value = next;
  if (selected.value.size) batchMode.value = true;
}
function canvasUnder(clientX, clientY) {
  const viewport = document.querySelector('.workbench .viewport');
  if (!viewport) return null;
  const rect = viewport.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
  // 拖动时遮罩已穿透，直接认落在视口矩形内
  return viewport;
}
function makeGhost(item) {
  const ghost = document.createElement('div');
  ghost.className = 'lib-drag-ghost';
  const thumb = document.createElement('div');
  thumb.className = 'lib-drag-ghost-thumb';
  if (isImageLike(item)) {
    const img = document.createElement('img');
    img.src = thumbOf(item);
    img.draggable = false;
    thumb.appendChild(img);
  } else if (item.kind === 'video') {
    const tip = document.createElement('span');
    tip.textContent = '▶ 视频';
    tip.style.cssText = 'color:#e07a2f;font-size:12px';
    thumb.appendChild(tip);
  } else {
    const tip = document.createElement('span');
    tip.textContent = '♪ 音频';
    tip.style.cssText = 'color:#7a5af8;font-size:12px';
    thumb.appendChild(tip);
  }
  const name = document.createElement('div');
  name.className = 'lib-drag-ghost-name';
  name.textContent = item.name || '素材';
  ghost.appendChild(thumb);
  ghost.appendChild(name);
  document.body.appendChild(ghost);
  return ghost;
}
function moveGhost(clientX, clientY) {
  if (!ghostEl) return;
  ghostEl.style.left = `${clientX}px`;
  ghostEl.style.top = `${clientY}px`;
  const viewport = canvasUnder(clientX, clientY);
  drag.overCanvas = Boolean(viewport);
  ghostEl.classList.toggle('over', drag.overCanvas);
  document.querySelectorAll('.viewport.asset-drop').forEach((el) => {
    if (el !== viewport) el.classList.remove('asset-drop');
  });
  if (viewport) viewport.classList.add('asset-drop');
}
function clearDragVisuals() {
  document.querySelectorAll('.viewport.asset-drop').forEach((el) => el.classList.remove('asset-drop'));
  if (ghostEl?.parentNode) ghostEl.parentNode.removeChild(ghostEl);
  ghostEl = null;
  document.body.classList.remove('lib-dragging');
  drag.item = null;
  drag.pointerId = null;
  drag.active = false;
  drag.overCanvas = false;
}
function bindDragOnce() {
  if (dragBound) return;
  dragBound = true;
  document.addEventListener(
    'pointermove',
    (event) => {
      if (!drag.item || drag.pointerId !== event.pointerId) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
        drag.active = true;
        ghostEl = makeGhost(drag.item);
        document.body.classList.add('lib-dragging');
      }
      event.preventDefault();
      moveGhost(event.clientX, event.clientY);
    },
    { passive: false }
  );
  const finish = (event, cancelled) => {
    if (!drag.item || drag.pointerId !== event.pointerId) return;
    const wasActive = drag.active;
    const item = drag.item;
    const target = wasActive && !cancelled ? canvasUnder(event.clientX, event.clientY) : null;
    clearDragVisuals();
    if (!wasActive) return;
    drag.suppressClick = true;
    setTimeout(() => {
      drag.suppressClick = false;
    }, 120);
    if (target && item) {
      placeOnCanvas(item, event.clientX, event.clientY);
      emit('drop-on-canvas', { item, clientX: event.clientX, clientY: event.clientY });
    }
  };
  document.addEventListener('pointerup', (event) => finish(event, false));
  document.addEventListener('pointercancel', (event) => finish(event, true));
  window.addEventListener('blur', () => {
    if (drag.item) clearDragVisuals();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drag.item) {
      drag.suppressClick = true;
      clearDragVisuals();
    }
  });
}
function beginCardDrag(event, item) {
  if (event.button !== 0) return;
  if (event.target?.closest?.('input, button, a, label, .acts')) return;
  if (route.name !== 'canvas' || !canvas.id) {
    Message.info('请先打开画布，再拖素材建卡');
    return;
  }
  bindDragOnce();
  drag.item = item;
  drag.pointerId = event.pointerId;
  drag.startX = event.clientX;
  drag.startY = event.clientY;
  drag.active = false;
  drag.overCanvas = false;
}
function placeOnCanvas(item, clientX, clientY) {
  if (route.name !== 'canvas' || !canvas.id) return;
  const viewport = document.querySelector('.workbench .viewport');
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  const scale = canvas.viewport.scale || 1;
  const x = (clientX - rect.left - canvas.viewport.x) / scale;
  const y = (clientY - rect.top - canvas.viewport.y) / scale;
  const kind = cardKind(item);
  const node = canvas.addNode(kind, { x: x - 100, y: y - 70 });
  canvas.updateNodeData(node.id, {
    url: item.url,
    thumb: item.thumbUrl || item.url,
    title: item.name,
    relPath: item.relPath,
  });
  Message.success('已拖到画布建卡');
}
function cardKind(item) {
  if (item.kind === 'video') return 'video';
  if (item.kind === 'audio') return 'audio';
  return 'image';
}
function createCard(item) {
  if (drag.suppressClick) return;
  emit('create-card', item);
  if (route.name === 'canvas' && canvas.id) {
    const node = canvas.addNode(cardKind(item), {
      x: 160 + canvas.nodes.length * 12,
      y: 140 + canvas.nodes.length * 10,
    });
    canvas.updateNodeData(node.id, {
      url: item.url,
      thumb: item.thumbUrl || item.url,
      title: item.name,
      relPath: item.relPath,
    });
    Message.success(`已建${cardKind(item) === 'image' ? '图片' : cardKind(item) === 'video' ? '视频' : '音频'}卡`);
    return;
  }
  Message.info('请先打开画布，再点建卡；也可直接拖到画布上');
}
async function extractTail(item) {
  if (route.name !== 'canvas' || !canvas.id) {
    Message.info('请先打开画布再提取尾帧');
    return;
  }
  try {
    const res = await api.tailFrame({ canvasId: canvas.id, url: item.url });
    const node = canvas.addNode('image');
    canvas.updateNodeData(node.id, { url: res.url || res.path, title: `${item.name} · 尾帧` });
    Message.success('已提取尾帧为图片卡');
  } catch (e) {
    Message.error(e.message);
  }
}
function openItem(item) {
  if (item.url) window.open(item.url, '_blank');
}
async function removeOne(item) {
  Modal.confirm({
    title: '删除素材',
    content: `将「${item.name}」移入回收站？`,
    onOk: async () => {
      await api.libraryDelete([item.relPath]);
      Message.success('已移入回收站');
      await load();
    },
  });
}
async function removeSelected() {
  const list = [...selected.value];
  if (!list.length) return;
  await api.libraryDelete(list);
  selected.value = new Set();
  Message.success('已移入回收站');
  await load();
}
async function cleanOrphans() {
  const report = await api.libraryOrphans();
  const count = report.orphans?.length || report.count || 0;
  orphanCount.value = count;
  if (!count) {
    Message.info('没有孤儿素材');
    return;
  }
  Modal.confirm({
    title: '清理孤儿',
    content: `发现 ${count} 个未被画布引用的素材，确认清理？`,
    onOk: async () => {
      const result = await api.libraryCleanOrphans();
      Message.success(`已清理 ${result.count ?? result.removed ?? count} 个`);
      orphanCount.value = 0;
      await load();
    },
  });
}
async function load() {
  loading.value = true;
  try {
    const data = await api.library({
      kind: kind.value || undefined,
      q: q.value || undefined,
      sort: sort.value,
    });
    items.value = data.items || data.files || [];
    if (!Array.isArray(items.value)) items.value = [];
    Object.assign(stats, data.stats || { count: items.value.length, bytes: 0 });
    total.value = data.total ?? stats.count;
    shown.value = Math.min(pageSize.value, items.value.length);
  } catch (e) {
    Message.error(e.message);
  } finally {
    loading.value = false;
  }
}
function loadMore() {
  pageSize.value += 24;
  shown.value = Math.min(pageSize.value, items.value.length);
}
function onScroll(e) {
  const el = e.target;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) loadMore();
}
async function uploadFiles(files) {
  for (const file of files) {
    if (file.size > 200 * 1024 * 1024) {
      Message.warning(`${file.name} 超过 200MB，已跳过`);
      continue;
    }
    const kindGuess = file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'image';
    await api.importAsset(file, kindGuess, canvas.id || undefined, 'copy');
  }
  Message.success(`已导入 ${files.length} 个文件`);
  await load();
}
async function onFilePick(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (files.length) await uploadFiles(files);
}
async function onDropFiles(e) {
  dropOver.value = false;
  const files = [...(e.dataTransfer.files || [])];
  if (files.length) await uploadFiles(files);
}
async function pasteLink() {
  const url = pasteUrl.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    Message.warning('请粘贴以 http(s) 开头的链接');
    return;
  }
  if (route.name === 'canvas' && canvas.id) {
    const node = canvas.addNode('image');
    canvas.updateNodeData(node.id, { url, title: url.split('/').pop() || '粘贴图片' });
    Message.success('已用链接建图片卡');
    pasteUrl.value = '';
    return;
  }
  Message.info('请先打开画布，再用链接建卡');
}
function onPaste(e) {
  if (!props.modelValue) return;
  const text = e.clipboardData?.getData('text') || '';
  if (/^https?:\/\//i.test(text.trim())) {
    pasteUrl.value = text.trim();
    nextTick(() => linkInput.value?.focus());
  }
  const items = [...(e.clipboardData?.items || [])];
  const file = items.find((i) => i.kind === 'file')?.getAsFile();
  if (file) uploadFiles([file]);
}

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    pageSize.value = 24;
    await load();
    api.libraryOrphans()
      .then((r) => {
        orphanCount.value = r.orphans?.length || 0;
      })
      .catch(() => {});
  }
);

onMounted(() => window.addEventListener('paste', onPaste));
onUnmounted(() => window.removeEventListener('paste', onPaste));
</script>

<style scoped lang="scss">
.lib {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #12161d;
  color: #e8ecf3;
  margin: -16px;
  padding: 16px 16px 12px;
}
.lib-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.title {
  display: flex;
  gap: 10px;
  align-items: baseline;
  b { font-size: 18px; }
}
.count { color: #8b95a3; font-size: 14px; }
.head-acts { display: flex; gap: 4px; }
.icon-btn {
  width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: #9aa8bd; cursor: pointer;
  &:hover { background: #1c2430; color: #fff; }
}
.search {
  display: flex; align-items: center; gap: 8px; background: #1a212b; border: 1px solid #2a3340;
  border-radius: 10px; padding: 0 12px; height: 40px; margin-bottom: 12px;
  input {
    flex: 1; border: 0; outline: 0; background: transparent; color: #e8ecf3; font-size: 13px;
    &::placeholder { color: #6b7684; }
  }
  kbd { font-size: 11px; color: #6b7684; background: #12161d; border-radius: 4px; padding: 2px 6px; }
}
.s-ico { color: #6b7684; }
.tabs {
  display: flex; gap: 6px; margin-bottom: 10px;
  button {
    border: 0; background: #1a212b; color: #9aa8bd; border-radius: 999px; padding: 6px 12px; font-size: 12px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
    &.on { background: #243040; color: #7fb6f2; }
  }
}
.dot {
  width: 6px; height: 6px; border-radius: 50%; display: inline-block;
  &.green { background: #22a06b; }
  &.orange { background: #e07a2f; }
  &.purple { background: #7a5af8; }
}
.toolbar {
  display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
}
.view-toggle {
  display: flex; background: #1a212b; border-radius: 8px; padding: 2px;
  button {
    width: 30px; height: 28px; border: 0; background: transparent; color: #8b95a3; border-radius: 6px; cursor: pointer;
    &.on { background: #2a3544; color: #e8ecf3; }
  }
}
.orphan-link { margin-left: auto; color: #7fb6f2; font-size: 12px; }
.dropzone {
  border: 1px dashed #3a4553; border-radius: 12px; padding: 14px; text-align: center; margin-bottom: 14px;
  background: #151a22;
  &.over { border-color: #2d8cf0; background: #182230; }
}
.dz-main { font-size: 13px; color: #c9d2de; }
.dz-sub { margin-top: 4px; font-size: 11px; color: #6b7684; }
.link-input {
  margin-top: 10px; width: 100%; height: 32px; border-radius: 8px; border: 1px solid #2a3340;
  background: #12161d; color: #e8ecf3; padding: 0 10px; font-size: 12px; outline: none;
}
.sec-head {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;
  b { font-size: 13px; }
  .hint { font-size: 11px; color: #6b7684; }
}
.body {
  flex: 1; overflow: auto; min-height: 0; padding-bottom: 8px;
  &.grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-content: start;
  }
  &.list {
    display: flex; flex-direction: column; gap: 8px;
    .card { display: flex; gap: 10px; }
    .thumb { width: 88px; height: 66px; flex-shrink: 0; }
    .meta { flex: 1; padding: 4px 0; }
  }
}
.card {
  background: #1a212b; border: 1px solid #2a3340; border-radius: 12px; overflow: hidden; cursor: grab;
  touch-action: none; user-select: none;
  &.picked { border-color: #2d8cf0; }
  &.dragging { opacity: .45; }
}
.thumb {
  position: relative; height: 110px; background: #0f141b; overflow: hidden;
  img, video { width: 100%; height: 100%; object-fit: cover; display: block; }
}
.wave {
  height: 100%; display: flex; align-items: flex-end; justify-content: center; gap: 3px; padding: 18px 12px;
  span { width: 3px; background: linear-gradient(180deg, #7a5af8, #334155); border-radius: 2px; display: block; }
}
.play {
  position: absolute; right: 8px; bottom: 8px; width: 22px; height: 22px; border-radius: 50%;
  background: rgba(0,0,0,.55); color: #fff; font-size: 10px; display: grid; place-items: center;
}
.check {
  position: absolute; left: 8px; top: 8px;
  input { accent-color: #2d8cf0; }
}
.meta { padding: 10px; }
.name {
  font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px;
}
.sub { font-size: 11px; color: #8b95a3; display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.acts { display: flex; gap: 6px; align-items: center; }
.acts button {
  border: 0; border-radius: 6px; height: 28px; padding: 0 10px; cursor: pointer; font-size: 12px;
  &.primary { background: #2d8cf0; color: #fff; }
  &.ghost { background: #243040; color: #c9d2de; width: 28px; padding: 0; display: grid; place-items: center; }
  &.danger { color: #f87171; }
}
.empty { grid-column: 1 / -1; text-align: center; color: #6b7684; padding: 40px 12px; font-size: 13px; }
.lib-foot {
  border-top: 1px solid #243040; padding-top: 10px; margin-top: 8px;
}
.foot-top {
  display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: #8b95a3; margin-bottom: 8px;
  .links { display: flex; gap: 12px; a { color: #7fb6f2; } }
}
.batch-bar {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 12px;
  button { border: 0; background: #7f1d1d; color: #fecaca; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
}
.more {
  width: 100%; height: 36px; border: 0; border-radius: 10px; background: #1a212b; color: #9aa8bd; cursor: pointer;
  &:hover { color: #e8ecf3; }
}
</style>

<style lang="scss">
.lib-drawer {
  .ivu-drawer-content { background: #12161d !important; }
  .ivu-drawer-body { padding: 16px !important; background: #12161d; }
  .ivu-select-selection {
    background: #1a212b !important;
    border-color: #2a3340 !important;
    color: #e8ecf3 !important;
  }
  .ivu-select-selected-value, .ivu-select-arrow { color: #c9d2de !important; }
}
/* 拖素材时：遮罩与抽屉不抢指针，才能落到画布上 */
body.lib-dragging {
  cursor: grabbing !important;
  user-select: none !important;
  .ivu-drawer-mask,
  .ivu-drawer-wrap {
    pointer-events: none !important;
  }
  .ivu-drawer-content {
    pointer-events: none !important;
    opacity: .55;
  }
}
.lib-drag-ghost {
  position: fixed; z-index: 10000; width: 140px; pointer-events: none;
  transform: translate(-40%, -60%);
  background: #1a212b; border: 1px solid #2d8cf0; border-radius: 12px;
  box-shadow: 0 12px 28px rgba(0,0,0,.45); overflow: hidden; opacity: .92;
  &.over { border-color: #34d399; box-shadow: 0 0 0 2px rgba(52,211,153,.35), 0 12px 28px rgba(0,0,0,.45); }
}
.lib-drag-ghost-thumb {
  height: 84px; background: #0f141b; display: grid; place-items: center;
  img { width: 100%; height: 100%; object-fit: cover; display: block; }
}
.lib-drag-ghost-name {
  padding: 6px 8px; font-size: 11px; color: #e8ecf3;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.viewport.asset-drop {
  outline: 2px dashed #34d399; outline-offset: -4px;
}
</style>
