<template>
  <div class="wrap">
    <div class="settings-shell">
      <aside class="side">
        <div
          v-for="s in sections"
          :key="s.key"
          class="side-item"
          :class="{ active: section === s.key }"
          @click="section = s.key"
        >{{ s.label }}</div>
      </aside>

      <div class="main panel">
        <div class="hint">设置保存在本机浏览器与 data/config.json，不随画布导出。</div>

        <template v-if="section === 'appearance'">
          <h3>外观与体验</h3>
          <p class="sub">主题、界面缩放与画布显示</p>
          <Form :label-width="120">
            <FormItem label="界面主题">
              <RadioGroup v-model="form.theme">
                <Radio label="dark">深色（推荐）</Radio>
                <Radio label="light">浅色</Radio>
                <Radio label="system">跟随系统</Radio>
              </RadioGroup>
              <div class="tip">画布工作台默认深色</div>
            </FormItem>
            <FormItem label="界面缩放">
              <RadioGroup v-model="form.uiScale" type="button">
                <Radio :label="90">90%</Radio>
                <Radio :label="100">100%</Radio>
                <Radio :label="110">110%</Radio>
                <Radio :label="125">125%</Radio>
              </RadioGroup>
              <div class="tip">影响工具栏与面板密度</div>
            </FormItem>
            <FormItem label="画布显示">
              <Checkbox v-model="form.showGrid">显示背景网格</Checkbox>
              <Checkbox v-model="form.showLinks" style="margin-left:12px">显示参考连线</Checkbox>
              <Checkbox v-model="form.showParams" style="margin-left:12px">卡片内显示参数摘要</Checkbox>
            </FormItem>
          </Form>
        </template>

        <template v-else-if="section === 'assets'">
          <h3>素材目录与归档</h3>
          <Form :label-width="120">
            <FormItem label="素材根目录">
              <div class="row">
                <Input v-model="form.assetRoot" />
                <Button>更改</Button>
                <Button>打开</Button>
              </div>
              <div class="tip">更改后需重新索引</div>
            </FormItem>
            <FormItem label="自动归档">
              <Select v-model="form.archiveDays" style="width:220px">
                <Option :value="0">关闭</Option>
                <Option :value="30">30 天未引用后归档</Option>
                <Option :value="60">60 天未引用后归档</Option>
              </Select>
              <Button style="margin-left:8px">立即归档</Button>
            </FormItem>
            <FormItem label="缩略图质量">
              <RadioGroup v-model="form.thumbQuality">
                <Radio label="standard">标准 320px</Radio>
                <Radio label="hd">高清 640px</Radio>
                <Radio label="origin">原始尺寸</Radio>
              </RadioGroup>
            </FormItem>
            <FormItem label="归档方式">
              <Select v-model="form.archiveMode" style="width:260px">
                <Option value="none">直接放分类文件夹</Option>
                <Option value="date">再按日期分一层</Option>
                <Option value="canvas">再按画布名字分一层</Option>
              </Select>
            </FormItem>
          </Form>
        </template>

        <template v-else-if="section === 'defaults'">
          <h3>新建默认参数</h3>
          <p class="sub">与后台模型默认配合生效</p>
          <Form :label-width="120">
            <Divider orientation="left">图片卡</Divider>
            <FormItem label="默认模型"><Input v-model="form.imageModel" /></FormItem>
            <FormItem label="默认比例">
              <RadioGroup v-model="form.imageRatio" type="button">
                <Radio label="16:9">16:9</Radio>
                <Radio label="1:1">1:1</Radio>
                <Radio label="9:16">9:16</Radio>
              </RadioGroup>
            </FormItem>
            <Divider orientation="left">视频卡</Divider>
            <FormItem label="默认模型"><Input v-model="form.videoModel" /></FormItem>
            <FormItem label="时长 / 帧率">
              <InputNumber v-model="form.videoDuration" :min="1" :max="60" /> s
              <InputNumber v-model="form.videoFps" :min="8" :max="60" style="margin-left:12px" /> fps
            </FormItem>
            <Divider orientation="left">快速视频卡</Divider>
            <FormItem label="默认模型"><Input v-model="form.quickModel" /></FormItem>
            <FormItem label="种子策略">
              <RadioGroup v-model="form.seedMode">
                <Radio label="random">每次随机</Radio>
                <Radio label="fixed">固定种子</Radio>
              </RadioGroup>
              <InputNumber v-if="form.seedMode === 'fixed'" v-model="form.seed" style="margin-left:12px" />
            </FormItem>
          </Form>
        </template>

        <template v-else-if="section === 'tail'">
          <h3>尾部提示词预设</h3>
          <Form :label-width="100">
            <FormItem label="图片"><Input v-model="form.tailImage" type="textarea" :rows="4" /></FormItem>
            <FormItem label="视频"><Input v-model="form.tailVideo" type="textarea" :rows="4" /></FormItem>
          </Form>
        </template>

        <template v-else-if="section === 'hotkeys'">
          <h3>快捷键</h3>
          <Table :columns="hotkeyCols" :data="hotkeys" size="small" />
        </template>

        <template v-else>
          <h3>关于与版本</h3>
          <div class="about">
            <div class="kv"><span>版本</span><b>V1.0.0</b></div>
            <div class="kv"><span>运行环境</span><span>Vue3 + View UI Plus · Node</span></div>
            <div class="kv"><span>本机地址</span><span>{{ portLabel }}</span></div>
          </div>
        </template>

        <div class="foot" v-if="section !== 'about' && section !== 'hotkeys'">
          <Button type="primary" :loading="saving" @click="save">保存设置</Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { Message } from 'view-ui-plus';
