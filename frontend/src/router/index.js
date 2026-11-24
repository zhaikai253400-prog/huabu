import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  {
    path: '/',
    component: () => import('@/layouts/AppLayout.vue'),
    children: [
      { path: '', name: 'portal', component: () => import('@/views/app/PortalView.vue'), meta: { title: '门户' } },
      { path: 'tasks', name: 'tasks', component: () => import('@/views/app/TasksView.vue'), meta: { title: '任务中心' } },
      { path: 'settings', name: 'settings', component: () => import('@/views/app/SettingsView.vue'), meta: { title: '设置' } },
      { path: 'interactions', name: 'interactions', component: () => import('@/views/app/InteractionsView.vue'), meta: { title: '交互件规范' } },
      { path: 'schedule-demo', name: 'schedule-demo', component: () => import('@/views/app/ScheduleDemoView.vue'), meta: { title: '定时生成组' } },
      { path: 'director-demo', name: 'director-demo', component: () => import('@/views/app/DirectorDemoView.vue'), meta: { title: '3D 导演台' } },
    ],
  },
  {
    path: '/storyboard-demo',
    name: 'storyboard-demo',
    component: () => import('@/views/app/StoryboardDemoView.vue'),
    meta: { title: '分镜墙示意', bare: true },
  },
  {
    path: '/canvas/:id',
    name: 'canvas',
    component: () => import('@/views/app/CanvasWorkbench.vue'),
    meta: { title: '画布工作台', bare: true },
  },
  {
    path: '/admin/login',
    name: 'admin-login',
    component: () => import('@/views/admin/LoginView.vue'),
    meta: { title: '后台登录' },
  },
  {
    path: '/admin',
    component: () => import('@/layouts/AdminLayout.vue'),
    meta: { requiresAdmin: true },
    children: [
      { path: '', name: 'admin-dashboard', component: () => import('@/views/admin/DashboardView.vue'), meta: { title: '仪表盘' } },
      { path: 'channels', name: 'admin-channels', component: () => import('@/views/admin/ChannelsView.vue'), meta: { title: '通道管理' } },
      { path: 'channels/:id', name: 'admin-channel-edit', component: () => import('@/views/admin/ChannelEditView.vue'), meta: { title: '通道编辑' } },
      { path: 'models', name: 'admin-models', component: () => import('@/views/admin/ModelsView.vue'), meta: { title: '模型默认' } },
      { path: 'tasks', name: 'admin-tasks', component: () => import('@/views/admin/AdminTasksView.vue'), meta: { title: '任务监控' } },
      { path: 'storage', name: 'admin-storage', component: () => import('@/views/admin/StorageView.vue'), meta: { title: '存储管理' } },
      { path: 'recycle', name: 'admin-recycle', component: () => import('@/views/admin/RecycleView.vue'), meta: { title: '备份回收站' } },
      { path: 'logs', name: 'admin-logs', component: () => import('@/views/admin/LogsView.vue'), meta: { title: '日志' } },
      { path: 'settings', name: 'admin-settings', component: () => import('@/views/admin/AdminSettingsView.vue'), meta: { title: '系统设置' } },
      { path: 'codesync', name: 'admin-codesync', component: () => import('@/views/admin/CodesyncView.vue'), meta: { title: '代码同步' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  document.title = (to.meta.title ? `${to.meta.title} · ` : '') + '本地无限画布';
  if (to.meta.requiresAdmin || to.matched.some((r) => r.meta.requiresAdmin)) {
    const session = localStorage.getItem('adminSession');
    if (!session && to.name !== 'admin-login') {
      return { name: 'admin-login', query: { redirect: to.fullPath } };
    }
  }
  return true;
});

export default router;
