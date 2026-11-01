import test from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS, CMS_PLATFORMS, getAdapter, OTHER_PLATFORM } from '../src/adapters/index.js';
import { AdapterError, createPlatformClient, ERROR_MESSAGES, safeCode, section, SUPPORT, summarizeSections } from '../src/adapters/framework.js';
import { SHOPIFY_API_VERSION } from '../src/adapters/shopify.js';
import { OutboundError } from '../src/safe-http.js';
import { fakeHttp } from './helpers.mjs';

const client = (http, baseUrl, authHeaders = { Authorization: 'test-auth' }) => createPlatformClient({ baseUrl, http, authHeaders });
const WP = 'https://site.example.test';

test('adapters follow one contract and every platform is covered', () => {
  assert.deepEqual(CMS_PLATFORMS.map(item => item.key).sort(), ['joomla', 'other', 'shopify', 'squarespace', 'wix', 'wordpress']);
  const support = new Set(Object.values(SUPPORT));
  for (const adapter of Object.values(ADAPTERS)) {
    assert.ok(adapter.label && adapter.docsUrl.startsWith('https://'), adapter.key);
    assert.ok(adapter.authTypes.length > 0, adapter.key);
    for (const type of adapter.authTypes) {
      assert.ok(type.guidance, type.key);
      assert.ok(type.fields.every(field => field.secret === true), `${adapter.key} ${type.key}`);
    }
    assert.equal(typeof adapter.check, 'function');
    assert.equal(typeof adapter.authHeaders, 'function');
    assert.equal(typeof adapter.validateConnection, 'function');
    for (const capability of adapter.capabilities) {
      assert.ok(support.has(capability.support), capability.key);
      assert.ok(capability.notes, capability.key);
      if (capability.support === SUPPORT.API_PERMISSION) assert.ok(capability.requires, `${adapter.key} ${capability.key} must name what it needs`);
    }
    for (const operation of adapter.operations) {
      assert.ok(adapter.capabilities.some(item => item.key === operation.capability), operation.key);
      assert.equal(typeof adapter.runOperation, 'function');
      assert.equal(typeof operation.params.safeParse, 'function');
    }
    assert.ok(adapter.capabilities.some(item => item.key === 'backups'), `${adapter.key} must state its backup position`);
  }
  assert.equal(OTHER_PLATFORM.authTypes.length, 0);
  assert.equal(getAdapter('__proto__'), null);
  assert.equal(getAdapter('constructor'), null);
});

test('capabilities distinguish supported API from permission and manual work', () => {
  const support = (adapter, key) => ADAPTERS[adapter].capabilities.find(item => item.key === key)?.support;
  assert.equal(support('wordpress', 'connection'), SUPPORT.API);
  assert.equal(support('wordpress', 'plugin_inventory'), SUPPORT.API_PERMISSION);
  assert.equal(support('wordpress', 'core_version'), SUPPORT.MANUAL);
  assert.equal(support('wordpress', 'software_updates'), SUPPORT.MANUAL);
  assert.equal(support('shopify', 'theme_inventory'), SUPPORT.API_PERMISSION);
  assert.equal(support('wix', 'software_inventory'), SUPPORT.UNSUPPORTED);
  assert.equal(support('wix', 'backups'), SUPPORT.MANUAL);
  assert.equal(support('squarespace', 'content_inventory'), SUPPORT.UNSUPPORTED);
  assert.equal(support('joomla', 'extension_inventory'), SUPPORT.API_PERMISSION);
});

test('the platform client cannot be pointed at another origin', async () => {
  const http = fakeHttp({ '*': { body: {} } });
  const platform = client(http, WP);
  for (const path of ['https://evil.example.test/x', '//evil.example.test/x', 'relative']) {
    await assert.rejects(platform.get(path), error => error.code === 'blocked_target', path);
  }
  assert.equal(http.calls.length, 0);
});