import { api } from '@/api/client';
import { useAppStore } from '@/stores/app';

const app = useAppStore();
const saving = ref(false);
const section = ref('appearance');
const sections = [
  { key: 'appearance', label: '外观与体验' },
  { key: 'assets', label: '素材目录与归档' },
  { key: 'hotkeys', label: '快捷键' },
  { key: 'defaults', label: '新建默认参数' },
  { key: 'tail', label: '尾部提示词预设' },
  { key: 'about', label: '关于与版本' },
];
const form = reactive({
  theme: 'dark',
  uiScale: 100,
  showGrid: true,
  showLinks: true,
  showParams: true,
  assetRoot: '',
  archiveDays: 30,
  archiveMode: 'none',
  thumbQuality: 'standard',
  imageModel: '',
  imageRatio: '16:9',
  videoModel: '',
  videoDuration: 5,
  videoFps: 24,
  quickModel: '',
  seedMode: 'random',
  seed: 88231,
  tailImage: '',
  tailVideo: '',
  submitCompress: true,
});
const hotkeyCols = [
  { title: '操作', key: 'action' },
  { title: '快捷键', key: 'key' },
];
const hotkeys = [
  { action: '保存画布', key: 'Ctrl + S' },
  { action: '新建图片卡', key: 'I' },
  { action: '新建视频卡', key: 'V' },
  { action: '适应画布', key: 'F' },
  { action: '打开素材库', key: 'L' },
];
const portLabel = computed(() => app.status?.url?.replace(/^https?:\/\//, '') || `127.0.0.1:${app.status?.port || location.port || '17890'}`);

async function load() {
  const st = await api.status();
  Object.assign(form, {
    theme: st.theme || app.theme || 'dark',
    uiScale: st.uiScale || 100,
    assetRoot: st.assetRoot || '',
    archiveMode: st.archiveMode || 'none',
    submitCompress: st.submitCompress !== false,
    imageModel: st.cardDefaults?.image?.model || '',
    imageRatio: st.cardDefaults?.image?.ratio || '16:9',
    videoModel: st.cardDefaults?.video?.model || '',
    videoDuration: st.cardDefaults?.video?.duration || 5,
    quickModel: st.cardDefaults?.quick?.model || '',
    tailImage: st.tailPrompts?.image || '',
    tailVideo: st.tailPrompts?.video || '',
  });
}
async function save() {
  saving.value = true;
  try {
    await api.saveSettings({
      theme: form.theme === 'system' ? 'light' : form.theme,
      uiScale: form.uiScale,
      assetRoot: form.assetRoot,
      archiveMode: form.archiveMode,
      submitCompress: form.submitCompress,
      showGrid: form.showGrid,
      showLinks: form.showLinks,
      showParams: form.showParams,
      cardDefaults: {
        image: { model: form.imageModel, ratio: form.imageRatio },
        video: { model: form.videoModel, duration: form.videoDuration, fps: form.videoFps },
        quick: { model: form.quickModel },
      },
      tailPrompts: { image: form.tailImage, video: form.tailVideo },
    });
    if (form.theme !== 'system') app.setTheme(form.theme);
    Message.success('已保存');
  } catch (e) {
    Message.error(e.message);
  } finally {
    saving.value = false;
  }
}
onMounted(() => load().catch(() => {}));
</script>

<style scoped lang="scss">
.wrap { padding: 28px 48px 40px; }
.settings-shell { display:flex; gap:16px; align-items:flex-start; }
.side {
  width: 200px; background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:10px; position:sticky; top:80px;
}
.side-item {
  padding:10px 12px; border-radius:8px; color:#6b7684; cursor:pointer; margin-bottom:2px; font-size:13px;
  &.active, &:hover { background:#eef5ff; color:#2d8cf0; font-weight:600; }
}
.panel { flex:1; background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:22px 26px; min-height:560px; }
.hint { font-size:12px; color:#8b95a3; margin-bottom:16px; }
h3 { margin:0 0 4px; }
.sub { margin:0 0 16px; color:#6b7684; font-size:13px; }
.tip { font-size:12px; color:#8b95a3; margin-top:4px; }
.row { display:flex; gap:8px; }
.foot { margin-top:20px; padding-top:16px; border-top:1px solid #eef1f6; }
.about .kv { display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #f4f6fa; }
</style>
