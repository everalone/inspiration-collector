# 微信 ClawBot 链接收集

`clawbot-bridge.mjs` 是独立的常驻桥接服务：微信文本链接 → 收件箱 `/collect` → 电脑解析入库 → 收件箱 `/ack` → 微信完成通知。它不调用模型、不执行聊天指令，也不需要完整的 OpenClaw Agent 运行环境。模型设置继续留在电脑端。

本文对应 v0.2.2。使用前需自行部署收件箱与桥接服务、绑定自己的微信账号，并在桌面端配置自己的模型 API；安装包不包含作者的服务器地址、Token 或 API Key。下载与改动见 [v0.2.2 Release](https://github.com/everalone/inspiration-collector/releases/tag/v0.2.2)。

## 接收范围与通知

- 只接收扫码绑定账号的固定 `owner` 发给对应 `bot` 的普通文本消息。其他用户、群聊、引用、混合媒体及指令消息被忽略。
- 只提取 `https://mp.weixin.qq.com/s/...` 或含 `__biz` 与 `sn` 的公众号文章长链接；同条消息中的重复链接合并。公众号文章卡片转发、图片和文件不属于本服务的接收格式。
- `/collect` 返回 `queued` 或 `duplicate` 后，发送：`已收到链接：本篇名为《文章标题》，已加入队列。` 若返回 `failed`，直接查询并发送最终失败报告，不声称重新加入队列。
- 查询该任务得到 **`status: "done"` 且 `ok: true`** 后，优先使用该状态中的 `title`，发送：`《文章标题》已解析成功并导入灵感收集。` 电脑离线时仅有入队通知，待电脑运行并完成回执后才发完成通知。
- 最终状态为 `failed` 时发送实际尝试次数、停止自动重试和安全报告，例如：`《文章标题》收集失败：已尝试3/3次，已停止自动重试。` 后接批次、卡片序号/名称、字段和固定原因，结尾为 `请在电脑端查看，修正后可手动重新排队。` 仍处于自动退避的 `pending, ok: false` 不发送最终失败或成功通知。

入队通知的标题尽力从文章页面做限时、限量读取；不执行页面脚本、不跟随重定向、不调用模型。抓取超时、页面受限或未找到标题时，回退为 `已收到链接，已加入队列。`，不猜测文章名，也不阻止收集。

完成通知的标题来自桌面真实收集结果：桌面将 `IngestResult.title` 随成功回执持久化，再通过 `/ack` 的可选 `title` 字段回传；服务器保存后，`/status` 固定返回 `title: string | null`。桥接只在 `done, ok: true` 时采用这个标题，并在发送前写入待通知状态，使通知补发或服务重启后保留正确文章名。它优先于入队时抓到的页面标题。

旧客户端、旧回执或旧服务器记录没有标题时仍兼容：完成通知沿用已读到的页面标题；两处都缺失时发送 `文章已解析成功并导入灵感收集。`。已成功完成但缺标题的服务器记录可由再次提交的成功 ACK 幂等补填；补填不改变状态、尝试次数、完成时间或回执记录，也不覆盖已有有效标题。标题补填不会触发重新分析，已经发送的完成通知也不会因此再次发送。

失败报告来自桌面持久化的 `failureReport`，由收件箱 `/status` 返回。桥接先校验和脱敏，再将安全报告、次数上限和实际次数写入待通知状态；失败文章名可用报告中的 `articleTitle` 补全。报告仅接受固定结构和原因码，不直接转发 `remote.error`、模型原文或 API 错误响应。正文最多 2200 字，完整失败通知最多 2500 字；旧数据缺报告时使用通用提示，缺次数时不猜测“3/3”。详细合同见 [收件箱失败报告](README.md#处理轮次与失败报告)。

通知失败会持久化并单独退避重试，等待时间从 2 秒起、最多 15 分钟，实际发送还取决于长轮询和网络状态。**补发通知不会重新调用 `/collect`、消耗文章分析次数或再次调用收费模型。** 同阶段补发使用固定 `client_id`；网络响应丢失时仍需依赖微信侧的去重行为，不能把通知当成严格的一次性投递。提交收件箱时若响应丢失会重试提交，由收件箱原有 URL 去重保护。

## 每轮停止与手动新一轮

手机任务默认每轮最多 **3 次：首次处理 + 2 次重试**。最终 failed 不会因再次发链接、超过 24 小时或历史保留期自动重新排队；失败记录也不按时间删除。只有在电脑端失败列表点击「重新排队（新一轮）」才会清零次数并生成新 `generation`。

桌面按任务 ID、`generation` 和尝试序号复用已落盘结果：即使完成失败记录后、发送 ACK 前重启，也不会为同一次已完成尝试重新分析。旧客户端不携带轮次和结构化报告，不能获得完整的跨轮次隔离和故障恢复保证，需与服务器配套升级。

最终通知确认发送后，桥接会移除该条跟踪。手动重新排队后，如需机器人继续跟踪新一轮，再把链接发给它；此时收件箱返回 pending 的重复记录，桥接据此建立新通知跟踪。

## 账号和环境变量

先通过微信扫码登录流程取得专用账号文件，保留返回的 `token`、`owner`、`bot`、`base` 字段。`owner` 来自绑定结果，不能从后续聊天内容覆盖；`base` 仅允许程序校验通过的微信 HTTPS 来源。不要将账号文件、扫码凭证或收件箱 Token 提交到 Git。

| 变量 | 要求 | 用途 |
|------|------|------|
| `CLAWBOT_ACCOUNT_FILE` | 必填 | 含绑定结果的私有 JSON 文件；推荐由 systemd `LoadCredential` 提供 |
| `CLAWBOT_DATA` | 必填 | 专用服务用户可写的状态目录 |
| `INBOX_TOKEN` | 必填 | 与收件箱服务使用同一个 Token |
| `INBOX_URL` | 可选 | 默认 `http://127.0.0.1:8787`；同机走回环地址，跨主机必须使用可信 HTTPS |

部署需要同一版本的 **4 个源码文件**：`server.mjs`、`failure-report.mjs`、`clawbot-bridge.mjs`、`clawbot-messages.mjs`。收件箱版本须包含 `/status`、结构化报告和 `generation` 协议；只覆盖 `server.mjs` 会缺少其导入的报告模块。桥接服务主动向微信发起 HTTPS 长轮询，不监听新端口。一次绑定只运行一个桥接进程；迁移时先停止旧监听，再转移状态与账号。

## systemd 常驻示例

预先创建无登录权限的 `inspiration-clawbot` 用户。将源码放在 `/opt/inspiration-collector/inbox`，源码目录应可遍历、上述四份源码应可读，例如 root 所有、目录 `755`、文件 `644`。创建 `/var/lib/inspiration-clawbot` 并设为该服务用户所有、权限 `700`。账号文件放在 root 所有的 `/etc/inspiration-clawbot/account.json`，目录 `700`、文件 `600`；已有 `/etc/inspiration-inbox.env` 保持 root 所有、权限 `600`。

以下为 `/etc/systemd/system/inspiration-clawbot.service` 示例；根据 `command -v node` 调整 `ExecStart` 的 Node 路径：

```ini
[Unit]
Description=Personal WeChat ClawBot link collector
Wants=network-online.target
After=network-online.target inspiration-inbox.service

[Service]
Type=simple
User=inspiration-clawbot
Group=inspiration-clawbot
WorkingDirectory=/opt/inspiration-collector/inbox
EnvironmentFile=/etc/inspiration-inbox.env
Environment=INBOX_URL=http://127.0.0.1:8787
Environment=CLAWBOT_DATA=/var/lib/inspiration-clawbot
Environment=CLAWBOT_ACCOUNT_FILE=/run/credentials/inspiration-clawbot.service/wechat-account
LoadCredential=wechat-account:/etc/inspiration-clawbot/account.json
ExecStart=/usr/local/bin/node /opt/inspiration-collector/inbox/clawbot-bridge.mjs
Restart=on-failure
RestartPreventExitStatus=78
RestartSec=15
TimeoutStopSec=40
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/inspiration-clawbot
MemoryMax=256M
TasksMax=64

[Install]
WantedBy=multi-user.target
```

`LoadCredential` 让 systemd 在启动时读取 root 私有账号文件，再向服务提供只读凭证；无需把账号文件改成所有人可读。代码写入时若使用 `umask 077`，应在写入后显式设置源码文件 `644`，避免服务因无法读代码而启动失败。

检查配置后启动：

```bash
systemd-analyze verify /etc/systemd/system/inspiration-clawbot.service
systemctl daemon-reload
systemctl enable --now inspiration-clawbot.service
systemctl status inspiration-clawbot.service
```

认证失效、账号/配置不合法、状态损坏或其他需人工处理的致命错误返回退出码 `78`。`RestartPreventExitStatus=78` 防止凭证失效后无限重启；确认具体错误、恢复凭证或状态后再手动启动。临时网络问题由程序内部退避处理。

## 状态、备份与验收

`CLAWBOT_DATA/state.json` 保存游标、去重标识、待提交链接及待通知记录，包括安全报告、文章处理次数和私有回复上下文，需与账号文件一同妥善备份。更新源码应保留它；旧状态缺报告或次数字段时可兼容读取。不要为解决启动失败直接删除。绑定账号改变时旧状态会被拒绝，应先停服务并保留原账号与状态，再按新绑定安排独立状态目录。

`CLAWBOT_DATA/status.json` 和标准输出只记录阶段、计数、最近轮询/提交时间与错误码，可用来排查 `auth_required`、`notification_failed`、`inbox_status_unavailable` 等状态。历史已被收件箱清理时会记录 `inbox_item_missing`，不会推断解析成功。

部署后需在自己的微信中验收正常收集和标题完成通知。失败次数、报告、同一尝试恢复、重复分享 failed 及通知断线补发使用隔离数据和模拟模型验证，再核对部署服务版本；不要为了验收故意重复调用真实收费模型。手机验收还应确认入队标题读取失败时的回退，以及其他用户消息不入队。

通知延迟边界：已缓存的最终失败通知如果发送失败，之后仍会补发；若用户在补发前已手动开启新一轮，该条回复仍描述上一轮结果。桥接当前未按 generation 取消旧通知，不会因此重复分析。
