<template>
  <div class="workbench" @contextmenu.prevent="onBoardContext">
    <div class="body">
      <aside class="rail">
        <header class="rail-head">
          <button class="back" title="回门户" @click="$router.push('/')"><Icon type="ios-arrow-back" /></button>
          <div class="rail-title">
            <button class="name" @click="rename">{{ store.name || '未命名画布' }}</button>
            <div class="save-line"><i class="save-dot" :class="store.saveState" /><span>{{ saveLabel }}</span></div>
          </div>
          <button class="icon-btn" title="更多" @click="moreOpen = !moreOpen"><Icon type="md-more" /></button>
        </header>

        <div class="mode-row">
          <button :class="{ on: store.tool === 'select' && !spaceDown }" @click="store.tool = 'select'">选择 <kbd>V</kbd></button>
          <button :class="{ on: store.tool === 'hand' || spaceDown }" @click="store.tool = 'hand'">平移 <kbd>H</kbd></button>
        </div>

        <div class="sec-row"><span>添加卡片</span><em>+</em></div>
        <div class="add-grid">
          <button @click="onAdd('image')"><i class="dot green" />图片</button>
          <button @click="onAdd('video')"><i class="dot orange" />视频</button>
          <button @click="onAdd('audio')"><i class="dot purple" />音频</button>
          <button @click="onAdd('quick')"><i class="dot cyan" />快速视频</button>
        </div>
        <button class="rail-btn import" @click="onAdd('import')">
          <span>导入素材 / 拖拽进板</span><kbd>Ctrl+V</kbd>
        </button>
        <button class="more-toggle" @click="moreOpen = !moreOpen">{{ moreOpen ? '收起更多类型' : '更多：区域 / 组合 / 定时 / 导演台' }}</button>
        <div v-if="moreOpen" class="add-more">
          <button @click="onAdd('zone')">区域</button>
          <button @click="onAdd('group')">组合</button>
          <button @click="onAdd('schedule')">定时组</button>
          <button @click="onAdd('director')">导演台</button>
        </div>

        <div class="find-box">
          <Icon type="ios-search" class="find-ico" />
          <input v-model="store.findQuery" placeholder="查找卡片 / 提示词" />
          <button class="icon-btn sm" title="定位首条" @click="focusFirstHit"><Icon type="md-locate" /></button>
        </div>
        <div class="filter-tabs">
          <button :class="{ on: typeFilter === '' }" @click="typeFilter = ''">全部</button>
          <button :class="{ on: typeFilter === 'image' }" @click="typeFilter = 'image'">图片</button>
          <button :class="{ on: typeFilter === 'video' }" @click="typeFilter = 'video'">视频</button>
          <button :class="{ on: typeFilter === 'other' }" @click="typeFilter = 'other'">其他</button>
        </div>
        <div v-if="store.findQuery || typeFilter" class="find-hits">
          <div v-for="n in filteredHits" :key="n.id" class="hit" @click="store.focusNode(n.id, vpW, vpH)">
            {{ numberLabel(n) }} · {{ (n.data?.title || n.data?.prompt || n.type).slice(0, 16) }}
          </div>
        </div>

        <div class="sec-row"><span>编辑</span><em>Ctrl+Z 撤销</em></div>
        <div class="edit-icons">
          <button :disabled="!store.canUndo" title="撤销" @click="doUndo"><Icon type="ios-undo" /></button>
          <button :disabled="!store.canRedo" title="重做" @click="doRedo"><Icon type="ios-redo" /></button>
          <button title="整理" @click="store.tidyLayout()"><Icon type="md-grid" /></button>
          <button :class="{ on: store.snap }" title="吸附" @click="store.snap = !store.snap"><Icon type="md-git-commit" /></button>
        </div>
        <div class="switch-row">
          <span>提交时压缩</span>
          <button class="switch" :class="{ on: store.compress }" @click="store.compress = !store.compress">
            <i />
          </button>
        </div>
        <button class="rail-btn" @click="tailOpen = true">尾部 · {{ tailLabel }} <Icon type="ios-arrow-forward" /></button>

        <div class="sec-row"><span>通道状态</span><a @click="$router.push('/admin/channels')">查看余额</a></div>
        <div class="channel-box">
          <div v-for="ch in channelBrief" :key="ch.id" class="ch-card">
            <i class="ch-dot" />
            <div class="ch-meta">
              <b>{{ ch.name }}</b>
              <span>{{ ch.kind }}</span>
            </div>
            <em>{{ ch.balance || '—' }}</em>
          </div>
          <div v-if="!channelBrief.length" class="muted tiny">暂无通道</div>
        </div>

        <div class="drawer-entries">
          <button class="foot-btn" @click="store.libraryOpen = true">
            <span><Icon type="ios-folder-outline" /> 素材库</span>
            <em>{{ libraryCount.toLocaleString() }}</em>
          </button>
          <button class="foot-btn" @click="store.taskOpen = true">
            <span><Icon type="ios-list-box-outline" /> 任务中心</span>
            <em v-if="runningTasks" class="hot">进行中 {{ runningTasks }}</em>
          </button>
        </div>

        <div class="rail-tools">
          <button title="适应窗口" @click="store.fitView(vpW, vpH)"><Icon type="md-expand" /></button>
          <button title="原点" @click="store.resetOrigin()"><Icon type="md-locate" /></button>
          <button title="小地图" :class="{ on: showMini }" @click="showMini = !showMini"><Icon type="md-globe" /></button>
          <button title="网格" :class="{ on: showGrid }" @click="showGrid = !showGrid"><Icon type="md-apps" /></button>
          <button title="设置" @click="$router.push('/settings')"><Icon type="ios-settings-outline" /></button>
        </div>
        <div class="rail-save">
          <span><Icon type="ios-cloud-outline" /> {{ saveLabel }}</span>
          <em>{{ clock }}</em>
        </div>
        <input ref="fileInput" type="file" multiple hidden accept="image/*,video/*,audio/*" @change="onFiles" />
      </aside>

      <div class="main-col">
        <header class="canvas-top">
          <div class="crumb">
            <a @click="$router.push('/')">门户</a>
            <span>/</span>
            <button class="name" @click="rename">{{ store.name || '未命名画布' }}</button>
          </div>
          <div class="chips">
            <span class="chip">{{ Math.round(store.viewport.scale * 100) }}%</span>
            <button class="chip" :class="{ on: showGrid }" @click="showGrid = !showGrid">网格 {{ showGrid ? '开' : '关' }}</button>
            <button class="chip" :class="{ on: store.snap }" @click="store.snap = !store.snap">吸附 {{ store.snap ? '8px' : '关' }}</button>
          </div>
          <div class="top-right">
            <span>区域 {{ zoneCount }} · 卡片 {{ cardCount }} · 生成中 {{ runningTasks }}</span>
            <button class="icon-btn" title="任务" @click="store.taskOpen = true"><Icon type="ios-list" /></button>
            <button class="icon-btn" title="素材库" @click="store.libraryOpen = true"><Icon type="ios-folder" /></button>
          </div>
        </header>

      <div
        ref="viewportEl"
        class="viewport"
        :class="{ hand: isHand, connecting: Boolean(linking), panning: drag.mode === 'pan' }"
        @wheel.prevent="onWheel"
        @pointerdown="onPointerDown"
        @dblclick="onDblClick"
        @dragover.prevent
        @drop="onDrop"
      >
        <div
          v-if="store.selection.length > 1"
          class="align-float"
          @pointerdown.stop
        >
          <div class="af-left">
            <Icon type="ios-copy-outline" class="af-ico" />
            <b>已选 {{ store.selection.length }} 张卡片</b>
            <span class="af-hint">{{ selectionHint }}</span>
          </div>
          <div class="af-tools">
            <button title="左对齐" @click="store.alignSelected('left')"><Icon type="md-return-left" />左对齐</button>
            <button title="顶部对齐" @click="store.alignSelected('top')"><Icon type="md-arrow-round-up" />顶部</button>
            <button title="水平等距" @click="store.alignSelected('hGap24')"><Icon type="md-swap" />等距</button>
            <button title="垂直分布" @click="store.alignSelected('vSpace')"><Icon type="md-menu" />分布</button>
            <button title="编组" @click="onGroup"><Icon type="md-people" />编组</button>
          </div>
          <div class="af-right">
            <span class="af-esc">Esc 取消选择</span>
            <button class="af-cancel" @click="clearSelection">取消选择</button>
          </div>
        </div>
        <div class="world" :style="worldStyle">
          <div v-if="showGrid" class="grid-bg" />
          <svg class="edges" :width="8000" :height="6000">
            <defs>
              <marker id="edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#5b7c99" />
              </marker>
            </defs>
            <path
              v-for="e in store.edges"
              :key="e.id"
              :d="edgePath(e)"
              class="edge"
              :class="{ on: hoverEdgeId === e.id }"
              marker-end="url(#edge-arrow)"
            />
            <path v-if="linking" :d="linkPreview" class="edge preview" marker-end="url(#edge-arrow)" />
          </svg>

          <div
            v-for="node in store.nodes"
            :key="node.id"
            class="node"
            :data-id="node.id"
            :class="[
              node.type,
              {
                active: store.activeId === node.id,
                selected: store.selection.includes(node.id),
                dim: isDimmed(node),
                'connect-target': linkHoverId === node.id && linking && linking.nodeId !== node.id,
                running: node.data?.status === 'running',
                failed: node.data?.status === 'failed',
                done: node.data?.status === 'done',
              },
            ]"
            :style="nodeStyle(node)"
            @pointerdown.stop="onNodeDown($event, node)"
            @click.stop="onNodeClick(node, $event)"
            @dblclick.stop="onNodeDbl(node)"
            @contextmenu.prevent.stop="openNodeMenu($event, node)"
            @dragstart.prevent
          >
            <!-- 区域头 -->
            <div v-if="node.type === 'zone'" class="zone-head">
              <div class="zh-left">
                <Icon type="md-grid" />
                <button class="zh-name" title="点击改名" @click.stop="renameZone(node)" @dblclick.stop="renameZone(node)">
                  {{ node.data?.title || '区域' }}
                </button>
                <span class="zh-tag">区域 · 可折叠</span>
                <span class="zh-meta">{{ zoneStats(node) }}</span>
              </div>
              <div class="zh-acts">
                <button title="改名" @click.stop="renameZone(node)"><Icon type="md-create" /></button>
                <button title="折叠" @click.stop="toggleZone(node)"><Icon type="ios-arrow-down" /></button>
                <button title="更多" @click.stop="openNodeMenu($event, node)"><Icon type="md-more" /></button>
              </div>
            </div>
            <i
              v-if="node.type === 'zone'"
              class="resize-handle"
              title="拖动右下角改变区域大小"
              @pointerdown.stop.prevent="startResize($event, node)"
            />

            <!-- 静默态：图片/视频缩略 -->
            <template v-if="store.activeId !== node.id && ['image', 'video'].includes(node.type)">
              <div class="media silent" :class="node.type">
                <img v-if="mediaUrl(node)" :src="mediaUrl(node)" alt="" draggable="false" @dragstart.prevent />
                <div v-else class="placeholder dash" :class="node.type">
                  <Icon :type="node.type === 'video' ? 'ios-videocam' : 'ios-image'" />
                  <span>{{ emptyHint(node) }}</span>
                </div>
                <span class="type-chip" :class="node.type">{{ node.type === 'video' ? '视频' : '图片' }}</span>
                <span v-if="node.type === 'video' && mediaUrl(node)" class="play-mark"><Icon type="ios-play" /></span>
                <div v-if="node.data?.status === 'running'" class="overlay">
                  <div class="spin" />
                  <div class="ov-title">正在生成…</div>
                  <div class="ov-bar"><i :style="{ width: progressOf(node) + '%' }" /></div>
                </div>
                <div v-else-if="node.data?.status === 'failed'" class="overlay fail">
                  <div class="ov-x">✕</div>
                  <div class="ov-title">生成失败</div>
                </div>
              </div>
              <div class="silent-meta">
                <div class="silent-title">
                  <span class="type-badge" :class="node.type">{{ node.type === 'video' ? '视频' : '图片' }}</span>
                  <span>{{ cardTitle(node) }}</span>
                </div>
                <div class="silent-sub">{{ silentLine(node) }}</div>
              </div>
            </template>

            <!-- 静默态：音频 -->
            <template v-else-if="store.activeId !== node.id && node.type === 'audio'">
              <div class="audio-silent">
                <div class="silent-title">
                  <i class="dot audio" />
                  <span>{{ cardTitle(node) }}</span>
                  <button class="more" @click.stop="openNodeMenu($event, node)"><Icon type="md-more" /></button>
                </div>
                <div class="wave">
                  <span v-for="n in 22" :key="n" :style="{ height: 8 + ((n * 13) % 28) + 'px' }" />
                </div>
                <div class="audio-foot">
                  <Icon type="ios-play" />
                  <span>{{ node.data?.params?.duration || '00:30' }}</span>
                  <em>音频</em>
                  <em v-if="statusText(node)" :class="node.data?.status">{{ statusText(node) }}</em>
                </div>
              </div>
            </template>

            <!-- 静默态：定时生成组 -->
            <template v-else-if="store.activeId !== node.id && node.type === 'schedule'">
              <div class="sched-card" @pointerdown.stop="onCardSurfaceDown($event, node)">
                <header class="sc-head">
                  <span class="type-badge schedule">定时生成组</span>
                  <b>{{ node.data?.title || `夜间批量 · ${scheduleMemberCount(node)} 卡` }}</b>
                  <button class="more" @click.stop="openNodeMenu($event, node)"><Icon type="md-more" /></button>
                </header>
                <div class="sc-row"><span>起始时间</span><em>{{ node.data?.schedule?.startAt || '03:00' }} {{ runTypeText(node) }}</em></div>
                <div class="sc-row"><span>并发</span><em>{{ node.data?.schedule?.concurrency || 2 }} 路</em></div>
                <div class="sc-row"><span>失败备用</span><em class="ok">{{ node.data?.schedule?.backup || '主通道' }}</em></div>
                <div class="sc-foot">
                  <div class="sc-thumbs">
                    <img
                      v-for="m in scheduleThumbNodes(node).slice(0, 3)"
                      :key="m.id"
                      :src="mediaUrl(m)"
                      alt=""
                    />
                    <span v-if="scheduleMemberCount(node) > 3">+{{ scheduleMemberCount(node) - 3 }}</span>
                    <span v-if="!scheduleMemberCount(node)" class="empty">队列为空</span>
                  </div>
                  <button class="btn-tail sm" @click.stop="openSchedule(node)">编辑排程</button>
                </div>
              </div>
            </template>

            <!-- 静默态：其他 -->
            <template v-else-if="store.activeId !== node.id && node.type !== 'zone'">
              <div class="media silent compact">
                <div class="placeholder">
                  <template v-if="node.type === 'group'">组合 · {{ (node.data?.members || []).length }}</template>
                  <template v-else-if="node.type === 'director'">3D 导演台</template>
                  <template v-else-if="node.type === 'quick'">
                    <span class="type-badge quick">快速视频</span>
                    <div class="q-prompt">{{ (node.data?.prompt || '写提示词，敲 @ 引用').slice(0, 48) }}</div>
                  </template>
                  <template v-else>{{ presetLabel(node.type) }}</template>
                </div>
              </div>
              <div v-if="node.type !== 'quick'" class="silent-meta">
                <div class="silent-title"><span>{{ cardTitle(node) }}</span></div>
              </div>
            </template>

            <!-- 展开态 -->
            <div
              v-if="store.activeId === node.id && node.type !== 'zone'"
              class="card-open"
              :class="node.type"
              @pointerdown="onCardSurfaceDown($event, node)"
            >
              <header class="co-head" data-drag-handle>
                <div class="co-left">
                  <span class="type-badge solid" :class="node.type">{{ shortTypeLabel(node.type) }}</span>
                  <b>{{ cardTitle(node) }}</b>
                </div>
                <div class="co-right">
                  <span v-if="node.data?.status === 'running'" class="run-pill">
                    <Icon type="ios-sync" class="spin-ico" />
                    生成中 {{ runElapsed(node) }}
                  </span>
                  <span v-else-if="statusText(node)" class="st-badge" :class="node.data?.status">{{ statusText(node) }}</span>
                  <span v-if="node.type === 'quick'" class="st-badge muted">不连线</span>
                  <button class="icon-btn sm" @click.stop="openNodeMenu($event, node)"><Icon type="md-more" /></button>
                </div>
              </header>

              <div v-if="node.type !== 'audio' && node.type !== 'schedule' && node.type !== 'group'" class="co-media" data-drag-handle>
                <img v-if="mediaUrl(node)" :src="mediaUrl(node)" alt="" draggable="false" />
                <div v-else-if="node.data?.status === 'running'" class="placeholder running dash">
                  <div class="run-ico" :class="node.type">
                    <Icon :type="node.type === 'video' || node.type === 'quick' ? 'ios-film' : 'ios-image'" />
                  </div>
                  <div class="ov-title">{{ renderStepHint(node) }}</div>
                  <div class="ov-bar"><i :style="{ width: progressOf(node) + '%' }" /></div>
                </div>
                <div v-else-if="node.data?.status === 'failed'" class="placeholder fail dash">
                  <div class="ov-x">✕</div>
                  <div class="ov-title">生成失败</div>
                  <div class="ov-sub">{{ node.data?.error || '请检查通道或稍后重试' }}</div>
                </div>
                <div v-else class="placeholder dash" :class="node.type">
                  <Icon :type="node.type === 'video' || node.type === 'quick' ? 'ios-videocam' : 'ios-image'" />
                  <span>{{ emptyHint(node) }}</span>
                </div>
                <div v-if="mediaUrl(node)" class="co-media-bar">
                  <div class="mb-left">
                    <button class="play"><Icon type="ios-play" /></button>
                    <span>{{ mediaMeta(node) }}</span>
                  </div>
                  <div class="mb-right">
                    <button title="打开" @click="openMedia(node)"><Icon type="ios-open-outline" /></button>
                    <button title="放大"><Icon type="md-expand" /></button>
                  </div>
                </div>
              </div>

              <div v-if="node.type === 'audio'" class="wave tall">
                <span v-for="n in 28" :key="n" :style="{ height: 10 + ((n * 17) % 36) + 'px' }" />
              </div>

              <!-- 生成中：任务行 + 取消 -->
              <div v-if="isGenerative(node.type) && node.data?.status === 'running'" class="co-task">
                <span class="task-line">任务 {{ shortTask(node) }} · {{ modelLabel(node) }} {{ queueHint(node) }}</span>
                <button class="btn-cancel" @click="cancelGen(node)">取消生成</button>
              </div>

              <div v-if="isGenerative(node.type)" class="co-model">
                <span class="lbl">模型</span>
                <Select
                  v-model="node.data.model"
                  filterable
                  transfer
                  transfer-class-name="dark-select-drop"
                  size="small"
                  class="model-sel"
                  @on-change="onModelChange(node)"
                >
                  <Option v-for="m in modelOptions(node.type)" :key="m.value" :value="m.value">{{ m.label }}</Option>
                </Select>
                <button class="btn-backup" @click="toggleBackupChannel(node)">{{ channelLabel(node) === '主通道' ? '备用通道' : channelLabel(node) }}</button>
              </div>

              <div v-if="isGenerative(node.type) && node.type !== 'audio' && node.data?.status !== 'running'" class="co-refs">
                <span class="lbl">参考</span>
                <div
                  v-for="refn in incoming(node.id).slice(0, 4)"
                  :key="refn.edge.id"
                  class="ref-thumb"
                  :title="numberLabel(refn.node)"
                >
                  <img v-if="mediaUrl(refn.node)" :src="mediaUrl(refn.node)" alt="" />
                  <span v-else>{{ numberLabel(refn.node) }}</span>
                  <button class="x" @click="unlinkEdge(refn.edge)">×</button>
                </div>
                <button class="ref-add" title="连线加入参考">+</button>
                <span class="ref-hint">{{ incoming(node.id).length ? '' : '拖入或将卡片连到此卡' }}</span>
                <button
                  v-if="node.type === 'video' && incoming(node.id).length >= 2"
                  class="btn-ghost sm"
                  @click="swapFrames(node)"
                >互换首尾帧</button>
              </div>

              <div v-if="isGenerative(node.type)" class="co-prompt">
                <div v-if="promptPillItems(node).length" class="pill-row in-prompt">
                  <button
                    v-for="p in promptPillItems(node)"
                    :key="p.tag"
                    type="button"
                    class="pill rich"
                    :class="p.tone"
                    @mousedown.prevent
                  >
                    <span
                      class="pill-thumb"
                      title="点击放大"
                      @click.stop="previewMention(p)"
                    >
                      <img v-if="p.thumb" :src="p.thumb" alt="" />
                      <i v-else class="ph"><Icon :type="p.icon" /></i>
                      <em v-if="p.tone === 'video'" class="play-mini"><Icon type="ios-play" /></em>
                    </span>
                    <span class="pill-text">@{{ p.tag }}</span>
                    <i class="pill-x" title="移除引用" @click.stop="removePromptTag(node, p.tag)">×</i>
                  </button>
                </div>
                <Input
                  :ref="(el) => setPromptRef(node.id, el)"
                  :model-value="promptFreeText(node)"
                  type="textarea"
                  :rows="3"
                  :placeholder="placeholder(node.type)"
                  @on-change="(e) => onPromptFreeChange(node, e)"
                  @on-keydown="onPromptKey($event, node)"
                />
                <div v-if="mention && mention.nodeId === node.id" class="mention" @pointerdown.stop>
                  <div class="mention-head">
                    <span>共 {{ mentionHits.length }} 条 · 可多选 · Space 勾选 · Enter 插入</span>
                    <span class="muted">点缩略图可放大</span>
                  </div>
                  <div class="mention-search">
                    <Icon type="ios-search" />
                    <input
                      class="mention-search-input"
                      :value="mention.filter || ''"
                      type="text"
                      placeholder="单独搜索名称/编号（可选）"
                      @input="onMentionFilterInput($event)"
                      @keydown.stop="onMentionSearchKey($event, node)"
                      @pointerdown.stop
                    />
                    <button
                      v-if="mention.filter"
                      type="button"
                      class="clear"
                      @mousedown.prevent="clearMentionFilter()"
                    >×</button>
                  </div>
                  <div v-if="!mentionHits.length" class="mention-empty">没有匹配的卡片</div>
                  <div
                    v-for="(item, idx) in mentionHits"
                    :key="item.id"
                    class="mention-item"
                    :class="{ on: idx === mention.index, checked: isMentionChecked(item.id) }"
                    @mousedown.prevent="toggleMentionCheck(item)"
                  >
                    <span class="mention-check" :class="{ on: isMentionChecked(item.id) }">
                      <Icon v-if="isMentionChecked(item.id)" type="md-checkmark" />
                    </span>
                    <button
                      class="mention-thumb"
                      :class="item.type"
                      type="button"
                      title="点击放大预览"
                      @mousedown.stop.prevent="previewMention(item)"
                      @click.stop.prevent="previewMention(item)"
                    >
                      <img v-if="item.thumb" :src="item.thumb" alt="" />
                      <span v-else class="ph"><Icon :type="item.type === 'video' || item.type === 'quick' ? 'ios-videocam' : item.type === 'audio' ? 'ios-musical-notes' : 'ios-image'" /></span>
                      <i v-if="item.type === 'video' || item.type === 'quick'" class="play-mini"><Icon type="ios-play" /></i>
                    </button>
                    <div class="mention-meta">
                      <div class="mention-title">
                        <i class="dot" :class="item.type" />
                        <b>{{ item.tag }}</b>
                        <em class="type-mini" :class="item.type">{{ shortTypeLabel(item.type) }}</em>
                      </div>
                      <div class="mention-sub muted">{{ item.title }}</div>
                    </div>
                  </div>
                  <div class="mention-foot">
                    <button type="button" class="linkish" @mousedown.prevent="clearMentionChecks()">清空</button>
                    <span class="muted">已选 {{ mentionCheckedCount }}</span>
                    <button
                      type="button"
                      class="btn-insert"
                      :disabled="!mentionCheckedCount"
                      @mousedown.prevent="applyMentionSelection(node)"
                    >插入已选 {{ mentionCheckedCount || '' }}</button>
                  </div>
                </div>
              </div>

              <div v-if="isGenerative(node.type)" class="co-params">
                <button
                  v-for="def in defsOf(node)"
                  :key="def.key"
                  class="chip-param"
                  @click="cycleParam(node, def)"
                >{{ paramChipText(node, def) }}</button>
                <button class="chip-param" @click="cycleSeed(node)">{{ seedChip(node) }}</button>
              </div>

              <div v-if="(node.data?.history || []).length" class="hist">
                <div class="hist-label">生成历史 {{ node.data.history.length }}</div>
                <div class="hist-row">
                  <button
                    v-for="h in node.data.history.slice(0, 8)"
                    :key="h.id"
                    class="hist-thumb"
                    :class="{ on: mediaUrl(node) === h.url }"
                    @click="store.restoreCardHistory(node.id, h.id)"
                  >
                    <img v-if="h.thumb" :src="h.thumb" alt="" />
                  </button>
                </div>
              </div>

              <div v-if="node.data?.status === 'failed'" class="co-fail-bar">
                <button class="btn-regen" @click="generate(node)">重试生成</button>
                <button class="btn-ghost" @click="store.taskOpen = true">查看日志</button>
              </div>

              <div v-else-if="isGenerative(node.type) && node.data?.status !== 'running'" class="co-acts">
                <button class="btn-regen" @click="generate(node)">
                  {{ node.data?.status === 'done' ? '再次生成' : node.type === 'quick' ? '快速生成' : '生成' }}
                </button>
                <button
                  v-if="(node.type === 'video' || node.type === 'quick') && mediaUrl(node)"
                  class="btn-tail"
                  @click="tailFrame(node)"
                >提取尾帧</button>
              </div>

              <div v-if="node.type === 'schedule'" class="co-acts">
                <button class="btn-ghost" @click="openSchedule(node)">编辑排程</button>
              </div>
              <div v-else-if="node.type === 'director'" class="co-acts">
                <button class="btn-ghost" @click="openDirector(node)">打开导演台</button>
              </div>
              <div v-else-if="node.type === 'group'" class="co-acts">
                <button class="btn-ghost" @click="showGroupMembers(node)">成员</button>
              </div>

              <div v-if="node.type === 'schedule'" class="sched-brief">
                <div>每日 {{ node.data?.schedule?.startAt || '03:00' }} · 并发 {{ node.data?.schedule?.concurrency || 2 }}</div>
                <div class="muted">队列 {{ (node.data?.members || []).length }} 卡</div>
              </div>
            </div>

            <i
              v-if="node.type !== 'zone'"
              class="port in"
              title="入线点"
              @pointerdown.stop.prevent="startLink($event, node, 'in')"
            />
            <i
              v-if="node.type !== 'quick' && node.type !== 'zone'"
              class="port out"
              title="出线点"
              @pointerdown.stop.prevent="startLink($event, node, 'out')"
            />
            <i
              v-if="node.type !== 'zone' && (store.selection.includes(node.id) || store.activeId === node.id)"
              class="resize-handle"
              title="拖动改变卡片大小"
              @pointerdown.stop.prevent="startResize($event, node)"
            />
          </div>

          <!-- 连线交互层：盖在卡片之上，只响应线/中点，不挡空白拖拽 -->
          <svg class="edges-ui" :width="8000" :height="6000">
            <g
              v-for="e in store.edges"
              :key="'ui-' + e.id"
              class="edge-g"
              :class="{ on: hoverEdgeId === e.id }"
              @pointerenter="setHoverEdge(e.id)"
              @pointerleave="clearHoverEdge(e.id)"
            >
              <path :d="edgePath(e)" class="edge-hit" />
            </g>
          </svg>
          <template v-for="e in store.edges" :key="'x-' + e.id">
            <button
              v-if="hoverEdgeId === e.id && edgeMid(e)"
              class="edge-x-btn"
              :style="edgeXStyle(e)"
              title="断开连线"
              @pointerenter="setHoverEdge(e.id)"
              @pointerleave="clearHoverEdge(e.id)"
              @pointerdown.stop.prevent
              @click.stop="unlinkEdge(e)"
            >×</button>
          </template>
        </div>

        <div v-if="!store.nodes.length" class="board-empty">
          <div class="board-empty-card">
            <div class="board-empty-title">这块画布还是空的</div>
            <ul>
              <li><b>双击空白处</b>新建图片卡</li>
              <li>左侧点 <b>图片 / 视频</b> 添加卡片</li>
              <li>把素材 <b>拖进画布</b> 或从素材库建卡</li>
            </ul>
            <div class="board-empty-foot">卡片之间拉线连参考，敲 <b>@</b> 引用画布素材</div>
          </div>
        </div>

        <div
          v-if="marquee"
          class="marquee"
          :style="{ left: marquee.left + 'px', top: marquee.top + 'px', width: marquee.width + 'px', height: marquee.height + 'px' }"
        />

        <div class="zoom-box">
          <button @click="zoomBy(0.9)">−</button>
          <div>{{ Math.round(store.viewport.scale * 100) }}%</div>
          <button @click="zoomBy(1.1)">+</button>
          <i class="zb-sep" />
          <button class="txt" @click="store.fitView(vpW, vpH)">适应窗口</button>
          <button class="txt" @click="store.resetOrigin()">原点</button>
        </div>
        <div class="hint-bar">虚线箭头 = 参考关系 · 区域可拖动分区 · 快速视频用 @ 引用不连线</div>
        <div v-if="showMini" class="mini-wrap">
          <canvas ref="miniEl" class="minimap" width="212" height="104" @click="onMiniClick" />
          <div class="mini-foot">
            <span>小地图</span>
            <span>{{ cardCount }} 卡 · {{ zoneCount }} 区</span>
          </div>
        </div>
      </div>
      </div>

      <aside class="side-rail">
        <button title="素材库" @click="store.libraryOpen = true"><Icon type="ios-folder-outline" /></button>
        <button title="任务中心" @click="store.taskOpen = true"><Icon type="ios-list-box-outline" /></button>
        <button title="历史" @click="doUndo"><Icon type="ios-time-outline" /></button>
        <i class="side-sep" />
        <button title="设置" @click="$router.push('/settings')"><Icon type="ios-settings-outline" /></button>
      </aside>
    </div>

    <Drawer v-model="store.taskOpen" title="生成任务" width="420">
      <div v-for="t in tasks" :key="t.id" class="task-row">
        <div><b>{{ t.kind }}</b> · {{ t.status }}</div>
        <div class="muted">{{ (t.prompt || '').slice(0, 60) }}</div>
        <a v-if="t.nodeId" @click="store.focusNode(t.nodeId, vpW, vpH)">跳转卡片</a>
        <a v-if="isActiveTask(t)" class="danger" @click="api.cancelTask(t.id).then(loadTasks)">取消</a>
      </div>
    </Drawer>

    <LibraryDrawer v-model="store.libraryOpen" />

    <div v-if="store.scheduleOpen" class="sched-mask" @click.self="store.scheduleOpen = false">
      <div class="sched-panel" @pointerdown.stop>
        <header class="sp-head">
          <div class="sp-title">
            <span class="sp-ico">时</span>
            <div>
              <div class="sp-row"><b>定时生成组 · 夜间批量</b><em class="on">已启用</em></div>
              <div class="sp-sub">挂机运行 · 失败自动切备用通道</div>
            </div>
          </div>
          <button class="icon-btn" @click="store.scheduleOpen = false"><Icon type="md-close" /></button>
        </header>
        <div class="sp-next">
          <div>
            <div class="sp-label">下次运行</div>
            <div class="sp-val">{{ scheduleForm.startAt || '03:00' }} · {{ runTypeLabel(scheduleForm.runType) }}</div>
          </div>
          <button class="btn-tail" @click="startSchedule">立即试跑</button>
        </div>
        <div class="sp-form">
          <div class="sp-line">
            <span class="k">运行方式</span>
            <div class="seg">
              <button :class="{ on: scheduleForm.runType === 'daily' }" @click="scheduleForm.runType = 'daily'">每日定时</button>
              <button :class="{ on: scheduleForm.runType === 'once' }" @click="scheduleForm.runType = 'once'">仅一次</button>
              <button :class="{ on: scheduleForm.runType === 'interval' }" @click="scheduleForm.runType = 'interval'">固定间隔</button>
            </div>
          </div>
          <div class="sp-line">
            <span class="k">起始时间</span>
            <input v-model="scheduleForm.startAt" class="sp-input" placeholder="03:00" />
            <span class="sp-hint">本机时区</span>
          </div>
          <div class="sp-line">
            <span class="k">并发</span>
            <input v-model.number="scheduleForm.concurrency" class="sp-input sm" type="number" min="1" max="10" />
            <span class="sp-hint">路并行</span>
            <input v-model.number="scheduleForm.interval" class="sp-input sm" type="number" min="0" />
            <span class="sp-hint">间隔秒</span>
          </div>
          <div class="sp-line">
            <span class="k">失败策略</span>
            <label class="sp-radio"><input v-model="scheduleForm.fail" type="radio" value="retry" /> 重试后跳过</label>
            <label class="sp-radio"><input v-model="scheduleForm.fail" type="radio" value="skip" /> 直接跳过</label>
            <label class="sp-radio"><input v-model="scheduleForm.fail" type="radio" value="abort" /> 中止整组</label>
          </div>
        </div>
        <div class="sp-queue-head">
          <b>卡片队列 · {{ scheduleMembers.length }}</b>
          <button class="linkish" @click="addSelectedToSchedule">把选中卡片加入</button>
        </div>
        <div class="sp-queue">
          <div v-for="(m, i) in scheduleMembers" :key="m.id" class="sp-q">
            <span class="handle">⋮⋮</span>
            <i class="dot" :class="m.type" />
            <div class="sp-q-main">
              <b>{{ numberLabel(m) }} · {{ m.data?.title || m.data?.prompt || m.type }}</b>
            </div>
            <button class="linkish" @click="removeFromSchedule(m.id)">移除</button>
          </div>
          <button v-if="!scheduleMembers.length" class="sp-add" @click="addSelectedToSchedule">+ 从画布选择卡片加入队列</button>
        </div>
        <footer class="sp-foot">
          <div class="sp-hint">队列 {{ scheduleMembers.length }} 卡 · 并发 {{ scheduleForm.concurrency || 2 }}</div>
          <div class="sp-acts">
            <button class="btn-ghost" @click="store.scheduleOpen = false">取消</button>
            <button class="btn-ghost" @click="stopSchedule">停止</button>
            <button class="btn-regen" @click="saveSchedule">保存配置</button>
          </div>
        </footer>
      </div>
    </div>

    <Modal v-model="store.directorOpen" title="3D 导演台" fullscreen footer-hide>
      <DirectorStage :node-id="store.directorNodeId" @close="store.directorOpen = false" @shot="onDirectorShot" />
    </Modal>

    <Modal v-model="tailOpen" title="尾部提示词" :footer-hide="true" width="520">
      <Input v-model="tailDraft" type="textarea" :rows="5" placeholder="生成时自动接在提示词后面，如：电影感, 胶片颗粒" />
      <div class="sched-foot" style="margin-top:12px">
        <Space>
          <Button @click="tailOpen = false">取消</Button>
          <Button type="primary" @click="saveTail">保存</Button>
        </Space>
      </div>
    </Modal>

    <div v-if="mediaPreview" class="media-preview" @click.self="mediaPreview = null" @pointerdown.stop>
      <div class="mp-card">
        <header class="mp-head">
          <div class="mp-title">
            <span class="type-badge solid" :class="mediaPreview.type">{{ shortTypeLabel(mediaPreview.type) }}</span>
            <b>{{ mediaPreview.tag || mediaPreview.title }}</b>
          </div>
          <button class="icon-btn" @click="mediaPreview = null"><Icon type="md-close" /></button>
        </header>
        <div class="mp-body">
          <img v-if="mediaPreview.url && mediaPreview.type !== 'audio'" :src="mediaPreview.url" alt="" />
          <div v-else class="mp-empty">暂无预览</div>
        </div>
        <div class="mp-foot muted">{{ mediaPreview.title }}</div>
      </div>
    </div>

    <div v-if="menu" class="ctx" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @pointerdown.stop>
      <div class="item" @click="menuAction('open')"><span>展开卡片面板</span><kbd>Enter</kbd></div>
      <div class="item" @click="menuAction('copy')"><span>复制卡片</span><kbd>Ctrl+D</kbd></div>
      <div v-if="menuCanTail" class="item" @click="menuAction('tail')">提取尾帧为图片卡</div>
      <div v-if="menuCanLink" class="item" @click="menuAction('link-out')">从此卡拉出参考线</div>
      <div class="item" @click="menuAction('refs')"><span>查找引用 / 被引用</span><span class="muted">{{ menuRefCount }}</span></div>
      <div class="sep" />
      <div class="item" @click="menuAction('group')">加入组合</div>
      <div class="item" @click="menuAction('zone')"><span>移入区域…</span><span>›</span></div>
      <div class="item" @click="menuAction('focus')">定位到此卡</div>
      <div class="sep" />
      <div class="item danger" @click="menuAction('delete')"><span>删除卡片</span><kbd>Del</kbd></div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Message, Modal } from 'view-ui-plus';
