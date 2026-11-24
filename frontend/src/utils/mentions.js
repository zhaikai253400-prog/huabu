function rawPattern() {
  return /@\[([^\]\n]+)\]/g;
}

export function tagsOf(text) {
  const out = [];
  const source = String(text ?? '');
  if (!source.includes('@[')) return out;
  const re = rawPattern();
  let match;
  while ((match = re.exec(source)) !== null) {
    if (!out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

export function toShown(text) {
  return String(text ?? '').replace(rawPattern(), (_, tag) => `@${tag}`);
}

export function toRaw(text, known) {
  const source = String(text ?? '');
  if (!source.includes('@')) return source;
  const live = known instanceof Set ? known : new Set(Array.isArray(known) ? known : []);
  return source.replace(/@(快速视频|视频|音频|图)(\d+)/g, (all, kind, num) => {
    const tag = kind + num;
    return live.has(tag) ? `@[${tag}]` : all;
  });
}

export function insertRawTag(text, tag) {
  const token = `@[${tag}]`;
  const src = String(text ?? '');
  if (src.includes(token)) return src;
  const needsSpace = src && !/\s$/.test(src);
  return src + (needsSpace ? ' ' : '') + token;
}

export function kindLabel(type) {
  return { image: '图', video: '视频', audio: '音频', quick: '快速视频' }[type] || type;
}
