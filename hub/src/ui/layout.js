import { createHash } from 'node:crypto';
import { html, raw } from 'hono/html';
import { can } from '../authz.js';
import { HUB_CSS } from './styles.js';

// The hash changes with the content, so a release can never show stale styles.
const CSS_HREF = `/assets/hub.css?v=${createHash('sha256').update(HUB_CSS).digest('hex').slice(0, 12)}`;

// hono/html escapes every interpolated value unless it is itself html``.

const NAV = [
  ['/', 'Overview', 'overview.read'],
  ['/websites', 'Client websites', 'website.read'],
  ['/clients', 'Clients', 'client.read'],
  ['/maintenance', 'Maintenance', 'maintenance.read'],
  ['/monitoring', 'Monitoring', 'monitoring.read'],
  ['/security', 'Security', 'security.read'],
  ['/backups', 'Backups', 'backup.read'],
  ['/hosting', 'Hosting providers', 'website.read'],
  ['/integrations', 'Integrations', 'website.read'],
  ['/staff', 'Staff', 'staff.read'],
  ['/audit', 'Audit log', 'audit.read']
];

// Only the two ends of the release path look different, so nobody mistakes one for production.
const ENVIRONMENT_NOTE = { staging: 'Staging environment', development: 'Local development', test: 'Test environment' };

export function shell({ title, active, view, body, notice, actions }) {
  const { staff, csrfToken, unread = 0, environment } = view;
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>${title} | CrumByte Hub</title>
<link rel="stylesheet" href="${CSS_HREF}"></head>
<body><a class="skip" href="#main">Skip to content</a><div class="app">
<aside class="sidebar" aria-label="Hub navigation">
  <a class="brand" href="/"><span class="brandmark" aria-hidden="true">C</span><span><strong>CrumByte</strong><small>Website hub</small></span></a>
  <div><p class="nav-label">Workspace</p><nav class="nav" aria-label="Sections">
    ${NAV.filter(item => can(staff, item[2])).map(([href, label]) =>
      html`<a href="${href}" ${href === active ? raw('aria-current="page"') : ''}>${label}</a>`)}
    <a href="/notifications" ${active === '/notifications' ? raw('aria-current="page"') : ''}>Notifications${unread ? html` <span class="tag warn">${unread}<span class="skip"> unread</span></span>` : ''}</a>
    <a href="/account" ${active === '/account' ? raw('aria-current="page"') : ''}>Your account</a>
  </nav></div>
  <div class="who"><div><strong>${staff.display_name}</strong>${roleLabel(staff.role)}</div>
    <form method="post" action="/logout">${csrf(csrfToken)}<button class="btn quiet" type="submit">Sign out</button></form></div>
</aside>
<main id="main">
  ${ENVIRONMENT_NOTE[environment] ? html`<div class="banner warn" role="note"><strong>${ENVIRONMENT_NOTE[environment]}</strong></div>` : ''}
  <header class="topbar"><div><div class="eyebrow">CrumByte Technologies / Internal</div><h1>${title}</h1></div>
    ${actions ? html`<div>${actions}</div>` : ''}</header>
  ${notice ? html`<div class="banner ${notice.kind ?? ''}" role="status"><strong>${notice.title}</strong>${notice.text ?? ''}</div>` : ''}
  ${body}
  <footer class="footer">Internal use only. Every change is written to the audit log.</footer>
</main></div></body></html>`;
}

export const roleLabel = role => ({ owner: 'Owner', admin: 'Admin', technician: 'Technician', billing: 'Billing', viewer: 'Viewer' }[role] ?? role);

export const csrf = token => html`<input type="hidden" name="_csrf" value="${token}">`;
export const postForm = (action, view, content, klass = 'stack') => html`<form class="${klass}" method="post" action="${action}">${csrf(view.csrfToken)}${content}</form>`;
export const submit = (label, klass = 'btn') => html`<div><button class="${klass}" type="submit">${label}</button></div>`;
export const stateBanner = state => (state?.errors
  ? html`<div class="banner error" role="alert"><strong>${state.message ?? 'That could not be saved.'}</strong>${Object.values(state.errors).join(' ')}</div>` : '');

export function barePage({ title, body }) {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>${title} | CrumByte Hub</title>
<link rel="stylesheet" href="${CSS_HREF}"></head>
<body><main class="login"><section><a class="brand" href="/"><span class="brandmark" aria-hidden="true">C</span><span><strong>CrumByte</strong><small>Website hub</small></span></a>${body}</section></main></body></html>`;
}

