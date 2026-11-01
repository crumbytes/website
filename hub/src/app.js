import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { ERROR_MESSAGES, safeCode } from './adapters/framework.js';
import { ADAPTERS, OTHER_PLATFORM } from './adapters/index.js';
import { writeAudit } from './audit.js';
import { createAuth, LoginDenied, safeEqual } from './auth.js';
import { can, requirePermission } from './authz.js';
import { HubError } from './errors.js';
import { createLogger } from './logger.js';
import { createRateLimiter } from './rate-limit.js';
import { runJobs } from './services/jobs.js';
import * as connections from './services/connections.js';
import * as insights from './services/insights.js';
import * as inventory from './services/inventory.js';
import * as records from './services/records.js';
import { barePage } from './ui/layout.js';
import * as pages from './ui/pages.js';
import * as pages2 from './ui/pages2.js';
import { HUB_CSS } from './ui/styles.js';

const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const PUBLIC_PATHS = [/^\/healthz$/, /^\/assets\//, /^\/login$/, /^\/auth\//, /^\/internal\//];
const isApi = path => path.startsWith('/api/');

// Only same-site paths, so a crafted form cannot redirect staff elsewhere.
const safeReturn = (value, fallback) => (typeof value === 'string' && /^\/(?![/\\])[A-Za-z0-9/_-]*$/.test(value) ? value : fallback);

export function createApp(deps) {
  const { db, config, vault, http, stackltr, email, backupProviders, logger = createLogger(), fetchImpl, now } = deps;
  const auth = createAuth({ db, config, fetchImpl, now });
  const limiter = createRateLimiter({ db, now });

  // The header is honoured only when configured, because a client can forge it otherwise.
  const clientKey = c => (config.trustedIpHeader ? c.req.header(config.trustedIpHeader)?.split(',')[0]?.trim() : null) ?? 'shared';
  const limited = async (c, kind, identity) => {
    if (!config.rateLimitsEnabled) return null;
    const { allowed, retryAfter } = await limiter.hit(kind, identity);
    if (allowed) return null;
    logger.warn('hub.rate_limited', { kind, requestId: c.get('requestId') });
    c.header('Retry-After', String(retryAfter));
    return isApi(c.req.path) ? c.json({ error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.' } }, 429) : c.text('Too many requests. Try again shortly.', 429);
  };
  const app = new Hono();

  const contextOf = c => ({
    db, vault, http, operationsEnabled: config.operationsEnabled,
    staff: c.get('staff'), requestId: c.get('requestId')
  });
  const viewOf = c => ({
    staff: c.get('staff'), csrfToken: c.get('csrfToken'), sessionId: c.get('sessionId'),
    unread: c.get('unread'), environment: config.environment
  });
  const pageConfig = {
    outboundEnabled: config.outboundEnabled,
    credentialStorageEnabled: config.credentials.storageEnabled,
    operationsEnabled: config.operationsEnabled,
    mfaRequired: Boolean(config.oidc.requiredAmr)
  };

  app.use('*', async (c, next) => {
    c.set('requestId', randomBytes(9).toString('base64url'));
    const started = performance.now();
    await next();
    // The route pattern only: IDs and query strings stay out of the logs.
    logger.info('hub.request', {
      requestId: c.get('requestId'), method: c.req.method, route: c.req.routePath, status: c.res.status,
      ms: Math.round(performance.now() - started), staffId: c.get('staff')?.id
    });
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    // Not no-referrer: that makes browsers send Origin: null on same-origin form
    // posts, which the CSRF origin check would then have to refuse.
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (!config.isDev) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!c.req.path.startsWith('/assets/')) c.header('Cache-Control', 'no-store');
  });
  app.use('*', bodyLimit({ maxSize: 128 * 1024, onError: c => c.text('Request too large.', 413) }));

  // Default deny: every path needs a session unless it is on the short public list.
  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_PATHS.some(pattern => pattern.test(path))) return next();
    const resolved = await auth.resolveSession(getCookie(c, config.session.cookieName));
    if (!resolved) {
      if (isApi(path)) return c.json({ error: { code: 'unauthenticated', message: 'Sign in is required.' } }, 401);
      if (c.req.method !== 'GET') return c.text('Sign in is required.', 401);
      return c.redirect('/login');
    }
    c.set('staff', resolved.staff);
    c.set('csrfToken', resolved.csrfToken);
    c.set('sessionId', resolved.sessionId);

    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      const fetchSite = c.req.header('sec-fetch-site');
      if ((origin && origin !== config.origin) || (!origin && fetchSite && fetchSite !== 'same-origin')) {
        await recordDenied(c, 'csrf.origin');
        return denyCsrf(c);
      }
      let token = c.req.header('x-csrf-token');
      if (!token && !isApi(path)) {
        const form = await c.req.parseBody();
        c.set('form', form);
        token = form._csrf;
      }
      if (typeof token !== 'string' || !safeEqual(token, resolved.csrfToken)) {
        await recordDenied(c, 'csrf.token');
        return denyCsrf(c);
      }
      const blocked = await limited(c, 'write', resolved.staff.id);
      if (blocked) return blocked;
    } else if (!isApi(path)) {
      c.set('unread', await insights.unreadCount({ db, staff: resolved.staff }));
    }
    return next();
  });

  const denyCsrf = c => (isApi(c.req.path)
    ? c.json({ error: { code: 'csrf_failed', message: 'The request could not be verified.' } }, 403)
    : c.html(errorPage('That request could not be verified', 'Reload the page and try again.'), 403));

  const recordDenied = (c, reason) => db.as('hub_auth', null, tx => writeAudit(tx, {
    staffId: c.get('staff').id, action: 'request.denied', outcome: 'denied', requestId: c.get('requestId'), metadata: { reason }
  }));

  const errorPage = (title, text, requestId) => barePage({
    title, body: html`<h1>${title}</h1><p class="muted">${text}</p>${requestId ? html`<p class="note">Reference: ${requestId}</p>` : ''}<a class="btn quiet" href="/">Back to the hub</a>`
  });

  app.onError(async (error, c) => {
    const requestId = c.get('requestId');
    if (error instanceof HubError) {
      if (error.status === 403 && c.get('staff')) {
        await recordDenied(c, error.code).catch(() => {});
      }
      if (isApi(c.req.path)) {
        return c.json({ error: { code: error.code, message: error.message, fields: error.fields, request_id: requestId } }, error.status);
      }
      return c.html(errorPage(error.status === 404 ? 'Not found' : 'That could not be completed', error.message, requestId), error.status);
    }
    // Database and driver messages can contain values, so only the type is logged.
    logger.error('hub.request_failed', { requestId, path: c.req.routePath, name: error?.name, code: error?.code });
    if (isApi(c.req.path)) return c.json({ error: { code: 'internal_error', message: 'Something went wrong.', request_id: requestId } }, 500);
    return c.html(errorPage('Something went wrong', 'The problem has been logged.', requestId), 500);
  });

  app.notFound(c => (isApi(c.req.path)
    ? c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
    : c.html(errorPage('Not found', 'That page does not exist.'), 404)));

  // Public routes ------------------------------------------------------------

  app.get('/healthz', c => c.json({ ok: true }));
  app.get('/assets/hub.css', c => {
    c.header('Content-Type', 'text/css; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(HUB_CSS);
  });

  const cookieOptions = { httpOnly: true, secure: config.session.secure, sameSite: 'Lax', path: '/' };

  app.get('/login', c => c.html(barePage({
    title: 'Sign in',
    body: html`<h1>Staff sign in</h1><p class="muted">This is a private CrumByte system. Access is limited to provisioned staff, and activity is logged.</p>
      <a class="btn" href="/auth/start">Sign in with your work account</a>`
  })));

  app.get('/auth/start', async c => {
    const blocked = await limited(c, 'login', clientKey(c));
    if (blocked) return blocked;
    try {
      const { redirectUrl, binding } = await auth.beginLogin();
      setCookie(c, config.session.bindingCookieName, binding, { ...cookieOptions, maxAge: 600 });
      return c.redirect(redirectUrl);
    } catch (error) {
      logger.error('hub.login_start_failed', { name: error?.name, reason: error?.reason });
      return c.html(errorPage('Sign in is unavailable', 'The identity provider could not be reached. Try again shortly.'), 503);
    }
  });

  app.get('/auth/callback', async c => {
    const blocked = await limited(c, 'login', clientKey(c));
    if (blocked) return blocked;
    const binding = getCookie(c, config.session.bindingCookieName);
    deleteCookie(c, config.session.bindingCookieName, cookieOptions);
    try {
      const { sessionToken } = await auth.completeLogin({
        code: c.req.query('code'), state: c.req.query('state'), binding, requestId: c.get('requestId')
      });
      setCookie(c, config.session.cookieName, sessionToken, { ...cookieOptions, maxAge: config.session.absoluteMinutes * 60 });
      return c.redirect('/');
    } catch (error) {
      if (error instanceof LoginDenied) {
        return c.html(errorPage('Sign in was not completed', 'Your account may not have access to this system. Contact an administrator if you need it.', c.get('requestId')), 403);
      }
      logger.error('hub.login_failed', { name: error?.name, requestId: c.get('requestId') });
      return c.html(errorPage('Sign in is unavailable', 'Try again shortly.', c.get('requestId')), 503);
    }
  });

  // Scheduled work. Off unless a secret is configured, and otherwise indistinguishable from no route.
  app.post('/internal/jobs/run', async c => {
    const header = c.req.header('authorization') ?? '';
    if (!config.jobSecret) return c.notFound();
    const blocked = await limited(c, 'job', clientKey(c));
    if (blocked) return blocked;
    if (!safeEqual(header, `Bearer ${config.jobSecret}`)) return c.json({ error: { code: 'unauthenticated' } }, 401);
    const result = await runJobs({ db, http, stackltr, email, backupProviders, logger, baseUrl: config.baseUrl, outboundEnabled: config.outboundEnabled });
    return c.json({ ok: true, result });
  });

  // Page helpers -------------------------------------------------------------

  const formOf = async c => c.get('form') ?? c.req.parseBody();
  const noticeOf = c => pages.noticeFor(c.req.query('notice'));
  const withoutInternals = form => Object.fromEntries(Object.entries(form).filter(([key]) => !key.startsWith('_')));

  // A form post either redirects on success or re-renders with its errors.
  const formRoute = (path, handler, onInvalid, success) => {
    app.post(path, async c => {
      const form = await formOf(c);
      const input = withoutInternals(form);
      try {
        const target = await handler(contextOf(c), input, c);
        const destination = safeReturn(form._return, target);
        return c.redirect(`${destination}?notice=${success ?? 'saved'}`, 303);
      } catch (error) {
        if (error instanceof HubError && error.status < 500 && error.status !== 403 && error.status !== 404 && onInvalid) {
          return c.html(await onInvalid(c, {
            errors: error.fields ?? { _: error.message }, message: error.fields ? error.message : 'That could not be saved.',
            values: stripSecrets(input)
          }), error.status);
        }
        throw error;
      }
    });
  };

  const stripSecrets = input => Object.fromEntries(Object.entries(input).filter(([key]) => !/pass|secret|token|key/i.test(key)));

  // Overview -----------------------------------------------------------------

  app.get('/', async c => c.html(pages.overviewPage(viewOf(c), await records.getOverview(contextOf(c)))));

  // Clients ------------------------------------------------------------------

  // Live from StackLTR for the person viewing. A failure here never blocks the page,
  // and nothing read this way is written to the hub's database.
  const stackltrView = async (c, client) => {
    if (!stackltr?.enabled) return { enabled: false };
    const view = { enabled: true, query: c.req.query('stackltr_q') };
    try {
      if (client.stackltr_company_id) {
        view.company = (await stackltr.getCompany(client.stackltr_workspace_id, client.stackltr_company_id))?.company;
        view.requests = (await stackltr.listRequests(client.stackltr_workspace_id, client.stackltr_company_id))?.requests;
      }
      if (view.query && can(c.get('staff'), 'client.write')) view.results = (await stackltr.searchCompanies(view.query.slice(0, 100)))?.companies;
    } catch (error) {
      view.error = ERROR_MESSAGES[safeCode(error)] ?? ERROR_MESSAGES.internal_error;
    }
    return view;
  };

  const renderClients = async (c, state) => {
    const ctx = contextOf(c);
    return pages.clientsPage(viewOf(c), { clients: await records.listClients(ctx), plans: await records.listPlans(ctx), planTasks: await inventory.listPlanTasks(ctx), notice: noticeOf(c), state });
  };
  app.get('/clients', async c => c.html(await renderClients(c)));
  app.get('/clients/new', c => {
    requirePermission(c.get('staff'), 'client.write');
    return c.html(pages.clientFormPage(viewOf(c), { websites: [] }));
  });
  const renderClient = async (c, state) => {
    const ctx = contextOf(c);
    const client = await records.getClient(ctx, c.req.param('id'));
    const websites = await records.listWebsites(ctx, { client: client.id, lifecycle: 'all' });
    return pages.clientFormPage(viewOf(c), { client, websites, state, notice: noticeOf(c), stackltr: await stackltrView(c, client) });
  };
  app.get('/clients/:id', async c => c.html(await renderClient(c)));
  formRoute('/clients', async (ctx, input) => `/clients/${(await records.createClient(ctx, input)).id}`,
    (c, state) => pages.clientFormPage(viewOf(c), { websites: [], state }));
  formRoute('/clients/:id', async (ctx, input, c) => {
    await records.updateClient(ctx, c.req.param('id'), input);
    return `/clients/${c.req.param('id')}`;
  }, renderClient);
  formRoute('/plans', async (ctx, input) => {
    await records.createPlan(ctx, input);
    return '/clients';
  }, renderClients);

  // Websites -----------------------------------------------------------------

  const inventoryFiltersOf = c => ({
    search: c.req.query('q'), client: c.req.query('client'), platform: c.req.query('platform'),
    hosting: c.req.query('hosting'), monitoring: c.req.query('monitoring'), lifecycle: c.req.query('lifecycle')
  });

  app.get('/websites', async c => {
    const ctx = contextOf(c);
    const filters = inventoryFiltersOf(c);
    return c.html(pages.websitesPage(viewOf(c), {
      websites: await records.listWebsites(ctx, filters), filters, clients: await records.listClients(ctx),
      hosting: await inventory.listHostingProviders(ctx), notice: noticeOf(c)
    }));
  });
  const renderWebsiteForm = async (c, state) => {
    const ctx = contextOf(c);
    const id = c.req.param('id');
    return pages.websiteFormPage(viewOf(c), {
      clients: await records.listClients(ctx), plans: await records.listPlans(ctx),
      hosting: await inventory.listHostingProviders(ctx), owners: await records.listAssignableStaff(ctx),
      website: id ? await records.getWebsite(ctx, id) : undefined, state
    });
  };
  app.get('/websites/new', async c => {
    requirePermission(c.get('staff'), 'website.write');
    return c.html(await renderWebsiteForm(c));
  });
  app.get('/websites/:id/edit', async c => {
    requirePermission(c.get('staff'), 'website.write');
    return c.html(await renderWebsiteForm(c));
  });

  const renderWebsiteById = async (c, websiteId, state) => {
    const ctx = contextOf(c);
    const website = await records.getWebsite(ctx, websiteId);
    const id = website.id;
    const [tasks, schedules, checks, reviews, sources, runs, history, connectionList, operations, assignable, domains, plans, incidents, windows, findings, recovery, workLogs, uptime7, uptime30, uptime90] = await Promise.all([
      records.listTasks(ctx, { websiteId: id }), records.listSchedules(ctx, { websiteId: id }), records.listChecks(ctx, { websiteId: id }),
      records.listSecurityReviews(ctx, { websiteId: id }), records.listBackupSources(ctx, { websiteId: id }), records.listBackupRuns(ctx, id),
      records.listHistory(ctx, id), connections.listConnections(ctx, id), connections.listOperations(ctx, id), records.listAssignableStaff(ctx),
      inventory.listDomains(ctx, id), records.listPlans(ctx), insights.listIncidents(ctx, { websiteId: id }), insights.listMaintenanceWindows(ctx, id),
      insights.listFindings(ctx, { websiteId: id }), insights.listRecoveryRequests(ctx, id), records.listWorkLogs(ctx, id),
      insights.uptimeReport(ctx, { websiteId: id, days: 7 }), insights.uptimeReport(ctx, { websiteId: id, days: 30 }), insights.uptimeReport(ctx, { websiteId: id, days: 90 })
    ]);
    const credentials = {};
    if (can(ctx.staff, 'credential.write')) {
      for (const connection of connectionList) credentials[connection.id] = await connections.hasActiveCredential(ctx, connection.id);
    }
    return pages.websiteDetailPage(viewOf(c), {
      website, tasks, schedules, checks, reviews, sources, runs, history, connections: connectionList, operations, credentials, assignable,
      config: pageConfig, state, notice: noticeOf(c), domains, plans, incidents, windows, findings, recovery, workLogs, uptime: [uptime7, uptime30, uptime90]
    });
  };
  const renderWebsite = (c, state) => renderWebsiteById(c, c.req.param('id'), state);
  app.get('/websites/:id', async c => c.html(await renderWebsite(c)));
  formRoute('/websites', async (ctx, input) => `/websites/${(await records.createWebsite(ctx, input)).id}`, renderWebsiteForm);
  formRoute('/websites/:id', async (ctx, input, c) => {
    await records.updateWebsite(ctx, c.req.param('id'), input);
    return `/websites/${c.req.param('id')}`;
  }, renderWebsiteForm);

  const websiteAction = (path, action) => formRoute(path, async (ctx, input, c) => {
    await action(ctx, c.req.param('id'), input);
    return `/websites/${c.req.param('id')}`;
  }, renderWebsite);
  websiteAction('/websites/:id/archive', (ctx, id) => inventory.archiveWebsite(ctx, id));
  websiteAction('/websites/:id/restore', (ctx, id) => inventory.restoreWebsite(ctx, id));
  websiteAction('/websites/:id/cms-version', (ctx, id, input) => inventory.recordCmsVersion(ctx, id, input));
  websiteAction('/websites/:id/domains', (ctx, id, input) => inventory.addDomain(ctx, id, input));
  websiteAction('/websites/:id/apply-plan', (ctx, id, input) => inventory.applyPlanToWebsite(ctx, id, input));

  // Re-render the website page when the form that failed came from one.
  const renderFromReturn = fallback => async (c, state) => {
    const form = await formOf(c);
    const match = /^\/websites\/([0-9a-f-]{36})$/.exec(form._return ?? '');
    return match ? renderWebsiteById(c, match[1], state) : fallback(c, state);
  };

  // Connections --------------------------------------------------------------

  const websiteOfConnection = (ctx, id) => ctx.db.as('hub_app', ctx.staff.id, async tx =>
    (await tx.query(`select website_id from hub.platform_connections where id = $1`, [id])).rows[0]?.website_id);

  formRoute('/websites/:id/connections', async (ctx, input, c) => {
    await connections.createConnection(ctx, c.req.param('id'), input);
    return `/websites/${c.req.param('id')}`;
  }, renderWebsite);

  const connectionRoute = (path, action, success) => app.post(path, async c => {
    const ctx = contextOf(c);
    const input = withoutInternals(await formOf(c));
    const id = c.req.param('id');
    try {
      await action(ctx, id, input);
    } catch (error) {
      if (!(error instanceof HubError) || error.status >= 500 && error.code !== 'not_configured' || error.status === 403 || error.status === 404) throw error;
      // Secrets from the failed form are not passed back to the page.
      const state = { errors: error.fields ?? { _: error.message }, message: 'That could not be saved.' };
      return c.html(await renderWebsiteById(c, await websiteOfConnection(ctx, id), state), error.status);
    }
    return c.redirect(`/websites/${await websiteOfConnection(ctx, id)}?notice=${success}#connection`, 303);
  });
  connectionRoute('/connections/:id/check', (ctx, id) => connections.runConnectionCheck(ctx, id), 'check_done');
  connectionRoute('/connections/:id/test', (ctx, id) => connections.runConnectionCheck(ctx, id, { mode: 'test' }), 'check_done');
  connectionRoute('/connections/:id/credential', (ctx, id, input) => connections.storeCredential(ctx, id, input), 'credential_stored');
  connectionRoute('/connections/:id/credential/revoke', (ctx, id) => connections.revokeCredential(ctx, id), 'credential_revoked');

  const websiteOfOperation = (ctx, id) => ctx.db.as('hub_app', ctx.staff.id, async tx =>
    (await tx.query(`select c.website_id from hub.operation_requests o join hub.platform_connections c on c.id = o.connection_id where o.id = $1`, [id])).rows[0]?.website_id);

  app.post('/operations', async c => {
    const ctx = contextOf(c);
    const input = withoutInternals(await formOf(c));
    await connections.requestOperation(ctx, input);
    return c.redirect(`/websites/${await websiteOfConnection(ctx, input.connection_id)}?notice=saved#connection`, 303);
  });
  for (const [verb, action] of [
    ['approve', (ctx, id) => connections.decideOperation(ctx, id, 'approved')],
    ['reject', (ctx, id) => connections.decideOperation(ctx, id, 'rejected')],
    ['execute', (ctx, id) => connections.executeOperation(ctx, id)]
  ]) {
    app.post(`/operations/:id/${verb}`, async c => {
      const ctx = contextOf(c);
      await action(ctx, c.req.param('id'));
      return c.redirect(`/websites/${await websiteOfOperation(ctx, c.req.param('id'))}?notice=saved#connection`, 303);
    });
  }

  // Maintenance --------------------------------------------------------------

  const renderMaintenance = async (c, state) => {
    const ctx = contextOf(c);
    const scope = c.req.query('scope') === 'all' ? 'all' : 'open';
    return pages.maintenancePage(viewOf(c), {
      tasks: await records.listTasks(ctx, { scope }), schedules: await records.listSchedules(ctx), websites: await records.listWebsites(ctx),
      assignable: await records.listAssignableStaff(ctx), scope, state, notice: noticeOf(c)
    });
  };
  app.get('/maintenance', async c => c.html(await renderMaintenance(c)));
  formRoute('/maintenance/tasks', async (ctx, input) => {
    await records.createTask(ctx, input);
    return '/maintenance';
  }, renderFromReturn(renderMaintenance));
  formRoute('/maintenance/tasks/:id/update', async (ctx, input, c) => {
    await records.updateTask(ctx, c.req.param('id'), input);
    return '/maintenance';
  }, renderFromReturn(renderMaintenance));
  formRoute('/maintenance/tasks/:id/complete', async (ctx, input, c) => {
    await records.completeTask(ctx, c.req.param('id'), input);
    return '/maintenance';
  }, renderFromReturn(renderMaintenance));
  formRoute('/maintenance/tasks/:id/approve', async (ctx, _input, c) => {
    await records.approveTask(ctx, c.req.param('id'));
    return '/maintenance';
  }, renderFromReturn(renderMaintenance));
  formRoute('/maintenance/tasks/:id/worklog', async (ctx, input, c) => {
    await records.addWorkLog(ctx, c.req.param('id'), input);
    return '/maintenance';
  }, renderFromReturn(renderMaintenance));
  formRoute('/maintenance/schedules', async (ctx, input) => {
    await records.createSchedule(ctx, input);
    return '/maintenance';
  }, renderFromReturn(renderMaintenance));
  formRoute('/maintenance/schedules/:id/task', async (ctx, _input, c) => {
    await records.createTaskFromSchedule(ctx, c.req.param('id'));
    return '/maintenance';
  }, renderMaintenance);
  formRoute('/history', async (ctx, input) => {
    await records.addHistory(ctx, input);
    return `/websites/${input.website_id}`;
  }, renderFromReturn(renderMaintenance));

  // Monitoring, security, backups ---------------------------------------------

  const renderMonitoring = async c => {
    const ctx = contextOf(c);
    const checks = await records.listChecks(ctx);
    return pages2.monitoringDashboardPage(viewOf(c), { checks, incidents: await insights.listIncidents(ctx), config: pageConfig, table: pages.checkTable(checks, true) });
  };
  const renderSecurity = async c => {
    const ctx = contextOf(c);
    return pages2.securityDashboardPage(viewOf(c), { sites: await insights.securityDashboard(ctx), findings: await insights.listFindings(ctx) });
  };
  app.get('/monitoring', async c => c.html(await renderMonitoring(c)));
  app.get('/security', async c => c.html(await renderSecurity(c)));
  app.get('/backups', async c => c.html(pages.backupsPage(viewOf(c), { sources: await records.listBackupSources(contextOf(c)) })));
  const renderBackups = async c => pages.backupsPage(viewOf(c), { sources: await records.listBackupSources(contextOf(c)) });
  formRoute('/monitoring/checks', async (ctx, input) => {
    await records.createCheck(ctx, input);
    return '/monitoring';
  }, renderFromReturn(renderMonitoring));
  formRoute('/security/reviews', async (ctx, input) => {
    await records.createSecurityReview(ctx, input);
    return '/security';
  }, renderFromReturn(renderSecurity));
  formRoute('/backups/sources', async (ctx, input) => {
    await records.createBackupSource(ctx, input);
    return '/backups';
  }, renderFromReturn(renderBackups));
  formRoute('/backups/runs', async (ctx, input) => {
    await records.recordBackupRun(ctx, input);
    return '/backups';
  }, renderFromReturn(renderBackups));
  formRoute('/backups/restores', async (ctx, input) => {
    await records.recordRestoreVerification(ctx, input);
    return '/backups';
  }, renderFromReturn(renderBackups));

  formRoute('/monitoring/windows', async (ctx, input) => {
    await insights.createMaintenanceWindow(ctx, input);
    return '/monitoring';
  }, renderFromReturn(renderMonitoring));
  formRoute('/incidents/:id/acknowledge', async (ctx, _input, c) => {
    const row = await insights.acknowledgeIncident(ctx, c.req.param('id'));
    return `/websites/${row.website_id}`;
  }, renderMonitoring);
  formRoute('/security/findings', async (ctx, input) => {
    await insights.createFinding(ctx, input);
    return '/security';
  }, renderFromReturn(renderSecurity));
  formRoute('/security/findings/:id/update', async (ctx, input, c) => {
    await insights.updateFinding(ctx, c.req.param('id'), input);
    return '/security';
  }, renderSecurity);
  formRoute('/security/findings/:id/remediate', async (ctx, _input, c) => {
    await insights.createRemediationTask(ctx, c.req.param('id'));
    return '/security';
  }, renderSecurity);
  formRoute('/recovery', async (ctx, input) => `/websites/${(await insights.requestRecovery(ctx, input)).website_id}`, renderBackups);
  for (const action of ['approve', 'reject', 'start', 'close']) {
    formRoute(`/recovery/:id/${action}`, async (ctx, input, c) => `/websites/${(await insights.moveRecovery(ctx, c.req.param('id'), action, input)).website_id}`, renderBackups);
  }

  // Plans, hosting, reports, notifications, account ---------------------------

  formRoute('/plans/:id/tasks', async (ctx, input, c) => {
    await inventory.addPlanTask(ctx, c.req.param('id'), input);
    return '/clients';
  }, renderClients);

  const renderHosting = async (c, state) => pages2.hostingPage(viewOf(c), { providers: await inventory.listHostingProviders(contextOf(c)), state, notice: noticeOf(c) });
  app.get('/hosting', async c => c.html(await renderHosting(c)));
  formRoute('/hosting', async (ctx, input) => {
    await inventory.createHostingProvider(ctx, input);
    return '/hosting';
  }, renderHosting);

  app.get('/reports/maintenance', async c => {
    const ctx = contextOf(c);
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const report = await inventory.maintenanceReport(ctx, {
      clientId: c.req.query('client'), from: c.req.query('from') || monthStart, to: c.req.query('to') || new Date().toISOString().slice(0, 10)
    });
    if (c.req.query('format') === 'csv') {
      c.header('Content-Type', 'text/csv; charset=utf-8');
      c.header('Content-Disposition', 'attachment; filename="maintenance-report.csv"');
      return c.body(pages2.toCsv([
        ['Completed', 'Client', 'Website', 'Work', 'Type', 'Notes', 'By', 'Minutes', 'Evidence'],
        ...report.tasks.map(item => [item.completed_at, item.client_name, item.website_name, item.title, item.kind, item.completion_notes, item.completed_by_name, item.minutes, item.completion_evidence_ref])
      ]));
    }
    return c.html(pages2.reportPage(viewOf(c), { report, clients: await records.listClients(ctx) }));
  });

  app.get('/notifications', async c => c.html(pages2.notificationsPage(viewOf(c), { notifications: await insights.listNotifications(contextOf(c)) })));
  app.post('/notifications/read', async c => {
    await insights.markNotificationsRead(contextOf(c));
    return c.redirect('/notifications', 303);
  });

  app.get('/account', async c => c.html(pages2.accountPage(viewOf(c), { sessions: await insights.listOwnSessions(contextOf(c)), config: pageConfig, notice: noticeOf(c) })));
  app.post('/account/sessions/:id/revoke', async c => {
    await insights.revokeOwnSession(contextOf(c), c.req.param('id'));
    return c.redirect('/account?notice=saved', 303);
  });

  // Integrations, staff, audit ------------------------------------------------

  app.get('/integrations', c => {
    requirePermission(c.get('staff'), 'website.read');
    return c.html(pages.integrationsPage(viewOf(c), { config: pageConfig, stackltrEnabled: Boolean(stackltr?.enabled) }));
  });

  const renderStaff = async (c, state) => {
    const ctx = contextOf(c);
    return pages.staffPage(viewOf(c), { staff: await records.listStaff(ctx), clients: await records.listClients(ctx), state, notice: noticeOf(c) });
  };
  app.get('/staff', async c => c.html(await renderStaff(c)));
  const staffRoute = (path, action) => formRoute(path, async (ctx, input, c) => {
    await action(ctx, input, c);
    return '/staff';
  }, renderStaff);
  staffRoute('/staff', (ctx, input) => records.createStaff(ctx, input));
  staffRoute('/staff/assign', (ctx, input) => records.assignStaff(ctx, input));
  staffRoute('/staff/unassign', (ctx, input) => records.unassignStaff(ctx, input));
  staffRoute('/staff/:id', (ctx, input, c) => records.updateStaff(ctx, c.req.param('id'), input));

  app.get('/audit', async c => c.html(pages.auditPage(viewOf(c), await records.listAudit(contextOf(c)))));

  app.post('/logout', async c => {
    await auth.logout(getCookie(c, config.session.cookieName), c.get('staff'), c.get('requestId'));
    deleteCookie(c, config.session.cookieName, cookieOptions);
    return c.redirect('/login', 303);
  });

  // JSON API -----------------------------------------------------------------

  const jsonBody = async c => {
    try {
      const body = await c.req.json();
      if (body && typeof body === 'object' && !Array.isArray(body)) return body;
    } catch { /* falls through to the same rejection */ }
    throw new HubError(400, 'invalid_json', 'The request body must be a JSON object.');
  };

  app.get('/api/v1/me', c => c.json({ staff: c.get('staff'), csrf_token: c.get('csrfToken') }));
  app.get('/api/v1/websites', async c => c.json({ websites: await records.listWebsites(contextOf(c), inventoryFiltersOf(c)) }));
  app.get('/api/v1/clients', async c => c.json({ clients: await records.listClients(contextOf(c)) }));
  app.post('/api/v1/clients', async c => c.json(await records.createClient(contextOf(c), await jsonBody(c)), 201));
  app.get('/api/v1/tasks', async c => c.json({ tasks: await records.listTasks(contextOf(c), { scope: c.req.query('scope') === 'all' ? 'all' : 'open' }) }));
  app.post('/api/v1/tasks/:id/complete', async c => c.json(await records.completeTask(contextOf(c), c.req.param('id'), await jsonBody(c))));
  app.get('/api/v1/monitoring/checks', async c => c.json({ checks: await records.listChecks(contextOf(c)) }));
  app.get('/api/v1/monitoring/incidents', async c => c.json({ incidents: await insights.listIncidents(contextOf(c)) }));
  app.get('/api/v1/security/findings', async c => c.json({ findings: await insights.listFindings(contextOf(c)) }));
  app.get('/api/v1/security/websites', async c => c.json({ websites: await insights.securityDashboard(contextOf(c)) }));
  app.get('/api/v1/backups/sources', async c => c.json({ sources: await records.listBackupSources(contextOf(c)) }));
  app.get('/api/v1/notifications', async c => c.json({ notifications: await insights.listNotifications(contextOf(c)) }));
  app.get('/api/v1/hosting-providers', async c => c.json({ providers: await inventory.listHostingProviders(contextOf(c)) }));
  app.post('/api/v1/websites/:id/archive', async c => c.json(await inventory.archiveWebsite(contextOf(c), c.req.param('id'))));
  app.post('/api/v1/websites/:id/domains', async c => c.json(await inventory.addDomain(contextOf(c), c.req.param('id'), await jsonBody(c)), 201));
  app.get('/api/v1/websites/:id/domains', async c => {
    const ctx = contextOf(c);
    const website = await records.getWebsite(ctx, c.req.param('id'));
    return c.json({ domains: await inventory.listDomains(ctx, website.id) });
  });
  app.post('/api/v1/websites', async c => c.json(await records.createWebsite(contextOf(c), await jsonBody(c)), 201));
  app.get('/api/v1/websites/:id', async c => c.json({ website: await records.getWebsite(contextOf(c), c.req.param('id')) }));
  app.get('/api/v1/websites/:id/connections', async c => {
    const ctx = contextOf(c);
    const website = await records.getWebsite(ctx, c.req.param('id'));
    return c.json({ connections: await connections.listConnections(ctx, website.id) });
  });
  app.post('/api/v1/tasks', async c => c.json(await records.createTask(contextOf(c), await jsonBody(c)), 201));
  app.get('/api/v1/adapters', c => {
    requirePermission(c.get('staff'), 'website.read');
    const describe = ({ key, label, capabilities, operations, docsUrl }) => ({
      key, label, docs_url: docsUrl, capabilities, operations: operations.map(({ key: operation, label: name, capability }) => ({ key: operation, label: name, capability }))
    });
    return c.json({ adapters: [...Object.values(ADAPTERS), OTHER_PLATFORM].map(describe), live_verified: false });
  });

  return app;
}
