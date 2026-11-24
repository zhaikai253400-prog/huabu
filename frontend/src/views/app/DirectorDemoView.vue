<template>
  <div class="page">
    <div class="panel">
      <div class="head">
        <div class="left">
          <span class="ico">导</span>
          <div>
            <b>3D 导演台</b>
            <div class="sub">机位 / 灯光 / 场景预演</div>
          </div>
        </div>
        <div class="right">
          <span class="badge">V2 规划中</span>
          <Button size="small" ghost @click="$router.push('/')">关闭</Button>
        </div>
      </div>

      <div class="viewport">
        <svg viewBox="0 0 480 220" class="grid">
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#1d232c" />
              <stop offset="100%" stop-color="#14181f" />
            </linearGradient>
          </defs>
          <rect width="480" height="220" fill="url(#g)" />
          <g stroke="#2a323d" fill="none">
            <path d="M40 180 L240 40 L440 180" />
            <path d="M80 180 L240 70 L400 180" />
            <path d="M120 180 L240 100 L360 180" />
            <path d="M160 180 L240 130 L320 180" />
            <path d="M40 180 H440" />
            <path d="M70 150 H410" />
            <path d="M100 120 H380" />
            <path d="M130 90 H350" />
            <rect x="210" y="118" width="56" height="38" fill="#1d232c" stroke="#3a4553" />
            <circle cx="300" cy="130" r="14" stroke="#3a4553" />
            <path d="M160 156 H216" stroke="#3a4553" />
          </g>
        </svg>
        <div class="vp-text">
          <div>3D 场景视图将在 V2 提供</div>
          <div class="sub">当前版本可先用「图片卡 + 连线」模拟机位与参考关系</div>
          <div class="btns">
            <button @click="$router.push('/storyboard-demo')">用图片卡模拟机位</button>
            <button class="ghost">查看路线图</button>
          </div>
        </div>
      </div>

      <div class="controls">
        <div class="box" v-for="c in controls" :key="c.title">
          <div class="box-head">
            <span>{{ c.title }}</span>
            <em>禁用</em>
          </div>
          <div class="slot" /><div class="slot" />
        </div>
      </div>

      <div class="tip">
        <b>占位说明</b>
        <p>导演台不会影响现有画布数据；未来接入后可把机位与镜头卡双向绑定，生成时自动携带机位参数。</p>
      </div>

      <div class="foot">
        <span>该卡片为占位，暂不可生成</span>
        <Button size="small" @click="$router.push('/')">关闭</Button>
      </div>
    </div>
  </div>
</template>

<script setup>
const controls = [
  { title: '机位' },
  { title: '灯光' },
  { title: '场景' },
];
</script>

<style scoped lang="scss">
.page {
  min-height: calc(100vh - 64px); background: #0f141b; display: flex; justify-content: center; padding: 32px 16px;
}
.panel {
  width: 640px; background: #1b1f26; border: 1px solid #2c333f; border-radius: 12px; color: #e8ecf3; overflow: hidden;
}
.head, .controls, .tip, .foot { padding: 14px 16px; }
.head {
  display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #262c36;
}
.left, .right { display: flex; gap: 10px; align-items: center; }
.ico {
  width: 28px; height: 28px; border-radius: 7px; background: #232a34; color: #8a94a2;
  display: grid; place-items: center; font-size: 12px;
}
.sub { color: #79838f; font-size: 12px; margin-top: 2px; }
.badge {
  background: #2b2138; border: 1px solid #46325f; color: #b79aff; font-size: 11px; padding: 2px 8px; border-radius: 4px;
}
.viewport {
  margin: 16px; border: 1px dashed #333c4a; border-radius: 9px; background: #14181f; min-height: 300px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; overflow: hidden;
}
.grid { width: 80%; max-width: 480px; opacity: .95; }
.vp-text { text-align: center; margin-top: 8px; padding-bottom: 16px; }
.vp-text .sub { margin: 4px 0 14px; }
.btns { display: flex; gap: 8px; justify-content: center; }
.btns button {
  height: 30px; border-radius: 6px; padding: 0 12px; cursor: pointer; font-size: 11px;
  border: 1px solid #35506f; background: #243040; color: #7fb6f2;
  &.ghost { border-color: #333c4a; background: #242a34; color: #a8b1be; }
}
.controls { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
.box {
  background: #1f242c; border: 1px solid #2b3340; border-radius: 8px; padding: 10px;
}
.box-head {
  display: flex; justify-content: space-between; align-items: center; color: #8a94a2; font-size: 11px; margin-bottom: 8px;
  em { font-style: normal; background: #242a34; color: #5d6675; padding: 0 5px; border-radius: 4px; font-size: 9px; }
}
.slot {
  height: 24px; border-radius: 4px; background: #181c23; border: 1px dashed #2c333f; margin-top: 5px;
}
.tip {
  margin: 0 16px 14px; background: #1a2230; border: 1px solid #2f3d52; border-radius: 8px; padding: 10px 12px;
  b { color: #9fb4d0; font-size: 11px; font-weight: 500; }
  p { margin: 6px 0 0; color: #7f90a8; font-size: 12px; line-height: 1.5; }
}
.foot {
  display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #262c36; color: #5d6675; font-size: 12px;
}
</style>
