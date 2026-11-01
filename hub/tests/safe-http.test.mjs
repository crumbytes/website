import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSafeHttp, isBlockedAddress, OutboundError } from '../src/safe-http.js';

let server, port, seen;
before(async () => {
  seen = [];
  server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://elsewhere.example.test/next' }); return res.end(); }
    if (req.url === '/big') { res.writeHead(200); res.write(Buffer.alloc(4096)); return res.end(); }
    if (req.url === '/slow') return; // Never answers.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => { server.closeAllConnections(); server.close(); });

const code = async promise => { try { await promise; return 'no error'; } catch (error) { assert.ok(error instanceof OutboundError, String(error)); return error.code; } };
const resolvesTo = address => (_host, _options, callback) => callback(null, [{ address, family: address.includes(':') ? 6 : 4 }]);

test('private, loopback, link-local and metadata addresses are recognized', () => {
  for (const address of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.1.1.1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1']) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test('literal internal targets and unsafe URLs are refused before any connection', async () => {
  const http = createSafeHttp();
  for (const url of ['https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://10.0.0.1/', 'https://localhost/', 'https://db.localhost/', 'https://svc.internal/',
    'http://example.test/', 'ftp://example.test/', 'file:///etc/passwd', 'not a url', 'https://user:pw@example.test/', 'https://example.test:8443/']) {
    assert.equal(await code(http.request({ url })), 'blocked_target', url);
  }
  assert.equal(await code(http.request({ url: 'gopher://example.test/', allowHttp: true })), 'blocked_target');
});

test('a public name that resolves to an internal address is refused at connect time', async () => {
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.2', '::1']) {
    const http = createSafeHttp({ resolve: resolvesTo(address), allowAnyPort: true });
    assert.equal(await code(http.request({ url: `http://public.example.test:${port}/`, allowHttp: true })), 'blocked_target', address);
  }
  assert.equal(seen.length, 0);
});

test('any internal answer among several is enough to refuse', async () => {
  const mixed = (_host, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  const http = createSafeHttp({ resolve: mixed, allowAnyPort: true });
  assert.equal(await code(http.request({ url: `http://public.example.test:${port}/`, allowHttp: true })), 'blocked_target');
});

test('when turned off, nothing is contacted at all', async () => {
  const http = createSafeHttp({ enabled: false });
  assert.equal(await code(http.request({ url: 'https://example.test/' })), 'outbound_disabled');
  assert.equal(await code(http.tlsCertificate({ url: 'https://example.test/' })), 'outbound_disabled');
});

// The remaining tests talk to a local server, so they explicitly allow loopback.
const local = () => createSafeHttp({ allowPrivate: true, allowAnyPort: true });

test('redirects are returned rather than followed', async () => {
  seen.length = 0;
  const result = await local().request({ url: `http://127.0.0.1:${port}/redirect`, allowHttp: true, headers: { Authorization: 'x' } });
  assert.equal(result.status, 302);
  assert.deepEqual(seen, ['/redirect']);
});

test('responses are size limited and slow servers time out', async () => {
  assert.equal(await code(local().request({ url: `http://127.0.0.1:${port}/big`, allowHttp: true, maxBytes: 1024 })), 'response_too_large');
  assert.equal(await code(local().request({ url: `http://127.0.0.1:${port}/slow`, allowHttp: true, timeoutMs: 100 })), 'timeout');
});

test('connection failures use a safe code and a successful call returns timing', async () => {
  const ok = await local().request({ url: `http://127.0.0.1:${port}/`, allowHttp: true });
  assert.equal(ok.body, '{"ok":true}');
  assert.ok(ok.elapsedMs >= 0);
  const closed = createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  assert.equal(await code(local().request({ url: `http://127.0.0.1:${closedPort}/`, allowHttp: true })), 'network_error');
});

test('TLS probes refuse internal targets', async () => {
  assert.equal(await code(createSafeHttp().tlsCertificate({ url: 'https://127.0.0.1/' })), 'blocked_target');
  assert.equal(await code(createSafeHttp({ resolve: resolvesTo('10.0.0.3') }).tlsCertificate({ url: 'https://public.example.test/' })), 'blocked_target');
});
