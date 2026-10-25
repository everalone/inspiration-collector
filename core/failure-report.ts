export type FailureCode = "invalid_type" | "missing_value" | "invalid_format" | "invalid_url" | "invalid_color" | "invalid_shape" | "invalid_json" | "truncated";
export interface FailureIssue {
  cardIndex: number;
  cardTitle?: string;
  cardType?: string;
  field: string;
  code: FailureCode;
}
export interface FailureReport {
  version: 1;
  stage: "card_validation" | "model_response";
  articleTitle?: string;
  batch?: number;
  imageStart?: number;
  imageEnd?: number;
  issues: FailureIssue[];
  issueCount: number;
}
const reasons: Record<FailureCode, string> = {
  invalid_type: "卡片类型不受支持", missing_value: "缺少必填内容", invalid_format: "格式不正确",
  invalid_url: "不是有效的 HTTP(S) 网址", invalid_color: "不是有效的十六进制颜色",
  invalid_shape: "字段结构不正确", invalid_json: "模型未返回有效 JSON", truncated: "模型输出被截断",
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= 1_000_000;
function clean(value: unknown, limit: number, secrets: string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value;
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[已隐藏]");
  text = text.replace(/\bBearer\s+[^\s<>"']+/gi, "[已隐藏]").replace(/\b(?:sk|sess|token|api[_-]?key)-[A-Za-z0-9_-]{8,}/gi, "[已隐藏]")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\p{Surrogate}/gu, "").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, limit).join("") || undefined;
}
/** Only transport bounded diagnostic metadata, never raw prompts, responses or request headers. */
export function sanitizeFailureReport(value: unknown, secrets: string[] = []): FailureReport | undefined {
  if (!record(value) || value.version !== 1 || !["card_validation", "model_response"].includes(String(value.stage)) || !Array.isArray(value.issues)) return undefined;
  const issues: FailureIssue[] = [];
  for (const item of value.issues.slice(0, 10)) {
    if (!record(item) || !integer(item.cardIndex) || typeof item.code !== "string" || !Object.hasOwn(reasons, item.code) ||
        typeof item.field !== "string" || !/^[A-Za-z_$][A-Za-z0-9_.$\[\]-]{0,99}$/.test(item.field) || secrets.some(secret => secret && String(item.field).includes(secret))) continue;
    issues.push({ cardIndex: item.cardIndex, code: item.code as FailureCode, field: item.field,
      cardTitle: clean(item.cardTitle, 80, secrets),
      cardType: ["palette", "website", "repo", "prompt", "note"].includes(String(item.cardType)) ? String(item.cardType) : undefined });
  }
  if (!issues.length) return undefined;
  return { version: 1, stage: value.stage as FailureReport["stage"], articleTitle: clean(value.articleTitle, 200, secrets),
    ...(integer(value.batch, 1) ? { batch: value.batch } : {}),
    ...(integer(value.imageStart, 1) && integer(value.imageEnd, 1) && value.imageEnd >= value.imageStart ? { imageStart: value.imageStart, imageEnd: value.imageEnd } : {}),
    issues, issueCount: integer(value.issueCount, 1) ? Math.max(value.issueCount, issues.length) : issues.length };
}
export function formatFailureReport(value: FailureReport): string {
  const context = [value.batch ? `第${value.batch}批` : "", value.imageStart ? `原文图片${value.imageStart}–${value.imageEnd}` : ""].filter(Boolean).join("，");
  const details = value.issues.map(issue => `${issue.cardIndex ? `第${issue.cardIndex}张卡` : "响应"}${issue.cardTitle ? `《${issue.cardTitle}》` : ""}${issue.cardType ? `（${issue.cardType}）` : ""}：${issue.field} ${reasons[issue.code]}`);
  return `${value.stage === "card_validation" ? "模型结果包含无效卡片" : "模型响应不合格"}${context ? `（${context}）` : ""}\n${details.join("\n")}${value.issueCount > value.issues.length ? `\n另有${value.issueCount - value.issues.length}项问题` : ""}\n未替换已有内容`;
}
export class CollectionFailure extends Error {
  readonly failureReport: FailureReport;
  constructor(report: FailureReport) {
    const safe = sanitizeFailureReport(report);
    if (!safe) throw new Error("失败报告格式不正确");
    super(formatFailureReport(safe));
    this.name = "CollectionFailure";
    this.failureReport = safe;
  }
}
export function failureReportFromError(error: unknown): FailureReport | undefined {
  return record(error) ? sanitizeFailureReport(error.failureReport) : undefined;
}
