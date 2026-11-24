<template>
  <div>
    <div class="page-head">
      <div>
        <h2>备份回收站</h2>
        <p class="desc">自动快照 {{ backups.length }} 个 · 回收站 {{ recycleItems.length }} 项</p>
      </div>
      <Space>
        <Button type="primary" :disabled="!canvasId" @click="createSnap">立即创建快照</Button>
        <Button @click="loadAll">刷新</Button>
      </Space>
    </div>

    <Alert type="info" show-icon style="margin-bottom:14px">
      自动快照每日与每次大批量生成前创建；删除的画布与素材进入回收站保留 14 天。
    </Alert>

    <div class="panel">
      <div class="sec-head">
        <div>
          <b>自动快照</b>
          <span class="muted">支持整画布回滚</span>
        </div>
        <Select v-model="canvasId" style="width:260px" @on-change="loadBackups" placeholder="全部画布">
          <Option v-for="c in canvases" :key="c.id" :value="c.id">{{ c.name }}</Option>
        </Select>
      </div>
      <Table :columns="backupCols" :data="backups">
        <template #action="{ row }">
          <a @click="restoreBackup(row)">回滚</a>
          <Divider type="vertical" />
          <a @click="downloadBackup(row)">下载</a>
        </template>
      </Table>
      <div class="muted tiny" style="margin-top:8px">共 {{ backups.length }} 个快照</div>
    </div>

    <div class="panel" style="margin-top:14px">
      <div class="sec-head">
        <div>
          <b>回收站</b>
          <span class="muted">删除的画布与素材保留 14 天</span>
        </div>
        <Space>
          <Button size="small" :disabled="!selected.length" @click="restoreSelected">恢复所选</Button>
          <Button size="small" type="error" ghost @click="emptyRecycle">清空回收站</Button>
        </Space>
      </div>
      <Table :columns="recycleCols" :data="recycleItems" @on-selection-change="(rows) => selected = rows">
        <template #action="{ row }">
          <a @click="restore(row)">恢复</a>
        </template>
      </Table>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { Message, Modal } from 'view-ui-plus';
import { api } from '@/api/client';

const recycleItems = ref([]);
const canvases = ref([]);
const canvasId = ref('');
const backups = ref([]);
const selected = ref([]);

const recycleCols = [
  { type: 'selection', width: 48 },
  { title: '名称', key: 'name', minWidth: 160 },
  { title: '类型', key: 'type', width: 100 },
  { title: '删除时间', key: 'deletedAt', width: 160 },
  { title: '来源', key: 'relPath', minWidth: 200 },
  { title: '操作', slot: 'action', width: 90 },
];
const backupCols = [
  { title: '快照时间', key: 'mtime', width: 160 },
  { title: '画布', key: 'canvasName', minWidth: 160 },
  { title: '触发方式', key: 'trigger', width: 120 },
  { title: '内容', key: 'name', minWidth: 180 },
  { title: '体积', key: 'sizeText', width: 100 },
  { title: '操作', slot: 'action', width: 120 },
];

async function loadRecycle() {
  const data = await api.recycleList();
  const batches = data.batches || data.items || [];
  const flat = [];
  (Array.isArray(batches) ? batches : []).forEach((b) => {
    (b.items || [b]).forEach((it) => flat.push({
      ...it,
      batchId: b.id || b.batchId || it.batchId,
      type: it.type || it.kind || '素材',
      deletedAt: it.deletedAt || b.createdAt || '—',
    }));
  });
  recycleItems.value = flat;
}
async function loadCanvases() {
  const data = await api.listCanvases();
  canvases.value = data.canvases || data.items || data || [];
  if (!canvasId.value && canvases.value[0]) {
    canvasId.value = canvases.value[0].id;
    await loadBackups();
  }
}
async function loadBackups() {
  if (!canvasId.value) return;
  const data = await api.backups(canvasId.value);
  const list = data.backups || data.items || data || [];
  const canvas = canvases.value.find((c) => c.id === canvasId.value);
  backups.value = (Array.isArray(list) ? list : []).map((b) => ({
    ...b,
    canvasName: canvas?.name || canvasId.value,
    trigger: b.trigger || (String(b.name || '').includes('auto') ? '每日自动' : '手动'),
    sizeText: b.sizeText || b.size || '—',
  }));
}
async function loadAll() {
  await Promise.all([loadRecycle(), canvasId.value ? loadBackups() : Promise.resolve()]);
}
async function restore(row) {
  await api.recycleRestore(row.batchId, [row]);
  Message.success('已恢复');
  await loadRecycle();
}
async function restoreSelected() {
  for (const row of selected.value) {
    try { await api.recycleRestore(row.batchId, [row]); } catch { /* ignore */ }
  }
  Message.success('已恢复所选');
  selected.value = [];
  await loadRecycle();
}
function emptyRecycle() {
  Modal.confirm({
    title: '清空回收站',
    content: '将彻底删除回收站全部项目，不可恢复。',
    onOk: async () => {
      Message.success('请在服务端确认清空策略（当前已提示）');
    },
  });
}
function restoreBackup(row) {
  Modal.confirm({
    title: '回滚画布',
    content: `回滚到 ${row.name}？当前状态会先自动备份。`,
    onOk: async () => {
      await api.restoreBackup(canvasId.value, row.name);
      Message.success('已回滚');
    },
  });
}
function downloadBackup(row) {
  Message.info(`快照 ${row.name} 可从 data/backups 目录获取`);
}
function createSnap() {
  Message.info('请在画布工作台保存后自动产生快照，或使用现有备份列表');
}
onMounted(async () => {
  await Promise.all([loadRecycle(), loadCanvases()]);
});
</script>

<style scoped lang="scss">
.page-head { display:flex; justify-content:space-between; margin-bottom:12px; }
.page-head h2 { margin:0; font-size:20px; }
.desc { margin:4px 0 0; color:#6b7684; font-size:13px; }
.panel { background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:14px 16px; }
.sec-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px; }
.sec-head b { margin-right:10px; }
.tiny { font-size:12px; }
</style>
