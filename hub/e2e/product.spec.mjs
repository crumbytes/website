import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
// Local synthetic product acceptance; hosted customer states need separate consent.
test.skip(Boolean(process.env.HUB_HOSTED_TEST_ORIGIN),'Customer portal acceptance needs separately provisioned hosted customer identities');
test.describe.configure({mode:'serial'});
const stamp=Date.now().toString(36),alpha=`Alpha Portal ${stamp}`,bravo=`Bravo Portal ${stamp}`,email=`alpha-${stamp}@portal.test`;
let alphaId,bravoId;
async function login(page,customer=false){
 await page.goto('/login');await page.getByRole('link',{name:'Sign in with your work account'}).click();
 if(customer){const u=new URL(page.url());u.searchParams.set('email',email);await page.goto(u.href);await expect(page.getByRole('heading',{level:1,name:'Customer portal'})).toBeVisible();}
 else {await page.getByRole('link',{name:/Local Owner/}).click();await expect(page.getByRole('heading',{level:1,name:'Overview'})).toBeVisible();}
}
test('staff onboard Alpha and Bravo and provision a scoped customer without sending email',async({page})=>{
 await login(page);
 for(const name of [alpha,bravo]){
  await page.goto('/clients/new');await page.getByLabel('Client name').fill(name);await page.getByRole('button',{name:'Add client',exact:true}).click();
  const id=new URL(page.url()).pathname.split('/').at(-1);if(name===alpha)alphaId=id;else bravoId=id;
  await page.goto('/websites/new');await page.getByLabel('Client',{exact:true}).selectOption({label:name});await page.getByLabel('Website name').fill(name+' site');await page.getByLabel('Website address').fill(`https://${name===alpha?'alpha':'bravo'}-${stamp}.example.test`);await page.getByLabel('CMS platform').selectOption('other');await page.getByRole('button',{name:'Add website',exact:true}).click();await expect(page.getByRole('heading',{level:1,name:name+' site'})).toBeVisible();
 }
 await page.goto('/requests');await page.getByRole('combobox',{name:'Organization',exact:true}).selectOption({label:alpha});await page.getByLabel('Customer name').fill('Synthetic Alpha Customer');await page.getByLabel('Verified sign-in email').fill(email);await page.getByRole('button',{name:'Save',exact:true}).first().click();
 await expect(page.getByRole('heading',{level:1,name:'Customer requests'})).toBeVisible();
});
test('customer navigation, request submission, contact and export stay inside Alpha',async({page})=>{
 await login(page,true);await expect(page.locator('main')).toContainText(alpha+' site');await expect(page.locator('main')).not.toContainText(bravo+' site');
 await page.getByText('New support request',{exact:true}).click();await page.getByLabel('Subject',{exact:true}).fill('Synthetic Alpha support');await page.getByLabel('Request details').fill('Please review the synthetic Alpha website.');
 const requestForm=page.getByRole('heading',{name:'Support requests',exact:true}).locator('..').locator('form');await requestForm.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('main')).toContainText('Synthetic Alpha support');
 const contacts=page.getByRole('heading',{name:'Authorized operational contacts'}).locator('..');await contacts.getByText('Add contact',{exact:true}).click();const add=contacts.locator('details').last();await add.getByLabel('Name',{exact:true}).fill('Alpha Operations');await add.getByLabel('Email',{exact:true}).fill('operations@alpha.test');await add.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('main')).toContainText('operations@alpha.test');
 const download=page.waitForEvent('download');await page.getByRole('link',{name:'Download monthly report'}).click();const stream=await (await download).createReadStream();let report='';for await(const chunk of stream)report+=chunk.toString();expect(report).toContain(alpha+' site');expect(report).not.toContain(bravo+' site');
 await page.goto('/portal?client='+bravoId);await expect(page.getByRole('heading',{name:'Not found',exact:true})).toBeVisible();
 await page.goto('/staff');await expect(page.locator('body')).toContainText('restricted to internal staff');
});
test('portal and automation settings are accessible on mobile and staff can resolve a request',async({page})=>{
 await login(page);await page.goto('/requests');const request=page.getByRole('heading',{name:'Synthetic Alpha support',exact:true}).locator('..');await request.getByRole('combobox',{name:'Status',exact:true}).selectOption('resolved');await request.getByLabel('Customer-visible response').fill('Synthetic request resolved with recorded evidence.');await request.getByRole('button',{name:'Save',exact:true}).click();
 await page.goto('/workflows');await expect(page.getByRole('heading',{level:1,name:'Automation settings'})).toBeVisible();expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
 await page.context().clearCookies();await login(page,true);await expect(page.locator('main')).toContainText('Synthetic request resolved');await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
 if(process.env.HUB_LOCAL_UI_CAPTURE_DIR)await page.screenshot({path:process.env.HUB_LOCAL_UI_CAPTURE_DIR+'/customer-portal-mobile.png',fullPage:true});
});
