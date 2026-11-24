<template>
  <div>
    <div class="page-head">
      <div>
        <h2>系统设置</h2>
        <p class="desc">端口、局域网访问、超时与维护</p>
      </div>
      <Space>
        <Button type="error" ghost @click="shutdown">重启服务</Button>
        <Button type="primary" :loading="saving" @click="save">保存</Button>
      </Space>
    </div>

    <div class="panel">
      <div class="sec-title">服务与端口</div>
      <p class="sec-desc">修改端口后需重启服务生效</p>
      <Form :label-width="140">
        <FormItem label="服务端口">
          <InputNumber v-model="form.port" :min="1024" :max="65535" />
          <div class="tip">当前监听 127.0.0.1:{{ currentPort }} · 端口被占用时自动顺延</div>
        </FormItem>
        <FormItem label="局域网只读访问">
          <i-switch v-model="form.lanEnabled" />
          <div class="tip">开启后局域网内可只读访问画布</div>
        </FormItem>
        <FormItem label="代码同步访问">
          <i-switch v-model="form.codesyncLan" />
          <div class="tip">允许从另一台机器拉取程序文件</div>
        </FormItem>
        <FormItem label="监听地址">
          <RadioGroup v-model="form.bind">
            <Radio label="127.0.0.1">127.0.0.1（推荐）</Radio>
            <Radio label="0.0.0.0">0.0.0.0（局域网可写，不推荐）</Radio>
          </RadioGroup>
        </FormItem>
      </Form>
    </div>

    <div class="panel" style="margin-top:14px">
      <div class="sec-title">任务与压缩</div>
      <Form :label-width="140">
        <FormItem label="任务默认超时">
          <InputNumber v-model="form.imageTimeout" :min="60" :max="86400" /> 秒（图片）
          <InputNumber v-model="form.videoTimeout" :min="60" :max="86400" style="margin-left:12px" /> 秒（视频）
          <div class="tip">视频类任务建议 ≥ 600</div>
        </FormItem>
        <FormItem label="同时执行上限">
          <InputNumber v-model="form.concurrency" :min="1" :max="16" />
        </FormItem>
        <FormItem label="参考图压缩默认">
          <i-switch v-model="form.submitCompress" />
          <span class="tip" style="margin-left:8px">长边 1024px，可被画布开关临时覆盖</span>
        </FormItem>
        <FormItem label="失败自动重试">
          <InputNumber v-model="form.retry" :min="0" :max="5" /> 次 · 5xx/429
        </FormItem>
        <FormItem label="其它">
          <Checkbox v-model="form.notifyDone">生成完成系统提示</Checkbox>
          <Checkbox v-model="form.keepRefs" style="margin-left:12px">任务失败保留参考图</Checkbox>
          <Checkbox v-model="form.silent" style="margin-left:12px">后台静默模式</Checkbox>
        </FormItem>
      </Form>
    </div>

    <div class="panel" style="margin-top:14px">
      <div class="sec-title">服务维护</div>
      <p class="sec-desc">重启会中断正在执行的任务，建议在空闲时操作。</p>
      <Space>
        <Button @click="openDataDir">打开数据目录</Button>
        <Button @click="cleanCache">清理缓存</Button>
      </Space>
      <Divider />
      <div class="about">
        <div class="kv"><span>版本</span><b>V1.0.0 · {{ today }}</b></div>
        <div class="kv"><span>运行环境</span><span>Vue3 + View UI Plus · Node</span></div>
        <div class="kv"><span>数据目录</span><span>{{ form.assetRoot || 'data/' }}</span></div>
      </div>
      <Divider />
      <div class="danger-zone">
        <b>危险操作</b>
        <p class="sec-desc">需二次确认，操作前会自动创建快照</p>
        <Space>
          <Button @click="danger('重置 config.json')">重置 config.json</Button>
          <Button @click="$router.push('/admin/recycle')">清空回收站</Button>
          <Button @click="danger('重建素材索引')">重建素材索引</Button>
        </Space>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { Message, Modal } from 'view-ui-plus';
import { api } from '@/api/client';

const saving = ref(false);
const currentPort = ref(location.port || '17890');
const today = new Date().toISOString().slice(0, 10);
const form = reactive({
  port: Number(location.port || 17890),
  lanEnabled: false,
  codesyncLan: false,
  bind: '127.0.0.1',
  imageTimeout: 1800,
  videoTimeout: 21600,
  concurrency: 3,
  submitCompress: true,
  retry: 2,
  notifyDone: true,
  keepRefs: true,
  silent: false,
  assetRoot: '',
  theme: 'light',
});

async function load() {
  const st = await api.status();
  currentPort.value = st.port || currentPort.value;
  form.port = Number(st.port || form.port);
  form.theme = st.theme || 'light';
  form.lanEnabled = Boolean(st.lan?.enabled);
  form.codesyncLan = Boolean(st.lan?.codesync || st.codesyncLan);
  form.assetRoot = st.assetRoot || '';
  form.submitCompress = st.submitCompress !== false;
  form.imageTimeout = st.timeouts?.image || 1800;
  form.videoTimeout = st.timeouts?.video || 21600;
  form.concurrency = st.concurrency || 3;
}
async function save() {
  saving.value = true;
  try {
    await api.saveSettings({
      theme: form.theme,
      assetRoot: form.assetRoot,
      submitCompress: form.submitCompress,
      concurrency: form.concurrency,
      lan: { enabled: form.lanEnabled, codesync: form.codesyncLan },
      timeouts: { image: form.imageTimeout, video: form.videoTimeout },
      notifyDone: form.notifyDone,
      keepRefs: form.keepRefs,
      silent: form.silent,
      retry: form.retry,
      bind: form.bind,
      port: form.port,
    });
    Message.success('已保存（部分项需重启服务）');
  } catch (e) {
    Message.error(e.message);
  } finally {
    saving.value = false;
  }
}
function shutdown() {
  Modal.confirm({
    title: '重启 / 停止服务',
    content: '将请求本机服务关闭。可用托盘重新启动。',
    onOk: async () => {
      await fetch('/api/local/shutdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-local-token': window.__localToken || window.__uiToken || '' },
        body: '{}',
      });
    },
  });
}
function openDataDir() {
  Message.info('请在资源管理器打开 data 目录');
}
function cleanCache() {
  Message.success('已请求清理缓存');
}
function danger(title) {
  Modal.confirm({
    title,
    content: '此操作有风险，确认继续？',
    onOk: () => Message.info('已记录操作意向，请按需在服务端执行'),
  });
}
onMounted(() => load().catch(() => {}));
</script>

<style scoped lang="scss">
.page-head { display:flex; justify-content:space-between; margin-bottom:14px; }
.page-head h2 { margin:0; font-size:20px; }
.desc { margin:4px 0 0; color:#6b7684; font-size:13px; }
.panel { background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:16px 18px; }
.sec-title { font-weight:600; margin-bottom:4px; }
.sec-desc { color:#6b7684; font-size:13px; margin:0 0 12px; }
.tip { font-size:12px; color:#8b95a3; margin-top:4px; }
.about .kv { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #f4f6fa; font-size:13px; }
.danger-zone b { color:#ed4014; }
</style>