import { api } from '@/api/client';
import { useCanvasStore, PRESETS, uid } from '@/stores/canvas';
import { paramDefsOf, seedParams } from '@/utils/paramDefs';
import { insertRawTag, kindLabel, tagsOf, toShown } from '@/utils/mentions';
import LibraryDrawer from '@/components/LibraryDrawer.vue';
import DirectorStage from '@/components/DirectorStage.vue';

const route = useRoute();
const router = useRouter();
const store = useCanvasStore();
const viewportEl = ref(null);
const miniEl = ref(null);
const fileInput = ref(null);
const railThin = ref(false);
const showGrid = ref(true);
const showMini = ref(true);
const moreOpen = ref(false);
const vpW = ref(1200);
const vpH = ref(800);
const tasks = ref([]);
const menu = ref(null);
const linking = ref(null);
const linkHoverId = ref('');
const hoverEdgeId = ref('');
const mention = ref(null);
const marquee = ref(null);
const spaceDown = ref(false);
const typeFilter = ref('');
const mediaPreview = ref(null);
const tailOpen = ref(false);
const tailDraft = ref('');
const tailLabel = ref('电影感');
const promptRefs = reactive({});
const drag = reactive({
  mode: '',
  id: '',
  ox: 0,
  oy: 0,
  vx: 0,
  vy: 0,
  moved: false,
  origins: null,
  additive: false,
  startClientX: 0,
  startClientY: 0,
  rw: 0,
  rh: 0,
});
const scheduleForm = reactive({
  startAt: '03:00',
  mode: 'stagger',
  runType: 'daily',
  fail: 'retry',
  interval: 30,
  concurrency: 2,
  backup: '主通道',
  nodeId: '',
});
const channelBrief = ref([]);
const libraryCount = ref(0);
const clock = ref('');
const typeFilters = [
  { id: 'image', label: '图' },
  { id: 'video', label: '视频' },
  { id: 'quick', label: '快' },
  { id: 'audio', label: '音' },
];

