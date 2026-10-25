/**
 * Bounded article-title lookup and owner-only Weixin notifications.
 * Wire format follows Tencent/openclaw-weixin 2.4.10 api/api.ts,
 * api/types.ts and messaging/send.ts. No model or HTML script execution.
 */
import { randomBytes } from 'node:crypto';
import { sanitizeFailureReport, formatFailureReport } from './failure-report.mjs';

const VERSION = '2.4.10';
const isText = (value, max) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max;
const error = code => Object.assign(new Error(code), { code });

function titleText(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return normalized ? Array.from(normalized).slice(0, 120).join('') : null;
}

export function queuedText(title) {
  const name = titleText(title);
  return name ? `已收到链接：本篇名为《${name}》，已加入队列。` : '已收到链接，已加入队列。';
}

export function finishedText(title) {
  const name = titleText(title);
  return name ? `《${name}》已解析成功并导入灵感收集。` : '文章已解析成功并导入灵感收集。';
}

export function failedText(title, options = {}) {
  // Only the structured allowlisted report reaches the notification. Older
  // callers' raw error strings and unknown metadata are deliberately ignored.
  const { failureReport, attempts, maxAttempts, secrets = [] } = options && typeof options === 'object' ? options : {};
  const report = sanitizeFailureReport(failureReport, secrets);
  let safeTitle = typeof title === 'string' && Buffer.byteLength(title) <= 16384 ? title : null;
  if (safeTitle) {
    for (const secret of (Array.isArray(secrets) ? secrets : []).slice(0, 64)) {
      if (typeof secret === 'string' && secret && Buffer.byteLength(secret) <= 65536) safeTitle = safeTitle.split(secret).join('[已隐藏]');
    }
    safeTitle = safeTitle.replace(/\bBearer\s+[^\s<>"']+/gi, '[已隐藏]')
      .replace(/\b(?:sk|sess|token|api[_-]?key)-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]');
  }
  const name = titleText(safeTitle) ?? titleText(report?.articleTitle);
  const count = Number.isSafeInteger(attempts) && attempts > 0;
  const limit = Number.isSafeInteger(maxAttempts) && maxAttempts > 0 && maxAttempts >= attempts;
  const tried = count ? `已尝试${attempts}${limit ? `/${maxAttempts}` : ''}次，` : '';
  const detail = report ? Array.from(formatFailureReport(report)).slice(0, 2200).join('') : '未提供结构化诊断，具体原因请在电脑端查看。';
  return Array.from(`${name ? `《${name}》` : '文章'}收集失败：${tried}已停止自动重试。\n${detail}\n请在电脑端查看，修正后可手动重新排队。`).slice(0, 2500).join('');
}

function checkedArticleUrl(value) {
  if (!isText(value, 8192) || !/^https:\/\/mp\.weixin\.qq\.com\//.test(value) ||
      /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.username || url.password || url.port) return null;
    if (!(/^\/s\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) ||
      (url.pathname === '/s' && url.searchParams.get('__biz')?.trim() && url.searchParams.get('sn')?.trim()))) return null;
    return url.href;
  } catch { return null; }
}

function decodeEntities(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–', middot: '·' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
    const point = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
  });
}

