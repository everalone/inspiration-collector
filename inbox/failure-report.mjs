/** Strict, bounded failure summaries. Raw model/API output is never copied. */
const STAGES = new Set(['card_validation', 'model_response']);
const TYPES = new Set(['palette', 'website', 'repo', 'prompt', 'note']);
const CODES = new Set(['invalid_type', 'missing_value', 'invalid_format', 'invalid_url',
  'invalid_color', 'invalid_shape', 'invalid_json', 'truncated']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const fieldPattern = /^(?:\$|[A-Za-z_][A-Za-z0-9_-]*)(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[(?:0|[1-9][0-9]{0,5})\])*$/;

function title(value, max, secrets) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 16_384) return undefined;
  let safe = value;
  for (const secret of secrets) safe = safe.split(secret).join('[已隐藏]');
  safe = safe.replace(/\bBearer\s+[^\s<>"']+/gi, '[已隐藏]')
    .replace(/\b(?:sk|sess|token|api[_-]?key)-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\p{Surrogate}/gu, '').replace(/\s+/gu, ' ').trim();
  return Array.from(safe).slice(0, max).join('').trim() || undefined;
}

export function sanitizeFailureReport(input, secrets = []) {
  try {
    if (!isRecord(input) || input.version !== 1 || !STAGES.has(input.stage) || !Array.isArray(input.issues)) return null;
    const privateValues = Array.isArray(secrets) ? secrets.filter(value => typeof value === 'string' && value.length > 0 &&
      Buffer.byteLength(value) <= 65_536).slice(0, 64) : [];
    const issues = [];
    // Both input inspection and the returned summary are bounded. Skip invalid
    // issues instead of accepting arbitrary exception fields or raw responses.
    for (const item of input.issues.slice(0, 100)) {
      if (!isRecord(item) || !integer(item.cardIndex, 0, 100_000) || !CODES.has(item.code) ||
          typeof item.field !== 'string' || item.field.length > 120 || !fieldPattern.test(item.field) ||
          privateValues.some(secret => item.field.includes(secret))) continue;
      const issue = { cardIndex: item.cardIndex, field: item.field, code: item.code };
      const cardTitle = title(item.cardTitle, 80, privateValues);
      if (cardTitle) issue.cardTitle = cardTitle;
      if (TYPES.has(item.cardType)) issue.cardType = item.cardType;
      issues.push(issue);
      if (issues.length === 10) break;
    }
    if (!issues.length) return null;
    const report = { version: 1, stage: input.stage, issues,
      issueCount: Math.max(issues.length, integer(input.issueCount, 1, 100_000) ? input.issueCount : Math.min(input.issues.length, 100_000)) };
    const articleTitle = title(input.articleTitle, 200, privateValues);
    if (articleTitle) report.articleTitle = articleTitle;
    if (integer(input.batch, 1, 10_000)) report.batch = input.batch;
    if (integer(input.imageStart, 1, 100_000)) report.imageStart = input.imageStart;
    if (integer(input.imageEnd, report.imageStart ?? 1, 100_000)) report.imageEnd = input.imageEnd;
    return report;
  } catch { return null; }
}

export function formatFailureReport(input) {
  const report = sanitizeFailureReport(input);
  if (!report) return '分析失败（未提供结构化报告）';
  const descriptions = { invalid_type: '类型不符合要求', missing_value: '缺少必填内容',
    invalid_format: '格式不符合要求', invalid_url: '链接格式无效', invalid_color: '颜色值无效',
    invalid_shape: '数据结构不符合要求', invalid_json: '模型返回的 JSON 无法解析', truncated: '模型返回内容被截断' };
  const typeNames = { palette: '配色', website: '网站', repo: '代码仓库', prompt: '提示词', note: '笔记' };
  const lines = [];
  const location = [report.batch ? `第 ${report.batch} 批` : '', report.imageStart ?
    `图片 ${report.imageStart}${report.imageEnd && report.imageEnd !== report.imageStart ? `–${report.imageEnd}` : ''}` : ''].filter(Boolean).join('，');
  if (location) lines.push(`${location}：`);
  for (const issue of report.issues) {
    const item = issue.cardIndex ? `第 ${issue.cardIndex} 张卡片${issue.cardTitle ? `《${issue.cardTitle}》` : ''}` : '模型响应';
    lines.push(`${item}${issue.cardType ? `（${typeNames[issue.cardType]}）` : ''}：${issue.field} — ${descriptions[issue.code]}。`);
  }
  if (report.issueCount > report.issues.length) lines.push(`共 ${report.issueCount} 个问题，以上显示前 ${report.issues.length} 个。`);
  return Array.from(lines.join('\n')).slice(0, 2_200).join('');
}
