<template>
  <div>
    <Row :gutter="16">
      <Col :span="6" v-for="card in cards" :key="card.title">
        <div class="metric">
          <div class="top">
            <span>{{ card.title }}</span>
            <span class="ico">{{ card.icon }}</span>
          </div>
          <div class="value">{{ card.value }} <small>{{ card.unit }}</small></div>
          <div class="sub">{{ card.sub }}</div>
          <div v-if="card.bar != null" class="bar"><i :style="{ width: card.bar + '%' }" /></div>
        </div>
      </Col>
    </Row>

    <Row :gutter="16" style="margin-top:16px">
      <Col :span="15">
        <div class="panel">
          <div class="head">
            <b>近 7 日任务趋势</b>
            <span class="legend"><i class="ok" />成功 <i class="fail" />失败</span>
            <div class="seg">
              <button class="on">按天</button>
              <button>按通道</button>
            </div>
          </div>
          <div class="bars">
            <div v-for="d in data.trend || []" :key="d.day" class="col">
              <div class="stack">
                <div class="ok" :style="{ height: h(d.ok) + 'px' }" />
                <div class="fail" :style="{ height: h(d.fail) + 'px' }" />
              </div>
              <div class="day">{{ String(d.day || '').slice(5) }}</div>
            </div>
          </div>
        </div>
      </Col>
      <Col :span="9">
        <div class="panel">
          <div class="head"><b>通道可用与余额</b><a @click="$router.push('/admin/channels')">管理通道</a></div>
          <div v-for="ch in data.channels || []" :key="ch.id" class="ch">
            <div class="line1">
              <span><i :class="ch.enabled ? 'on' : 'off'" />{{ ch.name }}</span>
              <Tag size="small">通道</Tag>
              <b>{{ ch.balanceText || '—' }}</b>
            </div>
            <div class="line2 muted">{{ ch.enabled ? '可用' : '已停用' }}</div>
          </div>
          <div v-if="!(data.channels || []).length" class="muted">暂无通道</div>
        </div>
      </Col>
    </Row>

    <Row :gutter="16" style="margin-top:16px">
      <Col :span="8">
        <div class="panel">
          <div class="head"><b>画布与素材</b><a @click="$router.push('/admin/storage')">详情</a></div>
          <div v-for="s in storageRows" :key="s.label" class="sto">
            <div class="line"><span><i :style="{ background: s.color }" />{{ s.label }}</span><span>{{ s.text }}</span></div>
            <div class="bar"><i :style="{ width: s.pct + '%', background: s.color }" /></div>
          </div>
          <Space style="margin-top:12px">
            <Button size="small" @click="$router.push('/admin/storage')">清理缩略图</Button>
            <Button size="small" @click="$router.push('/admin/recycle')">清理孤儿</Button>
          </Space>
        </div>
      </Col>
      <Col :span="8">
        <div class="panel">
          <div class="head"><b>近 5 条错误</b><a @click="$router.push('/admin/logs')">全部</a></div>
          <div v-for="(err, i) in data.errors || []" :key="i" class="err">
            <div class="line"><span>{{ err.when }}</span><Tag color="error" size="small">错误</Tag></div>
            <div class="muted">{{ err.message }}</div>
          </div>
          <div v-if="!(data.errors || []).length" class="muted">暂无错误</div>
        </div>
      </Col>
      <Col :span="8">
        <div class="panel">
          <div class="head"><b>启动自检</b><span class="muted">刚刚</span></div>
          <div v-for="c in data.checks || []" :key="c.label" class="check">
            <div>
              <div>{{ c.label }}</div>
              <div class="muted tiny">{{ c.detail }}</div>
            </div>
            <Tag :color="c.ok ? 'success' : 'error'">{{ c.ok ? '正常' : '注意' }}</Tag>
          </div>
          <Space style="margin-top:12px">
            <Button long @click="load">重新自检</Button>
          </Space>
        </div>
      </Col>
    </Row>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { Message } from 'view-ui-plus';
import { api } from '@/api/client';

const data = ref({ todayOk: 0, todayFail: 0, running: 0, canvases: 0, storage: {}, trend: [], channels: [], errors: [], checks: [] });

