# MomCare 4.4.8 比赛演示版

本仓库已包含 MomCare 的单文件静态互动网页（index.html）和 GitHub Pages 配置。

预期网址：https://xtuouyang.github.io/momcare/

如果尚未开放，请在仓库 Settings → Pages 中选择 GitHub Actions，或者 Deploy from a branch → main → /(root)。

## DeepSeek 真正调用尚待接通

HTML 的 MOMCARE_WORKER_URL 仍是占位符，不包含任何 DeepSeek 密钥。需要先将独立部署包的 cloudflare-worker/worker.js 部署到 Cloudflare Workers，设置服务端密钥 DEEPSEEK_API_KEY、ACCESS_CODE 和公开来源 ALLOWED_ORIGIN=https://xtuouyang.github.io，随后把 Worker HTTPS 地址写入 index.html 顶部。

请不要把 .env、DeepSeek 密钥或真实个人健康数据提交到公开仓库。此比赛版的表单记录存储在当前浏览器中，不提供真实跨设备的社区、账号、文件同步。DeepSeek 按调用计费。
