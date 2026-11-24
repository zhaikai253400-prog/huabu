<template>
  <div class="page">
    <div class="head">
      <div>
        <div class="title-row">
          <h2>交互件规范</h2>
          <span class="tag">必出交互件规范</span>
        </div>
        <p class="desc">右键菜单 · @弹层 · 多选对齐条 · 均以浮层形式出现在画布之上；Esc 逐层关闭</p>
      </div>
      <div class="right">
        <span class="muted">深色画布 · 圆角 10 · 描边 #2f3947</span>
        <Button @click="$router.push('/')">返回门户</Button>
      </div>
    </div>

    <div class="grid">
      <section class="block">
        <div class="block-title"><span class="n">01</span>卡片右键菜单</div>
        <div class="menu">
          <div class="item"><span>展开卡片面板</span><kbd>Enter</kbd></div>
          <div class="item"><span>复制卡片</span><kbd>Ctrl+D</kbd></div>
          <div class="item">提取尾帧为图片卡</div>
          <div class="item">从此卡拉出参考线</div>
          <div class="item"><span>查找引用 / 被引用</span><span class="muted">3 / 1</span></div>
          <div class="sep" />
          <div class="item">加入组合</div>
          <div class="item"><span>移入区域…</span><span>›</span></div>
          <div class="item">定位到此卡</div>
          <div class="sep" />
          <div class="item danger"><span>删除卡片</span><kbd>Del</kbd></div>
        </div>
        <p class="note">按卡片类型动态显隐：图片卡无「提取尾帧」，快速视频卡无「拉出参考线」。</p>
      </section>

      <section class="block">
        <div class="block-title"><span class="n">02</span>提示词 @ 引用弹层</div>
        <div class="popup">
          <div class="search">定妆<span class="caret" /></div>
          <div class="match">共 3 条匹配</div>
          <div class="group">本画布卡片</div>
          <div class="opt on">
            <i class="dot green" />定妆 · 站台
            <span class="thumb" /><span class="hint">Enter 插入</span>
          </div>
          <div class="opt"><i class="dot green" />定妆 · 车厢 <span class="thumb" /></div>
          <div class="group">素材库匹配</div>
          <div class="opt"><i class="dot orange" />定妆_女主_A.png <span class="hint">素材</span></div>
          <div class="opt"><i class="dot purple" />镜头库 · 推轨 <span class="hint">预设</span></div>
          <div class="popup-foot">↑↓ 选择 · Enter 插入 · Esc 关闭</div>
        </div>
        <p class="note">插入后生成彩色胶囊，颜色与被引用卡片类型一致，点击胶囊可定位回源卡片。</p>
      </section>

      <section class="block">
        <div class="block-title"><span class="n">03</span>卡片悬停连线点</div>
        <div class="link-demo">
          <div class="mini">
            <div class="thumb-lg" />
            <div class="row"><i class="dot green" />定妆 · 站台<span class="port">+</span></div>
          </div>
          <p class="note">右侧圆点为出线点，左侧为入线点；拖动到目标卡片即建立参考关系，快速视频卡不出线。</p>
        </div>
      </section>
    </div>

    <section class="block align-block">
      <div class="block-title">
        <span class="n">04</span>多选对齐条
        <Tag size="small">选中 ≥ 2 张卡片时从画布顶部滑入</Tag>
      </div>
      <div class="align-bar">
        <div class="left">已选 4 张卡片 <span class="muted">图片 2 · 视频 2</span></div>
        <div class="tools">
          <button>左对齐</button>
          <button>居中</button>
          <button>顶部</button>
          <button>等距 24</button>
          <button>分布</button>
          <button>编组</button>
          <button>建区域</button>
          <button class="danger">删除</button>
        </div>
        <a>Esc 取消选择</a>
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
.page { padding: 28px 48px 40px; background: #f5f7f9; min-height: calc(100vh - 64px); }
.head { display:flex; justify-content:space-between; gap:16px; margin-bottom:20px; }
.title-row { display:flex; gap:10px; align-items:center; }
h2 { margin:0; font-size:22px; color:#101828; }
.tag { background:#eef5ff; color:#2d8cf0; font-size:12px; padding:2px 8px; border-radius:999px; }
.desc { margin:8px 0 0; color:#6b7684; font-size:13px; }
.right { display:flex; gap:12px; align-items:center; }
.muted { color:#8b95a3; font-size:12px; }
.grid { display:grid; grid-template-columns: 280px 1.2fr 1fr; gap:18px; }
.block {
  background:#fff; border:1px solid #eef1f6; border-radius:12px; padding:16px; min-height:420px;
}
.block-title { display:flex; align-items:center; gap:8px; font-weight:600; margin-bottom:14px; color:#101828; }
.n {
  width:22px; height:22px; border-radius:6px; background:#101828; color:#fff; font-size:11px;
  display:grid; place-items:center;
}
.menu {
  width:240px; background:#151b27; border:1px solid #2f3947; border-radius:10px; padding:6px; color:#e5e7eb;
  box-shadow:0 12px 32px rgba(0,0,0,.25);
}
.item {
  display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-radius:6px; font-size:13px;
  &:hover { background:#1f2937; }
}
.item.danger { color:#f87171; }
.sep { height:1px; background:#2f3947; margin:4px 8px; }
kbd { font-size:11px; color:#8b95a3; background:#0f172a; padding:1px 6px; border-radius:4px; }
.note { margin-top:12px; font-size:12px; color:#8b95a3; line-height:1.5; }
.popup {
  width:340px; background:#151b27; border:1px solid #2f3947; border-radius:10px; overflow:hidden; color:#e5e7eb;
}
.search { padding:12px; border-bottom:1px solid #2f3947; }
.caret { display:inline-block; width:1px; height:14px; background:#2d8cf0; margin-left:2px; vertical-align:middle; }
.match, .group { padding:8px 12px 4px; font-size:12px; color:#8b95a3; }
.opt {
  display:flex; align-items:center; gap:8px; padding:9px 12px; font-size:13px;
  &.on, &:hover { background:#1f2937; }
}
.thumb { width:26px; height:18px; border-radius:3px; background:#334155; margin-left:auto; }
.hint { font-size:11px; color:#8b95a3; margin-left:auto; }
.popup-foot { padding:8px 12px; border-top:1px solid #2f3947; font-size:12px; color:#8b95a3; }
.dot { width:6px; height:6px; border-radius:50%; display:inline-block; }
.dot.green { background:#22a06b; }
.dot.orange { background:#e07a2f; }
.dot.purple { background:#7a5af8; }
.link-demo .mini {
  width:260px; background:#151b27; border:1px solid #2f3947; border-radius:10px; padding:10px; color:#e5e7eb;
}
.thumb-lg { height:112px; border-radius:6px; background:linear-gradient(135deg,#243040,#33445c); }
.row { display:flex; align-items:center; gap:8px; margin-top:10px; font-size:13px; }
.port {
  margin-left:auto; width:18px; height:18px; border-radius:50%; border:1px solid #2d8cf0; color:#2d8cf0;
  display:grid; place-items:center; font-size:12px;
}
.align-block { margin-top:18px; min-height:auto; }
.align-bar {
  display:flex; align-items:center; gap:16px; background:#101828; color:#fff; border-radius:10px; padding:10px 14px;
}
.align-bar .left { white-space:nowrap; }
.tools { display:flex; gap:6px; flex-wrap:wrap; }
.tools button {
  border:0; background:#1f2937; color:#e5e7eb; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:12px;
  &.danger { color:#f87171; }
}
.align-bar a { margin-left:auto; color:#9aa8bd; font-size:12px; }
@media (max-width: 1200px) { .grid { grid-template-columns: 1fr; } }
</style>
