import { chatVision } from "./vision.js";
import { loadConfig } from "./config.js";
import { CollectionFailure, type FailureIssue, type FailureReport } from "./failure-report.js";

export type ItemType = "palette" | "website" | "repo" | "prompt" | "note";

export interface ExtractedItem {
  type: ItemType;
  title: string;
  bbox?: number[]; // [x1,y1,x2,y2] 0~1000，在该卡片来源图中的矩形区域
  payload?: {
    colors?: { hex: string; name?: string }[];
    url?: string;
    desc?: string;
    text?: string;
    sections?: { heading: string; bullets: string[] }[];
  };
  source_image_index?: number;
}

export interface Extraction {
  articleType: ItemType;
  articleSummary: string;
  tags: string[];
  items: ExtractedItem[];
}

const SYSTEM = "你是精确的信息提取器。只输出一个 JSON 对象，不输出任何其他文字、解释或 markdown 标记。";

const SCHEMA_PROMPT = `请把这篇微信公众号文章中值得收藏的信息拆分为若干"卡片"，只输出 JSON：
{
  "article_type": "整篇文章的归类: palette|website|repo|prompt|note",
  "article_summary": "一句话总结文章(40字以内)",
  "tags": ["主题标签,从种子标签中选,最多4个,确有必要可新增"],
  "items": []
}

卡片类型与字段：
1. 配色 palette：{"type":"palette","title":"方案名(原文有名字就抄原名)","payload":{"desc":"原文对这套配色的说明,没有就空字符串","colors":[{"hex":"#AABBCC","name":"色名或省略"}]},"source_image_index":N}
   - 每个配色方案一张卡片；hex 优先抄录图中标注的文字；图上没标才根据色块估计；一篇文章可能有很多个方案，务必逐个拆分。
2. 网址 website：{"type":"website","title":"名称","payload":{"url":"完整网址","desc":"一句话说明"}}
3. 项目 repo：{"type":"repo","title":"项目名","payload":{"url":"完整链接","desc":"一句话说明"}}
4. 提示词 prompt：{"type":"prompt","title":"提示词名","payload":{"text":"完整提示词原文"}}
5. 笔记 note：{"type":"note","title":"笔记标题","payload":{"sections":[{"heading":"小节标题","bullets":["要点"]}]}}

每张卡片都必须给出定位字段：
- "source_image_index"：该卡片内容主要出现在哪张正文图片中（按顺序编号）。
- "bbox"：[x1,y1,x2,y2]，取值 0~1000，是该卡片内容在那张图中的矩形区域（左上、右下角坐标），框住该条目自身，不要框整张图。
- 一张图里有多个条目时，必须分别给各自的 bbox（例如一页里有 5 个配色方案，就各框各的行）。
- 内容只来自文字正文、不在任何图片里时，bbox 给 [0,0,0,0]。
- 卡片内容跨越图片中多个区块时，框最主要的那一块。

规则：
- 只基于给出的文字与图片提取，严禁凭标题臆造内容；证据不足时 items 返回空数组。
- URL 必须逐字抄录自原文（文字或图片中出现的），绝不编造、绝不"补全"；看不清的字符照原文抄。
- website/repo 的 url 必须是原文中完整的 http:// 或 https:// 链接；原文只有域名或路径、没有协议时，改用 note 卡片逐字保留原字符串和说明，不补协议。
- 五种卡片的内容字段统一放入 payload，不能省略各类型必需的 colors、url、text 或 sections。
- 图中或文中没有给出网址时，绝对不要猜测/编造域名——改用 note 卡片记录名称与说明。
- 设计展示图里浏览器窗口装饰性地址栏出现的网址不可信（只是配图）：除 github.com 项目地址外，此类内容的 website 卡 url 改填【文章链接】，desc 写明是风格/案例展示；正文或说明文字中明确推荐的网址照抄。
- 提示词必须逐字完整抄录，不得缩写、意译、省略。
- 图片按顺序编号，第一张 source_image_index=0。
- 同类内容逐项拆分，宁多勿漏；不要编造文章没有的内容。
- 若没有值得收藏的具体内容，items 返回空数组。`;

