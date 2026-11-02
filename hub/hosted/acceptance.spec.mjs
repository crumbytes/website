// No local IdP, deployment, migrations, bypass tokens or real CMS calls.
// Staff complete real MFA interactively before exporting short-lived state files.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
const stateFile = name => {
  const value=process.env[name];
  if (!value || !value.startsWith('/tmp/')) throw new Error(`${name} must point to a protected file under /tmp`);
  return value;
};
const origin=process.env.HUB_HOSTED_TEST_ORIGIN;
const paths=['/','/websites','/clients','/maintenance','/security','/backups','/account'];
const internal=['/src/auth.js','/.env','/.env.example','/.git/config','/db/migrations/0004_execution_and_revocation.sql','/package-lock.json'];

test('deployment protection denies a fresh unauthenticated browser',async({browser})=>{
 const context=await browser.newContext({baseURL:origin});
 try {
  for(const path of ['/', '/api/v1/websites', ...internal]) {
   const response=await context.request.get(path,{maxRedirects:0});
   expect([401,403,302,303,307,308]).toContain(response.status());
   expect(await response.text()).not.toMatch(/createAuth|create table hub|lockfileVersion/);
   if(response.status()>=300&&response.status()<400) {
    const destination=new URL(response.headers().location,process.env.HUB_HOSTED_TEST_ORIGIN);
    expect(destination.hostname==='vercel.com').toBeTruthy();
   }
  }
 } finally {await context.close()}
});

test('application authentication is mandatory even after platform protection',async({browser})=>{
 const file=stateFile('HUB_HOSTED_PROTECTION_STATE');
 const state=JSON.parse(await readFile(file,'utf8'));
 expect(state.cookies.some(cookie=>cookie.name.includes('hub_session'))).toBe(false);
 const context=await browser.newContext({baseURL:origin,storageState:file});
 try {
  expect((await context.request.get('/api/v1/websites',{maxRedirects:0})).status()).toBe(401);
  const page=await context.newPage();await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('link',{name:'Sign in with your work account'})).toBeVisible();
 } finally {await context.close()}
});

test('approved MFA staff session reaches protected pages but cannot retrieve internal files',async({browser})=>{
 const context=await browser.newContext({baseURL:origin,storageState:stateFile('HUB_HOSTED_OWNER_STATE')});
 try {
  const me=await context.request.get('/api/v1/me');expect(me.status()).toBe(200);
  expect((await me.json()).staff.role).toBe('owner');
  for(const path of internal) expect((await context.request.get(path)).status()).toBe(404);
  const page=await context.newPage();
  for(const path of paths) {
   const response=await page.goto(path);expect(response.status()).toBe(200);
   expect(response.headers()['cache-control']).toContain('no-store');
   expect(response.headers()['content-security-policy']).toContain("default-src 'none'");
   await expect(page.locator('script')).toHaveCount(0);
  }
 } finally {await context.close()}
});

test('two independently assigned synthetic clients stay isolated',async({browser})=>{
 const fixture=JSON.parse(await readFile(stateFile('HUB_HOSTED_SYNTHETIC_FIXTURE'),'utf8'));
 for(const key of ['siteA','siteB']) expect(fixture[key]).toMatch(/^[0-9a-f-]{36}$/);
 const a=await browser.newContext({baseURL:origin,storageState:stateFile('HUB_HOSTED_TECH_A_STATE')});
 const b=await browser.newContext({baseURL:origin,storageState:stateFile('HUB_HOSTED_TECH_B_STATE')});
 try {
  expect((await a.request.get(`/api/v1/websites/${fixture.siteA}`)).status()).toBe(200);
  expect((await a.request.get(`/api/v1/websites/${fixture.siteB}`)).status()).toBe(404);
  expect((await b.request.get(`/api/v1/websites/${fixture.siteB}`)).status()).toBe(200);
  expect((await b.request.get(`/api/v1/websites/${fixture.siteA}`)).status()).toBe(404);
 } finally {await a.close();await b.close()}
});

test('hosted pages fit common screens and have no serious accessibility failures',async({browser})=>{
 const context=await browser.newContext({baseURL:origin,storageState:stateFile('HUB_HOSTED_OWNER_STATE'),bypassCSP:true});
 try {
  const page=await context.newPage();
  for(const path of paths) {
   await page.goto(path);
   for(const width of [375,768,1280]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
   }
   const {violations}=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
   expect(violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id)).toEqual([]);
  }
 } finally {await context.close()}
});

test('approved synthetic staff disablement permanently invalidates an existing session',async({browser})=>{
 test.skip(process.env.HUB_HOSTED_MUTATIONS_APPROVED!==origin,'Requires separate approval for synthetic record changes');
 const fixture=JSON.parse(await readFile(stateFile('HUB_HOSTED_SYNTHETIC_FIXTURE'),'utf8'));
 expect(fixture.syntheticOnly).toBe(true);expect(fixture.staffB).toMatch(/^[0-9a-f-]{36}$/);
 const owner=await browser.newContext({baseURL:origin,storageState:stateFile('HUB_HOSTED_OWNER_STATE')});
 const staff=await browser.newContext({baseURL:origin,storageState:stateFile('HUB_HOSTED_TECH_B_STATE')});
 try {
  const response=await owner.request.get('/api/v1/me');expect(response.status()).toBe(200);
  const me=await response.json();expect(me.staff.role).toBe('owner');expect(me.staff.id).not.toBe(fixture.staffB);
  expect((await staff.request.get('/api/v1/me')).status()).toBe(200);
  const update=status=>owner.request.post(`/staff/${fixture.staffB}`,{headers:{Origin:origin},form:{_csrf:me.csrf_token,role:'technician',status},maxRedirects:0});
  try {
   expect((await update('disabled')).status()).toBe(303);
   expect((await staff.request.get('/api/v1/me')).status()).toBe(401);
  } finally {expect((await update('active')).status()).toBe(303)}
  expect((await staff.request.get('/api/v1/me')).status()).toBe(401);
 } finally {await owner.close();await staff.close()}
});
