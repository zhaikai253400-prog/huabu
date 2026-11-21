(function () {
  // 小工具从共用模块取（清单 38）。兜底一份等价实现：老页面缓存里可能还没有 utils.js
  const util = window.CanvasUtils || { pad2: (value) => String(value).padStart(2, '0') };
  const pad2 = util.pad2;
  const KIND_TEXT = { image: '图片', video: '视频', audio: '音频' };
  const KIND_ORDER = ['image', 'video', 'audio'];
  const AUTH_STYLES = [
    { value: 'bearer', label: 'Bearer（放 Authorization 头，最常用）' },
    { value: 'header', label: '自定义请求头' },
    { value: 'query', label: '放在 URL 参数里' },
    { value: 'none', label: '不带密钥' },
  ];
  const METHODS = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].map((v) => ({ value: v, label: v }));
  const CONTENT_TYPES = [
    { value: 'json', label: 'JSON（最常用）' },
    { value: 'form', label: '表单 form-urlencoded' },
    { value: 'text', label: '纯文本' },
    { value: 'multipart', label: 'multipart 表单（带本地素材时用）' },
    { value: 'none', label: '不带请求体' },
  ];
  const UPLOAD_TYPES = [
    { value: 'form', label: 'multipart 表单（最常用）' },
    { value: 'base64', label: '把素材内容塞进 JSON' },
    { value: 'binary', label: '原始字节直传' },
    { value: 'session', label: '会话分片上传（建会话→分片→校验）' },
  ];
  const DEFAULT_REF_LIMITS = {
    image: { exts: 'png,jpg,jpeg,webp,gif,bmp', maxMB: 20, maxSec: 0, totalMB: 0, maxCount: -1 },
    video: { exts: 'mp4,mov,webm,mkv', maxMB: 200, maxSec: 0, totalMB: 0, maxCount: -1 },
    audio: { exts: 'mp3,wav,m4a,aac,flac,ogg', maxMB: 50, maxSec: 0, totalMB: 0, maxCount: -1 },
  };
  const REF_COMPRESS_EDGES = [
    { value: '1024', label: '最长边 1024（最省）' },
    { value: '1280', label: '最长边 1280' },
    { value: '1600', label: '最长边 1600' },
    { value: '2048', label: '最长边 2048（推荐）' },
    { value: '2560', label: '最长边 2560' },
    { value: '3072', label: '最长边 3072' },
    { value: '3840', label: '最长边 3840（最清晰）' },
  ];
  const REF_COMPRESS_QUALITY = [
    { value: '1', label: '质量 1 · 最好' },
    { value: '2', label: '质量 2 · 画质优先（推荐）' },
    { value: '3', label: '质量 3 · 均衡' },
    { value: '4', label: '质量 4 · 更省体积' },
    { value: '5', label: '质量 5 · 最省体积' },
  ];
  const DEFAULT_BALANCE = {
    enabled: false,
    path: '/balance',
    method: 'GET',
    resultPath: 'credits',
    namePath: 'name',
    unitPath: 'unit',
    unitText: '',
    notePath: 'note',
    tasksPath: 'tasks',
  };
  const DEFAULT_RIDE = {
    enabled: false,
    path: '/api/ride',
    method: 'GET',
    ridePath: 'ride',
    idPath: 'id',
    statePath: 'state',
    departAtPath: 'departAt',
    onboardPath: 'onboard',
    triggerPath: 'batchTrigger',
    stateText: 'open:开放上车,accepting:即将发车,boarded:已上车待发,running:发车中,done:已发车',
  };
  const DEFAULT_UPLOAD = {
    enabled: false,
    path: '/files/upload',
    method: 'POST',
    contentType: 'form',
    field: 'file',
    extra: {},
    headers: {},
    resultUrl: 'data.url',
    resultId: 'data.id',
    timeoutSec: 300,
    appendExt: false,
    audio: DEFAULT_UPLOAD_KIND(),
    video: DEFAULT_UPLOAD_KIND(),
    // 主图床拒收音频 / 视频时，自动换 kappa.lol 重试一次（服务端执行）
    fallback: true,
  };
  // 「按类型单独上传」的空白模板：路径留空 = 跟随上面的通用设置
  function DEFAULT_UPLOAD_KIND() {
    return {
      path: '',
      method: '',
      contentType: '',
      field: '',
      appendExt: null,
      extra: {},
      headers: {},
      resultUrl: '',
      resultId: '',
      timeoutSec: 0,
    };
  }
  // 常被用到的图床预设：一键把「路径 / 取值路径 / 字段名」填对。
  // 只填调用方指定的那几个字段，别的保持原样（用户可能已经配了附加参数）。
  const UPLOAD_PRESETS = [
    { value: '', label: '（不用预设，自己填）' },
    { value: 'picui', label: 'PicUI（只收图片）' },
    { value: 'kappa', label: 'kappa.lol（图片 / 视频 / 音频，100 MB）' },
  ];
  const UPLOAD_PRESET_VALUES = {
    picui: { path: 'https://picui.cn/api/v1/upload', field: 'file', resultUrl: 'data.links.url', resultId: '', appendExt: false },
    kappa: { path: 'https://kappa.lol/api/upload', field: 'file', resultUrl: 'link', resultId: '', appendExt: true },
  };
  const DEFAULT_SIZE_MAP = {
    '1K': { '16:9': '1280x720', '9:16': '720x1280', '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152' },
    '2K': { '16:9': '2048x1152', '9:16': '1152x2048', '1:1': '1440x1440', '4:3': '1536x1152', '3:4': '1152x1536' },
    '4K': { '16:9': '3840x2160', '9:16': '2160x3840', '1:1': '2880x2880', '4:3': '3072x2304', '3:4': '2304x3072' },
  };
  const DEFAULT_VIDEO_SIZE_MAP = {
    '480p': { '16:9': '854x480', '9:16': '480x854', '1:1': '480x480', '4:3': '640x480', '3:4': '480x640' },
    '720p': { '16:9': '1280x720', '9:16': '720x1280', '1:1': '720x720', '4:3': '960x720', '3:4': '720x960' },
    '1080p': { '16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1080x1080', '4:3': '1440x1080', '3:4': '1080x1440' },
    '2K': { '16:9': '2560x1440', '9:16': '1440x2560', '1:1': '1440x1440', '4:3': '1920x1440', '3:4': '1440x1920' },
    '4K': { '16:9': '3840x2160', '9:16': '2160x3840', '1:1': '2160x2160', '4:3': '2880x2160', '3:4': '2160x2880' },
  };
  const ADD_PRESETS = [
    { kinds: ['image'], label: '图片通道', name: '新图片通道' },
    { kinds: ['video'], label: '视频通道', name: '新视频通道' },
    { kinds: ['audio'], label: '音频通道', name: '新音频通道' },
    { kinds: ['image', 'video', 'audio'], label: '全能通道', name: '新全能通道' },
  ];

  const listEl = document.getElementById('channel-list');
  const countEl = document.getElementById('channel-count');
  const saveStateEl = document.getElementById('channel-save-state');
  const searchEl = document.getElementById('ch-search');
  const ioPanel = document.getElementById('ch-io-panel');
  const importText = document.getElementById('ch-import-text');
  const includeKeysEl = document.getElementById('ch-include-keys');
  const ioReportEl = document.getElementById('ch-io-report');

  let channels = [];
  let channelTemplate = null;
  let hooks = {};
  let dirty = false;
  let saveTimer = null;
  let search = '';
  const notices = new Map();
  // 通道体检结果（清单 40）：id → { problems, notices, ok }，卡片头部角标靠它
  const inspectMap = new Map();
  const tests = new Map();
  const balances = new Map();
  const autoQueried = new Set();
  const rides = new Map();
  const autoRideQueried = new Set();
  const jsonDrafts = new Map();
  const openIds = new Set();
  const closedIds = new Set();
  const advancedOpen = new Set();
  const keyShown = new Set();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function makeText(value, onInput, placeholder) {
    const input = el('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = value === undefined || value === null ? '' : String(value);
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  function makeNumber(value, onInput, min, max) {
    const input = makeText(value, (text) => onInput(text));
    input.type = 'number';
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    return input;
  }

  function makeArea(value, onInput, rows) {
    const area = el('textarea');
    area.rows = rows || 4;
    area.spellcheck = false;
    area.value = value === undefined || value === null ? '' : String(value);
    area.addEventListener('input', () => onInput(area.value));
    return area;
  }

  function makeSelect(value, options, onChange) {
    const select = el('select');
    options.forEach((item) => {
      const opt = el('option', null, item.label);
      opt.value = item.value;
      if (String(item.value) === String(value)) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function makeCheckbox(labelText, checked, onChange) {
    const wrap = el('label', 'kind-box');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = Boolean(checked);
    box.addEventListener('change', () => onChange(box.checked));
    wrap.appendChild(box);
    wrap.appendChild(el('span', null, labelText));
    return wrap;
  }

  function fieldRow(labelText, control) {
    const wrap = el('div', 'field-row');
    wrap.appendChild(el('label', 'field-label', labelText));
    const box = el('div', 'field-ctl');
    box.appendChild(control);
    wrap.appendChild(box);
    return wrap;
  }

  function hintRow(text) {
    return el('div', 'field-hint', text);
  }

  function jsonField(channel, draftKey, labelText, value, applySet, rows) {
    const key = channel.id + '|' + draftKey;
    if (!jsonDrafts.has(key)) jsonDrafts.set(key, JSON.stringify(value || {}, null, 2));
    const area = makeArea(
      jsonDrafts.get(key),
      (text) => {
        jsonDrafts.set(key, text);
        try {
          const parsed = JSON.parse(text);
          area.classList.remove('bad');
          area.title = '';
          applySet(parsed);
          queueSave();
        } catch (error) {
          area.classList.add('bad');
          area.title = 'JSON 还没写对：' + error.message;
        }
      },
      rows || 4
    );
    area.classList.add('json-area');
    return fieldRow(labelText, area);
  }

  // 一行模型可以写“id”，也可以写“id | 显示名”，再加一段就是备注：“id | 显示名 | 备注”
  function parseModelEntry(entry) {
    const text = String(entry === undefined || entry === null ? '' : entry).trim();
    if (!text) return { id: '', label: '', note: '' };
    const parts = text
      .split(/\s*[|｜]\s*/)
      .map((item) => item.trim())
      .filter((item) => item !== '');
    if (parts.length >= 2) {
      return { id: parts[0], label: parts[1], note: parts.slice(2).join(' · ') };
    }
    return { id: text, label: text, note: '' };
  }

  function modelId(entry) {
    return parseModelEntry(entry).id;
  }

  function modelLabel(entry) {
    return parseModelEntry(entry).label;
  }

  function modelNote(entry) {
    return parseModelEntry(entry).note;
  }

  function splitModels(ids, filters) {
    const out = { image: [], video: [], audio: [], other: [] };
    const compiled = {};
    KIND_ORDER.forEach((kind) => {
      const pattern = String((filters && filters[kind]) || '').trim();
      if (!pattern) return;
      try {
        compiled[kind] = new RegExp(pattern, 'i');
      } catch {
        compiled[kind] = null;
      }
    });
    (ids || []).forEach((raw) => {
      const id = modelId(raw);
      if (!id) return;
      for (const kind of KIND_ORDER) {
        if (compiled[kind] && compiled[kind].test(id)) {
          if (out[kind].indexOf(id) < 0) out[kind].push(id);
          return;
        }
      }
      if (out.other.indexOf(id) < 0) out.other.push(id);
    });
    return out;
  }

  function matches(channel) {
    if (!search) return true;
    const needle = search.toLowerCase();
    const parts = [channel.name, channel.baseUrl, channel.notes];
    KIND_ORDER.forEach((kind) => {
      (channel.models[kind] || []).forEach((entry) => parts.push(String(entry)));
    });
    return parts.join(' ').toLowerCase().indexOf(needle) >= 0;
  }

  function isOpen(channel) {
    if (openIds.has(channel.id)) return true;
    if (closedIds.has(channel.id)) return false;
    return channels.length <= 3;
  }

  function setNotice(id, text, tone) {
    notices.set(id, { text: text, tone: tone || '' });
    render();
  }

  function render() {
    listEl.textContent = '';
    const shown = channels.filter(matches);
    countEl.textContent = channels.length
      ? '共 ' + channels.length + ' 个' + (search ? '（显示 ' + shown.length + ' 个）' : '')
      : '';
    if (!channels.length) {
      listEl.appendChild(
        el('div', 'empty-inline', '还没有通道。点下面的「+ 图片通道」这类按钮新建，把平台地址和密钥填进去就能用。')
      );
      return;
    }
    if (!shown.length) {
      listEl.appendChild(el('div', 'empty-inline', '没有匹配「' + search + '」的通道。'));
      return;
    }
    shown.forEach((channel) => {
      try {
        listEl.appendChild(buildCard(channel));
      } catch (error) {
        const broken = el('div', 'channel-card');
        broken.appendChild(el('div', 'channel-head', '通道「' + (channel && channel.name ? channel.name : '未命名') + '」读不出来：' + error.message));
        listEl.appendChild(broken);
      }
    });
  }

  function badge(text, tone) {
    return el('span', 'ch-badge' + (tone ? ' ' + tone : ''), text);
  }

  function buildCard(channel) {
    const card = el('div', 'channel-card');
    if (!isOpen(channel)) card.classList.add('collapsed');

    const head = el('div', 'channel-head');
    const toggle = el('button', 'ch-toggle', isOpen(channel) ? '▾' : '▸');
    toggle.title = '展开 / 收起这个通道';
    toggle.addEventListener('click', () => {
      if (isOpen(channel)) {
        closedIds.add(channel.id);
        openIds.delete(channel.id);
      } else {
        openIds.add(channel.id);
        closedIds.delete(channel.id);
      }
      render();
    });
    head.appendChild(toggle);

    const nameInput = makeText(
      channel.name,
      (value) => {
        channel.name = value;
        queueSave();
      },
      '通道名字，例如 AICopy 生图'
    );
    nameInput.className = 'channel-name';
    head.appendChild(nameInput);

    const badges = el('div', 'ch-badges');
    KIND_ORDER.forEach((kind) => {
      if (channel.kinds.indexOf(kind) < 0) return;
      badges.appendChild(badge(KIND_TEXT[kind] + ' ' + (channel.models[kind] || []).length));
    });
    if (!channel.baseUrl) badges.appendChild(badge('没填地址', 'warn'));
    else if (!channel.apiKey) badges.appendChild(badge('没填密钥', 'warn'));
    // 体检出的必填项缺失（清单 40）：数量摆在这儿，展开卡片能看到具体缺什么
    const missing = issueCountOf(channel);
    if (missing) {
      const flag = badge('缺 ' + missing + ' 项必填', 'bad');
      flag.title = '导入 / 保存时做的兼容检查发现的必填项缺失；展开卡片、点上面的保存，清单里会列出具体是哪几项';
      badges.appendChild(flag);
    } else {
      const soft = noticeCountOf(channel);
      if (soft) {
        const flag = badge(soft + ' 条提示', '');
        flag.title = '能跑，但有几处值得看一眼；点「导入 / 导出」里的体检清单能看到具体内容';
        badges.appendChild(flag);
      }
    }
    head.appendChild(badges);

    const enabledBox = makeCheckbox('启用', channel.enabled !== false, (checked) => {
      channel.enabled = checked;
      queueSave();
      render();
    });
    enabledBox.classList.add('channel-enabled');
    head.appendChild(enabledBox);

    const actions = el('div', 'ch-head-actions');
    const iconButton = (label, title, handler, className) => {
      const button = el('button', className || '', label);
      button.title = title;
      button.addEventListener('click', handler);
      return button;
    };
    actions.appendChild(
      iconButton('上移', '排在前面的通道优先使用', () => {
        const index = channels.indexOf(channel);
        if (index <= 0) return;
        channels.splice(index, 1);
        channels.splice(index - 1, 0, channel);
        render();
        queueSave(true);
      })
    );
    actions.appendChild(
      iconButton('下移', '往后排', () => {
        const index = channels.indexOf(channel);
        if (index < 0 || index >= channels.length - 1) return;
        channels.splice(index, 1);
        channels.splice(index + 1, 0, channel);
        render();
        queueSave(true);
      })
    );
    actions.appendChild(
      iconButton('复制', '复制成一个新通道，密钥也会一起复制', () => {
        const copy = JSON.parse(JSON.stringify(channel));
        copy.id = 'ch_' + Math.random().toString(16).slice(2, 10);
        copy.name = channel.name + ' 副本';
        channels.splice(channels.indexOf(channel) + 1, 0, copy);
        openIds.add(copy.id);
        closedIds.delete(copy.id);
        render();
        queueSave(true);
      })
    );
    actions.appendChild(
      iconButton('导出', '把这个通道复制成 JSON（不带密钥）', () => {
        const plain = JSON.parse(JSON.stringify(channel));
        plain.apiKey = '';
        copyText(JSON.stringify(plain, null, 2)).then((ok) => {
          saveStateEl.textContent = ok ? '这个通道的 JSON 已复制（密钥没带出去）' : '复制失败，请手动选中复制';
          saveStateEl.className = 'hint ' + (ok ? 'ok' : 'bad');
        });
      })
    );
    actions.appendChild(
      iconButton(
        '删除',
        '删掉这个通道',
        () => {
          if (!window.confirm('确定删掉通道「' + channel.name + '」吗？画布上已经生成的东西不受影响。')) return;
          channels = channels.filter((item) => item.id !== channel.id);
          render();
          queueSave(true);
        },
        'danger'
      )
    );
    head.appendChild(actions);
    card.appendChild(head);

    const body = el('div', 'channel-body');
    body.appendChild(
      fieldRow(
        '备注',
        makeText(channel.notes, (value) => { channel.notes = value; queueSave(); }, '提醒自己的话，比如「这个平台晚上便宜」')
      )
    );
    body.appendChild(
      fieldRow('Base URL', makeText(channel.baseUrl, (value) => { channel.baseUrl = value; queueSave(); }, 'https://api.xxx.com/v1'))
    );

    const keyRow = el('div', 'field-row');
    keyRow.appendChild(el('label', 'field-label', '密钥'));
    const keyBox = el('div', 'field-ctl ch-keyrow');
    const keyInput = makeText(channel.apiKey, (value) => { channel.apiKey = value; queueSave(); }, 'sk-...');
    keyInput.type = keyShown.has(channel.id) ? 'text' : 'password';
    keyInput.autocomplete = 'off';
    const showBtn = el('button', null, keyShown.has(channel.id) ? '隐藏' : '显示');
    showBtn.addEventListener('click', () => {
      if (keyShown.has(channel.id)) keyShown.delete(channel.id);
      else keyShown.add(channel.id);
      render();
    });
    keyBox.appendChild(keyInput);
    keyBox.appendChild(showBtn);
    keyRow.appendChild(keyBox);
    body.appendChild(keyRow);
    body.appendChild(
      hintRow(
        '密钥加密后保存在这台电脑的 data\\config.json 里，不写进画布文件。' +
          '解锁用的 data\\secret.key 带一份「可移植副本」：换电脑 / 换 Windows 账户 / 同步程序之后，' +
          '原来的密钥照样能用，不用重新填。'
      )
    );

    body.appendChild(buildBalanceRow(channel));
    body.appendChild(buildRideRow(channel));

    KIND_ORDER.forEach((kind) => {
      if (channel.kinds.indexOf(kind) < 0) return;
      body.appendChild(buildModelBlock(channel, kind));
    });

    if (channel.kinds.indexOf('image') >= 0) body.appendChild(buildTestRow(channel));
    if (channel.kinds.indexOf('video') >= 0) body.appendChild(buildVideoTestRow(channel));
    body.appendChild(buildAdvanced(channel));

    const notice = notices.get(channel.id);
    if (notice) body.appendChild(el('div', 'channel-notice ' + (notice.tone || ''), notice.text));

    card.appendChild(body);
    return card;
  }


  // 模型清单改了以后，把已经不存在的模型从人脸处理勾选里去掉
  function pruneFacePicks(channel, kind) {
    if (!channel.faceProcessing || typeof channel.faceProcessing !== 'object') return;
    const picked = channel.faceProcessing[kind];
    if (!Array.isArray(picked) || !picked.length) return;
    const alive = (channel.models[kind] || []).map((entry) => modelId(entry));
    channel.faceProcessing[kind] = picked.filter((id) => alive.indexOf(id) >= 0);
  }
  function buildModelBlock(channel, kind) {
    const box = el('div', 'model-block');
    const title = el('div', 'model-title');
    const list = channel.models[kind] || [];
    title.appendChild(el('span', null, KIND_TEXT[kind] + '模型（一行一个，可写「id | 显示名 | 备注」）'));
    title.appendChild(el('span', 'model-count', list.length + ' 个'));
    const probe = el('button', null, '拉取模型');
    probe.title = '按高级设置里的路径去问平台要模型清单，拿回来自动分类填好';
    probe.addEventListener('click', () => probeChannelModels(channel));
    title.appendChild(probe);
    const tidy = el('button', null, '重新归类');
    tidy.title = '把框里的模型按「归类规则」重新分到图片 / 视频 / 音频';
    tidy.addEventListener('click', () => reclassify(channel, kind));
    title.appendChild(tidy);
    const clear = el('button', null, '清空');
    clear.addEventListener('click', () => {
      if (!window.confirm('清空「' + KIND_TEXT[kind] + '模型」列表框？')) return;
      channel.models[kind] = [];
      render();
      queueSave(true);
    });
    title.appendChild(clear);
    box.appendChild(title);

    const area = makeArea(
      list.join('\n'),
      (text) => {
        channel.models[kind] = text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        pruneFacePicks(channel, kind);
        queueSave();
      },
      4
    );
    area.placeholder = 'gpt-image-2.5-flare\n模型id | 显示名 | 备注（备注可省）\nseedance-2.5 | Seedance 2.5 | 新标中转';
    box.appendChild(area);

    const defaults = channel.defaults || (channel.defaults = { image: '', video: '', audio: '' });
    const options = [{ value: '', label: '（不指定，默认用清单第一个）' }].concat(
      list.map((entry) => ({
        value: modelId(entry),
        label:
          modelLabel(entry) +
          (modelNote(entry) ? ' · ' + modelNote(entry) : '') +
          '（' + modelId(entry) + '）',
      }))
    );

    // 人脸处理：平台级开关，按模型逐个勾。只有勾上的模型提交时才会带上，不勾就完全不带这个字段。
    if (kind === 'image' || kind === 'video') {
      if (!channel.faceProcessing || typeof channel.faceProcessing !== 'object') {
        channel.faceProcessing = { image: [], video: [], audio: [] };
      }
      const faceConf = channel.faceProcessing;
      if (!Array.isArray(faceConf[kind])) faceConf[kind] = [];
      const picked = faceConf[kind];
      const faceBox = el('div', 'model-block face-block');
      const faceTitle = el('div', 'model-title');
      faceTitle.appendChild(el('span', null, '参考图人脸处理（按模型勾选，默认关）'));
      const faceCount = el('span', 'model-count', picked.length ? '已开 ' + picked.length + ' 个' : '全部关闭');
      faceTitle.appendChild(faceCount);
      faceBox.appendChild(faceTitle);
      faceBox.appendChild(
        hintRow(
          '勾上的模型提交时会带上「人脸处理」：平台先对参考图做一次人脸处理，让模型更容易还原参考人物的长相。只对参考图生效，参考视频 / 音频 / 文字不受影响，不额外收费；但它是「开启」而不是「保证」，个别图处理失败就按原图提交。'
        )
      );
      if (!list.length) {
        faceBox.appendChild(hintRow('上面还没有' + KIND_TEXT[kind] + '模型，先填模型再回来勾。'));
      } else {
        const faceRow = el('div', 'kind-row face-picks');
        list.forEach((entry) => {
          const id = modelId(entry);
          if (!id) return;
          const hit = picked.indexOf(id) >= 0;
          const box = makeCheckbox(modelLabel(entry) || id, hit, (checked) => {
            const at = picked.indexOf(id);
            if (checked && at < 0) picked.push(id);
            if (!checked && at >= 0) picked.splice(at, 1);
            faceCount.textContent = picked.length ? '已开 ' + picked.length + ' 个' : '全部关闭';
            queueSave(true);
          });
          box.title = id + ' · 只影响这个模型';
          faceRow.appendChild(box);
        });
        faceBox.appendChild(faceRow);
      }
      faceBox.appendChild(hintRow('只勾真正需要还原人物长相的模型就好；清单里删掉的模型会自动从勾选里清掉。这个字段要平台支持才行（通道2 的文档里有），不支持的平台勾了可能被拒单。'));
      box.appendChild(faceBox);
    }
    box.appendChild(
      fieldRow(
        '默认用哪个',
        makeSelect(defaults[kind], options, (value) => {
          defaults[kind] = value;
          queueSave();
        })
      )
    );
    return box;
  }

  function buildTestRow(channel) {
    const wrap = el('div', 'channel-test');
    const models = channel.models.image || [];
    const select = makeSelect(models[0] ? modelId(models[0]) : '', models.map((id) => ({
      value: modelId(id),
      label: modelLabel(id) + (modelNote(id) ? ' · ' + modelNote(id) : ''),
    })), () => {});
    select.className = 'test-model';
    const button = el('button', null, '试生成一张图');
    if (!models.length) {
      button.disabled = true;
      button.title = '先在上面填一个图片模型';
    }
    const box = el('div', 'test-box');
    button.addEventListener('click', () => runChannelTest(channel, select.value, box, button));
    wrap.appendChild(el('span', 'field-label', '试一张'));
    wrap.appendChild(select);
    wrap.appendChild(button);
    wrap.appendChild(box);
    const remembered = tests.get(channel.id);
    if (remembered) paintTest(box, remembered);
    return wrap;
  }

  function paintTest(box, result) {
    box.textContent = '';
    if (result.url) {
      const isVideo = result.kind === 'video' || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(result.url);
      if (isVideo) {
        const video = el('video', 'test-thumb video');
        video.src = result.url;
        video.controls = true;
        video.muted = true;
        video.playsInline = true;
        box.appendChild(video);
      } else {
        const img = el('img', 'test-thumb');
        img.src = result.url;
        box.appendChild(img);
      }
    }
    box.appendChild(el('span', 'test-text ' + (result.tone || ''), result.text));
  }

  // 余额查询：只读接口，不扣次数
  function buildBalanceRow(channel) {
    const wrap = el('div', 'channel-test');
    wrap.appendChild(el('span', 'field-label', '余额'));
    const button = el('button', null, '查余额');
    button.title = '问一下平台还剩多少次 / 多少钱，不会扣费';
    if (!channel.balance || channel.balance.enabled !== true) {
      button.disabled = true;
      button.title = '先在高级设置里打开「余额查询」并填好路径';
    }
    const box = el('div', 'test-box');
    box.dataset.balanceFor = channel.id;
    button.addEventListener('click', () => runBalanceQuery(channel, box, button));
    wrap.appendChild(button);
    wrap.appendChild(box);
    const remembered = balances.get(channel.id);
    if (remembered) paintBalance(box, remembered);
    return wrap;
  }

  function balanceTimeText(stamp) {
    const d = new Date(stamp);
    if (isNaN(d.getTime())) return '';
    const pad = pad2;
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function paintBalance(box, result) {
    box.textContent = '';
    if (!result) return;
    box.appendChild(el('span', 'test-text ' + (result.tone || ''), result.text || '—'));
    if (result.stamp) box.appendChild(el('span', 'balance-stamp', balanceTimeText(result.stamp)));
  }

  async function runBalanceQuery(channel, box, button) {
    button.disabled = true;
    paintBalance(box, { text: '正在查…' });
    await flushSave();
    try {
      const res = await window.api.channelBalance(channel);
      const done = { text: describeBalance(res), tone: 'ok', stamp: Date.now() };
      balances.set(channel.id, done);
      paintBalance(box, done);
      paintBalanceElsewhere(channel.id, done);
    } catch (error) {
      const failed = { text: '查询失败：' + error.message, tone: 'bad', stamp: Date.now() };
      balances.set(channel.id, failed);
      paintBalance(box, failed);
    } finally {
      button.disabled = false;
    }
  }

  // 页面上可能同时有好几个「余额」行（重绘过），都跟着更新
  function paintBalanceElsewhere(channelId, result) {
    const boxes = document.querySelectorAll('[data-balance-for="' + channelId + '"]');
    boxes.forEach((box) => {
      if (box.classList && box.classList.contains('test-box')) paintBalance(box, result);
    });
  }

  // 打开设置页时顺手查一遍已经打开余额查询的通道，省得每次都手动点
  async function autoQueryBalances() {
    const targets = channels.filter((channel) => channel.balance && channel.balance.enabled === true);
    for (const channel of targets) {
      if (autoQueried.has(channel.id)) continue;
      autoQueried.add(channel.id);
      try {
        const res = await window.api.channelBalance(channel);
        const done = { text: describeBalance(res), tone: 'ok', stamp: Date.now() };
        balances.set(channel.id, done);
        paintBalanceElsewhere(channel.id, done);
      } catch (error) {
        const failed = { text: '查询失败：' + error.message, tone: 'bad', stamp: Date.now() };
        balances.set(channel.id, failed);
        paintBalanceElsewhere(channel.id, failed);
      }
    }
  }

  // 下一班发车：只读接口，不扣次数
  function buildRideRow(channel) {
    const wrap = el('div', 'channel-test');
    wrap.appendChild(el('span', 'field-label', '班次'));
    const button = el('button', null, '查班次');
    button.title = '看看平台现在这一班排到哪了，只读、不扣费';
    if (!channel.ride || channel.ride.enabled !== true) {
      button.disabled = true;
      button.title = '先在高级设置里打开「班次查询」并填好路径';
    }
    const box = el('div', 'test-box');
    box.dataset.rideFor = channel.id;
    button.addEventListener('click', () => runRideQuery(channel, box, button));
    wrap.appendChild(button);
    wrap.appendChild(box);
    const remembered = rides.get(channel.id);
    if (remembered) paintRide(box, remembered);
    return wrap;
  }

  function paintRide(box, result) {
    box.textContent = '';
    if (!result) return;
    box.appendChild(el('span', 'test-text ' + (result.tone || ''), result.text || '—'));
    if (result.stamp) box.appendChild(el('span', 'balance-stamp', balanceTimeText(result.stamp)));
  }

  function paintRideElsewhere(channelId, result) {
    const boxes = document.querySelectorAll('[data-ride-for="' + channelId + '"]');
    boxes.forEach((box) => {
      if (box.classList && box.classList.contains('test-box')) paintRide(box, result);
    });
  }

  async function runRideQuery(channel, box, button) {
    button.disabled = true;
    paintRide(box, { text: '正在查…' });
    await flushSave();
    try {
      const res = await window.api.channelRide(channel);
      const done = { text: describeRide(res), tone: 'ok', stamp: Date.now() };
      rides.set(channel.id, done);
      paintRide(box, done);
      paintRideElsewhere(channel.id, done);
    } catch (error) {
      const failed = { text: '查询失败：' + error.message, tone: 'bad', stamp: Date.now() };
      rides.set(channel.id, failed);
      paintRide(box, failed);
      paintRideElsewhere(channel.id, failed);
    } finally {
      button.disabled = false;
    }
  }

  function describeRide(res) {
    const ride = res && res.ride;
    if (!ride) return '现在没有排班（平台还没开下一班）';
    const parts = ['班次 ' + (ride.id || '?')];
    const state = String(ride.state || '');
    const stateLabel = ride.stateText && ride.stateText !== ride.state ? ride.stateText : state || '状态未知';
    parts.push(stateLabel);
    const boarded = ride.onboard === null || ride.onboard === undefined ? null : Number(ride.onboard);
    const need = ride.trigger === null || ride.trigger === undefined ? null : Number(ride.trigger);
    const waiting = state === 'open' || state === 'accepting' || state === 'boarded';
    const departed = state === 'running' || state === 'done';
    if (waiting && boarded !== null && need !== null && need > 0) {
      parts.push('已上车 ' + boarded + ' / ' + need + ' 条');
      const left = Math.max(0, need - boarded);
      if (left > 0) parts.push('还差 ' + left + ' 条就发车');
      else parts.push('够数了，马上就发');
    } else if (boarded !== null) {
      parts.push('本班 ' + boarded + ' 条');
    } else if (need !== null && need > 0 && waiting) {
      parts.push('满 ' + need + ' 条发车');
    }
    const depart = rideDepartText(ride);
    if (depart) parts.push(depart);
    if (waiting) parts.push('攒够一车才走，说不准几点');
    else if (departed && need !== null && need > 0) parts.push('下一班凑满 ' + need + ' 条再发');
    return parts.join(' · ');
  }

  // 只有真的发车了，平台给的时间才可信；还在候车时那个时间会滚动，写出来反而误导
  function rideDepartText(ride) {
    if (!ride || !ride.departAt) return '';
    const state = String(ride.state || '');
    if (state !== 'running' && state !== 'done') return '';
    const d = new Date(ride.departAt);
    if (isNaN(d.getTime())) return '';
    const pad = pad2;
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const stamp = pad(d.getHours()) + ':' + pad(d.getMinutes());
    return '本班 ' + (sameDay ? '' : pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ') + stamp + ' 已发车';
  }

  async function autoQueryRides() {
    const targets = channels.filter((channel) => channel.ride && channel.ride.enabled === true);
    for (const channel of targets) {
      if (autoRideQueried.has(channel.id)) continue;
      autoRideQueried.add(channel.id);
      try {
        const res = await window.api.channelRide(channel);
        const done = { text: describeRide(res), tone: 'ok', stamp: Date.now() };
        rides.set(channel.id, done);
        paintRideElsewhere(channel.id, done);
      } catch (error) {
        const failed = { text: '查询失败：' + error.message, tone: 'bad', stamp: Date.now() };
        rides.set(channel.id, failed);
        paintRideElsewhere(channel.id, failed);
      }
    }
  }

  function describeBalance(res) {
    const parts = [];
    if (res.credits === null || res.credits === undefined) parts.push('余额没认出来（检查取值路径）');
    else parts.push('剩余 ' + res.credits + (res.unit ? ' ' + res.unit : ''));
    if (res.name) parts.push(res.name);
    if (res.tasks) {
      const t = res.tasks;
      parts.push('完成 ' + t.done + ' / 失败 ' + t.failed + ' / 进行中 ' + t.running + ' / 排队 ' + t.pending);
    }
    if (res.note) parts.push(res.note);
    return parts.join(' · ');
  }

  function buildVideoTestRow(channel) {
    const wrap = el('div', 'channel-test');
    const models = channel.models.video || [];
    const select = makeSelect(models[0] ? modelId(models[0]) : '', models.map((id) => ({
      value: modelId(id),
      label: modelLabel(id) + (modelNote(id) ? ' · ' + modelNote(id) : ''),
    })), () => {});
    select.className = 'test-model';
    const button = el('button', null, '试生成一段视频');
    button.title = '会按 5 秒、720P 试一段，真的扣费，通常要等几分钟到几十分钟';
    if (!models.length) {
      button.disabled = true;
      button.title = '先在上面填一个视频模型';
    }
    const box = el('div', 'test-box');
    button.addEventListener('click', () => runVideoTest(channel, select.value, box, button));
    wrap.appendChild(el('span', 'field-label', '试一段'));
    wrap.appendChild(select);
    wrap.appendChild(button);
    wrap.appendChild(box);
    const remembered = tests.get(channel.id + '|video');
    if (remembered) paintTest(box, remembered);
    return wrap;
  }

  async function runVideoTest(channel, model, box, button) {
    if (!model) return;
    if (
      !window.confirm(
        '试生成视频会真的扣费，而且要等几分钟到几十分钟。\n\n确认要用「' + model + '」试一段 5 秒、720P 的视频吗？'
      )
    ) {
      return;
    }
    button.disabled = true;
    paintTest(box, { text: '正在提交…' });
    await flushSave();
    let task = null;
    try {
      const res = await window.api.testChannelVideo({
        channelId: channel.id,
        model: model,
        duration: 5,
        resolution: '720p',
        ratio: '16:9',
      });
      task = res.task;
    } catch (error) {
      paintTest(box, { text: '提交失败：' + error.message, tone: 'bad' });
      button.disabled = false;
      return;
    }
    const startedAt = Date.now();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      let current = null;
      try {
        const res = await window.api.task(task.id);
        current = res.task;
      } catch (error) {
        paintTest(box, { text: '读取进度失败：' + error.message, tone: 'bad' });
        break;
      }
      if (!current) {
        paintTest(box, { text: '这条试生成任务找不到了（服务可能重启过）', tone: 'bad' });
        break;
      }
      if (current.status === 'done') {
        const result = current.result || {};
        const done = {
          url: result.url || '',
          kind: 'video',
          text: '成功，' + model + ' 能出视频（已存到 素材\\视频）',
          tone: 'ok',
        };
        tests.set(channel.id + '|video', done);
        paintTest(box, done);
        break;
      }
      if (current.status === 'failed' || current.status === 'canceled') {
        const failed = { text: (current.status === 'canceled' ? '已取消：' : '失败：') + (current.error || ''), tone: 'bad' };
        tests.set(channel.id + '|video', failed);
        paintTest(box, failed);
        break;
      }
      const mins = Math.floor((Date.now() - startedAt) / 60000);
      paintTest(box, { text: (current.stage || '生成中') + '（已等 ' + mins + ' 分钟，可以离开这个页面，服务会一直等）' });
    }
    button.disabled = false;
  }

  async function runChannelTest(channel, model, box, button) {
    if (!model) return;
    button.disabled = true;
    paintTest(box, { text: '正在试生成，可能要等一分钟…' });
    await flushSave();
    try {
      const res = await window.api.testChannelImage({
        channelId: channel.id,
        model: model,
        sizeKey: '1K',
        ratio: '16:9',
      });
      const done = { url: res.result.url, text: '成功，' + model + ' 能出图（已存到素材目录）', tone: 'ok' };
      tests.set(channel.id, done);
      paintTest(box, done);
    } catch (error) {
      const failed = { text: '失败：' + error.message, tone: 'bad' };
      tests.set(channel.id, failed);
      paintTest(box, failed);
    } finally {
      button.disabled = false;
    }
  }

  function buildAdvanced(channel) {
    const details = el('details', 'channel-advanced');
    if (advancedOpen.has(channel.id)) details.open = true;
    details.addEventListener('toggle', () => {
      if (details.open) advancedOpen.add(channel.id);
      else advancedOpen.delete(channel.id);
    });
    details.appendChild(
      el('summary', null, '高级设置：鉴权 / 接口路径 / 请求体模板 / 结果取值 / 归类规则 / 异步轮询（默认按 OpenAI 兼容接口填好了）')
    );
    const body = el('div', 'advanced-body');

    body.appendChild(el('div', 'advanced-title', '鉴权'));
    const authGrid = el('div', 'grid-2');
    authGrid.appendChild(
      fieldRow(
        '鉴权方式',
        makeSelect(channel.auth.style, AUTH_STYLES, (v) => {
          channel.auth.style = v;
          queueSave();
        })
      )
    );
    authGrid.appendChild(
      fieldRow('请求头名字', makeText(channel.auth.header, (v) => { channel.auth.header = v; queueSave(); }))
    );
    body.appendChild(authGrid);
    const authGrid2 = el('div', 'grid-2');
    authGrid2.appendChild(fieldRow('前缀', makeText(channel.auth.prefix, (v) => { channel.auth.prefix = v; queueSave(); }, 'Bearer ')));
    authGrid2.appendChild(fieldRow('URL 参数名', makeText(channel.auth.query, (v) => { channel.auth.query = v; queueSave(); }, 'key')));
    body.appendChild(authGrid2);

    const extraGrid = el('div', 'grid-2');
    extraGrid.appendChild(jsonField(channel, 'headers', '固定请求头（JSON）', channel.headers, (parsed) => { channel.headers = parsed; }, 4));
    extraGrid.appendChild(jsonField(channel, 'query', '固定 URL 参数（JSON）', channel.query, (parsed) => { channel.query = parsed; }, 4));
    body.appendChild(extraGrid);

    body.appendChild(el('div', 'advanced-title', '拉模型清单的接口'));
    body.appendChild(
      makeCheckbox('这个平台没有模型清单接口（模型我手动填）', channel.lists.enabled === false, (checked) => {
        channel.lists.enabled = !checked;
        queueSave();
        render();
      })
    );
    if (channel.lists.enabled === false) {
      body.appendChild(hintRow('模型请直接写在上面「可用模型」框里，一行一个，格式：模型ID | 显示名 | 备注。'));
      body.appendChild(el('div', 'advanced-title', '拉模型时按这些正则归类'));
      const fg = el('div', 'grid-3');
      KIND_ORDER.forEach((kind) => {
        fg.appendChild(
          fieldRow(KIND_TEXT[kind], makeText(channel.filters[kind], (v) => { channel.filters[kind] = v; queueSave(); }))
        );
      });
      body.appendChild(fg);
      return body;
    }
    const listGrid = el('div', 'grid-3');
    listGrid.appendChild(fieldRow('路径', makeText(channel.lists.path, (v) => { channel.lists.path = v; queueSave(); }, '/models')));
    listGrid.appendChild(
      fieldRow(
        '方法',
        makeSelect(channel.lists.method || 'GET', METHODS, (v) => {
          channel.lists.method = v;
          queueSave();
        })
      )
    );
    listGrid.appendChild(
      fieldRow('模型名字段', makeText(channel.lists.itemId, (v) => { channel.lists.itemId = v; queueSave(); }, 'id'))
    );
    body.appendChild(listGrid);
    body.appendChild(
      fieldRow('模型清单取值路径', makeText(channel.lists.resultPath, (v) => { channel.lists.resultPath = v; queueSave(); }, 'data'))
    );

    body.appendChild(el('div', 'advanced-title', '拉模型时按这些正则归类'));
    const filterGrid = el('div', 'grid-3');
    KIND_ORDER.forEach((kind) => {
      filterGrid.appendChild(
        fieldRow(KIND_TEXT[kind], makeText(channel.filters[kind], (v) => { channel.filters[kind] = v; queueSave(); }))
      );
    });
    body.appendChild(filterGrid);

    KIND_ORDER.forEach((kind) => {
      if (channel.kinds.indexOf(kind) < 0) return;
      body.appendChild(buildKindSpec(channel, kind));
    });

    const sizeBox = el('div', 'model-block');
    const sizeHead = el('div', 'model-title');
    sizeHead.appendChild(el('span', null, '尺寸对照表（档位 → 比例 → 实际像素）'));
    const resetSize = el('button', null, '恢复成默认表');
    resetSize.addEventListener('click', () => {
      channel.sizeMap = JSON.parse(JSON.stringify(DEFAULT_SIZE_MAP));
      jsonDrafts.delete(channel.id + '|sizeMap');
      render();
      queueSave(true);
    });
    sizeHead.appendChild(resetSize);
    sizeBox.appendChild(sizeHead);
    sizeBox.appendChild(
      jsonField(channel, 'sizeMap', '尺寸对照表（JSON）', channel.sizeMap, (parsed) => { channel.sizeMap = parsed; }, 8)
    );
    body.appendChild(sizeBox);

    if (channel.kinds.indexOf('video') >= 0) {
      const videoBox = el('div', 'model-block');
      const videoHead = el('div', 'model-title');
      videoHead.appendChild(el('span', null, '视频尺寸对照表（分辨率档位 → 比例 → 实际像素）'));
      const resetVideo = el('button', null, '恢复成默认表');
      resetVideo.addEventListener('click', () => {
        channel.videoSizeMap = JSON.parse(JSON.stringify(DEFAULT_VIDEO_SIZE_MAP));
        jsonDrafts.delete(channel.id + '|videoSizeMap');
        render();
        queueSave(true);
      });
      videoHead.appendChild(resetVideo);
      videoBox.appendChild(videoHead);
      videoBox.appendChild(
        jsonField(
          channel,
          'videoSizeMap',
          '视频尺寸对照表（JSON）',
          channel.videoSizeMap,
          (parsed) => { channel.videoSizeMap = parsed; },
          8
        )
      );
      videoBox.appendChild(hintRow('卡片上选「720P / 1080P」时，接口里的 {{size}} 就按这张表换算；视频模板里也可以直接用 {{resolution}}。'));
      body.appendChild(videoBox);
    }

    if (!channel.balance) channel.balance = JSON.parse(JSON.stringify(DEFAULT_BALANCE));
    const balance = channel.balance;
    body.appendChild(el('div', 'advanced-title', '余额查询（可选，只读，不扣次数）'));
    body.appendChild(
      hintRow(
        '平台有专门的「查余量 / 查余额」接口时可以打开。怎么查：先填路径，点卡片上的「查余额」，看结果里的取值路径对不对；不对就照着平台返回的字段名改。'
      )
    );
    body.appendChild(
      makeCheckbox('这个通道可以查余额', balance.enabled === true, (checked) => {
        balance.enabled = checked;
        queueSave(true);
        render();
      })
    );
    if (balance.enabled === true) {
      const balGrid = el('div', 'grid-2');
      balGrid.appendChild(
        fieldRow('查询路径', makeText(balance.path, (v) => { balance.path = v; queueSave(); }, '/api/balance'))
      );
      balGrid.appendChild(
        fieldRow(
          '方法',
          makeSelect(balance.method || 'GET', METHODS, (v) => {
            balance.method = v;
            queueSave();
          })
        )
      );
      body.appendChild(balGrid);
      const balGrid2 = el('div', 'grid-3');
      balGrid2.appendChild(
        fieldRow('余额取值路径', makeText(balance.resultPath, (v) => { balance.resultPath = v; queueSave(); }, 'credits'))
      );
      balGrid2.appendChild(
        fieldRow('账号名取值路径', makeText(balance.namePath, (v) => { balance.namePath = v; queueSave(); }, 'name'))
      );
      balGrid2.appendChild(
        fieldRow('单位取值路径', makeText(balance.unitPath, (v) => { balance.unitPath = v; queueSave(); }, 'unit'))
      );
      body.appendChild(balGrid2);
      const balGrid3 = el('div', 'grid-3');
      balGrid3.appendChild(
        fieldRow('说明取值路径', makeText(balance.notePath, (v) => { balance.notePath = v; queueSave(); }, 'note'))
      );
      balGrid3.appendChild(
        fieldRow('任务统计取值路径', makeText(balance.tasksPath, (v) => { balance.tasksPath = v; queueSave(); }, 'tasks'))
      );
      body.appendChild(balGrid3);
      body.appendChild(
        fieldRow('固定单位（填了就不读接口，例如「积分」）', makeText(balance.unitText, (v) => { balance.unitText = v; queueSave(); }, '积分'))
      );
      body.appendChild(hintRow('取值路径留空就表示这一项不要；余额读不出来时会自动试 remaining 字段。'));
    }

    if (!channel.ride) channel.ride = JSON.parse(JSON.stringify(DEFAULT_RIDE));
    const rideConf = channel.ride;
    body.appendChild(el('div', 'advanced-title', '班次查询（可选，只读，不扣次数）'));
    body.appendChild(
      hintRow(
        '平台首页上会显示「下一班发车」这类排班信息时，可以打开这里，把卡片上的「查班次」接到同一个接口。'
      )
    );
    body.appendChild(
      makeCheckbox('这个通道可以查下一班发车', rideConf.enabled === true, (checked) => {
        rideConf.enabled = checked;
        queueSave(true);
        render();
      })
    );
    if (rideConf.enabled === true) {
      const rideGrid = el('div', 'grid-2');
      rideGrid.appendChild(
        fieldRow('查询路径', makeText(rideConf.path, (v) => { rideConf.path = v; queueSave(); }, '/api/ride'))
      );
      rideGrid.appendChild(
        fieldRow(
          '方法',
          makeSelect(rideConf.method || 'GET', METHODS, (v) => {
            rideConf.method = v;
            queueSave();
          })
        )
      );
      body.appendChild(rideGrid);
      const rideGrid2 = el('div', 'grid-3');
      rideGrid2.appendChild(
        fieldRow('班次对象路径', makeText(rideConf.ridePath, (v) => { rideConf.ridePath = v; queueSave(); }, 'ride'))
      );
      rideGrid2.appendChild(
        fieldRow('班次号路径', makeText(rideConf.idPath, (v) => { rideConf.idPath = v; queueSave(); }, 'id'))
      );
      rideGrid2.appendChild(
        fieldRow('状态路径', makeText(rideConf.statePath, (v) => { rideConf.statePath = v; queueSave(); }, 'state'))
      );
      body.appendChild(rideGrid2);
      const rideGrid3 = el('div', 'grid-3');
      rideGrid3.appendChild(
        fieldRow('发车时刻路径', makeText(rideConf.departAtPath, (v) => { rideConf.departAtPath = v; queueSave(); }, 'departAt'))
      );
      rideGrid3.appendChild(
        fieldRow('已上车条数路径', makeText(rideConf.onboardPath, (v) => { rideConf.onboardPath = v; queueSave(); }, 'onboard'))
      );
      rideGrid3.appendChild(
        fieldRow('满车条数路径', makeText(rideConf.triggerPath, (v) => { rideConf.triggerPath = v; queueSave(); }, 'batchTrigger'))
      );
      body.appendChild(rideGrid3);
      body.appendChild(
        fieldRow(
          '状态文字对照',
          makeText(rideConf.stateText, (v) => { rideConf.stateText = v; queueSave(); }, 'open:开放上车,running:发车中')
        )
      );
      body.appendChild(hintRow('格式是「英文状态:中文说明」，用英文逗号隔开；没写到的状态就原样显示英文。'));
    }

    if (!channel.upload) channel.upload = JSON.parse(JSON.stringify(DEFAULT_UPLOAD));
    const upload = channel.upload;
    body.appendChild(el('div', 'advanced-title', '参考素材：先上传再引用'));
    body.appendChild(
      hintRow(
        '有的平台要求先把参考图 / 参考视频 / 参考音频传上去、拿到素材地址或编号，才能下单。打开下面的开关并填好上传接口；不开就直接把素材内容随请求发出去。'
      )
    );
    body.appendChild(
      makeCheckbox('先把参考素材上传到平台，再带着素材地址 / 编号下单', upload.enabled === true, (checked) => {
        upload.enabled = checked;
        queueSave(true);
      })
    );
    const upGrid = el('div', 'grid-3');
    upGrid.appendChild(fieldRow('上传路径', makeText(upload.path, (v) => { upload.path = v; queueSave(); }, '/files/upload')));
    upGrid.appendChild(fieldRow('方法', makeSelect(upload.method, METHODS, (v) => { upload.method = v; queueSave(); })));
    upGrid.appendChild(
      fieldRow('上传方式', makeSelect(upload.contentType, UPLOAD_TYPES, (v) => { upload.contentType = v; queueSave(); }))
    );
    body.appendChild(upGrid);
    const upGrid2 = el('div', 'grid-3');
    upGrid2.appendChild(fieldRow('文件字段名', makeText(upload.field, (v) => { upload.field = v; queueSave(); }, 'file')));
    upGrid2.appendChild(
      fieldRow('素材地址取值路径', makeText(upload.resultUrl, (v) => { upload.resultUrl = v; queueSave(); }, 'data.url'))
    );
    upGrid2.appendChild(
      fieldRow('素材编号取值路径', makeText(upload.resultId, (v) => { upload.resultId = v; queueSave(); }, 'data.id'))
    );
    body.appendChild(upGrid2);
    const upGrid3 = el('div', 'grid-2');
    upGrid3.appendChild(jsonField(channel, 'uploadExtra', '上传附加参数（JSON）', upload.extra, (parsed) => { upload.extra = parsed; }, 4));
    upGrid3.appendChild(jsonField(channel, 'uploadHeaders', '上传附加请求头（JSON）', upload.headers, (parsed) => { upload.headers = parsed; }, 4));
    body.appendChild(upGrid3);
    body.appendChild(
      fieldRow('上传超时（秒）', makeNumber(upload.timeoutSec, (v) => { upload.timeoutSec = v; queueSave(); }, 10, 3600))
    );
    body.appendChild(
      hintRow(
        '传完之后下单模板里可以用 {{refIds}} {{refUploadUrls}} {{refImageIds}} {{refVideoIds}} {{refAudioIds}}；没上传或没拿到地址时，{{refs}} 系列仍然装的是素材内容本身。'
      )
    );
    // 兜底开关：主上传地址是纯图片图床（picui.cn 这类）却要传音频 / 视频时，
    // 服务端自动换 kappa.lol 再试一次。默认开着——data/ 不随代码同步，
    // 另一台电脑上的通道配置常常还是旧的，靠这一层才不至于一带音频就失败。
    body.appendChild(
      makeCheckbox(
        '主上传地址不收音频 / 视频时，自动换 kappa.lol 重试一次（不用你另配）',
        upload.fallback !== false,
        (checked) => { upload.fallback = checked; queueSave(true); }
      )
    );

    // ---- 按类型单独上传 ----
    // 现实里图片图床（picui.cn 这类）只收图片，音频 / 视频一律返回「不支持的文件类型」。
    // 所以音频 / 视频可以各自另填一个上传接口，留空就继续用上面那一套。
    ['audio', 'video'].forEach((kind) => {
      if (!upload[kind] || typeof upload[kind] !== 'object') upload[kind] = DEFAULT_UPLOAD_KIND();
      const one = upload[kind];
      const box = el('details', 'ch-subupload');
      if (one.path) box.open = true;
      const sum = el('summary');
      sum.appendChild(el('span', 'ch-subupload-name', KIND_TEXT[kind] + '单独上传'));
      sum.appendChild(
        el('span', 'ch-subupload-state' + (one.path ? ' on' : ''), one.path ? '已单独配置' : '跟随上面的设置')
      );
      box.appendChild(sum);
      const inner = el('div', 'ch-subupload-body');
      inner.appendChild(
        hintRow(
          '上面的图床如果只收图片，把' + KIND_TEXT[kind] + '在这里单独配一个能收' + KIND_TEXT[kind] +
            '的地址；路径留空就还是用上面的。'
        )
      );
      const presetRow = el('div', 'grid-2');
      presetRow.appendChild(
        fieldRow(
          '快速预设',
          makeSelect('', UPLOAD_PRESETS, (v) => {
            const preset = UPLOAD_PRESET_VALUES[v];
            if (preset) Object.keys(preset).forEach((key) => { one[key] = preset[key]; });
            queueSave(true);
            render();
          })
        )
      );
      presetRow.appendChild(
        fieldRow(
          '上传路径',
          makeText(one.path, (v) => { one.path = v; queueSave(); }, 'https://图床域名/api/upload')
        )
      );
      inner.appendChild(presetRow);
      const row2 = el('div', 'grid-3');
      row2.appendChild(fieldRow('文件字段名', makeText(one.field, (v) => { one.field = v; queueSave(); }, 'file')));
      row2.appendChild(
        fieldRow('地址取值路径', makeText(one.resultUrl, (v) => { one.resultUrl = v; queueSave(); }, 'data.links.url'))
      );
      row2.appendChild(
        fieldRow('编号取值路径', makeText(one.resultId, (v) => { one.resultId = v; queueSave(); }, 'data.id'))
      );
      inner.appendChild(row2);
      const row3 = el('div', 'grid-3');
      row3.appendChild(
        fieldRow(
          '上传方式',
          makeSelect(
            one.contentType || '',
            [{ value: '', label: '跟随上面的设置' }].concat(UPLOAD_TYPES),
            (v) => { one.contentType = v; queueSave(); }
          )
        )
      );
      row3.appendChild(
        fieldRow(
          '方法',
          makeSelect(
            one.method || '',
            [{ value: '', label: '跟随上面的设置' }].concat(METHODS),
            (v) => { one.method = v; queueSave(); }
          )
        )
      );
      row3.appendChild(
        fieldRow(
          '超时（秒，0 = 跟随）',
          makeNumber(one.timeoutSec, (v) => { one.timeoutSec = Number(v) || 0; queueSave(); }, 0, 3600)
        )
      );
      inner.appendChild(row3);
      inner.appendChild(
        makeCheckbox(
          '返回的地址没带扩展名时，按真实文件后缀补上（有的平台靠后缀认格式）',
          one.appendExt === true,
          (checked) => { one.appendExt = checked; queueSave(true); }
        )
      );
      // 试传：当场验一次「这个图床收不收这类素材」，不产生生成费用。
      const testRow = el('div', 'ch-subupload-test');
      const testBtn = el('button', null, '试传一个' + KIND_TEXT[kind]);
      const testOut = el('div', 'ch-subupload-result');
      testBtn.title = '用一个 1 秒的样例文件传一次，只验格式收不收，不调用生成模型';
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        testOut.className = 'ch-subupload-result';
        testOut.textContent = '正在试传…';
        try {
          const res = await window.api.testChannelUpload({ channel: channel, kind: kind });
          if (res && res.ok) {
            testOut.className = 'ch-subupload-result ok';
            testOut.textContent = (res.fellBack
              ? '主图床不收' + KIND_TEXT[kind] + '（' + (res.fellBackFrom || '') + '），已自动改用 ' + (res.host || '备用图床') + '，可以传'
              : '可以传' + KIND_TEXT[kind] + '（' + (res.host || '图床') + '）') + (res.url ? '：' + res.url : '');
          } else {
            testOut.className = 'ch-subupload-result bad';
            testOut.textContent = '传不上去：' + ((res && res.reason) || '未知原因');
          }
        } catch (error) {
          testOut.className = 'ch-subupload-result bad';
          testOut.textContent = '试传失败：' + error.message;
        } finally {
          testBtn.disabled = false;
        }
      });
      testRow.appendChild(testBtn);
      testRow.appendChild(testOut);
      inner.appendChild(testRow);
      box.appendChild(inner);
      body.appendChild(box);
    });
    body.appendChild(
      makeCheckbox(
        '参考图本来就是公网 HTTPS 地址时，直接透传（不再下载→压缩→上传）',
        channel.directRefUrls === true,
        (checked) => {
          channel.directRefUrls = checked;
          queueSave(true);
        }
      )
    );
    body.appendChild(
      hintRow(
        '给「只认公网 HTTPS 素材」的平台用（如 xm API 的 SD2.5 系列）。开着时：素材本身是 https 地址就直接发这个地址，省掉一次下载 + 一次图床往返；仍是本地文件 / 被压缩过的，照旧走上面的上传。'
      )
    );

    body.appendChild(el('div', 'advanced-title', '提示词里怎么称呼参考素材'));
    body.appendChild(
      makeCheckbox(
        '把提示词里的「图42」「图45」换成平台认的「图片1」「图片2」（按本次提交顺序重新编号）',
        channel.refPromptIndex === true,
        (checked) => {
          channel.refPromptIndex = checked;
          // 关掉主开关时，@ 前缀也跟着失效，免得留下一个「开了但没用」的孤儿状态
          if (!checked) channel.refPromptAt = false;
          queueSave(true);
          render();
        }
      )
    );
    if (channel.refPromptIndex === true) {
      body.appendChild(
        makeCheckbox(
          '换成「@图片1」这种带 @ 的写法（元梦「源梦创作」要求带 @；Prompt Hubs 不要 @）',
          channel.refPromptAt === true,
          (checked) => {
            channel.refPromptAt = checked;
            queueSave(true);
          }
        )
      );
    }
    body.appendChild(
      hintRow(
        '有的平台只按参考素材的「出现顺序」认图，提示词里写画布上的全局编号（图42）它完全看不懂，参考图等于没接上。开着这个开关，提交时会按本次真正带上去的素材重新编号：图片从 图片1 开始、视频从 视频1 开始、音频各自算。只替换本次确实带上去的名字，没有的一律不动。默认关闭，别的平台（直接看素材地址的）不要开。'
      )
    );

    if (!channel.refLimits) channel.refLimits = JSON.parse(JSON.stringify(DEFAULT_REF_LIMITS));
    const limits = channel.refLimits;
    body.appendChild(el('div', 'advanced-title', '参考素材收件要求（提交前先校验，不合规就不浪费一次调用）'));
    KIND_ORDER.forEach((kind) => {
      if (!limits[kind]) limits[kind] = JSON.parse(JSON.stringify(DEFAULT_REF_LIMITS[kind]));
      const rule = limits[kind];
      if (rule.totalMB === undefined) rule.totalMB = 0;
      if (rule.maxCount === undefined) rule.maxCount = -1;
      const row = el('div', 'grid-3');
      row.appendChild(fieldRow(KIND_TEXT[kind] + '允许格式', makeText(rule.exts, (v) => { rule.exts = v; queueSave(); })));
      row.appendChild(
        fieldRow(KIND_TEXT[kind] + '单张最大 MB', makeNumber(rule.maxMB, (v) => { rule.maxMB = v; queueSave(); }, 1, 4096))
      );
      row.appendChild(
        fieldRow(
          KIND_TEXT[kind] + '最多几个',
          makeNumber(rule.maxCount, (v) => { rule.maxCount = v === '' ? -1 : v; queueSave(); }, -1, 99)
        )
      );
      body.appendChild(row);
      const row2 = el('div', 'grid-3');
      row2.appendChild(
        fieldRow(
          KIND_TEXT[kind] + '合计最大 MB',
          makeNumber(rule.totalMB, (v) => { rule.totalMB = v; queueSave(); }, 0, 4096)
        )
      );
      row2.appendChild(
        fieldRow(KIND_TEXT[kind] + '最长秒数', makeNumber(rule.maxSec, (v) => { rule.maxSec = v; queueSave(); }, 0, 3600))
      );
      body.appendChild(row2);
    });
    body.appendChild(
      hintRow('「最多几个」填 -1 表示不限、填 0 表示这个通道不收这类素材；「合计最大 MB」和「最长秒数」填 0 表示不限。')
    );

    if (!channel.refCompress || typeof channel.refCompress !== 'object') {
      channel.refCompress = { enabled: true, maxEdge: 2048, quality: 2, alphaFormat: 'webp' };
    }
    const compress = channel.refCompress;
    body.appendChild(el('div', 'advanced-title', '参考图压缩清晰度'));
    body.appendChild(
      hintRow('是否压缩由画布左侧的「提交压缩」统一决定：打开时每次提交都压；关闭时只在超出上面的限制才压。下面的设置是压缩时用的清晰度。')
    );
    const cGrid = el('div', 'grid-3');
    cGrid.appendChild(
      fieldRow(
        '最长边',
        makeSelect(compress.maxEdge || 2048, REF_COMPRESS_EDGES, (v) => {
          compress.maxEdge = Number(v);
          queueSave(true);
        })
      )
    );
    cGrid.appendChild(
      fieldRow(
        '压缩质量',
        makeSelect(compress.quality || 2, REF_COMPRESS_QUALITY, (v) => {
          compress.quality = Number(v);
          queueSave(true);
        })
      )
    );
    cGrid.appendChild(
      fieldRow(
        '透明图输出',
        makeSelect(compress.alphaFormat || 'webp', [
          { value: 'webp', label: 'WebP（推荐，体积小）' },
          { value: 'png', label: 'PNG（更通用）' },
        ], (v) => {
          compress.alphaFormat = v;
          queueSave(true);
        })
      )
    );
    body.appendChild(cGrid);
    body.appendChild(
      hintRow(
        '压缩的是这次提交用的临时副本，画布上的原图和素材目录里的文件都不会改。压一次不够时会逐级提高压缩，达标就停；打开左侧「提交压缩」时，没超限也会先按这里的清晰度压一遍。'
      )
    );

    details.appendChild(body);
    return details;
  }

  function buildKindSpec(channel, kind) {
    const spec = channel[kind];
    const box = el('div', 'model-block ch-spec');
    box.appendChild(el('div', 'advanced-title', KIND_TEXT[kind] + '接口'));

    const grid = el('div', 'grid-3');
    grid.appendChild(fieldRow('路径', makeText(spec.path, (v) => { spec.path = v; queueSave(); }, '/images/generations')));
    grid.appendChild(
      fieldRow(
        '方法',
        makeSelect(spec.method, METHODS, (v) => {
          spec.method = v;
          queueSave();
        })
      )
    );
    grid.appendChild(
      fieldRow(
        '请求体编码',
        makeSelect(spec.contentType || 'json', CONTENT_TYPES, (v) => {
          spec.contentType = v;
          queueSave();
        })
      )
    );
    box.appendChild(grid);

    const grid2 = el('div', 'grid-2');
    grid2.appendChild(fieldRow('超时（秒）', makeNumber(spec.timeoutSec, (v) => { spec.timeoutSec = v; queueSave(); }, 10, 3600)));
    grid2.appendChild(
      fieldRow('结果取值路径', makeText(spec.resultUrl, (v) => { spec.resultUrl = v; queueSave(); }, 'data.0.url'))
    );
    box.appendChild(grid2);
    const grid2b = el('div', 'grid-2');
    grid2b.appendChild(
      fieldRow(
        '单次请求体上限（MB，0 = 不检查）',
        makeNumber(spec.maxBodyMB, (v) => { spec.maxBodyMB = v === '' ? 0 : Number(v); queueSave(); }, 0, 1024)
      )
    );
    box.appendChild(grid2b);
    box.appendChild(
      hintRow(
        '给「把整个请求体读进内存」的平台用（例如 520ruo 的 64 MB 网关上限）。参考图内嵌 Base64 时最容易撞到：超出时在本地就拦住并说明差多少，不再白发一次请求。其它通道留 0 即可。'
      )
    );
    box.appendChild(
      fieldRow('base64 取值路径', makeText(spec.resultB64, (v) => { spec.resultB64 = v; queueSave(); }, 'data.0.b64_json'))
    );
    box.appendChild(fieldRow('请求体模板', makeArea(spec.body, (v) => { spec.body = v; queueSave(); }, 6)));
    if (kind === 'video') {
      box.appendChild(
        fieldRow(
          '首尾帧专用请求体（可选，留空则用上面的模板）',
          makeArea(spec.framesBody || '', (v) => { spec.framesBody = v; queueSave(); }, 4)
        )
      );
    }
    box.appendChild(
      hintRow(
        '可用占位：{{prompt}} {{promptRaw}} {{model}} {{n}} {{size}} {{sizeKey}} {{ratio}} {{duration}} {{resolution}} {{resolutionLower}} {{mode}} {{mediaOperation}} {{refs}} {{refCount}} {{refNames}} {{refImages}} {{refVideos}} {{refAudios}} {{refMedia}} {{refMediaInputs}} {{refInlineImages}} {{refInlineAudios}} {{ref0}} {{ref1}}…'
      )
    );
    box.appendChild(
      jsonField(channel, kind + '.extra', '附加固定参数（JSON，自动并进请求体）', spec.extra, (parsed) => { spec.extra = parsed; }, 3)
    );
    box.appendChild(
      jsonField(channel, kind + '.headers', '这类接口单独加的请求头（JSON）', spec.headers, (parsed) => { spec.headers = parsed; }, 3)
    );
    box.appendChild(buildPollEditor(channel, kind, spec));
    return box;
  }

  function buildPollEditor(channel, kind, spec) {
    const poll = spec.poll || (spec.poll = {});
    const wrap = el('div', 'ch-poll');
    const head = el('div', 'model-title');
    head.appendChild(
      makeCheckbox('异步接口：先返回任务号，再轮询拿结果', poll.enabled === true, (checked) => {
        poll.enabled = checked;
        queueSave();
        render();
      })
    );
    wrap.appendChild(head);
    if (poll.enabled !== true) return wrap;

    const g1 = el('div', 'grid-3');
    g1.appendChild(fieldRow('任务号取值路径', makeText(poll.taskIdPath, (v) => { poll.taskIdPath = v; queueSave(); }, 'data.0.task_id')));
    g1.appendChild(fieldRow('查询路径', makeText(poll.path, (v) => { poll.path = v; queueSave(); }, '/videos/{{taskId}}')));
    g1.appendChild(
      fieldRow('查询方法', makeSelect(poll.method || 'GET', METHODS, (v) => {
        poll.method = v;
        queueSave();
      }))
    );
    wrap.appendChild(g1);

    const gl = el('div', 'grid-2');
    gl.appendChild(
      fieldRow(
        '列表字段（只能拉列表时填）',
        makeText(poll.listField, (v) => { poll.listField = v; queueSave(); }, 'tasks')
      )
    );
    gl.appendChild(
      fieldRow('列表里的任务号字段', makeText(poll.listIdField, (v) => { poll.listIdField = v; queueSave(); }, 'id'))
    );
    wrap.appendChild(gl);
    wrap.appendChild(
      hintRow('平台没有「按任务号查一条」的接口时：查询路径填列表地址，上面两个填列表字段和任务号字段，画布会自己从列表里挑出这条任务。')
    );

    const g2 = el('div', 'grid-3');
    g2.appendChild(fieldRow('状态字段', makeText(poll.statusField, (v) => { poll.statusField = v; queueSave(); }, 'data.0.status')));
    g2.appendChild(fieldRow('完成时的值', makeText(poll.doneValues, (v) => { poll.doneValues = v; queueSave(); }, 'success,completed')));
    g2.appendChild(fieldRow('失败时的值', makeText(poll.failValues, (v) => { poll.failValues = v; queueSave(); }, 'failed,error')));
    wrap.appendChild(g2);

    const g3 = el('div', 'grid-3');
    g3.appendChild(fieldRow('轮询结果地址路径', makeText(poll.resultUrl, (v) => { poll.resultUrl = v; queueSave(); }, 'data.0.url')));
    g3.appendChild(fieldRow('轮询 base64 路径', makeText(poll.resultB64, (v) => { poll.resultB64 = v; queueSave(); })));
    g3.appendChild(fieldRow('错误信息字段', makeText(poll.errorField, (v) => { poll.errorField = v; queueSave(); }, 'data.0.error')));
    wrap.appendChild(g3);

    const g5 = el('div', 'grid-2');
    g5.appendChild(fieldRow('取件路径（可选）', makeText(poll.downloadPath, (v) => { poll.downloadPath = v; queueSave(); }, '/media/files/{{fileId}}/download')));
    g5.appendChild(fieldRow('取件文件号路径', makeText(poll.downloadIdPath, (v) => { poll.downloadIdPath = v; queueSave(); }, 'resultFileIds.0')));
    wrap.appendChild(g5);

    const g6 = el('div', 'grid-2');
    g6.appendChild(fieldRow('取件地址字段', makeText(poll.downloadUrlField, (v) => { poll.downloadUrlField = v; queueSave(); }, 'downloadUrl')));
    g6.appendChild(hintRow('任务返回里只有文件号时填这两项：先按取件路径换出下载地址，再下载。'));
    wrap.appendChild(g6);

    const g4 = el('div', 'grid-2');
    g4.appendChild(fieldRow('每隔几秒问一次', makeNumber(poll.intervalSec, (v) => { poll.intervalSec = v; queueSave(); }, 1, 600)));
    g4.appendChild(fieldRow('最长等多少秒', makeNumber(poll.maxWaitSec, (v) => { poll.maxWaitSec = v; queueSave(); }, 30, 86400)));
    wrap.appendChild(g4);
    wrap.appendChild(hintRow('查询路径里的 {{taskId}} 会换成任务号；状态值可以写多个，用逗号分开。'));
    return wrap;
  }

  function queueSave(immediate) {
    dirty = true;
    saveStateEl.textContent = '有改动，正在自动保存…';
    saveStateEl.className = 'hint';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, immediate ? 0 : 900);
  }

  async function saveNow(fromImport) {
    if (!dirty) return;
    dirty = false;
    saveStateEl.textContent = '正在保存…';
    try {
      const saved = await window.api.saveChannels(channels);
      saveStateEl.textContent = '已保存';
      saveStateEl.className = 'hint ok';
      // 服务端顺手做了一遍兼容体检（清单 40）：新导入的通道缺了哪些必填项，
      // 在这里就把清单摆出来，别等用户真点生成才撞上。
      rememberInspect(saved && saved.check);
      paintInspectReport(saved, Boolean(fromImport));
      if (hooks.onSaved) hooks.onSaved();
    } catch (error) {
      dirty = true;
      saveStateEl.textContent = '保存失败：' + error.message;
      saveStateEl.className = 'hint bad';
    }
  }

  // 把服务端回的体检结果按通道 id 记下来，卡片头部的角标要用
  function rememberInspect(check) {
    if (!check || !Array.isArray(check.items)) return;
    check.items.forEach((one) => {
      if (one && one.id) inspectMap.set(one.id, one);
    });
  }

  function issueCountOf(channel) {
    const one = channel && inspectMap.get(channel.id);
    return one ? (one.problems || []).length : 0;
  }

  function noticeCountOf(channel) {
    const one = channel && inspectMap.get(channel.id);
    return one ? (one.notices || []).length : 0;
  }

  // 导入 / 保存后的体检清单（清单 40）。
  // 展开时机只认两种：刚导入完（用户正等着看结果），或者清单本来就开着（用户在盯着它补字段）。
  // 平时自动保存不主动弹——不然每新建一个空通道都弹一次，很吵。
  function paintInspectReport(payload, fromImport) {
    if (!ioReportEl) return;
    const fresh = (payload && payload.freshProblems) || [];
    const check = payload && payload.check;
    const wasOpen = !ioReportEl.classList.contains('hidden');
    if (!check && !fresh.length) {
      ioReportEl.classList.add('hidden');
      ioReportEl.textContent = '';
      return;
    }
    if (!fromImport && !wasOpen) return;

    const items = (check && check.items) || [];
    const problemCount = check ? check.problemCount : fresh.length;
    const noticeCount = check ? check.noticeCount : 0;
    ioReportEl.textContent = '';
    ioReportEl.classList.remove('hidden');

    const head = el('div', 'ch-io-report-head');
    head.appendChild(el('b', null, '通道体检'));
    head.appendChild(
      el(
        'span',
        'ch-io-report-sum',
        problemCount
          ? '有 ' + problemCount + ' 个通道缺必填项，补齐前生成会失败'
          : '所有通道的必填项都齐了' + (noticeCount ? '，另有 ' + noticeCount + ' 个可以再看一眼' : '')
      )
    );
    const grow = el('span', 'grow');
    head.appendChild(grow);
    const close = el('button', 'ch-io-report-close', '收起');
    close.title = '收起这份体检清单（通道配置本身没有动）';
    close.addEventListener('click', () => {
      ioReportEl.classList.add('hidden');
      ioReportEl.textContent = '';
    });
    head.appendChild(close);
    ioReportEl.appendChild(head);

    // 只把有问题的 / 有提示的列出来；全绿的通道不占行，避免一眼看不到重点
    const shown = items.filter((one) => one && (!one.ok || (one.notices && one.notices.length)));
    if (!shown.length) {
      ioReportEl.appendChild(el('div', 'ch-io-report-ok', '这次没有发现缺必填项的通道。'));
    }
    shown.forEach((one) => {
      const row = el('div', 'ch-io-report-row' + (one.ok ? '' : ' bad'));
      row.appendChild(el('span', 'ch-io-report-mark', one.ok ? '✔' : '✖'));
      row.appendChild(el('b', 'ch-io-report-name', one.name || '（未命名通道）'));
      const lines = el('div', 'ch-io-report-lines');
      (one.problems || []).forEach((it) => {
        lines.appendChild(el('div', 'ch-io-report-line bad', '缺「' + it.label + '」：' + it.detail));
      });
      (one.notices || []).forEach((it) => {
        lines.appendChild(el('div', 'ch-io-report-line', '注意「' + it.label + '」：' + it.detail));
      });
      row.appendChild(lines);
      ioReportEl.appendChild(row);
    });
    const foot = el('div', 'ch-io-foot');
    foot.textContent =
      '导入不会被拦住，缺的项先存着，回头补齐就行。补完再点一次上面的「保存」，这份清单会跟着刷新。';
    ioReportEl.appendChild(foot);
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await saveNow();
  }

  async function probeChannelModels(channel) {
    setNotice(channel.id, '正在拉取模型清单…', '');
    let res;
    try {
      res = await window.api.probeChannel(channel);
    } catch (error) {
      setNotice(channel.id, '拉取失败：' + error.message, 'bad');
      return;
    }
    let added = 0;
    const other = (res.split && res.split.other) || [];
    KIND_ORDER.forEach((kind) => {
      const list = (res.split && res.split[kind]) || [];
      if (!list.length) return;
      if (channel.kinds.indexOf(kind) < 0) return;
      const current = (channel.models[kind] || []).map((entry) => String(entry));
      const seen = new Set(current.map((entry) => modelId(entry)));
      list.forEach((id) => {
        if (seen.has(id)) return;
        seen.add(id);
        current.push(id);
        added += 1;
      });
      channel.models[kind] = current;
    });
    let text = '拉到 ' + res.models.length + ' 个模型，新加 ' + added + ' 个。';
    if (other.length) text += ' 还有 ' + other.length + ' 个没归类：' + other.slice(0, 6).join('、') + '（可以在归类规则里补关键词）';
    setNotice(channel.id, text, 'ok');
    queueSave(true);
  }

  function reclassify(channel, kind) {
    const current = (channel.models[kind] || []).map((entry) => String(entry));
    if (!current.length) {
      setNotice(channel.id, KIND_TEXT[kind] + '模型框是空的，先填或先拉。', '');
      return;
    }
    const split = splitModels(current, channel.filters);
    const moved = [];
    KIND_ORDER.forEach((target) => {
      if (target === kind) return;
      if (channel.kinds.indexOf(target) < 0) return;
      const list = split[target] || [];
      if (!list.length) return;
      const existing = (channel.models[target] || []).map((entry) => String(entry));
      const seen = new Set(existing.map((entry) => modelId(entry)));
      list.forEach((id) => {
        if (seen.has(id)) return;
        seen.add(id);
        existing.push(id);
      });
      channel.models[target] = existing;
      moved.push(KIND_TEXT[target] + ' ' + list.length + ' 个');
    });
    const keep = [];
    current.forEach((entry) => {
      const id = modelId(entry);
      const target = KIND_ORDER.find((item) => (split[item] || []).indexOf(id) >= 0);
      if (!target || target === kind) keep.push(entry);
    });
    channel.models[kind] = keep;
    render();
    queueSave(true);
    setNotice(channel.id, moved.length ? '归好了：挪走 ' + moved.join('、') + '。' : '没有需要挪走的模型，都留在原位。', 'ok');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard
        .writeText(text)
        .then(() => true)
        .catch(() => false);
    }
    try {
      if (importText) {
        importText.value = text;
        importText.select();
        document.execCommand('copy');
        return Promise.resolve(true);
      }
    } catch {
      /* 复制不了就退回去手动复制 */
    }
    return Promise.resolve(false);
  }

  function exportPayload(withKeys) {
    const plain = channels.map((channel) => {
      const item = JSON.parse(JSON.stringify(channel));
      if (!withKeys) item.apiKey = '';
      return item;
    });
    return JSON.stringify(
      { kind: 'canvas-channels', version: 1, exportedAt: new Date().toISOString(), channels: plain },
      null,
      2
    );
  }

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  function parseImport(text) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.channels)) return parsed.channels;
    if (parsed && typeof parsed === 'object' && parsed.id && parsed.baseUrl !== undefined) return [parsed];
    throw new Error('这段 JSON 里没有通道配置');
  }

  // 填平缺项：导入的 JSON 可能只写了一半，缺的部分用模板补上，免得渲染出错
  function fillDefaults(base, value) {
    if (Array.isArray(base)) return Array.isArray(value) ? value.slice() : base.slice();
    if (base && typeof base === 'object') {
      const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const out = {};
      Object.keys(base).forEach((key) => {
        out[key] = fillDefaults(base[key], src[key]);
      });
      Object.keys(src).forEach((key) => {
        if (!(key in out)) out[key] = src[key];
      });
      return out;
    }
    return value === undefined || value === null ? base : value;
  }

  const FALLBACK_TEMPLATE = {
    id: '',
    name: '新通道',
    notes: '',
    enabled: true,
    kinds: ['image'],
    baseUrl: '',
    apiKey: '',
    auth: { style: 'bearer', header: 'Authorization', prefix: 'Bearer ', query: 'key' },
    headers: {},
    query: {},
    models: { image: [], video: [], audio: [] },
    defaults: { image: '', video: '', audio: '' },
    filters: { image: '', video: '', audio: '' },
    lists: { path: '/models', method: 'GET', resultPath: 'data', itemId: 'id' },
    balance: DEFAULT_BALANCE,
    ride: DEFAULT_RIDE,
    faceProcessing: { image: [], video: [], audio: [] },
    sizeMap: DEFAULT_SIZE_MAP,
    videoSizeMap: DEFAULT_VIDEO_SIZE_MAP,
    image: { path: '/images/generations', method: 'POST', contentType: 'json', body: '{}', extra: {}, headers: {}, resultUrl: 'data.0.url', resultB64: 'data.0.b64_json', timeoutSec: 300, poll: { enabled: false } },
    video: { path: '/videos', method: 'POST', contentType: 'json', body: '{}', extra: {}, headers: {}, resultUrl: 'data.0.url', resultB64: '', timeoutSec: 600, poll: { enabled: false } },
    audio: { path: '/audio/speech', method: 'POST', contentType: 'json', body: '{}', extra: {}, headers: {}, resultUrl: 'data.0.url', resultB64: '', timeoutSec: 300, poll: { enabled: false } },
  };

  function normalizeImported(item) {
    const shaped = fillDefaults(channelTemplate || FALLBACK_TEMPLATE, item);
    if (!Array.isArray(shaped.kinds) || !shaped.kinds.length) shaped.kinds = ['image'];
    shaped.kinds = shaped.kinds.filter((kind) => KIND_ORDER.indexOf(kind) >= 0);
    if (!shaped.kinds.length) shaped.kinds = ['image'];
    KIND_ORDER.forEach((kind) => {
      if (!Array.isArray(shaped.models[kind])) shaped.models[kind] = [];
    });
    if (!shaped.id) shaped.id = 'ch_' + Math.random().toString(16).slice(2, 10);
    if (!shaped.name) shaped.name = '导入的通道';
    return shaped;
  }

  // 导入前的体检（清单 40）。
  //
  // 关键点：必须在 fillDefaults 之前、拿「原始 JSON」判。填平缺项会把模板里的
  // 默认值补上去（kinds 补成 ['image']、路径补成 /images/generations），
  // 补完再看就永远是齐的——那等于什么都没查。
  //
  // 规则跟服务端 server/channels.js 的 inspectChannel 对齐，只是这里跑在原始数据上。
  function inspectImported(raw, id) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const problems = [];
    const notices = [];
    const kinds = Array.isArray(c.kinds) ? c.kinds.filter((kind) => KIND_ORDER.indexOf(kind) >= 0) : [];
    const models = c.models && typeof c.models === 'object' ? c.models : {};
    const countOf = (kind) => (Array.isArray(models[kind]) ? models[kind].length : 0);

    if (!String(c.baseUrl || '').trim()) {
      problems.push({ field: 'baseUrl', label: 'Base URL', detail: '接口地址没填，这个通道发不出任何请求' });
    }
    const auth = c.auth && typeof c.auth === 'object' ? c.auth : {};
    const authStyle = String(auth.style || 'bearer');
    if (authStyle !== 'none' && !String(c.apiKey || '').trim()) {
      problems.push({ field: 'apiKey', label: '密钥', detail: '这个通道要密钥才能调，现在是空的' });
    }
    if (!kinds.length) {
      problems.push({ field: 'kinds', label: '支持的用途', detail: '一个都没勾，这个通道不会被任何生成用到' });
    }
    if (kinds.length && !kinds.some((kind) => countOf(kind) > 0)) {
      problems.push({ field: 'models', label: '模型清单', detail: '勾选的用途下都没有模型，生成时挑不中模型' });
    }
    // 只有「这个用途的对象在原始 JSON 里、路径却是空的」才算真缺；
    // 整个 image / video 对象没写，会按模板补上默认路径，那属于提示。
    kinds.forEach((kind) => {
      const spec = c[kind];
      if (!spec || typeof spec !== 'object') return;
      if (!String(spec.path || '').trim()) {
        problems.push({
          field: kind + '.path',
          label: KIND_TEXT[kind] + '生成路径',
          detail: '这个通道要用来生成' + KIND_TEXT[kind] + '，但请求路径是空的',
        });
      }
    });

    kinds.forEach((kind) => {
      const spec = c[kind];
      if (!spec || typeof spec !== 'object') {
        notices.push({
          field: kind + '.path',
          label: KIND_TEXT[kind] + '请求参数',
          detail: '原始 JSON 里没写' + KIND_TEXT[kind] + '这一节，已按默认模板补上，生成前最好核对一遍',
        });
      }
      if (kind !== 'image' && spec && spec.poll && spec.poll.enabled === false) {
        notices.push({
          field: kind + '.poll',
          label: KIND_TEXT[kind] + '轮询',
          detail: '轮询是关着的：如果这个平台的' + KIND_TEXT[kind] + '是异步出片，会一直拿不到结果',
        });
      }
      const ids = Array.isArray(models[kind]) ? models[kind] : [];
      if (!ids.length) return;
      const want = String((c.defaults || {})[kind] || '').trim();
      if (!want) {
        notices.push({
          field: 'defaults.' + kind,
          label: KIND_TEXT[kind] + '默认模型',
          detail: '没选默认模型，生成时会用清单里的第一个',
        });
      } else if (ids.map((one) => modelId(one)).indexOf(want) < 0) {
        notices.push({
          field: 'defaults.' + kind,
          label: KIND_TEXT[kind] + '默认模型',
          detail: '设的默认模型（' + want + '）不在模型清单里，已忽略',
        });
      }
    });

    return {
      id: String(id || c.id || ''),
      name: String(c.name || '').trim() || '（未命名通道）',
      problems: problems,
      notices: notices,
      ok: problems.length === 0,
    };
  }

  // 把一批原始通道体检成服务端 check 的同一种形状，前端直接照着渲染
  function inspectBatch(list) {
    const items = (Array.isArray(list) ? list : []).map((one) => inspectImported(one, one && one.id));
    return {
      items: items,
      total: items.length,
      okCount: items.filter((one) => one.ok).length,
      problemCount: items.filter((one) => !one.ok).length,
      noticeCount: items.filter((one) => one.notices.length > 0).length,
    };
  }

  async function doImport(mode) {
    let raw;
    let incoming;
    try {
      raw = parseImport(importText.value.trim());
      incoming = raw.map((item) => normalizeImported(item));
    } catch (error) {
      window.alert('导入失败：' + error.message);
      return;
    }
    if (!incoming.length) {
      window.alert('这段 JSON 里没有通道。');
      return;
    }
    // 先按原始 JSON 体检一遍（填平默认值之前），导入完直接给用户看结果
    const check = inspectBatch(raw);
    if (mode === 'replace') {
      if (!window.confirm('确定用这 ' + incoming.length + ' 个通道替换掉现有的 ' + channels.length + ' 个吗？')) return;
      channels = incoming;
    } else {
      incoming.forEach((item) => {
        const copy = JSON.parse(JSON.stringify(item));
        if (!copy.id || channels.some((channel) => channel.id === copy.id)) {
          copy.id = 'ch_' + Math.random().toString(16).slice(2, 10);
        }
        if (!copy.name) copy.name = (channelTemplate && channelTemplate.name) || '导入的通道';
        channels.push(copy);
      });
    }
    // 补上 id：原始 JSON 里没写 id 的，上面已经生成过了，体检结果要跟着对齐
    check.items.forEach((one, index) => {
      const shaped = incoming[index];
      if (shaped && shaped.id) one.id = shaped.id;
    });
    importText.value = '';
    render();
    dirty = true;
    // 先落库（这一步服务端也会体检一遍，见 server/index.js），
    // 之后再用「按原始 JSON 算的」这份覆盖渲染：它抓的是导入文件本身缺什么，
    // 而服务端看到的是已经填平默认值之后的数据，报告会轻一些。
    await flushSave();
    check.items.forEach((one) => {
      if (one.id) inspectMap.set(one.id, one);
    });
    // 体检清单在导入面板外面，收起面板不影响它
    if (ioPanel) ioPanel.classList.add('hidden');
    paintInspectReport({ check: check, freshProblems: check.items.filter((one) => !one.ok) }, true);
    render();
    saveStateEl.textContent =
      '已导入 ' + incoming.length + ' 个通道并保存' +
      (check.problemCount ? '，其中 ' + check.problemCount + ' 个还缺必填项' : '');
    saveStateEl.className = 'hint ' + (check.problemCount ? 'bad' : 'ok');
  }

  function bindToolbar() {
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        search = searchEl.value.trim();
        render();
      });
    }
    const expandAll = document.getElementById('ch-expand-all');
    const collapseAll = document.getElementById('ch-collapse-all');
    if (expandAll) {
      expandAll.addEventListener('click', () => {
        channels.forEach((channel) => {
          openIds.add(channel.id);
          closedIds.delete(channel.id);
        });
        render();
      });
    }
    if (collapseAll) {
      collapseAll.addEventListener('click', () => {
        channels.forEach((channel) => {
          closedIds.add(channel.id);
          openIds.delete(channel.id);
        });
        render();
      });
    }
    ADD_PRESETS.forEach((preset, index) => {
      const button = document.getElementById('btn-add-channel-' + index);
      if (!button) return;
      button.addEventListener('click', async () => {
        await flushSave();
        const base = channelTemplate ? JSON.parse(JSON.stringify(channelTemplate)) : {};
        base.id = 'ch_' + Math.random().toString(16).slice(2, 10);
        base.name = preset.name + ' ' + (channels.length + 1);
        base.kinds = preset.kinds.slice();
        base.enabled = true;
        channels.push(base);
        openIds.add(base.id);
        closedIds.delete(base.id);
        render();
        queueSave(true);
        const last = listEl.lastElementChild;
        if (last && last.scrollIntoView) last.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    const saveBtn = document.getElementById('btn-save-channels');
    if (saveBtn) saveBtn.addEventListener('click', () => queueSave(true));
    const ioBtn = document.getElementById('btn-ch-io');
    if (ioBtn) {
      ioBtn.addEventListener('click', () => {
        if (ioPanel) ioPanel.classList.toggle('hidden');
      });
    }
    const exportFile = document.getElementById('btn-ch-export');
    if (exportFile) {
      exportFile.addEventListener('click', () => {
        const withKeys = includeKeysEl && includeKeysEl.checked;
        downloadText(exportPayload(withKeys), '通道配置-' + new Date().toISOString().slice(0, 10) + '.json');
        saveStateEl.textContent = withKeys ? '已导出（含密钥，注意保管）' : '已导出（不含密钥）';
        saveStateEl.className = 'hint ' + (withKeys ? 'warn' : 'ok');
      });
    }
    const exportCopy = document.getElementById('btn-ch-copy');
    if (exportCopy) {
      exportCopy.addEventListener('click', () => {
        const withKeys = includeKeysEl && includeKeysEl.checked;
        copyText(exportPayload(withKeys)).then((ok) => {
          saveStateEl.textContent = ok
            ? withKeys
              ? '已复制到剪贴板（含密钥）'
              : '已复制到剪贴板（不含密钥）'
            : '复制失败，请改用「导出到文件」';
          saveStateEl.className = 'hint ' + (ok ? (withKeys ? 'warn' : 'ok') : 'bad');
        });
      });
    }
    const mergeBtn = document.getElementById('btn-ch-import-merge');
    if (mergeBtn) mergeBtn.addEventListener('click', () => doImport('merge'));
    const replaceBtn = document.getElementById('btn-ch-import-replace');
    if (replaceBtn) replaceBtn.addEventListener('click', () => doImport('replace'));
  }

  // 密钥这次是怎么解开的：本机 DPAPI 解不出来、改用可移植副本时，
  // 说明这份数据是从另一台电脑同步 / 拷贝过来的 —— 但密钥依然有效。
  // 只在这两种情况之外保持沉默，别让一行字常驻在那里。
  function showKeySource() {
    Promise.resolve(window.api.status())
      .then((data) => {
        const seal = data && data.keyProtection;
        if (!seal) return;
        if (seal.error) {
          saveStateEl.textContent = '密钥解不开：' + seal.error;
          saveStateEl.className = 'hint bad';
          return;
        }
        if (seal.source === 'portable') {
          saveStateEl.textContent = '这些密钥是从另一台电脑带过来的，已自动接上，不用重填';
          saveStateEl.className = 'hint ok';
        }
      })
      .catch(() => {
        /* 状态接口读不到不影响改通道 */
      });
  }
  async function mount(options) {
    hooks = options || {};
    bindToolbar();
    try {
      const data = await window.api.listChannels();
      channels = Array.isArray(data.channels) ? data.channels : [];
      channelTemplate = data.template || null;
      render();
      if (hooks.onLoaded) hooks.onLoaded();
      autoQueryBalances();
      autoQueryRides();
      // 悄悄报一句「这次密钥是怎么解开的」：另一台电脑同步过来以后，
      // 用户会担心「是不是又要重填」，这里先给个明确答复。
      showKeySource();
    } catch (error) {
      listEl.textContent = '';
      listEl.appendChild(el('div', 'empty-inline', '读取通道配置失败：' + error.message));
    }
  }

  window.ChannelAdmin = { mount: mount };
})();
