import { createHash } from 'node:crypto';

const escapeHtml = value => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  // These forms only deliver to the business, never to an address supplied by a visitor.
  if (req.headers?.origin && !['https://crumbyte.com', 'https://www.crumbyte.com'].includes(req.headers.origin)) {
    return res.status(403).json({ error: 'Please submit your request from crumbyte.com.' });
  }
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Please complete the required fields.' });
  }
  if (body.website) return res.status(200).json({ ok: true });
  const limits = { name: 100, email: 254, company: 120, service: 100, message: 4000,
    platform: 80, issue: 100, request_acknowledgment: 150, kind: 20, requestId: 80 };
  const data = {};
  for (const [key, max] of Object.entries(limits)) {
    if (body[key] != null && (typeof body[key] !== 'string' || body[key].length > max)) {
      return res.status(400).json({ error: 'Please check the form fields and try again.' });
    }
    data[key] = (body[key] || '').trim();
  }
  if (!data.name || !data.service || data.message.length < 10 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) ||
      /[\r\n]/.test(data.name + data.service + data.email) ||
      !['contact', 'support'].includes(data.kind) ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(data.requestId)) {
    return res.status(400).json({ error: 'Please complete the required fields with a valid email address.' });
  }
  const support = data.kind === 'support';
  if (support && (!data.platform || !data.issue || !data.request_acknowledgment || data.message.length > 3000)) {
    return res.status(400).json({ error: 'Please select your device and issue category and acknowledge the support terms.' });
  }
  if (!process.env.RESEND_API_KEY || !process.env.CONTACT_FROM_EMAIL) {
    return res.status(503).json({ error: 'Online requests are temporarily unavailable. Please email info@crumbyte.com.' });
  }
  const heading = support ? 'New remote support request' : 'New website inquiry';
  const fields = [['Name', data.name], ['Email', data.email], ['Company', data.company], ['Service', data.service]];
  if (support) fields.push(['Device', data.platform], ['Issue category', data.issue], ['Acknowledgment', data.request_acknowledgment]);
  const text = heading + '\n\n' + fields.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n') + '\n\nMessage:\n' + data.message;
  const html = '<!doctype html><html lang="en"><body><h1>' + heading + '</h1>' +
    fields.filter(([, value]) => value).map(([label, value]) => `<p><strong>${label}:</strong> ${escapeHtml(value)}</p>`).join('') +
    '<h2>Message</h2><p>' + escapeHtml(data.message).replace(/\r?\n/g, '<br>') + '</p></body></html>';
  // Reusing the same form request after a lost response cannot send a second copy.
  const idempotencyKey = 'website-' + createHash('sha256').update(data.kind + ':' + data.requestId).digest('hex');
  const payload = { from: process.env.CONTACT_FROM_EMAIL, to: ['info@crumbyte.com'], reply_to: data.email,
    subject: `${support ? 'Support request' : 'Website inquiry'}: ${data.service}`, text, html,
    tags: [{ name: 'source', value: support ? 'website-support' : 'website-contact' }] };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        const result = await response.json();
        if (typeof result.id !== 'string' || !result.id) throw new Error('Missing email confirmation');
        return res.status(200).json({ ok: true });
      }
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      // Keep provider responses, credentials, and customer content out of public errors/logs.
      console.error('Website email delivery rejected', { status: response.status, source: data.kind });
      break;
    } catch {
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      console.error('Website email delivery unavailable', { source: data.kind });
    }
  }
  return res.status(502).json({ error: 'Your request could not be submitted. Please email info@crumbyte.com or call 808-285-7724.' });
}
