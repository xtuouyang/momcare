# MomCare 自建 DeepSeek AI 接口

本目录将现有的 Cloudflare Worker 业务逻辑直接交给 Node.js 22 运行。
它复用仓库根目录下的 cloudflare-worker/worker.js，所以支持全部已实现的
AI 功能，无需重新编写商品推荐、妈妈心理测评和家庭沟通等逻辑。

## 1. 在 Ubuntu 服务器部署

连接你拥有的服务器。根据镜像和账号情况，SSH 用户名可能是 ubuntu 或 root。

```sh
ssh ubuntu@119.29.221.11
```

进入服务器后：

```sh
git clone https://github.com/xtuouyang/momcare.git ~/momcare-ai-deploy
cd ~/momcare-ai-deploy/server-ai
cp .env.example .env
nano .env
```

将 .env 中的 DEEPSEEK_API_KEY 替换成你自己的真实密钥，并保持
ALLOWED_ORIGIN=https://xtuouyang.github.io。
不要把密钥发到聊天、写进 index.html 或提交到公开 GitHub 仓库。

```sh
chmod 600 .env
docker compose up -d --build
docker compose ps
docker compose logs --tail=60
```

如果服务器之前已下载过项目，不要重复 git clone，改为：

```sh
cd ~/momcare-ai-deploy
git pull
cd server-ai
docker compose up -d --build
```

## 2. 验证服务已启动

```sh
curl -i http://127.0.0.1:8787/health
```

应得到 HTTP 200 与 JSON，其中包含 ok:true。
该步骤验证的是服务器内部服务，并不证明中国大陆访客已经能够通过
HTTPS 连接。

从你自己的电脑，可以用 SSH 转发方式私下测试：

```sh
ssh -L 8787:127.0.0.1:8787 ubuntu@119.29.221.11
```

随后在电脑打开 http://127.0.0.1:8787/health 。

## 3. 公开上线前的限制

Docker Compose 默认只开放主机的 127.0.0.1:8787，
不会直接暴露未经认证的 AI 接口，也不占用原有 Caddy 的 80/443 端口。

MomCare GitHub Pages 是 HTTPS 页面，因此正式使用的 AI 接口也必须
提供浏览器信任的 HTTPS 地址。直接填 http://服务器IP:8787 会遭到
浏览器混合内容拦截。通常需要合法域名及 HTTPS 证书。

如果你使用的是中国大陆节点服务器，向互联网公众提供服务之前，
需要核实 ICP 备案及相关合规要求。一个月试用实例不应直接认定可以备案。
没有域名和合规的 HTTPS 入口时，应保持为仅服务器内部测试，
不能把网页直接切换到这个 HTTP 地址。

另外，即使 AI 接口迁到国内，GitHub Pages 网页本身在中国大陆的
可访问性也需要单独测试。

## 4. 安全与费用

server.mjs 有简单的每分钟、每日请求计数，默认每分钟 10 次、
每天 100 次；计数在容器进程重启时清空。它是临时的软限制，不是
严格的账单限额，也不能防止所有恶意使用。生产部署需配置持久化
限流、异常流量监控和 DeepSeek 账号的费用控制。

允许的网页来源仍是 https://xtuouyang.github.io 。
浏览器 Origin 检查只是前端访问限制，不是用户认证。
不要把未经认证的 AI 接口直接面向公众开放。

## 5. 停止测试容器

```sh
cd ~/momcare-ai-deploy/server-ai
docker compose down
```

## 6. 一个月竞赛专用的免域名演示链接

如果只需要让评委通过现有公网 IP 临时演示，可以将最新版 MomCare
直接从同一个 IP 的 /demo 路径加载，并将 /api/chat 路由到 AI 容器。
这样网页和接口同源，不需要从 HTTPS 的 GitHub Pages 请求 HTTP。

准备工作：

```sh
cd ~/momcare-ai-deploy
git pull
cd server-ai
sudo docker compose up -d --build
```

compose.yaml 中已配置演示来源 DEMO_ORIGIN 默认值
http://119.29.221.11。如果更换公网 IP，请在服务器的
server-ai/.env 加入 DEMO_ORIGIN=http://新的IP 并重建容器。

先检查内部的演示页面是否可用：

```sh
curl -I -H 'Host: 119.29.221.11' http://127.0.0.1:8787/demo
```

然后确认原 Caddy 的挂载位置，再对现有 Caddyfile 备份和修改。
仓库提供 server-ai/Caddyfile.demo 作为示例，它将 /demo、
/api/chat 和 /health 路由到 AI 容器，其余路径保持旧网站不变。
不要直接覆盖现有 Caddy 配置文件而不先备份，也不要再把 8787
直接暴露到公网。

Caddy 更新后，评委的临时演示地址为：

http://119.29.221.11/demo

这是未加密的 HTTP 演示模式，只适合一段时间内使用虚构测试数据。
页面中的心理测评、情绪关怀等输入会经过明文网络，不能填写真实
医疗、家庭或个人隐私。浏览器会显示“不安全”，这是预期现象。
同源并不等于安全认证，公开的 API 仍会产生 DeepSeek 费用。
现有分钟和每日限流仅在进程内有效，重启会重置；请在比赛结束后
停止此演示服务，必要时轮换密钥，并持续关注 DeepSeek 消费额度。
中国大陆服务器对外展示还应核实适用的互联网服务合规要求。