// Form helpers ---------------------------------------------------------------

// One page can hold several forms with the same field names, and each label needs
// to point at its own control.
let fieldCounter = 0;

function fieldWrap(field, state, control) {
  const error = state.errors?.[field.name];
  fieldCounter = (fieldCounter + 1) % 1e6;
  const id = `f-${field.name}-${fieldCounter}`;
  return html`<div class="field ${error ? 'invalid' : ''}">
    <label for="${id}">${field.label}${field.required ? '' : html` <span class="muted">(optional)</span>`}</label>
    ${control(id, error)}
    ${field.help ? html`<span class="help" id="${id}-help">${field.help}</span>` : ''}
    ${error ? html`<span class="field-error" id="${id}-error">${error}</span>` : ''}
  </div>`;
}

const describedBy = (id, field, error) => {
  const ids = [field.help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  return ids ? raw(`aria-describedby="${ids}"`) : '';
};

export function fields(list, state = {}) {
  const values = state.values ?? {};
  return list.map(field => fieldWrap(field, state, (id, error) => {
    const value = values[field.name] ?? field.value ?? '';
    const required = field.required ? raw('required') : '';
    const described = describedBy(id, field, error);
    const invalidAttr = error ? raw('aria-invalid="true"') : '';
    if (field.type === 'select') {
      return html`<select id="${id}" name="${field.name}" ${required} ${described} ${invalidAttr}>
        ${field.placeholder !== undefined ? html`<option value="">${field.placeholder}</option>` : ''}
        ${field.options.map(option => html`<option value="${option.value}" ${String(option.value) === String(value) ? raw('selected') : ''}>${option.label}</option>`)}
      </select>`;
    }
    if (field.type === 'textarea') {
      return html`<textarea id="${id}" name="${field.name}" ${required} ${described} ${invalidAttr}>${value}</textarea>`;
    }
    // Secrets are never written back into a page, including after a failed submit.
    if (field.type === 'password') {
      return html`<input id="${id}" type="password" name="${field.name}" autocomplete="off" spellcheck="false" ${required} ${described} ${invalidAttr}>`;
    }
    return html`<input id="${id}" type="${field.type ?? 'text'}" name="${field.name}" value="${value}" ${required} ${described} ${invalidAttr}>`;
  }));
}

export const formErrorBanner = state => (state?.errors?._ || state?.message
  ? html`<div class="banner error" role="alert"><strong>${state.message ?? 'That could not be saved.'}</strong>${state.errors?._ ?? ''}</div>` : '');

// Display helpers ------------------------------------------------------------

export function dateTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export const tag = (text, kind = '') => html`<span class="tag ${kind}">${text}</span>`;

export const empty = (title, text) => html`<div class="empty"><strong>${title}</strong><p>${text}</p></div>`;

export const statusTag = status => {
  const kinds = {
    open: '', in_progress: '', blocked: 'warn', completed: 'good', cancelled: 'unknown',
    active: 'good', inactive: 'unknown', paused: 'warn', offboarded: 'unknown', disabled: 'unknown',
    not_connected: 'unknown', connected: 'good', partial: 'warn', failed: 'bad',
    requested: 'warn', approved: '', rejected: 'unknown', executed: 'good',
    succeeded: 'good', unknown: 'unknown', passed: 'good',
    no_findings: 'good', findings: 'bad', incomplete: 'warn',
    low: 'unknown', normal: '', high: 'warn', urgent: 'bad'
  };
  return tag(String(status).replaceAll('_', ' '), kinds[status] ?? '');
};

// No result means nobody has measured. It is never shown as a good state.
export function monitoringTag(outcome) {
  if (outcome === 'up') return tag('Reachable', 'good');
  if (outcome === 'down') return tag('Not reachable from hub', 'bad');
  if (outcome === 'error') return tag('Check failed', 'warn');
  return tag('Unknown: not checked', 'unknown');
}

export function recoverabilityTag(recoverability) {
  const kinds = { verified: 'good', restore_failed: 'bad', evidence_stale: 'warn', unverified: 'warn', no_backups: 'unknown' };
  return tag(recoverability.label, kinds[recoverability.state]);
}
