import { randomUUID } from 'node:crypto';
import { getAdapter } from '../adapters/index.js';
import { AdapterError, createPlatformClient, safeCode, summarizeSections } from '../adapters/framework.js';
import { auditStaff, writeAudit } from '../audit.js';
import { requirePermission } from '../authz.js';
import { one } from '../db.js';
import { conflict, forbidden, invalid, notFound, unavailable } from '../errors.js';
import { isUuid, normalizeWebUrl, parse, schemas } from '../validation.js';

const asStaff = (ctx, fn) => ctx.db.as('hub_app', ctx.staff.id, fn);
const TIMEOUT_MS = 12000;

// Safe columns only. No code path selects credential material for a page or API.
const CONNECTION_COLUMNS = `c.id, c.website_id, c.client_account_id, c.adapter_key, c.base_url, c.auth_type, c.settings,
  c.status, c.granted_permissions, c.last_checked_at, c.last_error_code, c.not_before, c.created_at`;

export async function listConnections(ctx, websiteId) {
  requirePermission(ctx.staff, 'connection.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select ${CONNECTION_COLUMNS},
       (select max(success.captured_at) from hub.platform_snapshots success where success.connection_id=c.id and success.outcome='ok') as last_successful_at,
       (select jsonb_build_object('outcome', s.outcome, 'error_code', s.error_code, 'captured_at', s.captured_at, 'data', s.data)
          from hub.platform_snapshots s where s.connection_id = c.id order by s.captured_at desc limit 1) as latest_snapshot
     from hub.platform_connections c where c.website_id = $1 order by c.adapter_key`, [websiteId])).rows);
}

// Owners and admins may see that a credential exists. Nobody sees what it is.
export async function hasActiveCredential(ctx, connectionId) {
  requirePermission(ctx.staff, 'credential.write');
  return asStaff(ctx, async tx => {
    const row = one(await tx.query(
      `select id, created_at, key_id from hub.connection_credentials where connection_id = $1 and revoked_at is null`, [connectionId]));
    return row ? { id: row.id, created_at: row.created_at } : null;
  });
}

export async function createConnection(ctx, websiteId, input) {
  requirePermission(ctx.staff, 'connection.write');
  if (!isUuid(websiteId)) throw notFound();
  const data = parse(schemas.connection, input);
  const adapter = getAdapter(data.adapter_key);
  if (!adapter.authTypes.some(type => type.key === data.auth_type)) throw invalid({ auth_type: 'Choose a supported authentication type.' });

  const settings = {};
  for (const field of adapter.settingsFields ?? []) {
    const value = data[field.name];
    if (value) settings[field.name] = value;
    else if (field.required) throw invalid({ [field.name]: `${field.label} is required.` });
  }
  const baseUrl = adapter.fixedBaseUrl ?? normalizeWebUrl(data.base_url ?? '', { httpsOnly: true });
  if (!baseUrl) throw invalid({ base_url: 'Enter the https address of the site.' });
  const problem = adapter.validateConnection(baseUrl, settings);
  if (problem) throw invalid(adapter.fixedBaseUrl ? { site_id: problem } : { base_url: problem });

  try {
    return await asStaff(ctx, async tx => {
      const website = one(await tx.query(`select id, client_account_id from hub.managed_websites where id = $1`, [websiteId]));
      if (!website) throw notFound();
      const row = one(await tx.query(
        `insert into hub.platform_connections (client_account_id, website_id, adapter_key, base_url, auth_type, settings, created_by)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7) returning id`,
        [website.client_account_id, websiteId, adapter.key, baseUrl, data.auth_type, JSON.stringify(settings), ctx.staff.id]));
      await auditStaff(tx, ctx, 'connection.create', { entityType: 'platform_connection', entityId: row.id, clientId: website.client_account_id, metadata: { adapter: adapter.key, auth_type: data.auth_type } });
      return row;
    });
  } catch (error) {
    if (error?.code === '23505') throw conflict('This website already has that connection.');
    throw error;
  }
}

async function visibleConnection(tx, id) {
  if (!isUuid(id)) throw notFound();
  const row = one(await tx.query(`select ${CONNECTION_COLUMNS} from hub.platform_connections c where c.id = $1`, [id]));
  if (!row) throw notFound();
  return row;
}

export async function storeCredential(ctx, connectionId, input) {
  requirePermission(ctx.staff, 'credential.write');
  if (!ctx.vault.enabled) throw unavailable('Credential storage is turned off for this environment.');
  return asStaff(ctx, async tx => {
    const connection = await visibleConnection(tx, connectionId);
    const authType = getAdapter(connection.adapter_key).authTypes.find(type => type.key === connection.auth_type);
    const secret = {};
    for (const field of authType.fields) {
      const value = input[field.name];
      if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
        // The error names the field and never repeats what was typed.
        throw invalid({ [field.name]: `${field.label} is required.` });
      }
      secret[field.name] = value.trim();
    }
    const id = randomUUID();
    const sealed = ctx.vault.encrypt(connection.id, id, secret);
    await tx.query(
      `update hub.connection_credentials set revoked_at = now(), revoked_by = $2 where connection_id = $1 and revoked_at is null`,
      [connection.id, ctx.staff.id]);
    await tx.query(
      `insert into hub.connection_credentials (id, client_account_id, connection_id, key_id, wrapped_dek, dek_nonce, dek_tag, ciphertext, nonce, auth_tag, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, connection.client_account_id, connection.id, sealed.key_id, sealed.wrapped_dek, sealed.dek_nonce, sealed.dek_tag, sealed.ciphertext, sealed.nonce, sealed.auth_tag, ctx.staff.id]);
    await tx.query(`update hub.platform_connections set status = 'not_connected', last_error_code = null, updated_at = now() where id = $1`, [connection.id]);
    await auditStaff(tx, ctx, 'credential.store', { entityType: 'platform_connection', entityId: connection.id, clientId: connection.client_account_id, metadata: { adapter: connection.adapter_key } });
    return { id: connection.id };
  });
}

