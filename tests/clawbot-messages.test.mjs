import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchArticleTitle, queuedText, finishedText, failedText, sendWechatText } from '../inbox/clawbot-messages.mjs';

const article = 'https://mp.weixin.qq.com/s/test_article';
const account = { token: 'fake-token', owner: 'owner-only', bot: 'fake-bot', base: 'https://ilinkai.weixin.qq.com' };
const args = { account, text: '已收到链接，已加入队列。', contextToken: 'opaque-context-token', clientId: 'receipt:stable-id' };
const htmlResponse = html => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

test('notification copy distinguishes queueing, completed import and failure without echoing errors', () => {
  assert.equal(queuedText('示例'), '已收到链接：本篇名为《示例》，已加入队列。');
  assert.equal(queuedText(null), '已收到链接，已加入队列。');
  assert.equal(finishedText('示例'), '《示例》已解析成功并导入灵感收集。');
  assert.equal(finishedText(), '文章已解析成功并导入灵感收集。');
  assert.match(failedText('示例', 'api-key-sensitive'), /收集失败/);
  assert.doesNotMatch(failedText(null, 'api-key-sensitive'), /api-key-sensitive/);
  assert.equal(queuedText('  A\n  B  '), '已收到链接：本篇名为《A B》，已加入队列。');
});

test('final failure report gives actual attempt limit, bounded field diagnostics and no raw errors', () => {
  const report = { version: 1, stage: 'card_validation', articleTitle: '报告中的文章名', batch: 2, imageStart: 7, imageEnd: 12,
    issues: [{ cardIndex: 3, cardTitle: '配色示例', cardType: 'palette', field: 'colors[0].hex', code: 'invalid_color' }], issueCount: 1 };
  const text = failedText(null, { failureReport: report, attempts: 3, maxAttempts: 3, error: 'MODEL_RAW_SECRET' });
  assert.match(text, /^《报告中的文章名》收集失败：已尝试3\/3次，已停止自动重试。/);
  for (const value of ['2', '3', '配色示例', 'colors[0].hex']) assert.ok(text.includes(value), value);
  assert.match(text, /请在电脑端查看，修正后可手动重新排队。$/);
  assert.doesNotMatch(text, /MODEL_RAW_SECRET/);
  const unknown = failedText(null, { failureReport: { raw: 'MODEL_RAW_SECRET' }, error: 'MODEL_RAW_SECRET' });
  assert.match(unknown, /^文章收集失败：已停止自动重试。/);
  assert.match(unknown, /未提供结构化诊断/);
  assert.doesNotMatch(unknown, /3\/3|MODEL_RAW_SECRET/);
  const secretReport = { ...report, issues: [{ ...report.issues[0], cardTitle: '配色 FAKE_BOT_SECRET', raw: 'MODEL_RAW_SECRET' }] };
  assert.doesNotMatch(failedText(null, { failureReport: secretReport, attempts: 3, maxAttempts: 3, secrets: ['FAKE_BOT_SECRET'] }), /FAKE_BOT_SECRET|MODEL_RAW_SECRET/);
  assert.doesNotMatch(failedText('标题 FAKE_BOT_SECRET sk-testsecret123', { secrets: ['FAKE_BOT_SECRET'] }), /FAKE_BOT_SECRET|sk-testsecret123/);
  const long = failedText('文'.repeat(1000), { attempts: 3, maxAttempts: 3,
    failureReport: { ...report, issues: Array.from({ length: 100 }, () => ({ ...report.issues[0], cardTitle: '长'.repeat(1000) })), issueCount: 100 } });
  assert.ok(Array.from(long).length <= 2500);
  assert.match(long, /请在电脑端查看，修正后可手动重新排队。$/);
});

test('title lookup permits only strict Weixin article links without credentials, ports or redirects', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => { calls++; assert.equal(options.redirect, 'error'); return htmlResponse('<title>合法文章</title>'); };
  for (const value of ['http://mp.weixin.qq.com/s/a', 'https://mp.weixin.qq.com:443/s/a',
    'https://user@mp.weixin.qq.com/s/a', 'https://mp.weixin.qq.com.evil.test/s/a', 'https://evil.test/?u=' + article,
    'https://mp.weixin.qq.com/s?sn=x', 'https://mp.weixin.qq.com/s', 'https://mp.weixin.qq.com/cgi-bin/x',
    'https://mp.weixin.qq.com/s/a\\evil', 'https://mp.weixin.qq.com/s/%2fa']) {
    assert.equal(await fetchArticleTitle(value, { fetchImpl }), null, value);
  }
  assert.equal(calls, 0);
  assert.equal(await fetchArticleTitle(article, { fetchImpl }), '合法文章');
  assert.equal(await fetchArticleTitle('https://mp.weixin.qq.com/s?__biz=test&sn=abc', { fetchImpl }), '合法文章');
  assert.equal(calls, 2);
});