function extractTitle(html) {
  // Script and comment contents are not document metadata.
  const source = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const candidates = [];
  for (const meta of source.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = {};
    for (const attr of meta[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4];
    }
    if ((attrs.property ?? attrs.name)?.toLowerCase() === 'og:title' && attrs.content) candidates.push(attrs.content);
  }
  const documentTitle = source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  if (documentTitle) candidates.push(documentTitle);
  const normalize = value => titleText(decodeEntities(value).replace(/<[^>]*>/g, ''));
  const verificationTitle = /^(?:微信公众平台|微信公众平台安全验证|微信安全|访问验证|安全验证|环境异常|请完成验证|请在微信客户端打开链接|WeChat|Weixin Official Accounts Platform)$/i;
  // These forms identify a challenge page, without rejecting articles that
  // merely discuss verification in their prose or scripts.
  if (candidates.some(value => /^(?:环境异常|安全验证|访问验证)/.test(normalize(value) ?? '')) ||
      /<(?:form|div)\b[^>]*\bid\s*=\s*["'](?:js_verify|verify_container|captcha)["']/i.test(source)) return null;
  for (const candidate of candidates) {
    const title = normalize(candidate);
    if (title && !verificationTitle.test(title)) return title;
  }
  return null;
}

async function withDeadline(task, externalSignal, timeoutMs) {
  if (externalSignal?.aborted) throw error('request_aborted');
  const controller = new AbortController();
  let timer;
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => { controller.abort(); reject(error('request_aborted')); };
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(error('request_timeout')); }, timeoutMs);
  });
  try {
    return await Promise.race([task(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}

async function limitedText(response, maxBytes, signal) {
  if (Number(response.headers?.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw error('response_too_large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks = [];
  let bytes = 0;
  try {
    if (signal.aborted) throw error('request_aborted');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { abort(); throw error('response_too_large'); }
      chunks.push(Buffer.from(value));
    }
    if (signal.aborted) throw error('request_aborted');
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export async function fetchArticleTitle(value, { fetchImpl = fetch, signal, timeoutMs = 2500, maxBytes = 512 * 1024 } = {}) {
  const url = checkedArticleUrl(value);
  if (!url || typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
  try {
    return await withDeadline(async requestSignal => {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: requestSignal,
        headers: { Accept: 'text/html,application/xhtml+xml' } });
      if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); return null; }
      const type = response.headers?.get('content-type');
      if (type && !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type)) {
        void response.body?.cancel().catch(() => {}); return null;
      }
      return extractTitle(await limitedText(response, maxBytes, requestSignal));
    }, signal, timeoutMs);
  } catch { return null; }
}

function checkedAccount(account) {
  if (!account || typeof account !== 'object' || !isText(account.token, 8192) || /[\s\u0000-\u001f\u007f]/.test(account.token) ||
      !isText(account.owner, 1024) || !isText(account.bot, 1024) || /[\u0000-\u001f\u007f]/.test(account.owner + account.bot)) {
    throw error('invalid_account');
  }
  // Checking the raw authority also rejects :443, which URL normalizes away.
  if (typeof account.base !== 'string' || !/^https:\/\/(?:[a-z0-9-]+\.)*weixin\.qq\.com\/?$/i.test(account.base)) {
    throw error('invalid_account_origin');
  }
  const url = new URL(account.base);
  if (url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw error('invalid_account_origin');
  return url.origin;
}

export async function sendWechatText({ account, contextToken, text, clientId, fetchImpl = fetch, signal }) {
  const base = checkedAccount(account);
  if (!isText(contextToken, 65536)) throw error('missing_context_token');
  if (!isText(text, 16000) || !isText(clientId, 128) || !/^[A-Za-z0-9_.:-]+$/.test(clientId) || typeof fetchImpl !== 'function') {
    throw error('invalid_message');
  }
  try {
    await withDeadline(async requestSignal => {
      const response = await fetchImpl(`${base}/ilink/bot/sendmessage`, {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
          Authorization: `Bearer ${account.token}`, 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
          'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10) },
        body: JSON.stringify({ msg: { from_user_id: '', to_user_id: account.owner, client_id: clientId,
          message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text } }], context_token: contextToken },
          base_info: { channel_version: VERSION, bot_agent: 'InspirationCollector/0.2.0' } })
      });
      if (!response.ok || response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw error(response.status === 401 || response.status === 403 ? 'auth_required' : 'send_http_error');
      }
      let result;
      try { result = JSON.parse(await limitedText(response, 64 * 1024, requestSignal)); }
      catch (cause) { if (cause?.code) throw cause; throw error('send_invalid_response'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw error('send_invalid_response');
      if (result.ret === -14 || result.errcode === -14) throw error('auth_required');
      if ((result.ret !== undefined && result.ret !== 0) || (result.errcode !== undefined && result.errcode !== 0)) throw error('send_rejected');
    }, signal, 15000);
  } catch (cause) {
    const codes = new Set(['auth_required', 'send_http_error', 'send_invalid_response', 'send_rejected', 'response_too_large', 'request_timeout', 'request_aborted']);
    throw error(codes.has(cause?.code) ? cause.code : 'send_network_error');
  }
}
