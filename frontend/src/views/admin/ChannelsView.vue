<template>
  <div class="channels-page">
    <div class="page-head">
      <div>
        <div class="title-row">
          <h2>生成通道</h2>
          <Tag color="blue">前台</Tag>
        </div>
        <p class="desc">通道为前台卡片提供模型能力；每个通道可配置多个模型并指定默认值，前台按类型自动匹配。</p>
      </div>
      <div class="head-actions">
        <Upload :before-upload="onImportFile" accept=".json,application/json" action="" :show-upload-list="false">
          <Button>导入</Button>
        </Upload>
        <Button @click="exportAll">导出</Button>
        <Button type="primary" icon="md-add" @click="createOne">新建通道</Button>
      </div>
    </div>

    <div class="stat-line">
      {{ channels.length }} 个通道 · 可用 {{ enabledCount }} · 预警 {{ warnCount }} · 不可用 {{ disabledCount }}
    </div>

    <div class="panel">
      <div class="bulk" v-if="selected.length">
        <span>已选 {{ selected.length }} 项</span>
        <a @click="bulkEdit">编辑</a>
        <a @click="bulkCopy">复制</a>
        <a @click="bulkToggle">启停</a>
        <a @click="bulkDelete" class="danger">删除</a>
      </div>

      <div class="filters">
        <Input v-model="q" search clearable placeholder="搜索通道名称、模型、备注" style="width:280px" />
        <Select v-model="kindFilter" style="width:120px">
          <Option value="all">全部类型</Option>
          <Option value="image">图像</Option>
          <Option value="video">视频</Option>
          <Option value="audio">音频</Option>
        </Select>
        <Select v-model="statusFilter" style="width:120px">
          <Option value="all">全部状态</Option>
          <Option value="on">启用</Option>
          <Option value="off">停用</Option>
        </Select>
        <Button @click="resetFilters">重置筛选</Button>
        <div class="grow" />
        <span class="hint">导入导出默认去除密钥字段</span>
      </div>

      <Table
        :columns="columns"
        :data="filtered"
        :row-class-name="rowClass"
        @on-selection-change="onSelect"
        @on-row-click="open"
      >
        <template #name="{ row }">
          <div class="name-cell">
            <b>{{ row.name }}</b>
            <div class="url">{{ row.baseUrl || '—' }}</div>
          </div>
        </template>
        <template #kind="{ row }">
          <Tag :color="kindColor(row)">{{ kindLabel(row) }}</Tag>
        </template>
        <template #enabled="{ row }">
          <i-switch :model-value="row.enabled !== false" @on-change="(v) => toggle(row, v)" @click.stop />
        </template>
        <template #model="{ row }">
          <div>
            <div>{{ row.defaultModel }}</div>
            <div class="muted tiny">共 {{ modelCount(row) }} 个模型 · 默认 1</div>
          </div>
        </template>
        <template #balance="{ row }">
          <div>
            <b :class="{ warn: row._warn }">{{ row.balanceText || '—' }}</b>
            <div class="muted tiny">{{ row.checkText || '未校验' }}</div>
          </div>
        </template>
        <template #note="{ row }">
          <Tag v-if="row.note" size="small">{{ row.note }}</Tag>
          <span v-else class="muted">—</span>
        </template>
        <template #action="{ row }">
          <a @click.stop="open(row)">编辑</a>
          <Divider type="vertical" />
          <a @click.stop="copy(row)">复制</a>
          <Divider type="vertical" />
          <Dropdown @on-click="(k) => quickAction(k, row)" transfer>
            <a @click.stop>更多 <Icon type="ios-arrow-down" /></a>
            <template #list>
              <DropdownMenu>
                <DropdownItem name="test-image">试一张</DropdownItem>
                <DropdownItem name="test-video">试一段</DropdownItem>
                <DropdownItem name="balance">查余额</DropdownItem>
                <DropdownItem name="delete" divided style="color:#ed4014">删除</DropdownItem>
              </DropdownMenu>
            </template>
          </Dropdown>
        </template>
      </Table>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Message, Modal } from 'view-ui-plus';
import { api } from '@/api/client';

const router = useRouter();
const channels = ref([]);
const q = ref('');
const kindFilter = ref('all');
const statusFilter = ref('all');
const selected = ref([]);

const columns = [
  { type: 'selection', width: 48 },
  { title: '通道名称', slot: 'name', minWidth: 220 },
  { title: '类型', slot: 'kind', width: 90 },
  { title: '启用', slot: 'enabled', width: 90 },
  { title: '默认模型', slot: 'model', minWidth: 180 },
  { title: '余额 / 校验', slot: 'balance', minWidth: 140 },
  { title: '备注', slot: 'note', minWidth: 100 },
  { title: '操作', slot: 'action', width: 200 },
];

const enabledCount = computed(() => channels.value.filter((c) => c.enabled !== false).length);
const disabledCount = computed(() => channels.value.filter((c) => c.enabled === false).length);
const warnCount = computed(() => channels.value.filter((c) => c._warn).length);

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase();
  return channels.value
    .map((c) => ({
      ...c,
      defaultModel: c.defaults?.image || c.defaults?.video || c.defaults?.audio || c.defaultModel || '—',
      balanceText: c.balanceText || c.balance || '',
      checkText: c.checkText || c.lastCheck || '',
      _warn: Boolean(c.warn || (typeof c.balance === 'number' && c.balance < 20)),
    }))
    .filter((c) => {
      if (kindFilter.value !== 'all' && kindKey(c) !== kindFilter.value) return false;
      if (statusFilter.value === 'on' && c.enabled === false) return false;
      if (statusFilter.value === 'off' && c.enabled !== false) return false;
      if (!kw) return true;
      const blob = [c.name, c.baseUrl, c.note, JSON.stringify(c.models || {})].join(' ').toLowerCase();
      return blob.includes(kw);
    });
});

