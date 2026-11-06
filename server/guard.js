'use strict';

// 本机访问守卫：把「谁能调这个服务」这件事收在一处。
//
// 背景：服务只听 127.0.0.1，但这不等于安全。浏览器里任何一个网页都能向
// 127.0.0.1 发请求（跨站请求不带 CORS 预检的「简单请求」直接放行），
// 于是别人的网页可以：
//   · 悄悄替你发起付费生成（POST /api/generate）
//   · 改掉画布数据、配置、素材目录
//   · 让 /api/export/assets 往任意目录写文件
// 这类攻击叫 CSRF / DNS rebinding，光靠监听回环地址挡不住。
//
// 这里用三道闸，缺一不可：
//   1) Host 必须是本机名字（挡 DNS rebinding：攻击者把域名解析到 127.0.0.1，
//      浏览器仍然会带 Host: evil.example，一看就不是本机）
//   2) 带 Origin 的请求必须是同源（挡跨站 fetch / 表单提交）
//   3) /api/* 必须带 UI 钥匙（挡其它本机程序、也挡住漏网的跨站请求）
//
// 两把钥匙的分工（沿用原来的安全承诺：画布页拿不到平台密钥）：
//   · uiToken     —— 每个页面打开时由服务端注入，所有 /api/* 都能用，
//                    但拿不到 /api/channels*（那些只认 adminToken）
//   · adminToken  —— 只在「接口通道设置」窗口注入，且仅认 channels 前缀
// 这样即使画布页被 XSS 打穿，密钥仍然读不走。

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// 端口会被带上（127.0.0.1:17890），比对前先剥掉
function hostNameOf(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  // [::1]:17890 这种要先保住方括号里的冒号
  if (raw.charAt(0) === '[') {
    const close = raw.indexOf(']');
    return close > 0 ? raw.slice(0, close + 1) : raw;
  }
  // 裸 IPv6（::1）：冒号不止一个，说明整串就是地址，不能按「地址:端口」切
  if (raw.indexOf(':') !== raw.lastIndexOf(':')) return raw;
  const colon = raw.lastIndexOf(':');
  return colon > 0 ? raw.slice(0, colon) : raw;
}

// 取 Origin 里的 host（Origin 里不带路径，但可能带端口）
function originHostOf(origin) {
  try {
    const parsed = new URL(String(origin));
    return hostNameOf(parsed.host);
  } catch {
    return '';
  }
}

function isLocalHost(value) {
  return LOCAL_HOSTS.has(hostNameOf(value));
}

// 局域网访问：只认「这台电脑自己的地址」（网卡 IP、计算机名），不整段放行 192.168.x.x。
// 这样 DHCP 换了 IP 会自动跟上，而别人的 192.168.x.x 伪造 Host 依旧进不来。
// 地址表缓存 10 秒：素材是按张请求的，每个请求都去枚举网卡会明显拖慢画布。
let lanCache = { at: 0, hosts: new Set() };
function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const key of Object.keys(nets)) {
    for (const one of nets[key] || []) {
      if (!one || one.internal) continue;
      if (one.family !== 'IPv4' && one.family !== 4) continue;
      const ip = String(one.address || '');
      if (!ip) continue;
      // 169.254.x.x 是「没拿到地址」时的自动地址，另一台电脑连不上，不列出来
      if (ip.indexOf('169.254.') === 0) continue;
      if (out.indexOf(ip) < 0) out.push(ip);
    }
  }
  return out;
}
function lanHosts() {
  if (Date.now() - lanCache.at < 10000) return lanCache.hosts;
  const hosts = new Set();
  const name = String(os.hostname() || '').toLowerCase();
  if (name) {
    hosts.add(name);
    hosts.add(name + '.local');
  }
  lanAddresses().forEach((ip) => hosts.add(ip.toLowerCase()));
  lanCache = { at: Date.now(), hosts: hosts };
  return hosts;
}
function isLanHost(value) {
  return lanHosts().has(hostNameOf(value));
}

