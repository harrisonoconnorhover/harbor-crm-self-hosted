import {effectiveMemberToolPolicy} from '../lib/portable-tool-permissions';
import {sharedToolAllowed} from '../db/postgres/shared-tool-permission';
import {portablePageHasBody} from './portable-page-body';
import {readAccountDefaults} from '../db/postgres/account-defaults-store';
import {workspaceDate,workspaceNumber} from '../lib/portable-account-defaults';
import {recordAccess} from '../db/postgres/record-access-store';
import {notFound} from 'next/navigation';
import {z} from 'zod';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {readPortableLeads} from '../db/postgres/portable-lead-store';
import {readSalesWorkspaceTasks} from '../db/postgres/sales-workspace-store';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {validTimeZone} from '../lib/email/schedule';
import {taskDeadlineLabel} from '../lib/task-deadline';
import {PortableCrmHeader} from './portable-crm-header';
import {portableDb} from './portable-db';
import {env} from './portable-env';
import {portableWorkspaceGuest} from './portable-identity';
import {portableLoginConfig} from './portable-login-config';
import {withPortableNavigation} from './portable-navigation';
import {RouteShownLeads} from './portable-lead-routing-ui';
import {SalesWorkspaceZone} from './portable-sales-workspace-zone';
import './portable-contacts.css';
import './portable-sales-workspace.css';

const query=z.object({view:z.literal('sales-workspace'),workspaceId:z.string().guid().optional(),
  taskZone:z.string().max(100).refine(validTimeZone).optional()}).strict();

