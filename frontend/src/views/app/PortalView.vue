<template>
  <div class="portal">
    <div v-if="diskNotice || healthNotice" class="alert-bar">
      <div class="alert-left">
        <Icon type="ios-warning" color="#e07a2f" />
        <span>{{ diskNotice || healthNotice }}</span>
        <a @click="$router.push('/admin/storage')">查看存储</a>
        <a @click="$router.push('/admin/recycle')">清理回收站</a>
      </div>
      <Icon type="md-close" class="close" @click="dismissAlert = true" />
    </div>

    <div class="content">
      <section class="proto">
        <div class="proto-head">
          <div>
            <h3>前台原型面板</h3>
            <p>对应设计稿：定时生成组 · 3D 导演台 · 交互件规范 · 分镜墙。点卡片即可打开。</p>
          </div>
          <span class="proto-tip">顶部导航也可直达</span>
        </div>
        <div class="proto-grid">
          <button class="proto-card" @click="$router.push('/schedule-demo')">
            <span class="pc-ico schedule">时</span>
            <div>
              <b>定时生成组面板</b>
              <span>夜间批量 · 队列 · 失败策略</span>
            </div>
          </button>
          <button class="proto-card" @click="$router.push('/director-demo')">
            <span class="pc-ico director">导</span>
            <div>
              <b>3D 导演台占位</b>
              <span>机位 / 灯光 / 场景预演</span>
            </div>
          </button>
          <button class="proto-card" @click="$router.push('/interactions')">
            <span class="pc-ico interact">交</span>
            <div>
              <b>交互件规范</b>
              <span>右键菜单 · @ 弹层 · 多选对齐</span>
            </div>
          </button>
          <button class="proto-card" @click="$router.push('/storyboard-demo')">
            <span class="pc-ico story">镜</span>
            <div>
              <b>分镜墙示意</b>
              <span>夜行地铁 · 三幕九镜头</span>
            </div>
          </button>
        </div>
      </section>

      <div class="head">
        <div>
          <div class="title-row">
            <h2>我的画布</h2>
            <span class="count">{{ canvases.length }}</span>
          </div>
          <p class="sub">最近编辑 {{ latestEdit }} · 存储占用 {{ storageLabel }} · 自动备份 每日 03:00</p>
        </div>
        <div class="head-actions">
          <button class="icon-btn" title="筛选"><Icon type="ios-funnel-outline" /></button>
          <Upload :before-upload="onImport" accept=".json,application/json" action="" :show-upload-list="false">
            <Button icon="ios-cloud-upload-outline">导入备份 JSON</Button>
          </Upload>
          <Button type="primary" icon="md-add" @click="showCreate = true">新建画布</Button>
        </div>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="ico blue"><Icon type="ios-apps" /></div>
          <div>
            <div class="label">画布总数</div>
            <div class="value">{{ stats.canvases ?? canvases.length }} <small>+{{ stats.weekNew ?? 0 }} 本周</small></div>
          </div>
        </div>
        <div class="stat">
          <div class="ico green"><Icon type="ios-images" /></div>
          <div>
            <div class="label">素材总量</div>
            <div class="value">{{ stats.assetCount ?? '—' }} <small>孤儿 {{ stats.orphans ?? 0 }}</small></div>
          </div>
        </div>
        <div class="stat">
          <div class="ico orange"><Icon type="ios-pulse" /></div>
          <div>
            <div class="label">今日任务</div>
            <div class="value">{{ stats.todayTasks ?? 0 }} <small>成功 {{ stats.todayOk ?? 0 }} · 失败 {{ stats.todayFail ?? 0 }}</small></div>
          </div>
        </div>
        <div class="stat">
          <div class="ico gray"><Icon type="ios-folder" /></div>
          <div class="storage">
            <div class="label">存储占用 {{ storageLabel }}</div>
            <div class="bar"><i :style="{ width: usagePct + '%' }" /></div>
          </div>
        </div>
      </div>

      <div class="filters">
        <div class="left">
          <Input v-model="q" search clearable placeholder="搜索画布名称、标签或备注" style="width:330px">
            <template #suffix><span class="kbd">⌘K</span></template>
          </Input>
          <div class="tabs">
            <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部 {{ canvases.length }}</button>
            <button :class="{ on: tab === 'recent' }" @click="tab = 'recent'">最近编辑</button>
            <button :class="{ on: tab === 'shared' }" @click="tab = 'shared'">已共享</button>
            <button :class="{ on: tab === 'archived' }" @click="tab = 'archived'">归档</button>
          </div>
        </div>
        <div class="right">
          <Select v-model="sort" style="width:122px" size="small">
            <Option value="recent">最近编辑</Option>
            <Option value="name">按名称</Option>
          </Select>
          <div class="view-toggle">
            <button :class="{ on: viewMode === 'grid' }" @click="viewMode = 'grid'"><Icon type="md-grid" /></button>
            <button :class="{ on: viewMode === 'list' }" @click="viewMode = 'list'"><Icon type="md-list" /></button>
          </div>
        </div>
      </div>

      <div class="grid" :class="viewMode">
        <div v-for="c in filtered" :key="c.id" class="card" @dblclick="open(c)">
          <div class="cover" :style="coverStyle(c)" @click="open(c)" />
          <div class="body">
            <div class="title-line">
              <div class="name" :title="c.name">{{ c.name }}</div>
              <span class="status" :class="statusClass(c)">{{ statusOf(c) || '草稿' }}</span>
            </div>
            <div class="meta">
              <span>{{ sizeText(c) }}</span>
              <span>·</span>
              <span>{{ c.nodeCount ?? '—' }} 卡片 · {{ c.zoneCount ?? 0 }} 区域</span>
              <span>·</span>
              <span>{{ formatTime(c.updatedAt) }}</span>
            </div>
            <div class="actions">
              <div class="ops">
                <button title="打开" @click="open(c)"><Icon type="ios-open-outline" /></button>
                <button title="改名" @click="rename(c)"><Icon type="ios-create-outline" /></button>
                <button title="导出" @click="exportOne(c)"><Icon type="ios-share-outline" /></button>
                <button title="历史" @click="showHistory(c)"><Icon type="ios-time-outline" /></button>
                <button title="共享" @click="toggleShare(c)"><Icon type="ios-people-outline" /></button>
                <button title="删除" class="danger" @click="remove(c)"><Icon type="ios-trash-outline" /></button>
              </div>
              <div class="side-meta">
                <template v-if="c.shared">
                  <span class="avatars"><i /><i /></span>
                  <span>只读</span>
                </template>
                <template v-else-if="c.backupCount">
                  <Icon type="ios-camera-outline" /> 快照 {{ c.backupCount }} 个
                </template>
                <template v-else-if="c.sizeText">
                  <Icon type="ios-folder-outline" /> {{ c.sizeText }}
                </template>
              </div>
            </div>
          </div>
        </div>

        <div class="card create" @click="showCreate = true">
          <div class="create-inner">
            <div class="plus">+</div>
            <div class="ct">新建画布</div>
            <div class="muted">从空白开始，或选择默认模板</div>
            <div class="tpl">
              <a @click.stop="createWithName('空白 1920×1080')">空白 1920×1080</a>
              <a @click.stop="$router.push('/storyboard-demo')">分镜三幕</a>
            </div>
            <div class="muted tiny">也可以拖入 JSON 备份恢复画布</div>
          </div>
        </div>
      </div>

      <div class="foot">
        <span><Icon type="ios-information-circle-outline" /> 快捷键 · 导出设置 · 使用文档</span>
        <span>
          <a @click="$router.push('/schedule-demo')">定时组</a>
          <a @click="$router.push('/director-demo')">导演台</a>
          <a @click="$router.push('/interactions')">交互件</a>
          <a @click="$router.push('/storyboard-demo')">分镜墙</a>
          <a @click="$router.push('/admin')">后台</a>
          <span class="muted">V1.0 · 本机版</span>
        </span>
      </div>
    </div>

    <Modal v-model="showCreate" :footer-hide="true" width="560">
      <div class="create-head">
        <div class="ico">画</div>
        <div>
          <b>新建画布</b>
          <div class="muted tiny">选择尺寸与模板，创建后可直接进入工作台</div>
        </div>
      </div>
      <div class="create-body">
        <div class="field-label"><span>画布名称 <em>*</em></span><span class="muted">可稍后在门户改名</span></div>
        <Input v-model="newName" placeholder="未命名画布" @on-enter="create" />
        <div class="field-label" style="margin-top:14px"><span>画布尺寸</span><span class="muted">仅桌面尺寸，画布无限延展</span></div>
        <div class="size-row">
          <button v-for="s in sizePresets" :key="s.id" type="button" :class="{ on: sizeId === s.id }" @click="sizeId = s.id">
            <i :style="s.preview" />
            <span>{{ s.label }}</span>
          </button>
        </div>
        <div class="field-label" style="margin-top:14px">初始模板</div>
        <div class="tpl-row">
          <button v-for="t in templates" :key="t.id" type="button" :class="{ on: templateId === t.id }" @click="templateId = t.id">
            <b>{{ t.label }}</b>
            <span>{{ t.desc }}</span>
          </button>
        </div>
        <div class="inherit">将使用后台默认模型：图片 / 视频默认配置 <a @click="$router.push('/admin/models')">调整默认</a></div>
        <div class="import-box">
          <div>
            <b>从 JSON 备份恢复画布</b>
            <div class="muted tiny">支持门户「导出」生成的 .json 文件</div>
          </div>
          <Upload :before-upload="onImport" accept=".json,application/json" action="" :show-upload-list="false">
            <Button size="small">选择文件</Button>
          </Upload>
        </div>
      </div>
      <div class="create-foot">
        <span class="muted tiny">保存在本机 data/canvases</span>
        <Space>
          <Button @click="showCreate = false">取消</Button>
          <Button type="primary" @click="create">创建并进入</Button>
        </Space>
      </div>
    </Modal>

    <Modal v-model="historyOpen" title="历史版本" footer-hide width="640">
      <Table :columns="historyCols" :data="historyRows">
        <template #action="{ row }"><a @click="restoreHistory(row)">回滚</a></template>
      </Table>
    </Modal>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Message, Modal } from 'view-ui-plus';
