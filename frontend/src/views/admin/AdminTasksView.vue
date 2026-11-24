<template>
  <div>
    <div class="page-head">
      <div>
        <h2>任务监控</h2>
        <p class="desc">全画布任务 · 自动刷新 10s</p>
      </div>
      <Space>
        <Button @click="paused = !paused">{{ paused ? '继续刷新' : '暂停刷新' }}</Button>
        <Button @click="exportCsv">导出</Button>
      </Space>
    </div>

    <Alert type="warning" show-icon class="tip">
      强制失败会中断通道轮询并标记任务失败，仅在任务挂死超过 10 分钟时使用；建议先用「接续信息」确认通道侧是否已产出。
      <template #desc>处理建议：先查额度 / 原始响应，再决定强制失败或接续。</template>
    </Alert>

    <Row :gutter="14" class="metrics">
      <Col :span="6"><div class="metric"><div class="label">GPU 队列</div><div class="value">{{ queued }} / {{ concurrency }}</div><div class="sub">并发上限 {{ concurrency }}</div></div></Col>
      <Col :span="6"><div class="metric"><div class="label">执行中任务</div><div class="value">{{ runningCount }}</div><div class="sub">{{ runningHint }}</div></div></Col>
      <Col :span="6"><div class="metric"><div class="label">疑似挂死</div><div class="value warn">{{ stuckCount }}</div><div class="sub">超过 10 分钟仍轮询</div></div></Col>
      <Col :span="6"><div class="metric"><div class="label">今日吞吐</div><div class="value">{{ doneCount + failedCount }}</div><div class="sub">成功 {{ doneCount }} · 失败 {{ failedCount }}</div></div></Col>
    </Row>

    <div class="panel">
      <div class="filters">
        <RadioGroup v-model="filter" type="button">
          <Radio label="all">全部</Radio>
          <Radio label="running">进行中 {{ runningCount }}</Radio>
          <Radio label="failed">失败 {{ failedCount }}</Radio>
          <Radio label="done">完成 {{ doneCount }}</Radio>
        </RadioGroup>
        <Input v-model="q" search clearable placeholder="任务 ID" style="width:180px" />
        <span class="muted tiny">{{ paused ? '已暂停' : '10s 自动刷新' }}</span>
      </div>

      <Table :columns="columns" :data="rows">
        <template #task="{ row }">
          <div><b>#{{ shortId(row.id) }}</b><div class="muted tiny">{{ formatTime(row.createdAt || row.time) }}</div></div>
        </template>
        <template #canvas="{ row }">
          <div><div>{{ row.canvasName || row.canvasId || '—' }}</div><div class="muted tiny">{{ row.cardName || row.prompt?.slice(0, 28) || '—' }}</div></div>
        </template>
        <template #model="{ row }">
          <div><div>{{ row.model || '—' }}</div><div class="muted tiny">{{ row.channel || row.channelName || '—' }}</div></div>
        </template>
        <template #status="{ row }">
          <Tag :color="statusColor(row)">{{ statusLabel(row) }}</Tag>
          <div class="muted tiny">{{ row.elapsed || row.duration || '' }}</div>
        </template>
        <template #resume="{ row }">
          <div class="resume">{{ row.resumeInfo || row.stage || row.message || '—' }}</div>
        </template>
        <template #action="{ row }">
          <a v-if="row.canvasId" @click="$router.push(`/canvas/${row.canvasId}`)">详情</a>
          <Divider v-if="isActive(row)" type="vertical" />
          <a v-if="isActive(row)" @click="cancel(row)">取消</a>
          <Divider v-if="isActive(row) || isFailed(row)" type="vertical" />
          <a v-if="isActive(row)" class="danger" @click="forceFail(row)">强制失败</a>
          <a v-if="isFailed(row)" @click="resume(row)">接续</a>
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
const rowsRaw = ref([]);
const paused = ref(false);
const concurrency = ref(3);
let timer = 0;

const columns = [
  { title: '任务 / 时间', slot: 'task', width: 120 },
  { title: '画布 / 卡片', slot: 'canvas', minWidth: 180 },
  { title: '模型 / 通道', slot: 'model', minWidth: 150 },
  { title: '状态', slot: 'status', width: 110 },
  { title: '接续信息', slot: 'resume', minWidth: 200 },
  { title: '操作', slot: 'action', width: 180 },
];