let taskTimer = 0;
let miniTimer = 0;
let clockTimer = 0;

const filteredHits = computed(() => {
  let list = store.nodes;
  if (typeFilter.value === 'image') list = list.filter((n) => n.type === 'image');
  else if (typeFilter.value === 'video') list = list.filter((n) => n.type === 'video' || n.type === 'quick');
  else if (typeFilter.value === 'other') list = list.filter((n) => !['image', 'video', 'quick'].includes(n.type));
  const q = String(store.findQuery || '').trim().toLowerCase();
  if (q) list = list.filter((n) => String(n.data?.title || n.data?.prompt || n.type).toLowerCase().includes(q));
  return list.slice(0, 10);
});
const isHand = computed(() => store.tool === 'hand' || spaceDown.value);
const worldStyle = computed(() => ({
  transform: `translate(${store.viewport.x}px, ${store.viewport.y}px) scale(${store.viewport.scale})`,
}));
const saveLabel = computed(() => {
  if (store.saveState === 'saving') return '保存中…';
  if (store.saveState === 'dirty') return '未保存';
  if (store.saveState === 'failed') return '保存失败';
  return '已保存';
});
const runningTasks = computed(() =>
  tasks.value.filter((t) => ['running', 'queued', 'pending', 'waiting', 'rendering'].includes(String(t.status || '').toLowerCase())).length
);
const zoneCount = computed(() => store.nodes.filter((n) => n.type === 'zone').length);
const cardCount = computed(() => store.nodes.filter((n) => n.type !== 'zone').length);
const selectionHint = computed(() => {
  const nodes = store.selectedNodes;
  const img = nodes.filter((n) => n.type === 'image').length;
  const vid = nodes.filter((n) => n.type === 'video' || n.type === 'quick').length;
  return `图片 ${img} · 视频 ${vid}`;
});
const menuNode = computed(() => store.nodes.find((n) => n.id === menu.value?.nodeId) || null);
const menuCanTail = computed(() => ['video', 'quick'].includes(menuNode.value?.type));
const menuCanLink = computed(() => menuNode.value && menuNode.value.type !== 'quick');
const menuRefCount = computed(() => {
  const id = menu.value?.nodeId;
  if (!id) return '0 / 0';
  const out = store.edges.filter((e) => (e.source || e.sourceId || e.source_id) === id).length;
  const inn = store.edges.filter((e) => (e.target || e.targetId || e.target_id) === id).length;
  return `${out} / ${inn}`;
});
const linkPreview = computed(() => {
  if (!linking.value) return '';
  const { x1, y1, x2, y2 } = linking.value;
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
});
const mentionHits = computed(() => {
  if (!mention.value) return [];
  // 优先用搜索框；否则用提示词里 @ 后面正在输入的片段
  const q = String(mention.value.filter || mention.value.q || '').trim().toLowerCase();
  const list = store.nodes
    .filter((n) => ['image', 'video', 'audio', 'quick'].includes(n.type))
    .map((n) => ({
      id: n.id,
      type: n.type,
      tag: numberLabel(n),
      title: n.data?.title || toShown(n.data?.prompt || '').slice(0, 48) || n.type,
      typeLabel: shortTypeLabel(n.type),
      thumb: mediaUrl(n) || n.data?.thumb || '',
      url: mediaUrl(n) || n.data?.thumb || '',
    }))
    .filter((item) => {
      if (!q) return true;
      return (
        item.tag.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q) ||
        item.typeLabel.toLowerCase().includes(q) ||
        item.type.toLowerCase().includes(q)
      );
    });
  return list.slice(0, q ? 30 : 12);
});
const mentionCheckedCount = computed(() => (mention.value?.checked || []).length);
const scheduleMembers = computed(() => {
  const s = store.nodes.find((n) => n.id === scheduleForm.nodeId);
  if (!s) return [];
  return (s.data?.members || []).map((id) => store.nodes.find((n) => n.id === id)).filter(Boolean);
});

function scheduleMemberCount(node) {
  return (node?.data?.members || []).length;
}
function scheduleThumbNodes(node) {
  return (node?.data?.members || [])
    .map((id) => store.nodes.find((n) => n.id === id))
    .filter((n) => n && mediaUrl(n));
}
function runTypeText(node) {
  const t = node?.data?.schedule?.runType || 'daily';
  if (t === 'once') return '仅一次';
  if (t === 'interval') return '固定间隔';
  return '每日';
}
function runTypeLabel(t) {
  if (t === 'once') return '仅一次';
  if (t === 'interval') return '固定间隔';
  return '每日定时';
}

