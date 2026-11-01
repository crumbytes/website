import { createHash, createHmac } from 'node:crypto';
import { OutboundError } from './safe-http.js';

// A backup provider reports what exists. Nothing here starts a backup or restores
// one, and a reported object says nothing about whether it can be restored.
//
//   key, label, supportsSync
//   listRuns(source) -> [{ externalId, status, finishedAt, sizeBytes }]

const sha256Hex = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

// AWS Signature Version 4, which Cloudflare R2's S3-compatible API expects.
export function signS3Request({ method, url, accessKeyId, secretAccessKey, region = 'auto', service = 's3', now = new Date() }) {
  const parsed = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex('');
  const canonicalQuery = [...parsed.searchParams.entries()]
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${key}=${value}`).join('&');
  const canonicalHeaders = `host:${parsed.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, parsed.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash
  };
}

const xmlValue = (block, tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block)?.[1] ?? null;

export function createR2Provider({ accountId, bucket, accessKeyId, secretAccessKey }, http, now = () => new Date()) {
  return {
    key: 'r2',
    label: 'Cloudflare R2',
    supportsSync: true,
    async listRuns(source) {
      const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucket}`);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('max-keys', '100');
      if (source.storage_ref) url.searchParams.set('prefix', source.storage_ref);
      const headers = signS3Request({ method: 'GET', url: url.href, accessKeyId, secretAccessKey, now: now() });
      const response = await http.request({ url: url.href, headers, maxBytes: 4 * 1024 * 1024 });
      if (response.status === 401 || response.status === 403) throw new OutboundError('auth_failed', response.status);
      if (response.status === 429) throw new OutboundError('rate_limited', response.status);
      if (response.status < 200 || response.status >= 300) throw new OutboundError('upstream_error', response.status);
      return [...response.body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, block]) => {
        const sizeBytes = Number(xmlValue(block, 'Size'));
        return {
          externalId: xmlValue(block, 'Key'),
          // An empty object cannot be a backup, so it is not reported as a success.
          status: sizeBytes > 0 ? 'succeeded' : 'unknown',
          finishedAt: new Date(xmlValue(block, 'LastModified')),
          sizeBytes
        };
      }).filter(run => run.externalId && !Number.isNaN(run.finishedAt.getTime()));
    }
  };
}

export function createBackupProviders(config, http) {
  const providers = {};
  if (config.enabled && config.accountId && config.bucket && config.accessKeyId && config.secretAccessKey) {
    providers.r2 = createR2Provider(config, http);
  }
  return providers;
}
