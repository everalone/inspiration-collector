---
feature: mobile-ingest
status: delivered
updated: 2026-09-22
branch: feat/mobile-ingest
commits: b66ef2188a02b3904ddebb535d0f1e81ccde6636..0ed4043
---

# 手机转发自动收集（VPS 收件箱）

## Report

**What was built** — 手机在外也可把公众号文章链接送进灵感收集：VPS 上可部署的 `inbox/` 收件箱（Bearer token，只收 `mp.weixin.qq.com/s/`，24h 去重，JSONL 持久化，`/collect` `/pull` `/ack` `/health`）；桌面应用 ⚙ 配置 `inboxUrl`/`inboxToken`/`inboxEnabled`/`inboxIntervalSec`（10–120s），轮询或 Electron 定时 `drain` 后走既有 `ingest(refresh)` 全自动拆卡并系统通知（含卡片数）；`cli.ts inbox-pull` 可无 GUI 拉取；README + 设置页提供 iPhone 快捷指令（POST `/collect`）说明；`inbox/Caddyfile` + systemd 示例供 VPS HTTPS 部署。入队用进程内互斥避免并发同链双队列；默认只绑 `127.0.0.1` 由 Caddy 反代。

**Verification** — `npm run build:core` PASS。`inbox` 冒烟：`/health` ok；无 token POST `/collect` 401；合法 URL 201 `queued`；重复 200 `duplicate`；`/pull` FIFO；两并发同 URL → 一 `queued` 一 `duplicate`。独立评审两轮：critical（CLI token 泄露、入队 TOCTOU）已修；复审指出 `config set` 回显仍泄 token，已再修（`0ed4043`）。未跑真实 VPS/ iPhone 端到端（用户需自备域名与服务器）。

**Journey log** — 1) 用户不熟 VPS/Tunnel 术语，先用「门房收信」比喻定下 VPS 收件箱 + 电脑拉取，而不是 Tailscale。2) 评审发现 smoke 里 GET `/collect` 404 是方法门，不是鉴权洞；POST 无 token 本就 401。3) 入队 TOCTOU 用 Promise 串行锁修掉，并发同 URL 实测一真一 duplicate。4) 双轮询（core `startInboxPoller` + Electron `watchInbox`）靠 `drainLock` 互斥，通知只在 Electron 侧带卡片数。5) 工具层多次 tool-call flood，合并重复插入的 `/api/inbox/drain` 块时务必先 grep 计数。

## [S1] Problem

用户在 iPhone 上刷到微信公众号文章，希望「转发/分享到固定位置」后，家里常开的灵感收集电脑**自动**抓取并拆卡入库。人长时间在外，**不在与电脑同一 Wi-Fi**，现有剪贴板监听与界面粘贴都无法在手机侧完成收集。

## [S2] Design

### S2.1 链路与角色

手机快捷指令 HTTPS POST → VPS 收件箱队列 → 电脑轮询 pull → 既有 ingest → ack。

| 角色 | 职责 |
|------|------|
| **inbox**（VPS） | 公网 HTTPS 入口；校验 token；只收 `mp.weixin.qq.com` 链接；持久化队列；供桌面 pull/ack。**不做**抓取与视觉拆卡。 |
| **桌面应用** | 配置 inbox URL + token；后台轮询；拉到后 `ingest(url)`；结果通知；ack 确认出队。 |
| **iPhone** | 快捷指令从分享/剪贴板取 URL → POST 到 inbox → 显示成功/失败。 |

### S2.2 Inbox HTTP 契约

- **鉴权**：`Authorization: Bearer <token>`；`INBOX_TOKEN`。默认监听 `127.0.0.1:8787`（可用 `HOST` 覆盖），由 Caddy/nginx 终结 HTTPS。
- **`POST /collect`** `{url}` 仅 `https://mp.weixin.qq.com/s/`；`201 queued` / `200 duplicate`（pending 或 24h 内）/ `400` 非法 / `401`。入队进程内互斥。
- **`GET /pull?limit=5`** → pending FIFO。
- **`POST /ack`** `{id, ok, error?}` 出队记日志。
- **`GET /health`** 免鉴权。
- **存储**：JSONL（`INBOX_DATA`）。部署见 `inbox/README.md` + `inbox/Caddyfile`。

### S2.3 桌面轮询与自动入库

- ⚙：`inboxUrl`、`inboxToken`、`inboxEnabled`、`inboxIntervalSec`（10–120，默认 30）。
- drain 串行 `ingest(url, {refresh:true})` 后 ack；失败 ack `ok:false`（网络类可在 ack 前有限重试）；Electron 系统通知含成功/失败/卡片数。
- CLI：`node cli.ts inbox-pull`。
- 同 URL 再收 = 重新拆卡（与重跑语义一致）。

### S2.4 iPhone 接入

快捷指令：取 URL → `POST https://<域名>/collect` + Bearer + JSON `{url}`。文案在设置页与 README。不做原生 App。

### S2.5 安全边界

Token 在 VPS 环境变量、桌面 config、快捷指令；CLI 回显脱敏。VPS 不存正文/图片/卡片。

## [S3] Out of Scope

- 自建微信订阅号/服务号收转发；Tailscale/Cloudflare Tunnel。
- 抓取拆卡/库上云；跨设备同步。
- iOS/安卓 App；域名购买备案；inbox 管理后台。
- 多实例 JSONL 分布式锁；Bearer 常数时间比较（单机收件箱可接受）。

## Tasks

- [x] T1: `inbox/` 服务（/collect /pull /ack /health，token，JSONL，24h 去重）— acceptance: 无 token 401；合法 queued；重复 duplicate；pull/ack 契约（covers: S2.2）
- [x] T2: Caddyfile + 部署文档 — acceptance: HTTPS 反代、环境变量、systemd 可照抄（covers: S2.2）
- [x] T3: ⚙ 配置 + 轮询/drain → ingest + ack + 通知 — acceptance: 启用后链接自动入库；有通知；关闭不拉（covers: S2.3）
- [x] T4: `cli.ts inbox-pull` — acceptance: 无 GUI 可拉取入库/ack（covers: S2.3; depends: T3）
- [x] T5: iPhone 快捷指令说明 + 设置页文案 — acceptance: 可按说明 POST /collect（covers: S2.4; depends: T1）
