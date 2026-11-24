<template>
  <div class="login-page">
    <div class="left">
      <div class="top">
        <div class="brand-row">
          <div class="logo">画</div>
          <div>
            <div class="brand-name">本地无限画布</div>
            <div class="brand-sub">LOCAL CANVAS · V1.0</div>
          </div>
          <span class="pill">本机绿色版</span>
        </div>

        <div class="hero">
          <div class="hero-title">无限画布</div>
          <div class="hero-sub">管理后台</div>
          <p class="hero-desc">
            通道与模型、任务监控、存储与备份、日志与代码同步 —— 全部在这台机器上完成，不依赖云端账号。
          </p>
        </div>

        <div class="feats">
          <div v-for="f in feats" :key="f.title" class="feat">
            <div class="feat-ico">{{ f.icon }}</div>
            <div>
              <div class="feat-t">{{ f.title }}</div>
              <div class="feat-d">{{ f.desc }}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="left-foot">
        <span>127.0.0.1:{{ port }}</span>
        <span>{{ dataDir }}</span>
        <span>口令仅保存在本机</span>
      </div>
    </div>

    <div class="right">
      <div class="form-wrap">
        <div class="form-head">
          <div class="form-title"><Icon type="md-lock" /> 管理员解锁</div>
          <p>本机模式无需云账号，输入启动时生成的管理口令即可进入后台。</p>
        </div>

        <div class="field">
          <div class="label-row">
            <span>管理口令 <i>*</i></span>
            <span class="hint">6 位以上字符</span>
          </div>
          <Input
            v-model="password"
            :type="show ? 'text' : 'password'"
            size="large"
            placeholder="请输入管理口令"
            @on-enter="submit"
          >
            <template #prefix><Icon type="ios-key-outline" /></template>
            <template #suffix>
              <Icon :type="show ? 'ios-eye-off-outline' : 'ios-eye-outline'" @click="show = !show" style="cursor:pointer" />
            </template>
          </Input>
        </div>

        <div class="assist">
          <label class="remember">
            <Checkbox v-model="remember" /> 30 天内记住本机
          </label>
          <a class="link" @click="fillDefault">忘记口令？</a>
        </div>

        <Alert v-if="error" type="error" show-icon style="margin-bottom:12px">{{ error }}</Alert>

        <Button type="primary" long size="large" :loading="loading" class="unlock" @click="submit">
          <Icon type="md-unlock" /> 解锁进入后台
        </Button>

        <div class="alt">
          <Button long @click="$router.push('/')">返回前台创作端</Button>
          <Button long @click="openDataHint">打开数据目录</Button>
        </div>

        <div class="tip">
          <div class="tip-title"><Icon type="ios-information-circle" /> 首次启动口令</div>
          <p>默认口令 <b>admin@local</b>，可在后台系统设置中修改，修改后需重新登录。</p>
          <div class="tip-row">
            <code>admin@local</code>
            <a @click="copyDefault">复制</a>
          </div>
        </div>
      </div>

      <div class="right-foot">
        <span class="online"><i />本地服务运行中 · 端口 {{ port }}</span>
        <span>V1.0 · 2026-11-24</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Message } from 'view-ui-plus';
import { useAdminStore } from '@/stores/admin';
import { useAppStore } from '@/stores/app';
import { api } from '@/api/client';

const admin = useAdminStore();
const app = useAppStore();
const router = useRouter();
const route = useRoute();
const password = ref('');
const show = ref(false);
const remember = ref(true);
const loading = ref(false);
const error = ref('');
const needSetup = ref(false);
const port = ref(location.port || '17890');
const dataDir = ref('data');

const feats = [
  { icon: '通', title: '通道管理', desc: '新建通道、填写 URL 与密钥、拉取模型清单、试一张 / 试一段' },
  { icon: '模', title: '模型默认与参数', desc: '按图 / 视频 / 快速视频分别设定新建默认，统一尾部提示词策略' },
  { icon: '任', title: '任务监控与恢复', desc: '跨画布查看任务接续信息，回收站恢复误删画布与素材' },
  { icon: '检', title: '自检与代码同步', desc: '目录 / ffmpeg / 密钥 / 端口四项自检，或从另一台机器同步程序文件' },
];

