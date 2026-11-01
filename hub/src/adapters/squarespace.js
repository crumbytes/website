import { expectArray, expectObject, section, SUPPORT } from './framework.js';

const BASE_URL = 'https://api.squarespace.com';

export const squarespace = {
  key: 'squarespace',
  label: 'Squarespace',
  docsUrl: 'https://developers.squarespace.com/commerce-apis/overview',
  baseUrlHint: `Always ${BASE_URL}. The API key identifies the site.`,
  fixedBaseUrl: BASE_URL,
  authTypes: [{
    key: 'api_key',
    label: 'Developer API key',
    guidance: 'API keys for custom applications need the Commerce Advanced plan. Other plans need a registered OAuth extension, which is not built yet.',
    fields: [{ name: 'api_key', label: 'API key', secret: true }]
  }],
  capabilities: [
    { key: 'connection', label: 'Basic site information', support: SUPPORT.API_PERMISSION, requires: 'Commerce Advanced plan for an API key', notes: 'GET /1.0/authorization/website.' },
    { key: 'commerce_inventory', label: 'Commerce stock inventory', support: SUPPORT.API_PERMISSION, requires: 'Inventory read permission on the key', notes: 'GET /1.0/commerce/inventory. This is store stock, not page or software inventory.' },
    { key: 'content_inventory', label: 'Pages and content', support: SUPPORT.UNSUPPORTED, notes: 'The official APIs are commerce-focused and offer no general content API.' },
    { key: 'software_inventory', label: 'CMS version and extensions', support: SUPPORT.UNSUPPORTED, notes: 'Squarespace is hosted and does not expose versions.' },
    { key: 'software_updates', label: 'Platform updates', support: SUPPORT.UNSUPPORTED, notes: 'Squarespace updates the platform itself.' },
    { key: 'backups', label: 'Backups and restore', support: SUPPORT.MANUAL, notes: 'There is no backup API. Document the manual process and record what was done.' }
  ],
  operations: [],
  validateConnection() { return null; },
  authHeaders(secret) {
    return { Authorization: `Bearer ${secret.api_key}` };
  },
  async check(client) {
    return {
      connection: await section(async () => {
        const site = expectObject(await client.get('/1.0/authorization/website'));
        return { siteId: site.siteId ?? null, title: site.title ?? null, url: site.url ?? null, currency: site.currency ?? null, timeZone: site.timeZone ?? null };
      }),
      commerce_inventory: await section(async () => {
        const result = expectObject(await client.get('/1.0/commerce/inventory'));
        return { items_on_first_page: expectArray(result.inventory).length, has_more: Boolean(result.pagination?.hasNextPage) };
      })
    };
  }
};
