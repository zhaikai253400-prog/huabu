<template>
  <div class="director">
    <div class="bar">
      <div>
        <b>3D 导演台</b>
        <div class="muted tiny">摆机位 → 记关键帧 → 出图 / 拍一组 · 占位示意</div>
      </div>
      <div class="grow" />
      <Button @click="addKeyframe">＋ 记下当前机位</Button>
      <Button type="primary" :loading="shooting" @click="shootOne">拍一张</Button>
      <Button :loading="shooting" @click="shootAll">按机位拍一组</Button>
      <Button @click="$emit('close')">关闭</Button>
    </div>
    <div class="stage" @pointermove="onMove" @pointerup="onUp" @pointerleave="onUp">
      <div class="scene">
        <div class="grid" />
        <div
          class="cam"
          :style="{ left: cam.x + '%', top: cam.y + '%' }"
          @pointerdown.stop="dragCam = true"
        >摄像机</div>
        <div
          v-for="(p, i) in propsList"
          :key="i"
          class="prop"
          :style="{ left: p.x + '%', top: p.y + '%', background: p.color }"
          @pointerdown.stop="dragProp = i"
        >{{ p.name }}</div>
        <div class="hint">拖拽摄像机与占位体；关键帧列表在右侧</div>
      </div>
      <aside>
        <h4>机位关键帧</h4>
        <div v-for="(k, i) in keyframes" :key="i" class="kf" @click="jump(k)">
          <span>#{{ i + 1 }} · t={{ k.t.toFixed(1) }}s</span>
          <a @click.stop="keyframes.splice(i, 1)">删</a>
        </div>
        <div v-if="!keyframes.length" class="muted empty">还没有机位，先摆好再记下</div>
        <Divider />
        <h4>占位体</h4>
        <Button size="small" long @click="addProp">添加角色/道具</Button>
        <p class="muted tiny" style="margin-top:10px">拍一张会按当前机位生成提示词草稿并回写到画布卡片。</p>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { Message } from 'view-ui-plus';

defineProps({ nodeId: String });
const emit = defineEmits(['close', 'shot']);

const cam = reactive({ x: 50, y: 40 });
const propsList = ref([
  { name: '角色A', x: 30, y: 55, color: '#22a06b' },
  { name: '道具', x: 62, y: 58, color: '#e07a2f' },
]);
const keyframes = ref([]);
const shooting = ref(false);
const dragCam = ref(false);
const dragProp = ref(-1);
let t = 0;

function onMove(e) {
  const stage = e.currentTarget?.querySelector?.('.scene') || document.querySelector('.director .scene');
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 100;
  const y = ((e.clientY - rect.top) / rect.height) * 100;
  if (dragCam.value) {
    cam.x = Math.min(95, Math.max(5, x));
    cam.y = Math.min(95, Math.max(5, y));
  }
  if (dragProp.value >= 0) {
    const p = propsList.value[dragProp.value];
    if (p) {
      p.x = Math.min(95, Math.max(5, x));
      p.y = Math.min(95, Math.max(5, y));
    }
  }
}
function onUp() {
  dragCam.value = false;
  dragProp.value = -1;
}
function addKeyframe() {
  keyframes.value.push({ t, x: cam.x, y: cam.y });
  t += 1.5;
  Message.success('已记下机位');
}
function jump(k) {
  cam.x = k.x;
  cam.y = k.y;
}
function addProp() {
  propsList.value.push({
    name: `道具${propsList.value.length}`,
    x: 40 + Math.random() * 30,
    y: 45 + Math.random() * 20,
    color: '#7a5af8',
  });
}
async function shootOne() {
  shooting.value = true;
  try {
    emit('shot', { cam: { ...cam }, keyframes: [...keyframes.value], props: [...propsList.value] });
    Message.success('已生成机位提示词草稿');
  } finally {
    shooting.value = false;
  }
}
async function shootAll() {
  if (!keyframes.value.length) {
    Message.warning('请先记下至少一个机位');
    return;
  }
  shooting.value = true;
  try {
    for (const k of keyframes.value) {
      emit('shot', { cam: { x: k.x, y: k.y }, keyframes: [...keyframes.value], props: [...propsList.value] });
    }
    Message.success(`已按 ${keyframes.value.length} 个机位拍一组`);
  } finally {
    shooting.value = false;
  }
}
onMounted(() => {
  window.addEventListener('pointerup', onUp);
});
onUnmounted(() => {
  window.removeEventListener('pointerup', onUp);
});
</script>

<style scoped lang="scss">
.director { height:100%; display:flex; flex-direction:column; background:#0b1220; color:#e5e7eb; }
.bar {
  display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid #1f2937; background:#111827;
}
.tiny { font-size:12px; }
.stage { flex:1; display:flex; min-height:0; }
.scene {
  flex:1; position:relative; margin:16px; border-radius:14px; overflow:hidden; background:#0f172a; border:1px solid #243044;
}
.grid {
  position:absolute; inset:0;
  background-image: linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px);
  background-size: 40px 40px;
}
.cam, .prop {
  position:absolute; transform:translate(-50%,-50%); padding:8px 12px; border-radius:999px; cursor:grab; font-size:12px; user-select:none;
}
.cam { background:#2d8cf0; color:#fff; box-shadow:0 0 0 4px rgba(45,140,240,.25); }
.prop { color:#fff; }
.hint { position:absolute; left:16px; bottom:14px; color:#7c8ba1; font-size:12px; }
aside {
  width:260px; border-left:1px solid #1f2937; padding:16px; background:#111827; overflow:auto;
}
h4 { margin:0 0 10px; }
.kf {
  display:flex; justify-content:space-between; padding:8px 10px; border-radius:8px; background:#0f172a; margin-bottom:6px; cursor:pointer;
  &:hover { background:#1f2937; }
  a { color:#f87171; }
}
.empty { padding:12px 0; }
.grow { flex:1; }
</style>
