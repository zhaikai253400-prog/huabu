import { defineStore } from 'pinia';
import { api } from '@/api/client';

export const useAdminStore = defineStore('admin', {
  state: () => ({
    session: localStorage.getItem('adminSession') || '',
    needSetup: false,
    unlocked: Boolean(localStorage.getItem('adminSession')),
    loginError: '',
  }),
  actions: {
    async checkStatus() {
      const data = await api.adminStatus();
      this.needSetup = Boolean(data.needSetup);
      this.unlocked = Boolean(data.unlocked);
      return data;
    },
    async setup(password) {
      const data = await api.adminSetup(password);
      this.applySession(data.session);
      this.needSetup = false;
      this.loginError = '';
      return data;
    },
    async login(password) {
      try {
        const data = await api.adminLogin(password);
        this.applySession(data.session);
        this.loginError = '';
        return data;
      } catch (e) {
        this.loginError = e.message || '口令错误';
        throw e;
      }
    },
    async logout() {
      try {
        await api.adminLogout();
      } catch {
        /* ignore */
      }
      this.applySession('');
    },
    applySession(session) {
      this.session = session || '';
      this.unlocked = Boolean(session);
      window.__adminSession = this.session;
      if (session) localStorage.setItem('adminSession', session);
      else localStorage.removeItem('adminSession');
    },
  },
});
