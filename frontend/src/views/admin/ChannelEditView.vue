<template>
  <div v-if="channel" class="edit-page">
    <div class="page-head">
      <div>
        <div class="crumb">
          <a @click="$router.push('/admin/channels')">通道列表</a>
          <span>/</span>
          <b>编辑通道 · {{ channel.name || '未命名' }}</b>
          <Tag v-if="dirty" color="orange" size="small">有未保存修改</Tag>
        </div>
      </div>
      <div class="actions">
        <Button :loading="testingVideo" @click="testVideo">试一段</Button>
        <Button :loading="testing" @click="testImage">试一张</Button>
        <Button type="primary" :loading="saving" @click="save">保存</Button>
      </div>
    </div>

    <Tabs v-model="tab">
      <TabPane label="基础配置" name="basic">
        <div class="panel">
          <div class="panel-title">
            <div>
              <b>通道 URL、密钥与启用状态</b>
            </div>
            <div class="enable">
              <span>启用通道</span>
              <i-switch v-model="channel.enabled" @on-change="markDirty" />
            </div>
          </div>
          <Form :label-width="120" class="form">
            <FormItem label="通道名称">
              <Input v-model="channel.name" @on-change="markDirty" />
            </FormItem>
            <FormItem label="类型（决定前台匹配）">
              <RadioGroup v-model="channelKind" type="button" @on-change="markDirty">
                <Radio label="image">图像</Radio>
                <Radio label="video">视频</Radio>
                <Radio label="audio">音频</Radio>
              </RadioGroup>
            </FormItem>
            <FormItem label="Base URL">
              <Input v-model="channel.baseUrl" placeholder="https://api.xxx.com" @on-change="markDirty" />
              <div class="tip">不含 /v1 路径后缀</div>
            </FormItem>
            <FormItem label="API Key">
              <div class="key-row">
                <Input v-model="channel.apiKey" :type="showKey ? 'text' : 'password'" @on-change="markDirty" />
                <Button @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</Button>
                <Button @click="channel.apiKey = ''; markDirty()">替换</Button>
              </div>
              <div class="tip" v-if="channel.checkText">{{ channel.checkText }}</div>
            </FormItem>
            <FormItem label="备注">
              <Input v-model="channel.note" type="textarea" :rows="2" @on-change="markDirty" />
            </FormItem>
            <FormItem label="排序">
              <InputNumber v-model="channel.sort" :min="0" @on-change="markDirty" />
              <div class="tip">数值越小优先级越高</div>
            </FormItem>
            <FormItem label="前台默认通道">
              <Checkbox v-model="channel.isDefault" @on-change="markDirty">设为{{ kindLabel }}类默认</Checkbox>
            </FormItem>
          </Form>
        </div>
      </TabPane>

      <TabPane label="模型清单" name="models">
        <div class="panel">
          <div class="panel-title">
            <b>拉取或粘贴 → 归类 → 指定默认</b>
            <Space>
              <Button :loading="probing" @click="probe">拉取模型</Button>
              <Button @click="pasteMode = !pasteMode">粘贴清单</Button>
            </Space>
          </div>
          <Alert v-if="pasteMode" type="info" show-icon style="margin-bottom:12px">
            每行一个模型，格式：模型id 或 模型id | 显示名。按类型分别粘贴到下方文本框。
          </Alert>
          <div v-if="pasteMode" class="paste-grid">
            <div>
              <div class="label">图片模型</div>
              <Input v-model="imageModelsText" type="textarea" :rows="6" @on-change="markDirty" />
            </div>
            <div>
              <div class="label">视频模型</div>
              <Input v-model="videoModelsText" type="textarea" :rows="6" @on-change="markDirty" />
            </div>
            <div>
              <div class="label">音频模型</div>
              <Input v-model="audioModelsText" type="textarea" :rows="4" @on-change="markDirty" />
            </div>
          </div>
          <Table v-else :columns="modelCols" :data="modelRows">
            <template #cap="{ row }">{{ row.cap || '—' }}</template>
            <template #def="{ row }">
              <Tag v-if="isDefaultModel(row)" color="blue">默认</Tag>
              <a v-else @click="setDefault(row)">设为默认</a>
            </template>
            <template #action="{ row }">
              <a @click="testModel(row)">测试</a>
              <Divider type="vertical" />
              <a @click="removeModel(row)" class="danger">移除</a>
            </template>
          </Table>
          <div class="model-foot">
            {{ modelRows.length }} 个模型
            <Button size="small" @click="addModel">手动添加模型</Button>
          </div>
          <Form :label-width="100" style="margin-top:12px">
            <FormItem label="默认图片"><Input v-model="channel.defaults.image" @on-change="markDirty" /></FormItem>
            <FormItem label="默认视频"><Input v-model="channel.defaults.video" @on-change="markDirty" /></FormItem>
            <FormItem label="默认音频"><Input v-model="channel.defaults.audio" @on-change="markDirty" /></FormItem>
          </Form>
        </div>
      </TabPane>

      <TabPane label="高级参数" name="advanced">
        <div class="panel">
          <div class="panel-title">
            <b>鉴权模板、异步轮询、尺寸映射、参考图上传与超时</b>
            <Button size="small" @click="resetAdvanced">恢复默认</Button>
          </div>
          <Input v-model="advancedJson" type="textarea" :rows="18" class="mono" @on-change="markDirty" />
        </div>
      </TabPane>
    </Tabs>

    <Modal v-model="showResult" :title="`试一张 · ${channel.name}`" width="720" footer-hide>
      <div class="result-body" v-if="testResultUrl || testMessage">
        <div class="left">
          <img v-if="testResultUrl" :src="testResultUrl" alt="试一张" />
          <div v-else class="empty">暂无预览图</div>
          <div class="meta-tags">
            <span>种子 {{ testMeta.seed || '—' }}</span>
            <a v-if="testResultUrl" :href="testResultUrl" target="_blank">下载</a>
          </div>
          <div class="prompt-box">
            <div class="row"><span class="muted">测试提示词</span></div>
            <div>{{ testPrompt }}</div>
          </div>
        </div>
        <div class="right">
          <b>连接与耗时</b>
          <div class="kv"><span>HTTP 状态</span><span class="ok">{{ testMeta.status || '—' }}</span></div>
          <div class="kv"><span>总耗时</span><span>{{ testMeta.elapsed || '—' }}</span></div>
          <div class="kv"><span>本次消耗</span><span>{{ testMeta.cost || '—' }}</span></div>
          <div class="kv"><span>剩余余额</span><span class="ok">{{ balanceText || '—' }}</span></div>
          <div class="kv"><span>请求 ID</span><span>{{ testMeta.requestId || '—' }}</span></div>
          <Alert type="info" style="margin-top:12px">{{ testMessage || '通道可用，可保存配置并在前台使用。' }}</Alert>
        </div>
      </div>
      <div class="result-foot">
        <div>
          <a @click="testVideo">试一段</a>
          <a @click="checkBalance" style="margin-left:14px">查余额</a>
        </div>
        <Space>
          <Button @click="showResult = false">关闭</Button>
          <Button @click="testImage" :loading="testing">再试一次</Button>
          <Button type="primary" @click="saveAndEnable">保存并启用</Button>
        </Space>
      </div>
    </Modal>
  </div>
  <div v-else class="muted">通道不存在或已删除</div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Message } from 'view-ui-plus';
