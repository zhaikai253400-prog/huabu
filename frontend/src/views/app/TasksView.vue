<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>任务中心</h2>
        <p class="desc">所有画布与卡片的生成任务 · 支持跳转卡片继续编辑</p>
      </div>
      <Space>
        <Button icon="md-refresh" @click="load">刷新</Button>
        <Button icon="ios-download-outline" @click="exportCsv">导出 CSV</Button>
        <Button type="error" ghost :disabled="!runningCount" @click="cancelRunning">取消进行中 {{ runningCount || '' }}</Button>
      </Space>
    </div>

    <div class="metrics">
      <div class="metric">
        <div class="label">进行中</div>
        <div class="value">{{ runningCount }}</div>
        <div class="sub">队列 {{ queued }} · 渲染 {{ rendering }} · 最长 {{ longest }}</div>
      </div>
      <div class="metric">
        <div class="label">今日完成</div>
        <div class="value">{{ doneCount }}</div>
        <div class="sub">成功率 {{ successRate }} · 平均耗时 {{ avgElapsed }}</div>
      </div>
      <div class="metric">
        <div class="label">今日失败</div>
        <div class="value warn">{{ failedCount }}</div>
        <div class="sub">{{ failHint }}</div>
      </div>
      <div class="metric">
        <div class="label">今日消耗</div>
        <div class="value">{{ costText }}</div>
        <div class="sub">{{ costBreakdown }}</div>
      </div>
    </div>

    <div class="panel">
      <div class="filters">
        <div class="tabs">
          <button :class="{ on: filter === 'all' }" @click="filter = 'all'">全部 {{ list.length }}</button>
          <button :class="{ on: filter === 'running' }" @click="filter = 'running'">进行中 {{ runningCount }}</button>
          <button :class="{ on: filter === 'done' }" @click="filter = 'done'">完成 {{ doneCount }}</button>
          <button :class="{ on: filter === 'failed' }" @click="filter = 'failed'">失败 {{ failedCount }}</button>
        </div>
        <Input v-model="q" search clearable placeholder="任务 ID / 卡片名 / 模型" style="width:240px" />
        <Select v-model="kindFilter" style="width:110px" size="small">
          <Option value="all">全部类型</Option>
          <Option value="image">图片</Option>
          <Option value="video">视频</Option>
          <Option value="audio">音频</Option>
        </Select>
        <Select v-model="channelFilter" style="width:110px" size="small">
          <Option value="all">全部通道</Option>
        </Select>
        <Select v-model="canvasFilter" style="width:110px" size="small">
          <Option value="all">全部画布</Option>
        </Select>
        <Button size="small" @click="reset">重置</Button>
      </div>

      <Table :columns="columns" :data="rows" class="task-table">
        <template #task="{ row }">
          <div class="cell-main">
            <b>#{{ shortId(row.id) }}</b>
            <div class="muted tiny">{{ formatTime(row.createdAt || row.time) }}</div>
          </div>
        </template>
        <template #kind="{ row }">
          <span class="kind" :class="String(row.kind || '').toLowerCase()">{{ kindLabel(row.kind) }}</span>
        </template>
        <template #canvas="{ row }">
          <div class="cell-main">
            <div>{{ row.canvasName || row.canvasId || '—' }}</div>
            <div class="muted tiny">{{ row.cardName || row.prompt?.slice(0, 24) || '—' }}</div>
          </div>
        </template>
        <template #model="{ row }">
          <div class="cell-main">
            <div>{{ row.model || '—' }}</div>
            <div class="muted tiny">{{ row.channel || row.channelName || '—' }}</div>
          </div>
        </template>
        <template #status="{ row }">
          <Tag :color="statusColor(row)" size="medium">{{ statusLabel(row) }}</Tag>
        </template>
        <template #action="{ row }">
          <a v-if="row.canvasId" @click="$router.push(`/canvas/${row.canvasId}`)">跳转</a>
          <Divider v-if="active(row)" type="vertical" />
          <a v-if="active(row)" @click="cancel(row)">取消</a>
          <Divider v-if="isFailed(row)" type="vertical" />
          <a v-if="isFailed(row)" @click="retry(row)">重试</a>
        </template>
      </Table>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Message, Modal } from 'view-ui-plus';
import { api } from '@/api/client';

const filter = ref('all');
const q = ref('');
const kindFilter = ref('all');
const channelFilter = ref('all');
const canvasFilter = ref('all');
const list = ref([]);
let timer = 0;

const columns = [
  { title: '任务 / 时间', slot: 'task', width: 120 },
  { title: '类型', slot: 'kind', width: 80 },
  { title: '画布 / 卡片', slot: 'canvas', minWidth: 180 },
  { title: '模型 / 通道', slot: 'model', minWidth: 160 },
  { title: '状态', slot: 'status', width: 100 },
  { title: '耗时', key: 'elapsed', width: 90 },
  { title: '原因', key: 'reason', minWidth: 140, tooltip: true },
  { title: '操作', slot: 'action', width: 140 },
];

