// Local-only screenshot evidence. Creates synthetic records in a fresh in-memory
// development database. It never imports credentials or connects customer sites.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const root=fileURLToPath(new URL('..',import.meta.url));
if(process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV==='production') throw new Error('UI capture is local development only');
const output=path.resolve(process.env.HUB_SCREENSHOT_DIR||'/tmp/hub-ui-screenshots');
const port=Number(process.env.HUB_CAPTURE_PORT||4320);
if(!Number.isInteger(port)||port<1024||port>65534) throw new Error('Invalid capture port');
const origin=`http://localhost:${port}`;
const env={...process.env,PORT:String(port)};delete env.HUB_DEV_DB;
const server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
let log='';server.stdout.on('data',chunk=>{log+=chunk});server.stderr.on('data',chunk=>{log+=chunk});
let browser;
try {
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{clearInterval(poll);reject(new Error('Local capture server startup timed out'))},20000);
  const poll=setInterval(()=>{if(log.includes('Hub running')){clearTimeout(timer);clearInterval(poll);resolve()}},25);
  server.once('exit',()=>{clearTimeout(timer);clearInterval(poll);reject(new Error('Local capture server failed'))});
 });
 browser=await chromium.launch({executablePath:process.env.HUB_BROWSER_EXECUTABLE||undefined});
 const context=await browser.newContext({baseURL:origin,viewport:{width:1440,height:1000},deviceScaleFactor:1});
 const page=await context.newPage();page.setDefaultTimeout(10000);
 await page.goto('/login');await page.getByRole('link',{name:'Sign in with your work account'}).click();
 await page.getByRole('link',{name:/Local Owner/}).click();await page.getByRole('heading',{level:1,name:'Overview'}).waitFor();
 async function client(name){await page.goto('/clients/new');await page.getByLabel('Client name').fill(name);await page.getByRole('button',{name:'Add client',exact:true}).click();await page.getByRole('heading',{level:1,name}).waitFor()}
 async function website(name,platform){await page.goto('/websites/new');await page.getByLabel('Client',{exact:true}).selectOption({label:'Synthetic — Harbor Studio'});await page.getByLabel('Website name').fill(name);await page.getByLabel('Website address').fill(`https://${platform}.example.test`);await page.getByLabel('CMS platform').selectOption(platform);await page.getByRole('button',{name:'Add website',exact:true}).click();await page.getByRole('heading',{level:1,name}).waitFor();return new URL(page.url()).pathname}
 await client('Synthetic — Harbor Studio');await client('Synthetic — Summit Shop');
 const sites={};for(const platform of ['wordpress','shopify','wix','squarespace','joomla']) sites[platform]=await website(`Synthetic ${platform} website`,platform);
 const site=sites.wordpress;
 await page.goto(site);await page.getByText('Add a task',{exact:true}).click();
 let form=page.locator('form[action="/maintenance/tasks"]');await form.getByLabel('Task',{exact:true}).fill('Synthetic navigation review');await form.getByLabel(/^Due/).fill(new Date().toISOString().slice(0,10));await form.getByRole('button',{name:'Add task',exact:true}).click();
 await page.getByText('Add a schedule',{exact:true}).click();form=page.locator('form[action="/maintenance/schedules"]');await form.getByLabel('Recurring work').fill('Synthetic monthly review');await form.getByLabel('Repeat every (days)').fill('30');await form.getByLabel('Next due').fill(new Date(Date.now()+30*86400000).toISOString().slice(0,10));await form.getByRole('button',{name:'Add schedule',exact:true}).click();
 await page.getByText('Add a backup source',{exact:true}).click();form=page.locator('form[action="/backups/sources"]');await form.getByLabel('Provider',{exact:true}).fill('Synthetic local record');await form.getByLabel('Description',{exact:true}).fill('Test archive — no backup run recorded');await form.getByLabel(/^Schedule/).fill('Nightly test record; provider is not connected');await form.getByRole('button',{name:'Add source',exact:true}).click();
 await page.getByText('Record a finding',{exact:true}).click();form=page.locator('form[action="/security/findings"]');await form.getByLabel('Finding',{exact:true}).fill('Synthetic review follow-up');await form.getByLabel('Risk',{exact:true}).selectOption('info');await form.getByRole('button',{name:'Record finding',exact:true}).click();
 await page.getByText('Record completed work',{exact:true}).click();form=page.locator('form[action="/history"]');await form.getByLabel('Type',{exact:true}).selectOption('other');await form.getByLabel('What was done',{exact:true}).fill('Synthetic UI capture: tested authenticated form submissions in this local session.');await form.getByRole('button',{name:'Add to history',exact:true}).click();
 await page.getByText('Connect WordPress',{exact:true}).click();form=page.locator(`form[action="${site}/connections"]`);await form.getByRole('button',{name:'Create connection',exact:true}).click();
 await mkdir(output,{recursive:true});
 const captured=[];
 async function capture(name,url,mobile=false){await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:1000});const response=await page.goto(url);if(response.status()!==200)throw new Error(`Capture failed: ${name}`);await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});captured.push({file:name+'.png',path:url,viewport:mobile?'mobile':'desktop'})}
 for(const [name,url]of [['overview','/'],['inventory','/websites'],['website',site],['maintenance','/maintenance'],['security','/security'],['backups','/backups'],['monitoring','/monitoring'],['integrations','/integrations'],['notifications','/notifications']])await capture(name,url);
 await capture('overview-mobile','/',true);await capture('inventory-mobile','/websites',true);
 for(const [platform,url]of Object.entries(sites)){await page.setViewportSize({width:1440,height:1000});await page.goto(url);const panel=page.locator('#connection');await panel.locator('details').evaluateAll(nodes=>nodes.forEach(node=>{node.open=true}));await panel.screenshot({path:path.join(output,'connection-'+platform+'.png')});captured.push({file:'connection-'+platform+'.png',path:url+'#connection',viewport:'desktop'})}
 const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const dirty=Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim());
 await writeFile(path.join(output,'manifest.json'),JSON.stringify({sha,dirty,notice:'Local synthetic records only; no monitoring results or live connections were manufactured. No provider or customer was contacted.',captured},null,2)+'\n');
 await writeFile(path.join(output,'gallery.md'),'# CrumByte Hub — local UI evidence\n\nSynthetic records only. No real monitoring result, live integration or customer data is shown.\n\nCommit: `'+sha+'`'+(dirty?' (working tree contains changes)':'')+'\n\n'+captured.map(item=>'— ['+item.file.replace('.png','')+']('+path.join(output,item.file)+')').join('\n\n')+'\n');
 console.log(`Captured ${captured.length} screenshots in ${output}`);
} finally {await browser?.close();if(server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve))}}
