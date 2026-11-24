import { defineStore } from 'pinia';
import { api } from '@/api/client';
import { createHistoryStack } from '@/utils/historyStack';
import { seedParams } from '@/utils/paramDefs';

const PRESETS = {
  image: { w: 180, h: 156, label: '图片' },
  video: { w: 400, h: 220, label: '视频' },
  audio: { w: 200, h: 132, label: '音频' },
  quick: { w: 378, h: 184, label: '快速视频' },
  group: { w: 280, h: 160, label: '组合' },
  zone: { w: 980, h: 520, label: '区域' },
  schedule: { w: 336, h: 208, label: '定时生成组' },
  director: { w: 520, h: 300, label: '3D 导演台' },
};

function uid(prefix = 'n') {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function cloneSnap(nodes, edges, viewport) {
  return JSON.stringify({
    nodes: JSON.parse(JSON.stringify(nodes)),
    edges: JSON.parse(JSON.stringify(edges)),
    viewport: { ...viewport },
  });
}

export const useCanvasStore = defineStore('canvas', {
  state: () => ({
    id: '',
    name: '',
    rev: 0,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, scale: 1 },
    selection: [],
    activeId: '',
    saveState: 'saved',
    models: { image: [], video: [], audio: [] },
    snap: true,
    compress: true,
    tool: 'select',
    libraryOpen: false,
    taskOpen: false,
    scheduleOpen: false,
    directorOpen: false,
    directorNodeId: '',
    findQuery: '',
    filter: { types: [], statuses: [] },
    contextMenu: null,
    mention: null,
    dirtyTimer: 0,
    _history: createHistoryStack(60),
    _histReady: false,
  }),
  getters: {
    activeNode(state) {
      return state.nodes.find((n) => n.id === state.activeId) || null;
    },
    selectedNodes(state) {
      const set = new Set(state.selection);
      return state.nodes.filter((n) => set.has(n.id));
    },
    visibleNodes(state) {
      let list = state.nodes;
      const q = String(state.findQuery || '')
        .trim()
        .toLowerCase();
      if (q) {
        list = list.filter((n) => {
          const title = String(n.data?.title || n.data?.prompt || n.type || '').toLowerCase();
          return title.includes(q) || String(n.id).toLowerCase().includes(q);
        });
      }
      if (state.filter.types?.length) {
        const set = new Set(state.filter.types);
        list = list.filter((n) => set.has(n.type));
      }
      if (state.filter.statuses?.length) {
        const set = new Set(state.filter.statuses);
        list = list.filter((n) => set.has(n.data?.status || 'idle'));
      }
      return list;
    },
    canUndo(state) {
      return state._history.canUndo();
    },
    canRedo(state) {
      return state._history.canRedo();
    },
  },
  actions: {
    preset(type) {
      return PRESETS[type] || PRESETS.image;
    },
    snapshot() {
      return cloneSnap(this.nodes, this.edges, this.viewport);
    },
    applySnapshot(raw) {
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        this.nodes = data.nodes || [];
        this.edges = data.edges || [];
        this.viewport = data.viewport || { x: 0, y: 0, scale: 1 };
        this.selection = [];
        this.activeId = '';
        this.scheduleSave();
      } catch {
        /* ignore */
      }
    },
    pushHistory() {
      if (!this._histReady) return;
      this._history.push(this.snapshot());
    },
    undo() {
      const prev = this._history.undo(this.snapshot());
      if (prev) this.applySnapshot(prev);
      return Boolean(prev);
    },
    redo() {
      const next = this._history.redo(this.snapshot());
      if (next) this.applySnapshot(next);
      return Boolean(next);
    },
    normalizeEdge(e) {
      return {
        id: e.id || uid('e'),
        source: e.source || e.sourceId || e.source_id || '',
        target: e.target || e.targetId || e.target_id || '',
        role: e.role || 'ref',
        sourcePort: e.sourcePort || e.source_port || null,
        targetPort: e.targetPort || e.target_port || null,
      };
    },
    async load(id) {
      // 接口形态是 { canvas, nodes, edges, viewport }，卡片不在 canvas 里
      const data = await api.getCanvas(id);
      const canvas = data.canvas || {};
      this.id = id;
      this.name = canvas.name || data.name || '画布';
      this.rev = canvas.rev ?? data.rev ?? 0;
      const rawNodes = data.nodes || canvas.nodes || [];
      this.nodes = rawNodes.map((n) => ({
        ...n,
        data: n.data || {},
      }));
      const rawEdges = data.edges || canvas.edges || [];
      this.edges = rawEdges.map((e) => this.normalizeEdge(e));
      const vp = data.viewport || canvas.viewport || { x: 0, y: 0, scale: 1 };
      this.viewport = {
        x: Number(vp.x) || 0,
        y: Number(vp.y) || 0,
        scale: Number(vp.scale ?? vp.zoom) || 1,
      };
      this.selection = [];
      this.activeId = '';
      this.findQuery = '';
      this.saveState = 'saved';
      this._history.reset();
      this._histReady = true;
      try {
        this.models = (await api.models()) || this.models;
      } catch {
        /* ignore */
      }
    },
    async save(force) {
      if (!this.id) return;
      // 加载读空后再 beforeunload 强制保存，会把库里已有卡片冲成 0。
      // 本地空、且本次并不是「用户刚删光」的脏写时，先跟服务端核对。
      if (!this.nodes.length && this.saveState !== 'dirty') {
        try {
          const meta = await api.canvasMeta(this.id);
          if ((meta.nodeCount || 0) > 0) {
            this.saveState = 'failed';
            throw new Error('本地卡片为空但服务端仍有数据，已拒绝覆盖');
          }
        } catch (e) {
          if (String(e.message || '').includes('拒绝覆盖')) {
            if (!force) throw e;
            return;
          }
        }
      }
      this.saveState = 'saving';
      try {
        const payload = {
          name: this.name,
          nodes: this.nodes,
          // 服务端落库字段是 sourceId / targetId
          edges: this.edges.map((e) => {
            const n = this.normalizeEdge(e);
            return {
              id: n.id,
              sourceId: n.source,
              targetId: n.target,
              role: n.role,
              sourcePort: n.sourcePort,
              targetPort: n.targetPort,
            };
          }),
          viewport: this.viewport,
        };
        const res = await api.saveCanvas(this.id, payload, this.rev);
        if (res && res.rev != null) this.rev = res.rev;
        this.saveState = 'saved';
      } catch (e) {
        this.saveState = 'failed';
        if (!force) throw e;
      }
    },
    scheduleSave() {
      this.saveState = 'dirty';
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = setTimeout(() => {
        this.save().catch(() => {});
      }, 700);
    },
    addNode(type, at = {}) {
      this.pushHistory();
      const p = this.preset(type);
      const modelList = this.models[type === 'quick' ? 'video' : type] || [];
      const preferred = modelList.find((m) => m.isDefault) || modelList[0];
      const modelId = preferred?.id || preferred || '';
      const node = {
        id: uid('n'),
        type,
        x: at.x ?? 120 + this.nodes.length * 24,
        y: at.y ?? 120 + this.nodes.length * 18,
        w: p.w,
        h: p.h,
        z: this.nodes.length + 1,
        data: {
          prompt: '',
          title: type === 'schedule' ? '定时生成组 · 夜间批量' : type === 'group' ? '组合' : '',
          model: ['image', 'video', 'quick', 'audio'].includes(type) ? modelId : '',
          channelId: preferred?.channelId || '',
          params: seedParams(this.models, type, modelId),
          status: 'idle',
          history: [],
          members: type === 'group' || type === 'schedule' ? [] : undefined,
          schedule: type === 'schedule' ? { startAt: '03:00', runType: 'daily', concurrency: 2, fail: 'retry', interval: 30 } : undefined,
        },
      };
      this.nodes.push(node);
      this.selection = [node.id];
      this.activeId = node.id;
      this.scheduleSave();
      return node;
    },
    updateNode(id, patch) {
      const n = this.nodes.find((x) => x.id === id);
      if (!n) return;
      Object.assign(n, patch);
      this.scheduleSave();
    },
    updateNodeData(id, patch) {
      const n = this.nodes.find((x) => x.id === id);
      if (!n) return;
      n.data = { ...(n.data || {}), ...patch };
      this.scheduleSave();
    },
    removeNodes(ids) {
      this.pushHistory();
      const set = new Set(ids);
      // 从组合/定时组成员里摘掉
      this.nodes.forEach((n) => {
        if (!Array.isArray(n.data?.members)) return;
        n.data.members = n.data.members.filter((id) => !set.has(id));
      });
      // 解散被删组合的出线：还给成员
      ids.forEach((id) => {
        const g = this.nodes.find((n) => n.id === id && n.type === 'group');
        if (!g) return;
        const members = (g.data?.members || []).map((mid) => this.nodes.find((n) => n.id === mid)).filter(Boolean);
        const outs = this.edges.filter((e) => (e.source || e.source_id) === id);
        outs.forEach((e) => {
          members.forEach((m) => {
            if (m.id === (e.target || e.target_id)) return;
            this.edges.push({ id: uid('e'), source: m.id, target: e.target || e.target_id, role: e.role || 'ref' });
          });
        });
      });
      this.nodes = this.nodes.filter((n) => !set.has(n.id));
      this.edges = this.edges.filter((e) => !set.has(e.source) && !set.has(e.target) && !set.has(e.source_id) && !set.has(e.target_id));
      this.selection = this.selection.filter((id) => !set.has(id));
      if (set.has(this.activeId)) this.activeId = '';
      this.scheduleSave();
    },
    connect(source, target, role = 'ref') {
      if (!source || !target || source === target) return;
      const exists = this.edges.some((e) => (e.source || e.source_id) === source && (e.target || e.target_id) === target);
      if (exists) return;
      this.pushHistory();
      this.edges.push({ id: uid('e'), source, target, role });
      this.scheduleSave();
    },
    removeEdge(id) {
      this.pushHistory();
      this.edges = this.edges.filter((e) => e.id !== id);
      this.scheduleSave();
    },
    select(ids, additive) {
      if (additive) {
        const set = new Set(this.selection);
        ids.forEach((id) => (set.has(id) ? set.delete(id) : set.add(id)));
        this.selection = [...set];
      } else {
        this.selection = [...ids];
      }
      // 选中不自动展开：展开靠双击 / Enter，避免一点就进编辑态拖不动
      if (this.selection.length !== 1 || !this.selection.includes(this.activeId)) {
        this.activeId = '';
      }
    },
    resetOrigin() {
      this.pushHistory();
      this.viewport = { x: 40, y: 40, scale: 1 };
    },
    fitView(width, height) {
      if (!this.nodes.length) {
        this.viewport = { x: 0, y: 0, scale: 1 };
        return;
      }
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      this.nodes.forEach((n) => {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + (n.w || 200));
        maxY = Math.max(maxY, n.y + (n.h || 120));
      });
      const bw = maxX - minX || 1;
      const bh = maxY - minY || 1;
      const scale = Math.min(1.2, Math.max(0.2, Math.min((width - 120) / bw, (height - 120) / bh)));
      this.viewport = {
        scale,
        x: (width - bw * scale) / 2 - minX * scale,
        y: (height - bh * scale) / 2 - minY * scale,
      };
    },
    tidyLayout() {
      this.pushHistory();
      const cards = this.nodes.filter((n) => n.type !== 'zone');
      const zones = this.nodes.filter((n) => n.type === 'zone');
      const gapX = 48;
      const gapY = 40;
      const cols = Math.max(1, Math.ceil(Math.sqrt(cards.length)));
      cards.forEach((n, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        n.x = 80 + col * ((n.w || 360) + gapX);
        n.y = 80 + row * ((n.h || 210) + gapY);
      });
      zones.forEach((z, i) => {
        z.x = 40;
        z.y = 40 + i * ((z.h || 420) + 60);
      });
      this.scheduleSave();
    },
    alignSelected(mode) {
      const nodes = this.selectedNodes.filter((n) => n.type !== 'zone');
      if (nodes.length < 2) return;
      this.pushHistory();
      if (mode === 'left') {
        const x = Math.min(...nodes.map((n) => n.x));
        nodes.forEach((n) => (n.x = x));
      } else if (mode === 'right') {
        const r = Math.max(...nodes.map((n) => n.x + n.w));
        nodes.forEach((n) => (n.x = r - n.w));
      } else if (mode === 'centerX') {
        const cx = nodes.reduce((s, n) => s + n.x + n.w / 2, 0) / nodes.length;
        nodes.forEach((n) => (n.x = cx - n.w / 2));
      } else if (mode === 'top') {
        const y = Math.min(...nodes.map((n) => n.y));
        nodes.forEach((n) => (n.y = y));
      } else if (mode === 'bottom') {
        const b = Math.max(...nodes.map((n) => n.y + n.h));
        nodes.forEach((n) => (n.y = b - n.h));
      } else if (mode === 'centerY') {
        const cy = nodes.reduce((s, n) => s + n.y + n.h / 2, 0) / nodes.length;
        nodes.forEach((n) => (n.y = cy - n.h / 2));
      } else if (mode === 'hSpace' || mode === 'hGap24') {
        const sorted = [...nodes].sort((a, b) => a.x - b.x);
        const gap = mode === 'hGap24' ? 24 : null;
        if (gap != null) {
          let x = sorted[0].x;
          sorted.forEach((n) => {
            n.x = x;
            x += n.w + gap;
          });
        } else {
          const left = sorted[0].x;
          const right = sorted[sorted.length - 1].x + sorted[sorted.length - 1].w;
          const totalW = sorted.reduce((s, n) => s + n.w, 0);
          const g = (right - left - totalW) / (sorted.length - 1);
          let x = left;
          sorted.forEach((n) => {
            n.x = x;
            x += n.w + g;
          });
        }
      } else if (mode === 'vSpace') {
        const sorted = [...nodes].sort((a, b) => a.y - b.y);
        const top = sorted[0].y;
        const bottom = sorted[sorted.length - 1].y + sorted[sorted.length - 1].h;
        const totalH = sorted.reduce((s, n) => s + n.h, 0);
        const g = (bottom - top - totalH) / (sorted.length - 1);
        let y = top;
        sorted.forEach((n) => {
          n.y = y;
          y += n.h + g;
        });
      }
      this.scheduleSave();
    },
    groupMembersOf(group) {
      const list = Array.isArray(group?.data?.members) ? group.data.members : [];
      return list.map((id) => this.nodes.find((n) => n.id === id)).filter((n) => n && n.type !== 'group');
    },
    groupsOf(nodeId) {
      return this.nodes.filter((n) => n.type === 'group' && Array.isArray(n.data?.members) && n.data.members.includes(nodeId));
    },
    selectedCards() {
      const seen = new Set();
      const out = [];
      const push = (card) => {
        if (!card || card.type === 'group' || card.type === 'schedule' || card.type === 'zone' || seen.has(card.id)) return;
        seen.add(card.id);
        out.push(card);
      };
      this.selectedNodes.forEach((n) => {
        if (n.type === 'group') this.groupMembersOf(n).forEach(push);
        else push(n);
      });
      return out;
    },
    createGroup(cards) {
      if (!cards?.length) return null;
      this.pushHistory();
      const minX = Math.min(...cards.map((c) => c.x));
      const minY = Math.min(...cards.map((c) => c.y));
      const p = this.preset('group');
      const group = {
        id: uid('n'),
        type: 'group',
        x: Math.round(minX - 320),
        y: Math.round(minY),
        w: p.w,
        h: p.h,
        z: this.nodes.length + 1,
        data: {
          title: `组合 · ${cards.length}`,
          members: cards.map((c) => c.id),
          status: 'idle',
          prompt: '',
          params: {},
        },
      };
      this.nodes.push(group);
      const memberIds = new Set(group.data.members);
      this.edges.forEach((e) => {
        const src = e.source || e.source_id;
        const tgt = e.target || e.target_id;
        if (memberIds.has(src) && !memberIds.has(tgt)) {
          e.source = group.id;
          delete e.source_id;
        }
      });
      this.selection = [group.id];
      this.activeId = group.id;
      this.scheduleSave();
      return group;
    },
    addToGroup(group, cards) {
      if (!group || group.type !== 'group') return;
      this.pushHistory();
      if (!Array.isArray(group.data.members)) group.data.members = [];
      cards.forEach((card) => {
        if (!card || card.type === 'group') return;
        this.groupsOf(card.id).forEach((other) => {
          if (other.id === group.id) return;
          other.data.members = other.data.members.filter((id) => id !== card.id);
        });
        if (!group.data.members.includes(card.id)) group.data.members.push(card.id);
      });
      group.data.title = `组合 · ${group.data.members.length}`;
      this.scheduleSave();
    },
    groupSelection() {
      const picked = this.selectedNodes;
      const groupPicked = picked.filter((n) => n.type === 'group');
      const cards = this.selectedCards();
      if (groupPicked.length === 1 && cards.length) {
        this.addToGroup(groupPicked[0], cards);
        return groupPicked[0];
      }
      if (cards.length < 2) return null;
      return this.createGroup(cards);
    },
    createZoneAroundSelection() {
      const nodes = this.selectedNodes.filter((n) => n.type !== 'zone');
      if (!nodes.length) return null;
      this.pushHistory();
      const pad = 40;
      const minX = Math.min(...nodes.map((n) => n.x)) - pad;
      const minY = Math.min(...nodes.map((n) => n.y)) - pad;
      const maxX = Math.max(...nodes.map((n) => n.x + n.w)) + pad;
      const maxY = Math.max(...nodes.map((n) => n.y + n.h)) + pad;
      const zone = this.addNode('zone', { x: minX, y: minY });
      zone.w = Math.max(320, maxX - minX);
      zone.h = Math.max(240, maxY - minY);
      zone.data.title = '区域';
      nodes.forEach((n) => {
        n.data = { ...n.data, zoneId: zone.id };
      });
      this.scheduleSave();
      return zone;
    },
    pushCardHistory(nodeId, result) {
      const n = this.nodes.find((x) => x.id === nodeId);
      if (!n || !result?.url) return;
      const list = Array.isArray(n.data.history) ? n.data.history.slice() : [];
      list.unshift({
        id: uid('h'),
        at: Date.now(),
        url: result.url,
        thumb: result.thumb || result.url,
        model: n.data.model,
        prompt: n.data.prompt,
        params: { ...(n.data.params || {}) },
      });
      n.data.history = list.slice(0, 20);
      this.scheduleSave();
    },
    restoreCardHistory(nodeId, histId) {
      const n = this.nodes.find((x) => x.id === nodeId);
      if (!n) return;
      const hit = (n.data.history || []).find((h) => h.id === histId);
      if (!hit) return;
      this.pushHistory();
      n.data.url = hit.url;
      n.data.thumb = hit.thumb;
      if (hit.prompt != null) n.data.prompt = hit.prompt;
      if (hit.model) n.data.model = hit.model;
      if (hit.params) n.data.params = { ...hit.params };
      n.data.status = 'done';
      this.scheduleSave();
    },
    focusNode(id, width, height) {
      const node = this.nodes.find((n) => n.id === id);
      if (!node) return;
      this.select([id]);
      this.viewport = {
        ...this.viewport,
        x: width / 2 - (node.x + (node.w || 200) / 2) * this.viewport.scale,
        y: height / 2 - (node.y + (node.h || 140) / 2) * this.viewport.scale,
      };
    },
    addScheduleMembers(scheduleId, cardIds) {
      const s = this.nodes.find((n) => n.id === scheduleId && n.type === 'schedule');
      if (!s) return;
      this.pushHistory();
      if (!Array.isArray(s.data.members)) s.data.members = [];
      cardIds.forEach((id) => {
        if (!s.data.members.includes(id)) s.data.members.push(id);
      });
      this.scheduleSave();
    },
  },
});

export { PRESETS, uid };