test('HTTP failures map to safe codes and drop provider bodies', async () => {
  for (const [status, code] of [[401, 'auth_failed'], [403, 'permission_required'], [404, 'not_found'], [410, 'not_found'], [429, 'rate_limited'], [500, 'upstream_error'], [503, 'upstream_error'], [301, 'redirected'], [400, 'operation_rejected']]) {
    const http = fakeHttp({ '*': { status, body: 'secret-from-provider token=abc' } });
    const error = await client(http, WP).get('/x').catch(e => e);
    assert.ok(error instanceof AdapterError, String(status));
    assert.equal(error.code, code);
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /secret-from-provider/);
    assert.ok(ERROR_MESSAGES[code], code);
  }
});

test('transport failures and unreadable responses map to safe codes', async () => {
  for (const code of ['timeout', 'tls_error', 'network_error', 'blocked_target', 'response_too_large', 'outbound_disabled']) {
    const http = { request: async () => { throw new OutboundError(code); } };
    const error = await client(http, WP).get('/x').catch(e => e);
    assert.equal(error.code, code);
    assert.ok(ERROR_MESSAGES[code], code);
  }
  const notJson = fakeHttp({ '*': { status: 200, body: '<html>maintenance</html>' } });
  assert.equal((await client(notJson, WP).get('/x').catch(e => e)).code, 'invalid_response');
  const unknown = { request: async () => { throw new Error('connect ECONNREFUSED with secret-value'); } };
  assert.equal((await client(unknown, WP).get('/x').catch(e => e)).code, 'network_error');
  assert.equal(safeCode(new Error('secret')), 'internal_error');
});

test('one failing section does not hide others and is never reported as healthy', async () => {
  const sections = {
    a: await section(async () => 'ok'),
    b: await section(async () => { throw new AdapterError('permission_required'); }),
    c: await section(async () => { throw new Error('secret detail'); })
  };
  assert.equal(sections.a.status, 'ok');
  assert.deepEqual(sections.b, { status: 'permission_required', code: 'permission_required' });
  assert.deepEqual(sections.c, { status: 'error', code: 'internal_error' });
  assert.equal(summarizeSections(sections).outcome, 'partial');
  assert.equal(summarizeSections({ b: sections.b, c: sections.c }).outcome, 'failed');
  assert.equal(summarizeSections({ a: sections.a }).outcome, 'ok');
});

// WordPress ------------------------------------------------------------------

const wordpressRoutes = (overrides = {}) => ({
  '/wp-json/': { body: { name: 'Example', namespaces: ['wp/v2', 'wp-site-health/v1'] } },
  '/wp-json/wp/v2/users/me': { body: { id: 3, roles: ['administrator'], email: 'should-not-copy@example.test' } },
  '/wp-json/wp/v2/plugins': { body: [{ plugin: 'akismet/akismet', name: 'Akismet', version: '5.3', status: 'active', description: { raw: 'x' } }] },
  '/wp-json/wp/v2/themes': { body: [{ stylesheet: 'twentytwentyfive', name: { raw: 'TT5' }, version: '1.2', status: 'active' }] },
  ...Object.fromEntries(['background-updates', 'loopback-requests', 'https-status', 'dotorg-communication', 'authorization-header']
    .map(name => [`/wp-json/wp-site-health/v1/tests/${name}`, { body: { status: 'good', label: name } }])),
  ...overrides
});

test('WordPress: authenticates with an Application Password and reports inventory', async () => {
  const headers = ADAPTERS.wordpress.authHeaders({ username: 'svc', application_password: 'abcd efgh ijkl' });
  assert.equal(headers.Authorization, `Basic ${Buffer.from('svc:abcdefghijkl').toString('base64')}`);
  const http = fakeHttp(wordpressRoutes());
  const result = await ADAPTERS.wordpress.check(client(http, WP), {});
  assert.equal(summarizeSections(result).outcome, 'ok');
  assert.deepEqual(result.connection.data.service_user_roles, ['administrator']);
  assert.doesNotMatch(JSON.stringify(result), /should-not-copy/);
  assert.deepEqual(result.plugin_inventory.data, [{ plugin: 'akismet/akismet', name: 'Akismet', version: '5.3', status: 'active' }]);
  assert.equal(result.theme_inventory.data[0].name, 'TT5');
  assert.equal(result.site_health.data['https-status'].status, 'good');
});

