import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Runs the real server and a real browser, against an empty in-memory database.
// Every record is synthetic, and the two clients are independent test clients.
const unique = Date.now().toString(36);
const CLIENT_A = `E2E Client A ${unique}`;
const CLIENT_B = `E2E Client B ${unique}`;
const SITE_A = `E2E Site A ${unique}`;
const SITE_B = `E2E Site B ${unique}`;
let siteAUrl;
let siteBUrl;
let clientBUrl;

async function signIn(page, name) {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in with your work account' }).click();
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

async function addClient(page, name) {
  await page.goto('/clients/new');
  await page.getByLabel('Client name').fill(name);
  await page.getByRole('button', { name: 'Add client' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return page.url().split('?')[0];
}

async function addWebsite(page, client, name, slug) {
  await page.goto('/websites/new');
  await page.getByLabel('Client', { exact: true }).selectOption({ label: client });
  await page.getByLabel('Website name').fill(name);
  await page.getByLabel('Website address').fill(`https://${slug}-${unique}.example.test`);
  await page.getByLabel('CMS platform').selectOption('wordpress');
  await page.getByRole('button', { name: 'Add website' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return page.url().split('?')[0];
}

test.describe.configure({ mode: 'serial' });

test('an anonymous visitor sees no client information', async ({ page }) => {
  for (const path of ['/', '/websites', '/clients', '/maintenance', '/monitoring', '/security', '/backups', '/audit']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('body')).not.toContainText('E2E');
  }
  const api = await page.request.get('/api/v1/websites');
  expect(api.status()).toBe(401);
});

test('an owner sets up two independent clients through the interface', async ({ page }) => {
  await signIn(page, 'Local Owner');
  await expect(page.locator('main')).toContainText('This is not a clean result');
  await addClient(page, CLIENT_A);
  clientBUrl = await addClient(page, CLIENT_B);
  siteAUrl = await addWebsite(page, CLIENT_A, SITE_A, 'alpha');
  siteBUrl = await addWebsite(page, CLIENT_B, SITE_B, 'bravo');
  await expect(page.locator('main')).toContainText('Unknown: not checked');
  await expect(page.locator('main')).toContainText('No backups recorded');
  await expect(page.locator('main')).toContainText('Not assessed');

  await page.goto('/staff');
  const row = page.getByRole('row', { name: /Local Technician/ });
  await row.getByLabel('Client to assign to Local Technician').selectOption({ label: CLIENT_A });
  await row.getByRole('button', { name: 'Assign' }).click();
  await expect(page.getByRole('row', { name: /Local Technician/ })).toContainText(CLIENT_A);
});

test('a technician assigned to one client cannot see or reach the other', async ({ page }) => {
  await signIn(page, 'Local Technician');
  await page.goto('/websites');
  await expect(page.locator('main')).toContainText(SITE_A);
  await expect(page.locator('main')).not.toContainText(SITE_B);
  await page.goto('/clients');
  await expect(page.locator('main')).not.toContainText(CLIENT_B);
  expect((await page.goto(siteBUrl)).status()).toBe(404);
  await expect(page.locator('body')).not.toContainText(SITE_B);
  expect((await page.goto(clientBUrl)).status()).toBe(404);
  const id = siteBUrl.split('/').pop();
  expect((await page.request.get(`/api/v1/websites/${id}`)).status()).toBe(404);
  expect((await page.goto('/audit')).status()).toBe(403);
  expect((await page.goto('/staff')).status()).toBe(403);
});

test('a technician records maintenance from start to finish', async ({ page }) => {
  await signIn(page, 'Local Technician');
  await page.goto(siteAUrl);
  await page.getByText('Add a task', { exact: true }).click();
  const form = page.locator('form[action="/maintenance/tasks"]').first();
  await form.getByLabel('Task', { exact: true }).fill('Check contact form');
  await form.getByLabel(/^Due/).fill('2020-01-15');
  await form.getByRole('button', { name: 'Add task' }).click();
  await expect(page.locator('#maintenance')).toContainText('Check contact form');
  await expect(page.locator('#maintenance')).toContainText('Overdue');

  await page.locator('#maintenance').getByText('Log work', { exact: true }).click();
  await page.getByLabel('What you did').fill('Sent a test submission');
  await page.getByRole('spinbutton', { name: 'Minutes (optional)' }).fill('15');
  await page.getByRole('button', { name: 'Add to work log' }).click();
  await expect(page.locator('#maintenance')).toContainText('Sent a test submission');

  await page.locator('#maintenance').getByText('Complete', { exact: true }).click();
  await page.getByLabel('What was done').first().fill('Form delivers correctly');
  await page.getByRole('button', { name: 'Mark completed' }).click();
  await expect(page.locator('#history')).toContainText('Check contact form: Form delivers correctly');
  await expect(page.locator('main')).toContainText(new RegExp('Last maintenance'));
});

test('invalid input shows a clear error and keeps what was typed', async ({ page }) => {
  await signIn(page, 'Local Owner');
  await page.goto('/websites/new');
  await page.getByLabel('Client', { exact: true }).selectOption({ label: CLIENT_A });
  await page.getByLabel('Website name').fill('Bad Address Site');
  await page.getByLabel('Website address').evaluate(element => { element.type = 'text'; });
  await page.getByLabel('Website address').fill('javascript:alert(1)');
  await page.getByLabel('CMS platform').selectOption('other');
  await page.getByRole('button', { name: 'Add website' }).click();
  await expect(page.locator('main')).toContainText('Enter a full web address');
  await expect(page.getByLabel('Website name')).toHaveValue('Bad Address Site');
  await expect(page.getByLabel('Website address')).toHaveAttribute('aria-invalid', 'true');
});

test('a backup never reads as recoverable until a restore test passes', async ({ page }) => {
  await signIn(page, 'Local Owner');
  await page.goto(siteAUrl);
  await page.getByText('Add a backup source', { exact: true }).click();
  const source = page.locator('form[action="/backups/sources"]');
  await source.getByLabel('Provider', { exact: true }).fill('Example Backup');
  await source.getByLabel('Description').fill('Nightly');
  await source.getByRole('button', { name: 'Add source' }).click();
  await page.getByText('Record a backup run', { exact: true }).click();
  const run = page.locator('form[action="/backups/runs"]');
  await run.getByLabel('Result').selectOption('succeeded');
  await run.getByRole('button', { name: 'Record run' }).click();
  await expect(page.locator('#backups')).toContainText('Not verified: no restore test on record');
  await expect(page.locator('#backups')).not.toContainText('Restore verified with evidence');

  await page.getByText('Record a restore test', { exact: true }).click();
  const restore = page.locator('form[action="/backups/restores"]');
  await restore.getByLabel('Outcome').selectOption('passed');
  await restore.getByLabel('Checks performed').fill('Home page loads and admin can sign in.');
  await restore.getByRole('button', { name: 'Record restore test' }).click();
  await expect(page.locator('main')).toContainText('A passed restore needs a reference to its evidence');

  await page.goto(siteAUrl);
  await page.getByText('Record a restore test', { exact: true }).click();
  const retry = page.locator('form[action="/backups/restores"]');
  await retry.getByLabel('Outcome').selectOption('passed');
  await retry.getByLabel('Checks performed').fill('Home page loads and admin can sign in.');
  await retry.getByLabel('Evidence reference').fill('DOC-1');
  await retry.getByRole('button', { name: 'Record restore test' }).click();
  await expect(page.locator('#backups')).toContainText('Restore verified with evidence');
});

test('credential entry is impossible in development, and the page runs no scripts', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page, 'Local Owner');
  await page.goto(siteAUrl);
  await page.getByText('Connect WordPress', { exact: true }).click();
  await page.locator('#connection').getByRole('button', { name: 'Create connection' }).click();
  await expect(page.locator('#connection')).toContainText('Credential storage is turned off in this environment');
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.locator('script')).toHaveCount(0);
  const stored = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }));
  expect(stored).toEqual({ local: 0, session: 0 });
  await page.getByText('Run a connection check', { exact: true }).click();
  await page.getByRole('button', { name: 'Test connection only' }).click();
  await expect(page.locator('#connection')).toContainText('No credential is stored for this connection');
  expect(errors).toEqual([]);
});

