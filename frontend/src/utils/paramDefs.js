export const PARAM_DEFS = {
  image: [
    { key: 'size', label: '尺寸', options: ['1K', '2K', '4K'] },
    { key: 'ratio', label: '比例', options: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
    { key: 'count', label: '张数', options: ['1', '2', '3', '4'], texts: ['1 张', '2 张', '3 张', '4 张'] },
  ],
  video: [
    { key: 'duration', label: '时长', options: ['5', '10', '15', '30'], texts: ['5 秒', '10 秒', '15 秒', '30 秒'] },
    { key: 'resolution', label: '分辨率', options: ['720p', '1080p'], texts: ['720P', '1080P'] },
    { key: 'ratio', label: '比例', options: ['16:9', '9:16', '1:1'] },
    { key: 'mode', label: '模式', options: ['reference', 'frames', 'text'], texts: ['全能参考', '首尾帧', '纯文生'] },
  ],
  quick: [
    { key: 'duration', label: '时长', options: ['5', '10', '15', '30'], texts: ['5 秒', '10 秒', '15 秒', '30 秒'] },
    { key: 'resolution', label: '分辨率', options: ['720p', '1080p'], texts: ['720P', '1080P'] },
    { key: 'ratio', label: '比例', options: ['16:9', '9:16', '1:1'] },
  ],
};

export const PARAM_DEFAULTS = {
  image: { size: '2K', ratio: '16:9', count: '1' },
  video: { duration: '30', resolution: '720p', ratio: '16:9', mode: 'reference' },
  quick: { duration: '30', resolution: '720p', ratio: '16:9' },
};

export function modelSpecOf(models, type, data = {}) {
  const key = type === 'quick' ? 'video' : type;
  const list = models?.[key] || models?.[`${key}s`] || [];
  const id = data.model;
  if (!id) return list.find((m) => m.isDefault) || list[0] || null;
  return (
    list.find((m) => (m.id || m) === id && (!data.channelId || m.channelId === data.channelId)) ||
    list.find((m) => (m.id || m) === id) ||
    null
  );
}

export function paramDefsOf(models, node) {
  const type = node.type;
  const defs = PARAM_DEFS[type] || [];
  const spec = (modelSpecOf(models, type, node.data || {}) || {}).spec || {};
  return defs.map((def) => {
    let options = def.options;
    let texts = def.texts;
    if (def.key === 'size' && Array.isArray(spec.sizes) && spec.sizes.length) {
      options = spec.sizes.slice();
      texts = null;
    } else if (def.key === 'resolution' && Array.isArray(spec.resolutions) && spec.resolutions.length) {
      options = spec.resolutions.slice();
      texts = options.map((v) => String(v).toUpperCase());
    } else if (def.key === 'duration' && Array.isArray(spec.durations) && spec.durations.length) {
      options = spec.durations.map(String);
      texts = options.map((v) => `${v} 秒`);
    } else if (def.key === 'ratio' && Array.isArray(spec.ratios) && spec.ratios.length) {
      options = spec.ratios.slice();
      texts = null;
    } else if (def.key === 'mode' && Array.isArray(spec.modes) && spec.modes.length) {
      const names = { reference: '全能参考', frames: '首尾帧', text: '纯文生' };
      options = spec.modes.slice();
      texts = options.map((v) => names[v] || v);
    }
    if (options === def.options) return def;
    return { ...def, options, texts };
  });
}

export function seedParams(models, type, modelId) {
  const base = { ...(PARAM_DEFAULTS[type] || {}) };
  const entry = modelSpecOf(models, type, { model: modelId });
  const spec = entry?.spec || {};
  if (spec.defaultDuration != null) base.duration = String(spec.defaultDuration);
  if (spec.defaultResolution != null && base.resolution !== undefined) {
    base.resolution = String(spec.defaultResolution).toLowerCase();
  }
  if (Array.isArray(spec.sizes) && spec.sizes.length && base.size) {
    if (!spec.sizes.includes(base.size)) base.size = spec.sizes[0];
  }
  return base;
}

export function optionLabel(def, value) {
  const idx = (def.options || []).indexOf(value);
  if (idx >= 0 && def.texts?.[idx]) return def.texts[idx];
  return String(value);
}
