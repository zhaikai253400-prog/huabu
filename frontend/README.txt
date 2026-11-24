本地无限画布 · Vue3 前端
========================

技术栈：Vue 3 + Vue Router + Pinia + View UI Plus + Vite
构建产物输出到：../web/dist/（由本机 Node 服务直接托管）

开发：
  npm install --registry https://registry.npmmirror.com
  npm run dev
  （需本机服务已在 17890 端口运行，Vite 会代理 /api /media /thumb）

发布：
  npm run build
  然后重启「无限画布.exe」/ 托盘「重启服务」
  浏览器打开 http://127.0.0.1:17890/ 即为新壳

旧页面兜底：
  /legacy          旧门户
  /legacy/canvas   旧画布
  /channels        托盘通道设置窗（仍可用）
