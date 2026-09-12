import { chatVision } from "./vision.js";
import { loadConfig } from "./config.js";

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
1. 配色 palette：{"type":"palette","title":"方案名(原文有名字就抄原名)","desc":"原文对这套配色的说明,没有就空字符串","colors":[{"hex":"#AABBCC","name":"色名或省略"}],"source_image_index":N}
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
- 图中或文中没有给出网址时，绝对不要猜测/编造域名——改用 note 卡片记录名称与说明。
- 设计展示图里浏览器窗口装饰性地址栏出现的网址不可信（只是配图）：除 github.com 项目地址外，此类内容的 website 卡 url 改填【文章链接】，desc 写明是风格/案例展示；正文或说明文字中明确推荐的网址照抄。
- 提示词必须逐字完整抄录，不得缩写、意译、省略。
- 图片按顺序编号，第一张 source_image_index=0。
- 同类内容逐项拆分，宁多勿漏；不要编造文章没有的内容。
- 若没有值得收藏的具体内容，items 返回空数组。`;

function normalizeHex(raw: string): string | null {
  let h = raw.trim().replace(/^#*/, "").toUpperCase();
  if (/^[0-9A-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  return /^[0-9A-F]{6}$/.test(h) ? "#" + h : null;
}

function clampItems(raw: unknown, imageCount: number): ExtractedItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedItem[] = [];
  const validTypes: ItemType[] = ["palette", "website", "repo", "prompt", "note"];
  for (const it of raw as Record<string, unknown>[]) {
    const type = it.type as ItemType;
    if (!validTypes.includes(type)) continue;
    const title = String(it.title ?? "").trim() || "未命名";
    const item: ExtractedItem = { type, title };
    const idx = Number(it.source_image_index ?? 0);
    item.source_image_index = Number.isFinite(idx) ? Math.max(0, Math.min(idx, Math.max(0, imageCount - 1))) : 0;
    const bbox = Array.isArray(it.bbox) ? (it.bbox as unknown[]).map(Number) : [];
    item.bbox = bbox.length === 4 && bbox.every((n) => n >= 0 && n <= 1000) ? bbox.map((n) => Math.round(n)) : undefined;

    if (type === "palette") {
      const colors = Array.isArray(it.colors) ? it.colors : [];
      const cleaned = colors
        .map((c): { hex: string; name?: string } | null => {
          const rec = c as Record<string, unknown>;
          const hex = normalizeHex(String(rec?.hex ?? ""));
          return hex ? { hex, name: rec?.name ? String(rec.name) : undefined } : null;
        })
        .filter((c): c is { hex: string; name?: string } => c !== null);
      if (!cleaned.length) continue;
      item.payload = { colors: cleaned, desc: String(it.desc ?? "").trim() };
    } else {
      const p = (it.payload ?? {}) as Record<string, unknown>;
      const payload: ExtractedItem["payload"] = {};
      if (type === "website" || type === "repo") {
        const url = String(p.url ?? "").trim();
        if (!/^https?:\/\//.test(url)) continue;
        payload.url = url;
        payload.desc = String(p.desc ?? "").trim();
      } else if (type === "prompt") {
        const text = String(p.text ?? "").trim();
        if (!text) continue;
        payload.text = text;
      } else {
        const sections = Array.isArray(p.sections) ? p.sections : [];
        const cleaned = sections
          .map((s) => {
            const rec = s as Record<string, unknown>;
            const heading = String(rec?.heading ?? "").trim();
            const bullets = Array.isArray(rec?.bullets)
              ? (rec.bullets as unknown[]).map((b) => String(b).trim()).filter(Boolean)
              : [];
            return heading || bullets.length ? { heading, bullets } : null;
          })
          .filter((s): s is { heading: string; bullets: string[] } => s !== null);
        if (!cleaned.length) continue;
        payload.sections = cleaned;
      }
      item.payload = payload;
    }
    out.push(item);
  }
  return out;
}

function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("模型未返回 JSON:\n" + text.slice(0, 300));
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** 单批提取。images 与文中 source_image_index 对应 */
export async function extractBatch(
  meta: { title: string; account: string; publishDate: string; description: string; text: string; url: string },
  images: Buffer[],
  batchOffset: number
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

  const raw = await chatVision(SYSTEM, userText, images);
  const parsed = parseJsonLoose(raw.content) as Record<string, unknown>;
  const types: ItemType[] = ["palette", "website", "repo", "prompt", "note"];
  return {
    articleType: types.includes(parsed.article_type as ItemType) ? (parsed.article_type as ItemType) : "note",
    articleSummary: String(parsed.article_summary ?? "").slice(0, 100),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean).slice(0, 6) : [],
    items: clampItems(parsed.items, batchOffset + images.length),
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
    const ex = await extractBatch(meta, batch, off);
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
