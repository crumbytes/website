import { forbidden } from './errors.js';

const ALL = ['owner', 'admin', 'technician', 'billing', 'viewer'];
const OPERATORS = ['owner', 'admin', 'technician'];
const ADMINS = ['owner', 'admin'];

// Application-level checks. Row level security in 0002_access_control.sql enforces
// the same rules again, so a mistake in one layer does not expose another client.
export const PERMISSIONS = Object.freeze({
  'overview.read': ALL,
  'client.read': ALL,
  'client.write': ADMINS,
  'plan.write': ADMINS,
  'website.read': ALL,
  'website.write': OPERATORS,
  'connection.read': ALL,
  'connection.write': ADMINS,
  'credential.write': ADMINS,
  'connection.check': OPERATORS,
  'operation.request': OPERATORS,
  'operation.decide': ADMINS,
  'operation.execute': ADMINS,
  'maintenance.read': ALL,
  'maintenance.write': OPERATORS,
  'monitoring.read': ALL,
  'monitoring.write': OPERATORS,
  'security.read': ALL,
  'security.write': OPERATORS,
  'backup.read': ALL,
  'backup.write': OPERATORS,
  'staff.read': ADMINS,
  'staff.write': ADMINS,
  'audit.read': ADMINS
});

export const can = (staff, permission) => Boolean(staff && PERMISSIONS[permission]?.includes(staff.role));

export function requirePermission(staff, permission) {
  if (!can(staff, permission)) throw forbidden();
}