import { api } from '@/api/client';

const route = useRoute();
const channel = ref(null);
const all = ref([]);
const tab = ref('basic');
const dirty = ref(false);
const saving = ref(false);
const probing = ref(false);
const testing = ref(false);
const testingVideo = ref(false);
const showKey = ref(false);
const pasteMode = ref(false);
const showResult = ref(false);
const testResultUrl = ref('');
const testMessage = ref('');
const balanceText = ref('');
const testPrompt = ref('夜晚地铁站台，冷白顶灯，人物背对镜头，地面反光，电影感');
const testMeta = ref({});
const advancedJson = ref('');
const imageModelsText = ref('');
const videoModelsText = ref('');
const audioModelsText = ref('');
const channelKind = ref('image');

const modelCols = [
  { title: '模型 ID', key: 'id', minWidth: 180 },
  { title: '能力', slot: 'cap', minWidth: 140 },
  { title: '新建默认', slot: 'def', width: 110 },
  { title: '操作', slot: 'action', width: 120 },
];

const kindLabel = computed(() => ({ image: '图像', video: '视频', audio: '音频' }[channelKind.value] || '图像'));

const modelRows = computed(() => {
  const c = channel.value;
  if (!c) return [];
  const rows = [];
  const push = (list, kind, cap) => {
    (list || []).forEach((m) => {
      const id = typeof m === 'string' ? m : m.id;
      const label = typeof m === 'string' ? '' : m.label || '';
      rows.push({ id, label, kind, cap: label || cap });
    });
  };
  push(c.models?.image || c.imageModels, 'image', '文生图 / 图生图');
  push(c.models?.video || c.videoModels, 'video', '文生视频');
  push(c.models?.audio || c.audioModels, 'audio', '语音合成');
  return rows;
});