const cards = computed(() => {
  const ok = data.value.todayOk || 0;
  const fail = data.value.todayFail || 0;
  const total = ok + fail;
  const rate = total ? Math.round((ok / total) * 1000) / 10 + '%' : '—';
  const storage = data.value.storage || {};
  return [
    { title: '今日任务', icon: '任', value: total, unit: '', sub: `成功 ${ok} · 失败 ${fail}` },
    { title: '今日成功率', icon: '%', value: rate, unit: '', sub: '相对昨日', bar: total ? Math.round((ok / total) * 100) : 0 },
    { title: '进行中', icon: '跑', value: data.value.running || 0, unit: '', sub: '队列 / 渲染中' },
    { title: '画布 / 素材体积', icon: '库', value: data.value.canvases || 0, unit: '画布', sub: storage.totalText || '—', bar: 43 },
  ];
});

const storageRows = computed(() => {
  const s = data.value.storage || {};
  const total = Number(s.totalBytes) || 1;
  return [
    { label: '图片', color: '#22a06b', text: fmt(s.imageBytes), pct: pct(s.imageBytes, total) },
    { label: '视频', color: '#e07a2f', text: fmt(s.videoBytes), pct: pct(s.videoBytes, total) },
    { label: '音频', color: '#7a5af8', text: fmt(s.audioBytes), pct: pct(s.audioBytes, total) },
  ];
});

function fmt(n) {
  const v = Number(n) || 0;
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / 1024 / 1024).toFixed(1) + ' MB';
}
function pct(n, total) { return Math.min(100, Math.round(((Number(n) || 0) / total) * 100)); }
function h(n) { return Math.max(4, Math.min(120, (Number(n) || 0) * 4)); }
async function load() {
  try { data.value = await api.adminDashboard(); }
  catch (e) { Message.error(e.message); }
}
onMounted(load);
</script>

<style scoped lang="scss">
.metric, .panel {
  background: #fff; border: 1px solid #eef1f6; border-radius: 12px; padding: 16px; min-height: 120px;
}
.metric .top { display: flex; justify-content: space-between; color: #6b7684; font-size: 12px; }
.ico {
  width: 26px; height: 26px; border-radius: 8px; background: #eef5ff; color: #2d8cf0;
  display: grid; place-items: center; font-size: 12px;
}
.value { font-size: 28px; font-weight: 700; margin: 10px 0 6px; }
.value small { font-size: 13px; color: #8b95a3; font-weight: 400; }
.sub { color: #8b95a3; font-size: 12px; }
.bar { height: 6px; background: #eef1f6; border-radius: 3px; margin-top: 12px; overflow: hidden; }
.bar i { display: block; height: 100%; background: #2d8cf0; }
.head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.head a { margin-left: auto; color: #2d8cf0; font-size: 12px; }
.legend { color: #8b95a3; font-size: 12px; display: flex; gap: 10px; align-items: center; }
.legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.legend .ok { background: #19be6b; } .legend .fail { background: #ed4014; }
.seg { margin-left: auto; display: flex; background: #f5f7f9; border-radius: 6px; padding: 2px; }
.seg button { border: 0; background: transparent; padding: 2px 10px; border-radius: 4px; color: #6b7684; cursor: pointer; }
.seg .on { background: #fff; color: #2d8cf0; }
.bars { display: flex; gap: 18px; align-items: end; height: 170px; padding: 8px 4px; }
.col { width: 40px; text-align: center; }
.stack { display: flex; flex-direction: column-reverse; height: 140px; }
.stack .ok { background: #19be6b; border-radius: 4px 4px 0 0; }
.stack .fail { background: #ed4014; }
.day { font-size: 12px; color: #8b95a3; margin-top: 6px; }
.ch { padding: 10px 0; border-bottom: 1px solid #f5f7f9; }
.line1 { display: flex; gap: 8px; align-items: center; }
.line1 b { margin-left: auto; }
.line1 i, .sto i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 8px; }
.line1 i.on { background: #19be6b; } .line1 i.off { background: #8b95a3; }
.line2 { font-size: 12px; margin-top: 4px; padding-left: 15px; }
.sto { margin-bottom: 10px; }
.sto .line { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
.err, .check { padding: 10px 0; border-bottom: 1px solid #f5f7f9; }
.err .line, .check { display: flex; justify-content: space-between; gap: 8px; }
.tiny { font-size: 12px; margin-top: 2px; }
</style>
