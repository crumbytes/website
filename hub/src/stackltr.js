import { writeAudit } from './audit.js';
import { createPlatformClient, safeCode } from './adapters/framework.js';

const MAX_ATTEMPTS = 8;
const EVENT_PATHS = Object.freeze({ 'maintenance.completed': '/api/integrations/website-hub/v1/events' });

// The StackLTR side of this contract does not exist yet: see
// docs/stackltr-integration.md. Until it does, and until someone explicitly turns
// it on, events simply wait in the outbox and nothing is sent.
export function createStackltrClient({ enabled, baseUrl, token }, http) {
  if (!enabled || !baseUrl || !token) return { enabled: false };
  const client = createPlatformClient({ baseUrl, http, authHeaders: { Authorization: `Bearer ${token}` }, timeoutMs: 10000 });
  return {
    enabled: true,
    sendEvent: (path, event) => client.post(path, {
      json: event,
      headers: { 'Idempotency-Key': event.idempotency_key }
    })
  };
}

export async function deliverOutbox({ db, stackltr, limit = 25 }) {
  if (!stackltr?.enabled) return { sent: 0, failed: 0, skipped: 'stackltr_disabled' };
  const pending = await db.as('hub_worker', null, async tx => (await tx.query(
    `select o.id, o.client_account_id, o.event_type, o.idempotency_key, o.payload, o.attempts, c.stackltr_workspace_id, c.stackltr_company_id
     from hub.stackltr_outbox o join hub.client_accounts c on c.id = o.client_account_id
     where o.status = 'pending' order by o.created_at limit $1`, [limit])).rows);
  let sent = 0;
  let failed = 0;
  for (const event of pending) {
    // A client that is not linked keeps its events until an admin links it.
    if (!event.stackltr_company_id) continue;
    let code = null;
    try {
      await stackltr.sendEvent(EVENT_PATHS[event.event_type], {
        type: event.event_type, idempotency_key: event.idempotency_key,
        workspace_id: event.stackltr_workspace_id, company_id: event.stackltr_company_id, data: event.payload
      });
    } catch (error) {
      code = safeCode(error);
    }
    const attempts = event.attempts + 1;
    // Rejected credentials or permissions need a person, so stop retrying those.
    const giveUp = code && (attempts >= MAX_ATTEMPTS || code === 'auth_failed' || code === 'permission_required');
    const status = code ? (giveUp ? 'failed' : 'pending') : 'sent';
    await db.as('hub_worker', null, async tx => {
      await tx.query(
        `update hub.stackltr_outbox set status = $2, attempts = $3, last_error_code = $4, sent_at = case when $2 = 'sent' then now() end where id = $1`,
        [event.id, status, attempts, code]);
      await writeAudit(tx, {
        action: 'stackltr.deliver', outcome: code ? 'failure' : 'success', clientId: event.client_account_id,
        entityType: 'stackltr_outbox', entityId: event.id, metadata: { event: event.event_type, code, attempts }
      });
    });
    if (code) failed += 1;
    else sent += 1;
  }
  return { sent, failed };
}
