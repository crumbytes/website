import * as portal from './services/portal.js';
import { portalPage,requestsPage } from './ui/portal.js';
import * as settings from './services/settings.js';
import * as records from './services/records.js';
import { workflowsPage } from './ui/workflows.js';
import * as automation from './services/automation.js';
import * as connections from './services/connections.js';
import { requirePermission } from './authz.js';
export function registerPortalRoutes(app,{contextOf,viewOf}){
 app.get('/workflows',async c=>{const ctx=contextOf(c);const data=await settings.workflowRecords(ctx);return c.html(workflowsPage(viewOf(c),{...data,checks:await records.listChecks(ctx),sources:data.sources}));});
 for(const [kind,fn] of [['checks',settings.updateCheck],['backups',settings.updateBackupSource],['plans',settings.updatePlan]])app.post(`/workflows/${kind}/:id`,async c=>{await fn(contextOf(c),c.req.param('id'),c.get('form')??await c.req.parseBody());return c.redirect('/workflows',303);});
 app.get('/reports/customer/:id',async c=>{const report=await portal.customerSummary(contextOf(c),c.req.param('id'),{from:c.req.query('from'),to:c.req.query('to')});c.header('Content-Disposition','attachment; filename="crumbyte-customer-report.json"');return c.json(report);});
 app.get('/portal',async c=>{
  const ctx=contextOf(c),clients=await portal.clientDirectory(ctx),clientId=c.req.query('client')||clients[0]?.id;
  const summary=clientId?await portal.customerSummary(ctx,clientId):null;
  return c.html(portalPage(viewOf(c),{clients,clientId,summary,contacts:clientId?await portal.contacts(ctx,clientId):[],requests:clientId?await portal.requests(ctx,clientId):[]}));
 });
 app.get('/portal/reports/:id',async c=>{
  const report=await portal.customerSummary(contextOf(c),c.req.param('id'),{from:c.req.query('from'),to:c.req.query('to')});
  c.header('Content-Disposition','attachment; filename="crumbyte-monthly-report.json"');return c.json(report);
 });
 app.post('/tasks/:id/rollback',async c=>{await automation.recordRollback(contextOf(c),c.req.param('id'),c.get('form')??await c.req.parseBody());return c.redirect('/maintenance',303);});
 app.post('/history/:id/unshare',async c=>{const row=await automation.shareHistory(contextOf(c),c.req.param('id'),false);return c.redirect('/websites/'+row.website_id,303);});
 app.post('/history/:id/share',async c=>{const row=await automation.shareHistory(contextOf(c),c.req.param('id'));return c.redirect('/websites/'+row.website_id,303);});
 app.post('/connections/:id/rewrap',async c=>{await connections.rewrapCredential(contextOf(c),c.req.param('id'));return c.redirect('/integrations',303);});
 const body=c=>c.get('form')??c.req.parseBody();
 app.post('/portal/requests',async c=>{const input=await body(c);await portal.submitRequest(contextOf(c),input);return c.redirect('/portal?client='+encodeURIComponent(input.client_account_id),303);});
 for(const suffix of ['', '/:id'])app.post('/portal/contacts'+suffix,async c=>{const input=await body(c);await portal.saveContact(contextOf(c),input,c.req.param('id'));return c.redirect('/portal?client='+encodeURIComponent(input.client_account_id),303);});
 app.get('/requests',async c=>{const ctx=contextOf(c);requirePermission(ctx.staff,'maintenance.read');return c.html(requestsPage(viewOf(c),{requests:await portal.requests(ctx),clients:await portal.clientDirectory(ctx)}));});
 app.post('/requests/onboard',async c=>{const d=await body(c);await portal.inviteCustomer(contextOf(c),d.client_account_id,d);return c.redirect('/requests',303);});
 app.post('/requests/:id',async c=>{await portal.updateRequest(contextOf(c),c.req.param('id'),await body(c));return c.redirect('/requests',303);});
}
