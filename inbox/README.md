# 公网收件箱部署（VPS）

手机把公众号文章链接 POST 到本服务，家里电脑轮询拉取后自动拆卡。服务器只保存链接、备注和任务状态；文章抓取、模型调用、图片与卡片入库在你的电脑完成。电脑关机、睡眠或应用退出时，链接继续排队，待电脑恢复后处理。

这是**个人单用户收件箱**：一个 Token 对应一个共享队列，只安排一台桌面程序消费。不要向其他用户公开 Token，也不要把 Token 或自己的模型 Key 写入公开安装包。本协议没有多用户隔离或多桌面任务租约，不提供跨设备卡片同步。

## 环境要求

- Node.js ≥ 20
- 域名解析到本 VPS（A 记录）
- 反代并自动 HTTPS（推荐 Caddy）
- 安全组只需对公网开放网站使用的 80/443；8787 默认仅监听 `127.0.0.1`，交给反向代理访问。

## 启动

```bash
export INBOX_TOKEN="换成足够长的随机串"
export INBOX_DATA=/var/lib/inspiration-inbox
export PORT=8787
node server.mjs
```

正式部署建议把环境变量放进权限为 `600` 的 `/etc/inspiration-inbox.env`，不要放进 Git。示例内容（替换占位 Token）：

```ini
INBOX_TOKEN=替换成足够长的随机串
INBOX_DATA=/var/lib/inspiration-inbox
PORT=8787
HOST=127.0.0.1
```

systemd 示例 `inspiration-inbox.service`（使用预先创建的 `inspiration` 服务用户，并确保它可写 `INBOX_DATA`）：

```ini
[Unit]
Description=Inspiration inbox
After=network.target

[Service]
User=inspiration
WorkingDirectory=/opt/inspiration-collector/inbox
EnvironmentFile=/etc/inspiration-inbox.env
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## HTTPS

```bash
# 域名改为你的，替换 Caddyfile 后：
caddy run --config Caddyfile
```

Nginx 则 `proxy_pass http://127.0.0.1:8787;` 并用 certbot 签证书。作品集、个人网站与收件箱可使用不同域名/子域名，共享同一台服务器的 443 端口。

## 接口摘要

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/health` | 无 | 探活；新版返回 `{ok:true,protocol:2}` |
| POST | `/collect` | Bearer | `{url,note?}` 入队；pending 去重，近期记录 24h 去重；重新分享 failed 会重试 |
| GET | `/pull?limit=5` | Bearer | 只返回已到重试时间的 pending，最多 20 条 |
| POST | `/ack` | Bearer | `{id,ok,error?,receiptId?}`；成功完成，失败进入有限重试；新版客户端提供 receiptId 防止重复记失败次数 |
| GET | `/failed` | Bearer | `{items:[{id,url,received_at,attempts,error,last_attempt_at}]}`，供桌面显示失败原因 |
| POST | `/retry` | Bearer | `{id}` 将 failed 重新入队并重置尝试次数；pending 不重复重置，done 返回 409 |

桌面应用 ⚙ 设置里填 `https://你的域名` 与同一个 `INBOX_TOKEN`，打开「手机收集」。

## 重试、回执与备份

- 分析最多尝试 **3 次**。第 1、2 次失败后分别等待 **60 秒、120 秒** 再允许拉取；第 3 次失败进入失败列表。实际执行时间还取决于桌面轮询、应用是否运行和本地任务队列。
- 桌面使用统一收集队列。普通收藏已入库文章会跳过，不会因为重复分享或重试覆盖手改卡片；明确「重跑」仍属于用户主动操作。
- 分析结果先记入本地 `data/inbox-receipts.json`，再向服务器确认。回执网络失败按 5 秒起、最高 5 分钟退避持续补发；重启仍可补发，**不会因回执断线再次调用模型**。回执文件不保存 Token；应与本地数据库、任务文件一起备份。回执损坏会暂停拉取并显示错误，保留原文件以便恢复。
- 所有收件箱请求有 **15 秒**超时，包含响应正文读取。断线状态、最近错误、待确认数量会显示在桌面任务状态中。
- 服务器队列仍为 `INBOX_DATA/inbox.jsonl`。每次变更先写临时文件并刷新到磁盘，再原子替换；写入失败不会更新内存中的队列。现有 JSONL 可直接读取，无需手工迁移。
- 默认保留完成/失败历史 **30 天**，在启动和后续写入时清理；pending 不按时间删除。默认最多 **10000 条**；满时优先回收最早的 done 历史，仍满则 `/collect` 返回 429，不丢弃待办或未到保留期的 failed。回收 done 后它的 24h 去重记录也会消失，但桌面的已入库去重仍保护已有卡片。
- 定期备份服务器的 `inbox.jsonl`。损坏的旧文件会阻止启动，程序不会自动清空；停服务、保留故障文件后恢复备份。

可选环境变量：

| 变量 | 默认值 | 含义 |
|------|--------|------|
| `INBOX_MAX_ATTEMPTS` | `3` | 每轮自动分析总次数 |
| `INBOX_RETRY_BASE_MS` | `60000` | 失败后首次等待毫秒数，之后翻倍，最多 1 小时 |
| `INBOX_MAX_ROWS` | `10000` | 队列与保留历史的总容量 |
| `INBOX_HISTORY_DAYS` | `30` | 完成/失败历史保留天数 |

以上可选值必须是正整数；无效值回退默认值。不要把 `HOST` 改成公网监听来绕过 HTTPS。

## 升级与验收

先备份 `inbox.jsonl`，替换本目录的 `server.mjs` 并重启服务，再升级桌面应用。手机快捷指令的 URL、Token 与 JSON 请求保持不变。

新服务器兼容旧客户端的基本 `/collect`、`/pull`、`/ack` 请求；旧客户端没有持久回执，不能获得新版完整的断线保护。新桌面连接旧服务器时仍能收集；旧服务器不支持失败列表、手动重试或自动退避，设置页应提示升级服务端。旧服务器对于已完成任务再次 ACK 的 404 被新版桌面按已确认兼容处理。

上线后至少检查：

1. 手机提交一篇测试文章，桌面出现任务并完成入库。
2. 电脑离线时提交，恢复后正常收集。
3. 相同文章重复分享，不覆盖已有卡片。
4. 模拟模型暂时不可用，任务按次数重试并可查看最终失败原因。
5. 分析完成时暂时断开收件箱连接，再恢复/重启桌面，确认只补回执、不重复分析。

本仓库自动回归使用临时目录、测试 Token 和模拟处理器，不访问真实文章或收费模型：

```bash
node --import tsx --test tests/inbox-client.test.ts tests/inbox-server.test.ts
```