export async function revokeCredential(ctx, connectionId) {
  requirePermission(ctx.staff, 'credential.write');
  return asStaff(ctx, async tx => {
    const connection = await visibleConnection(tx, connectionId);
    await tx.query(
      `update hub.connection_credentials set revoked_at = now(), revoked_by = $2 where connection_id = $1 and revoked_at is null`,
      [connection.id, ctx.staff.id]);
    await tx.query(`update hub.platform_connections set status = 'not_connected', updated_at = now() where id = $1`, [connection.id]);
    await auditStaff(tx, ctx, 'credential.revoke', { entityType: 'platform_connection', entityId: connection.id, clientId: connection.client_account_id });
    return { id: connection.id };
  });
}

// Reads ciphertext through hub_worker, the only role allowed to. Authorization
// has already happened under hub_app, and each decryption leaves an audit entry.
async function unsealedSecret(ctx, connection, purpose) {
  return ctx.db.as('hub_worker', null, async tx => {
    const row = one(await tx.query(
      `select * from hub.connection_credentials where connection_id = $1 and revoked_at is null`, [connection.id]));
    if (!row) return null;
    const secret = ctx.vault.decrypt(row);
    await writeAudit(tx, {
      staffId: ctx.staff?.id ?? null, requestId: ctx.requestId, action: 'credential.use', entityType: 'platform_connection',
      entityId: connection.id, clientId: connection.client_account_id, metadata: { purpose }
    });
    return secret;
  });
}

async function authorizedClient(ctx, connection, adapter, purpose) {
  if (!ctx.vault.enabled) return { code: 'no_credential' };
  const secret = await unsealedSecret(ctx, connection, purpose);
  if (!secret) return { code: 'no_credential' };
  const options = { baseUrl: connection.base_url, http: ctx.http, timeoutMs: TIMEOUT_MS };
  const authHeaders = adapter.prepareAuth
    ? await adapter.prepareAuth(secret.reveal(), options)
    : adapter.authHeaders(secret.reveal(), connection.settings);
  return { client: createPlatformClient({ ...options, authHeaders }) };
}

