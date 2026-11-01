import { defineAdapter, expectArray, expectObject, SUPPORT } from './framework.js';

const API = '/api/index.php/v1';

export const joomla = defineAdapter({
  key: 'joomla',
  label: 'Joomla',
  docsUrl: 'https://manual.joomla.org/docs/general-concepts/webservices/',
  baseUrlHint: 'The site address, for example https://www.example.com. Joomla 4 or later.',
  authTypes: [{
    key: 'api_token',
    label: 'Joomla API token',
    guidance: 'Generate it in the service user profile. The API Authentication - Web Services Joomla Token plugin and the Web Services - Installer plugin must be enabled.',
    fields: [{ name: 'api_token', label: 'API token', secret: true }]
  }],
  capabilities: [
    { key: 'connection', label: 'Connection check', support: SUPPORT.API_PERMISSION, requires: 'Joomla API token plugin enabled, and core.login.api for the user', notes: 'GET /api/index.php/v1/extensions, limited to one row.' },
    { key: 'extension_inventory', label: 'CMS version and extension inventory', support: SUPPORT.API_PERMISSION, requires: 'Web Services - Installer plugin enabled, and permission to manage extensions', notes: 'GET /api/index.php/v1/extensions. The core version comes from the files_joomla row.' },
    { key: 'update_status', label: 'Core update status', support: SUPPORT.MANUAL, notes: 'Newer Joomla releases add joomlaupdate routes. They are version-dependent and not used yet, so check in the administrator area.' },
    { key: 'software_updates', label: 'Core and extension updates', support: SUPPORT.MANUAL, notes: 'Apply in the administrator area or on the host, then record the work.' },
    { key: 'backups', label: 'Backups', support: SUPPORT.MANUAL, notes: 'Joomla core has no backup API. Connect the backup provider separately.' }
  ],
  operations: [],
  validateConnection(baseUrl) {
    return new URL(baseUrl).pathname.startsWith('/api') ? 'Use the site address without /api.' : null;
  },
  authHeaders(secret) {
    return { 'X-Joomla-Token': secret.api_token, Accept: 'application/vnd.api+json' };
  },
  sections(client) {
    return {
      connection: async () => {
        const result = expectObject(await client.get(`${API}/extensions`, { query: { 'page[limit]': '1' } }));
        expectArray(result.data);
        return { api_reachable: true };
      },
      extension_inventory: async () => {
        const result = expectObject(await client.get(`${API}/extensions`, { query: { 'page[limit]': '100' } }));
        const extensions = expectArray(result.data).map(item => {
          const attributes = item.attributes ?? {};
          return { name: attributes.name, type: attributes.type, version: attributes.version ?? null, enabled: attributes.status ?? null };
        });
        const core = extensions.find(item => item.name === 'files_joomla');
        return { core_version: core?.version ?? null, extensions, has_more: Boolean(result.links?.next) };
      }
    };
  }
});
