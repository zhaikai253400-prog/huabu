<template>
  <div>
    <div class="page-head">
      <div>
        <h2>代码同步</h2>
        <p class="desc">只同步程序文件，不含 data / 素材</p>
      </div>
      <Space>
        <Button @click="showTokenHint">同步口令设置</Button>
        <Button @click="plan" :loading="planning">重新连接</Button>
      </Space>
    </div>

    <div class="steps">
      <div v-for="(s, i) in stepLabels" :key="s" class="step" :class="{ on: step >= i + 1 }">
        <span class="n">{{ i + 1 }}</span>{{ s }}
      </div>
    </div>

    <Alert v-if="planResult" :type="conflictCount ? 'warning' : 'success'" show-icon style="margin-bottom:14px">
      对比完成 · 可同步 {{ syncableCount }} 项，冲突 {{ conflictCount }} 项
    </Alert>

    <Row :gutter="14">
      <Col :span="8">
        <div class="panel">
          <div class="sec-title">对端程序 <Tag :color="planResult ? 'success' : 'default'" size="small">{{ planResult ? '已连接' : '未连接' }}</Tag></div>
          <Form :label-width="90">
            <FormItem label="对端地址">
              <Input v-model="host" placeholder="http://192.168.x.x:17890" />
            </FormItem>
            <FormItem label="同步口令">
              <Input v-model="token" type="password" placeholder="可选" />
            </FormItem>
            <FormItem label="同步范围">
              <Checkbox :model-value="true" disabled>app/ 与 admin/ 程序文件</Checkbox>
              <div class="tip">排除 data</div>
            </FormItem>
          </Form>
          <Space>
            <Button :loading="planning" type="primary" @click="plan">1 连接并对比</Button>
            <Button type="primary" :loading="pulling" :disabled="!planResult" @click="pull">3 同步所选</Button>
          </Space>
        </div>
      </Col>
      <Col :span="16">
        <div class="panel">
          <div class="stats">
            <div><b>{{ counts.add }}</b><span>新增</span></div>
            <div><b>{{ counts.mod }}</b><span>修改</span></div>
            <div><b class="warn">{{ counts.conflict }}</b><span>冲突</span></div>
            <div><b>{{ counts.extra }}</b><span>对端多余</span></div>
          </div>
          <div class="sec-head">
            <b>文件差异</b>
            <span class="muted">不包含 data/ 与素材目录</span>
          </div>
          <Table :columns="cols" :data="diffRows" height="420">
            <template #diff="{ row }">
              <Tag :color="diffColor(row.kind)" size="small">{{ row.kind }}</Tag>
            </template>
            <template #action="{ row }">
              <a @click="showDiff(row)">查看差异</a>
            </template>
          </Table>
          <pre v-if="planText" class="plan">{{ planText }}</pre>
        </div>
      </Col>
    </Row>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { Message, Modal } from 'view-ui-plus';
import { api } from '@/api/client';

const host = ref('');
const token = ref('');
const planning = ref(false);
const pulling = ref(false);
const planResult = ref(null);
const step = ref(1);
const stepLabels = ['连接对端', '对比差异', '同步所选', '重启服务'];

const cols = [
  { title: '文件路径', key: 'path', minWidth: 260 },
  { title: '差异', slot: 'diff', width: 90 },
  { title: '本地版本', key: 'local', width: 110 },
  { title: '对端版本', key: 'remote', width: 110 },
  { title: '体积', key: 'size', width: 90 },
  { title: '操作', slot: 'action', width: 100 },
];

const planText = computed(() => (planResult.value ? JSON.stringify(planResult.value, null, 2) : ''));
const diffRows = computed(() => {
  const r = planResult.value || {};
  const files = r.files || r.diff || r.items || [];
  if (Array.isArray(files) && files.length) {
    return files.map((f) => ({
      path: f.path || f.file || f.name || '—',
      kind: f.kind || f.status || (f.conflict ? '冲突' : f.added ? '新增' : '修改'),
      local: f.local || f.localMtime || '—',
      remote: f.remote || f.remoteMtime || '—',
      size: f.sizeText || f.size || '—',
    }));
  }
  return [];
});
const counts = computed(() => {
  const rows = diffRows.value;
  return {
    add: rows.filter((r) => String(r.kind).includes('增')).length,
    mod: rows.filter((r) => String(r.kind).includes('改')).length,
    conflict: rows.filter((r) => String(r.kind).includes('冲')).length,
    extra: rows.filter((r) => String(r.kind).includes('多')).length,
  };
});
const syncableCount = computed(() => Math.max(0, diffRows.value.length - counts.value.conflict));
const conflictCount = computed(() => counts.value.conflict);

function showTokenHint() {
  Message.info('同步口令可在系统设置中查看');
}
function diffColor(kind) {
  if (String(kind).includes('冲')) return 'error';
  if (String(kind).includes('增')) return 'success';
  return 'blue';
}
function showDiff(row) {
  Modal.info({ title: row.path, content: `本地：${row.local}<br/>对端：${row.remote}` });
}
async function plan() {
  planning.value = true;
  try {
    planResult.value = await api.codesyncPlan(host.value.trim());
    step.value = 2;
    Message.success('对比完成');
  } catch (e) {
    Message.error(e.message);
  } finally {
    planning.value = false;
  }
}
function pull() {
  Modal.confirm({
    title: '确认同步',
    content: '将覆盖本机程序文件（会先备份）。同步后请重启服务。',
    onOk: async () => {
      pulling.value = true;
      try {
        const r = await api.codesyncPull(host.value.trim());
        step.value = 4;
        Message.success(r.message || '同步完成，请重启服务');
      } catch (e) {
        Message.error(e.message);
      } finally {
        pulling.value = false;
      }
    },
  });
}
</script>

<style scoped lang="scss">
.page-head { display:flex; justify-content:space-between; margin-bottom:14px; }
.page-head h2 { margin:0; font-size:20px; }
.desc { margin:4px 0 0; color:#6b7684; font-size:13px; }
.steps { display:flex; gap:10px; margin-bottom:14px; }
.step {
  flex:1; background:#fff; border:1px solid #eef1f6; border-radius:10px; padding:10px 12px;
  color:#8b95a3; font-size:13px; display:flex; align-items:center; gap:8px;
  &.on { border-color:#d6e6fb; color:#2d8cf0; background:#f5f9ff; }
}
.n {
  width:22px; height:22px; border-radius:50%; background:#eef1f6; display:grid; place-items:center; font-size:12px;
}
.step.on .n { background:#2d8cf0; color:#fff; }
.panel { background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:16px; min-height:420px; }
.sec-title { font-weight:600; margin-bottom:12px; display:flex; align-items:center; gap:8px; }
.sec-head { display:flex; justify-content:space-between; margin:8px 0 10px; }
.tip { font-size:12px; color:#8b95a3; }
.stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:12px; }
.stats div { background:#f8fafc; border-radius:8px; padding:10px; text-align:center; }
.stats b { display:block; font-size:20px; }
.stats span { font-size:12px; color:#8b95a3; }
.warn { color:#ed4014; }
.plan { margin-top:12px; background:#0f172a; color:#e2e8f0; padding:12px; border-radius:8px; max-height:180px; overflow:auto; font-size:11px; }
</style>