test('WordPress: a restricted user gets partial results, not a failure or a pass', async () => {
  const http = fakeHttp(wordpressRoutes({ '/wp-json/wp/v2/plugins': { status: 403, body: { code: 'rest_cannot_view_plugins' } } }));
  const result = await ADAPTERS.wordpress.check(client(http, WP), {});
  assert.equal(result.plugin_inventory.status, 'permission_required');
  assert.equal(result.theme_inventory.status, 'ok');
  assert.equal(summarizeSections(result).outcome, 'partial');
});

test('WordPress: a rejected credential fails and malformed data is refused', async () => {
  const rejected = await ADAPTERS.wordpress.check(client(fakeHttp({ '*': { status: 401, body: {} } }), WP), {});
  assert.equal(summarizeSections(rejected).outcome, 'failed');
  assert.equal(summarizeSections(rejected).code, 'auth_failed');
  const malformed = await ADAPTERS.wordpress.check(client(fakeHttp(wordpressRoutes({ '/wp-json/wp/v2/plugins': { body: { not: 'a list' } } })), WP), {});
  assert.equal(malformed.plugin_inventory.code, 'invalid_response');
});

test('WordPress: plugin operations validate input before any call', async () => {
  const operation = ADAPTERS.wordpress.operations[0];
  assert.equal(operation.params.safeParse({ plugin: '../../wp-admin/x', status: 'active' }).success, false);
  assert.equal(operation.params.safeParse({ plugin: 'akismet/akismet', status: 'deleted' }).success, false);
  const http = fakeHttp({ '*': { body: {} } });
  await ADAPTERS.wordpress.runOperation(client(http, WP), 'plugin.set_status', { plugin: 'akismet/akismet', status: 'inactive' });
  assert.equal(http.calls[0].method, 'POST');
  assert.equal(new URL(http.calls[0].url).pathname, '/wp-json/wp/v2/plugins/akismet/akismet');
  assert.deepEqual(JSON.parse(http.calls[0].body), { status: 'inactive' });
});

test('WordPress: refuses a REST path as the site address', () => {
  assert.ok(ADAPTERS.wordpress.validateConnection('https://site.example.test/wp-json'));
  assert.equal(ADAPTERS.wordpress.validateConnection('https://site.example.test'), null);
});

// Shopify --------------------------------------------------------------------

const SHOP = 'https://store.myshopify.com';
const shopifyGraphql = (handler) => ({ [`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`]: options => handler(JSON.parse(options.body).query) });

test('Shopify: uses the pinned Admin GraphQL API and reports scopes and themes', async () => {
  const http = fakeHttp(shopifyGraphql(query => {
    if (query.includes('themes')) return { body: { data: { themes: { nodes: [{ id: 'gid://t/1', name: 'Dawn', role: 'MAIN' }] } } } };
    if (query.includes('accessScopes')) return { body: { data: { currentAppInstallation: { accessScopes: [{ handle: 'read_themes' }] } } } };
    return { body: { data: { shop: { name: 'Store', primaryDomain: { url: SHOP, sslEnabled: true } } } } };
  }));
  const result = await ADAPTERS.shopify.check(client(http, SHOP), {});
  assert.equal(summarizeSections(result).outcome, 'ok');
  assert.deepEqual(result.granted_scopes.data, ['read_themes']);
  assert.equal(result.theme_inventory.data[0].name, 'Dawn');
  assert.deepEqual(ADAPTERS.shopify.authHeaders({ access_token: 't' }), { 'X-Shopify-Access-Token': 't' });
});

