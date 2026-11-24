import { defineStore } from 'pinia';
import { api } from '@/api/client';

export const useAppStore = defineStore('app', {
  state: () => ({
    status: null,
    health: null,
    theme: localStorage.getItem('theme') || 'light',
    libraryOpen: false,
    librarySeed: 0,
  }),
  actions: {
    async refreshStatus() {
      this.status = await api.status();
      return this.status;
    },
    async refreshHealth() {
      this.health = await api.health();
      return this.health;
    },
    setTheme(theme) {
      this.theme = theme;
      localStorage.setItem('theme', theme);
      document.documentElement.dataset.theme = theme;
    },
    openLibrary() {
      this.libraryOpen = true;
      this.librarySeed += 1;
    },
    closeLibrary() {
      this.libraryOpen = false;
    },
  },
});
