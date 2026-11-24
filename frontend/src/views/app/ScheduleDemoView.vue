<template>
  <div class="page">
    <div class="panel">
      <div class="head">
        <div class="left">
          <span class="ico">时</span>
          <div>
            <div class="title-row">
              <b>定时生成组 · 夜间批量</b>
              <span class="on">已启用</span>
            </div>
            <div class="sub">挂机运行 · 失败自动切备用通道</div>
          </div>
        </div>
        <Button size="small" ghost @click="$router.push('/')">返回门户</Button>
      </div>

      <div class="next">
        <div>
          <div class="label">下次运行</div>
          <div class="val">03:00（今天）· 距离启动还有 12 小时 28 分</div>
        </div>
        <Button type="primary" size="small">立即试跑</Button>
      </div>

      <div class="form">
        <div class="row">
          <span class="k">运行方式</span>
          <div class="seg">
            <button :class="{ on: form.runType === 'daily' }" @click="form.runType = 'daily'">每日定时</button>
            <button :class="{ on: form.runType === 'once' }" @click="form.runType = 'once'">仅一次</button>
            <button :class="{ on: form.runType === 'interval' }" @click="form.runType = 'interval'">固定间隔</button>
          </div>
        </div>
        <div class="row">
          <span class="k">起始时间</span>
          <Input v-model="form.startAt" style="width:100px" />
          <span class="hint">本机时区 · 仅在服务运行时触发</span>
        </div>
        <div class="row">
          <span class="k">并发与队列</span>
          <InputNumber v-model="form.concurrency" :min="1" :max="10" />
          <span class="hint">路并行</span>
          <InputNumber v-model="form.queue" :min="1" :max="50" style="margin-left:12px" />
          <span class="hint">队列上限</span>
        </div>
        <div class="row">
          <span class="k">备用模型</span>
          <Select v-model="form.backup" style="width:280px">
            <Option value="svd">StableVideo 备用 · svd-1.1-motion</Option>
            <Option value="nb">NanoBanana 主通道</Option>
          </Select>
          <Tag color="success" size="small">可用</Tag>
        </div>
        <div class="row">
          <span class="k">失败策略</span>
          <RadioGroup v-model="form.fail">
            <Radio label="retry">重试 2 次后跳过</Radio>
            <Radio label="skip">直接跳过</Radio>
            <Radio label="abort">中止整组</Radio>
          </RadioGroup>
        </div>
        <div class="row">
          <span class="k">尾部提示词</span>
          <span class="hint">继承画布设置：电影感, 胶片颗粒</span>
        </div>
      </div>

      <div class="queue-head">
        <b>卡片队列 · {{ queue.length }}</b>
        <span class="hint">按画布顺序</span>
      </div>
      <div class="queue">
        <div v-for="(item, i) in queue" :key="i" class="q-item">
          <span class="handle">⋮⋮</span>
          <div class="q-main">
            <b>{{ item.name }}</b>
            <div class="hint">{{ item.model }}</div>
          </div>
          <Tag :color="item.color" size="small">{{ item.status }}</Tag>
        </div>
        <button class="add-q">+ 从画布选择卡片加入队列</button>
      </div>

      <div class="foot">
        <div class="hint">预计总耗时约 12 分 30 秒 · 预计消耗 ¥4.80<br />上次运行 03:00 完成 5/5</div>
        <Space>
          <Button @click="$router.push('/')">取消</Button>
          <Button type="primary">保存定时组</Button>
        </Space>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';

const form = reactive({
  runType: 'daily',
  startAt: '03:00',
  concurrency: 2,
  queue: 10,
  backup: 'svd',
  fail: 'retry',
});
const queue = ref([
  { name: '镜次 04 · 出口拉远', model: 'svd-1.1', status: '待生成', color: 'default' },
  { name: '镜次 05 · 天桥俯拍', model: 'svd-1.1', status: '待生成', color: 'default' },
  { name: '镜次 06 · 天桥下摇', model: 'svd-1.1', status: '已排 1', color: 'blue' },
  { name: '尾帧 · 站台', model: 'gemini-3-pro', status: '待生成', color: 'default' },
  { name: '空镜 · 出口雨夜', model: 'kling-flash-4s', status: '待生成', color: 'default' },
]);
</script>

<style scoped lang="scss">
.page {
  min-height: calc(100vh - 64px); background: #0f141b; display: flex; justify-content: center; padding: 32px 16px;
}
.panel {
  width: 420px; background: #1b1f26; border: 1px solid #2c333f; border-radius: 12px; color: #e8ecf3; overflow: hidden;
}
.head, .next, .form, .queue-head, .queue, .foot { padding: 14px 16px; }
.head {
  display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #262c36;
}
.left { display: flex; gap: 10px; align-items: center; }
.ico {
  width: 28px; height: 28px; border-radius: 7px; background: #2b2138; color: #b79aff;
  display: grid; place-items: center; font-size: 12px; font-weight: 700;
}
.title-row { display: flex; gap: 8px; align-items: center; }
.on { background: #1f3a2e; color: #34d399; font-size: 11px; padding: 1px 7px; border-radius: 4px; }
.sub, .hint, .label { color: #79838f; font-size: 12px; }
.next {
  display: flex; justify-content: space-between; align-items: center; background: #151a22; border-bottom: 1px solid #262c36;
}
.val { margin-top: 4px; font-size: 13px; }
.form .row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.k { width: 78px; color: #a8b1be; font-size: 12px; flex-shrink: 0; }
.seg {
  display: flex; background: #14181f; border-radius: 6px; padding: 2px;
  button {
    border: 0; background: transparent; color: #8a94a2; padding: 5px 10px; border-radius: 5px; cursor: pointer; font-size: 12px;
    &.on { background: #243040; color: #7fb6f2; }
  }
}
.queue-head { display: flex; justify-content: space-between; align-items: center; padding-bottom: 0; }
.queue { padding-top: 10px; }
.q-item {
  display: flex; align-items: center; gap: 10px; background: #151a22; border: 1px solid #2b3340;
  border-radius: 8px; padding: 10px; margin-bottom: 8px;
}
.handle { color: #5d6675; letter-spacing: -2px; }
.q-main { flex: 1; min-width: 0; }
.q-main b { font-size: 13px; display: block; }
.add-q {
  width: 100%; border: 1px dashed #3a4553; background: transparent; color: #7fb6f2;
  border-radius: 8px; padding: 10px; cursor: pointer;
}
.foot {
  display: flex; justify-content: space-between; align-items: flex-end; gap: 12px;
  border-top: 1px solid #262c36;
}
</style>
