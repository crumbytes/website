import { SUPPORT } from './framework.js';
import { joomla } from './joomla.js';
import { shopify } from './shopify.js';
import { squarespace } from './squarespace.js';
import { wix } from './wix.js';
import { wordpress } from './wordpress.js';

// Adding a platform means adding one module with this same shape to this list.
export const ADAPTERS = Object.freeze({ wordpress, shopify, wix, squarespace, joomla });

export const getAdapter = key => (Object.hasOwn(ADAPTERS, key) ? ADAPTERS[key] : null);

// Sites on any other CMS still get uptime, certificate and manual records.
export const OTHER_PLATFORM = Object.freeze({
  key: 'other',
  label: 'Other CMS',
  docsUrl: null,
  authTypes: [],
  operations: [],
  capabilities: [
    { key: 'connection', label: 'Platform API connection', support: SUPPORT.UNSUPPORTED, notes: 'No adapter yet. Add one with the same module shape if this platform has a supported API.' },
    { key: 'software_inventory', label: 'Version and extension inventory', support: SUPPORT.MANUAL, notes: 'Record it in a security review or service history entry.' },
    { key: 'backups', label: 'Backups', support: SUPPORT.MANUAL, notes: 'Record the provider and restore evidence in the hub.' }
  ]
});

export const CMS_PLATFORMS = Object.freeze([
  ...Object.values(ADAPTERS).map(({ key, label }) => ({ key, label })),
  { key: OTHER_PLATFORM.key, label: OTHER_PLATFORM.label }
]);
