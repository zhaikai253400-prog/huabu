<template>
  <div class="admin-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="logo">管</span>
        <div>
          <div class="t1">无限画布</div>
          <div class="t2">管理后台</div>
        </div>
      </div>
      <div class="group">工作台</div>
      <RouterLink class="item" to="/admin" exact-active-class="active">仪表盘</RouterLink>
      <RouterLink class="item" to="/admin/channels" active-class="active">
        通道管理 <span v-if="channelCount" class="badge">{{ channelCount }}</span>
      </RouterLink>
      <RouterLink class="item" to="/admin/models" active-class="active">模型默认</RouterLink>
      <RouterLink class="item" to="/admin/tasks" active-class="active">
        任务监控 <span v-if="running" class="badge">{{ running }}</span>
      </RouterLink>
      <div class="group">数据与安全</div>
      <RouterLink class="item" to="/admin/storage" active-class="active">存储管理</RouterLink>
      <RouterLink class="item" to="/admin/recycle" active-class="active">备份回收站</RouterLink>
      <RouterLink class="item" to="/admin/logs" active-class="active">日志</RouterLink>
      <RouterLink class="item" to="/admin/settings" active-class="active">系统设置</RouterLink>
      <RouterLink class="item" to="/admin/codesync" active-class="active">代码同步</RouterLink>
      <div class="foot">
        <div class="status"><i />服务运行中 <b>{{ port }}</b></div>
        <Button long size="small" @click="$router.push('/')">进入前台</Button>
      </div>
    </aside>
    <div class="main">
      <header class="top">
        <div class="crumb">
          <Icon type="ios-home-outline" />
          <b>{{ $route.meta.title || '仪表盘' }}</b>
          <span class="muted">本机时段 · 今日统计自 00:00 起</span>
        </div>
        <div class="tools">
          <span class="port">127.0.0.1:{{ port }}</span>
          <Button size="small" @click="$router.push('/')">前台</Button>
          <Button size="small" type="error" ghost @click="onLogout">退出</Button>
        </div>
      </header>
      <div class="content"><router-view /></div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { useAdminStore } from '@/stores/admin';
import { api } from '@/api/client';

const router = useRouter();
const app = useAppStore();
const admin = useAdminStore();
const channelCount = ref(0);
const running = ref(0);
const port = computed(() => app.status?.port || location.port || '17890');

async function onLogout() {
  await admin.logout();
  router.push('/admin/login');
}
onMounted(async () => {
  await app.refreshStatus().catch(() => {});
  try {
    const ch = await api.listChannels();
    channelCount.value = (ch.channels || ch || []).length;
  } catch { /* ignore */ }
  try {
    const dash = await api.adminDashboard();
    running.value = dash.running || 0;
  } catch { /* ignore */ }
});
</script>

<style scoped lang="scss">
.admin-shell { display: flex; height: 100%; background: #f5f7f9; }
.sidebar {
  width: 208px; background: #1a2230; color: #dfe7f4; display: flex; flex-direction: column; padding: 16px 12px;
}
.brand { display: flex; gap: 10px; align-items: center; padding: 4px 6px 12px; }
.logo {
  width: 32px; height: 32px; border-radius: 8px; background: #2d8cf0; display: grid; place-items: center; font-weight: 700; color: #fff;
}
.t1 { font-weight: 700; } .t2 { font-size: 12px; color: #7c8ba1; }
.group { font-size: 12px; color: #7c8ba1; padding: 14px 10px 6px; }
.item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 12px; border-radius: 8px; color: #c5d0e0; margin-bottom: 2px;
  &.active, &:hover { background: rgba(255,255,255,.08); color: #fff; }
}
.badge {
  min-width: 18px; height: 18px; border-radius: 9px; background: #2d8cf0; color: #fff;
  font-size: 11px; display: inline-grid; place-items: center; padding: 0 5px;
}
.foot { margin-top: auto; padding: 10px; }
.status { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 10px; color: #9aa8bd; }
.status i { width: 6px; height: 6px; border-radius: 50%; background: #19be6b; display: inline-block; }
.status b { margin-left: auto; color: #7fb6f2; font-weight: 500; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.top {
  height: 56px; background: #fff; border-bottom: 1px solid #eef1f6;
  display: flex; align-items: center; justify-content: space-between; padding: 0 24px;
}
.crumb { display: flex; align-items: center; gap: 10px; }
.tools { display: flex; gap: 10px; align-items: center; }
.port { font-size: 12px; color: #6b7684; background: #f5f7f9; border-radius: 6px; padding: 4px 8px; }
.content { flex: 1; overflow: auto; padding: 20px 24px; }
</style>
