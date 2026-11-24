<template>
  <div>
    <div class="page-head">
      <div>
        <h2>日志</h2>
        <p class="desc">按天归档 · 密钥自动脱敏</p>
      </div>
      <Space>
        <Button @click="download">导出当日</Button>
        <Button @click="load">刷新</Button>
      </Space>
    </div>

    <div class="layout">
      <aside class="days">
        <div class="label">目录</div>
        <div
          v-for="d in dayLabels"
          :key="d.value"
          class="day"
          :class="{ active: day === d.value }"
          @click="day = d.value; load()"
        >{{ d.label }}</div>
        <DatePicker v-model="pickDate" type="date" placeholder="选择日期" style="width:100%;margin-top:8px" @on-change="onPick" />
      </aside>

      <div class="panel">
        <div class="filters">
          <RadioGroup v-model="level" type="button">
            <Radio label="all">全部</Radio>
            <Radio label="info">INFO</Radio>
            <Radio label="warn">WARN {{ warnCount || '' }}</Radio>
            <Radio label="error">ERROR {{ errorCount || '' }}</Radio>
          </RadioGroup>
          <Input v-model="q" search clearable placeholder="搜索模块 / 任务 ID / 关键词" style="width:280px" />
          <span class="muted tiny">密钥已脱敏显示</span>
        </div>

        <Table :columns="columns" :data="parsedRows" height="520" @on-row-click="openDetail">
          <template #level="{ row }">
            <Tag :color="levelColor(row.level)" size="small">{{ row.level }}</Tag>
          </template>
        </Table>
        <div class="foot muted">当日 {{ totalHint }} · 仅显示最近 200 条</div>
      </div>
    </div>

    <Drawer v-model="detailOpen" title="日志详情" width="420">
      <pre class="detail">{{ detailText }}</pre>
    </Drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Message } from 'view-ui-plus';
import { api } from '@/api/client';

const day = ref('');
const days = ref([]);
const level = ref('all');
const q = ref('');
const lines = ref('');
const pickDate = ref('');
const detailOpen = ref(false);
const detailText = ref('');
let timer = 0;

const columns = [
  { title: '时间', key: 'time', width: 100 },
  { title: '级别', slot: 'level', width: 90 },
  { title: '模块', key: 'module', width: 120 },
  { title: '内容', key: 'content', minWidth: 360, tooltip: true },
];

const dayLabels = computed(() => {
  const list = days.value.length ? days.value : [day.value].filter(Boolean);
  return list.map((d, i) => ({
    value: d,
    label: i === 0 ? `今天 ${formatDay(d)}` : i === 1 ? `昨天 ${formatDay(d)}` : formatDay(d),
  }));
});

function formatDay(d) {
  if (!d) return '';
  const m = String(d).match(/(\d{2})-(\d{2})$/) || String(d).match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${m[1]}/${m[2]}`;
  return String(d).slice(5);
}

const parsedAll = computed(() => {
  return String(lines.value || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d{1,2}:\d{2}:\d{2})\s+(\w+)\s+(\S+)\s+(.*)$/)
        || line.match(/^\[?(\d{1,2}:\d{2}:\d{2})\]?\s*(ERROR|WARN|INFO|DEBUG)?\s*(.*)$/i);
      if (m && m.length >= 4 && m[3] && m[4] !== undefined) {
        return { time: m[1], level: (m[2] || 'INFO').toUpperCase(), module: m[3], content: m[4], raw: line };
      }
      const lower = line.toLowerCase();
      let lv = 'INFO';
      if (lower.includes('error') || lower.includes('失败') || lower.includes('出错')) lv = 'ERROR';
      else if (lower.includes('warn') || lower.includes('注意')) lv = 'WARN';
      const timeMatch = line.match(/(\d{1,2}:\d{2}:\d{2})/);
      return { time: timeMatch?.[1] || '—', level: lv, module: '—', content: line, raw: line };
    });
});

const warnCount = computed(() => parsedAll.value.filter((r) => r.level === 'WARN').length);
const errorCount = computed(() => parsedAll.value.filter((r) => r.level === 'ERROR').length);
const totalHint = computed(() => parsedAll.value.length.toLocaleString());

const parsedRows = computed(() => {
  let arr = parsedAll.value;
  if (level.value !== 'all') arr = arr.filter((r) => r.level === level.value.toUpperCase());
  const kw = q.value.trim().toLowerCase();
  if (kw) arr = arr.filter((r) => r.raw.toLowerCase().includes(kw));
  return arr.slice(0, 200);
});

function levelColor(lv) {
  if (lv === 'ERROR') return 'error';
  if (lv === 'WARN') return 'warning';
  return 'default';
}
function openDetail(row) {
  detailText.value = row.raw;
  detailOpen.value = true;
}
function onPick(val) {
  if (!val) return;
  const d = new Date(val);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  day.value = iso;
  load();
}
async function load() {
  const data = await api.logs(day.value || undefined);
  days.value = data.days || days.value;
  if (!day.value && days.value[0]) day.value = days.value[0];
  lines.value = data.text || data.content || (Array.isArray(data.lines) ? data.lines.join('\n') : '');
}
function download() {
  location.href = api.logDownloadUrl(day.value);
}
onMounted(() => {
  load().catch((e) => Message.error(e.message));
  timer = setInterval(() => load().catch(() => {}), 5000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped lang="scss">
.page-head { display:flex; justify-content:space-between; margin-bottom:14px; }
.page-head h2 { margin:0; font-size:20px; }
.desc { margin:4px 0 0; color:#6b7684; font-size:13px; }
.layout { display:flex; gap:14px; align-items:flex-start; }
.days {
  width: 160px; background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:12px;
}
.days .label { font-size:12px; color:#8b95a3; margin-bottom:8px; }
.day {
  padding:8px 10px; border-radius:8px; cursor:pointer; color:#3f4a58; margin-bottom:2px; font-size:13px;
  &.active, &:hover { background:#eef5ff; color:#2d8cf0; }
}
.panel { flex:1; background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:14px 16px; }
.filters { display:flex; gap:10px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
.tiny { font-size:12px; }
.foot { margin-top:10px; font-size:12px; }
.detail { white-space:pre-wrap; font-size:12px; line-height:1.6; }
</style>
