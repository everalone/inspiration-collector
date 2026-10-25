# 公网收件箱部署（VPS）

手机把公众号文章链接 POST 到本服务，家里电脑轮询拉取后自动拆卡。服务器保存链接、备注、任务状态、成功标题和脱敏后的结构化失败报告；用于拆卡的文章抓取、模型调用、图片与卡片入库在你的电脑完成。电脑关机、睡眠或应用退出时，链接继续排队，待电脑恢复后处理。

本文对应 v0.2.2 的协议与部署要求，需与同版本桌面应用配套使用。桌面下载与完整改动见 [v0.2.2 Release](https://github.com/everalone/inspiration-collector/releases/tag/v0.2.2)。收件箱由使用者自行部署和配置，不会连接作者的服务器。

这是**个人单用户收件箱**：一个 Token 对应一个共享队列，只安排一台桌面程序消费。不要向其他用户公开 Token，也不要把 Token 或自己的模型 Key 写入公开安装包。本协议没有多用户隔离或多桌面任务租约，不提供跨设备卡片同步。

## 环境要求

- Node.js ≥ 20
- 域名解析到本 VPS（A 记录）
- 反代并自动 HTTPS（推荐 Caddy）
- 安全组只需对公网开放网站使用的 80/443；8787 默认仅监听 `127.0.0.1`，交给反向代理访问。

## 启动

将 `server.mjs` 与 `failure-report.mjs` 一起放在部署目录；启用 ClawBot 时再加入 `clawbot-bridge.mjs`、`clawbot-messages.mjs`，共四份源码。切换到该目录后启动：

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
| POST | `/collect` | Bearer | `{url,note?}` 入队；pending 去重，done 记录 24h 去重；同 URL 已 failed 时返回 `{id,status:"failed"}`，不重新入队 |
| GET | `/pull?limit=5` | Bearer | 只返回未达次数上限且已到重试时间的 pending，最多 20 条；含 `attempts`、`maxAttempts`、`generation` |
| GET | `/status?ids=UUID,UUID` | Bearer | 只读查询 1–20 个不重复 UUID；返回 `{items,missing}`，不拉取、不重试、不清理队列 |
| POST | `/ack` | Bearer | `{id,ok,generation?,title?,failureReport?,error?,receiptId?}`；成功可带标题，失败可带结构化报告；用 `receiptId` 去重，忽略过期 `generation` 回执，原始 `error` 不持久化或转发 |
| GET | `/failed` | Bearer | 返回失败条目的 `id,url,title,attempts,maxAttempts,generation,failureReport,error,last_attempt_at` 等字段；`error` 为安全摘要 |
| POST | `/retry` | Bearer | `{id}` 将 failed 手动开启新一轮：次数归零、生成新 `generation`、清除旧报告；pending 不重复重置，done 返回 409 |

桌面应用 ⚙ 设置里填 `https://你的域名` 与同一个 `INBOX_TOKEN`，打开「手机收集」。

### 成功回执与文章标题

桌面完成收集后，从真实的 `IngestResult.title` 取得标题，先随成功回执写入本地 `data/inbox-receipts.json`，再发送 `/ack`。断线或重启后补发同一回执时仍携带标题，不会为了补标题重新分析文章。旧回执文件没有 `title` 时仍可正常补发。

`title` 是可选字段，仅在 `ok: true` 时接收。服务器清理控制字符、合并空白并最多保留 200 个 Unicode 字符；无效或空标题视为缺失，失败回执中的标题忽略。成功接收的标题随任务持久化到 `inbox.jsonl`。

对于已经 `done, ok: true` 但缺少标题的旧记录，再次提交含有效标题的成功 ACK 可幂等补填标题，**不改变任务状态、尝试次数、完成时间或回执记录**；已有有效标题不会被后续 ACK 覆盖。旧客户端不传标题仍能完成收集，不要求迁移旧数据。

### 处理轮次与失败报告

新建任务与手动 `/retry` 各生成一个 `generation`。桌面在 ACK 中原样返回它；带有旧轮次值的回执得到当前状态响应，但不改变新轮次。旧记录在查询与拉取时以 `"legacy"` 表示原轮次。省略 `generation` 的旧客户端 ACK 仍被接受，因此旧客户端不具备跨轮次的回执隔离。

失败 ACK 可包含以下 `failureReport`（示例）：

```json
{
  "version": 1,
  "stage": "card_validation",
  "articleTitle": "示例文章",
  "batch": 2,
  "imageStart": 9,
  "imageEnd": 16,
  "issues": [{
    "cardIndex": 3,
    "cardTitle": "示例配色",
    "cardType": "palette",
    "field": "payload.colors[0].hex",
    "code": "invalid_color"
  }],
  "issueCount": 1
}
```

`stage` 仅接受 `card_validation` 或 `model_response`；卡片序号从 1 开始，0 表示整段模型响应。文章名、批次、图片范围、卡片名和类型为可选上下文。`code` 只接受 `invalid_type`、`missing_value`、`invalid_format`、`invalid_url`、`invalid_color`、`invalid_shape`、`invalid_json`、`truncated`。报告最多保存 10 项有界问题，`issueCount` 表示问题总数；只传递字段位置与固定原因，不包含模型原始响应、提示词或请求头。

桌面在本地任务、待发回执中保留报告，服务器再校验、脱敏并持久化。未知错误、旧客户端只传的错误文本或不合法报告显示通用摘要；服务器不会直接保存或转发 `body.error`。成功 ACK 清除失败报告，手动新一轮也会清除旧报告。

### 查询指定任务状态

`GET /status?ids=...` 使用与 `/collect` 相同的 `Authorization: Bearer <INBOX_TOKEN>`。`ids` 参数只能出现一次，包含 **1–20 个不重复的标准 UUID**，以英文逗号分隔；UUID 大小写均可，按小写匹配。缺少参数、空值、重复 ID、畸形 UUID 或超过上限返回 `400`；缺少或错误的 Token 返回 `401`。

成功响应示例（示例 ID）：

```json
{
  "items": [{
    "id": "11111111-1111-4111-8111-111111111111",
    "status": "pending",
    "ok": null,
    "title": null,
    "generation": "11111111-1111-4111-8111-222222222222",
    "failureReport": null,
    "received_at": "2026-01-01T00:00:00.000Z",
    "acked_at": null,
    "attempts": 0,
    "maxAttempts": 3,
    "next_attempt_at": null
  }],
  "missing": []
}
```

已知任务按请求顺序出现在 `items`；未知或已清理的 ID 出现在 `missing`，整体仍返回 `200`。每条已知任务固定返回 `title: string | null`、`failureReport: object | null`，以及 `generation`、`attempts`、`maxAttempts`；缺少有效标题或报告时为 `null`。存在失败原因时 `error` 是由报告生成的安全摘要。首次处理前 `ok`、`acked_at` 为 `null`；没有待执行的退避时 `next_attempt_at` 为 `null`。失败后仍在自动重试的任务是 `status: "pending", ok: false`，只有 `status: "done", ok: true` 才表示桌面已确认成功；`failed` 表示本轮自动处理已停止。

查询不会修改任务、消费重试次数或延长/清理历史。`missing` 不能视为成功。反向代理若使用路径白名单，应按使用需要加入 `/status`；同机 ClawBot 通过回环地址查询，不需要为它新增公网端口。

## 微信 ClawBot 入口

可运行独立常驻桥接服务，接收扫码绑定用户发来的公众号**文本链接**，入队后回复收件通知，桌面成功导入后再回复完成通知。完成通知优先采用成功 ACK 回传、由 `/status` 提供的文章标题；没有该标题时使用此前读到的页面标题，两者都缺失则发送通用完成通知。配置、账号隔离、通知重试与 systemd 示例见 [ClawBot 部署说明](clawbot.md)。它与 iPhone 快捷指令共用现有收件箱，不需要把模型 Key 放到服务器。

## 重试、回执与备份

- 默认每轮共 **3 次文章处理：首次 + 2 次重试**，配置只能调低，不能超过 3。第 1、2 次失败后分别等待 **60 秒、120 秒** 再允许拉取；第 3 次失败进入失败列表并停止。实际执行时间还取决于桌面轮询、应用是否运行和本地任务队列；每次文章处理可含多个图片批次和模型请求。
- 最终失败链接再次 `/collect` 仍返回 `failed`，经过 24 小时、历史保留期或服务重启都不会自动重排。只有用户明确 `/retry` 才开启新 `generation` 和新一轮次数。
- 桌面使用统一收集队列。普通收藏已入库文章会跳过，不会因为重复分享或重试覆盖手改卡片；明确「重跑」仍属于用户主动操作。
- 桌面先保存本地任务结果，再写 `data/inbox-receipts.json` 并向服务器确认。相同 `id + generation + attempt` 已有落盘失败或成功结果时直接复用，即使进程在写 ACK 回执前退出也不重复分析该已完成尝试。尚未落盘的中断处理不在此保证范围内。
- 回执网络失败按 5 秒起、最高 5 分钟退避持续补发；重启仍可补发。**补 ACK 和补微信通知都不消耗分析次数，也不再次调用收费模型。** 回执文件不保存 Token；应与本地数据库、任务文件一起备份。回执损坏会暂停拉取并显示错误，保留原文件以便恢复。
- 所有收件箱请求有 **15 秒**超时，包含响应正文读取。断线状态、最近错误、待确认数量会显示在桌面任务状态中。
- 服务器队列仍为 `INBOX_DATA/inbox.jsonl`。每次变更先写临时文件并刷新到磁盘，再原子替换；写入失败不会更新内存中的队列。现有 JSONL 可直接读取，无需手工迁移。
- 默认保留 done 历史 **30 天**，在启动和后续写入时清理；**pending 和 failed 不按时间删除**。默认最多 **10000 条**；满时优先回收最早的 done 历史，仍满则 `/collect` 返回 429，不丢弃待办或最终失败记录。回收 done 后它的 24h 去重记录也会消失，但桌面的已入库去重仍保护已有卡片。
- 定期备份服务器的 `inbox.jsonl`。损坏的旧文件会阻止启动，程序不会自动清空；停服务、保留故障文件后恢复备份。

可选环境变量：

| 变量 | 默认值 | 含义 |
|------|--------|------|
| `INBOX_MAX_ATTEMPTS` | `3` | 每轮总次数（含首次）；有效值限制为 1–3，大于 3 时取 3 |
| `INBOX_RETRY_BASE_MS` | `60000` | 失败后首次等待毫秒数，之后翻倍，最多 1 小时 |
| `INBOX_MAX_ROWS` | `10000` | 队列与保留历史的总容量 |
| `INBOX_HISTORY_DAYS` | `30` | done 历史保留天数；不删除 pending 或 failed |

以上可选值必须是正整数；无效值回退默认值。不要把 `HOST` 改成公网监听来绕过 HTTPS。

## 升级与验收

先停止相关服务并备份 `inbox.jsonl`；使用 ClawBot 时同时保留账号文件和 `CLAWBOT_DATA/state.json`。仅部署收件箱时必须配套替换 `server.mjs`、`failure-report.mjs`；使用 ClawBot 时还须同时替换 `clawbot-bridge.mjs`、`clawbot-messages.mjs`，共 **4 个文件**。检查服务用户可读这些源码后，重启对应服务并升级桌面应用。手机快捷指令的 URL、Token 与 JSON 请求保持不变。

新服务器兼容旧客户端的基本 `/collect`、`/pull`、`/ack` 请求，但旧客户端不传结构化报告或 `generation`，更早版本也没有持久回执；不能获得新版完整的跨重启结果复用、跨轮次旧回执隔离。新桌面连接旧服务器仍可收集；缺少次数、轮次或最终失败保留协议的旧服务器无法提供本版的每轮停止保证。更早服务器还可能不支持失败列表、手动重试或自动退避。完整行为需配套升级；切换期间先退出旧桌面消费者。旧服务器对于已完成任务再次 ACK 的 404 被新版桌面按已确认兼容处理。

上线后至少检查：

1. 手机提交一篇测试文章，桌面出现任务并完成入库。
2. 电脑离线时提交，恢复后正常收集。
3. 相同文章重复分享，不覆盖已有卡片。
4. 用隔离数据与模拟处理器验证首次加两次重试后停止，报告能定位批次、卡片、字段；重复分享 failed 不增加次数或重排。
5. 用隔离数据模拟结果已落盘、ACK 未保存时进程退出，再恢复，确认同一任务轮次和尝试只补回执。
6. 手动重新排队生成新轮次；旧轮次 ACK 不影响新轮次，失败通知断线恢复只补通知。

本仓库自动回归使用临时目录、测试 Token 和模拟处理器，不访问真实文章或收费模型：

```bash
node --import tsx --test tests/inbox-client.test.ts tests/inbox-server.test.ts
```