test('Shopify: GraphQL errors inside a 200 are not treated as success', async () => {
  const denied = fakeHttp(shopifyGraphql(query => (query.includes('themes')
    ? { body: { errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }] } }
    : query.includes('accessScopes') ? { body: { data: { currentAppInstallation: { accessScopes: [] } } } }
    : { body: { errors: [{ message: 'slow', extensions: { code: 'THROTTLED' } }] } })));
  const result = await ADAPTERS.shopify.check(client(denied, SHOP), {});
  assert.equal(result.theme_inventory.status, 'permission_required');
  assert.equal(result.connection.code, 'rate_limited');
  assert.equal(result.granted_scopes.status, 'ok');
});

test('Shopify: client credentials exchange stays at the store and the token is not persisted', async () => {
  const http = fakeHttp({ 'POST /admin/oauth/access_token': options => {
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('grant_type'), 'client_credentials');
    return { body: { access_token: 'short-lived', expires_in: 86399 } };
  } });
  const headers = await ADAPTERS.shopify.prepareAuth({ client_id: 'id', client_secret: 'sec' }, { baseUrl: SHOP, http });
  assert.deepEqual(headers, { 'X-Shopify-Access-Token': 'short-lived' });
  assert.equal(new URL(http.calls[0].url).origin, SHOP);
  const bad = fakeHttp({ 'POST /admin/oauth/access_token': { body: { nothing: true } } });
  await assert.rejects(ADAPTERS.shopify.prepareAuth({ client_id: 'id', client_secret: 'sec' }, { baseUrl: SHOP, http: bad }), error => error.code === 'invalid_response');
});

test('Shopify: only a myshopify.com store address is accepted', () => {
  assert.equal(ADAPTERS.shopify.validateConnection('https://store.myshopify.com/'), null);
  for (const url of ['https://store.example.test', 'https://myshopify.com.evil.test', 'https://store.myshopify.com/admin']) {
    assert.ok(ADAPTERS.shopify.validateConnection(url), url);
  }
});

test('Shopify: redirect creation reports user errors as a rejection', async () => {
  const rejected = fakeHttp(shopifyGraphql(() => ({ body: { data: { urlRedirectCreate: { urlRedirect: null, userErrors: [{ message: 'taken' }] } } } })));
  await assert.rejects(ADAPTERS.shopify.runOperation(client(rejected, SHOP), 'url_redirect.create', { path: '/a', target: '/b' }), error => error.code === 'operation_rejected');
  const params = ADAPTERS.shopify.operations[0].params;
  assert.equal(params.safeParse({ path: 'no-slash', target: '/b' }).success, false);
  assert.equal(params.safeParse({ path: '/a', target: 'javascript:alert(1)' }).success, false);
});

// Wix ------------------------------------------------------------------------

const SITE_ID = '11111111-2222-4333-8444-555555555555';

test('Wix: sends one scope header per call and requests only operational fields', async () => {
  const http = fakeHttp({
    '/site-properties/v4/properties': { body: { properties: { siteDisplayName: 'Shop', timeZone: 'UTC', email: 'private@example.test', phone: '555' } } },
    '/site-list/v2/sites/query': { body: { sites: [{ id: SITE_ID, displayName: 'Shop', published: true, premium: true, domainConnected: true, contributorAccountIds: ['x'] }] } }
  });
  const result = await ADAPTERS.wix.check(client(http, 'https://www.wixapis.com', ADAPTERS.wix.authHeaders({ api_key: 'k' })), { settings: { site_id: SITE_ID, account_id: 'acct' } });
  assert.equal(summarizeSections(result).outcome, 'ok');
  const [properties, listing] = http.calls;
  assert.equal(properties.headers['wix-site-id'], SITE_ID);
  assert.equal(properties.headers['wix-account-id'], undefined);
  assert.equal(listing.headers['wix-account-id'], 'acct');
  assert.equal(listing.headers['wix-site-id'], undefined);
  assert.equal(properties.headers.Authorization, 'k');
  assert.doesNotMatch(JSON.stringify(result), /private@example|contributorAccountIds/);
  assert.equal(result.connection.data.siteDisplayName, 'Shop');
});