import { api } from '@/api/client';
import { useAppStore } from '@/stores/app';

const router = useRouter();
const app = useAppStore();
const canvases = ref([]);
const stats = ref({});
const q = ref('');
const tab = ref('all');
const sort = ref('recent');
const viewMode = ref('grid');
const showCreate = ref(false);
const dismissAlert = ref(false);
const newName = ref(`未命名画布 · ${new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`);
const sizeId = ref('1920x1080');
const templateId = ref('blank');
const sizePresets = [
  { id: '1920x1080', label: '1920 × 1080', preview: { width: '44px', height: '25px' } },
  { id: '1080x1920', label: '1080 × 1920', preview: { width: '16px', height: '29px' } },
  { id: '1080x1080', label: '1080 × 1080', preview: { width: '26px', height: '26px' } },
  { id: 'custom', label: '自定义', preview: { width: '20px', height: '20px' } },
];
const templates = [
  { id: 'blank', label: '空白画布', desc: '仅一张参考卡占位' },
  { id: 'story', label: '分镜三幕', desc: '3 区域 + 参考位' },
  { id: 'board', label: '参考板', desc: '6 张图片卡网格' },
];
const historyOpen = ref(false);
const historyRows = ref([]);
const historyCanvasId = ref('');
const historyCols = [
  { title: '文件', key: 'name' },
  { title: '时间', key: 'mtime', width: 180 },
  { title: '操作', slot: 'action', width: 100 },
];

