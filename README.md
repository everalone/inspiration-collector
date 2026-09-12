# 灵感收集

项目 ID：P016。登记信息见 `D:/workspace/INDEX.md`。

个人灵感收集工具：把值得留存的微信公众号文章链接复制下来，自动抓取、用视觉大模型把内容拆成一张张"可复制的卡片"（配色 / 网址 / 项目 / 提示词 / 笔记），形成可检索、可持续积累的本地灵感库。

**当前状态：MVP 已完成**（核心引擎 + 卡片墙 + Electron 桌面壳，已用 7 篇真实文章验收）。

## 快速开始

1. **配置 API key**：复制 `.env.example` 为 `.env`，填入你的 key（默认用 DeepSeek `deepseek-flash`，多模态；也可换任意 OpenAI 兼容视觉模型，改 `BASE_URL` + `MODEL`）。`.env` 与 `data/` 均已在 `.gitignore` 中，不会被提交。
2. **启动应用**（推荐）：
   ```
   npm install
   npm run app
   ```
   打开卡片墙窗口并常驻托盘，复制微信文章链接即自动收集（托盘菜单可关掉自动收集、设置开机自启）。
3. **或仅启动网页版**：`npm run serve`，浏览器打开 http://127.0.0.1:5178 ，用页面顶部的粘贴框收集。

## 使用流程

### 收集
- 桌面：复制 `mp.weixin.qq.com/s/…` 链接 → 自动抓取 → 提取 → 系统通知报告结果（如"配色×54，笔记×1"）。
- 手机：在手机微信里"复制链接" → 发给**文件传输助手** → 在电脑微信里打开并复制该链接 → 被自动收集。后续可考虑公众号转发接收等自动化方案（二期）。
- 抓取被微信风控拦截时，兜底方案：浏览器打开文章 → 另存为 HTML → `npm run ingest -- --offline <html路径>`。

### 卡片墙（左列表 + 右详情）
- 顶部一行是唯一的分类维度：全部 / 配色 / 网址 / github / 提示词 / 笔记 / 待核对，配合搜索框全局检索。
- **左侧列表**：紧凑卡片（类型徽章 + 标题 + 内容预览），右下角直接"编辑 / 删除"，点卡片在右侧打开详情；**中间分隔条可拖拽调整两栏宽度**（自动记忆）。
- **右侧详情**：完整内容 + **来源原图按卡片定位裁剪展示**（视觉模型提取时输出每张卡在图中的 bbox 区域，服务端按区域切图；点开可看完整原图对照）。配色卡大色块点一下复制 hex、"复制全部色值"、有原文说明则显示；网址卡点 URL 整条复制、探活状态显示；提示词卡全文一键复制；笔记卡目录芯片跳转、可复制为 Markdown。
- **待核对**页签集中列出校验存疑的卡片（如色值与原图对不上），对照原图人工修正。

### 数据都在本地
- `data/inspiration.db`：SQLite，文章与卡片。
- `data/raw/`：文章 HTML 缓存（重跑提取不重新抓）。
- `assets/<文章id>/`：正文原图（bbox 裁剪的依据与人工对照兜底）。
- `.env`：API key 等敏感配置（不入库）。
- `data/config.json`：端口、种子标签等非敏感配置。

## CLI

```
npm run ingest -- <url>...      # 收集文章
npm run ingest -- --offline <本地html路径>   # 风控兜底：解析本地另存的 HTML
node cli.ts reprocess <文章id>  # 换模型/改提示词后重跑某篇提取
node cli.ts checkurls           # 全库网址探活清扫（标记失效/域名不存在）
node cli.ts list                # 列出已入库文章
node cli.ts serve [--port=N]    # 启动卡片墙服务
node cli.ts config [set k=v]    # 查看/修改配置
```

## 架构（core/ 与壳解耦）

抓取 `fetch.ts`（浏览器 UA、本地直连，兼容传统图文 `#js_content` 与新版图片消息 `picture_page_info_list` 两种页面格式）→ 解析 `parse.ts` → 视觉提取 `extract.ts`（deepseek-flash 多模态，严格 JSON schema 拆卡片，零证据不臆造）→ 校验 `verify.ts`（色卡像素采样比对原图、网址探活、ENOTFOUND 判编造）→ 存储 `store.ts`（SQLite）→ 卡片墙 `viewer/` + 服务 `server.ts`；Electron 壳 `src-electron/main.mjs`（窗口/托盘/剪贴板监听/通知）。

## 已知限制与后续方向

- 视觉提取对设计稿类图片（假浏览器地址栏里的概念域名）会忠实抄录，探活会标"已失效/域名不存在"，人工编辑兜底。
- Electron 通过 `npx tsx` 子进程拉起核心服务，开发态运行方式；打包成安装包（electron-builder）是下一步。
- 手机端自动入口（公众号转发接收）、跨设备同步、导出 Markdown/Notion，均为可选二期。
- 提取质量依赖所选视觉模型；可换成更强模型重跑 `reprocess`。