export async function PortableSalesWorkspacePage({input}:{input:Record<string,string|undefined>}){
  const parsed=query.safeParse(input);
  if(!parsed.success)notFound();
  const {workspaceId,taskZone}=parsed.data,now=new Date();
  function href(parameters:Record<string,string>){
    const params=new URLSearchParams(parameters);
    if(workspaceId)params.set('workspaceId',workspaceId);
    return '/?'+params;
  }
  const user=await requireChatGPTUser(href({view:'sales-workspace',...(taskZone?{taskZone}:{})}));
  const db=portableDb();
  if(portableWorkspaceGuest(user.email)&&(!workspaceId||!await guestWorkspaceAllowed(db,user.userId,workspaceId,portableLoginConfig(env).allowedEmails)))notFound();
  const grant=workspaceId?await sharedWorkspaceGrant(db,user.userId,workspaceId,true):undefined;
  const settings=await readAccountDefaults(db,user.userId,workspaceId);
  const zone=taskZone??settings.defaults.timeZone;
  if(workspaceId&&(!grant||!await sharedToolAllowed(db,user.userId,workspaceId,'sales-workspace')))notFound();
  const canRoute=!grant||(grant.role==='editor'&&effectiveMemberToolPolicy(grant,'leads').edit==='all');
  const includeBody=await portablePageHasBody();
  const {tasks,leads,waiting}=await db.transaction(async tx=>{
    const [tasks,leads,waiting]=await Promise.all([
      readSalesWorkspaceTasks(tx,user.userId,workspaceId,zone,now),
      readPortableLeads(tx,user.userId,{workspaceId,owner:'mine',limit:5}),
      canRoute?readPortableLeads(tx,user.userId,{workspaceId,owner:'needs-routing',limit:5}):undefined,
    ]);
    if(!leads||!('records' in leads))notFound();
    if(includeBody){
      await recordAccess(tx,user,'tasks','list',tasks.preview.map(row=>row.id),workspaceId);
      const visibleLeads=[...leads.records,...(waiting&&'records' in waiting?waiting.records:[])];
      await recordAccess(tx,user,'leads','list',visibleLeads.map(row=>row.id),workspaceId);
    }
    return {tasks,leads,waiting};
  },{isolationLevel:'repeatable read'});
  const queue=(filters:Record<string,string>)=>href({kind:'tasks',...filters});
  const today=(taskView:string)=>queue({taskView,taskZone:zone,taskAssignee:'me'});
  const cards=[
    ['Open tasks',tasks.counts.mine,queue({taskView:'mine'})],
    ['Overdue',tasks.counts.overdue,today('overdue')],
    ['Due today',tasks.counts.today,today('today')],
    ['High priority',tasks.counts.high,queue({taskView:'mine',taskPriority:'High'})],
    ['Calls',tasks.counts.calls,queue({taskView:'mine',taskType:'Call'})],
    ['Emails',tasks.counts.emails,queue({taskView:'mine',taskType:'Email'})],
    ['LinkedIn',tasks.counts.linkedin,queue({taskView:'mine',taskType:'LinkedIn'})],
  ] as const;
  return withPortableNavigation(user.email,<main className="portable-contacts portable-sales-summary">
    <PortableCrmHeader email={user.email} page="sales-workspace" workspaceId={workspaceId}/>
    <section aria-labelledby="sales-workspace-title">
      <h1 id="sales-workspace-title">Sales workspace</h1>
      <nav aria-label="Sales workspace views">
        <a href={href({view:'sales-workspace',taskZone:zone})} aria-current="page">Summary</a>
        <a href={href({kind:'leads',owner:'mine'})}>My leads</a>
        <a href={href({kind:'companies'})}>Companies</a><a href={href({kind:'deals'})}>Deals</a>
        <a href={queue({taskView:'mine'})}>My tasks</a>
      </nav>
      <SalesWorkspaceZone specified={Boolean(taskZone)||settings.revision>0}/>
      <header className="sales-summary-date"><h2>Daily summary</h2>
        <p>{settings.revision?workspaceDate(now.valueOf(),{...settings.defaults,timeZone:zone},false):new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'long',month:'short',day:'numeric'}).format(now)} · {zone}</p></header>
      <div className="sales-summary-counts">
        {cards.map(([label,count,url])=><a key={label} href={url}>
          <span>{label}</span><strong>{settings.revision?workspaceNumber(count,settings.defaults):count}</strong></a>)}
      </div>
      <div className="sales-summary-lists">
        <section aria-labelledby="sales-assigned-tasks"><h3 id="sales-assigned-tasks">My open tasks</h3>
          {tasks.preview.length?<ul>{tasks.preview.map(task=><li key={task.id}>
            <a href={queue({record:task.id,taskView:'mine'})}>{task.data.name}</a>
            <span>{task.data.dueDate?taskDeadlineLabel(task.data):task.data.taskType}</span></li>)}</ul>:
            <p>No open tasks assigned to you.</p>}
          {tasks.counts.mine>5&&<a href={queue({taskView:'mine'})}>View all my tasks</a>}
        </section>
        <section aria-labelledby="sales-assigned-leads"><h3 id="sales-assigned-leads">My leads</h3>
          {leads.records.length?<ul>{leads.records.map(lead=><li key={lead.id}>
            <a href={href({kind:'leads',owner:'mine',record:lead.id})}>{lead.data.name}</a>
            <span>{lead.data.leadStage}</span></li>)}</ul>:<p>No leads assigned to you.</p>}
          {leads.next&&<a href={href({kind:'leads',owner:'mine'})}>View all my leads</a>}
        </section>
        {waiting&&'records' in waiting&&<section aria-labelledby="sales-routing-queue"><h3 id="sales-routing-queue">Needs routing</h3>
          {waiting.records.length?<ul>{waiting.records.map(lead=><li key={lead.id}>
            <a href={href({kind:'leads',owner:'needs-routing',record:lead.id})}>{lead.data.name}</a>
            <span>{lead.assigneeLabel?'Previous assignee · '+lead.assigneeLabel:lead.data.leadStage} · Created <time dateTime={lead.createdAt}>{settings.revision?workspaceDate(lead.createdAt,settings.defaults,false):lead.createdAt.slice(0,10)}</time></span></li>)}</ul>:<p>No open leads awaiting assignment.</p>}
          <RouteShownLeads offerQueue={process.env.HARBOR_LEAD_ROUTING_RETRY_ENABLED==='true'} leads={waiting.records.map(({id,revision})=>({id,expectedRevision:revision}))}
            shared={workspaceId&&grant?{workspaceId,grantId:grant.id}:undefined}/>
          {waiting.next&&<a href={href({kind:'leads',owner:'needs-routing'})}>View all leads needing routing</a>}
        </section>}
      </div>
    </section>
  </main>,{actorId:user.userId,workspaceId});
}
