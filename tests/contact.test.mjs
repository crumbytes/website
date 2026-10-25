import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/contact.js';

const valid = { name: 'Website Test', email: 'info@crumbyte.com', service: 'IT Consulting',
  message: 'Configuration test only. No service request.', kind: 'contact', requestId: 'c0a034f2-3574-45a0-b1be-5b965c313400' };
const run = async (body = valid, extra = {}) => {
  const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'POST', headers: { origin: 'https://crumbyte.com' }, body, ...extra }, res);
  return res;
};
const originalFetch = globalThis.fetch;
process.env.RESEND_API_KEY = 'unit-test-credential';
process.env.CONTACT_FROM_EMAIL = 'CrumByte Technologies <website@crumbyte.com>';
let calls;
test.beforeEach(() => { calls = []; globalThis.fetch = async (url, options) => {
  calls.push({ url, options, payload: JSON.parse(options.body) });
  return { ok: true, status: 200, json: async () => ({ id: 'test-message' }) };
}; });
test.after(() => { globalThis.fetch = originalFetch; });

test('inquiries use the verified sender and fixed business recipient, and preserve reply-to', async () => {
  const r = await run({ ...valid, to: 'attacker@example.com', from: 'spoof@example.com' });
  assert.equal(r.code, 200); assert.deepEqual(r.body, { ok: true });
  assert.deepEqual(calls[0].payload.to, ['info@crumbyte.com']);
  assert.equal(calls[0].payload.from, process.env.CONTACT_FROM_EMAIL);
  assert.equal(calls[0].payload.reply_to, valid.email);
  assert.equal(calls[0].payload.tags[0].value, 'website-contact');
});
test('support requests include device, issue, and acknowledgment', async () => {
  const r = await run({ ...valid, kind: 'support', service: 'Remote Support', platform: 'Windows PC',
    issue: 'Network or Wi-Fi', request_acknowledgment: 'I understand this is a request, not a live connection' });
  assert.equal(r.code, 200); assert.match(calls[0].payload.text, /Device: Windows PC/);
  assert.match(calls[0].payload.text, /Issue category: Network or Wi-Fi/);
  assert.equal(calls[0].payload.tags[0].value, 'website-support');
});
test('HTML is escaped and plain text preserves the original message', async () => {
  await run({ ...valid, message: '<script>alert("unsafe")</script>\nNew line.' });
  assert.doesNotMatch(calls[0].payload.html, /<script>/);
  assert.match(calls[0].payload.html, /&lt;script&gt;/);
  assert.match(calls[0].payload.text, /<script>/);
});
test('invalid, oversized, and incomplete requests never call the email provider', async () => {
  for (const body of [null, [], { ...valid, email: 'invalid email' }, { ...valid, name: ['array'] },
    { ...valid, service: 'IT\r\nBcc: injected' }, { ...valid, message: 'x'.repeat(4001) },
    { ...valid, kind: 'support' }, { ...valid, requestId: '' }]) {
    assert.equal((await run(body)).code, 400);
  }
  assert.equal(calls.length, 0);
});
test('honeypots and disallowed methods/origins do not send email', async () => {
  assert.equal((await run({ ...valid, website: 'bot-field' })).code, 200);
  assert.equal((await run(valid, { method: 'GET' })).code, 405);
  assert.equal((await run(valid, { headers: { origin: 'https://other.example' } })).code, 403);
  assert.equal(calls.length, 0);
});
test('retries reuse the idempotency key; repeated requests produce the same key', async () => {
  let attempts = 0;
  globalThis.fetch = async (url, options) => {
    calls.push(options); attempts++;
    return { ok: attempts !== 1, status: attempts === 1 ? 503 : 200, json: async () => ({ id: 'test-message' }) };
  };
  assert.equal((await run()).code, 200);
  assert.equal((await run()).code, 200);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(c => c.headers['Idempotency-Key'])).size, 1);
});
test('provider failures do not report success or expose provider secrets', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  const r = await run();
  assert.equal(r.code, 502); assert.equal(r.body.ok, undefined);
  assert.doesNotMatch(JSON.stringify(r.body), /unit-test-credential/);
});
