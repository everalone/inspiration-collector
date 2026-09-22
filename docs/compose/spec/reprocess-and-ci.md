---
feature: reprocess-and-ci
status: delivered
updated: 2026-09-12
branch: feat/reprocess-and-ci
commits: 6d7df55a258124ba7ca6ec631a68a8ca8f18a1fc..29062ad
---

# Reprocess UI + Release CI

## Report

**What was built** — 「重跑提取」产品化：`ingest`/`reprocess` 支持 `refresh` 强制在线重抓（失败不写库；raw 缓存改为提取成功后落盘）；`POST /api/articles/reprocess` 串行逐篇返回 ok/error；⚙ 设置内多选/全选/重跑，左侧文章列表单篇「重跑」按钮，确认框含真实卡数 N，客户端逐篇请求并 toast 进度。发版 CI：push `v*` 标签 → 校验 tag 与 `package.json` version 一致 → Windows 构建 Setup+Portable → 自动创建 Release（两 exe + `latest.yml`）。代码签名明确不做（未来再说）。

**Verification** — `npm run build:core`（tsc）PASS（修复前后各一轮）；`loadBootstrap`/`loadItems`/`imgCache` 引用存在（grep）。独立评审两轮：首轮 3 critical（早期 `upsertArticle` 半写库、CLI 多 id 中断、确认文案缺 N）已修；复审确认 critical 清零，残余（过滤态卡数、raw 缓存时机）已再修。无测试框架，未跑 `npm run dist`（依赖本机 electron-builder 长时间打包）。

**Journey log** — 1) 会话隔离禁止 `git worktree add`，改原地 `feat/reprocess-and-ci`（用户确认功能分支再合并）。2) 选定「强制重抓失败中止」后，实现上把 raw 缓存写入挪到 `replaceItems` 之后，才真正满足「成功后刷新」。3) 评审指出 `state.items` 受过滤/500 条上限约束，确认框 N 改为 `listArticles.itemCount` 子查询。4) 批量 UI 从单次长 HTTP 改为客户端逐篇 POST，解决进度反馈与超时。5) 工具层多次 tool-call flood，实现被迫单步推进——合并时以 git 提交为准。

## [S1] Problem

1. **换模型后旧卡片不会变好**：⚙ 设置可改 API Key / Base URL / Model，但已入库文章的卡片仍是旧模型产物。CLI 有 `node cli.ts reprocess <id>`，UI 无入口，无法批量重跑。
2. **发版全手工**：`npm run dist` 本地打包后手动建 Release、手动传两个 exe。易漏传、version 与 tag 可能不一致。仓库无任何 GitHub Actions。

## [S2] Design

### S2.1 Reprocess 行为

- **覆盖策略**：`reprocess` 走完整 `ingest`，经既有 `replaceItems` **整篇替换**该文全部卡片（含用户手改卡）。不合并、不保留手改。
- **抓取策略**：强制在线重抓微信原文（不读 `data/raw/` 缓存）；抓取失败则**中止该篇**并报错，不改库。成功入库后刷新 raw 缓存。
- **入口**：
  1. ⚙ 设置弹窗「重跑提取」区：文章多选（checkbox）+「全选」+「重跑选中」；
  2. 左侧文章列表父级行内「重跑」按钮，仅对该篇。
- **确认**：确认对话框含「将删除该文现有 N 张卡片并重新提取，手动修改会丢失」（N 来自 `listArticles.itemCount`）；取消则不动作。
- **执行与反馈**：客户端串行逐篇 POST；每篇 toast；结束汇总成功/失败。失败篇保持原卡片不变（写库仅发生在提取+校验成功后）。
- **API**：`POST /api/articles/reprocess` body `{ ids: string[] }` → `{ results: [{ id, ok, title?, counts?, error? }] }`。
- **CLI**：`reprocess` 与 API 同语义；多 id 时单篇失败不中断其余。

### S2.2 Release CI（4b）

- **触发**：push 标签 `v*`（如 `v0.2.0`）。
- **校验**：tag 去掉 `v` 前缀后必须等于 `package.json` 的 `version`，否则 job 失败。
- **构建**：`windows-latest` 上 `npm ci` → `npm run dist`。
- **发布**：创建/更新该 tag 的 GitHub Release，上传 Setup exe、Portable exe、`latest.yml`。
- **权限**：`contents: write`。不涉及代码签名。
- **发版操作**：改 version → commit → `git tag vX.Y.Z` → push branch + tag（见 README）。

### S2.3 明确不做（用户决策）

- **代码签名**：不做，未来再说。SmartScreen 拦截属预期。
- 手改卡合并保留、导出备份后覆盖：不做。
- 设置内「优先用本地 raw」模式：不做（与选定的强制重抓相反）。

## [S3] Out of Scope

- 代码签名 / EV 证书 / 消 SmartScreen。
- 保留用户手改卡片的合并策略。
- 重跑前自动导出 JSON/Markdown 备份。
- 跨设备同步、导出 Notion、手机端入口（仍留在 STATE 候选）。
- CI 矩阵（macOS/Linux）、自动 bump version。
- `upsertArticle` 与 `replaceItems` 同事务（复审记录的非关键加固项）。

## Tasks

- [x] T1: `ingest`/`reprocess` 支持强制在线重抓，失败中止不改库 — acceptance: 抓取失败时 `replaceItems` 不被调用；成功路径仍整篇替换（covers: S2.1）
- [x] T2: `POST /api/articles/reprocess` 接口 — acceptance: 提交多个 id 返回逐篇 ok/error；失败篇旧卡仍在（covers: S2.1; depends: T1）
- [x] T3: ⚙ 设置「重跑提取」面板（多选/全选/确认警告/进度汇总）— acceptance: UI 可勾选文章并触发，确认框含删除警告，完成后列表刷新（covers: S2.1; depends: T2）
- [x] T4: 文章列表单篇「重跑」按钮 + 同确认流 — acceptance: 列表行可重跑单篇，行为与设置面板一致（covers: S2.1; depends: T2）
- [x] T5: `.github/workflows/release.yml` — acceptance: workflow 含 tag 触发、version 校验、dist、上传两 exe + latest.yml（covers: S2.2）
- [x] T6: README 补「发版」两步说明（改 version、打 tag）— acceptance: README 含 tag 发版步骤且与 workflow 一致（covers: S2.2; depends: T5）