function active(row) {
  return ['running', 'queued', 'pending', 'waiting', 'rendering'].includes(String(row.status || '').toLowerCase());
}
function isFailed(row) {
  return String(row.status || '').toLowerCase() === 'failed';
}
function isDone(row) {
  return ['done', 'completed', 'success'].includes(String(row.status || '').toLowerCase());
}
function shortId(id) {
  return String(id || '').slice(-4).toUpperCase() || '—';
}
function formatTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t).slice(0, 19);
  return d.toTimeString().slice(0, 8);
}
function kindLabel(k) {
  const m = { image: '图片', video: '视频', audio: '音频', quick: '快速视频' };
  return m[String(k || '').toLowerCase()] || k || '—';
}
function statusLabel(row) {
  if (active(row)) return row.stage || '渲染中';
  if (isDone(row)) return '完成';
  if (isFailed(row)) return '失败';
  return row.status || '—';
}
function statusColor(row) {
  if (active(row)) return 'blue';
  if (isDone(row)) return 'success';
  if (isFailed(row)) return 'error';
  return 'default';
}

const runningCount = computed(() => list.value.filter(active).length);
const doneCount = computed(() => list.value.filter(isDone).length);
const failedCount = computed(() => list.value.filter(isFailed).length);
const queued = computed(() => list.value.filter((t) => ['queued', 'pending', 'waiting'].includes(String(t.status).toLowerCase())).length);
const rendering = computed(() => list.value.filter((t) => ['running', 'rendering'].includes(String(t.status).toLowerCase())).length);
const longest = computed(() => list.value.filter(active).map((t) => t.elapsed || t.duration || '—')[0] || '—');
const successRate = computed(() => {
  const total = doneCount.value + failedCount.value;
  if (!total) return '—';
  return `${Math.round((doneCount.value / total) * 1000) / 10}%`;
});
const avgElapsed = computed(() => '—');
const failHint = computed(() => (failedCount.value ? '含超时 / 余额 / 限流' : '今日暂无失败'));
const costText = computed(() => '—');
const costBreakdown = computed(() => '图像 / 视频 / 音频');

const rows = computed(() => {
  let arr = list.value;
  if (filter.value === 'running') arr = arr.filter(active);
  if (filter.value === 'done') arr = arr.filter(isDone);
  if (filter.value === 'failed') arr = arr.filter(isFailed);
  if (kindFilter.value !== 'all') arr = arr.filter((t) => String(t.kind || '').toLowerCase() === kindFilter.value);
  const kw = q.value.trim().toLowerCase();
  if (kw) arr = arr.filter((t) => [t.id, t.model, t.cardName, t.canvasName, t.prompt].join(' ').toLowerCase().includes(kw));
  return arr.map((t) => ({
    ...t,
    elapsed: t.elapsed || t.duration || '—',
    reason: t.reason || t.error || t.message || t.stage || '',
  }));
});

function reset() {
  filter.value = 'all';
  q.value = '';
  kindFilter.value = 'all';
  channelFilter.value = 'all';
  canvasFilter.value = 'all';
}
async function load() {
  const data = await api.tasks(100);
  const items = data.tasks || data.items || [];
  list.value = Array.isArray(items) ? items : [];
}
async function cancel(row) {
  await api.cancelTask(row.id);
  Message.success('已取消');
  await load();
}
async function retry(row) {
  if (api.resumeTask) {
    await api.resumeTask(row.id);
    Message.success('已重试');
    await load();
  } else {
    Message.info('请到画布卡片内重试');
  }
}
function cancelRunning() {
  Modal.confirm({
    title: '取消进行中任务',
    content: `将取消 ${runningCount.value} 个进行中任务`,
    onOk: async () => {
      for (const t of list.value.filter(active)) {
        try { await api.cancelTask(t.id); } catch { /* ignore */ }
      }
      Message.success('已取消');
      await load();
    },
  });
}
function exportCsv() {
  const header = 'id,kind,model,channel,status,elapsed,reason\n';
  const body = rows.value.map((r) => [r.id, r.kind, r.model, r.channel, r.status, r.elapsed, JSON.stringify(r.reason || '')].join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([header + body], { type: 'text/csv' }));
  a.download = `tasks-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}
onMounted(() => {
  load().catch((e) => Message.error(e.message));
  timer = setInterval(() => load().catch(() => {}), 4000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped lang="scss">
.wrap { padding: 28px 48px 40px; }
.page-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:18px; }
.page-head h2 { margin:0; font-size:22px; color:#101828; }
.desc { margin:6px 0 0; color:#6b7684; font-size:13px; }
.metrics {
  display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:16px;
}
.metric {
  background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:16px 18px; min-height:104px;
}
.label { color:#6b7684; font-size:12px; }
.value { font-size:28px; font-weight:700; margin-top:4px; color:#101828; }
.value.warn { color:#ed4014; }
.sub { color:#8b95a3; font-size:12px; margin-top:8px; line-height:1.4; }
.panel { background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:14px 16px 8px; }
.filters { display:flex; gap:10px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
.tabs {
  display:flex; background:#f5f7f9; border-radius:8px; padding:3px;
  button {
    border:0; background:transparent; padding:6px 12px; border-radius:6px; color:#6b7684; cursor:pointer; font-size:13px;
    &.on { background:#fff; color:#2d8cf0; font-weight:600; box-shadow:0 1px 2px rgba(16,24,40,.06); }
  }
}
.cell-main b { display:block; }
.tiny { font-size:12px; margin-top:2px; }
.kind {
  display:inline-block; font-size:12px; padding:2px 8px; border-radius:999px; background:#f5f7f9; color:#6b7684;
  &.image { background:#ecfdf5; color:#047857; }
  &.video { background:#fff7ed; color:#c2410c; }
  &.audio { background:#f5f3ff; color:#6d28d9; }
  &.quick { background:#ecfeff; color:#0e7490; }
}
</style>
