import { z } from 'zod';
import { invalid } from './errors.js';

const emptyToNull = value => (typeof value === 'string' && value.trim() === '' ? null : value);
const text = (min, max) => z.string().trim().min(min).max(max);
const optionalText = max => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
const optionalUuid = z.preprocess(emptyToNull, z.string().uuid().nullable().optional());
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date').refine(value => !Number.isNaN(Date.parse(value)), 'Use a valid date');
const optionalDate = z.preprocess(emptyToNull, dateOnly.nullable().optional());
// Date-time inputs have no zone, and the forms label them as UTC. An empty value
// stays undefined so it fails, because coercing null would produce 1970.
const dateTime = z.preprocess(value => {
  if (typeof value !== 'string' || value.trim() === '') return value || undefined;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00Z` : value;
}, z.coerce.date({ message: 'Use a valid date and time' }));
const notFuture = dateTime.refine(value => value.getTime() <= Date.now() + 5 * 60 * 1000, 'This cannot be in the future');
const optionalInt = (min, max) => z.preprocess(emptyToNull, z.coerce.number().int().min(min).max(max).nullable().optional());

// Normalizes a site address and refuses forms that smuggle credentials or use
// non-web schemes. Reachability is enforced later by the outbound client.
export function normalizeWebUrl(value, { httpsOnly = false } = {}) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!(url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:'))) return null;
  if (url.username || url.password || !url.hostname.includes('.')) return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  return url.href.replace(/\/$/, '');
}

const webUrl = z.string().trim().max(2048).transform((value, ctx) => {
  const normalized = normalizeWebUrl(value);
  if (!normalized) {
    ctx.addIssue({ code: 'custom', message: 'Enter a full web address, such as https://www.example.com' });
    return z.NEVER;
  }
  return normalized;
});

export const schemas = {
  client: z.object({
    display_name: text(1, 160),
    status: z.enum(['active', 'inactive']).default('active'),
    stackltr_workspace_id: optionalUuid,
    stackltr_company_id: optionalUuid,
    stackltr_billing_ref: optionalText(120)
  }).refine(value => Boolean(value.stackltr_workspace_id) === Boolean(value.stackltr_company_id), {
    path: ['stackltr_company_id'], message: 'Enter both the StackLTR workspace ID and company ID, or neither'
  }),
  plan: z.object({
    name: text(1, 120),
    description: z.string().trim().max(2000).default(''),
    maintenance_interval_days: optionalInt(1, 366),
    stackltr_billing_ref: optionalText(120)
  }),
  website: z.object({
    client_account_id: z.string().uuid('Choose a client'),
    display_name: text(1, 160),
    primary_url: webUrl,
    cms_platform: z.enum(['wordpress', 'shopify', 'wix', 'squarespace', 'joomla', 'other'], { message: 'Choose a platform' }),
    cms_other_name: optionalText(80),
    hosting_provider: optionalText(120),
    service_plan_id: optionalUuid,
    lifecycle: z.enum(['active', 'paused', 'offboarded']).default('active'),
    notes: z.string().max(4000).default('')
  }).transform(value => ({ ...value, cms_other_name: value.cms_platform === 'other' ? value.cms_other_name ?? null : null })),
  connection: z.object({
    adapter_key: z.enum(['wordpress', 'shopify', 'wix', 'squarespace', 'joomla']),
    base_url: optionalText(2048),
    auth_type: text(1, 40),
    site_id: optionalText(80),
    account_id: optionalText(80)
  }),
  task: z.object({
    website_id: z.string().uuid('Choose a website'),
    title: text(1, 160),
    details: z.string().max(4000).default(''),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    assignee_id: optionalUuid,
    due_on: optionalDate,
    stackltr_request_id: optionalUuid
  }),
  taskUpdate: z.object({
    status: z.enum(['open', 'in_progress', 'blocked', 'cancelled']).optional(),
    assignee_id: optionalUuid
  }),
  taskComplete: z.object({ completion_notes: text(3, 4000) }),
  schedule: z.object({
    website_id: z.string().uuid(),
    title: text(1, 160),
    interval_days: z.coerce.number().int().min(1).max(366),
    next_due_on: dateOnly,
    default_assignee_id: optionalUuid
  }),
  history: z.object({
    website_id: z.string().uuid(),
    kind: z.enum(['maintenance', 'security', 'backup', 'restore', 'connection', 'other']),
    summary: text(3, 4000),
    performed_at: notFuture
  }),
  monitoringCheck: z.object({
    website_id: z.string().uuid(),
    kind: z.enum(['uptime', 'ssl']),
    interval_minutes: z.coerce.number().int().min(5).max(10080).default(60)
  }),
  securityReview: z.object({
    website_id: z.string().uuid(),
    scope: text(3, 1000),
    outcome: z.enum(['no_findings', 'findings', 'incomplete']),
    summary: text(3, 4000),
    evidence_ref: optionalText(500),
    reviewed_at: notFuture,
    next_due_on: optionalDate
  }),
  backupSource: z.object({
    website_id: z.string().uuid(),
    provider: text(1, 80),
    label: text(1, 160),
    expected_interval_hours: optionalInt(1, 8760)
  }),
  backupRun: z.object({
    source_id: z.string().uuid(),
    status: z.enum(['succeeded', 'failed', 'unknown']),
    finished_at: notFuture,
    size_bytes: optionalInt(0, Number.MAX_SAFE_INTEGER),
    artifact_ref: optionalText(500)
  }),
  restoreVerification: z.object({
    backup_run_id: z.string().uuid(),
    target_environment: z.enum(['isolated', 'staging', 'production']),
    outcome: z.enum(['passed', 'partial', 'failed']),
    checks_performed: text(10, 4000),
    evidence_ref: optionalText(500),
    performed_at: notFuture
  }).refine(value => value.outcome !== 'passed' || (value.evidence_ref?.length ?? 0) >= 3, {
    path: ['evidence_ref'], message: 'A passed restore needs a reference to its evidence'
  }),
  staff: z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    display_name: text(1, 120),
    role: z.enum(['owner', 'admin', 'technician', 'billing', 'viewer'])
  }),
  staffUpdate: z.object({
    role: z.enum(['owner', 'admin', 'technician', 'billing', 'viewer']),
    status: z.enum(['active', 'disabled'])
  }),
  assignment: z.object({ staff_id: z.string().uuid(), client_account_id: z.string().uuid() }),
  operationRequest: z.object({
    connection_id: z.string().uuid(),
    operation_key: text(1, 60),
    reason: text(5, 1000)
  })
};

export const isUuid = value => z.string().uuid().safeParse(value).success;

export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] ?? '_';
    fields[key] ??= issue.message;
  }
  throw invalid(fields);
}