const healthNotice = computed(() => {
  if (dismissAlert.value) return '';
  const n = app.health?.notice;
  return n ? `数据库异常，已重建空库。原因：${n.reason || '未知'}` : '';
});
const diskNotice = computed(() => {
  if (dismissAlert.value) return '';
  return stats.value.diskWarning || '';
});
const usagePct = computed(() => Math.min(100, Number(stats.value.usagePct) || 43));
const storageLabel = computed(() => stats.value.usageText || stats.value.storageText || '—');
const latestEdit = computed(() => {
  const first = [...canvases.value].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  return first ? formatTime(first.updatedAt) : '—';
});
const filtered = computed(() => {
  let list = [...canvases.value];
  const kw = q.value.trim().toLowerCase();
  if (kw) list = list.filter((c) => String(c.name || '').toLowerCase().includes(kw));
  if (tab.value === 'shared') list = list.filter((c) => c.shared);
  if (tab.value === 'archived') list = list.filter((c) => c.archived);
  if (sort.value === 'name') list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
  else list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  if (tab.value === 'recent') list = list.slice(0, 12);
  return list;
});

function formatTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    const diff = Date.now() - d.getTime();
    if (diff < 3600000) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
    if (diff < 172800000) return '昨天 ' + d.toTimeString().slice(0, 5);
  }
  return String(v).replace('T', ' ').slice(0, 16);
}
function sizeText(c) {
  return c.sizeLabel || (c.shared ? '1080 × 1920' : '1920 × 1080');
}
function statusOf(c) {
  if (c.archived) return '已归档';
  if (c.shared) return '已共享';
  if (c.running) return `生成中 ${c.running}`;
  if (c.exported) return '已导出';
  if (c.done) return '已完成';
  return c.status || '';
}
function statusClass(c) {
  if (c.archived) return 'archived';
  if (c.shared) return 'shared';
  if (c.running) return 'running';
  if (c.exported) return 'exported';
  if (c.done) return 'done';
  return 'draft';
}
function coverStyle(c) {
  if (c.coverUrl) return { backgroundImage: `url(${c.coverUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' };
  const hues = ['#1f3a5f', '#3d2c4d', '#1f4a3a', '#4a3520', '#2a3558'];
  const i = Math.abs(String(c.id || '').split('').reduce((s, ch) => s + ch.charCodeAt(0), 0)) % hues.length;
  return { background: `linear-gradient(145deg, ${hues[i]}, #0f172a 70%)` };
}
async function load() {
  const [list, st] = await Promise.all([api.listCanvases(), api.portalStats().catch(() => ({}))]);
  canvases.value = list.canvases || list.items || list || [];
  stats.value = st || {};
}
function open(c) { router.push(`/canvas/${c.id}`); }
async function create() {
  if (templateId.value === 'story') {
    showCreate.value = false;
    router.push('/storyboard-demo');
    return;
  }
  const name = newName.value.trim() || '未命名画布';
  const data = await api.createCanvas(name);
  const id = data.id || data.canvas?.id;
  if (templateId.value === 'board' && id) {
    const nodes = Array.from({ length: 6 }).map((_, i) => ({
      id: `n${i + 1}`,
      type: 'image',
      x: 80 + (i % 3) * 260,
      y: 120 + Math.floor(i / 3) * 200,
      w: 220,
      h: 140,
      z: i + 1,
      data: { title: `参考 ${i + 1}`, prompt: '' },
    }));
    await api.saveCanvas(id, { name, nodes, edges: [], viewport: { x: 0, y: 0, scale: 1 }, size: sizeId.value });
  }
  showCreate.value = false;
  router.push(`/canvas/${id}`);
}
async function createWithName(name) {
  const data = await api.createCanvas(name);
  router.push(`/canvas/${data.id || data.canvas?.id}`);
}
function rename(c) {
  const next = window.prompt('画布改名', c.name);
  if (!next || next === c.name) return;
  api.renameCanvas(c.id, next).then(load).catch((e) => Message.error(e.message));
}
async function exportOne(c) {
  const data = await api.exportCanvas(c.id);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${c.name || '画布'}.json`;
  a.click();
}
async function showHistory(c) {
  historyCanvasId.value = c.id;
  const data = await api.backups(c.id);
  historyRows.value = data.backups || data || [];
  historyOpen.value = true;
}
async function restoreHistory(row) {
  await api.restoreBackup(historyCanvasId.value, row.name);
  Message.success('已回滚');
  historyOpen.value = false;
}
async function toggleShare(c) {
  await api.shareToggle(c.id, !c.shared);
  await load();
}
function remove(c) {
  Modal.confirm({
    title: '删除画布',
    content: `删除「${c.name}」？可稍后从回收站/备份找回。`,
    onOk: async () => {
      await api.deleteCanvas(c.id);
      await load();
    },
  });
}
async function onImport(file) {
  const text = await file.text();
  await api.importCanvas(JSON.parse(text));
  Message.success('已导入');
  await load();
  showCreate.value = false;
  return false;
}
onMounted(() => load().catch((e) => Message.error(e.message)));
</script>

<style scoped lang="scss">
.portal { min-height: calc(100vh - 64px); }
.proto {
  margin-bottom: 22px; padding: 18px 20px; border-radius: 14px;
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 55%, #172554 100%);
  color: #e8ecf3; border: 1px solid #243044;
}
.proto-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.proto-head h3 { margin: 0; font-size: 16px; }
.proto-head p { margin: 6px 0 0; font-size: 12px; color: #9aa8bd; }
.proto-tip { font-size: 12px; color: #7fb6f2; white-space: nowrap; }
.proto-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.proto-card {
  display: flex; gap: 12px; align-items: center; text-align: left;
  padding: 14px; border-radius: 12px; border: 1px solid #334155; background: rgba(15, 23, 42, .55);
  color: #e8ecf3; cursor: pointer; transition: border-color .15s, transform .15s;
  &:hover { border-color: #2d8cf0; transform: translateY(-1px); }
  b { display: block; font-size: 14px; margin-bottom: 4px; }
  span { font-size: 12px; color: #94a3b8; }
}
.pc-ico {
  width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center;
  font-weight: 700; font-size: 14px; flex-shrink: 0;
  &.schedule { background: #312e81; color: #c4b5fd; }
  &.director { background: #0f766e; color: #99f6e4; }
  &.interact { background: #1d4ed8; color: #bfdbfe; }
  &.story { background: #9a3412; color: #fed7aa; }
}
@media (max-width: 1100px) { .proto-grid { grid-template-columns: 1fr 1fr; } }
.alert-bar {
  height: 44px; background: #fff7ed; border-bottom: 1px solid #ffedd5; color: #9a3412;
  display: flex; align-items: center; justify-content: space-between; padding: 0 32px; font-size: 13px;
}
.alert-left { display: flex; align-items: center; gap: 8px; }
.alert-left a { color: #c2410c; margin-left: 8px; }
.close { cursor: pointer; color: #9a3412; }
.content { padding: 28px 48px 40px; }
.head { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 20px; }
.title-row { display: flex; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: 22px; color: #101828; }
.count {
  min-width: 28px; height: 21px; border-radius: 11px; background: #eef5ff; color: #2d8cf0;
  display: inline-grid; place-items: center; font-size: 12px; padding: 0 8px; font-weight: 600;
}
.sub { margin: 8px 0 0; color: #8b95a3; font-size: 13px; }
.head-actions { display: flex; gap: 10px; align-items: center; }
.icon-btn {
  width: 36px; height: 36px; border: 1px solid #d7dee9; border-radius: 8px; background: #fff; color: #6b7684; cursor: pointer;
  display: grid; place-items: center;
}
.stats {
  display: grid; grid-template-columns: repeat(4, 1fr); background: #fff;
  border: 1px solid #eef1f6; border-radius: 12px; margin-bottom: 18px; overflow: hidden;
}
.stat {
  display: flex; gap: 14px; align-items: center; padding: 22px 24px;
  border-right: 1px solid #eef1f6;
  &:last-child { border-right: 0; }
}
.ico {
  width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; color: #fff; font-size: 18px;
  &.blue { background: #2d8cf0; } &.green { background: #19be6b; }
  &.orange { background: #e07a2f; } &.gray { background: #6b7684; }
}
.label { color: #6b7684; font-size: 12px; }
.value { font-size: 22px; font-weight: 700; margin-top: 2px; color: #101828; }
.value small { font-size: 12px; color: #8b95a3; font-weight: 400; margin-left: 6px; }
.storage { width: 100%; }
.bar { height: 6px; background: #eef1f6; border-radius: 3px; margin-top: 10px; overflow: hidden; max-width: 150px; }
.bar i { display: block; height: 100%; background: #2d8cf0; }
.filters { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 18px; }
.filters .left, .filters .right { display: flex; gap: 12px; align-items: center; }
.tabs {
  display: flex; background: #fff; border: 1px solid #eef1f6; border-radius: 8px; padding: 3px;
  button {
    border: 0; background: transparent; padding: 6px 12px; border-radius: 6px; color: #6b7684; cursor: pointer; font-size: 13px;
    &.on { background: #eef5ff; color: #2d8cf0; font-weight: 600; }
  }
}
.kbd { font-size: 11px; color: #8b95a3; background: #f5f7f9; border-radius: 4px; padding: 1px 5px; }
.view-toggle {
  display: flex; border: 1px solid #eef1f6; border-radius: 8px; overflow: hidden; background: #fff;
  button {
    width: 32px; height: 32px; border: 0; background: transparent; color: #8b95a3; cursor: pointer;
    &.on { background: #eef5ff; color: #2d8cf0; }
  }
}
.grid {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 24px;
  &.list { grid-template-columns: 1fr; }
}
.card {
  background: #fff; border: 1px solid #eef1f6; border-radius: 12px; overflow: hidden;
  transition: box-shadow .15s ease, border-color .15s ease;
  &:hover { border-color: #d6e6fb; box-shadow: 0 10px 28px rgba(16,24,40,.06); }
}
.cover { height: 228px; cursor: pointer; background-size: cover; background-position: center; }
.body { padding: 14px 16px 16px; }
.title-line { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.name { font-weight: 600; font-size: 15px; color: #101828; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status {
  flex-shrink: 0; font-size: 11px; border-radius: 999px; padding: 2px 8px;
  &.running { background: #fff7ed; color: #c2410c; }
  &.done { background: #ecfdf5; color: #047857; }
  &.exported { background: #eff6ff; color: #1d4ed8; }
  &.shared { background: #eef5ff; color: #2d8cf0; }
  &.archived { background: #f5f7f9; color: #6b7684; }
  &.draft { background: #f5f7f9; color: #8b95a3; }
}
.meta { color: #8b95a3; font-size: 12px; margin: 8px 0 12px; display: flex; gap: 6px; flex-wrap: wrap; }
.actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.ops { display: flex; gap: 4px; }
.ops button {
  width: 30px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: #6b7684; cursor: pointer;
  display: grid; place-items: center;
  &:hover { background: #f5f7f9; color: #2d8cf0; }
  &.danger:hover { background: #fef2f2; color: #ed4014; }
}
.side-meta { display: flex; align-items: center; gap: 6px; color: #8b95a3; font-size: 12px; }
.avatars { display: inline-flex; }
.avatars i {
  width: 24px; height: 24px; border-radius: 50%; background: #dbeafe; border: 2px solid #fff; display: inline-block;
  margin-left: -8px; &:first-child { margin-left: 0; background: #bfdbfe; }
}
.create {
  min-height: 349px; border-style: dashed; cursor: pointer; display: flex; align-items: center; justify-content: center;
  &:hover { border-color: #2d8cf0; background: #f8fbff; }
}
.create-inner { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 24px; }
.plus {
  width: 52px; height: 52px; border-radius: 14px; background: #eef5ff; color: #2d8cf0;
  display: grid; place-items: center; font-size: 28px; line-height: 1; margin-bottom: 8px;
}
.ct { font-weight: 600; color: #101828; }
.tpl { display: flex; gap: 10px; margin-top: 8px; }
.tpl a {
  color: #2d8cf0; font-size: 12px; border: 1px solid #d6e6fb; border-radius: 6px; padding: 4px 10px; background: #fff;
}
.tiny { font-size: 12px; margin-top: 8px; }
.foot {
  margin-top: 28px; display: flex; justify-content: space-between; font-size: 12px; color: #8b95a3; align-items: center;
  a { color: #2d8cf0; margin-right: 14px; }
}
.create-head { display:flex; gap:10px; align-items:center; margin-bottom:14px; }
.create-head .ico {
  width:28px; height:28px; border-radius:7px; background:#eef4ff; color:#2d8cf0; display:grid; place-items:center; font-size:12px; font-weight:700;
}
.field-label { display:flex; justify-content:space-between; margin-bottom:6px; font-size:12px; color:#3f4a58; }
.field-label em { color:#ed4014; font-style:normal; }
.size-row, .tpl-row { display:flex; gap:8px; }
.size-row button, .tpl-row button {
  flex:1; border:1px solid #d7dee9; background:#fff; border-radius:7px; padding:10px; cursor:pointer; text-align:center;
  display:flex; flex-direction:column; align-items:center; gap:6px; color:#5c6674; font-size:11px;
  &.on { border-color:#2d8cf0; background:#eef4ff; color:#2d8cf0; }
  i { display:block; border:1px solid #9dc4f2; background:#fff; border-radius:3px; }
}
.tpl-row button { align-items:flex-start; text-align:left; min-height:58px; }
.tpl-row b { font-size:12px; }
.tpl-row span { color:#8b95a3; font-size:10px; }
.inherit {
  margin-top:14px; background:#fafbfd; border:1px solid #eef1f6; border-radius:7px; padding:10px 12px; font-size:12px; color:#5c6674;
  display:flex; justify-content:space-between; a { color:#2d8cf0; }
}
.import-box {
  margin-top:12px; background:#f5f9ff; border:1px dashed #bcd9f7; border-radius:7px; padding:10px 12px;
  display:flex; justify-content:space-between; align-items:center;
}
.create-foot {
  display:flex; justify-content:space-between; align-items:center; margin-top:14px; padding-top:12px; border-top:1px solid #eef1f6;
}
.muted { color: #8b95a3; }
@media (max-width: 1500px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 1100px) {
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stats { grid-template-columns: 1fr 1fr; }
  .stat:nth-child(2) { border-right: 0; }
}
</style>