// Asks the platform what it can report. A failure is recorded as a failure with a
// safe code. It never becomes a healthy or unhealthy claim about the website.
export async function runConnectionCheck(ctx, connectionId, { mode = 'full' } = {}) {
  requirePermission(ctx.staff, 'connection.check');
  const connection = await asStaff(ctx, tx => visibleConnection(tx, connectionId));
  const adapter = getAdapter(connection.adapter_key);
  let outcome;
  let code;
  let sections = {};
  try {
    // Honour a platform's request to wait, rather than be blocked or banned.
    if (connection.not_before && new Date(connection.not_before) > new Date()) throw new AdapterError('backing_off');
    const prepared = await authorizedClient(ctx, connection, adapter, 'connection_check');
    if (prepared.code) {
      outcome = 'failed';
      code = prepared.code;
    } else {
      sections = await (mode === 'test' ? adapter.testConnection : adapter.check)(prepared.client, { settings: connection.settings });
      ({ outcome, code } = summarizeSections(sections));
    }
  } catch (error) {
    outcome = 'failed';
    code = safeCode(error);
  }
  const status = { ok: 'connected', partial: 'partial', failed: 'failed' }[outcome];
  await ctx.db.as('hub_worker', null, async tx => {
    await tx.query(
      `insert into hub.platform_snapshots (client_account_id, connection_id, outcome, error_code, data, requested_by)
       values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [connection.client_account_id, connection.id, outcome, code, JSON.stringify(sections), ctx.staff.id]);
    await tx.query(
      `update hub.platform_connections set status = $2, last_checked_at = now(), last_error_code = $3, updated_at = now(),
         granted_permissions = coalesce($4::jsonb, granted_permissions),
         not_before = case when $5::int is not null then now() + make_interval(secs => $5::int) else not_before end where id = $1`,
      [connection.id, status, code, sections.granted_scopes?.status === 'ok' ? JSON.stringify(sections.granted_scopes.data) : null,
        Object.values(sections).find(item => item.retryAfterSeconds)?.retryAfterSeconds ?? null]);
    // Only a version the platform itself reported is labelled as coming from the API.
    const reported = sections.extension_inventory?.data?.core_version;
    if (reported) {
      await tx.query(
        `update hub.managed_websites set cms_version = $2, cms_version_source = 'api', cms_version_recorded_at = now() where id = $1`, [connection.website_id, reported]);
    }
    await writeAudit(tx, {
      staffId: ctx.staff.id, requestId: ctx.requestId, action: 'connection.check', outcome: outcome === 'failed' ? 'failure' : 'success',
      entityType: 'platform_connection', entityId: connection.id, clientId: connection.client_account_id,
      metadata: { adapter: adapter.key, mode, outcome, code }
    });
  });
  return { outcome, code, sections };
}

// Approved operations --------------------------------------------------------

export async function listOperations(ctx, websiteId) {
  requirePermission(ctx.staff, 'connection.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select o.id, o.connection_id, o.operation_key, o.params, o.reason,
       case when o.status = 'approved' and exists (select 1 from hub.operation_execution_claims ec where ec.operation_id = o.id)
         then 'executing' else o.status end as status, o.result_code, o.created_at, o.decided_at, o.executed_at,
       o.requested_by, r.display_name as requested_by_name, d.display_name as decided_by_name, c.adapter_key
     from hub.operation_requests o
     join hub.platform_connections c on c.id = o.connection_id
     join hub.staff_users r on r.id = o.requested_by
     left join hub.staff_users d on d.id = o.decided_by
     where c.website_id = $1 order by o.created_at desc limit 50`, [websiteId])).rows);
}

export async function requestOperation(ctx, input) {
  requirePermission(ctx.staff, 'operation.request');
  const data = parse(schemas.operationRequest, input);
  return asStaff(ctx, async tx => {
    const connection = await visibleConnection(tx, data.connection_id);
    const operation = getAdapter(connection.adapter_key).operations.find(item => item.key === data.operation_key);
    if (!operation) throw invalid({ operation_key: 'This platform does not offer that operation.' });
    const params = parse(operation.params, input);
    const row = one(await tx.query(
      `insert into hub.operation_requests (client_account_id, connection_id, operation_key, params, reason, requested_by)
       values ($1, $2, $3, $4::jsonb, $5, $6) returning id`,
      [connection.client_account_id, connection.id, operation.key, JSON.stringify(params), data.reason, ctx.staff.id]));
    await auditStaff(tx, ctx, 'operation.request', { entityType: 'operation_request', entityId: row.id, clientId: connection.client_account_id, metadata: { operation: operation.key, params } });
    return row;
  });
}

export async function decideOperation(ctx, id, decision) {
  requirePermission(ctx.staff, 'operation.decide');
  if (!isUuid(id) || !['approved', 'rejected'].includes(decision)) throw notFound();
  return asStaff(ctx, async tx => {
    const operation = one(await tx.query(`select id, client_account_id, status, requested_by from hub.operation_requests where id = $1 for update`, [id]));
    if (!operation) throw notFound();
    if (operation.status !== 'requested') throw conflict('This request has already been decided.');
    if (decision === 'approved' && operation.requested_by === ctx.staff.id) throw forbidden('A second person must approve your request.');
    await tx.query(`update hub.operation_requests set status = $2, decided_by = $3, decided_at = now() where id = $1`, [id, decision, ctx.staff.id]);
    await auditStaff(tx, ctx, `operation.${decision === 'approved' ? 'approve' : 'reject'}`, { entityType: 'operation_request', entityId: id, clientId: operation.client_account_id });
    return { id };
  });
}

