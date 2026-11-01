import { expectArray, expectObject, section, SUPPORT } from './framework.js';

const BASE_URL = 'https://www.wixapis.com';
// Limited to operational fields. The same endpoint can return business contact
// details, which belong in StackLTR and are not requested here.
const PROPERTY_FIELDS = ['siteDisplayName', 'timeZone', 'language', 'paymentCurrency', 'businessConfig'];

export const wix = {
  key: 'wix',
  label: 'Wix',
  docsUrl: 'https://dev.wix.com/docs/api-reference',
  baseUrlHint: `Always ${BASE_URL}. Wix APIs are not on the site address.`,
  fixedBaseUrl: BASE_URL,
  settingsFields: [
    { name: 'site_id', label: 'Wix site ID', required: true },
    { name: 'account_id', label: 'Wix account ID', required: false, help: 'Needed only for the account-level site listing.' }
  ],
  authTypes: [{
    key: 'api_key',
    label: 'Wix API key',
    guidance: 'Create the key in the Wix API Keys Manager, limited to this site and the permissions below.',
    fields: [{ name: 'api_key', label: 'API key', secret: true }]
  }],
  capabilities: [
    { key: 'connection', label: 'Site properties', support: SUPPORT.API_PERMISSION, requires: 'API key permission for Site Properties', notes: 'GET /site-properties/v4/properties.' },
    { key: 'site_inventory', label: 'Site record: published, premium, domain', support: SUPPORT.API_PERMISSION, requires: 'Account-level API key with Read Site Data, and the account ID', notes: 'POST /site-list/v2/sites/query.' },
    { key: 'software_inventory', label: 'CMS version and extensions', support: SUPPORT.UNSUPPORTED, notes: 'Wix is hosted and does not expose versions. Installed apps are reviewed in the dashboard.' },
    { key: 'software_updates', label: 'Platform updates', support: SUPPORT.UNSUPPORTED, notes: 'Wix updates the platform itself.' },
    { key: 'backups', label: 'Backups and restore', support: SUPPORT.MANUAL, notes: 'Use Site History in the Wix dashboard and record what was done.' }
  ],
  operations: [],
  validateConnection(_baseUrl, settings) {
    return /^[0-9a-f-]{36}$/i.test(settings?.site_id ?? '') ? null : 'Enter the Wix site ID.';
  },
  authHeaders(secret) {
    return { Authorization: secret.api_key };
  },
  async check(client, { settings }) {
    const sections = {
      connection: await section(async () => {
        const result = expectObject(await client.get('/site-properties/v4/properties', {
          query: { 'fields.paths': PROPERTY_FIELDS },
          headers: { 'wix-site-id': settings.site_id }
        }));
        return Object.fromEntries(PROPERTY_FIELDS.map(field => [field, result.properties?.[field] ?? null]));
      })
    };
    // Wix allows one scope header per call, so this one sends only the account ID.
    if (settings.account_id) {
      sections.site_inventory = await section(async () => {
        const result = expectObject(await client.post('/site-list/v2/sites/query', {
          headers: { 'wix-account-id': settings.account_id },
          json: { query: { filter: { id: { $eq: settings.site_id } }, cursorPaging: { limit: 1 } } }
        }));
        return expectArray(result.sites).map(site => ({
          id: site.id, displayName: site.displayName, published: site.published, premium: site.premium,
          domainConnected: site.domainConnected, blocked: site.blocked, viewUrl: site.viewUrl
        }));
      });
    }
    return sections;
  }
};