const PAGES = ['/', '/websites', '/clients', '/clients/new', '/websites/new', '/maintenance', '/reports/maintenance', '/monitoring', '/security', '/backups', '/hosting', '/integrations', '/notifications', '/account', '/staff', '/audit'];

test('every page has no serious accessibility violations', async ({ browser }) => {
  // Axe has to inject a script, which the real Content-Security-Policy correctly refuses.
  const context = await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();
  await signIn(page, 'Local Owner');
  for (const path of [...PAGES, new URL(siteAUrl).pathname]) {
    await page.goto(path);
    await page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const serious = violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => `${item.id}: ${item.nodes.slice(0, 3).map(node => node.target.join(' ')).join(' | ')}`);
    expect(serious, path).toEqual([]);
  }
  await page.goto('/login');
  const login = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(login.violations.filter(item => ['serious', 'critical'].includes(item.impact))).toEqual([]);
  await context.close();
});

for (const [name, viewport] of [['phone', { width: 375, height: 812 }], ['tablet', { width: 768, height: 1024 }], ['desktop', { width: 1280, height: 800 }]]) {
  test(`every page fits a ${name} screen`, async ({ page }) => {
    await signIn(page, 'Local Owner');
    await page.setViewportSize(viewport);
    for (const path of [...PAGES, new URL(siteAUrl).pathname]) {
      await page.goto(path);
      const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(scroll, path).toBeLessThanOrEqual(client);
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeInViewport();
    }
  });
}

test('keyboard users can skip navigation and reach the content', async ({ page }) => {
  await signIn(page, 'Local Owner');
  await page.goto('/websites');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
});

test('the browser enforces the security headers', async ({ page }) => {
  const response = await page.goto('/login');
  const headers = response.headers();
  expect(headers['content-security-policy']).toContain("default-src 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('same-origin');
  await signIn(page, 'Local Owner');
  const blocked = await page.evaluate(async () => {
    try { await fetch('/api/v1/me'); return false; } catch { return true; }
  });
  expect(blocked).toBe(true);
});