export async function executeOperation(ctx, id) {
  requirePermission(ctx.staff, 'operation.execute');
  if (!ctx.operationsEnabled) throw unavailable('Live maintenance operations are turned off for this environment.');
  if (!isUuid(id)) throw notFound();
  const claimToken = randomUUID();
  const { operation, connection } = await asStaff(ctx, async tx => {
    const op = one(await tx.query(`select * from hub.operation_requests where id = $1 for update`, [id]));
    if (!op) throw notFound();
    if (op.status !== 'approved') throw conflict('Only an approved request can be run.');
    const connection = await visibleConnection(tx, op.connection_id);
    const claimed = one(await tx.query(
      `insert into hub.operation_execution_claims (operation_id, claim_token, claimed_by) values ($1, $2, $3)
       on conflict (operation_id) do nothing returning operation_id`, [id, claimToken, ctx.staff.id]));
    if (!claimed) throw conflict('This operation has already been claimed. Do not retry an uncertain outcome.');
    await auditStaff(tx, ctx, 'operation.claim', { entityType: 'operation_request', entityId: id, clientId: op.client_account_id });
    return { operation: op, connection };
  });
  const adapter = getAdapter(connection.adapter_key);
  const definition = adapter.operations.find(item => item.key === operation.operation_key);
  if (!definition) throw conflict('This operation is no longer offered.');
  let code = null;
  try {
    const prepared = await authorizedClient(ctx, connection, adapter, `operation:${definition.key}`);
    if (prepared.code) code = prepared.code;
    else await adapter.runOperation(prepared.client, definition.key, definition.params.parse(operation.params));
  } catch (error) {
    code = safeCode(error);
  }
  await ctx.db.as('hub_worker', null, async tx => {
    const finalized = await tx.query(
      `update hub.operation_requests set status = $2, executed_at = now(), result_code = $3 where id = $1
         and status = 'approved' and exists (select 1 from hub.operation_execution_claims ec where ec.operation_id = $1 and ec.claim_token = $4)
         returning id`,
      [id, code ? 'failed' : 'executed', code, claimToken]);
    if (!finalized.rows.length) throw conflict('The execution claim could not be finalized. Reconcile before taking further action.');
    await tx.query(
      `insert into hub.service_history (client_account_id, website_id, kind, summary, source, performed_by)
       values ($1, $2, 'maintenance', $3, 'system', $4)`,
      [connection.client_account_id, connection.website_id, `${definition.label} ${code ? 'failed' : 'completed'} through the ${adapter.label} API.`, ctx.staff.id]);
    await writeAudit(tx, {
      staffId: ctx.staff.id, requestId: ctx.requestId, action: 'operation.execute', outcome: code ? 'failure' : 'success',
      entityType: 'operation_request', entityId: id, clientId: connection.client_account_id, metadata: { operation: definition.key, code }
    });
  });
  return { id, code };
}

// Rewrap only the data key: ciphertext, credential identity and nonce stay intact.
export async function rewrapCredential(ctx,connectionId){
 requirePermission(ctx.staff,'credential.write');
 if(!ctx.vault.enabled)throw unavailable('Credential storage is turned off for this environment.');
 const connection=await asStaff(ctx,tx=>visibleConnection(tx,connectionId));
 return ctx.db.as('hub_worker',null,async tx=>{
  const row=one(await tx.query('select * from hub.connection_credentials where connection_id=$1 and revoked_at is null for update',[connection.id]));
  if(!row)throw notFound();const wrapped=ctx.vault.rewrap(row);
  await tx.query('update hub.connection_credentials set key_id=$2,wrapped_dek=$3,dek_nonce=$4,dek_tag=$5 where id=$1',[row.id,wrapped.key_id,wrapped.wrapped_dek,wrapped.dek_nonce,wrapped.dek_tag]);
  await auditStaff(tx,ctx,'credential.rewrap',{clientId:connection.client_account_id,entityType:'platform_connection',entityId:connection.id});
  return {id:connection.id};
 });
}
