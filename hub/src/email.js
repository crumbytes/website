import { writeAudit } from './audit.js';

const MAX_ATTEMPTS = 5;

// Sends through the same provider as the public contact form, with its own key.
// Off by default, in which case notifications stay in the hub only.
export function createEmailSender({ enabled, apiKey, from }, http) {
  if (!enabled || !apiKey || !from) return { enabled: false };
  return {
    enabled: true,
    async send({ to, subject, text, idempotencyKey }) {
      const response = await http.request({
        url: 'https://api.resend.com/emails', method: 'POST', timeoutMs: 10000,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ from, to: [to], subject, text })
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`Email rejected with status ${response.status}`);
    }
  };
}

export async function deliverEmails({ db, email, baseUrl, logger, limit = 25 }) {
  if (!email?.enabled) return { sent: 0, failed: 0, skipped: 'email_disabled' };
  const pending = await db.as('hub_worker', null, async tx => (await tx.query(
    `select n.id, n.title, n.body, n.link_path, n.email_attempts, u.email from hub.notifications n join hub.staff_users u on u.id = n.staff_id
     where n.email_status = 'pending' and u.status = 'active' order by n.created_at limit $1`, [limit])).rows);
  let sent = 0;
  let failed = 0;
  for (const item of pending) {
    let ok = true;
    try {
      await email.send({
        to: item.email, subject: `[CrumByte Hub] ${item.title}`, idempotencyKey: `hub-notification-${item.id}`,
        text: `${item.title}\n\n${item.body}\n\n${item.link_path ? `${baseUrl}${item.link_path}` : baseUrl}`
      });
    } catch (error) {
      ok = false;
      logger?.warn('hub.email_failed', { notification: item.id, name: error?.name });
    }
    const attempts = item.email_attempts + 1;
    const status = ok ? 'sent' : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    await db.as('hub_worker', null, async tx => {
      await tx.query(`update hub.notifications set email_status = $2, email_attempts = $3 where id = $1`, [item.id, status, attempts]);
      if (status === 'failed') await writeAudit(tx, { action: 'notification.email_failed', outcome: 'failure', entityType: 'notification', entityId: item.id });
    });
    if (ok) sent += 1;
    else failed += 1;
  }
  return { sent, failed };
}
