import { z } from 'zod';
import { AdapterError, createPlatformClient, defineAdapter, expectArray, expectObject, SUPPORT } from './framework.js';

// Pinned on purpose. Shopify retires versions on a schedule, so moving this is a
// reviewed change rather than something that happens on its own.
export const SHOPIFY_API_VERSION = '2026-10';
const GRAPHQL_PATH = `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

async function graphql(client, query, variables) {
  const result = expectObject(await client.post(GRAPHQL_PATH, { json: { query, variables } }));
  if (Array.isArray(result.errors) && result.errors.length) {
    const codes = result.errors.map(error => error?.extensions?.code);
    if (codes.includes('ACCESS_DENIED')) throw new AdapterError('permission_required');
    if (codes.includes('THROTTLED')) throw new AdapterError('rate_limited');
    throw new AdapterError('operation_rejected');
  }
  return expectObject(result.data);
}

export const shopify = defineAdapter({
  key: 'shopify',
  label: 'Shopify',
  docsUrl: 'https://shopify.dev/docs/api/admin-graphql',
  baseUrlHint: 'The admin store address, for example https://your-store.myshopify.com',
  authTypes: [
    {
      key: 'client_credentials',
      label: 'Dev Dashboard app (client credentials)',
      guidance: 'For an app and store in the same Shopify organization. The hub stores the client ID and secret and requests a 24-hour token when needed.',
      fields: [
        { name: 'client_id', label: 'Client ID', secret: true },
        { name: 'client_secret', label: 'Client secret', secret: true }
      ]
    },
    {
      key: 'admin_access_token',
      label: 'Admin API access token',
      guidance: 'For an existing custom app installation. Grant only the scopes this hub uses.',
      fields: [{ name: 'access_token', label: 'Admin API access token', secret: true }]
    }
  ],
  capabilities: [
    { key: 'connection', label: 'Store identity and health', support: SUPPORT.API, notes: 'Admin GraphQL shop query, with no extra scope beyond the installed app.' },
    { key: 'granted_scopes', label: 'Granted API scopes', support: SUPPORT.API, notes: 'currentAppInstallation.accessScopes shows what this connection can do.' },
    { key: 'theme_inventory', label: 'Theme inventory', support: SUPPORT.API_PERMISSION, requires: 'read_themes scope', notes: 'Admin GraphQL themes query.' },
    { key: 'url_redirects', label: 'Create a URL redirect', support: SUPPORT.API_PERMISSION, requires: 'write_online_store_navigation scope and hub approval', notes: 'urlRedirectCreate mutation.' },
    { key: 'installed_apps', label: 'Full list of installed apps', support: SUPPORT.MANUAL, notes: 'A custom app cannot list other installed apps. Review them in the Shopify admin.' },
    { key: 'software_updates', label: 'Platform updates', support: SUPPORT.UNSUPPORTED, notes: 'Shopify is hosted and updates the platform itself.' },
    { key: 'backups', label: 'Backups', support: SUPPORT.MANUAL, notes: 'Shopify has no store backup API. Use a backup provider app and record its evidence.' }
  ],
  operations: [{
    key: 'url_redirect.create',
    label: 'Create a URL redirect',
    capability: 'url_redirects',
    params: z.object({
      path: z.string().regex(/^\/[^\s]*$/, 'Use a path that starts with /').max(255),
      target: z.string().regex(/^(\/|https:\/\/)[^\s]*$/, 'Use a path or an https address').max(255)
    })
  }],
  validateConnection(baseUrl) {
    const url = new URL(baseUrl);
    return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(url.hostname) && url.pathname === '/'
      ? null : 'Use the store address, such as https://your-store.myshopify.com';
  },
  authHeaders(secret) {
    return secret.access_token ? { 'X-Shopify-Access-Token': secret.access_token } : {};
  },
  // Client credentials are swapped for a short-lived token, which is never stored.
  async prepareAuth(secret, { baseUrl, http, timeoutMs }) {
    if (!secret.client_id) return this.authHeaders(secret);
    const client = createPlatformClient({ baseUrl, http, timeoutMs });
    const token = expectObject(await client.post('/admin/oauth/access_token', {
      form: { grant_type: 'client_credentials', client_id: secret.client_id, client_secret: secret.client_secret }
    }));
    if (typeof token.access_token !== 'string' || !token.access_token) throw new AdapterError('invalid_response');
    return { 'X-Shopify-Access-Token': token.access_token };
  },
  sections(client) {
    return {
      connection: async () => {
        const { shop } = await graphql(client, `{ shop { name myshopifyDomain ianaTimezone currencyCode setupRequired checkoutApiSupported primaryDomain { url sslEnabled } } }`);
        return expectObject(shop);
      },
      granted_scopes: async () => {
        const { currentAppInstallation } = await graphql(client, `{ currentAppInstallation { accessScopes { handle } } }`);
        return expectArray(currentAppInstallation?.accessScopes).map(scope => scope.handle);
      },
      theme_inventory: async () => {
        const { themes } = await graphql(client, `{ themes(first: 25) { nodes { id name role updatedAt } } }`);
        return expectArray(themes?.nodes);
      }
    };
  },
  async runOperation(client, key, params) {
    if (key === 'url_redirect.create') {
      const data = await graphql(client,
        `mutation hubRedirect($urlRedirect: UrlRedirectInput!) { urlRedirectCreate(urlRedirect: $urlRedirect) { urlRedirect { id } userErrors { field message } } }`,
        { urlRedirect: params });
      if (data.urlRedirectCreate?.userErrors?.length) throw new AdapterError('operation_rejected');
    }
  }
});
