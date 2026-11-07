// pnpm dev 的入口：dev 下界面在 Vite（5173）上，登录链接和「可信来源」都要指向它。
// 原来写成 `OPENSUPERBOT_WEB_URL=${OPENSUPERBOT_WEB_URL:-…} tsx watch …`，那是 Unix shell 的写法，
// Windows 上 pnpm 用 cmd.exe 跑脚本会直接报错；放在这里，三个平台都一样。
process.env.OPENSUPERBOT_WEB_URL ||= 'http://localhost:5173'
await import('../src/main.js')
