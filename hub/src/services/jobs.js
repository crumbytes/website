import { writeAudit } from '../audit.js';
import { OutboundError } from '../safe-http.js';
import { deliverOutbox } from '../stackltr.js';

const CODE = error => (error instanceof OutboundError ? error.code : 'internal_error');

// A result row is only written when a probe truly ran. If probing is turned off,
// nothing is recorded and the check keeps showing as unknown.
export async function probeCheck(http, check) {
  if (check.kind === 'ssl') {
    try {
      const certificate = await http.tlsCertificate({ url: check.target_url });
      return {
        outcome: certificate.trusted ? 'up' : 'error',
        tls_valid_to: certificate.validTo,
        tls_issuer: certificate.issuer?.slice(0, 200) ?? null,
        error_code: certificate.trusted ? null : 'tls_untrusted'
      };
    } catch (error) {
      return { outcome: 'error', error_code: CODE(error) };
    }
  }
  try {
    const response = await http.request({ url: check.target_url, allowHttp: true, maxBytes: 512 * 1024 });
    // A redirect shows the server answered. It is not followed.
    return {
      outcome: response.status < 500 ? 'up' : 'down',
      http_status: response.status,
      response_ms: response.elapsedMs
    };
  } catch (error) {
    const code = CODE(error);
    // A refused target is a configuration problem, not evidence the site is down.
    return { outcome: code === 'blocked_target' ? 'error' : 'down', error_code: code };
  }
}

export async function runDueMonitoring({ db, http, outboundEnabled, now = () => new Date(), limit = 50 }) {
  if (!outboundEnabled) return { ran: 0, skipped: 'outbound_disabled' };
  const due = await db.as('hub_worker', null, async tx => (await tx.query(
    `select m.id, m.client_account_id, m.kind, m.target_url, m.interval_minutes
     from hub.monitoring_checks m join hub.managed_websites w on w.id = m.website_id
     where m.enabled and w.lifecycle = 'active' and m.next_run_at <= $1 order by m.next_run_at limit $2`, [now(), limit])).rows);
  for (const check of due) {
    const result = await probeCheck(http, check);
    await db.as('hub_worker', null, async tx => {
      await tx.query(
        `insert into hub.monitoring_results (client_account_id, check_id, outcome, http_status, response_ms, tls_valid_to, tls_issuer, error_code, checked_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [check.client_account_id, check.id, result.outcome, result.http_status ?? null, result.response_ms ?? null,
          result.tls_valid_to ?? null, result.tls_issuer ?? null, result.error_code ?? null, now()]);
      await tx.query(`update hub.monitoring_checks set next_run_at = $2 where id = $1`,
        [check.id, new Date(now().getTime() + check.interval_minutes * 60000)]);
    });
  }
  if (due.length) {
    await db.as('hub_worker', null, tx => writeAudit(tx, { action: 'monitoring.run', metadata: { checks: due.length } }));
  }
  return { ran: due.length };
}

export async function runJobs(deps) {
  const monitoring = await runDueMonitoring(deps);
  const stackltr = await deliverOutbox(deps);
  return { monitoring, stackltr };
}
