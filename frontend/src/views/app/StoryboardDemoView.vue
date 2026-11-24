<template>
  <div class="story">
    <header class="top">
      <div>
        <div class="title-row">
          <h2>夜行地铁 · 分镜墙</h2>
          <Tag color="blue">示意页</Tag>
        </div>
        <div class="meta">3 幕 · 9 镜头 · 总时长 00:42 · 参考连线 7</div>
      </div>
      <Space>
        <Button ghost @click="createDemo" :loading="creating">用此结构新建画布</Button>
        <Button @click="$router.push('/interactions')">交互件规范</Button>
        <Button type="primary" @click="$router.push('/')">返回门户</Button>
      </Space>
    </header>

    <div class="board">
      <aside class="side">
        <div class="side-title">分镜说明</div>
        <p>左侧为参考素材区，右侧为镜头墙；虚线箭头表示参考 / 时序关系。</p>
        <p>每一幕末尾可「添加镜头」。状态色：绿完成、蓝生成中、红失败。</p>
        <Button long @click="selected = null">取消选择</Button>
        <div class="esc">Esc 取消选择</div>
      </aside>

      <div class="acts">
        <section v-for="act in acts" :key="act.id" class="act">
          <div class="act-head">
            <div class="left">
              <span class="no">{{ act.no }}</span>
              <b>{{ act.title }}</b>
              <span class="muted">{{ act.duration }}</span>
              <Tag :color="act.tagColor" size="small">{{ act.tag }}</Tag>
            </div>
            <span class="muted">{{ act.shots.length }} 镜头</span>
          </div>
          <div class="shots">
            <div
              v-for="(shot, idx) in act.shots"
              :key="shot.id"
              class="shot"
              :class="[{ on: selected === shot.id }, shot.status]"
              @click="selected = shot.id"
            >
              <div class="cover" :style="{ background: shot.bg }">
                <span v-if="shot.status === 'running'" class="progress">生成中 {{ shot.progress }}</span>
                <span v-if="shot.status === 'failed'" class="fail">失败 429</span>
              </div>
              <div class="info">
                <div class="name">{{ shot.name }}</div>
                <div class="row">
                  <span>{{ shot.len }}</span>
                  <span class="st">● {{ shot.statusText }}</span>
                </div>
              </div>
              <div v-if="idx < act.shots.length - 1" class="arrow">›</div>
            </div>
            <button class="add-shot">+ 添加镜头</button>
          </div>
        </section>
      </div>
    </div>

    <footer class="legend">
      <span>虚线箭头 · 时序 / 参考关系</span>
      <span>方框 · 分幕区域，可拖动</span>
      <span>蓝点 · 独立生成，不进入行内</span>
    </footer>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { Message } from 'view-ui-plus';
import { api } from '@/api/client';

const router = useRouter();
const selected = ref(null);
const creating = ref(false);
const acts = [
  {
    id: 'a1', no: '01', title: '第一幕 · 站台', duration: '00:14', tag: '3/3 完成', tagColor: 'success',
    shots: [
      { id: 's1', name: 'S01-01 站台全景', len: '5s', status: 'done', statusText: '完成', bg: 'linear-gradient(135deg,#1f2937,#334155)' },
      { id: 's2', name: 'S01-02 轨道特写', len: '4s', status: 'done', statusText: '完成', bg: 'linear-gradient(135deg,#111827,#374151)' },
      { id: 's3', name: 'S01-03 人物背影', len: '5s', status: 'done', statusText: '完成', bg: 'linear-gradient(135deg,#312e81,#4c1d95)' },
    ],
  },
  {
    id: 'a2', no: '02', title: '第二幕 · 车厢', duration: '00:16', tag: '生成中', tagColor: 'blue',
    shots: [
      { id: 's4', name: 'S02-01 车厢横摇', len: '6s', status: 'running', statusText: '生成中', progress: '00:42', bg: 'linear-gradient(135deg,#78350f,#a16207)' },
      { id: 's5', name: 'S02-02 窗外掠影', len: '5s', status: 'queued', statusText: '队列中', bg: 'linear-gradient(135deg,#1e3a5f,#334155)' },
      { id: 's6', name: 'S02-03 把手特写', len: '5s', status: 'idle', statusText: '待生成', bg: 'linear-gradient(135deg,#1f2937,#0f172a)' },
    ],
  },
  {
    id: 'a3', no: '03', title: '第三幕 · 出口', duration: '00:12', tag: '失败 1', tagColor: 'error',
    shots: [
      { id: 's7', name: 'S03-01 出口拉远', len: '4s', status: 'done', statusText: '完成', bg: 'linear-gradient(135deg,#0f172a,#1e293b)' },
      { id: 's8', name: 'S03-02 雨夜空镜', len: '4s', status: 'failed', statusText: '失败', bg: 'linear-gradient(135deg,#3f1d1d,#7f1d1d)' },
      { id: 's9', name: 'S03-03 天桥俯拍', len: '4s', status: 'idle', statusText: '待生成', bg: 'linear-gradient(135deg,#1e293b,#334155)' },
    ],
  },
];