function setPromptRef(id, el) {
  if (el) promptRefs[id] = el;
}
function presetLabel(type) {
  return PRESETS[type]?.label || type;
}
function isGenerative(type) {
  return ['image', 'video', 'quick', 'audio'].includes(type);
}
function placeholder(type) {
  if (type === 'quick') return '写提示词，敲 @ 引用素材（无需连线）';
  return '写提示词，敲 @ 插入引用';
}
function nodeStyle(node) {
  const expanded = store.activeId === node.id && node.type !== 'zone';
  let w = node.w || 280;
  if (expanded && isGenerative(node.type)) w = Math.max(w, node.type === 'audio' ? 280 : 400);
  if (node.type === 'schedule') w = Math.max(w, 336);
  return {
    left: node.x + 'px',
    top: node.y + 'px',
    width: w + 'px',
    height: node.type === 'zone' ? (node.h || 420) + 'px' : undefined,
    zIndex: node.type === 'zone' ? 0 : store.activeId === node.id ? 20 : node.z || 1,
    minHeight: node.type === 'zone' ? undefined : expanded ? undefined : node.type === 'schedule' ? undefined : (node.h || 132) + 'px',
  };
}
function mediaUrl(node) {
  const d = node.data || {};
  return d.url || d.thumb || d.resultUrl || '';
}
function cardTitle(node) {
  return node.data?.title || node.data?.prompt?.slice?.(0, 18) || numberLabel(node) || presetLabel(node.type);
}
function silentLine(node) {
  const bits = [];
  if (statusText(node)) bits.push(statusText(node));
  if (node.data?.width && node.data?.height) bits.push(`${node.data.width}×${node.data.height}`);
  else if (node.data?.params?.ratio) bits.push(node.data.params.ratio);
  else if (node.data?.params?.duration) bits.push(String(node.data.params.duration).includes('s') ? node.data.params.duration : `${node.data.params.duration}s`);
  else if (node.type === 'image') bits.push('16:9');
  else if (node.type === 'video' || node.type === 'quick') bits.push(node.data?.params?.duration || '5s');
  return bits.join(' · ') || presetLabel(node.type);
}
function emptyHint(node) {
  if (node.type === 'image') return '等待尾帧 / 出图';
  if (node.type === 'video' || node.type === 'quick') return '等待生成';
  return '暂无预览';
}
function progressOf(node) {
  const p = Number(node.data?.progress);
  if (Number.isFinite(p) && p > 0) return Math.min(100, p);
  const step = Number(node.data?.step);
  const total = Number(node.data?.totalSteps) || 5;
  if (Number.isFinite(step) && step > 0) return Math.min(100, Math.round((step / total) * 100));
  if (node.data?.startedAt) {
    const sec = Math.max(0, Math.floor((Date.now() - Number(node.data.startedAt)) / 1000));
    return Math.min(92, 18 + sec * 2);
  }
  return 42;
}
function fmtMmSs(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
function runElapsed(node) {
  void clock.value; // 每秒刷新生成用时
  if (node.data?.elapsed) return String(node.data.elapsed);
  const t0 = Number(node.data?.startedAt);
  if (t0) return fmtMmSs((Date.now() - t0) / 1000);
  return '00:00';
}
function renderStepHint(node) {
  const total = Number(node.data?.totalSteps) || 5;
  let step = Number(node.data?.step);
  if (!Number.isFinite(step) || step <= 0) {
    step = Math.max(1, Math.min(total, Math.ceil((progressOf(node) / 100) * total)));
  }
  const remain = node.data?.eta || fmtMmSs(Math.max(8, (total - step) * 14));
  return `正在渲染第 ${step} / ${total} 步 · 预计还需 ${remain}`;
}
function queueHint(node) {
  if (node.data?.queue) return String(node.data.queue);
  return 'GPU 队列 2/3';
}
function shortTypeLabel(type) {
  if (type === 'image') return '图片';
  if (type === 'video') return '视频';
  if (type === 'quick') return '快视';
  if (type === 'audio') return '音频';
  return presetLabel(type);
}
function seedChip(node) {
  const v = node.data?.params?.seed;
  if (v == null || v === '' || v === 'random') return '随机';
  return String(v);
}
function cycleSeed(node) {
  if (!node.data.params) node.data.params = {};
  const cur = node.data.params.seed;
  if (cur == null || cur === '' || cur === 'random') node.data.params.seed = String(Math.floor(Math.random() * 9999));
  else node.data.params.seed = 'random';
  store.scheduleSave();
}
function toggleBackupChannel(node) {
  const list = channelBrief.value || [];
  if (!list.length) {
    Message.info('暂无可用通道');
    return;
  }
  const cur = node.data?.channelId || list[0]?.id;
  const i = Math.max(0, list.findIndex((c) => c.id === cur));
  const next = list[(i + 1) % list.length];
  store.updateNodeData(node.id, { channelId: next.id });
  Message.success(`已切换到 ${next.name || '通道'}`);
}
function runHint(node) {
  return renderStepHint(node);
}
function mediaMeta(node) {
  const p = node.data?.params || {};
  const parts = [];
  if (p.duration) parts.push(String(p.duration).includes('s') ? p.duration : `${p.duration}s`);
  else if (node.type === 'video' || node.type === 'quick') parts.push('00:05');
  parts.push(p.size || p.resolution || '1080p');
  if (p.fps) parts.push(`${p.fps}fps`);
  else if (node.type === 'video' || node.type === 'quick') parts.push('24fps');
  return parts.join(' · ');
}
function channelLabel(node) {
  const id = node.data?.channelId;
  if (!id) return '主通道';
  const hit = channelBrief.value.find((c) => c.id === id);
  return hit?.name || '主通道';
}
function modelLabel(node) {
  const opts = modelOptions(node.type);
  const hit = opts.find((m) => m.value === node.data?.model);
  return hit?.label || node.data?.model || '—';
}
function shortTask(node) {
  const id = String(node.data?.taskId || node.id || '');
  return '#' + id.slice(-4);
}
function promptPills(node) {
  return tagsOf(node.data?.prompt || '');
}
function promptFreeText(node) {
  // 输入框只显示正文，引用标签交给上方缩略图芯片，避免重复
  return String(node.data?.prompt || '')
    .replace(/@\[[^\]\n]+\]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s+/, '');
}
function rebuildPrompt(node, freeText, tags) {
  const list = Array.isArray(tags) ? tags : promptPills(node);
  const tagPart = list.map((t) => `@[${t}]`).join(' ');
  const body = String(freeText ?? '').replace(/@\[[^\]\n]+\]/g, '').trim();
  node.data.prompt = [tagPart, body].filter(Boolean).join(tagPart && body ? ' ' : '');
}
function onPromptFreeChange(node, e) {
  const val = typeof e === 'string' ? e : e?.target?.value ?? promptFreeText(node);
  // View UI 有时给的是事件，有时直接值；再读一次 input
  const raw =
    typeof val === 'string'
      ? val
      : e?.target?.value ??
        document.activeElement?.value ??
        promptFreeText(node);
  rebuildPrompt(node, raw, promptPills(node));
  store.scheduleSave();
}
function pillTone(tag) {
  if (/^快速视频|^视频|镜头|推轨/.test(tag)) return 'video';
  if (/^音频|环境/.test(tag)) return 'audio';
  return 'image';
}
function findNodeByTag(tag) {
  const t = String(tag || '');
  return (
    store.nodes.find((n) => numberLabel(n) === t) ||
    store.nodes.find((n) => (n.data?.title || '') === t) ||
    null
  );
}
function promptPillItems(node) {
  return promptPills(node).map((tag) => {
    const ref = findNodeByTag(tag);
    const tone = pillTone(tag);
    return {
      tag,
      tone,
      id: ref?.id || tag,
      type: ref?.type || (tone === 'video' ? 'video' : tone === 'audio' ? 'audio' : 'image'),
      title: ref?.data?.title || tag,
      thumb: ref ? mediaUrl(ref) || ref.data?.thumb || '' : '',
      url: ref ? mediaUrl(ref) || ref.data?.thumb || '' : '',
      icon:
        tone === 'video' ? 'ios-videocam' : tone === 'audio' ? 'ios-musical-notes' : 'ios-image',
    };
  });
}
function removePromptTag(node, tag) {
  const tags = promptPills(node).filter((t) => t !== tag);
  rebuildPrompt(node, promptFreeText(node), tags);
  const ref = findNodeByTag(tag);
  if (ref) {
    const edge = store.edges.find(
      (e) => edgeEnd(e, 'source') === ref.id && edgeEnd(e, 'target') === node.id
    );
    if (edge) store.removeEdge(edge.id);
    if (node.type === 'quick' && node.data?.quickRefs) {
      const qr = { ...node.data.quickRefs };
      delete qr[tag];
      node.data.quickRefs = qr;
    }
  }
  store.scheduleSave();
}
function paramChipText(node, def) {
  const v = node.data?.params?.[def.key];
  if (def.key === 'seed') return seedChip(node);
  if (def.key === 'motion') return `运动 ${v ?? ''}`;
  if (def.key === 'duration') return String(v || '').includes('s') ? v : `${v || 5}s`;
  if (def.key === 'resolution') return String(v || '').toUpperCase();
  if (def.key === 'mode') {
    return ({ reference: '全能参考', frames: '首尾帧', text: '纯文生' })[v] || v || def.label;
  }
  if (def.key === 'count') return `${v || 1} 张`;
  return String(v ?? def.label);
}
function cycleParam(node, def) {
  if (!node.data.params) node.data.params = {};
  const opts = def.options || [];
  if (!opts.length) return;
  const cur = node.data.params[def.key];
  const i = Math.max(0, opts.indexOf(cur));
  node.data.params[def.key] = opts[(i + 1) % opts.length];
  store.scheduleSave();
}
function zoneStats(node) {
  const cards = store.nodes.filter(
    (n) => n.type !== 'zone' && n.x >= node.x && n.y >= node.y && n.x + n.w <= node.x + node.w && n.y + n.h <= node.y + node.h
  );
  const ids = new Set(cards.map((c) => c.id));
  const links = store.edges.filter((e) => ids.has(edgeEnd(e, 'source')) || ids.has(edgeEnd(e, 'target'))).length;
  return `${cards.length}卡片 · ${links}连线`;
}
function toggleZone(node) {
  const folded = !node.data?.folded;
  store.updateNodeData(node.id, { folded });
  if (folded) {
    node._hBeforeFold = node.h;
    node.h = 48;
  } else if (node._hBeforeFold) {
    node.h = node._hBeforeFold;
  } else {
    node.h = store.preset('zone').h;
  }
  store.scheduleSave();
}
function renameZone(node) {
  const cur = node.data?.title || '区域';
  const next = window.prompt('区域名称（例如：第一幕 · 站台）', cur);
  if (next == null) return;
  const name = String(next).trim() || '区域';
  store.updateNodeData(node.id, { title: name });
  Message.success('区域已改名');
}
function startResize(e, node) {
  if (e.button !== 0) return;
  store.pushHistory();
  const p = toWorld(e.clientX, e.clientY);
  drag.mode = 'resize';
  drag.id = node.id;
  drag.ox = p.x;
  drag.oy = p.y;
  drag.rw = node.w || 280;
  drag.rh = node.h || 180;
  drag.moved = false;
  bindGlobalPointer();
}
function openMedia(node) {
  const url = mediaUrl(node);
  if (!url) return;
  mediaPreview.value = {
    type: node.type,
    tag: numberLabel(node),
    title: node.data?.title || toShown(node.data?.prompt || '') || url,
    url,
  };
}
function previewMention(item) {
  if (!item) return;
  if (!item.url && !item.thumb) {
    Message.info('该卡片还没有预览图');
    return;
  }
  mediaPreview.value = {
    type: item.type,
    tag: item.tag,
    title: item.title,
    url: item.url || item.thumb,
  };
}
function numberLabel(node) {
  if (!node) return '';
  if (node.type === 'zone') return '区域';
  if (node.type === 'group') return '组合';
  if (node.type === 'schedule') return '定时';
  if (node.type === 'director') return '导演';
  const same = store.nodes.filter((n) => n.type === node.type);
  const idx = same.findIndex((n) => n.id === node.id) + 1;
  return `${kindLabel(node.type)}${idx}`;
}
function modelOptions(type) {
  const key = type === 'quick' ? 'video' : type;
  const list = store.models?.[key] || store.models?.[`${key}s`] || [];
  return list.map((m) => ({
    value: m.id || m,
    label: m.label || m.id || m,
  }));
}
function defsOf(node) {
  return paramDefsOf(store.models, node);
}
function onModelChange(node) {
  const entry = modelOptions(node.type).find((m) => m.value === node.data.model);
  const seeded = seedParams(store.models, node.type, node.data.model);
  node.data.params = { ...seeded, ...(node.data.params || {}) };
  // keep compatible values
  defsOf(node).forEach((def) => {
    if (!def.options.includes(node.data.params[def.key])) {
      node.data.params[def.key] = def.options[0];
    }
  });
  if (entry) {
    const raw = (store.models[node.type === 'quick' ? 'video' : node.type] || []).find((m) => (m.id || m) === node.data.model);
    if (raw?.channelId) node.data.channelId = raw.channelId;
  }
  store.scheduleSave();
}
function incoming(nodeId) {
  return store.edges
    .filter((e) => edgeEnd(e, 'target') === nodeId)
    .map((edge) => ({
      edge,
      node: store.nodes.find((n) => n.id === edgeEnd(edge, 'source')),
    }))
    .filter((x) => x.node);
}
function edgeEnd(e, side) {
  if (side === 'source') return e.source || e.sourceId || e.source_id || '';
  return e.target || e.targetId || e.target_id || '';
}
function nodeBox(n) {
  const w = n.w || 200;
  const h = n.type === 'zone' ? n.h || 420 : n.h || 156;
  return { x: n.x, y: n.y, w, h, r: n.x + w, b: n.y + h };
}
function pointInNode(x, y, pad = 8) {
  return store.nodes.some((n) => {
    if (n.type === 'zone') return false;
    const b = nodeBox(n);
    return x >= b.x - pad && x <= b.r + pad && y >= b.y - pad && y <= b.b + pad;
  });
}
function edgeEnds(e) {
  const a = store.nodes.find((n) => n.id === edgeEnd(e, 'source'));
  const b = store.nodes.find((n) => n.id === edgeEnd(e, 'target'));
  if (!a || !b) return null;
  const aw = a.w || 200;
  const bw = b.w || 200;
  // 出线点对齐卡片右侧中部（接近 port 视觉位置）
  const x1 = a.x + aw;
  const y1 = a.y + Math.min(48, (a.h || 120) * 0.35);
  const x2 = b.x;
  const y2 = b.y + Math.min(48, (b.h || 120) * 0.35);
  return { a, b, x1, y1, x2, y2, cx: (x1 + x2) / 2 };
}
function edgePath(e) {
  const p = edgeEnds(e);
  if (!p) return '';
  return `M ${p.x1} ${p.y1} C ${p.cx} ${p.y1}, ${p.cx} ${p.y2}, ${p.x2} ${p.y2}`;
}
function edgeMid(e) {
  const p = edgeEnds(e);
  if (!p) return null;
  // 优先取两卡之间的空隙中心，避免 × 压在卡片上
  let x = (p.x1 + p.x2) / 2;
  let y = (p.y1 + p.y2) / 2;
  if (Math.abs(p.x2 - p.x1) > 40) {
    x = (p.x1 + p.x2) / 2;
    y = (p.y1 + p.y2) / 2;
  } else {
    // 纵向连线：放在曲线外侧空隙
    x = p.cx + 28;
    y = (p.y1 + p.y2) / 2;
  }
  // 若仍落在某张卡上，沿水平方向推出
  if (pointInNode(x, y)) {
    const left = Math.min(p.x1, p.x2);
    const right = Math.max(p.x1, p.x2);
    x = (left + right) / 2;
    y = (p.y1 + p.y2) / 2;
    if (pointInNode(x, y)) {
      x = p.cx;
      y = Math.min(p.y1, p.y2) - 24;
    }
    if (pointInNode(x, y)) {
      x = p.cx;
      y = Math.max(p.y1, p.y2) + 24;
    }
  }
  return { x, y };
}
let hoverEdgeTimer = 0;
function setHoverEdge(id) {
  if (hoverEdgeTimer) {
    clearTimeout(hoverEdgeTimer);
    hoverEdgeTimer = 0;
  }
  hoverEdgeId.value = id;
}
function clearHoverEdge(id) {
  if (hoverEdgeTimer) clearTimeout(hoverEdgeTimer);
  // 延迟清除，方便从线移到 × 按钮
  hoverEdgeTimer = setTimeout(() => {
    if (hoverEdgeId.value === id) hoverEdgeId.value = '';
    hoverEdgeTimer = 0;
  }, 120);
}
function edgeXStyle(e) {
  const m = edgeMid(e);
  if (!m) return { display: 'none' };
  return {
    left: m.x + 'px',
    top: m.y + 'px',
  };
}
function confirmAction({ title, content, okText = '确定', okType = 'error' }) {
  return new Promise((resolve) => {
    Modal.confirm({
      title,
      content,
      okText,
      cancelText: '取消',
      okType,
      className: 'dark-confirm',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}
async function unlinkEdge(e) {
  if (!e?.id) return;
  const ok = await confirmAction({
    title: '断开连线',
    content: '确定断开这两张卡片之间的连线吗？断开后参考关系也会一起清除。',
    okText: '断开',
  });
  if (!ok) return;
  store.removeEdge(e.id);
  clearHoverEdge(e.id);
  Message.success('已断开连线');
}
async function confirmRemoveNodes(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  const n = list.length;
  const ok = await confirmAction({
    title: n > 1 ? `删除 ${n} 张卡片` : '删除卡片',
    content: n > 1
      ? `确定删除选中的 ${n} 张卡片吗？相关连线也会一并清除，此操作可撤销。`
      : '确定删除这张卡片吗？相关连线也会一并清除，此操作可撤销。',
    okText: '删除',
  });
  if (!ok) return;
  store.removeNodes(list);
  Message.success(n > 1 ? `已删除 ${n} 张卡片` : '已删除');
}
function toWorld(clientX, clientY) {
  const rect = viewportEl.value.getBoundingClientRect();
  return {
    x: (clientX - rect.left - store.viewport.x) / store.viewport.scale,
    y: (clientY - rect.top - store.viewport.y) / store.viewport.scale,
  };
}
function statusText(node) {
  const st = node.data?.status;
  if (st === 'done') return '已完成';
  if (st === 'running') return '生成中';
  if (st === 'failed') return '失败';
  return '';
}
function zoomBy(factor) {
  const next = Math.min(2.5, Math.max(0.2, store.viewport.scale * factor));
  const cx = vpW.value / 2;
  const cy = vpH.value / 2;
  const wx = (cx - store.viewport.x) / store.viewport.scale;
  const wy = (cy - store.viewport.y) / store.viewport.scale;
  store.viewport = { scale: next, x: cx - wx * next, y: cy - wy * next };
}
function saveTail() {
  tailLabel.value = (tailDraft.value || '电影感').split(/[,，]/)[0].trim() || '电影感';
  localStorage.setItem('canvas.tailPrompt', tailDraft.value);
  tailOpen.value = false;
  Message.success('尾部提示词已保存');
}
function isDimmed(node) {
  if (!store.findQuery && !typeFilter.value) return false;
  let list = store.nodes;
  if (typeFilter.value === 'image') list = list.filter((n) => n.type === 'image');
  else if (typeFilter.value === 'video') list = list.filter((n) => n.type === 'video' || n.type === 'quick');
  else if (typeFilter.value === 'other') list = list.filter((n) => !['image', 'video', 'quick'].includes(n.type));
  const q = String(store.findQuery || '').trim().toLowerCase();
  if (q) list = list.filter((n) => String(n.data?.title || n.data?.prompt || n.type).toLowerCase().includes(q));
  return !list.some((n) => n.id === node.id);
}
function toggleType(id) {
  const set = new Set(store.filter.types);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  store.filter.types = [...set];
}
function onWheel(e) {
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  const next = Math.min(2.5, Math.max(0.2, store.viewport.scale * factor));
  const rect = viewportEl.value.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const wx = (cx - store.viewport.x) / store.viewport.scale;
  const wy = (cy - store.viewport.y) / store.viewport.scale;
  store.viewport = {
    scale: next,
    x: cx - wx * next,
    y: cy - wy * next,
  };
}
function bindGlobalPointer() {
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}
function unbindGlobalPointer() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
}
function hitNodeDom(clientX, clientY) {
  const under = document.elementFromPoint(clientX, clientY);
  const el = under?.closest?.('.node');
  if (!el) return null;
  const id = el.getAttribute('data-id');
  return store.nodes.find((n) => n.id === id) || null;
}
function beginPan(e, clearOnClick) {
  drag.mode = 'pan';
  drag.ox = e.clientX;
  drag.oy = e.clientY;
  drag.vx = store.viewport.x;
  drag.vy = store.viewport.y;
  drag.moved = false;
  drag.additive = Boolean(clearOnClick);
  bindGlobalPointer();
}
function beginMarquee(e) {
  const rect = viewportEl.value.getBoundingClientRect();
  drag.mode = 'marquee';
  drag.ox = e.clientX - rect.left;
  drag.oy = e.clientY - rect.top;
  drag.additive = e.shiftKey || e.ctrlKey || e.metaKey;
  drag.moved = false;
  marquee.value = { left: drag.ox, top: drag.oy, width: 0, height: 0 };
  if (!drag.additive) {
    store.selection = [];
    store.activeId = '';
  }
  bindGlobalPointer();
}
function onPointerDown(e) {
  menu.value = null;
  mention.value = null;
  if (e.button === 1 || (e.button === 0 && isHand.value)) {
    e.preventDefault();
    beginPan(e, true);
    return;
  }
  if (e.button !== 0) return;
  const onBlank =
    e.target === viewportEl.value ||
    e.target.classList?.contains('world') ||
    e.target.classList?.contains('edges') ||
    e.target.tagName === 'svg' ||
    e.target.tagName === 'path';
  if (onBlank) {
    // 选择工具：空白处拖框选；点一下清空
    beginMarquee(e);
  }
}
function onPointerMove(e) {
  if (drag.mode === 'pan') {
    const dx = e.clientX - drag.ox;
    const dy = e.clientY - drag.oy;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    store.viewport = {
      ...store.viewport,
      x: drag.vx + dx,
      y: drag.vy + dy,
    };
    return;
  }
  if (drag.mode === 'marquee') {
    const rect = viewportEl.value.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const left = Math.min(drag.ox, cx);
    const top = Math.min(drag.oy, cy);
    const width = Math.abs(cx - drag.ox);
    const height = Math.abs(cy - drag.oy);
    if (width + height > 3) drag.moved = true;
    marquee.value = { left, top, width, height };
    return;
  }
  if (drag.mode === 'node') {
    const p = toWorld(e.clientX, e.clientY);
    let dx = p.x - drag.ox;
    let dy = p.y - drag.oy;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) drag.moved = true;
    if (store.snap) {
      const g = 8;
      dx = Math.round(dx / g) * g;
      dy = Math.round(dy / g) * g;
    }
    const origins = drag.origins || [];
    origins.forEach((o) => {
      const n = store.nodes.find((x) => x.id === o.id);
      if (!n) return;
      n.x = o.x + dx;
      n.y = o.y + dy;
    });
    return;
  }
  if (drag.mode === 'resize') {
    const p = toWorld(e.clientX, e.clientY);
    let dw = p.x - drag.ox;
    let dh = p.y - drag.oy;
    if (Math.abs(dw) + Math.abs(dh) > 0.5) drag.moved = true;
    if (store.snap) {
      const g = 8;
      dw = Math.round(dw / g) * g;
      dh = Math.round(dh / g) * g;
    }
    const n = store.nodes.find((x) => x.id === drag.id);
    if (n) {
      const minW = n.type === 'zone' ? 320 : 140;
      const minH = n.type === 'zone' ? 200 : 100;
      n.w = Math.max(minW, drag.rw + dw);
      n.h = Math.max(minH, drag.rh + dh);
    }
    return;
  }
  if (linking.value) {
    const p = toWorld(e.clientX, e.clientY);
    linking.value.x2 = p.x;
    linking.value.y2 = p.y;
    const hit = hitNodeDom(e.clientX, e.clientY);
    linkHoverId.value = hit && hit.id !== linking.value.nodeId ? hit.id : '';
  }
}
function onPointerUp(e) {
  if (drag.mode === 'pan') {
    if (!drag.moved && drag.additive) {
      store.selection = [];
      store.activeId = '';
    }
  } else if (drag.mode === 'marquee') {
    if (drag.moved && marquee.value) {
      const rect = viewportEl.value.getBoundingClientRect();
      const a = toWorld(rect.left + marquee.value.left, rect.top + marquee.value.top);
      const b = toWorld(
        rect.left + marquee.value.left + marquee.value.width,
        rect.top + marquee.value.top + marquee.value.height
      );
      const hit = store.nodes
        .filter((n) => n.x < b.x && n.x + (n.w || 200) > a.x && n.y < b.y && n.y + (n.h || 140) > a.y)
        .map((n) => n.id);
      if (drag.additive) store.select([...new Set([...store.selection, ...hit])]);
      else store.select(hit);
    }
    marquee.value = null;
  } else if (drag.mode === 'node' || drag.mode === 'resize') {
    if (drag.moved) store.scheduleSave();
  }
  if (linking.value) {
    const fixed = linking.value.nodeId;
    const side = linking.value.side;
    const hit = hitNodeDom(e.clientX, e.clientY);
    const dragged =
      Math.abs(e.clientX - (linking.value.startClientX || e.clientX)) +
        Math.abs(e.clientY - (linking.value.startClientY || e.clientY)) >
      6;
    if (hit && hit.id !== fixed) {
      if (side === 'out') store.connect(fixed, hit.id);
      else store.connect(hit.id, fixed);
    } else if (!hit && dragged && side === 'out') {
      const p = toWorld(e.clientX, e.clientY);
      const created = store.addNode('image', p);
      store.connect(fixed, created.id);
      Message.info('已在落点新建图片卡并连线');
    }
    linking.value = null;
    linkHoverId.value = '';
  }
  drag.mode = '';
  drag.origins = null;
  unbindGlobalPointer();
}
function isCardInteractive(target) {
  return Boolean(
    target?.closest?.(
      [
        'input',
        'textarea',
        'button',
        'a',
        'select',
        'label',
        '.ivu-select',
        '.ivu-input-wrapper',
        '.ivu-input',
        '.mention',
        '.co-acts',
        '.co-params',
        '.chip-param',
        '.hist-thumb',
        '.ref-add',
        '.ref-thumb',
        '.play',
        '.port',
      ].join(',')
    )
  );
}
function onCardSurfaceDown(e, node) {
  // 表单控件自己处理；标题/预览等空白区不拦截，交给卡片拖拽
  if (isCardInteractive(e.target)) {
    e.stopPropagation();
    return;
  }
  onNodeDown(e, node);
  e.stopPropagation();
}
function beginNodeDrag(e, node) {
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  if (additive) store.select([node.id], true);
  else if (!store.selection.includes(node.id)) store.select([node.id]);

  const p = toWorld(e.clientX, e.clientY);
  const ids = store.selection.includes(node.id) ? store.selection : [node.id];
  drag.mode = 'node';
  drag.id = node.id;
  drag.ox = p.x;
  drag.oy = p.y;
  drag.moved = false;
  drag.origins = ids.map((id) => {
    const n = store.nodes.find((x) => x.id === id);
    return { id, x: n?.x || 0, y: n?.y || 0 };
  });
  store.pushHistory();
  bindGlobalPointer();
}
function onNodeDown(e, node) {
  if (e.button === 1 || (e.button === 0 && isHand.value)) {
    e.preventDefault();
    beginPan(e, false);
    return;
  }
  if (e.button !== 0) return;
  beginNodeDrag(e, node);
}
function onNodeClick(node, e) {
  // 拖动过则不再改选择；纯点击才处理
  if (drag.moved) return;
  store.select([node.id], e.shiftKey || e.ctrlKey || e.metaKey);
}
function onNodeDbl(node) {
  if (node.type === 'zone') {
    renameZone(node);
    return;
  }
  store.selection = [node.id];
  store.activeId = node.id;
  if (node.type === 'director') openDirector(node);
  if (node.type === 'schedule') openSchedule(node);
}
function onDblClick(e) {
  if (isHand.value) return;
  if (e.target !== viewportEl.value && !e.target.classList?.contains('world')) return;
  const p = toWorld(e.clientX, e.clientY);
  store.addNode('image', p);
}
function startLink(e, node, side) {
  if (isHand.value) return;
  e.stopPropagation();
  e.preventDefault();
  const x = side === 'out' ? node.x + (node.w || 200) : node.x;
  const y = node.y + (node.h || 120) / 2;
  linking.value = {
    from: node.id,
    side,
    nodeId: node.id,
    x1: x,
    y1: y,
    x2: x,
    y2: y,
    startClientX: e.clientX,
    startClientY: e.clientY,
  };
  linkHoverId.value = '';
  bindGlobalPointer();
}
function onAdd(name) {
  if (name === 'import') {
    fileInput.value?.click();
    return;
  }
  const node = store.addNode(name);
  if (name === 'zone') {
    nextTick(() => renameZone(node));
  }
  if (name === 'schedule') openSchedule(node);
  if (name === 'director') openDirector(node);
}
async function onFiles(e) {
  const files = [...(e.target.files || [])];
  for (const file of files) {
    const kind = file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'image';
    const data = await api.importAsset(file, kind, store.id, 'copy');
    const node = store.addNode(kind);
    store.updateNodeData(node.id, { url: data.url || data.path, thumb: data.thumb, title: file.name });
  }
  e.target.value = '';
}
async function onDrop(e) {
  const raw = e.dataTransfer.getData('application/x-canvas-asset');
  if (raw) {
    const item = JSON.parse(raw);
    const kind = item.kind || 'image';
    const p = toWorld(e.clientX, e.clientY);
    const node = store.addNode(kind === 'tail' ? 'image' : kind, p);
    store.updateNodeData(node.id, { url: item.url, thumb: item.thumbUrl || item.url, title: item.name });
    return;
  }
  const files = [...e.dataTransfer.files];
  for (const file of files) {
    const kind = file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'image';
    const data = await api.importAsset(file, kind, store.id, 'copy');
    const p = toWorld(e.clientX, e.clientY);
    const node = store.addNode(kind, p);
    store.updateNodeData(node.id, { url: data.url || data.path, title: file.name });
  }
}
function rename() {
  const next = window.prompt('画布改名', store.name);
  if (!next || next === store.name) return;
  store.name = next;
  api.renameCanvas(store.id, next).then(() => store.scheduleSave()).catch((e) => Message.error(e.message));
}
function swapFrames(node) {
  const list = incoming(node.id);
  if (list.length < 2) return;
  store.pushHistory();
  const a = list[0].edge;
  const b = list[1].edge;
  const as = a.source;
  a.source = b.source;
  b.source = as;
  store.scheduleSave();
}
async function generate(node) {
  // 再次生成前先把当前成品归档，避免被新结果盖掉却进不了历史
  const cur = mediaUrl(node);
  if (cur) {
    const list = node.data?.history || [];
    if (!list.some((h) => h.url === cur)) {
      store.pushCardHistory(node.id, { url: cur, thumb: node.data?.thumb || cur });
    }
  }
  store.updateNodeData(node.id, {
    status: 'running',
    error: '',
    startedAt: Date.now(),
    progress: 8,
    step: 1,
    totalSteps: 5,
  });
  try {
    const refs = incoming(node.id).map((x) => ({
      nodeId: x.node.id,
      url: mediaUrl(x.node),
      kind: x.node.type,
    }));
    // 组合出线摊平
    const flatRefs = [];
    refs.forEach((r) => {
      const src = store.nodes.find((n) => n.id === r.nodeId);
      if (src?.type === 'group') {
        store.groupMembersOf(src).forEach((m) => {
          flatRefs.push({ nodeId: m.id, url: mediaUrl(m), kind: m.type });
        });
      } else flatRefs.push(r);
    });
    const payload = {
      canvasId: store.id,
      nodeId: node.id,
      kind: node.type === 'quick' ? 'video' : node.type,
      model: node.data.model,
      channelId: node.data.channelId,
      prompt: node.data.prompt || '',
      params: {
        ...(node.data.params || {}),
        mode: node.data.params?.mode || node.data.mode || 'reference',
      },
      mode: node.data.params?.mode || node.data.mode || 'reference',
      refs: flatRefs,
      quickRefs: node.data.quickRefs || {},
      compress: store.compress,
    };
    const res = await api.generate(payload);
    if (res.url || res.resultUrl) {
      const url = res.url || res.resultUrl;
      store.updateNodeData(node.id, {
        status: 'done',
        url,
        thumb: res.thumb || res.cover,
        taskId: res.taskId || res.id,
      });
      store.pushCardHistory(node.id, { url, thumb: res.thumb || res.cover || url });
    } else {
      store.updateNodeData(node.id, { status: 'running', taskId: res.taskId || res.id });
      pollTask(node.id, res.taskId || res.id);
    }
  } catch (e) {
    store.updateNodeData(node.id, { status: 'failed', error: e.message });
    Message.error(e.message);
  }
}
async function pollTask(nodeId, taskId) {
  if (!taskId) return;
  try {
    const t = await api.task(taskId);
    if (['done', 'completed', 'success'].includes(String(t.status).toLowerCase())) {
      const url = t.url || t.resultUrl || t.result?.url;
      store.updateNodeData(nodeId, { status: 'done', url, thumb: t.thumb, progress: 100 });
      store.pushCardHistory(nodeId, { url, thumb: t.thumb || url });
      return;
    }
    if (String(t.status).toLowerCase() === 'failed') {
      store.updateNodeData(nodeId, { status: 'failed', error: t.error || t.message || '失败' });
      return;
    }
    const patch = {};
    if (t.progress != null) patch.progress = Number(t.progress);
    if (t.step != null) patch.step = Number(t.step);
    if (t.totalSteps != null) patch.totalSteps = Number(t.totalSteps);
    if (t.eta) patch.eta = t.eta;
    if (t.queue) patch.queue = t.queue;
    if (Object.keys(patch).length) store.updateNodeData(nodeId, patch);
    setTimeout(() => pollTask(nodeId, taskId), 3000);
  } catch {
    setTimeout(() => pollTask(nodeId, taskId), 5000);
  }
}
async function cancelGen(node) {
  if (!node.data?.taskId) return;
  await api.cancelTask(node.data.taskId);
  store.updateNodeData(node.id, { status: 'idle' });
  Message.success('已取消');
}
async function tailFrame(node) {
  try {
    const res = await api.tailFrame({ canvasId: store.id, nodeId: node.id, url: mediaUrl(node) });
    const n = store.addNode('image', { x: node.x + node.w + 40, y: node.y });
    store.updateNodeData(n.id, { url: res.url || res.path, title: '尾帧', from: node.id });
    Message.success('已提取尾帧');
  } catch (e) {
    Message.error(e.message);
  }
}
function openSchedule(node) {
  scheduleForm.nodeId = node.id;
  Object.assign(scheduleForm, {
    startAt: '03:00',
    concurrency: 2,
    interval: 30,
    runType: 'daily',
    fail: 'retry',
    mode: 'stagger',
    ...(node.data?.schedule || {}),
  });
  store.scheduleOpen = true;
}
function persistSchedule(close = true) {
  if (!scheduleForm.nodeId) return;
  store.updateNodeData(scheduleForm.nodeId, {
    schedule: {
      startAt: scheduleForm.startAt,
      mode: scheduleForm.mode,
      runType: scheduleForm.runType,
      interval: scheduleForm.interval,
      concurrency: scheduleForm.concurrency,
      fail: scheduleForm.fail,
      backup: scheduleForm.backup || '主通道',
    },
  });
  if (close) store.scheduleOpen = false;
}
function saveSchedule() {
  persistSchedule(true);
  Message.success('定时组已保存');
}
function addSelectedToSchedule() {
  const ids = store.selectedCards().map((n) => n.id);
  if (!ids.length) {
    Message.warning('请先选中要加入队列的卡片');
    return;
  }
  store.addScheduleMembers(scheduleForm.nodeId, ids);
}
function removeFromSchedule(id) {
  const s = store.nodes.find((n) => n.id === scheduleForm.nodeId);
  if (!s) return;
  store.pushHistory();
  s.data.members = (s.data.members || []).filter((x) => x !== id);
  store.scheduleSave();
}
async function startSchedule() {
  persistSchedule(false);
  await api.startSchedule(scheduleForm.nodeId, {
    ...scheduleForm,
    members: scheduleMembers.value.map((m) => m.id),
  });
  Message.success('定时组已开始');
}
async function stopSchedule() {
  await api.stopSchedule(scheduleForm.nodeId);
  Message.success('已停止');
}
function openDirector(node) {
  store.directorNodeId = node.id;
  store.directorOpen = true;
}
function onDirectorShot(payload) {
  const n = store.addNode('image', { x: 200, y: 200 });
  store.updateNodeData(n.id, { url: payload.url, title: payload.label || '导演台出图' });
  store.connect(store.directorNodeId, n.id);
}
function openNodeMenu(e, node) {
  store.select([node.id]);
  menu.value = { x: e.clientX, y: e.clientY, nodeId: node.id };
}
function onGroup() {
  const g = store.groupSelection();
  if (!g) Message.warning('至少选两张卡片才能编组');
  else Message.success('已编组');
}
function showGroupMembers(node) {
  const names = store.groupMembersOf(node).map((m) => numberLabel(m)).join('、') || '无';
  Message.info(`成员 ${(node.data.members || []).length} 个：${names}`);
}
function menuAction(act) {
  const node = store.nodes.find((n) => n.id === menu.value?.nodeId);
  menu.value = null;
  if (!node) return;
  if (act === 'open') {
    store.select([node.id]);
    store.activeId = node.id;
  }
  if (act === 'tail') tailFrame(node);
  if (act === 'link-out') {
    const x = node.x + (node.w || 200);
    const y = node.y + (node.h || 120) / 2;
    linking.value = { from: node.id, side: 'out', nodeId: node.id, x1: x, y1: y, x2: x, y2: y };
    Message.info('拖到目标卡片松开以建立参考线');
    bindGlobalPointer();
  }
  if (act === 'refs') {
    const outs = store.edges.filter((e) => edgeEnd(e, 'source') === node.id);
    const inns = store.edges.filter((e) => edgeEnd(e, 'target') === node.id);
    Message.info(`引用 ${outs.length} · 被引用 ${inns.length}`);
    if (inns[0]) store.focusNode(inns[0].source || inns[0].source_id || inns[0].target, vpW.value, vpH.value);
  }
  if (act === 'group') {
    const groups = store.nodes.filter((n) => n.type === 'group');
    if (groups.length) {
      store.addToGroup(groups[0], [node]);
      Message.success(`已加入「${groups[0].data?.title || '组合'}」`);
    } else {
      store.createGroup([node, ...store.selectedCards().filter((c) => c.id !== node.id)].slice(0, 8));
      Message.success('已创建组合');
    }
  }
  if (act === 'zone') {
    const zones = store.nodes.filter((n) => n.type === 'zone');
    if (!zones.length) {
      const z = store.addNode('zone', { x: node.x - 40, y: node.y - 40 });
      store.updateNodeData(node.id, { zoneId: z.id });
      Message.success('已创建区域并移入');
    } else {
      store.updateNodeData(node.id, { zoneId: zones[0].id });
      Message.success(`已移入区域「${zones[0].data?.title || '区域'}」`);
    }
  }
  if (act === 'focus') store.focusNode(node.id, vpW.value, vpH.value);
  if (act === 'delete') confirmRemoveNodes([node.id]);
  if (act === 'copy') {
    store.pushHistory();
    const copy = JSON.parse(JSON.stringify(node));
    copy.id = uid('n');
    copy.x += 40;
    copy.y += 40;
    if (Array.isArray(copy.data?.members)) copy.data.members = [...copy.data.members];
    store.nodes.push(copy);
    store.scheduleSave();
  }
}
function onBoardContext() {
  menu.value = null;
  mention.value = null;
}
function onPromptKey(e, node) {
  if (mention.value && mention.value.nodeId === node.id) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mention.value.index = Math.min(mention.value.index + 1, Math.max(0, mentionHits.value.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mention.value.index = Math.max(0, mention.value.index - 1);
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      const hit = mentionHits.value[mention.value.index];
      if (hit) toggleMentionCheck(hit);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmMentionFromKeyboard(node);
      return;
    }
    if (e.key === 'Escape') {
      mention.value = null;
      return;
    }
  }
  if (e.key === '@') {
    nextTick(() => {
      // 先把当前输入框正文写回（含刚敲的 @）
      const el = e.target;
      if (el && 'value' in el) onPromptFreeChange(node, el.value);
      mention.value = { nodeId: node.id, q: '', filter: '', index: 0, checked: [] };
    });
  } else if (mention.value && mention.value.nodeId === node.id) {
    nextTick(() => {
      if (!mention.value) return;
      if (String(mention.value.filter || '').trim()) return;
      const el = e.target;
      if (el && 'value' in el) onPromptFreeChange(node, el.value);
      const text = promptFreeText(node);
      const at = text.lastIndexOf('@');
      const frag = at >= 0 ? text.slice(at + 1) : '';
      if (frag.startsWith('[')) {
        mention.value = null;
        return;
      }
      mention.value.q = frag.replace(/\s.*/, '');
      mention.value.index = 0;
    });
  }
}
function onMentionFilterInput(e) {
  if (!mention.value) return;
  mention.value.filter = e.target?.value || '';
  mention.value.index = 0;
}
function clearMentionFilter() {
  if (!mention.value) return;
  mention.value.filter = '';
  mention.value.index = 0;
}
function onMentionSearchKey(e, node) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    mention.value.index = Math.min((mention.value.index || 0) + 1, Math.max(0, mentionHits.value.length - 1));
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    mention.value.index = Math.max(0, (mention.value.index || 0) - 1);
    return;
  }
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    const hit = mentionHits.value[mention.value.index || 0];
    if (hit) toggleMentionCheck(hit);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    confirmMentionFromKeyboard(node);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (mention.value?.filter) {
      clearMentionFilter();
      return;
    }
    mention.value = null;
  }
}
function isMentionChecked(id) {
  return (mention.value?.checked || []).includes(id);
}
function toggleMentionCheck(item) {
  if (!mention.value || !item?.id) return;
  const set = new Set(mention.value.checked || []);
  if (set.has(item.id)) set.delete(item.id);
  else set.add(item.id);
  mention.value.checked = [...set];
  // 同步高亮到当前项
  const idx = mentionHits.value.findIndex((x) => x.id === item.id);
  if (idx >= 0) mention.value.index = idx;
}
function clearMentionChecks() {
  if (!mention.value) return;
  mention.value.checked = [];
}
function confirmMentionFromKeyboard(node) {
  if (mentionCheckedCount.value) {
    applyMentionSelection(node);
    return;
  }
  const hit = mentionHits.value[mention.value?.index || 0];
  if (hit) {
    toggleMentionCheck(hit);
    applyMentionSelection(node);
  }
}
function applyMentionSelection(node) {
  if (!mention.value) return;
  const ids = mention.value.checked || [];
  let items = ids
    .map((id) => mentionHits.value.find((x) => x.id === id) || store.nodes.find((n) => n.id === id))
    .filter(Boolean)
    .map((n) =>
      n.tag
        ? n
        : {
            id: n.id,
            tag: numberLabel(n),
            type: n.type,
          }
    );
  if (!items.length) {
    Message.warning('请先勾选要引用的卡片');
    return;
  }
  // 正文去掉未完成的 @xxx；标签只留在芯片里
  let free = promptFreeText(node).replace(/@[^@\s\[\]]*$/, '').trim();
  const tags = [...promptPills(node)];
  items.forEach((item) => {
    if (!tags.includes(item.tag)) tags.push(item.tag);
    if (node.type === 'quick') {
      node.data.quickRefs = { ...(node.data.quickRefs || {}), [item.tag]: item.id };
    } else if (!incoming(node.id).some((x) => x.node.id === item.id)) {
      store.connect(item.id, node.id);
    }
  });
  rebuildPrompt(node, free, tags);
  mention.value = null;
  store.scheduleSave();
  Message.success(items.length > 1 ? `已插入 ${items.length} 个引用` : '已插入引用');
}
function applyMention(node, item) {
  if (!mention.value) mention.value = { nodeId: node.id, q: '', filter: '', index: 0, checked: [] };
  mention.value.checked = [item.id];
  applyMentionSelection(node);
}
function doUndo() {
  if (store.undo()) Message.info('已撤销');
}
function doRedo() {
  if (store.redo()) Message.info('已重做');
}
function focusFirstHit() {
  const hit = filteredHits.value[0];
  if (hit) store.focusNode(hit.id, vpW.value, vpH.value);
  else Message.info('没有可定位的卡片');
}
function clearSelection() {
  store.selection = [];
  store.activeId = '';
}
function onKey(e) {
  const tag = (e.target?.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
  if (e.code === 'Space' && !typing) {
    spaceDown.value = true;
    e.preventDefault();
    return;
  }
  if (typing) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    doUndo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault();
    doRedo();
    return;
  }
  if (typing) return;
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key.toLowerCase() === 'v') {
      store.tool = 'select';
      return;
    }
    if (e.key.toLowerCase() === 'h') {
      store.tool = 'hand';
      return;
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    if (store.activeId || store.selection[0]) {
      e.preventDefault();
      menu.value = { x: 0, y: 0, nodeId: store.activeId || store.selection[0] };
      menuAction('copy');
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    store.select(store.nodes.map((n) => n.id));
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    onGroup();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (store.selection.length) {
      e.preventDefault();
      confirmRemoveNodes([...store.selection]);
    }
    return;
  }
  if (e.key === 'Enter' && store.selection[0]) {
    store.activeId = store.selection[0];
    return;
  }
  if (e.key === 'Escape') {
    if (mediaPreview.value) {
      mediaPreview.value = null;
      return;
    }
    menu.value = null;
    mention.value = null;
    linking.value = null;
    linkHoverId.value = '';
    marquee.value = null;
    clearSelection();
  }
}
function onKeyUp(e) {
  if (e.code === 'Space') spaceDown.value = false;
}
function drawMini() {
  const canvas = miniEl.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!store.nodes.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  store.nodes.forEach((n) => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  });
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;
  const scale = Math.min(canvas.width / bw, canvas.height / bh) * 0.85;
  const ox = (canvas.width - bw * scale) / 2 - minX * scale;
  const oy = (canvas.height - bh * scale) / 2 - minY * scale;
  const colors = { image: '#22a06b', video: '#e07a2f', audio: '#7a5af8', quick: '#0f9fbf', group: '#94a3b8', schedule: '#a78bfa' };
  store.nodes.forEach((n) => {
    ctx.fillStyle = colors[n.type] || '#64748b';
    ctx.fillRect(n.x * scale + ox, n.y * scale + oy, Math.max(4, n.w * scale), Math.max(4, n.h * scale));
  });
}
function onMiniClick() {
  store.fitView(vpW.value, vpH.value);
}
async function loadTasks() {
  const data = await api.tasks(50, { canvasId: store.id });
  tasks.value = data.tasks || data.items || [];
}
function isActiveTask(t) {
  return ['running', 'queued', 'pending', 'waiting', 'rendering'].includes(String(t.status || '').toLowerCase());
}
function measure() {
  if (!viewportEl.value) return;
  vpW.value = viewportEl.value.clientWidth;
  vpH.value = viewportEl.value.clientHeight;
}
function onLeave() {
  store.save(true).catch(() => {});
}