function isActive(row) {
  return ['running', 'queued', 'pending', 'waiting', 'rendering'].includes(String(row.status || '').toLowerCase());
}
function isFailed(row) {
  return String(row.status || '').toLowerCase() === 'failed';
}
function isDone(row) {
  return ['done', 'completed', 'success'].includes(String(row.status || '').toLowerCase());
}
function shortId(id) { return String(id || '').slice(-4).toUpperCase() || '—'; }
function formatTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t).slice(0, 19);
  return d.toTimeString().slice(0, 8);
}
function statusLabel(row) {
  if (isActive(row)) return row.stage || '渲染中';
  if (isDone(row)) return '完成';
  if (isFailed(row)) return '失败';
  return row.status || '—';
}
function statusColor(row) {
  if (isActive(row)) return 'blue';
  if (isDone(row)) return 'success';
  if (isFailed(row)) return 'error';
  return 'default';
}

const runningCount = computed(() => rowsRaw.value.filter(isActive).length);
const doneCount = computed(() => rowsRaw.value.filter(isDone).length);
const failedCount = computed(() => rowsRaw.value.filter(isFailed).length);
const queued = computed(() => rowsRaw.value.filter((t) => ['queued', 'pending', 'waiting'].includes(String(t.status).toLowerCase())).length);
const stuckCount = computed(() => rowsRaw.value.filter((t) => t.stuck || /挂死|超时|无响应/.test(String(t.message || t.stage || ''))).length);
const runningHint = computed(() => {
  const first = rowsRaw.value.find(isActive);
  return first ? `#${shortId(first.id)} 耗时 ${first.elapsed || first.duration || '—'}` : '暂无执行中';
});
const rows = computed(() => {
  let list = rowsRaw.value;
  if (filter.value === 'running') list = list.filter(isActive);
  if (filter.value === 'done') list = list.filter(isDone);
  if (filter.value === 'failed') list = list.filter(isFailed);
  const kw = q.value.trim().toLowerCase();
  if (kw) list = list.filter((t) => String(t.id || '').toLowerCase().includes(kw));
  return list;
});

async function load() {
  const data = await api.tasks(200);
  let list = data.tasks || data.items || data || [];
  if (!Array.isArray(list)) list = [];
  rowsRaw.value = list;
  if (data.concurrency) concurrency.value = data.concurrency;
}
async function cancel(row) {
  await api.cancelTask(row.id);
  Message.success('已取消');
  await load();
}
async function resume(row) {
  await api.resumeTask(row.id);
  Message.success('已接续');
  await load();
}
function forceFail(row) {
  Modal.confirm({
    title: '强制失败',
    content: `将任务 #${shortId(row.id)} 标记为失败并中断轮询？`,
    onOk: async () => {
      await api.cancelTask(row.id);
      Message.success('已强制失败');
      await load();
    },
  });
}
function exportCsv() {
  const header = 'id,canvas,model,channel,status,resume\n';
  const body = rows.value.map((r) => [r.id, r.canvasId, r.model, r.channel, r.status, JSON.stringify(r.resumeInfo || r.stage || '')].join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([header + body], { type: 'text/csv' }));
  a.download = `admin-tasks-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}
onMounted(() => {
  load().catch((e) => Message.error(e.message));
  timer = setInterval(() => { if (!paused.value) load().catch(() => {}); }, 10000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped lang="scss">
.page-head { display:flex; justify-content:space-between; margin-bottom:12px; }
.page-head h2 { margin:0; font-size:20px; }
.desc { margin:4px 0 0; color:#6b7684; font-size:13px; }
.tip { margin-bottom:14px; }
.metrics { margin-bottom:14px; }
.metric { background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:14px 16px; }
.label { color:#6b7684; font-size:12px; }
.value { font-size:26px; font-weight:700; margin-top:4px; }
.value.warn { color:#ed4014; }
.sub { color:#8b95a3; font-size:12px; margin-top:6px; }
.panel { background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:14px 16px; }
.filters { display:flex; gap:10px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
.tiny { font-size:12px; }
.resume { font-size:12px; color:#3f4a58; line-height:1.45; }
.danger { color:#ed4014; }
</style>