async function createDemo() {
  creating.value = true;
  try {
    const created = await api.createCanvas('夜行地铁 · 分镜墙');
    const id = created.id || created.canvas?.id;
    const nodes = [
      { id: 'n1', type: 'image', x: 80, y: 100, w: 220, h: 140, z: 1, data: { title: '站台参考', prompt: '夜晚地铁站台' } },
      { id: 'n2', type: 'image', x: 80, y: 280, w: 220, h: 140, z: 2, data: { title: '车厢参考', prompt: '地铁车厢内部' } },
      { id: 'n3', type: 'image', x: 80, y: 460, w: 220, h: 140, z: 3, data: { title: '出口参考', prompt: '地铁出口雨夜' } },
      { id: 'n4', type: 'video', x: 520, y: 120, w: 320, h: 180, z: 4, data: { title: 'S01 站台推轨', prompt: '站台推轨镜头', mode: 'refs' } },
      { id: 'n5', type: 'video', x: 520, y: 340, w: 320, h: 180, z: 5, data: { title: 'S02 车厢横摇', prompt: '车厢横摇', mode: 'refs' } },
      { id: 'n6', type: 'video', x: 520, y: 560, w: 320, h: 180, z: 6, data: { title: 'S03 出口拉远', prompt: '出口拉远', mode: 'frames' } },
      { id: 'z1', type: 'zone', x: 40, y: 60, w: 900, h: 240, z: 0, data: { title: '第一幕 · 站台' } },
    ];
    const edges = [
      { id: 'e1', source: 'n1', target: 'n4', role: 'ref' },
      { id: 'e2', source: 'n2', target: 'n5', role: 'ref' },
      { id: 'e3', source: 'n3', target: 'n6', role: 'ref' },
    ];
    await api.saveCanvas(id, { name: '夜行地铁 · 分镜墙', nodes, edges, viewport: { x: 0, y: 0, scale: 1 } });
    Message.success('已创建示例画布');
    router.push(`/canvas/${id}`);
  } catch (e) {
    Message.error(e.message);
  } finally {
    creating.value = false;
  }
}
</script>

<style scoped lang="scss">
.story {
  min-height: 100vh; background: #0b0f14; color: #e8ecf3; display: flex; flex-direction: column;
}
.top {
  display: flex; justify-content: space-between; align-items: flex-start; padding: 20px 28px;
  border-bottom: 1px solid #1f2937; background: #111827;
}
.title-row { display: flex; gap: 10px; align-items: center; }
h2 { margin: 0; font-size: 20px; }
.meta { margin-top: 6px; color: #8b95a3; font-size: 12px; }
.board { flex: 1; display: flex; min-height: 0; }
.side {
  width: 220px; border-right: 1px solid #1f2937; padding: 18px; background: #0f172a;
  p { color: #9aa8bd; font-size: 12px; line-height: 1.55; margin: 0 0 12px; }
}
.side-title { font-weight: 600; margin-bottom: 10px; }
.esc { margin-top: 8px; color: #64748b; font-size: 11px; }
.acts { flex: 1; overflow: auto; padding: 18px 22px 28px; }
.act {
  background: #111827; border: 1px solid #1f2937; border-radius: 14px; padding: 14px; margin-bottom: 16px;
}
.act-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.act-head .left { display: flex; gap: 10px; align-items: center; }
.no {
  width: 28px; height: 28px; border-radius: 8px; background: #1e293b; display: grid; place-items: center; font-size: 12px; color: #7fb6f2;
}
.muted { color: #8b95a3; font-size: 12px; }
.shots { display: flex; gap: 12px; align-items: stretch; overflow-x: auto; padding-bottom: 4px; }
.shot {
  width: 200px; flex-shrink: 0; background: #0f172a; border: 1px solid #243044; border-radius: 12px; overflow: hidden;
  position: relative; cursor: pointer;
  &.on { border-color: #2d8cf0; box-shadow: 0 0 0 1px #2d8cf0; }
}
.cover {
  height: 112px; position: relative; background-size: cover;
}
.progress, .fail {
  position: absolute; left: 8px; right: 8px; bottom: 8px; border-radius: 6px; padding: 4px 8px; font-size: 11px; text-align: center;
}
.progress { background: rgba(37,99,235,.85); }
.fail { background: rgba(185,28,28,.9); }
.info { padding: 10px; }
.name { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.row { display: flex; justify-content: space-between; font-size: 11px; color: #94a3b8; }
.st { color: #94a3b8; }
.shot.done .st { color: #34d399; }
.shot.running .st { color: #60a5fa; }
.shot.failed .st { color: #f87171; }
.arrow {
  position: absolute; right: -10px; top: 48%; z-index: 2; width: 18px; height: 18px; border-radius: 50%;
  background: #1e293b; border: 1px dashed #64748b; color: #94a3b8; display: grid; place-items: center; font-size: 12px;
}
.add-shot {
  width: 140px; flex-shrink: 0; border: 1px dashed #334155; background: transparent; color: #7fb6f2;
  border-radius: 12px; cursor: pointer;
}
.legend {
  display: flex; gap: 24px; padding: 12px 28px; border-top: 1px solid #1f2937; color: #64748b; font-size: 12px; background: #0f172a;
}
</style>