test('Wix: without an account ID the account-level listing is not attempted, and bad settings are refused', async () => {
  const http = fakeHttp({ '/site-properties/v4/properties': { status: 403, body: {} } });
  const result = await ADAPTERS.wix.check(client(http, 'https://www.wixapis.com'), { settings: { site_id: SITE_ID } });
  assert.equal(result.connection.status, 'permission_required');
  assert.equal(result.site_inventory, undefined);
  assert.ok(ADAPTERS.wix.validateConnection('https://www.wixapis.com', { site_id: 'nope' }));
  assert.equal(ADAPTERS.wix.validateConnection('https://www.wixapis.com', { site_id: SITE_ID }), null);
});

// Squarespace ----------------------------------------------------------------

test('Squarespace: uses a bearer key and a user agent, and notes the plan limit', async () => {
  const http = fakeHttp({
    '/1.0/authorization/website': { body: { siteId: 's1', title: 'Studio', url: 'https://studio.example.test' } },
    '/1.0/commerce/inventory': { body: { inventory: [{ variantId: 'v' }], pagination: { hasNextPage: true } } }
  });
  const result = await ADAPTERS.squarespace.check(client(http, 'https://api.squarespace.com', ADAPTERS.squarespace.authHeaders({ api_key: 'k' })), {});
  assert.equal(summarizeSections(result).outcome, 'ok');
  assert.equal(http.calls[0].headers.Authorization, 'Bearer k');
  assert.ok(http.calls[0].headers['User-Agent']);
  assert.deepEqual(result.commerce_inventory.data, { items_on_first_page: 1, has_more: true });
  assert.match(ADAPTERS.squarespace.authTypes[0].guidance, /Commerce Advanced/);
});

test('Squarespace: a plan or key without access is reported as such', async () => {
  const http = fakeHttp({ '/1.0/authorization/website': { body: { siteId: 's' } }, '/1.0/commerce/inventory': { status: 403, body: {} } });
  const result = await ADAPTERS.squarespace.check(client(http, 'https://api.squarespace.com'), {});
  assert.equal(result.commerce_inventory.status, 'permission_required');
});

// Joomla ---------------------------------------------------------------------

test('Joomla: uses the token header and finds the core version in the extension list', async () => {
  const http = fakeHttp({ '/api/index.php/v1/extensions': { body: {
    data: [
      { type: 'extensions', id: '1', attributes: { name: 'files_joomla', type: 'file', version: '5.3.1', status: 1 } },
      { type: 'extensions', id: '2', attributes: { name: 'plg_system_cache', type: 'plugin', version: '4.0.0', status: 0 } }
    ], links: { next: 'x' }
  } } });
  const result = await ADAPTERS.joomla.check(client(http, WP, ADAPTERS.joomla.authHeaders({ api_token: 't' })), {});
  assert.equal(summarizeSections(result).outcome, 'ok');
  assert.equal(http.calls[0].headers['X-Joomla-Token'], 't');
  assert.equal(http.calls[0].headers.Accept, 'application/vnd.api+json');
  assert.equal(result.extension_inventory.data.core_version, '5.3.1');
  assert.equal(result.extension_inventory.data.has_more, true);
  assert.equal(result.extension_inventory.data.extensions.length, 2);
});

test('Joomla: a disabled API or plugin is reported, and the core version is never guessed', async () => {
  const off = await ADAPTERS.joomla.check(client(fakeHttp({ '*': { status: 404, body: {} } }), WP), {});
  assert.equal(summarizeSections(off).code, 'not_found');
  const noCore = fakeHttp({ '/api/index.php/v1/extensions': { body: { data: [{ attributes: { name: 'mod_x', type: 'module', version: '1' } }] } } });
  const result = await ADAPTERS.joomla.check(client(noCore, WP), {});
  assert.equal(result.extension_inventory.data.core_version, null);
});