function kindKey(c) {
  const hasI = (c.models?.image || []).length || c.imageModels?.length;
  const hasV = (c.models?.video || []).length || c.videoModels?.length;
  const hasA = (c.models?.audio || []).length || c.audioModels?.length;
  if (hasV && !hasI && !hasA) return 'video';
  if (hasA && !hasI && !hasV) return 'audio';
  if (hasI) return 'image';
  if (hasV) return 'video';
  if (hasA) return 'audio';
  return 'image';
}
function kindLabel(c) {
  const map = { image: '图像', video: '视频', audio: '音频' };
  return map[kindKey(c)] || '图像';
}
function kindColor(c) {
  const map = { image: 'green', video: 'orange', audio: 'purple' };
  return map[kindKey(c)] || 'default';
}
function modelCount(c) {
  const m = c.models || {};
  return (m.image || []).length + (m.video || []).length + (m.audio || []).length
    || (c.imageModels || []).length + (c.videoModels || []).length + (c.audioModels || []).length
    || 0;
}
function rowClass() { return 'channel-row'; }
function onSelect(rows) { selected.value = rows; }
function resetFilters() {
  q.value = '';
  kindFilter.value = 'all';
  statusFilter.value = 'all';
}
function uid() {
  return 'ch_' + Math.random().toString(36).slice(2, 10);
}
async function load() {
  const data = await api.listChannels();
  channels.value = data.channels || data || [];
}
function open(row) {
  router.push(`/admin/channels/${encodeURIComponent(row.id)}`);
}
async function persist(next) {
  await api.saveChannels(next);
  channels.value = next;
}
async function toggle(row, enabled) {
  const next = channels.value.map((c) => (c.id === row.id ? { ...c, enabled } : c));
  await persist(next);
}
async function createOne() {
  const item = {
    id: uid(),
    name: '新通道',
    baseUrl: '',
    apiKey: '',
    enabled: true,
    note: '',
    models: { image: [], video: [], audio: [] },
    defaults: {},
  };
  await persist([...channels.value, item]);
  router.push(`/admin/channels/${item.id}`);
}
async function copy(row) {
  const item = { ...JSON.parse(JSON.stringify(row)), id: uid(), name: (row.name || '通道') + ' 副本' };
  await persist([...channels.value, item]);
  Message.success('已复制');
}
function remove(row) {
  Modal.confirm({
    title: '删除通道',
    content: `确定删除「${row.name}」？`,
    onOk: async () => {
      await persist(channels.value.filter((c) => c.id !== row.id));
      Message.success('已删除');
    },
  });
}
function bulkEdit() {
  if (selected.value[0]) open(selected.value[0]);
}
async function bulkCopy() {
  for (const row of selected.value) await copy(row);
}
async function bulkToggle() {
  const ids = new Set(selected.value.map((r) => r.id));
  const next = channels.value.map((c) => (ids.has(c.id) ? { ...c, enabled: c.enabled === false } : c));
  await persist(next);
  Message.success('已切换启停');
}
function bulkDelete() {
  Modal.confirm({
    title: '删除所选通道',
    content: `确定删除 ${selected.value.length} 个通道？`,
    onOk: async () => {
      const ids = new Set(selected.value.map((r) => r.id));
      await persist(channels.value.filter((c) => !ids.has(c.id)));
      selected.value = [];
      Message.success('已删除');
    },
  });
}
async function quickAction(name, row) {
  if (name === 'delete') return remove(row);
  if (name === 'test-image' || name === 'test-video' || name === 'balance') {
    open(row);
    return;
  }
}
async function exportAll() {
  const data = await api.exportChannels(false);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `通道配置-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}
async function onImportFile(file) {
  const text = await file.text();
  Modal.confirm({
    title: '导入通道',
    content: '合并到现有通道？点取消则替换全部。',
    okText: '合并',
    cancelText: '替换全部',
    onOk: async () => {
      await api.importChannels(text, 'merge');
      await load();
      Message.success('已合并导入');
    },
    onCancel: async () => {
      await api.importChannels(text, 'replace');
      await load();
      Message.success('已替换导入');
    },
  });
  return false;
}
onMounted(() => load().catch((e) => Message.error(e.message)));
</script>

<style scoped lang="scss">
.page-head { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
.title-row { display: flex; align-items: center; gap: 10px; }
.title-row h2 { margin: 0; font-size: 20px; }
.desc { margin: 6px 0 0; color: #6b7684; font-size: 13px; max-width: 640px; }
.head-actions { display: flex; gap: 8px; align-items: flex-start; }
.stat-line { color: #8b95a3; font-size: 12px; margin-bottom: 12px; }
.panel {
  background: #fff; border: 1px solid #eef1f6; border-radius: 12px; padding: 14px 16px 8px;
}
.bulk {
  display: flex; gap: 14px; align-items: center; background: #f5f9ff; border: 1px solid #d6e6fb;
  border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; font-size: 13px;
  a { color: #2d8cf0; } .danger { color: #ed4014; }
}
.filters { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.hint { font-size: 12px; color: #8b95a3; }
.name-cell b { display: block; }
.url { font-size: 12px; color: #8b95a3; margin-top: 2px; }
.tiny { font-size: 12px; margin-top: 2px; }
.warn { color: #e07a2f; }
:deep(.channel-row) { cursor: pointer; }
</style>
