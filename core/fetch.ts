const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class CaptchaError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CaptchaError";
  }
}

async function once(url: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        ...extraHeaders,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 抓取文章 HTML；被风控时抛 CaptchaError 并提示手动兜底方案 */
export async function fetchHtml(url: string): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await once(url);
      const text = await res.text();
      if (text.includes("环境异常") || text.includes("完成验证后即可继续访问")) {
        throw new CaptchaError("触发微信风控验证页。兜底：在浏览器打开文章 → 右键另存为 HTML → 用 `ingest --offline <保存的html路径>` 解析。");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return text;
    } catch (e) {
      if (e instanceof CaptchaError) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`抓取失败（重试3次）: ${lastErr}`);
}

const EXT_BY_FMT: Record<string, string> = {
  jpeg: "jpg", jpg: "jpg", png: "png", gif: "gif", webp: "webp", svg: "svg", other: "jpg",
};

export function extFromWxFmt(url: string): string {
  try {
    const fmt = new URL(url).searchParams.get("wx_fmt")?.toLowerCase() ?? "jpeg";
    return EXT_BY_FMT[fmt] ?? "jpg";
  } catch {
    return "jpg";
  }
}

/** 下载正文图片（mmbiz CDN 匿名可访问） */
export async function downloadImage(url: string, dest: string): Promise<void> {
  const res = await once(url, { Referer: "https://mp.weixin.qq.com/" });
  if (!res.ok) throw new Error(`图片下载 HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error(`图片过小(${buf.length}B)，疑似失败: ${url}`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(dest, buf);
}
