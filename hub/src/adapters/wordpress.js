import { z } from 'zod';
import { expectArray, expectObject, section, SUPPORT } from './framework.js';

const SITE_HEALTH_TESTS = ['background-updates', 'loopback-requests', 'https-status', 'dotorg-communication', 'authorization-header'];
const DOCS = 'https://developer.wordpress.org/rest-api/reference/';

export const wordpress = {
  key: 'wordpress',
  label: 'WordPress',
  docsUrl: DOCS,
  baseUrlHint: 'The site address, for example https://www.example.com',
  authTypes: [{
    key: 'application_password',
    label: 'Application Password',
    guidance: 'Create one for a dedicated CrumByte service user. Application Passwords need HTTPS and can be revoked individually.',
    fields: [
      { name: 'username', label: 'WordPress username', secret: true },
      { name: 'application_password', label: 'Application Password', secret: true }
    ]
  }],
  capabilities: [
    { key: 'connection', label: 'Connection and identity check', support: SUPPORT.API, notes: 'GET /wp-json/ and /wp/v2/users/me.' },
    { key: 'site_health', label: 'Site health tests', support: SUPPORT.API_PERMISSION, requires: 'view_site_health_checks capability', notes: `The ${SITE_HEALTH_TESTS.length} wp-site-health/v1 test routes. Administrators have this by default.` },
    { key: 'plugin_inventory', label: 'Plugin inventory and versions', support: SUPPORT.API_PERMISSION, requires: 'activate_plugins capability', notes: 'GET /wp/v2/plugins.' },
    { key: 'theme_inventory', label: 'Theme inventory and versions', support: SUPPORT.API_PERMISSION, requires: 'switch_themes or edit_theme_options capability', notes: 'GET /wp/v2/themes. A lesser role may see only the active theme.' },
    { key: 'plugin_activation', label: 'Activate or deactivate a plugin', support: SUPPORT.API_PERMISSION, requires: 'activate_plugins capability and hub approval', notes: 'POST /wp/v2/plugins/<plugin>.' },
    { key: 'core_version', label: 'WordPress core version', support: SUPPORT.MANUAL, notes: 'Core REST routes do not report it. Record it manually, or add a reviewed companion plugin or WP-CLI access later.' },
    { key: 'software_updates', label: 'Core, plugin and theme updates', support: SUPPORT.MANUAL, notes: 'Core REST routes can install and activate but not update. Use the dashboard, WP-CLI or the host, then record the work.' },
    { key: 'backups', label: 'Backups', support: SUPPORT.MANUAL, notes: 'WordPress has no core backup API. Connect the backup provider separately.' }
  ],
  operations: [{
    key: 'plugin.set_status',
    label: 'Activate or deactivate a plugin',
    capability: 'plugin_activation',
    params: z.object({
      plugin: z.string().regex(/^[a-z0-9_-]+(\/[a-z0-9_.-]+)?$/i, 'Use the plugin identifier, such as akismet/akismet').max(200),
      status: z.enum(['active', 'inactive'])
    })
  }],
  validateConnection(baseUrl) {
    return new URL(baseUrl).pathname.startsWith('/wp-json') ? 'Use the site address without /wp-json.' : null;
  },
  authHeaders(secret, _settings) {
    const value = Buffer.from(`${secret.username}:${String(secret.application_password).replace(/\s+/g, '')}`).toString('base64');
    return { Authorization: `Basic ${value}` };
  },
  async check(client) {
    const sections = {
      connection: await section(async () => {
        const index = expectObject(await client.get('/wp-json/'));
        const me = expectObject(await client.get('/wp-json/wp/v2/users/me', { query: { context: 'edit' } }));
        return {
          site_name: index.name ?? null,
          namespaces: expectArray(index.namespaces ?? []).slice(0, 50),
          service_user_roles: Array.isArray(me.roles) ? me.roles : []
        };
      }),
      site_health: await section(async () => {
        const tests = {};
        for (const test of SITE_HEALTH_TESTS) {
          const result = expectObject(await client.get(`/wp-json/wp-site-health/v1/tests/${test}`));
          tests[test] = { status: result.status ?? 'unknown', label: result.label ?? test };
        }
        return tests;
      }),
      plugin_inventory: await section(async () => expectArray(await client.get('/wp-json/wp/v2/plugins', { query: { context: 'edit' } }))
        .map(plugin => ({ plugin: plugin.plugin, name: plugin.name, version: plugin.version, status: plugin.status }))),
      theme_inventory: await section(async () => expectArray(await client.get('/wp-json/wp/v2/themes', { query: { context: 'edit' } }))
        .map(theme => ({ stylesheet: theme.stylesheet, name: theme.name?.raw ?? theme.name, version: theme.version, status: theme.status })))
    };
    return sections;
  },
  async runOperation(client, key, params) {
    if (key === 'plugin.set_status') {
      await client.post(`/wp-json/wp/v2/plugins/${params.plugin}`, { json: { status: params.status } });
    }
  }
};
