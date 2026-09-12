import * as cheerio from "cheerio";
import crypto from "node:crypto";

export interface ArticleMeta {
  id: string;
  url: string;
  title: string;
  account: string;
  publishDate: string;
  description: string;
  text: string;
  images: string[]; // 原始图片地址，按正文顺序
}

export function articleIdFromUrl(url: string): string {
  const m = url.match(/mp\.weixin\.qq\.com\/s\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const biz = url.match(/__biz=([\w=]+)/)?.[1];
  const sn = url.match(/sn=([\w=]+)/)?.[1];
  if (biz && sn) return `biz_${biz}_${sn}`.replace(/[^\w-]/g, "");
  return "u_" + crypto.createHash("md5").update(url).digest("hex").slice(0, 12);
}

export function normalizeImageUrl(u: string): string {
  return u.startsWith("//") ? "https:" + u : u;
}

/** 从新版"图片消息"页面提取轮播图：picture_page_info_list 是全部 slide 的列表，逐条收集 */
function extractCarouselImages(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/picture_page_info_list:\s*\[/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < html.length && depth > 0) {
      const c = html[i];
      if (c === "[") depth++;
      else if (c === "]") depth--;
      i++;
    }
    const block = html.slice(m.index + m[0].length, i - 1);

    // 顶层 { } 对象（含嵌套但按括号配平切割），每条是一个 slide
    let d = 0, start = -1;
    for (let j = 0; j < block.length; j++) {
      const c = block[j];
      if (c === "{") { if (d === 0) start = j; d++; }
      else if (c === "}") { d--; if (d === 0 && start >= 0) {
        const entry = block.slice(start, j + 1);
        start = -1;
        const url = entry.match(/cdn_url:\s*'((?:https?:)?\/\/mmbiz\.qpic\.cn\/[^']+)'/)?.[1];
        if (url) {
          const u = normalizeImageUrl(url).replace(/^http:\/\//, "https://");
          if (!out.includes(u)) out.push(u);
        }
      } }
    }
  }
  return out;
}

/** 解码 meta/og 标签里的 JS 转义(\n、\xNN)与 HTML 实体 */
function unescapeMeta(s: string): string {
  const out = s
    .replace(/\\n/g, "\n")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return cheerio.load(`<textarea>${out}</textarea>`).text().replace(/\u00a0/g, " ").trim();
}

export function parseArticle(html: string, url: string): ArticleMeta {
  const $ = cheerio.load(html);

  let title = unescapeMeta(
    $("#activity-name").text().trim() ||
    $('meta[property="og:title"]').attr("content") ||
    "未知标题"
  ).trim();

  const account = unescapeMeta(
    $("#js_name").text().trim() ||
    html.match(/var nickname = "([^"]+)"/)?.[1] ||
    html.match(/nick_name:\s*'([^']+)'/)?.[1] ||
    html.match(/nickname:\s*'([^']+)'/)?.[1] ||
    "未知公众号"
  ).trim();

  const tsMatch = html.match(/create_time['"]?\s*[:=]\s*'?(1[0-9]{9})/);
  const createTimeStr = html.match(/create_time:\s*'([^']+)'/)?.[1] ?? "";
  const publishDate =
    $("#publish_time").text().trim() ||
    (createTimeStr || (tsMatch ? new Date(Number(tsMatch[1]) * 1000).toISOString().slice(0, 10) : ""));

  const description = unescapeMeta($('meta[name="description"]').attr("content") ?? "");

  // 传统图文格式：#js_content 里有文字和 <img data-src>
  let text = $("#js_content").text().replace(/[ \t]+/g, " ").trim();
  const images: string[] = [];
  $("#js_content").find("img").each((_, el) => {
    const raw = $(el).attr("data-src") || $(el).attr("src") || "";
    const u = normalizeImageUrl(raw);
    if (u.includes("mmbiz.qpic.cn") && !images.includes(u)) images.push(u);
  });

  // 新版"图片消息"格式（轮播图）：每个 slide 的 picture_page_info_list 里有若干尺寸变体，
  // 取 width 最大的那条作为该 slide 的图；文字在 meta description。
  if (images.length === 0) images.push(...extractCarouselImages(html));
  if (text.length === 0 && description) {
    text = description.replace(/\s*\n\s*/g, " ").slice(0, 6000);
  }

  // "标题即正文"型文章（纯文字消息）：第一行是标题，其余是正文
  if (text.length === 0 && title.includes("\n")) {
    const lines = title.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      title = lines[0];
      text = lines.slice(1).join("\n").replace(/\s+/g, " ").slice(0, 6000);
    }
  }

  return { id: articleIdFromUrl(url), url, title, account, publishDate, description, text, images };
}
