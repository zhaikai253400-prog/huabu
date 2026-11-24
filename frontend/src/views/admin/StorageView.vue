<template>
  <div>
    <div class="page-head">
      <div>
        <h2>存储管理</h2>
        <p class="desc">根目录、分类占用与清理</p>
      </div>
      <Space>
        <Button :loading="busy" @click="reindex">重新索引</Button>
        <Button @click="load">刷新</Button>
      </Space>
    </div>

    <div class="usage panel">
      <div class="usage-top">
        <div>
          <b>{{ totalText }}</b>
          <div class="muted">{{ stats.assetRoot || 'data/assets' }} · 分区本地磁盘</div>
        </div>
        <Button size="small">更改根目录</Button>
      </div>
      <Progress :percent="usagePct" :stroke-width="10" status="active" />
      <div class="muted tiny" style="margin-top:6px">低于预警阈值时建议清理缩略图与孤儿素材</div>
    </div>

    <Row :gutter="14" style="margin-top:14px">
      <Col :span="6" v-for="c in cards" :key="c.label">
        <div class="card">
          <div class="dot" :style="{ background: c.color }" />
          <div class="label">{{ c.label }}</div>
          <div class="value">{{ c.count }}</div>
          <div class="size">{{ c.size }}</div>
        </div>
      </Col>
    </Row>

    <Row :gutter="14" style="margin-top:14px">
      <Col :span="8">
        <div class="panel box">
          <b>缩略图清理</b>
          <p class="muted">清理 30 天未访问的缩略图，画布会在下次打开时自动重建。</p>
          <div class="muted tiny">可清理约 {{ format(stats.thumbBytes) }}</div>
          <Button style="margin-top:10px" :loading="busy" @click="cleanThumbs">立即清理</Button>
        </div>
      </Col>
      <Col :span="8">
        <div class="panel box">
          <b>孤儿素材</b>
          <p class="muted">未被任何画布引用且超过 7 天的素材，清理后进入回收站。</p>
          <Button style="margin-top:10px" :loading="busy" @click="cleanOrphans">查看并清理</Button>
        </div>
      </Col>
      <Col :span="8">
        <div class="panel box">
          <b>快照与回收站占用</b>
          <p class="muted">快照与回收站占用可在备份回收站管理。</p>
          <Button style="margin-top:10px" @click="$router.push('/admin/recycle')">前往管理</Button>
        </div>
      </Col>
    </Row>

    <div class="panel" style="margin-top:14px">
      <div class="table-head">
        <b>目录明细</b>
        <span class="muted">data 目录下的子目录占用</span>
      </div>
      <Table :columns="dirCols" :data="dirRows">
        <template #action>
          <a>打开</a>
        </template>
      </Table>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { Message } from 'view-ui-plus';
import { api } from '@/api/client';

const stats = ref({});
const busy = ref(false);
const dirCols = [
  { title: '子目录', key: 'path', minWidth: 200 },
  { title: '用途', key: 'usage', minWidth: 140 },
  { title: '体积', key: 'size', width: 100 },
  { title: '操作', slot: 'action', width: 80 },
];

function format(n) {
  const v = Number(n) || 0;
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

const cards = computed(() => [
  { label: '图片素材', count: stats.value.imageCount ?? '—', size: format(stats.value.imageBytes), color: '#22a06b' },
  { label: '视频素材', count: stats.value.videoCount ?? '—', size: format(stats.value.videoBytes), color: '#e07a2f' },
  { label: '音频素材', count: stats.value.audioCount ?? '—', size: format(stats.value.audioBytes), color: '#7a5af8' },
  { label: '缩略图缓存', count: stats.value.thumbCount ?? '—', size: format(stats.value.thumbBytes), color: '#2d8cf0' },
]);
const totalText = computed(() => {
  const total = (Number(stats.value.imageBytes) || 0) + (Number(stats.value.videoBytes) || 0)
    + (Number(stats.value.audioBytes) || 0) + (Number(stats.value.thumbBytes) || 0) + (Number(stats.value.tailBytes) || 0);
  return `${format(total)} 已用`;
});
const usagePct = computed(() => Math.min(90, Math.round(((Number(stats.value.imageBytes) || 0) + (Number(stats.value.videoBytes) || 0)) / (200 * 1024 * 1024 * 1024) * 100) || 12));
const dirRows = computed(() => [
  { path: 'data/assets/images', usage: '图片素材原图', size: format(stats.value.imageBytes) },
  { path: 'data/assets/videos', usage: '视频与快速视频产出', size: format(stats.value.videoBytes) },
  { path: 'data/assets/audio', usage: '音频与配乐', size: format(stats.value.audioBytes) },
  { path: 'data/thumbs', usage: '缩略图缓存', size: format(stats.value.thumbBytes) },
]);

async function load() {
  stats.value = await api.storageStats();
}
async function cleanOrphans() {
  busy.value = true;
  try {
    const r = await api.libraryCleanOrphans();
    Message.success(`已清理 ${r.count ?? r.removed ?? 0} 项`);
    await load();
  } catch (e) {
    Message.error(e.message);
  } finally {
    busy.value = false;
  }
}
async function cleanThumbs() {
  busy.value = true;
  try {
    await api.saveSettings({ cleanThumbs: true });
    Message.success('已请求清理缩略图');
    await load();
  } catch (e) {
    Message.error(e.message);
  } finally {
    busy.value = false;
  }
}
async function reindex() {
  busy.value = true;
  try {
    await load();
    Message.success('已重新扫描');
  } finally {
    busy.value = false;
  }
}
onMounted(() => load().catch((e) => Message.error(e.message)));
</script>

<style scoped lang="scss">
.page-head { display:flex; justify-content:space-between; margin-bottom:14px; }
.page-head h2 { margin:0; font-size:20px; }
.desc { margin:4px 0 0; color:#6b7684; font-size:13px; }
.panel { background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:16px 18px; }
.usage-top { display:flex; justify-content:space-between; margin-bottom:10px; }
.card {
  background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:16px; position:relative;
}
.dot { width:8px; height:8px; border-radius:50%; position:absolute; right:14px; top:14px; }
.label { color:#6b7684; font-size:12px; }
.value { font-size:24px; font-weight:700; margin-top:6px; }
.size { color:#8b95a3; font-size:12px; margin-top:4px; }
.box b { display:block; margin-bottom:6px; }
.box p { margin:0 0 8px; font-size:13px; line-height:1.5; }
.table-head { display:flex; justify-content:space-between; margin-bottom:10px; }
.tiny { font-size:12px; }
</style>
