import sharp from "sharp";
import { loadConfig } from "./config.js";

export interface VisionResult {
  content: string;
  finishReason: string;
}

/** 图片 → 压缩后的 data URI（控制 token 消耗） */
export async function toDataUri(image: Buffer, maxDim = 1024, quality = 82): Promise<string> {
  const jpeg = await sharp(image)
    .rotate()
    .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/**
 * 调用 OpenAI 兼容的多模态 chat 接口。
 * images: 原始图片 Buffer 数组，按顺序追加在 user 文本之后。
 */
export async function chatVision(
  system: string,
  userText: string,
  images: Buffer[],
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<VisionResult> {
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error("未配置 API key，请填写 data/config.json 的 apiKey");

  const content: unknown[] = [{ type: "text", text: userText }];
  for (const img of images) {
    content.push({ type: "image_url", image_url: { url: await toDataUri(img) } });
  }

  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content },
    ],
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    temperature: opts.temperature ?? 0.2,
    stream: false,
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300_000);
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        // 限流/服务端错误可重试
        if ([429, 500, 502, 503].includes(res.status)) throw new RetryableError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        throw new Error(`API 错误 HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      const json = JSON.parse(text);
      const msg = json.choices?.[0]?.message;
      const finish = json.choices?.[0]?.finish_reason ?? "";
      const content0: string = msg?.content ?? "";
      if (!content0 && finish === "length") {
        // 推理模型的思考耗尽了输出预算 → 加大预算重试一次
        body.max_tokens = Math.min(body.max_tokens * 2, 32000);
        throw new RetryableError(`输出被截断，max_tokens 已提升至 ${body.max_tokens}`);
      }
      return { content: content0, finishReason: finish };
    } catch (e) {
      if (e instanceof RetryableError) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if ((e as Error).name === "AbortError") {
        lastErr = new Error("请求超时(300s)");
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`API 调用失败（重试3次）: ${lastErr}`);
}

class RetryableError extends Error {}