test('metadata title wins, entities decode, scripts are ignored and titles are bounded', async () => {
  const source = '<script>throw new Error("must not execute"); "<title>fake</title>";</script>' +
    '<title>document title</title><META content=" A &amp; B &#x4e2d;&#25991; &ldquo;字&rdquo; &nbsp; " property="og:title">';
  assert.equal(await fetchArticleTitle(article, { fetchImpl: async () => htmlResponse(source) }), 'A & B 中文 “字”');
  assert.equal(await fetchArticleTitle(article, { fetchImpl: async () => htmlResponse('<title>  Hello\n world </title>') }), 'Hello world');
  assert.equal(Array.from(await fetchArticleTitle(article, { fetchImpl: async () => htmlResponse(`<title>${'🧠'.repeat(140)}</title>`) })).length, 120);
});

test('missing, generic, challenge, non-HTML, failed or redirected pages have no title', async () => {
  for (const html of ['', '<title>微信公众平台</title>', '<title>环境异常</title><meta property="og:title" content="looks valid">',
    '<title>some text</title><div id="js_verify"></div>', '<script>"<title>fake</title>"</script>']) {
    assert.equal(await fetchArticleTitle(article, { fetchImpl: async () => htmlResponse(html) }), null);
  }
  for (const response of [new Response('private', { status: 403 }), new Response('<title>not html</title>', { headers: { 'content-type': 'image/png' } })]) {
    assert.equal(await fetchArticleTitle(article, { fetchImpl: async () => response }), null);
  }
  assert.equal(await fetchArticleTitle(article, { fetchImpl: async () => ({ ok: true, redirected: true }) }), null);
  assert.equal(await fetchArticleTitle(article, { fetchImpl: async () => { throw new Error('private body'); } }), null);
});

test('title reads bound advertised and streamed bodies and honor total timeout and cancellation', async () => {
  assert.equal(await fetchArticleTitle(article, { maxBytes: 30, fetchImpl: async () => new Response('<title>small</title>', { headers: { 'content-length': '999' } }) }), null);
  assert.equal(await fetchArticleTitle(article, { maxBytes: 30, fetchImpl: async () => htmlResponse('<title>small</title>' + 'x'.repeat(30)) }), null);
  assert.equal(await fetchArticleTitle(article, { timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) }), null);
  assert.equal(await fetchArticleTitle(article, { timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) }), null);
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  assert.equal(await fetchArticleTitle(article, { signal: controller.signal, fetchImpl: async () => { calls++; return htmlResponse('<title>a</title>'); } }), null);
  assert.equal(calls, 0);
});

test('send uses official protocol, exact context and fixed owner with stable supplied client ID', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return Response.json({ ret: 0, message_id: '12345678901234567890' }); };
  await sendWechatText({ ...args, fetchImpl });
  await sendWechatText({ ...args, fetchImpl });
  for (const { url, options } of calls) {
    assert.equal(url, 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer fake-token');
    assert.equal(options.headers.AuthorizationType, 'ilink_bot_token');
    assert.equal(options.headers['iLink-App-Id'], 'bot');
    assert.equal(options.headers['iLink-App-ClientVersion'], '132106');
    assert.match(Buffer.from(options.headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
    assert.deepEqual(JSON.parse(options.body), { msg: { from_user_id: '', to_user_id: account.owner, client_id: args.clientId,
      message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text: args.text } }], context_token: args.contextToken },
      base_info: { channel_version: '2.4.10', bot_agent: 'InspirationCollector/0.2.0' } });
  }
});

test('untrusted origins and invalid account/message values are rejected before any network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ ret: 0 }); };
  for (const base of ['http://ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:443', 'https://weixin.qq.com.evil.test',
    'https://user@weixin.qq.com', 'https://weixin.qq.com/path', 'https://weixin.qq.com?leak=1', 'https://evil.test']) {
    await assert.rejects(sendWechatText({ ...args, account: { ...account, base }, fetchImpl }), { code: 'invalid_account_origin' });
  }
  await assert.rejects(sendWechatText({ ...args, account: { ...account, token: 'unsafe\nsecret' }, fetchImpl }), { code: 'invalid_account' });
  await assert.rejects(sendWechatText({ ...args, contextToken: '', fetchImpl }), { code: 'missing_context_token' });
  await assert.rejects(sendWechatText({ ...args, clientId: '', fetchImpl }), { code: 'invalid_message' });
  assert.equal(calls, 0);
});

test('send errors contain only stable codes and auth expiry is recognized', async () => {
  for (const [response, code] of [[Response.json({ ret: -14, errmsg: 'private token' }), 'auth_required'],
    [Response.json({ errcode: -14 }), 'auth_required'], [Response.json({ ret: -2, errmsg: 'private article' }), 'send_rejected'],
    [new Response('private token', { status: 401 }), 'auth_required'], [new Response('private body', { status: 500 }), 'send_http_error'],
    [new Response('private invalid JSON'), 'send_invalid_response'], [Response.json(null), 'send_invalid_response'],
    [Response.json([], {}), 'send_invalid_response'], [new Response('x'.repeat(65537)), 'response_too_large']]) {
    await assert.rejects(sendWechatText({ ...args, fetchImpl: async () => response }), e => e.code === code && e.message === code);
  }
  await assert.rejects(sendWechatText({ ...args, fetchImpl: async () => { throw new Error('private credentials'); } }), { message: 'send_network_error', code: 'send_network_error' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(sendWechatText({ ...args, signal: controller.signal, fetchImpl: async () => { throw new Error('not reached'); } }), { code: 'request_aborted' });
});
