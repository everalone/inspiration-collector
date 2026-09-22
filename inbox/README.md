# 公网收件箱部署（VPS）

手机把公众号文章链接 POST 到本服务，家里电脑轮询拉取后自动拆卡。

## 环境要求

- Node.js ≥ 20
- 域名解析到本 VPS（A 记录）
- 反代并自动 HTTPS（推荐 Caddy）

## 启动

```bash
export INBOX_TOKEN="换成足够长的随机串"
export INBOX_DATA=/var/lib/inspiration-inbox
export PORT=8787
node server.mjs
```

systemd 示例 `inspiration-inbox.service`：

```ini
[Unit]
Description=Inspiration inbox
After=network.target

[Service]
WorkingDirectory=/opt/inspiration-collector/inbox
Environment=INBOX_TOKEN=换-成-你的-token
Environment=INBOX_DATA=/var/lib/inspiration-inbox
Environment=PORT=8787
ExecStart=/usr/bin/node server.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

## HTTPS

```bash
# 域名改为你的，替换 Caddyfile 后：
caddy run --config Caddyfile
```

Nginx 则 `proxy_pass http://127.0.0.1:8787;` 并用 certbot 签证书。

## 接口摘要

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/health` | 无 | 探活 |
| POST | `/collect` | Bearer | `{url}` 入队，24h 去重 |
| GET | `/pull?limit=5` | Bearer | 桌面拉取 pending |
| POST | `/ack` | Bearer | `{id, ok, error?}` 出队 |

桌面应用 ⚙ 设置里填 `https://你的域名` 与同一个 `INBOX_TOKEN`，打开「手机收集」。