function fillDefault() {
  password.value = 'admin@local';
}
async function copyDefault() {
  try {
    await navigator.clipboard.writeText('admin@local');
    Message.success('已复制默认口令');
  } catch {
    password.value = 'admin@local';
  }
}
function openDataHint() {
  Message.info('数据目录：' + (dataDir.value || '程序目录\\data'));
}
async function submit() {
  error.value = '';
  if (!password.value || password.value.length < 6) {
    error.value = '口令至少 6 位';
    return;
  }
  loading.value = true;
  try {
    if (needSetup.value) await admin.setup(password.value);
    else await admin.login(password.value);
    if (remember.value) localStorage.setItem('adminRemember', '1');
    router.replace(route.query.redirect || '/admin');
  } catch (e) {
    error.value = e.message || '口令错误';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  try {
    const st = await admin.checkStatus();
    needSetup.value = Boolean(st.needSetup);
    const status = await api.status().catch(() => ({}));
    port.value = status.port || location.port || '17890';
    dataDir.value = status.dataDir || status.root || 'data';
    app.status = status;
    if (st.unlocked && admin.session) router.replace('/admin');
  } catch {
    needSetup.value = true;
  }
});
</script>

<style scoped lang="scss">
.login-page {
  height: 100%;
  display: grid;
  grid-template-columns: 880fr 560fr;
  background: #f5f7f9;
  min-height: 900px;
}
.left {
  background: #1a2230;
  color: #fff;
  padding: 56px 64px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.brand-row { display: flex; align-items: center; gap: 12px; }
.logo {
  width: 40px; height: 40px; border-radius: 11px; background: #fff; color: #1a2230;
  display: grid; place-items: center; font-weight: 700;
}
.brand-name { font-weight: 700; font-size: 16px; }
.brand-sub { color: #7c8ba1; font-size: 11px; margin-top: 2px; }
.pill {
  margin-left: 12px; font-size: 10.5px; color: #7fb6f2; background: #243040;
  border: 1px solid #33445c; border-radius: 5px; padding: 2px 8px;
}
.hero { margin-top: 88px; }
.hero-title { font-size: 38px; font-weight: 700; line-height: 1.37; }
.hero-sub { font-size: 38px; font-weight: 700; color: #7fb6f2; line-height: 1.37; }
.hero-desc { margin: 18px 0 0; color: #8fa0b8; font-size: 13.5px; line-height: 1.63; max-width: 520px; }
.feats { margin-top: 40px; display: flex; flex-direction: column; gap: 14px; }
.feat { display: flex; gap: 12px; align-items: flex-start; }
.feat-ico {
  width: 32px; height: 32px; border-radius: 8px; background: #243040; color: #7fb6f2;
  display: grid; place-items: center; font-size: 12px; flex-shrink: 0;
}
.feat-t { color: #dfe7f4; font-size: 12.5px; font-weight: 500; }
.feat-d { color: #7c8ba1; font-size: 11px; margin-top: 2px; line-height: 1.45; }
.left-foot {
  display: flex; gap: 20px; flex-wrap: wrap; color: #6d7c93; font-size: 11px;
}
.right {
  background: #fff;
  padding: 0 72px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.form-wrap { padding-top: 120px; display: flex; flex-direction: column; gap: 16px; }
.form-title { font-size: 20px; font-weight: 700; color: #101828; display: flex; gap: 8px; align-items: center; }
.form-title :deep(.ivu-icon) { color: #2d8cf0; }
.form-head p { margin: 8px 0 0; color: #6b7684; font-size: 12.5px; line-height: 1.52; }
.label-row { display: flex; justify-content: space-between; margin-bottom: 7px; font-size: 12px; color: #3f4a58; }
.label-row i { color: #ed4014; font-style: normal; }
.hint { color: #8b95a3; font-size: 11px; }
.assist { display: flex; justify-content: space-between; align-items: center; }
.remember { display: flex; align-items: center; gap: 7px; color: #4a5462; font-size: 12px; }
.link { color: #2d8cf0; font-size: 12px; cursor: pointer; }
.unlock { height: 44px; font-weight: 600; margin-top: 8px; }
.alt { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.tip {
  margin-top: 8px; background: #f5f9ff; border: 1px solid #d6e6fb; border-radius: 8px; padding: 12px;
}
.tip-title { color: #1f5fa8; font-size: 11.5px; font-weight: 600; display: flex; gap: 6px; align-items: center; }
.tip p { margin: 6px 0 0; color: #41607f; font-size: 11.5px; line-height: 1.57; }
.tip-row { margin-top: 8px; display: flex; gap: 8px; align-items: center; }
.tip-row code {
  background: #fff; border: 1px solid #d6e6fb; border-radius: 5px; padding: 3px 9px;
  color: #1f5fa8; font-size: 11px;
}
.tip-row a { color: #2d8cf0; font-size: 11px; cursor: pointer; }
.right-foot {
  border-top: 1px solid #eef1f6; padding: 20px 0; display: flex; justify-content: space-between;
  color: #6b7684; font-size: 11px;
}
.online { display: flex; align-items: center; gap: 6px; }
.online i { width: 6px; height: 6px; border-radius: 50%; background: #19be6b; display: inline-block; }
@media (max-width: 1200px) {
  .login-page { grid-template-columns: 1fr; }
  .left { display: none; }
  .form-wrap { padding-top: 64px; }
}
</style>