// 常量时间比较：钥匙长度固定，这里主要避免「逐字节早退」泄露前缀
function sameToken(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 判一个请求该不该放行。返回 { ok } 或 { ok:false, code, error }
//
// keys：{ adminToken, uiToken, queryToken }
//   queryToken 仅在「浏览器直接导航」这类无法带请求头的 GET 上用（日志下载）
//
// needToken：'none' | 'ui' | 'admin'
//   none   —— 静态页面 / 素材 / 缩略图：只查 Host 与 Origin
//   ui     —— 普通接口：ui 或 admin 钥匙都行（托盘只拿得到 admin）
//   admin  —— 平台密钥相关：只认 admin 钥匙
function check(req, needToken, keys) {
  const opt = keys || {};
  // 局域网开关关着时，行为与以前完全一致：只认回环地址。
  const lanEnabled = opt.lanEnabled === true;
  const host = hostNameOf(req.headers.host);
  if (!host) {
    return { ok: false, code: 403, error: '请求缺少 Host，拒绝' };
  }
  const fromLoopback = isLocalHost(host);
  const fromLan = !fromLoopback && lanEnabled && isLanHost(host);
  if (!fromLoopback && !fromLan) {
    return {
      ok: false,
      code: 403,
      error: lanEnabled
        ? '只接受本机或这台电脑自己的局域网地址访问（当前 Host：' + host + '）'
        : '只接受本机访问：Host 不是 127.0.0.1 / localhost'
    };
  }

  // Origin 只在跨站请求时出现（同源 fetch、直接导航都不带）。
  // 带了就必须是同源，否则一律拒——这是 CSRF 的主防线。
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const oh = originHostOf(origin);
    const originOk = oh && (isLocalHost(oh) || (lanEnabled && isLanHost(oh)));
    if (!originOk) {
      return { ok: false, code: 403, error: '跨站请求被拒绝：Origin 不是本机' };
    }
    // 端口也要对上，避免「本机另一个服务」借道
    let originPort = '';
    try {
      originPort = new URL(String(origin)).port || '';
    } catch {
      originPort = '';
    }
    const hostPort = String(req.headers.host || '').split(':').pop() || '';
    if (originPort && hostPort && originPort !== hostPort) {
      return { ok: false, code: 403, error: '跨站请求被拒绝：Origin 端口与本机服务不一致' };
    }
  }

  if (needToken === 'none') return { ok: true, local: fromLoopback };

  // 钥匙两种来源：请求头（正常接口）或查询串（浏览器直接导航下载文件时带不了头）
  const given = String(req.headers['x-local-token'] || '') || String(opt.queryToken || '');
  const adminOk = sameToken(given, opt.adminToken);
  if (needToken === 'admin') {
    if (adminOk) return { ok: true, local: fromLoopback };
    return { ok: false, code: 401, local: fromLoopback, error: '通道设置只在本机的「接口通道设置」窗口里做，请从启动器重新打开那个窗口' };
  }
  // ui：UI 钥匙或 admin 钥匙都可以（托盘、维护脚本手里是 admin 钥匙）
  if (sameToken(given, opt.uiToken) || adminOk) return { ok: true, local: fromLoopback };
  return { ok: false, code: 401, local: fromLoopback, error: '这个请求没有本机钥匙，已拒绝。请从启动器重新打开画布页面' };
}

// 判断 target 是否真的在 dir 里（含 dir 本身）。
//
// 为什么不能用 target.startsWith(dir)：那只是字符串前缀。
// D:\项目\web 与 D:\项目\web备份 前缀相同，startsWith 会认为后者也在 web 里，
// 于是 /assets/../../web备份/任意文件 就能被读走。这里按路径段比较：
// 先取相对路径，再确认它不以 .. 开头、也不是绝对路径。
function isInsideDir(dir, target) {
  if (!dir || !target) return false;
  const rootAbs = path.resolve(dir);
  const targetAbs = path.resolve(target);
  const rel = path.relative(rootAbs, targetAbs);
  if (!rel) return true;
  if (path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== '..';
}

module.exports = {
  check,
  isInsideDir,
  isLocalHost,
  isLanHost,
  lanAddresses,
  hostNameOf,
  originHostOf,
  sameToken,
  LOCAL_HOSTS,
};
