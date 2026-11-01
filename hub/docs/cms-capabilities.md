# CMS adapter framework and platform capabilities

**No adapter has connected to a live site.** Each is written from official documentation and tested against simulated responses. That shows the hub handles those response shapes and failures. It does not show that a real platform behaves the same way. The table below is from documentation reviewed on 2026-11-01. Confirm each row with an authorized test site before relying on it.

## Support levels

| Level | Meaning |
| --- | --- |
| Supported API | Official API, available with the connection's normal credential. |
| API with added permission | Official API, but needs a specific scope, role, plan or enabled setting. |
| Manual workflow | No suitable API. Staff do the work and record the result in the hub. |
| Not available | The platform does not offer this. |

The same information appears in the app on the Integrations page and each website's connection section, and comes from each adapter's `capabilities` list, so the two cannot drift apart.

## WordPress

Auth: Application Passwords over HTTPS, for a dedicated service user.

| Capability | Level | Detail |
| --- | --- | --- |
| Connection and identity | Supported API | `GET /wp-json/`, `GET /wp/v2/users/me` |
| Site health | Added permission | The five `wp-site-health/v1/tests/*` routes. Needs `view_site_health_checks`. |
| Plugin inventory and versions | Added permission | `GET /wp/v2/plugins`. Needs `activate_plugins`. |
| Theme inventory and versions | Added permission | `GET /wp/v2/themes` |
| Activate or deactivate a plugin | Added permission, with hub approval | `POST /wp/v2/plugins/<plugin>` |
| Core version | **Manual** | Core REST routes do not report it. |
| Core, plugin and theme updates | **Manual** | Core REST can install and activate, not update. |
| Backups | **Manual** | No core API. Use a backup provider. |

A companion plugin or WP-CLI access could close the version and update gaps. That is a separate decision, because it adds code to customer sites.

## Shopify

Auth: Dev Dashboard client credentials, for an app and store in the same organization (24-hour tokens, exchanged when needed and never stored), or an existing Admin API token. Admin GraphQL, version pinned to `2026-10`. Shopify retires versions on a schedule, so someone must own moving this.

| Capability | Level | Detail |
| --- | --- | --- |
| Store identity and health | Supported API | `shop` query |
| Granted scopes | Supported API | `currentAppInstallation.accessScopes` |
| Theme inventory | Added permission | `read_themes` |
| Create a URL redirect | Added permission, with hub approval | `write_online_store_navigation` |
| Full list of installed apps | **Manual** | Review in the Shopify admin. |
| Platform updates | Not available | Shopify handles them. |
| Backups | **Manual** | No store backup API. |

**Open question:** client credentials only reach stores in CrumByte's own Shopify organization. Customer-owned stores outside it need a different route, such as authorization code or a collaborator arrangement, which is not built.

## Wix

Auth: API key from the API Keys Manager, with one scope header per call.

| Capability | Level | Detail |
| --- | --- | --- |
| Site properties | Added permission | `GET /site-properties/v4/properties`, requesting operational fields only. The same endpoint can return contact details, which are deliberately not requested. |
| Site record: published, premium, domain | Added permission | `POST /site-list/v2/sites/query`. Needs an account-level key. |
| CMS version and extensions | Not available | Hosted platform. |
| Backups and restore | **Manual** | Site History in the dashboard. |

## Squarespace

Auth: API key on the **Commerce Advanced plan**. Other plans need a registered OAuth extension, which is not built.

| Capability | Level | Detail |
| --- | --- | --- |
| Basic site information | Added permission | `GET /1.0/authorization/website` |
| Commerce stock | Added permission | `GET /1.0/commerce/inventory`. This is store stock, not software. |
| Pages and content | Not available | The official APIs are commerce-focused. |
| CMS version and extensions | Not available | Hosted platform. |
| Backups and restore | **Manual** | No backup API. |

## Joomla

Auth: API token in `X-Joomla-Token`, Joomla 4 or later. The token authentication and Installer web services plugins must be enabled.

| Capability | Level | Detail |
| --- | --- | --- |
| Connection | Added permission | `GET /api/index.php/v1/extensions` |
| CMS version and extension inventory | Added permission | Same route. The core version comes from the `files_joomla` row, and this mapping is the least certain and most in need of a live test. |
| Core update status | **Manual** | Joomla's source has `joomlaupdate` routes, but they depend on the version and are not used yet. |
| Core and extension updates | **Manual** | Administrator area or host. |
| Backups | **Manual** | No core API. |

## Other CMS

No adapter. Uptime and certificate monitoring, maintenance, security reviews and backup evidence all still work.

## Adding a platform

Create one module in `src/adapters/` and add it to the list in `index.js`. It declares:

```js
{
  key, label, docsUrl, baseUrlHint,
  fixedBaseUrl,                   // Optional, for APIs on a vendor domain.
  settingsFields,                 // Optional non-secret identifiers.
  authTypes: [{ key, label, guidance, fields }],
  capabilities: [{ key, label, support, requires, notes }],
  operations: [{ key, label, capability, params }], // params is a Zod schema.
  validateConnection(baseUrl, settings),
  authHeaders(secret, settings),
  prepareAuth(secret, options),   // Optional, for token exchange.
  check(client, { settings }),    // Returns sections built with section().
  runOperation(client, key, params) // Required if there are operations.
}
```

Also add the platform's key to the `adapter_key` and `cms_platform` checks in a new migration. `tests/adapters.test.mjs` verifies the contract for every registered adapter, including that anything needing added permission names what it needs.

Failures from any platform become one of the safe codes in `framework.js`. Provider bodies and headers are dropped, because they can echo credentials or customer data. One failed section does not hide the others, and a denied section shows as needing permission, never as a pass.

## Sources

- [WordPress plugins reference](https://developer.wordpress.org/rest-api/reference/plugins/), [site health tests](https://developer.wordpress.org/rest-api/reference/wp-site-health-tests/)
- [Shopify client credentials](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant), [Admin GraphQL `currentAppInstallation`](https://shopify.dev/docs/api/admin-graphql/latest/queries/currentAppInstallation)
- [Wix Site Properties](https://dev.wix.com/docs/api-reference/business-management/site-properties/properties/get-site-properties), [Query Sites](https://dev.wix.com/docs/api-reference/account-level/sites/sites/query-sites), [API key calls](https://dev.wix.com/docs/api-reference/articles/authentication/api-keys/make-api-calls-with-an-api-key)
- [Squarespace authentication and permissions](https://developers.squarespace.com/commerce-apis/authentication-and-permissions), [basic site information](https://developers.squarespace.com/commerce-apis/retrieve-basic-site-info)
- [Joomla web services](https://manual.joomla.org/docs/general-concepts/webservices/), [Installer plugin source](https://github.com/joomla/joomla-cms/blob/5.4-dev/plugins/webservices/installer/src/Extension/Installer.php)
