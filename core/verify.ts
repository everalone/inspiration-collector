import sharp from "sharp";

export interface ColorCheck {
  hex: string;
  ok: boolean;
  minDist: number; // 0~441 欧氏距离
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * 用原图像素验证模型抄录的 hex：对每个 hex 计算它与图中采样像素的最小欧氏距离。
 * 阈值 60（0~441）：JPEG 压缩与装饰元素造成的偏差可容忍，抄错颜色则通常差得很远。
 */
export async function verifyPalette(
  colors: { hex: string }[],
  imagePath: string,
  threshold = 60
): Promise<ColorCheck[]> {
  const { data, info } = await sharp(imagePath).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 60_000)));

  const targets = colors.map((c) => hexToRgb(c.hex));
  const minDists = targets.map(() => Infinity);

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const off = (y * width + x) * channels;
      const r = data[off], g = data[off + 1], b = data[off + 2];
      for (let i = 0; i < targets.length; i++) {
        if (minDists[i] === 0) continue;
        const dr = r - targets[i][0], dg = g - targets[i][1], db = b - targets[i][2];
        const d2 = dr * dr + dg * dg + db * db;
        if (d2 < minDists[i] * minDists[i]) {
          minDists[i] = Math.sqrt(d2);
        }
      }
    }
  }
  return colors.map((c, i) => ({ hex: c.hex, ok: minDists[i] <= threshold, minDist: Math.round(minDists[i]) }));
}

export interface UrlCheck {
  url: string;
  status: number | null; // null = 网络层失败
  alive: boolean;        // 404/410 视为失效，反爬 403/999 等视为"存疑但大概率活着"
  note: string;
}

/** 网址探活：HEAD 优先，被拒则降级 GET。部分站点反爬会返回 403/999，不算死链 */
export async function checkUrl(url: string, timeoutMs = 10_000): Promise<UrlCheck> {
  const doFetch = async (method: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method,
        redirect: "follow",
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0" },
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await doFetch("HEAD");
    if ([400, 403, 405, 501].includes(res.status)) {
      try {
        res = await doFetch("GET");
      } catch {
        /* GET 也失败则用 HEAD 的结果 */
      }
    }
    const dead = res.status === 404 || res.status === 410;
    return { url, status: res.status, alive: !dead, note: dead ? "链接已失效(404)" : "" };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
      return { url, status: null, alive: false, note: "域名不存在（疑似 AI 编造的网址）" };
    }
    return { url, status: null, alive: true, note: `无法探活(${msg.includes("abort") ? "超时" : "网络"})，不代表失效` };
  }
}