onMounted(async () => {
  try {
    await store.load(route.params.id);
  } catch (e) {
    Message.error(e.message || '画布打开失败');
    router.push('/');
    return;
  }
  measure();
  window.addEventListener('resize', measure);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    spaceDown.value = false;
  });
  drawMini();
  miniTimer = setInterval(drawMini, 1000);
  loadTasks().catch(() => {});
  taskTimer = setInterval(() => loadTasks().catch(() => {}), 4000);
  clockTimer = setInterval(() => {
    clock.value = new Date().toTimeString().slice(0, 5);
  }, 1000);
  clock.value = new Date().toTimeString().slice(0, 5);
  api.channelStatus(true).then((data) => {
    const list = data.channels || data.items || data || [];
    channelBrief.value = (Array.isArray(list) ? list : []).slice(0, 4).map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind || ((c.models && c.models.video && c.models.video.length) ? '视频' : '图像'),
      balance: c.balanceText || c.balance || c._balanceText || '',
    }));
  }).catch(() => {
    api.listChannels().then((data) => {
      const list = data.channels || data || [];
      channelBrief.value = (Array.isArray(list) ? list : []).slice(0, 3).map((c) => ({
        id: c.id, name: c.name, kind: '通道', balance: '',
      }));
    }).catch(() => {});
  });
  tailDraft.value = localStorage.getItem('canvas.tailPrompt') || '电影感, 胶片颗粒';
  tailLabel.value = (tailDraft.value || '电影感').split(/[,，]/)[0].trim() || '电影感';
  api
    .library({ sort: 'time' })
    .then((data) => {
      const items = data.items || data.files || data || [];
      libraryCount.value = Array.isArray(items) ? items.length : data.total || 0;
    })
    .catch(() => {});
  window.addEventListener('beforeunload', onLeave);
});
onUnmounted(() => {
  window.removeEventListener('resize', measure);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('beforeunload', onLeave);
  unbindGlobalPointer();
  clearInterval(taskTimer);
  clearInterval(miniTimer);
  clearInterval(clockTimer);
  store.save().catch(() => {});
});
watch(
  () => route.params.id,
  async (id) => {
    if (id) await store.load(id);
  }
);
</script>