function normalizeHex(raw: string): string | null {
  let h = raw.trim().replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  return /^[0-9A-F]{6}$/.test(h) ? "#" + h : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function coordinate(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Validate without rewriting source URLs. Bare source addresses can be retained as notes. */
function urlKind(value: string): "link" | "note" | "invalid" {
  if (/[\s\u0000-\u001f\u007f\\]/.test(value) || /%(?![0-9a-f]{2})/i.test(value)) return "invalid";
  const scheme = value.match(/^([a-z][a-z\d+.-]*):/i)?.[1];
  if (scheme && !/^https?$/i.test(scheme)) return "invalid";
  if (scheme && !/^https?:\/\/[^/?#]+/i.test(value)) return "invalid";
  if (!scheme && (/^https?[\/\\]/i.test(value) || /^\/(?!\/)/.test(value))) return "invalid";
  const candidate = scheme ? value : `https://${value.replace(/^\/\//, "")}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname || parsed.username || parsed.password) return "invalid";
    return scheme ? "link" : "note";
  } catch { return "invalid"; }
}

function clampItems(raw: unknown[], imageCount: number): { items: ExtractedItem[]; issues: FailureIssue[] } {
  const out: ExtractedItem[] = [];
  const issues: FailureIssue[] = [];
  const validTypes: ItemType[] = ["palette", "website", "repo", "prompt", "note"];
  for (const [index, value] of raw.entries()) {
    const it = isRecord(value) ? value : null;
    const issue = (field: string, code: FailureIssue["code"]) => issues.push({
      cardIndex: index + 1,
      ...(typeof it?.title === "string" ? { cardTitle: it.title } : {}),
      ...(typeof it?.type === "string" ? { cardType: it.type } : {}),
      field, code,
    });
    if (!it) { issue("item", "invalid_shape"); continue; }
    const type = it.type as ItemType;
    if (!validTypes.includes(type)) { issue("type", "invalid_type"); continue; }
    const title = typeof it.title === "string" && it.title.trim() ? it.title.trim() : "未命名";
    const item: ExtractedItem = { type, title };
    const idx = coordinate(it.source_image_index);
    item.source_image_index = idx !== undefined ? Math.max(0, Math.min(Math.trunc(idx), Math.max(0, imageCount - 1))) : 0;
    const bbox = Array.isArray(it.bbox) ? (it.bbox as unknown[]).map(coordinate) : [];
    item.bbox = bbox.length === 4 && bbox.every((n): n is number => n !== undefined && n >= 0 && n <= 1000) ? bbox.map((n) => Math.round(n)) : undefined;

    if (it.payload !== undefined && it.payload !== null && !isRecord(it.payload)) {
      issue("payload", "invalid_shape"); continue;
    }
    const p = isRecord(it.payload) ? it.payload : {};
    // payload is canonical; legacy top-level fields are accepted only when that field is absent.
    const field = (name: string) => p[name] !== undefined ? p[name] : it[name];
    const desc = typeof field("desc") === "string" ? (field("desc") as string).trim() : "";
    const before = issues.length;
    if (type === "palette") {
      const colors = field("colors");
      if (!Array.isArray(colors)) { issue("payload.colors", colors == null ? "missing_value" : "invalid_shape"); continue; }
      if (!colors.length) { issue("payload.colors", "missing_value"); continue; }
      const cleaned: { hex: string; name?: string }[] = [];
      for (const [colorIndex, color] of colors.entries()) {
        const rawHex = typeof color === "string" ? color : isRecord(color) ? color.hex : undefined;
        const hex = typeof rawHex === "string" ? normalizeHex(rawHex) : null;
        if (!hex) { issue(`payload.colors[${colorIndex}].hex`, "invalid_color"); continue; }
        const name = isRecord(color) && typeof color.name === "string" ? color.name : undefined;
        cleaned.push(name ? { hex, name } : { hex });
      }
      item.payload = { colors: cleaned, desc };
    } else if (type === "website" || type === "repo") {
      const value = field("url");
      if (typeof value !== "string") { issue("payload.url", value == null ? "missing_value" : "invalid_shape"); continue; }
      const url = value.trim();
      if (!url) { issue("payload.url", "missing_value"); continue; }
      const kind = urlKind(url);
      if (kind === "invalid") { issue("payload.url", "invalid_url"); continue; }
      if (kind === "note") {
        item.type = "note";
        item.payload = { sections: [{ heading: "原文链接", bullets: [url, ...(desc ? [desc] : [])] }] };
      } else item.payload = { url, desc };
    } else if (type === "prompt") {
      const text = field("text");
      if (typeof text !== "string") { issue("payload.text", text == null ? "missing_value" : "invalid_shape"); continue; }
      if (!text.trim()) { issue("payload.text", "missing_value"); continue; }
      item.payload = { text: text.trim() };
    } else {
      const sections = field("sections");
      if (!Array.isArray(sections)) { issue("payload.sections", sections == null ? "missing_value" : "invalid_shape"); continue; }
      if (!sections.length) { issue("payload.sections", "missing_value"); continue; }
      const cleaned: { heading: string; bullets: string[] }[] = [];
      for (const [sectionIndex, section] of sections.entries()) {
        const sectionField = `payload.sections[${sectionIndex}]`;
        if (!isRecord(section)) { issue(sectionField, "invalid_shape"); continue; }
        if (section.heading != null && typeof section.heading !== "string") issue(`${sectionField}.heading`, "invalid_shape");
        if (section.bullets != null && !Array.isArray(section.bullets)) issue(`${sectionField}.bullets`, "invalid_shape");
        const heading = typeof section.heading === "string" ? section.heading.trim() : "";
        const bullets: string[] = [];
        for (const [bulletIndex, bullet] of (Array.isArray(section.bullets) ? section.bullets : []).entries()) {
          if (typeof bullet !== "string") issue(`${sectionField}.bullets[${bulletIndex}]`, "invalid_shape");
          else if (bullet.trim()) bullets.push(bullet.trim());
        }
        if (!heading && !bullets.length) issue(sectionField, "missing_value");
        cleaned.push({ heading, bullets });
      }
      item.payload = { sections: cleaned };
    }
    if (issues.length === before) out.push(item);
  }
  return { items: out, issues };
}

function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("模型未返回 JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** 单批提取。images 与文中 source_image_index 对应 */
export async function extractBatch(
  meta: { title: string; account: string; publishDate: string; description: string; text: string; url: string },
  images: Buffer[],
  batchOffset: number,
  batchNumber = 1,
): Promise<Extraction> {
  const cfg = loadConfig();
  const seed = cfg.seedTags.join("、");
  const userText = `【文章标题】${meta.title}
【文章链接】${meta.url}
【公众号】${meta.account}   【发布时间】${meta.publishDate || "未知"}
【摘要】${meta.description || "无"}
【文字正文】${meta.text || "（无文字正文，内容都在图片里）"}
【正文图片】共 ${images.length} 张，按顺序编号 ${batchOffset} ~ ${batchOffset + images.length - 1}
【种子标签】${seed}

${SCHEMA_PROMPT}
注意：source_image_index 请使用全局编号（当前批次的图片全局编号已给出）。`;

  const fail = (stage: FailureReport["stage"], issues: FailureIssue[]): never => {
    throw new CollectionFailure({ version: 1, stage, articleTitle: meta.title, batch: batchNumber,
      ...(images.length ? { imageStart: batchOffset + 1, imageEnd: batchOffset + images.length } : {}),
      issues, issueCount: issues.length });
  };
  const raw = await chatVision(SYSTEM, userText, images, { temperature: 0 });
  if (raw.finishReason === "length") fail("model_response", [{ cardIndex: 0, field: "response", code: "truncated" }]);
  let parsed: unknown;
  try { parsed = parseJsonLoose(raw.content); }
  catch { fail("model_response", [{ cardIndex: 0, field: "response", code: "invalid_json" }]); }
  const data = isRecord(parsed) && Array.isArray(parsed.items) ? parsed
    : fail("model_response", [{ cardIndex: 0, field: "items", code: "invalid_shape" }]);
  const metadataIssues: FailureIssue[] = [];
  if (data.article_summary != null && typeof data.article_summary !== "string") {
    metadataIssues.push({ cardIndex: 0, field: "article_summary", code: "invalid_shape" });
  }
  if (data.tags != null && !Array.isArray(data.tags)) metadataIssues.push({ cardIndex: 0, field: "tags", code: "invalid_shape" });
  if (Array.isArray(data.tags)) data.tags.forEach((tag, index) => {
    if (typeof tag !== "string") metadataIssues.push({ cardIndex: 0, field: `tags[${index}]`, code: "invalid_shape" });
  });
  if (metadataIssues.length) fail("model_response", metadataIssues);
  const { items, issues } = clampItems(data.items as unknown[], batchOffset + images.length);
  if (issues.length) fail("card_validation", issues);
  const types: ItemType[] = ["palette", "website", "repo", "prompt", "note"];
  return {
    articleType: types.includes(data.article_type as ItemType) ? (data.article_type as ItemType) : "note",
    articleSummary: typeof data.article_summary === "string" ? data.article_summary.slice(0, 100) : "",
    tags: Array.isArray(data.tags) ? (data.tags as string[]).map(tag => tag.trim()).filter(Boolean).slice(0, 6) : [],
    items,
  };
}

/** 图片多于单次请求上限时按批拆分提取并合并 */
export async function extractCards(
  meta: { title: string; account: string; publishDate: string; description: string; text: string; url: string },
  images: Buffer[],
  batchSize = 8
): Promise<Extraction> {
  // 零证据防线：既无图片也无有效文字时直接返回空，不让模型凭标题编卡片
  if (images.length === 0 && (meta.text || "").length < 50) {
    return { articleType: "note", articleSummary: "", tags: [], items: [] };
  }
  if (images.length === 0) {
    return extractBatch(meta, [], 0);
  }
  const merged: Extraction = { articleType: "note", articleSummary: "", tags: [], items: [] };
  for (let off = 0; off < images.length; off += batchSize) {
    const batch = images.slice(off, off + batchSize);
    const ex = await extractBatch(meta, batch, off, Math.floor(off / batchSize) + 1);
    if (!merged.articleSummary) {
      merged.articleType = ex.articleType;
      merged.articleSummary = ex.articleSummary;
      merged.tags = ex.tags;
    } else {
      merged.tags = [...new Set([...merged.tags, ...ex.tags])].slice(0, 6);
    }
    merged.items.push(...ex.items);
  }
  return merged;
}
