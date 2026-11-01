const SENSITIVE_KEY = /pass|secret|token|credential|authorization|cookie|api[-_]?key|private|ciphertext|\bdek\b|session/i;

// Audit metadata is never a place for secrets, even if a caller passes one by mistake.
export function redact(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, depth + 1)]));
  }
  if (typeof value === 'string' && value.length > 500) return value.slice(0, 500) + '…';
  return value;
}

// Written in the same transaction as the change it describes, so neither can
// commit without the other.
export async function writeAudit(tx, entry) {
  const actorType = entry.actorType ?? (entry.staffId ? 'staff' : 'system');
  await tx.query(
    `insert into hub.audit_log (actor_type, actor_staff_id, action, outcome, entity_type, entity_id,
       client_account_id, request_id, metadata, prev_hash, entry_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '', '')`,
    [actorType, entry.staffId ?? null, entry.action, entry.outcome ?? 'success', entry.entityType ?? null,
      entry.entityId ?? null, entry.clientId ?? null, entry.requestId ?? null, JSON.stringify(redact(entry.metadata ?? {}))]
  );
}

// Standard entry for a change made by the signed-in staff member.
export const auditStaff = (tx, ctx, action, details = {}) =>
  writeAudit(tx, { staffId: ctx.staff.id, requestId: ctx.requestId, action, ...details });
