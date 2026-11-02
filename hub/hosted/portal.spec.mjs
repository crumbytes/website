// Read-only customer acceptance. Actual MFA and synthetic identities must be provisioned/approved first.
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFile} from 'node:fs/promises';
const origin=process.env.HUB_HOSTED_TEST_ORIGIN;
const configured=Boolean(process.env.HUB_HOSTED_CUSTOMER_A_STATE&&process.env.HUB_HOSTED_CUSTOMER_B_STATE);
test.skip(!configured,'Separate real-MFA synthetic customer states have not been supplied');
async function inputs(){
 const state=name=>{const f=process.env[name];if(!f?.startsWith('/tmp/'))throw new Error('Protected /tmp customer state files required');return f;};
 const fixture=JSON.parse(await readFile(state('HUB_HOSTED_SYNTHETIC_FIXTURE'),'utf8'));
 if(fixture.syntheticOnly!==true||![fixture.clientA,fixture.clientB].every(v=>/^[a-f0-9-]{36}$/i.test(v)))throw new Error('Explicit synthetic customer organization IDs required');
 return {fixture,a:state('HUB_HOSTED_CUSTOMER_A_STATE'),b:state('HUB_HOSTED_CUSTOMER_B_STATE')};
}
test('independent portal customers cannot read or export the other organization',async({browser})=>{
 const {fixture,a,b}=await inputs();
 for(const [state,own,foreign] of [[a,fixture.clientA,fixture.clientB],[b,fixture.clientB,fixture.clientA]]){
  const ctx=await browser.newContext({baseURL:origin,storageState:state});try{
   expect((await ctx.request.get('/portal?client='+own)).status()).toBe(200);
   expect((await ctx.request.get('/portal?client='+foreign)).status()).toBe(404);
   expect((await ctx.request.get('/portal/reports/'+foreign)).status()).toBe(404);
   expect((await ctx.request.get('/api/v1/websites')).status()).toBe(403);
  }finally{await ctx.close();}
 }
});
test('portal reports contain curated fields and no credential or internal-note fields',async({browser})=>{
 const {fixture,a}=await inputs(),ctx=await browser.newContext({baseURL:origin,storageState:a});try{
  const response=await ctx.request.get('/portal/reports/'+fixture.clientA);expect(response.status()).toBe(200);
  expect(response.headers()['content-disposition']).toContain('attachment');
  const data=await response.json();expect(data.client_id).toBe(fixture.clientA);
  for(const site of data.websites){expect(site).not.toHaveProperty('notes');expect(site).not.toHaveProperty('credentials');}
  for(const backup of data.backups){expect(backup).not.toHaveProperty('storage_ref');expect(backup).not.toHaveProperty('artifact_ref');}
 }finally{await ctx.close();}
});
test('hosted customer portal has accessible responsive navigation',async({browser})=>{
 const {a}=await inputs(),ctx=await browser.newContext({baseURL:origin,storageState:a,viewport:{width:390,height:844}});try{
  const page=await ctx.newPage();await page.goto('/portal');await expect(page.getByRole('heading',{level:1,name:'Customer portal'})).toBeVisible();
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 }finally{await ctx.close();}
});
