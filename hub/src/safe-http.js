import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import tls from 'node:tls';

export class OutboundError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['2002::', 16], ['2001::', 32], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
]) blocked.addSubnet(address, prefix, 'ipv6');

export function isBlockedAddress(address) {
  const family = isIP(address);
  if (family === 0) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// Validates at connect time and connects to the validated answer, so a hostname
// that changes to a private address between checks still cannot be reached.
function guardedLookup(resolve, allowPrivate) {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length || (!allowPrivate && addresses.some(item => isBlockedAddress(item.address)))) {
        return callback(new OutboundError('blocked_target'));
      }
      if (options?.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function checkTarget(rawUrl, { allowHttp, allowPrivate, allowAnyPort }) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundError('blocked_target');
  }
  if (url.username || url.password) throw new OutboundError('blocked_target');
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new OutboundError('blocked_target');
  if (url.port && !allowAnyPort && !['80', '443'].includes(url.port)) throw new OutboundError('blocked_target');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && isIP(host) && isBlockedAddress(host)) throw new OutboundError('blocked_target');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))) {
    throw new OutboundError('blocked_target');
  }
  return url;
}

function classify(error) {
  if (error instanceof OutboundError) return error;
  const code = String(error?.code ?? '');
  if (code.includes('TIMEDOUT') || code === 'ABORT_ERR') return new OutboundError('timeout');
  if (/CERT|SSL|TLS|SELF_SIGNED|ALTNAME/i.test(code)) return new OutboundError('tls_error');
  return new OutboundError('network_error');
}

// The only way the hub reaches a URL that came from staff input or a stored record.
// Redirects are returned, never followed, so credentials cannot travel to another host.
export function createSafeHttp({ resolve = dnsLookup, allowPrivate = false, allowAnyPort = false, enabled = true } = {}) {
  const lookup = guardedLookup(resolve, allowPrivate);
  return {
    request({ url: rawUrl, method = 'GET', headers = {}, body, timeoutMs = 10000, maxBytes = 2 * 1024 * 1024, allowHttp = false }) {
      if (!enabled) return Promise.reject(new OutboundError('outbound_disabled'));
      return new Promise((resolvePromise, reject) => {
        let url;
        try {
          url = checkTarget(rawUrl, { allowHttp, allowPrivate, allowAnyPort });
        } catch (error) {
          return reject(error);
        }
        const started = performance.now();
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(url, { method, headers, lookup, signal: AbortSignal.timeout(timeoutMs) }, res => {
          const chunks = [];
          let size = 0;
          res.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) {
              // Rejected here, because 'end' can still fire and must not resolve a cut-off body.
              reject(new OutboundError('response_too_large'));
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            elapsedMs: Math.round(performance.now() - started)
          }));
          res.on('error', error => reject(classify(error)));
        });
        req.on('error', error => reject(classify(error)));
        if (body) req.write(body);
        req.end();
      });
    },
    async dnsAddresses({ url: rawUrl }) {
      if (!enabled) throw new OutboundError('outbound_disabled');
      const url = checkTarget(rawUrl, { allowHttp: true, allowPrivate, allowAnyPort });
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = await new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new OutboundError('timeout')), 8000);
        resolve(host, { all: true }, (error, answers) => {
          clearTimeout(timer);
          if (error) return fail(classify(error));
          if (!answers?.length || (!allowPrivate && answers.some(a => isBlockedAddress(a.address)))) return fail(new OutboundError('blocked_target'));
          ok([...new Set(answers.map(a => a.address))].sort().slice(0,20));
        });
      });
      return addresses;
    },
    tlsCertificate({ url: rawUrl, timeoutMs = 10000 }) {
      if (!enabled) return Promise.reject(new OutboundError('outbound_disabled'));
      return new Promise((resolvePromise, reject) => {
        let url;
        try {
          url = checkTarget(rawUrl, { allowHttp: false, allowPrivate, allowAnyPort });
        } catch (error) {
          return reject(error);
        }
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const socket = tls.connect({
          host: hostname, port: Number(url.port) || 443, lookup, rejectUnauthorized: false,
          servername: isIP(hostname) ? undefined : hostname
        }, () => {
          const certificate = socket.getPeerCertificate();
          const hostError = certificate?.subject ? tls.checkServerIdentity(hostname, certificate) : new Error('No certificate');
          const result = {
            validTo: certificate?.valid_to ? new Date(certificate.valid_to) : null,
            issuer: certificate?.issuer?.O ?? certificate?.issuer?.CN ?? null,
            trusted: socket.authorized && !hostError
          };
          socket.destroy();
          resolvePromise(result);
        });
        socket.setTimeout(timeoutMs, () => socket.destroy(new OutboundError('timeout')));
        socket.on('error', error => reject(classify(error)));
      });
    }
  };
}