<style scoped lang="scss">
.workbench {
  height: 100vh; display: flex; flex-direction: column; background: #14171c; color: #e8ecf3; overflow: hidden;
}
.body { flex: 1; display: flex; min-height: 0; }
.main-col { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.canvas-top {
  height: 44px; flex-shrink: 0; display: flex; align-items: center; gap: 16px;
  padding: 0 20px; border-bottom: 1px solid #232933; background: #181c23;
}
.crumb {
  display: flex; align-items: center; gap: 8px;
  a, .name { color: #9aa8bd; background: transparent; border: 0; cursor: pointer; font-size: 13px; }
  .name { color: #e8ecf3; font-weight: 600; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
.chips { display: flex; align-items: center; gap: 8px; flex: 1; }
.chip {
  border: 1px solid #2a3340; background: #1a212b; color: #c9d2de; border-radius: 8px;
  height: 28px; padding: 0 10px; font-size: 12px; cursor: pointer;
  &.on { border-color: #2d8cf0; color: #7fb6f2; }
}
.top-right {
  display: flex; align-items: center; gap: 8px; font-size: 12px; color: #8b95a3; white-space: nowrap;
}
.icon-btn {
  width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: #9aa8bd; cursor: pointer;
  display: grid; place-items: center;
  &:hover { background: #243040; color: #e8ecf3; }
  &.sm { width: 22px; height: 22px; }
}
.rail {
  width: 264px; flex-shrink: 0; background: #181c23; border-right: 1px solid #232933;
  padding: 0 0 12px; display: flex; flex-direction: column; gap: 8px; overflow: auto;
}
.rail-head {
  height: 56px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid #232933;
  .back, .icon-btn {
    width: 28px; height: 28px; border: 0; border-radius: 8px; background: #1f2630; color: #c9d2de; cursor: pointer;
    display: grid; place-items: center;
  }
  .rail-title { flex: 1; min-width: 0; }
  .name {
    border: 0; background: transparent; color: #e8ecf3; font-weight: 700; font-size: 14px;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; padding: 0;
  }
  .save-line { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #6b7684; margin-top: 2px; }
  .save-dot {
    width: 5px; height: 5px; border-radius: 50%; background: #34d399; display: inline-block;
    &.dirty, &.saving { background: #e07a2f; }
    &.failed { background: #ef4444; }
  }
}
.mode-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 0; margin: 8px 12px 0;
  background: #12161d; border-radius: 10px; padding: 3px;
  button {
    height: 30px; border: 0; border-radius: 8px; background: transparent; color: #9aa8bd; cursor: pointer; font-size: 12px; font-weight: 600;
    kbd { font-size: 10px; opacity: .55; margin-left: 4px; }
    &.on { background: #1e3a5f; color: #7fb6f2; }
  }
}
.sec-row {
  display: flex; justify-content: space-between; align-items: center; padding: 8px 14px 0; font-size: 11px; color: #6b7684;
  a, em { font-style: normal; color: #6b7684; }
}
.add-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 0 12px;
  button {
    display: flex; align-items: center; gap: 8px; border: 0; background: #1f2630; color: #e8ecf3;
    border-radius: 10px; height: 38px; padding: 0 12px; cursor: pointer; font-size: 12px;
    &:hover { background: #243040; }
  }
}
.add-more {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 0 12px;
  button {
    border: 0; background: transparent; color: #8b95a3; border-radius: 6px; height: 24px; font-size: 11px; cursor: pointer;
    &:hover { background: #1f2630; color: #c9d2de; }
  }
}
.dot {
  width: 7px; height: 7px; border-radius: 50%; display: inline-block;
  &.green { background: #22a06b; } &.orange { background: #e07a2f; }
  &.purple { background: #7a5af8; } &.cyan { background: #0f9fbf; }
  &.image { background: #22a06b; } &.video { background: #e07a2f; }
  &.audio { background: #7a5af8; } &.quick { background: #0f9fbf; }
}
.rail-btn, .foot-btn {
  border: 0; background: #1f2630; color: #e5e7eb; border-radius: 8px; padding: 8px 10px;
  text-align: left; cursor: pointer; width: calc(100% - 24px); margin: 0 12px; font-size: 12px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  &:disabled { opacity: .4; cursor: not-allowed; }
  &.on { background: #1e3a5f; color: #7fb6f2; }
  &.import { height: 34px; }
  kbd { font-size: 10px; color: #6b7684; background: #12161d; padding: 1px 6px; border-radius: 4px; }
}
.find-box {
  margin: 4px 12px 0; height: 32px; border-radius: 8px; background: #12161d; border: 1px solid #2a3340;
  display: flex; align-items: center; gap: 6px; padding: 0 8px;
  .find-ico { color: #6b7684; }
  input {
    flex: 1; border: 0; background: transparent; color: #e8ecf3; outline: none; font-size: 12px; min-width: 0;
    &::placeholder { color: #6b7684; }
  }
}
.filter-tabs {
  display: flex; gap: 4px; flex-wrap: wrap; padding: 0 12px;
  button {
    border: 0; background: transparent; color: #8b95a3; border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer;
    &.on { background: #243040; color: #7fb6f2; }
  }
}
.find-hits { max-height: 100px; overflow: auto; padding: 0 12px; }
.hit { font-size: 11px; color: #cbd5e1; padding: 4px 6px; border-radius: 6px; cursor: pointer; &:hover { background: #1f2937; } }
.edit-icons {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; padding: 0 12px;
  button {
    height: 32px; border: 0; border-radius: 8px; background: #1f2630; color: #c9d2de; cursor: pointer;
    &:disabled { opacity: .35; } &.on { color: #7fb6f2; background: #1e3a5f; }
  }
}
.switch-row {
  display: flex; justify-content: space-between; align-items: center; padding: 0 14px; font-size: 12px; color: #9aa8bd;
  .switch {
    width: 32px; height: 18px; border: 0; border-radius: 999px; background: #2a3340; position: relative; cursor: pointer; padding: 0;
    i { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #c9d2de; transition: .15s; }
    &.on { background: #2d8cf0; i { left: 16px; background: #fff; } }
  }
}
.channel-box { margin: 0 12px; display: flex; flex-direction: column; gap: 6px; }
.ch-card {
  display: flex; align-items: center; gap: 8px; background: #12161d; border: 1px solid #232933;
  border-radius: 10px; padding: 8px 10px;
  .ch-dot { width: 6px; height: 6px; border-radius: 50%; background: #34d399; flex-shrink: 0; }
  .ch-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  b { font-size: 12px; color: #e8ecf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  span { font-size: 11px; color: #6b7684; }
  em { font-style: normal; color: #34d399; font-size: 12px; }
}
.tiny { font-size: 11px; } .muted { color: #8b95a3; }
.drawer-entries { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.foot-btn {
  em { font-style: normal; color: #9aa8bd; background: #243040; border-radius: 8px; padding: 1px 7px; font-size: 11px; }
  em.hot { background: #2d8cf0; color: #fff; }
}
.rail-tools {
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; padding: 8px 12px 0; margin-top: auto;
  button {
    height: 30px; border: 0; border-radius: 8px; background: #1f2630; color: #9aa8bd; cursor: pointer;
    &.on { color: #7fb6f2; background: #1e3a5f; }
  }
}
.rail-save {
  margin: 8px 12px 0; height: 35px; border-radius: 10px; background: #12161d; border: 1px solid #232933;
  display: flex; align-items: center; justify-content: space-between; padding: 0 10px; font-size: 12px; color: #9aa8bd;
  em { font-style: normal; color: #6b7684; }
}
.side-rail {
  width: 56px; flex-shrink: 0; background: #181c23; border-left: 1px solid #232933;
  display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px 0;
  button {
    width: 36px; height: 36px; border: 0; border-radius: 10px; background: #1f2630; color: #c9d2de; cursor: pointer;
    display: grid; place-items: center; font-size: 18px;
    &:hover { background: #243040; }
  }
  .side-sep { width: 24px; height: 1px; background: #2a3340; margin: 4px 0; }
}
.align-float {
  position: absolute; left: 24px; right: 24px; top: 16px; z-index: 50;
  min-height: 44px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 8px 14px; border-radius: 12px;
  background: rgba(28, 34, 44, .96); border: 1px solid #2f3947;
  box-shadow: 0 12px 32px rgba(0,0,0,.4); backdrop-filter: blur(8px);
  .af-left { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #e8ecf3; }
  .af-ico { color: #7fb6f2; font-size: 18px; }
  .af-hint {
    font-size: 11px; color: #9aa8bd; background: #1a212b; border: 1px solid #2a3340;
    border-radius: 6px; padding: 2px 8px;
  }
  .af-tools { display: flex; gap: 6px; flex: 1; flex-wrap: wrap; }
  .af-right { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .af-esc { font-size: 11px; color: #6b7684; }
  button {
    border: 0; height: 28px; padding: 0 10px; border-radius: 7px; background: #243040;
    color: #e8ecf3; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
    &:hover { background: #2d3a4d; }
  }
  .af-cancel {
    background: #1f2630; border: 1px solid #2a3340;
    &:hover { border-color: #3b82f6; color: #7fb6f2; }
  }
}

.viewport {
  flex: 1; position: relative; overflow: hidden; cursor: default; background: #14171c;
  &.hand, &.panning { cursor: grab; }
  &.panning { cursor: grabbing; }
  &.connecting { cursor: crosshair; }
  &.connecting .port.in { transform: scale(1.25); background: #93c5fd; }
}
.world { position: absolute; left: 0; top: 0; width: 8000px; height: 6000px; transform-origin: 0 0; }
.grid-bg {
  position: absolute; inset: 0;
  background-image: radial-gradient(rgba(255,255,255,.09) 1px, transparent 1px);
  background-size: 22px 22px; pointer-events: none;
}
.edges {
  position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; z-index: 1;
}
.edges-ui {
  /* 在卡片之下：只在两卡空隙里能摸到线，避免 × 浮在卡片上 */
  position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; z-index: 2;
}
.edge-g { pointer-events: none; cursor: pointer; }
.edge-hit {
  fill: none; stroke: transparent; stroke-width: 20; pointer-events: stroke;
}
.edge {
  fill: none; stroke: #5b7c99; stroke-width: 1.6; stroke-dasharray: 5 5; pointer-events: none;
  &.on { stroke: #93c5fd; stroke-width: 2.2; }
}
.edge.preview { stroke: #93c5fd; opacity: .9; pointer-events: none; }
.edge-x-btn {
  position: absolute; z-index: 25; width: 22px; height: 22px; margin: 0; padding: 0;
  border-radius: 50%; border: 1.5px solid #ef4444; background: #1b2430; color: #f87171;
  font-size: 15px; line-height: 18px; font-weight: 700; cursor: pointer;
  transform: translate(-50%, -50%);
  box-shadow: 0 4px 12px rgba(0,0,0,.35);
  pointer-events: auto;
  &:hover { background: #3f1a1a; border-color: #f87171; }
}
.more-toggle {
  margin: 0 12px; border: 0; background: transparent; color: #6b7684; font-size: 11px;
  text-align: left; cursor: pointer; padding: 2px 0;
  &:hover { color: #9aa8bd; }
}
.marquee {
  position: absolute; border: 1px solid #60a5fa; background: rgba(96,165,250,.12); pointer-events: none; z-index: 40;
}
.node {
  position: absolute; background: #20252e; border: 1px solid #313a48; border-radius: 12px; overflow: visible;
  user-select: none; touch-action: none; cursor: grab; box-shadow: 0 10px 28px rgba(0,0,0,.28);
  &.selected, &.active { border-color: #3b82f6; box-shadow: 0 0 0 1px #3b82f6, 0 12px 28px rgba(0,0,0,.35); }
  &.dim { opacity: .28; }
  &.connect-target { border-color: #34d399; box-shadow: 0 0 0 2px rgba(52,211,153,.35); }
  &.failed { border-color: #ef4444; }
  &.running { border-color: #3b82f6; }
  &.zone {
    background: rgba(24, 30, 40, .42); border: 1px dashed #3a4553; box-shadow: none; padding: 12px;
  }
  &.image:not(.selected):not(.active):not(.zone) { border-color: #1e4634; box-shadow: inset 3px 0 0 #19be6b, 0 10px 28px rgba(0,0,0,.28); }
  &.video:not(.selected):not(.active) { border-color: #4a3a20; box-shadow: inset 3px 0 0 #f59e0b, 0 10px 28px rgba(0,0,0,.28); }
  &.quick:not(.selected):not(.active) { border-color: #1d4a55; box-shadow: inset 3px 0 0 #0f9fbf, 0 10px 28px rgba(0,0,0,.28); }
  &.audio:not(.selected):not(.active) { border-color: #3b2f5c; box-shadow: inset 3px 0 0 #a78bfa, 0 10px 28px rgba(0,0,0,.28); }
  &:active { cursor: grabbing; }
}
.zone-head {
  display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 13px;
  .zh-left { display: flex; align-items: center; gap: 8px; min-width: 0; color: #e8ecf3; }
  .zh-name {
    border: 0; background: transparent; color: #e8ecf3; font-weight: 700; font-size: 13px;
    padding: 0; cursor: text; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    &:hover { color: #7fb6f2; text-decoration: underline; text-underline-offset: 3px; }
  }
  .zh-tag {
    font-size: 10px; color: #8b95a3; background: #1f2630; border: 1px solid #2a3340;
    border-radius: 4px; padding: 1px 7px; flex-shrink: 0;
  }
  .zh-meta { font-size: 11px; color: #6b7684; white-space: nowrap; }
  .zh-acts {
    display: flex; gap: 4px;
    button {
      width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent; color: #8b95a3; cursor: pointer;
      &:hover { background: #243040; color: #e8ecf3; }
    }
  }
}
.resize-handle {
  position: absolute; right: 2px; bottom: 2px; width: 14px; height: 14px; z-index: 8;
  cursor: nwse-resize; border-radius: 2px;
  background:
    linear-gradient(135deg, transparent 50%, #5b7c99 50%) no-repeat,
    linear-gradient(135deg, transparent 65%, #8b95a3 65%);
  opacity: .55;
  &:hover { opacity: 1; }
}
.node.zone .resize-handle { opacity: .75; }
.media {
  position: relative; height: 110px; background: #12161d; border-radius: 12px 12px 0 0; overflow: hidden;
  &.silent { pointer-events: none; }
  &.compact { height: 96px; display: grid; place-items: center; }
  &.image { background: #101a16; }
  &.video { background: #1a1510; }
  img, video { width: 100%; height: 100%; object-fit: cover; display: block; -webkit-user-drag: none; }
}
.type-chip {
  position: absolute; left: 8px; top: 8px; z-index: 3;
  height: 22px; padding: 0 8px; border-radius: 5px; font-size: 11px; font-weight: 700;
  display: inline-flex; align-items: center; letter-spacing: .02em;
  border: 1px solid transparent; box-shadow: 0 2px 8px rgba(0,0,0,.35);
  &.image { color: #b7f0d0; background: rgba(18, 70, 45, .92); border-color: #1e4634; }
  &.video { color: #ffe0a3; background: rgba(70, 48, 16, .92); border-color: #4a3a20; }
}
.play-mark {
  position: absolute; right: 8px; bottom: 8px; z-index: 3;
  width: 26px; height: 26px; border-radius: 50%;
  display: grid; place-items: center;
  background: rgba(0,0,0,.55); color: #ffe0a3; border: 1px solid rgba(245,158,11,.45);
  font-size: 14px;
}
.audio-silent { padding: 10px 12px 12px; }
.wave {
  height: 56px; display: flex; align-items: flex-end; justify-content: center; gap: 3px; padding: 8px 6px;
  background: #12161d; border-radius: 8px; margin: 8px 0;
  span { width: 3px; background: linear-gradient(180deg, #7a5af8, #334155); border-radius: 2px; display: block; }
  &.tall { height: 72px; margin: 0 0 10px; }
}
.audio-foot {
  display: flex; align-items: center; gap: 8px; font-size: 11px; color: #8b95a3;
  em { font-style: normal; } em.done { color: #19be6b; }
}
.placeholder {
  height: 100%; min-height: 88px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; color: #8b95a3; font-size: 12px; padding: 12px; text-align: center;
  &.dash {
    border: 1px dashed #3a4553; border-radius: 8px; margin: 0; background: #191d24;
  }
  &.dash.image {
    border-color: #1e4634; background: #122018; color: #6fbf93;
    :deep(.ivu-icon) { color: #19be6b; font-size: 22px; }
  }
  &.dash.video {
    border-color: #4a3a20; background: #20180f; color: #c9a15b;
    :deep(.ivu-icon) { color: #f59e0b; font-size: 22px; }
  }
  &.running, &.fail { background: #12161d; }
  .q-prompt { margin-top: 8px; color: #c9d2de; font-size: 11px; line-height: 1.5; max-width: 90%; }
}
.overlay {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; background: rgba(8,12,20,.62); text-align: center; padding: 12px;
  .ov-title { font-size: 13px; color: #e8ecf3; font-weight: 600; }
  .ov-sub { font-size: 11px; color: #9aa8bd; max-width: 90%; }
  .ov-bar {
    width: 70%; height: 4px; border-radius: 999px; background: rgba(255,255,255,.12); overflow: hidden; margin-top: 4px;
    i { display: block; height: 100%; background: #60a5fa; border-radius: inherit; }
  }
  .ov-x { font-size: 22px; color: #f87171; line-height: 1; margin-bottom: 2px; }
  &.fail { color: #fca5a5; .ov-title { color: #fecaca; } }
}
.spin {
  width: 28px; height: 28px; border-radius: 50%; border: 3px solid rgba(255,255,255,.2); border-top-color: #60a5fa;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.silent-meta { padding: 8px 10px 10px; }
.silent-title {
  display: flex; align-items: center; gap: 6px; font-size: 12px; color: #e8ecf3; font-weight: 600;
  span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .more { margin-left: auto; border: 0; background: transparent; color: #6b7684; cursor: pointer; }
}
.silent-sub { margin-top: 4px; font-size: 10.5px; color: #6f7c8d; }

.type-badge {
  display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 4px;
  font-size: 9.5px; font-weight: 600; border: 1px solid transparent;
  &.video { color: #f59e0b; background: #2a2117; border-color: #4a3a20; }
  &.image { color: #19be6b; background: #12291f; border-color: #1e4634; }
  &.audio { color: #a78bfa; background: #241b38; border-color: #3b2f5c; }
  &.quick { color: #0f9fbf; background: #10262c; border-color: #1d4a55; }
  &.schedule { color: #c4b5fd; background: #241b38; border-color: #3b2f5c; }
  &.group { color: #94a3b8; background: #1f2630; border-color: #2a3340; }
  &.director { color: #7fb6f2; background: #182433; border-color: #2a4060; }
  &.solid.video { color: #1a1206; background: #f59e0b; border-color: #f59e0b; }
  &.solid.image { color: #062016; background: #19be6b; border-color: #19be6b; }
  &.solid.quick { color: #041418; background: #0f9fbf; border-color: #0f9fbf; }
  &.solid.audio { color: #120a22; background: #a78bfa; border-color: #a78bfa; }
}
.st-badge {
  display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 4px;
  font-size: 9.5px; font-weight: 600; border: 1px solid transparent;
  &.done { color: #19be6b; background: #12291f; border-color: #1e4634; }
  &.running { color: #60a5fa; background: #182433; border-color: #2a4060; }
  &.failed { color: #f87171; background: #2a1717; border-color: #5c2626; }
  &.muted { color: #8b95a3; background: #1f2630; border-color: #2a3340; }
}

.card-open {
  padding: 12px; display: flex; flex-direction: column; gap: 10px; cursor: default;
  &.video { min-width: 360px; }
}
.co-head[data-drag-handle],
.co-media[data-drag-handle] {
  cursor: grab;
  &:active { cursor: grabbing; }
}
.co-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  .co-left, .co-right { display: flex; align-items: center; gap: 7px; min-width: 0; }
  b { font-size: 12.5px; color: #e8ecf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}
.run-pill {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px;
  border-radius: 6px; font-size: 11px; font-weight: 600;
  color: #93c5fd; background: #182433; border: 1px solid #2a4060; white-space: nowrap;
  .spin-ico { animation: spin 1s linear infinite; font-size: 13px; }
}
.co-media {
  display: flex; flex-direction: column; gap: 8px;
  img {
    width: 100%; height: 186px; object-fit: cover; border-radius: 8px; display: block; background: #12161d;
  }
  .placeholder { height: 186px; border-radius: 8px; }
  .placeholder.running {
    gap: 10px; justify-content: center;
    .ov-title { font-size: 12px; font-weight: 500; color: #e8ecf3; max-width: 92%; }
    .ov-bar {
      width: 72%; height: 4px; border-radius: 999px; background: rgba(255,255,255,.12); overflow: hidden;
      i { display: block; height: 100%; background: #3b82f6; border-radius: inherit; }
    }
  }
}
.run-ico {
  width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center;
  background: #1a2030; border: 1px solid #2f3b4f; color: #7fb6f2; font-size: 20px;
  &.video, &.quick { color: #f59e0b; border-color: #4a3a20; background: #2a2117; }
}
.co-media-bar, .co-run-bar, .co-fail-bar, .co-task {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 10.5px; color: #8a94a2;
}
.co-task .task-line {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9aa8bd;
}
.btn-cancel {
  flex-shrink: 0; height: 26px; padding: 0 10px; border-radius: 5px; cursor: pointer;
  border: 1px solid #5c2626; background: #2a1717; color: #f87171; font-size: 11px;
  &:hover { background: #3a1c1c; }
}
.btn-backup {
  flex-shrink: 0; height: 28px; padding: 0 10px; border-radius: 5px; cursor: pointer;
  border: 1px solid #4a3a20; background: #2a2117; color: #f59e0b; font-size: 11px; white-space: nowrap;
  &:hover { filter: brightness(1.08); }
}
.mb-left, .mb-right { display: flex; align-items: center; gap: 8px; }
.play {
  width: 22px; height: 22px; border: 0; border-radius: 11px; background: #2b3340; color: #e8ecf3;
  display: grid; place-items: center; cursor: pointer;
}
.mb-right button, .co-run-bar button {
  border: 0; background: transparent; color: #8a94a2; cursor: pointer; font-size: 12px;
  &:hover { color: #e8ecf3; }
}
.co-fail-bar { gap: 8px; }
.co-model {
  display: flex; align-items: center; gap: 8px;
  .lbl { width: 32px; flex-shrink: 0; font-size: 10.5px; color: #6f7c8d; }
  .model-sel { flex: 1; min-width: 0; }
  :deep(.ivu-select-selection) {
    background: #191d24 !important; border: 1px solid #2c333f !important; color: #dfe5ee !important;
    height: 28px !important; border-radius: 6px !important; box-shadow: none !important;
  }
  :deep(.ivu-select-selection:hover),
  :deep(.ivu-select-visible .ivu-select-selection) {
    border-color: #3b82f6 !important;
  }
  :deep(.ivu-select-selected-value),
  :deep(.ivu-select-input),
  :deep(.ivu-select-arrow) {
    color: #c9d2de !important; font-size: 12px !important;
  }
  :deep(.ivu-select-placeholder) { color: #6b7684 !important; }
}
.ch-tag {
  flex-shrink: 0; font-size: 10px; color: #19be6b; background: #1f242c; border: 1px solid #2b3340;
  border-radius: 5px; padding: 3px 8px;
  &.alt { color: #f59e0b; border-color: #4a3a20; background: #2a2117; }
}
.co-refs {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  .lbl { width: 32px; flex-shrink: 0; font-size: 10.5px; color: #6f7c8d; }
  .ref-hint { font-size: 10px; color: #5d6675; }
}
.ref-thumb {
  position: relative; width: 34px; height: 34px; border-radius: 5px; overflow: hidden;
  background: #191d24; border: 1px solid #355f5a; flex-shrink: 0;
  img { width: 100%; height: 100%; object-fit: cover; display: block; }
  span { font-size: 9px; color: #8b95a3; display: grid; place-items: center; height: 100%; }
  .x {
    position: absolute; right: 0; top: 0; width: 14px; height: 14px; border: 0; background: rgba(0,0,0,.55);
    color: #fff; font-size: 10px; line-height: 1; cursor: pointer; display: none;
  }
  &:hover .x { display: block; }
}
.ref-add {
  width: 34px; height: 34px; border-radius: 5px; border: 1px dashed #333c4a; background: #191d24;
  color: #6f7c8d; cursor: pointer; font-size: 16px;
}
.co-prompt {
  position: relative;
  border: 1px solid #2c333f; border-radius: 8px; background: #191d24; overflow: visible;
  :deep(.ivu-input-wrapper) { display: block; }
  :deep(textarea) {
    background: transparent !important; border-color: transparent !important; color: #cfd8e6 !important;
    font-size: 11px !important; line-height: 1.55 !important; border-radius: 0 0 7px 7px !important;
    box-shadow: none !important;
  }
  &:focus-within { border-color: #3b82f6; }
}
.pill-row {
  display: flex; flex-wrap: wrap; gap: 6px;
  &.in-prompt {
    padding: 8px 8px 0; margin: 0;
  }
}
.pill {
  display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 8px; border-radius: 9px;
  font-size: 9.5px; border: 1px solid transparent;
  &.image { color: #19be6b; background: #12291f; border-color: #1e4634; }
  &.video { color: #f59e0b; background: #2a2117; border-color: #4a3a20; }
  &.audio { color: #a78bfa; background: #241b38; border-color: #3b2f5c; }
  &.rich {
    height: 28px; padding: 0 6px 0 3px; border-radius: 8px; gap: 6px; cursor: default;
    font-size: 11px; font-weight: 600;
  }
}
.pill-thumb {
  position: relative; width: 22px; height: 22px; border-radius: 5px; overflow: hidden;
  background: #0f141b; border: 1px solid rgba(255,255,255,.08); flex-shrink: 0; cursor: zoom-in;
  display: grid; place-items: center; padding: 0;
  img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ph { color: #6b7684; font-size: 12px; display: grid; place-items: center; }
  .play-mini {
    position: absolute; right: 1px; bottom: 1px; width: 10px; height: 10px; border-radius: 50%;
    background: rgba(0,0,0,.55); color: #ffe0a3; display: grid; place-items: center; font-size: 7px;
  }
}
.pill-text { white-space: nowrap; }
.pill-x {
  margin-left: 2px; width: 14px; height: 14px; border-radius: 50%;
  display: grid; place-items: center; font-style: normal; font-size: 12px; line-height: 1;
  cursor: pointer; opacity: .7;
  &:hover { opacity: 1; background: rgba(0,0,0,.25); }
}
.co-params { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-param {
  border: 1px solid #2b3340; background: #1f242c; color: #a8b1be; border-radius: 5px;
  height: 22px; padding: 0 8px; font-size: 10px; cursor: pointer;
  &:hover { border-color: #3b82f6; color: #e8ecf3; }
}
.co-acts { display: flex; align-items: center; gap: 8px; }
.btn-regen {
  flex: 1; height: 32px; border: 0; border-radius: 6px; background: #f59e0b; color: #1a1206;
  font-size: 11.5px; font-weight: 600; cursor: pointer;
  &:disabled { opacity: .55; cursor: not-allowed; }
  &:hover:not(:disabled) { filter: brightness(1.05); }
}
.btn-ghost {
  height: 32px; min-width: 74px; border: 1px solid #333c4a; border-radius: 6px; background: #242a34;
  color: #c3cad6; font-size: 11.5px; cursor: pointer; padding: 0 12px;
  &.sm { height: 24px; min-width: auto; font-size: 10px; padding: 0 8px; }
  &:hover { background: #2b3340; }
}
.btn-tail {
  height: 32px; min-width: 94px; border: 1px solid #35506f; border-radius: 6px; background: #243040;
  color: #7fb6f2; font-size: 11.5px; cursor: pointer; padding: 0 12px;
  &:hover { background: #2a3a50; }
}
.mention {
  position: absolute; left: 0; right: 0; top: 100%; z-index: 30; margin-top: 4px;
  background: #151b27; border: 1px solid #2f3947; border-radius: 10px; overflow: hidden;
  box-shadow: 0 12px 28px rgba(0,0,0,.35); max-height: 280px; overflow-y: auto;
}
.mention-head {
  display: flex; justify-content: space-between; gap: 8px; align-items: center;
  padding: 8px 12px 4px; font-size: 11px; color: #8b95a3;
  position: sticky; top: 0; background: #151b27; z-index: 1;
}
.mention-search {
  display: flex; align-items: center; gap: 6px; margin: 4px 10px 8px; padding: 0 8px;
  height: 30px; border-radius: 7px; background: #0f141b; border: 1px solid #2f3947;
  position: sticky; top: 28px; z-index: 1;
  :deep(.ivu-icon), .ivu-icon { color: #6b7684; font-size: 14px; }
  input {
    flex: 1; min-width: 0; border: 0; outline: none; background: transparent;
    color: #e8ecf3; font-size: 12px; height: 100%;
    &::placeholder { color: #5d6675; }
  }
  .clear {
    border: 0; background: transparent; color: #6b7684; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px;
    &:hover { color: #e8ecf3; }
  }
  &:focus-within { border-color: #3b82f6; }
}
.mention-empty {
  padding: 16px 12px; text-align: center; font-size: 12px; color: #6b7684;
}
.mention-foot {
  position: sticky; bottom: 0; z-index: 1;
  display: flex; align-items: center; gap: 10px; justify-content: flex-end;
  padding: 8px 10px; border-top: 1px solid #2f3947; background: #151b27;
  .linkish { margin-right: auto; }
}
.btn-insert {
  height: 28px; padding: 0 12px; border: 0; border-radius: 6px; cursor: pointer;
  background: #3b82f6; color: #fff; font-size: 12px; font-weight: 600;
  &:disabled { opacity: .45; cursor: not-allowed; }
  &:hover:not(:disabled) { filter: brightness(1.06); }
}
.mention-item {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px; font-size: 13px; cursor: pointer;
  &.on, &:hover { background: #1f2937; }
  &.checked { background: #182433; }
}
.mention-check {
  width: 16px; height: 16px; flex-shrink: 0; border-radius: 4px; border: 1px solid #3a4553;
  background: #0f141b; display: grid; place-items: center; color: #93c5fd; font-size: 12px;
  &.on { background: #1e3a5f; border-color: #3b82f6; }
}
.mention-thumb {
  position: relative; width: 48px; height: 36px; flex-shrink: 0; border-radius: 6px; overflow: hidden;
  border: 1px solid #2f3947; background: #0f141b; padding: 0; cursor: zoom-in;
  img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ph {
    width: 100%; height: 100%; display: grid; place-items: center; color: #6b7684; font-size: 16px;
  }
  &.video, &.quick { border-color: #4a3a20; }
  &.image { border-color: #1e4634; }
  &.audio { border-color: #3b2f5c; }
  .play-mini {
    position: absolute; right: 3px; bottom: 3px; width: 14px; height: 14px; border-radius: 50%;
    background: rgba(0,0,0,.55); color: #ffe0a3; display: grid; place-items: center; font-size: 9px;
  }
  &:hover { outline: 1px solid #3b82f6; }
}
.mention-meta { min-width: 0; flex: 1; }
.mention-title {
  display: flex; align-items: center; gap: 6px; min-width: 0;
  b { font-size: 12.5px; color: #e8ecf3; white-space: nowrap; }
}
.mention-sub {
  margin-top: 2px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.type-mini {
  font-style: normal; font-size: 10px; padding: 0 5px; border-radius: 3px; border: 1px solid transparent;
  &.image { color: #19be6b; background: #12291f; border-color: #1e4634; }
  &.video, &.quick { color: #f59e0b; background: #2a2117; border-color: #4a3a20; }
  &.audio { color: #a78bfa; background: #241b38; border-color: #3b2f5c; }
}
.media-preview {
  position: fixed; inset: 0; z-index: 120; background: rgba(6, 10, 16, .72);
  display: grid; place-items: center; padding: 24px;
}
.mp-card {
  width: min(720px, 92vw); background: #1b1f26; border: 1px solid #2c333f; border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0,0,0,.5); overflow: hidden; color: #e8ecf3;
}
.mp-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px; border-bottom: 1px solid #262c36;
}
.mp-title { display: flex; align-items: center; gap: 8px; min-width: 0;
  b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}
.mp-body {
  background: #0f141b; min-height: 240px; max-height: 70vh; display: grid; place-items: center;
  img { max-width: 100%; max-height: 70vh; object-fit: contain; display: block; }
}
.mp-empty { color: #6b7684; padding: 48px; }
.mp-foot { padding: 10px 14px; font-size: 12px; border-top: 1px solid #262c36; }
.hist { margin-top: 2px; }
.hist-label { font-size: 11px; color: #8b95a3; margin-bottom: 6px; }
.hist-row { display: flex; gap: 6px; overflow-x: auto; }
.hist-thumb {
  width: 44px; height: 32px; border-radius: 6px; border: 1px solid #334155; background: #1f2937; padding: 0; overflow: hidden; cursor: pointer;
  &.on { border-color: #2d8cf0; }
  img { width: 100%; height: 100%; object-fit: cover; display: block; }
}
.sched-brief { font-size: 12px; color: #9aa8bd; }
.sched-card {
  padding: 12px; display: flex; flex-direction: column; gap: 8px; cursor: grab;
  &:active { cursor: grabbing; }
}
.sc-head {
  display: flex; align-items: center; gap: 8px;
  b { flex: 1; min-width: 0; font-size: 13px; color: #e8ecf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .more { border: 0; background: transparent; color: #6b7684; cursor: pointer; }
}
.sc-row {
  display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #8b95a3;
  em { font-style: normal; color: #cfd8e6; }
  em.ok { color: #34d399; }
}
.sc-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; }
.sc-thumbs {
  display: flex; align-items: center; gap: 4px; min-height: 28px;
  img { width: 36px; height: 28px; border-radius: 4px; object-fit: cover; border: 1px solid #2a3340; background: #151a22; }
  span { font-size: 11px; color: #8b95a3; padding: 0 4px; }
  .empty { color: #5d6675; }
}
.btn-tail.sm { height: 28px; min-width: auto; font-size: 11px; padding: 0 10px; }
.port {
  position: absolute; top: 48px; width: 12px; height: 12px; border-radius: 50%; background: #60a5fa; border: 2px solid #0b1220;
  z-index: 5; cursor: crosshair; box-shadow: 0 0 0 3px rgba(96,165,250,.18); opacity: 0; transition: opacity .15s;
  /* 扩大可点范围但不挡住拖卡片 */
  &::before { content: ''; position: absolute; inset: -8px; }
  &.in { left: -8px; } &.out { right: -8px; }
}
.node:hover .port, .node.active .port, .viewport.connecting .port { opacity: 1; }
/* 静默卡整块都可抓；展开卡只靠标题/预览拖 */
.node:not(.active) { cursor: grab; }
.node:not(.active):active { cursor: grabbing; }

.board-empty {
  position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; z-index: 5;
}
.board-empty-card {
  background: rgba(24,28,35,.92); border: 1px solid #2a3340; border-radius: 16px; padding: 24px 28px; width: 360px;
  .board-empty-title { font-size: 18px; font-weight: 700; margin-bottom: 12px; }
  ul { margin: 0; padding-left: 18px; color: #9aa8bd; font-size: 13px; line-height: 1.8; }
  .board-empty-foot { margin-top: 12px; font-size: 12px; color: #6b7684; }
}
.zoom-box {
  position: absolute; left: 16px; bottom: 16px; display: flex; align-items: center; gap: 2px;
  background: rgba(24,28,35,.94); border: 1px solid #2a3340; border-radius: 10px; padding: 4px; z-index: 20;
  button, div {
    min-width: 32px; height: 28px; border: 0; background: transparent; color: #c9d2de;
    display: grid; place-items: center; font-size: 12px; cursor: pointer; border-radius: 6px;
  }
  button:hover { background: #243040; }
  .txt { padding: 0 8px; min-width: auto; }
  .zb-sep { width: 1px; height: 16px; background: #2a3340; margin: 0 4px; }
}
.hint-bar {
  position: absolute; left: 280px; bottom: 22px; font-size: 11px; color: #5d6675; z-index: 15; pointer-events: none;
}
.mini-wrap {
  position: absolute; right: 16px; bottom: 16px; z-index: 20;
  background: rgba(15,23,42,.96); border: 1px solid #334155; border-radius: 12px; padding: 8px;
}
.minimap { display: block; border-radius: 8px; width: 212px; height: 104px; }
.mini-foot {
  display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; color: #8b95a3;
}
.sched-mask {
  position: fixed; inset: 0; z-index: 90; background: rgba(8, 12, 18, .55);
  display: grid; place-items: center; padding: 24px;
}
.sched-panel {
  width: 560px; max-width: 100%; max-height: min(86vh, 820px); overflow: auto;
  background: #1b1f26; border: 1px solid #2c333f; border-radius: 12px; color: #e8ecf3;
  box-shadow: 0 24px 64px rgba(0,0,0,.45);
}
.sp-head, .sp-next, .sp-form, .sp-queue-head, .sp-queue, .sp-foot { padding: 14px 16px; }
.sp-head {
  display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #262c36;
}
.sp-title { display: flex; gap: 10px; align-items: center; }
.sp-ico {
  width: 28px; height: 28px; border-radius: 7px; background: #2b2138; color: #b79aff;
  display: grid; place-items: center; font-size: 12px; font-weight: 700;
}
.sp-row { display: flex; gap: 8px; align-items: center; }
.sp-row b { font-size: 14px; }
.sp-row .on { background: #1f3a2e; color: #34d399; font-size: 11px; padding: 1px 7px; border-radius: 4px; }
.sp-sub, .sp-hint, .sp-label { color: #79838f; font-size: 12px; }
.icon-btn {
  width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: #8b95a3; cursor: pointer;
  &:hover { background: #243040; color: #e8ecf3; }
}
.sp-next {
  display: flex; justify-content: space-between; align-items: center; background: #151a22; border-bottom: 1px solid #262c36;
}
.sp-val { margin-top: 4px; font-size: 13px; color: #e8ecf3; }
.sp-line { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.sp-line .k { width: 72px; color: #a8b1be; font-size: 12px; flex-shrink: 0; }
.seg {
  display: flex; background: #14181f; border-radius: 6px; padding: 2px;
  button {
    border: 0; background: transparent; color: #8a94a2; padding: 5px 10px; border-radius: 5px; cursor: pointer; font-size: 12px;
    &.on { background: #243040; color: #7fb6f2; }
  }
}
.sp-input {
  height: 30px; border: 1px solid #2b3340; border-radius: 6px; background: #14181f; color: #e8ecf3;
  padding: 0 10px; font-size: 12px; width: 100px; outline: none;
  &.sm { width: 64px; }
  &:focus { border-color: #3b82f6; }
}
.sp-radio {
  display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: #c3cad6; cursor: pointer;
  input { accent-color: #3b82f6; }
}
.sp-queue-head { display: flex; justify-content: space-between; align-items: center; padding-bottom: 0; }
.linkish { border: 0; background: transparent; color: #7fb6f2; font-size: 12px; cursor: pointer; }
.sp-queue { padding-top: 10px; }
.sp-q {
  display: flex; align-items: center; gap: 10px; background: #151a22; border: 1px solid #2b3340;
  border-radius: 8px; padding: 10px; margin-bottom: 8px;
  .handle { color: #5d6675; letter-spacing: -2px; }
  .sp-q-main { flex: 1; min-width: 0; }
  .sp-q-main b { font-size: 13px; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}
.sp-add {
  width: 100%; border: 1px dashed #3a4553; background: transparent; color: #7fb6f2;
  border-radius: 8px; padding: 10px; cursor: pointer; font-size: 12px;
}
.sp-foot {
  display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; border-top: 1px solid #262c36;
}
.sp-acts { display: flex; gap: 8px; }
.ctx {
  position: fixed; z-index: 80; background: #151b27; border: 1px solid #2f3947; border-radius: 10px; min-width: 240px; padding: 6px;
  box-shadow: 0 12px 32px rgba(0,0,0,.35);
  .item {
    display: flex; justify-content: space-between; align-items: center; gap: 16px;
    padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; color: #e5e7eb;
  }
  .item:hover { background: #1f2937; }
  .item.danger { color: #f87171; }
  .sep { height: 1px; background: #2f3947; margin: 4px 8px; }
  kbd { font-size: 11px; color: #8b95a3; background: #0f172a; padding: 1px 6px; border-radius: 4px; }
}
.task-row { padding: 10px 0; border-bottom: 1px solid #1f2937; a { margin-right: 10px; } .danger { color: #f87171; } }
.grow { flex: 1; }
</style>