function markDirty() { dirty.value = true; }
function modelsToText(list) {
  return (list || [])
    .map((m) => (typeof m === 'string' ? m : m.id ? `${m.id}${m.label ? ' | ' + m.label : ''}` : ''))
    .filter(Boolean)
    .join('\n');
}
function textToModels(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|').map((s) => s.trim());
      return parts[1] ? { id: parts[0], label: parts[1] } : parts[0];
    });
}
function syncTextsFromChannel() {
  const c = channel.value;
  if (!c) return;
  if (!c.defaults) c.defaults = {};
  if (!c.models) c.models = { image: [], video: [], audio: [] };
  if (c.sort == null) c.sort = 0;
  imageModelsText.value = modelsToText(c.models.image || c.imageModels);
  videoModelsText.value = modelsToText(c.models.video || c.videoModels);
  audioModelsText.value = modelsToText(c.models.audio || c.audioModels);
  const hasI = (c.models.image || []).length || (c.imageModels || []).length;
  const hasV = (c.models.video || []).length || (c.videoModels || []).length;
  const hasA = (c.models.audio || []).length || (c.audioModels || []).length;
  channelKind.value = hasV && !hasI ? 'video' : hasA && !hasI && !hasV ? 'audio' : 'image';
  const clone = JSON.parse(JSON.stringify(c));
  delete clone.apiKey;
  advancedJson.value = JSON.stringify(clone, null, 2);
  dirty.value = false;
}
function isDefaultModel(row) {
  return channel.value?.defaults?.[row.kind] === row.id;
}
function setDefault(row) {
  if (!channel.value.defaults) channel.value.defaults = {};
  channel.value.defaults[row.kind] = row.id;
  markDirty();
}
function removeModel(row) {
  const list = channel.value.models[row.kind] || [];
  channel.value.models[row.kind] = list.filter((m) => (typeof m === 'string' ? m : m.id) !== row.id);
  syncTextsFromChannel();
  markDirty();
}
function addModel() {
  const id = window.prompt('模型 ID');
  if (!id) return;
  if (!channel.value.models[channelKind.value]) channel.value.models[channelKind.value] = [];
  channel.value.models[channelKind.value].push(id);
  syncTextsFromChannel();
  markDirty();
}
function testModel(row) {
  if (row.kind === 'video') testVideo();
  else testImage();
}
function resetAdvanced() {
  syncTextsFromChannel();
  Message.info('已恢复为当前通道字段');
}
async function load() {
  const data = await api.listChannels();
  all.value = data.channels || data || [];
  channel.value = all.value.find((c) => String(c.id) === String(route.params.id)) || null;
  syncTextsFromChannel();
}
async function save() {
  if (!channel.value) return;
  saving.value = true;
  try {
    channel.value.models = {
      image: textToModels(imageModelsText.value),
      video: textToModels(videoModelsText.value),
      audio: textToModels(audioModelsText.value),
    };
    try {
      const adv = JSON.parse(advancedJson.value || '{}');
      Object.assign(channel.value, adv, {
        id: channel.value.id,
        apiKey: channel.value.apiKey,
        models: channel.value.models,
        defaults: channel.value.defaults,
        enabled: channel.value.enabled,
        name: channel.value.name,
        baseUrl: channel.value.baseUrl,
        note: channel.value.note,
        sort: channel.value.sort,
      });
    } catch { /* keep form */ }
    const next = all.value.map((c) => (c.id === channel.value.id ? channel.value : c));
    await api.saveChannels(next);
    all.value = next;
    dirty.value = false;
    Message.success('已保存');
  } catch (e) {
    Message.error(e.message);
  } finally {
    saving.value = false;
  }
}
async function saveAndEnable() {
  channel.value.enabled = true;
  await save();
  showResult.value = false;
}
async function probe() {
  probing.value = true;
  try {
    const data = await api.probeChannel(channel.value);
    Message.success(data.message || '已拉取');
    if (data.channel) {
      channel.value = { ...channel.value, ...data.channel, apiKey: channel.value.apiKey };
      syncTextsFromChannel();
      markDirty();
    }
  } catch (e) {
    Message.error(e.message);
  } finally {
    probing.value = false;
  }
}
async function testImage() {
  testing.value = true;
  testMessage.value = '';
  try {
    const started = Date.now();
    const data = await api.testChannelImage({ channelId: channel.value.id, channel: channel.value, prompt: testPrompt.value });
    testResultUrl.value = data.url || data.thumb || data.path || '';
    testMessage.value = data.message || '通道可用，模型清单匹配，尺寸映射正确。可保存配置并在前台使用。';
    testMeta.value = {
      status: data.status || '200 OK',
      elapsed: data.elapsed || `${((Date.now() - started) / 1000).toFixed(1)}s`,
      cost: data.cost || '—',
      requestId: data.requestId || data.taskId || '—',
      seed: data.seed || '—',
    };
    showResult.value = true;
    Message.success('试一张成功');
  } catch (e) {
    testMessage.value = e.message;
    showResult.value = true;
    Message.error(e.message);
  } finally {
    testing.value = false;
  }
}
async function testVideo() {
  testingVideo.value = true;
  try {
    const data = await api.testChannelVideo({ channelId: channel.value.id, channel: channel.value });
    testMessage.value = data.message || '已提交试一段';
    Message.success(testMessage.value);
  } catch (e) {
    Message.error(e.message);
  } finally {
    testingVideo.value = false;
  }
}
async function checkBalance() {
  try {
    const data = await api.channelBalance(channel.value);
    balanceText.value = data.text || data.balance || JSON.stringify(data);
    Message.success('已查询余额');
  } catch (e) {
    Message.error(e.message);
  }
}
onMounted(() => load().catch((e) => Message.error(e.message)));
watch(() => route.params.id, () => load().catch(() => {}));
</script>

