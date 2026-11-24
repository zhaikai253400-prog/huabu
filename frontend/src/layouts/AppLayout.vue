<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="left">
        <div class="brand" @click="$router.push('/')">
          <span class="logo">画</span>
          <strong>本地无限画布</strong>
          <span class="ver">V1.0 · LOCAL</span>
        </div>
        <nav class="nav">
          <RouterLink class="nav-item" to="/" :class="{ active: $route.path === '/' }">
            <Icon type="ios-home-outline" />门户
          </RouterLink>
          <a class="nav-item" href="javascript:;" @click="app.openLibrary()">
            <Icon type="ios-folder-outline" />素材库
          </a>
          <RouterLink class="nav-item" to="/tasks" active-class="active">
            <Icon type="ios-list-box-outline" />任务中心
          </RouterLink>
          <RouterLink class="nav-item" to="/settings" active-class="active">
            <Icon type="ios-settings-outline" />设置
          </RouterLink>
          <RouterLink class="nav-item" to="/schedule-demo" active-class="active">定时组</RouterLink>
          <RouterLink class="nav-item" to="/director-demo" active-class="active">导演台</RouterLink>
          <RouterLink class="nav-item" to="/interactions" active-class="active">交互件</RouterLink>
          <RouterLink class="nav-item" to="/storyboard-demo" active-class="active">分镜墙</RouterLink>
        </nav>
      </div>
      <div class="right">
        <span class="port"><Icon type="ios-laptop-outline" /> {{ portLabel }}</span>
        <button class="icon-btn" title="主题" @click="toggleTheme"><Icon type="ios-moon-outline" /></button>
        <button class="icon-btn" title="通知"><Icon type="ios-notifications-outline" /></button>
        <i class="divider" />
        <Button type="primary" size="small" icon="ios-construct-outline" @click="$router.push('/admin')">进入后台</Button>
        <div class="avatar">本机</div>
      </div>
    </header>
    <main class="page">
      <router-view />
    </main>
    <LibraryDrawer v-model="app.libraryOpen" />
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { useAppStore } from '@/stores/app';
import LibraryDrawer from '@/components/LibraryDrawer.vue';

const app = useAppStore();
const portLabel = computed(() => app.status?.url?.replace(/^https?:\/\//, '') || `127.0.0.1:${app.status?.port || location.port || '17890'}`);
function toggleTheme() {
  app.setTheme(app.theme === 'dark' ? 'light' : 'dark');
}
onMounted(() => {
  app.refreshStatus().catch(() => {});
  app.refreshHealth().catch(() => {});
  app.setTheme(app.theme);
});
</script>

<style scoped lang="scss">
.app-shell { min-height: 100%; background: #f5f7f9; display: flex; flex-direction: column; }
.topbar {
  height: 64px; background: #fff; border-bottom: 1px solid #eef1f6;
  display: flex; align-items: center; justify-content: space-between; padding: 0 32px; position: sticky; top: 0; z-index: 30;
}
.left, .right, .brand, .nav { display: flex; align-items: center; }
.left { gap: 36px; }
.brand { gap: 10px; cursor: pointer; }
.logo {
  width: 34px; height: 34px; border-radius: 10px; background: #2d8cf0; color: #fff;
  display: grid; place-items: center; font-weight: 700; font-size: 15px;
}
.brand strong { font-size: 16px; color: #101828; }
.ver {
  font-size: 11px; color: #8b95a3; background: #f5f7f9; border: 1px solid #eef1f6;
  border-radius: 999px; padding: 2px 8px; margin-left: 2px;
}
.nav { gap: 4px; }
.nav-item {
  height: 32px; padding: 0 14px; border-radius: 8px; color: #6b7684;
  display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
  &.active, &:hover { background: #eef5ff; color: #2d8cf0; }
}
.right { gap: 10px; }
.port {
  height: 28px; display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: #6b7684; background: #f5f7f9; border-radius: 6px; padding: 0 10px;
}
.icon-btn {
  width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: #6b7684; cursor: pointer;
  display: grid; place-items: center;
  &:hover { background: #f5f7f9; color: #2d8cf0; }
}
.divider { width: 1px; height: 22px; background: #e5eaf2; display: inline-block; margin: 0 4px; }
.avatar {
  width: 34px; height: 34px; border-radius: 50%; background: #e8eef8; color: #2d8cf0;
  display: grid; place-items: center; font-size: 12px; font-weight: 600;
}
.page { flex: 1; min-height: 0; }
</style>
