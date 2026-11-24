<template>
  <div>
    <div class="page-head">
      <div>
        <h2>模型默认</h2>
        <p class="desc">决定前台新建卡片时预填的模型与参数</p>
      </div>
      <Space>
        <Button @click="resetDefaults">恢复默认</Button>
        <Button type="primary" :loading="saving" @click="save">保存</Button>
      </Space>
    </div>

    <div class="panel">
      <div class="sec-title">新建默认模型</div>
      <p class="sec-desc">按卡片类型分别指定；快速视频卡默认不参与连线</p>
      <Row :gutter="14">
        <Col :span="8">
          <div class="card-box">
            <div class="card-head"><b>图片卡</b><Tag size="small">图像</Tag></div>
            <Form :label-width="90">
              <FormItem label="默认模型"><Input v-model="form.image.model" placeholder="模型 id" /></FormItem>
              <FormItem label="比例">
                <Select v-model="form.image.ratio"><Option v-for="r in ratios" :key="r" :value="r">{{ r }}</Option></Select>
              </FormItem>
              <FormItem label="质量">
                <Select v-model="form.image.size"><Option v-for="s in sizes" :key="s" :value="s">{{ s }}</Option></Select>
              </FormItem>
              <FormItem label="尾部提示词"><i-switch v-model="form.image.tail" /></FormItem>
            </Form>
          </div>
        </Col>
        <Col :span="8">
          <div class="card-box">
            <div class="card-head"><b>视频卡</b><Tag color="orange" size="small">视频</Tag></div>
            <Form :label-width="90">
              <FormItem label="默认模型"><Input v-model="form.video.model" /></FormItem>
              <FormItem label="时长"><InputNumber v-model="form.video.duration" :min="1" :max="120" /> s</FormItem>
              <FormItem label="帧率"><InputNumber v-model="form.video.fps" :min="8" :max="60" /> fps</FormItem>
              <FormItem label="分辨率">
                <Select v-model="form.video.resolution"><Option value="720P">720P</Option><Option value="1080P">1080P</Option></Select>
              </FormItem>
              <FormItem label="建议提尾帧"><i-switch v-model="form.video.suggestTail" /></FormItem>
            </Form>
          </div>
        </Col>
        <Col :span="8">
          <div class="card-box">
            <div class="card-head"><b>快速视频卡</b><Tag color="cyan" size="small">快速</Tag></div>
            <Form :label-width="90">
              <FormItem label="跟随视频"><i-switch v-model="form.quick.followVideo" /></FormItem>
              <FormItem v-if="!form.quick.followVideo" label="默认模型"><Input v-model="form.quick.model" /></FormItem>
              <FormItem label="时长">{{ form.quick.duration || 4 }}s</FormItem>
              <FormItem label="生成模式">
                <Select v-model="form.quick.mode"><Option value="text">文生视频</Option><Option value="image">图生视频</Option></Select>
              </FormItem>
              <div class="tip">默认不参与连线</div>
            </Form>
          </div>
        </Col>
      </Row>
    </div>

    <div class="panel" style="margin-top:14px">
      <div class="sec-title">尾部提示词策略</div>
      <Form :label-width="120">
        <FormItem label="追加位置">
          <RadioGroup v-model="form.tail.position">
            <Radio label="end">提示词末尾</Radio>
            <Radio label="start">提示词开头</Radio>
            <Radio label="negative">独立负向段</Radio>
          </RadioGroup>
        </FormItem>
        <FormItem label="适用卡片类型">
          <Checkbox v-model="form.tail.image">图片</Checkbox>
          <Checkbox v-model="form.tail.video" style="margin-left:12px">视频</Checkbox>
          <Checkbox v-model="form.tail.quick" style="margin-left:12px">快速视频</Checkbox>
          <Checkbox disabled style="margin-left:12px">音频（不适用）</Checkbox>
        </FormItem>
        <FormItem label="图片尾部提示词"><Input v-model="form.tail.imageText" type="textarea" :rows="3" /></FormItem>
        <FormItem label="视频尾部提示词"><Input v-model="form.tail.videoText" type="textarea" :rows="3" /></FormItem>
      </Form>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { Message } from 'view-ui-plus';
import { api } from '@/api/client';

const sizes = ['标准', '1K', '2K', '4K'];
const ratios = ['16:9', '9:16', '1:1', '4:3'];
const saving = ref(false);
const form = reactive({
  image: { model: '', size: '标准', ratio: '16:9', tail: true },
  video: { model: '', duration: 5, fps: 24, resolution: '720P', suggestTail: true },
  quick: { followVideo: true, model: '', duration: 4, mode: 'text' },
  tail: { position: 'end', image: true, video: true, quick: true, imageText: '', videoText: '' },
});

async function load() {
  const st = await api.status();
  const d = st.cardDefaults || st.settings?.cardDefaults || {};
  Object.assign(form.image, d.image || {});
  Object.assign(form.video, d.video || {});
  Object.assign(form.quick, d.quick || {});
  const t = st.tailPrompts || d.tail || {};
  form.tail.imageText = t.image || '';
  form.tail.videoText = t.video || '';
}
function resetDefaults() {
  form.image = { model: 'gemini-3-pro', size: '标准', ratio: '16:9', tail: true };
  form.video = { model: 'svd-1.1-motion', duration: 5, fps: 24, resolution: '720P', suggestTail: true };
  form.quick = { followVideo: false, model: 'kling-flash-4s', duration: 4, mode: 'text' };
  Message.info('已填入推荐默认值，请保存');
}
async function save() {
  saving.value = true;
  try {
    await api.saveSettings({
      cardDefaults: { image: form.image, video: form.video, quick: form.quick },
      tailPrompts: { image: form.tail.imageText, video: form.tail.videoText },
      tailStrategy: {
        position: form.tail.position,
        apply: { image: form.tail.image, video: form.tail.video, quick: form.tail.quick },
      },
    });
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
.page-head { display:flex; justify-content:space-between; margin-bottom:14px; }
.page-head h2 { margin:0; font-size:20px; }
.desc { margin:4px 0 0; color:#6b7684; font-size:13px; }
.panel { background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:16px 18px; }
.sec-title { font-weight:600; }
.sec-desc { color:#6b7684; font-size:13px; margin:4px 0 14px; }
.card-box { background:#f8fafc; border:1px solid #eef1f6; border-radius:10px; padding:14px; min-height:280px; }
.card-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.tip { font-size:12px; color:#8b95a3; }
</style>