<style scoped lang="scss">
.page-head { display:flex; justify-content:space-between; gap:12px; margin-bottom:14px; align-items:center; }
.crumb { display:flex; align-items:center; gap:8px; font-size:14px; }
.crumb a { color:#2d8cf0; }
.actions { display:flex; gap:8px; }
.panel {
  background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:16px 18px; margin-top:4px;
}
.panel-title { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
.enable { display:flex; align-items:center; gap:8px; color:#6b7684; font-size:13px; }
.tip { font-size:12px; color:#8b95a3; margin-top:4px; }
.key-row { display:flex; gap:8px; }
.paste-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; margin-bottom:12px; }
.label { font-size:12px; color:#6b7684; margin-bottom:6px; }
.model-foot { display:flex; justify-content:space-between; align-items:center; margin-top:10px; color:#8b95a3; font-size:12px; }
.mono { font-family: Consolas, monospace; }
.danger { color:#ed4014; }
.result-body { display:flex; gap:16px; }
.result-body .left { width:360px; }
.result-body img { width:360px; height:220px; object-fit:cover; border-radius:8px; background:#f5f7f9; }
.empty { width:360px; height:220px; border-radius:8px; background:#f5f7f9; display:grid; place-items:center; color:#8b95a3; }
.meta-tags { display:flex; justify-content:space-between; margin:8px 0; font-size:12px; color:#5c6674; }
.prompt-box { background:#fafbfd; border:1px solid #eef1f6; border-radius:7px; padding:10px; font-size:12px; }
.prompt-box .row { display:flex; justify-content:space-between; margin-bottom:4px; }
.right { flex:1; }
.kv { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #f4f6fa; font-size:12px; color:#3f4a58; }
.kv span:first-child { color:#8b95a3; }
.ok { color:#19be6b; }
.result-foot { display:flex; justify-content:space-between; align-items:center; margin-top:16px; padding-top:12px; border-top:1px solid #eef1f6; }
.result-foot a { color:#2d8cf0; font-size:12px; }
</style>
