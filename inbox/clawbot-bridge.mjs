#!/usr/bin/env node
/**
 * Personal ClawBot text-link inbox bridge. No model, tools or media handling.
 * Sends fixed queue/completion receipts only to the bound account owner.
 * Protocol: Tencent/openclaw-weixin, api/types.ts and api/api.ts (2.4.10).
 * Required: CLAWBOT_ACCOUNT_FILE, CLAWBOT_DATA, INBOX_TOKEN.
 * Optional: INBOX_URL (default http://127.0.0.1:8787).
 * state.json is private; status.json and stdout contain counters/error codes only.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchArticleTitle, sendWechatText, queuedText, finishedText, failedText } from './clawbot-messages.mjs';
import { sanitizeFailureReport } from './failure-report.mjs';

const VERSION = '2.4.10';
const LIMIT = Object.freeze({ response: 2_000_000, state: 8_000_000, cursor: 256_000,
  text: 64_000, url: 8_192, context: 16_384, pending: 1_000, tracking: 1_000, seen: 4_096, messages: 1_000 });
const hash = value => createHash('sha256').update(value).digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value, max, empty = false) => typeof value === 'string' &&
  (empty || value.length > 0) && Buffer.byteLength(value) <= max;

function checkedTitle(value) {
  // Titles from a status response are data, not instructions. Reject malformed
  // values rather than allowing one row to invalidate the durable batch.
  if (!boundedString(value, 2_048) || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/.test(value)) return null;
  return value.replace(/\s+/g, ' ').trim() || null;
}

export class BridgeError extends Error {
  constructor(code, fatal = false) { super(code); this.code = code; this.fatal = fatal; }
}

export function checkedBase(value) {
  try {
    // Check the raw authority too: URL.port normalizes an explicit :443 to "".
    if (typeof value !== 'string' || !/^https:\/\/(?:[a-z0-9-]+\.)*weixin\.qq\.com\/?$/i.test(value)) throw 0;
    const u = new URL(value);
    if (u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash) throw 0;
    return u.origin;
  } catch { throw new BridgeError('invalid_account_origin', true); }
}

export function checkedInbox(value) {
  try {
    const u = new URL(value);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) ||
        u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw 0;
    return u.origin;
  } catch { throw new BridgeError('invalid_inbox_origin', true); }
}

function checkedAccount(account) {
  if (!isRecord(account) || !boundedString(account.token, 8_192) || /[\s\u0000-\u001f]/.test(account.token) ||
      !boundedString(account.owner, 1_024) || !boundedString(account.bot, 1_024)) {
    throw new BridgeError('invalid_account', true);
  }
  return { token: account.token, owner: account.owner, bot: account.bot, base: checkedBase(account.base) };
}

export function isArticleUrl(value) {
  if (!boundedString(value, LIMIT.url) || !/^https:\/\/mp\.weixin\.qq\.com\//.test(value) ||
      /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const u = new URL(value);
    const rawPath = value.slice('https://mp.weixin.qq.com'.length).split(/[?#]/, 1)[0];
    return u.protocol === 'https:' && u.hostname === 'mp.weixin.qq.com' && !u.username && !u.password && !u.port &&
      rawPath === u.pathname && (/^\/s\/[A-Za-z0-9_-]+\/?$/.test(rawPath) ||
       (rawPath === '/s' && !!u.searchParams.get('__biz')?.trim() && !!u.searchParams.get('sn')?.trim()));
  } catch { return false; }
}

export function extractArticleUrls(text) {
  if (!boundedString(text, LIMIT.text, true)) return [];
  const links = new Set();
  const normalized = text.replaceAll('&amp;', '&');
  // Match complete URLs before checking the host, so a URL embedded in an evil
  // host's query/path is not mistaken for a separately supplied article URL.
  for (const match of normalized.matchAll(/https?:\/\/[^\s<>"'`\\\u3000-\u303f\uff00-\uffef]+/gi)) {
    if (match.index > 0 && /[\w:/?=&%+.-]/.test(normalized[match.index - 1])) continue;
    const candidate = match[0].replace(/[)\]}.,;!?:]+$/g, '');
    if (!isArticleUrl(candidate)) continue;
    const u = new URL(candidate);
    u.hash = ''; // Weixin's #rd is a browser anchor, not a different article.
    links.add(u.href);
  }
  return [...links];
}

export function acceptedMessage(message, account) {
  if (!isRecord(message) || message.message_type !== 1 || message.message_state !== 2 ||
      message.from_user_id !== account.owner || message.group_id || message.delete_time_ms ||
      (message.to_user_id && message.to_user_id !== account.bot) || message.ref_msg ||
      !Array.isArray(message.item_list) || !message.item_list.length || message.item_list.length > 100) return null;
  // A quoted message or a mixed media message is ignored as a whole. Only the
  // current owner's plain text is considered; nested content is never traversed.
  if (message.item_list.some(item => !isRecord(item) || item.type !== 1 || item.ref_msg ||
      !isRecord(item.text_item) || !boundedString(item.text_item.text, LIMIT.text, true))) return null;
  const text = message.item_list.map(item => item.text_item.text).join('\n');
  if (!boundedString(text, LIMIT.text, true) || /^\s*[!/\uFF01>]/m.test(text)) return null;
  const urls = extractArticleUrls(text);
  const id = message.message_id ?? message.client_id;
  // Hash identifiers before persistence. If no identifier exists, stable text +
  // timestamp hashing still suppresses repeated deliveries without storing text.
  const identity = typeof id === 'string' && id ? ['id', id] :
    ['fallback', message.create_time_ms ?? null, message.seq ?? null, text];
  const contextToken = boundedString(message.context_token, LIMIT.context) ? message.context_token : '';
  return { key: hash(JSON.stringify([account.owner, account.bot, ...identity])), urls, contextToken };
}

export function createInitialState(cursor = '') {
  if (!boundedString(cursor, LIMIT.cursor, true)) throw new BridgeError('invalid_cursor', true);
  return { version: 1, accountHash: '', cursor, pending: [], tracking: [], seen: [], received: 0, submitted: 0,
    lastPoll: null, lastCollect: null };
}

function validState(state) {
  const counter = value => Number.isSafeInteger(value) && value >= 0;
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const timestamp = value => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
  return isRecord(state) && state.version === 1 && (state.accountHash === '' || digest(state.accountHash)) &&
    boundedString(state.cursor, LIMIT.cursor, true) && Array.isArray(state.pending) && state.pending.length <= LIMIT.pending &&
    state.pending.every(item => isRecord(item) && digest(item.key) && isArticleUrl(item.url) &&
      boundedString(item.contextToken, LIMIT.context, true)) &&
    Array.isArray(state.tracking) && state.tracking.length <= LIMIT.tracking && state.tracking.every(item =>
      isRecord(item) && digest(item.key) && digest(item.trackingId) && isArticleUrl(item.url) &&
      boundedString(item.inboxItemId, 1_024) && boundedString(item.contextToken, LIMIT.context, true) &&
      typeof item.titleChecked === 'boolean' && (item.title === null || boundedString(item.title, 2_048, true)) &&
      typeof item.queuedNoticeSent === 'boolean' && ['pending', 'done', 'failed'].includes(item.lastStatus) &&
      (item.failureReport === undefined || item.failureReport === null || isRecord(item.failureReport)) &&
      (item.attempts === undefined || item.attempts === null || counter(item.attempts)) &&
      (item.maxAttempts === undefined || item.maxAttempts === null || (counter(item.maxAttempts) && item.maxAttempts > 0)) &&
      counter(item.notifyAttempts) && counter(item.nextNotifyAt) && counter(item.statusAttempts) && counter(item.nextStatusAt) &&
      (item.lastNoticeError === null || /^[a-z_0-9]+$/.test(item.lastNoticeError))) &&
    Array.isArray(state.seen) && state.seen.length <= LIMIT.seen && state.seen.every(digest) &&
    counter(state.received) && counter(state.submitted) && timestamp(state.lastPoll) && timestamp(state.lastCollect);
}

async function readJson(file, max, errorCode) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    if ((await handle.stat()).size > max) throw new BridgeError(errorCode, true);
    const data = await handle.readFile('utf8');
    if (Buffer.byteLength(data) > max) throw new BridgeError(errorCode, true);
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw new BridgeError(errorCode, true);
  } finally { await handle?.close(); }
}

export async function atomicWriteJson(file, value, max = LIMIT.state) {
  const data = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(data) > max) throw new BridgeError('state_capacity', true);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.rename(temporary, file);
    // Persist the rename across a power failure on the deployed Linux host.
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('storage_error', true);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw new BridgeError('storage_error', true); });
  }
}

async function acquireLock(directory) {
  const file = path.join(directory, 'bridge.lock');
  const recoveryFile = path.join(directory, 'bridge-recovery.lock');
  const marker = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(marker); await handle.sync(); } finally { await handle.close(); }
      return async () => {
        if ((await fs.readFile(file, 'utf8').catch(() => '')) === marker) await fs.unlink(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw new BridgeError('storage_error', true);
      // A separate exclusive recovery lock serializes stale-lock reclamation.
      // This avoids two restarting processes both unlinking a newly held lock.
      let recovery;
      try {
        recovery = await fs.open(recoveryFile, 'wx', 0o600);
        const previous = await fs.readFile(file, 'utf8').catch(() => '');
        if (!previous) continue; // Another clean shutdown may just have removed it.
        const pid = Number(previous.split(':')[0]);
        if (!Number.isSafeInteger(pid) || pid < 1) throw new BridgeError('invalid_lock', true);
        try { process.kill(pid, 0); throw new BridgeError('already_running', true); }
        catch (probe) { if (probe.code !== 'ESRCH') throw new BridgeError('already_running', true); }
        await fs.unlink(file);
      } catch (recoveryError) {
        if (recoveryError instanceof BridgeError) throw recoveryError;
        throw new BridgeError(recoveryError.code === 'EEXIST' ? 'already_running' : 'storage_error', true);
      } finally {
        if (recovery) { await recovery.close(); await fs.unlink(recoveryFile); }
      }
    }
  }
  throw new BridgeError('already_running', true);
}

async function responseJson(response, label, max) {
  if (!response.ok) { await response.body?.cancel(); throw new BridgeError(`${label}_http_${response.status}`); }
  const declared = Number(response.headers.get('content-length'));
  if (declared > max) { await response.body?.cancel(); throw new BridgeError(`${label}_response_size`); }
  const reader = response.body?.getReader();
  if (!reader) throw new BridgeError(`${label}_response_invalid`);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new BridgeError(`${label}_response_size`); }
      chunks.push(Buffer.from(value));
    }
    // Node 22's reviver source preserves uint64 message IDs without a lossy
    // Number conversion. Reject unsafe numeric IDs if run on an older runtime.
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, value, context) => {
      if (key === 'message_id' && typeof value === 'number') {
        if (context?.source && /^\d+$/.test(context.source)) return context.source;
        if (Number.isSafeInteger(value)) return String(value);
        throw new BridgeError(`${label}_response_invalid`);
      }
      return value;
    });
    if (!isRecord(result)) throw 0;
    return result;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(`${label}_response_invalid`);
  } finally { reader.releaseLock(); }
}

async function requestJson(fetchImpl, url, body, headers, { label, timeout, signal, max = LIMIT.response, method = 'POST' }) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  try {
    const response = await fetchImpl(url, { method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal });
    return await responseJson(response, label, max);
  } catch (error) {
    if (signal?.aborted) throw new BridgeError('stopped');
    if (timeoutSignal.aborted) throw new BridgeError(`${label}_timeout`);
    if (error instanceof BridgeError) throw error;
    // Fetch errors can contain request URLs and credentials: never forward them.
    throw new BridgeError(`${label}_network`);
  }
}

export async function createBridge({ account, dataDir, inboxUrl = 'http://127.0.0.1:8787', inboxToken,
  fetchImpl = fetch, logger = line => console.log(line), now = () => new Date().toISOString(),
  fetchTitle = fetchArticleTitle, sendNotice = sendWechatText }) {
  account = checkedAccount(account);
  inboxUrl = checkedInbox(inboxUrl);
  if (!boundedString(inboxToken, 8_192) || /[\s\u0000-\u001f]/.test(inboxToken) || !dataDir) {
    throw new BridgeError('invalid_config', true);
  }
  dataDir = path.resolve(dataDir);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const release = await acquireLock(dataDir);
  const stateFile = path.join(dataDir, 'state.json');
  const statusFile = path.join(dataDir, 'status.json');
  const accountHash = hash(JSON.stringify([account.owner, account.bot, account.base]));
  let state;
  try {
    try { state = await readJson(stateFile, LIMIT.state, 'invalid_state'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = createInitialState(); }
    if (!validState(state)) throw new BridgeError('invalid_state', true);
    if (state.accountHash && state.accountHash !== accountHash) throw new BridgeError('account_state_mismatch', true);
    // Optional fields keep older durable states readable. Re-sanitize saved
    // reports with this account's secrets before any notification is retried.
    state = { ...state, accountHash, tracking: state.tracking.map(item => ({ ...item,
      failureReport: sanitizeFailureReport(item.failureReport, [account.token, inboxToken, item.contextToken]),
      attempts: item.attempts ?? null, maxAttempts: item.maxAttempts ?? null })) };
    await atomicWriteJson(stateFile, state);
  } catch (error) { await release(); throw error; }
  let closed = false, busy = false, phase = 'ready', lastErrorCode = null;
  let lastLogged = '';
  async function status(nextPhase = phase, code = null) {
    phase = nextPhase; lastErrorCode = code;
    const safe = { phase, lastPoll: state.lastPoll, lastCollect: state.lastCollect,
      pending: state.pending.length, received: state.received, submitted: state.submitted,
      awaitingCompletion: state.tracking.length,
      lastErrorCode: lastErrorCode ?? state.tracking.find(item => item.lastNoticeError)?.lastNoticeError ?? null };
    await atomicWriteJson(statusFile, safe, 4_096);
    // Avoid a log line every empty long poll. status.json remains current.
    const event = JSON.stringify({ phase, pending: safe.pending, received: safe.received, submitted: safe.submitted,
      awaitingCompletion: safe.awaitingCompletion, lastErrorCode: safe.lastErrorCode });
    if (event !== lastLogged) { logger(event); lastLogged = event; }
    return safe;
  }
  async function commit(next) {
    if (!validState(next)) throw new BridgeError('state_capacity', true);
    await atomicWriteJson(stateFile, next);
    state = next;
  }
  async function flush(signal) {
    while (state.pending.length && !signal?.aborted) {
      const item = state.pending[0];
      if (state.tracking.length >= LIMIT.tracking) throw new BridgeError('tracking_capacity', true);
      const result = await requestJson(fetchImpl, `${inboxUrl}/collect`, { url: item.url },
        { Authorization: `Bearer ${inboxToken}` }, { label: 'inbox', timeout: 15_000, signal, max: 64_000 });
      if (!['queued', 'duplicate', 'failed'].includes(result.status) || !boundedString(result.id, 1_024)) {
        throw new BridgeError('inbox_response_invalid');
      }
      // An uncertain POST is replayed. The inbox's existing URL dedupe closes
      // the window between a successful POST and this durable local commit.
      const trackingId = hash(`${item.key}\u0000${item.url}`);
      const tracking = [...state.tracking, { ...item, trackingId, inboxItemId: result.id, title: null, titleChecked: false,
        // A repeated share of a terminal failure does not requeue it. Suppress
        // the queue receipt and read /status for its final diagnostic report.
        queuedNoticeSent: result.status === 'failed', lastStatus: 'pending', notifyAttempts: 0, nextNotifyAt: 0,
        failureReport: null, attempts: null, maxAttempts: null,
        statusAttempts: 0, nextStatusAt: 0, lastNoticeError: null }];
      await commit({ ...state, pending: state.pending.slice(1), tracking, submitted: state.submitted + 1, lastCollect: now() });
      await status('listening');
    }
  }
  const clock = () => Date.parse(now());
  const notificationBackoff = attempts => Math.min(15 * 60_000, 2_000 * 2 ** Math.min(attempts - 1, 9));
  async function updateTracking(id, patch) {
    const tracking = state.tracking.map(item => item.trackingId === id ? { ...item, ...patch } : item);
    await commit({ ...state, tracking });
  }
  async function notifications(signal) {
    if (!state.tracking.length || signal?.aborted) return;
    // Rotate by next check time, so older pending analyses do not starve newer
    // items. Query at most 20 IDs per tick and never trigger analysis ourselves.
    const due = state.tracking.filter(item => item.lastStatus === 'pending' && item.nextStatusAt <= clock())
      .sort((a, b) => a.nextStatusAt - b.nextStatusAt).slice(0, 20);
    if (due.length) {
      const ids = [...new Set(due.map(item => item.inboxItemId))];
      try {
        const result = await requestJson(fetchImpl, `${inboxUrl}/status?ids=${encodeURIComponent(ids.join(','))}`,
          undefined, { Authorization: `Bearer ${inboxToken}` },
          // Up to 20 rows can each contain a bounded diagnostic report.
          { label: 'inbox_status', timeout: 15_000, max: 512_000, signal, method: 'GET' });
        if (!Array.isArray(result.items) || !Array.isArray(result.missing) ||
            result.items.some(row => !isRecord(row) || !ids.includes(row.id) || !['pending', 'done', 'failed'].includes(row.status)) ||
            result.missing.some(id => !ids.includes(id)) ||
            ids.some(id => !result.items.some(row => row.id === id) && !result.missing.includes(id))) {
          throw new BridgeError('inbox_status_response_invalid');
        }
        const updates = new Map();
        for (const item of due) {
          const remote = result.items.find(row => row?.id === item.inboxItemId);
          const terminal = remote?.status === 'done' && remote.ok === true ? 'done' : remote?.status === 'failed' ? 'failed' : 'pending';
          // The desktop's successful parse is authoritative. Persist this title
          // before sending so a failed notification/restart retains the name.
          const parsedTitle = terminal === 'done' ? checkedTitle(remote.title) : null;
          const failureReport = terminal === 'failed' ? sanitizeFailureReport(remote.failureReport,
            [account.token, inboxToken, item.contextToken]) : null;
          const failedTitle = terminal === 'failed' ? checkedTitle(failureReport?.articleTitle) : null;
          const attempts = Number.isSafeInteger(remote?.attempts) && remote.attempts >= 0 ? remote.attempts : null;
          const maxAttempts = Number.isSafeInteger(remote?.maxAttempts) && remote.maxAttempts > 0 ? remote.maxAttempts : null;
          const previousError = ['inbox_status_unavailable', 'inbox_item_missing'].includes(item.lastNoticeError) ? null : item.lastNoticeError;
          updates.set(item.trackingId, { lastStatus: terminal, statusAttempts: 0, nextStatusAt: clock() + 30_000,
            failureReport, attempts, maxAttempts,
            ...(parsedTitle ? { title: parsedTitle, titleChecked: true } : {}),
            ...(!parsedTitle && failedTitle ? { title: failedTitle, titleChecked: true } : {}),
            lastNoticeError: result.missing.includes(item.inboxItemId) ? 'inbox_item_missing' : previousError });
        }
        await commit({ ...state, tracking: state.tracking.map(item => ({ ...item, ...updates.get(item.trackingId) })) });
      } catch (error) {
        if (signal?.aborted || error.code === 'stopped') throw new BridgeError('stopped');
        if (error.fatal) throw error;
        const ids = new Set(due.map(item => item.trackingId));
        await commit({ ...state, tracking: state.tracking.map(item => ids.has(item.trackingId) ? { ...item,
          statusAttempts: item.statusAttempts + 1, nextStatusAt: clock() + notificationBackoff(item.statusAttempts + 1),
          lastNoticeError: 'inbox_status_unavailable' } : item) });
      }
    }
    for (const snapshot of [...state.tracking]) {
      if (signal?.aborted) return;
      let item = state.tracking.find(candidate => candidate.trackingId === snapshot.trackingId);
      if (!item || item.nextNotifyAt > clock()) continue;
      if (!item.titleChecked) {
        let title = null;
        try { title = await fetchTitle(item.url, { fetchImpl, signal }); } catch { /* Best-effort title; queue receipt remains truthful. */ }
        title = checkedTitle(item.title) ?? checkedTitle(title);
        await updateTracking(item.trackingId, { title, titleChecked: true });
        item = state.tracking.find(candidate => candidate.trackingId === snapshot.trackingId);
      }
      try {
        if (!item.contextToken) throw new BridgeError('missing_context');
        if (!item.queuedNoticeSent && item.lastStatus !== 'failed') {
          await sendNotice({ account, contextToken: item.contextToken, clientId: `collect-q-${item.trackingId.slice(0, 40)}`,
            text: queuedText(item.title), fetchImpl, signal });
          await updateTracking(item.trackingId, { queuedNoticeSent: true, notifyAttempts: 0, nextNotifyAt: 0, lastNoticeError: null });
          item = state.tracking.find(candidate => candidate.trackingId === snapshot.trackingId);
        }
        if (item.lastStatus !== 'pending') {
          await sendNotice({ account, contextToken: item.contextToken, clientId: `collect-${item.lastStatus}-${item.trackingId.slice(0, 40)}`,
            text: item.lastStatus === 'done' ? finishedText(item.title) : failedText(item.title, {
              failureReport: item.failureReport, attempts: item.attempts, maxAttempts: item.maxAttempts,
              secrets: [account.token, inboxToken, item.contextToken]
            }), fetchImpl, signal });
          // Acknowledged final notifications need no permanent tracking row.
          await commit({ ...state, tracking: state.tracking.filter(candidate => candidate.trackingId !== item.trackingId) });
        }
      } catch (error) {
        if (signal?.aborted || error.code === 'stopped') throw new BridgeError('stopped');
        if (error instanceof BridgeError && error.fatal) throw error;
        if (error.code === 'auth_required') throw new BridgeError('auth_required', true);
        const attempts = item.notifyAttempts + 1;
        await updateTracking(item.trackingId, { notifyAttempts: attempts, nextNotifyAt: clock() + notificationBackoff(attempts),
          lastNoticeError: error.code === 'missing_context' ? 'missing_context' : 'notification_failed' });
      }
    }
  }
  async function step(signal) {
    if (closed || busy) throw new BridgeError(closed ? 'closed' : 'busy', true);
    busy = true;
    try {
      if (signal?.aborted) return;
      await flush(signal);
      await notifications(signal);
      if (signal?.aborted) return;
      const result = await requestJson(fetchImpl, `${account.base}/ilink/bot/getupdates`, {
        get_updates_buf: state.cursor, base_info: { channel_version: VERSION, bot_agent: 'InspirationCollector/0.2.0' }
      }, { Authorization: `Bearer ${account.token}`, AuthorizationType: 'ilink_bot_token',
        'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10),
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') },
      { label: 'upstream', timeout: 35_000, signal });
      const errorCodes = [result.ret, result.errcode].filter(code => code !== undefined && code !== 0);
      if (errorCodes.length) {
        if (errorCodes.includes(-14)) throw new BridgeError('auth_required', true);
        throw new BridgeError('upstream_api_error');
      }
      if ((result.msgs !== undefined && !Array.isArray(result.msgs)) || (result.msgs?.length || 0) > LIMIT.messages ||
          (result.get_updates_buf !== undefined && !boundedString(result.get_updates_buf, LIMIT.cursor, true))) {
        throw new BridgeError('upstream_response_invalid');
      }
      const seen = new Set(state.seen);
      const pending = [...state.pending];
      let received = state.received;
      for (const message of result.msgs || []) {
        const accepted = acceptedMessage(message, account);
        if (!accepted || seen.has(accepted.key)) continue;
        seen.add(accepted.key); received++;
        for (const url of accepted.urls) pending.push({ key: accepted.key, url, contextToken: accepted.contextToken });
      }
      // Commit the batch AND cursor in one replacement BEFORE any inbox POST.
      // Capacity/storage failure leaves the old cursor intact for redelivery.
      await commit({ ...state, cursor: result.get_updates_buf ?? state.cursor, pending,
        seen: [...seen].slice(-LIMIT.seen), received, lastPoll: now() });
      await status('listening');
      await flush(signal);
      await notifications(signal);
      return await status('listening');
    } catch (error) {
      const safe = ['upstream_http_401', 'upstream_http_403'].includes(error.code) ? new BridgeError('auth_required', true) :
        error instanceof BridgeError ? error : new BridgeError('internal_error', true);
      if (safe.code !== 'stopped') await status(safe.code === 'auth_required' ? 'auth_required' : 'error', safe.code);
      throw safe;
    } finally { busy = false; }
  }
  try { await status(); } catch (error) { await release(); throw error; }
  return {
    step,
    async run(signal) {
      let failures = 0;
      while (!signal?.aborted) {
        try { await step(signal); failures = 0; }
        catch (error) {
          if (signal?.aborted || error.code === 'stopped') break;
          if (error.fatal) return { code: error.code, exitCode: 78 };
          failures++;
        }
        const wait = failures ? Math.min(60_000, 1_000 * 2 ** Math.min(failures - 1, 6)) : 500;
        try { await delay(wait, undefined, { signal }); } catch { if (!signal?.aborted) throw new BridgeError('internal_error', true); }
      }
      await status('stopped');
      return { code: 'stopped', exitCode: 0 };
    },
    async close() {
      if (busy) throw new BridgeError('busy', true);
      if (!closed) { closed = true; await release(); }
    },
    getStatus: () => ({ phase, lastPoll: state.lastPoll, lastCollect: state.lastCollect,
      pending: state.pending.length, received: state.received, submitted: state.submitted, awaitingCompletion: state.tracking.length,
      lastErrorCode: lastErrorCode ?? state.tracking.find(item => item.lastNoticeError)?.lastNoticeError ?? null })
  };
}

export async function main(env = process.env) {
  let bridge;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    if (!env.CLAWBOT_ACCOUNT_FILE || !env.CLAWBOT_DATA) throw new BridgeError('invalid_config', true);
    let account;
    try { account = await readJson(env.CLAWBOT_ACCOUNT_FILE, 32_768, 'invalid_account'); }
    catch { throw new BridgeError('invalid_account', true); }
    bridge = await createBridge({ account, dataDir: env.CLAWBOT_DATA, inboxUrl: env.INBOX_URL,
      inboxToken: env.INBOX_TOKEN });
    const result = await bridge.run(controller.signal);
    return result.exitCode;
  } catch (error) {
    console.error(JSON.stringify({ phase: 'error', lastErrorCode: error instanceof BridgeError ? error.code : 'internal_error' }));
    return 78;
  } finally {
    await bridge?.close();
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
