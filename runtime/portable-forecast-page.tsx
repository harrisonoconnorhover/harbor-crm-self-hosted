import {effectiveMemberToolPolicy} from '../lib/portable-tool-permissions';
import {readAccountDefaults} from '../db/postgres/account-defaults-store';
import {workspaceNumber} from '../lib/portable-account-defaults';
import {notFound} from 'next/navigation';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {readDealPipelines} from '../db/postgres/deal-pipeline-store';
import {readDealSummary} from '../db/postgres/deal-store';
import {canReadSharedForecast,forecastCalendar,readForecastGoal,visibleForecastOwners} from '../db/postgres/forecast-goal-store';
import {readOwnedWorkspaceId} from '../db/postgres/private-workspace-store';
import {portableWorkspaceAssignees} from '../db/postgres/workspace-assignee-store';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {targetProgress} from '../lib/forecast-targets';
import {builtinPipeline} from '../lib/portable-deal-pipelines';
import {forecastSettingsSchema} from '../lib/sales-forecast';
import {forecastPageQuery,quarterMonths} from '../lib/portable-forecast';
import {PortableCrmHeader} from './portable-crm-header';
import {portableDb} from './portable-db';
import {env} from './portable-env';
import {FiscalCalendarEditor,ForecastGoalEditor} from './portable-forecast-goal-editor';
import {portableWorkspaceGuest} from './portable-identity';
import {portableLoginConfig} from './portable-login-config';
import {withPortableNavigation} from './portable-navigation';
import './portable-contacts.css';
import './portable-forecast.css';

const legacyMoney=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
export async function PortableForecastPage({input}:{input:Record<string,string|undefined>}){
  const parsed=forecastPageQuery.safeParse(input);
  if(!parsed.success)notFound();
  const {view,workspaceId,period='month',month=new Date().toISOString().slice(0,7),owner='all',pipelineId='default'}=parsed.data;
  if(period==='quarter'&&!forecastSettingsSchema.shape.month.safeParse(month).success)notFound();
  const scope={period,month,owner,pipelineId};
  const workspace:Record<string,string>=workspaceId?{workspaceId}:{};
  const link=(destination:string)=>'/?'+new URLSearchParams({...scope,...workspace,view:destination});
  const user=await requireChatGPTUser(link(view)),db=portableDb();
  const defaults=await readAccountDefaults(db,user.userId,workspaceId);
  const amount=(value:number)=>defaults.revision?workspaceNumber(value,defaults.defaults,'money'):legacyMoney.format(value);
  const data=await db.transaction(async tx=>{
    if(portableWorkspaceGuest(user.email)&&(!workspaceId||!await guestWorkspaceAllowed(tx,user.userId,workspaceId,portableLoginConfig(env).allowedEmails)))notFound();
    const grant=workspaceId?await sharedWorkspaceGrant(tx,user.userId,workspaceId,true):undefined;
    if(workspaceId&&!grant)notFound();
    const seeForecast=!grant||effectiveMemberToolPolicy(grant,'forecast').view!=='none';
    const seeGoals=!grant||effectiveMemberToolPolicy(grant,'goals').view!=='none';
    if(view==='forecast'?!seeForecast:!seeGoals)notFound();
    if(workspaceId&&!await canReadSharedForecast(tx,user.userId,workspaceId))return null;
    const pipelines=[builtinPipeline,...await readDealPipelines(tx,user.userId,workspaceId)];
    const pipeline=pipelines.find(item=>item.id===pipelineId);
    if(!pipeline)notFound();
    const members=workspaceId?await visibleForecastOwners(tx,user.userId,workspaceId):await portableWorkspaceAssignees(tx,user.userId,undefined,undefined,'deals');
    if(owner!=='all'&&owner!=='mine'&&!members.some(member=>member.id===owner))notFound();
    const targetWorkspace=workspaceId??await readOwnedWorkspaceId(tx,user.userId);
    const start=targetWorkspace?await forecastCalendar(tx,targetWorkspace):1;
    const quarter=period==='quarter'?quarterMonths(month,String(start)):null;
    const compareOwners=view==='forecast'&&owner==='all';
    const totals=seeForecast?await readDealSummary(tx,user.userId,pipeline,quarter?.months??month,workspaceId,owner==='all'?undefined:owner,compareOwners?members.map(m=>m.id):undefined):[];
    const partial=!!grant&&effectiveMemberToolPolicy(grant,'deals').view!=='all';
    const goalVisible=seeGoals&&(!partial||owner==='mine'||owner===user.userId);
    const goal=goalVisible&&targetWorkspace?await readForecastGoal(tx,targetWorkspace,user.userId,{...scope,month:quarter?.months[0]??month},view==='goals'&&!!quarter):{amountCents:null,revision:0,overlappingGoals:[]};
    const memberLabels=new Map(members.map(m=>[m.id,m.label]));
    const ownerRows=totals.flatMap(row=>{
      if(!row.ownerBucket)return [];
      const member=memberLabels.get(row.ownerBucket);
      const label=member??(row.ownerBucket==='unassigned'?'Unassigned':'Unavailable owners');
      const contribution=Number(row.wonAmount??0)+Number(row.weightedOpen??0);
      return [{id:row.ownerBucket,team:row.teamBucket,label,link:!!member,won:Number(row.wonAmount??0),weighted:Number(row.weightedOpen??0),contribution}];
    }).sort((a,b)=>b.contribution-a.contribution||a.label.localeCompare(b.label)||a.id.localeCompare(b.id));
    const repsByTeam=Map.groupBy(ownerRows.filter(row=>row.link),row=>row.team);
    const teamRows=totals.flatMap(row=>{
      if(!row.teamBucket||row.ownerBucket)return [];
      const label=row.teamName??({unassigned:'Unassigned deals',unavailable:'Unavailable owners'}[row.teamBucket]??'No primary team');
      const won=Number(row.wonAmount??0),weighted=Number(row.weightedOpen??0);
      return [{id:row.teamBucket,named:!!row.teamName,label,won,weighted,contribution:won+weighted,reps:repsByTeam.get(row.teamBucket)??[]}];
    }).sort((a,b)=>b.contribution-a.contribution||a.label.localeCompare(b.label)||a.id.localeCompare(b.id));
    return {compareOwners,ownerRows,teamRows,seeGoals,seeForecast,pipelines,pipeline,members,totals,partial,goalVisible,goal,quarter,start};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
  const title=view==='goals'?'Goals':'Forecast';
  const total=data?.totals.find(row=>row.stageId===null&&!row.ownerBucket&&!row.teamBucket);
  const won=Number(total?.wonAmount??0),weighted=Number(total?.weightedOpen??0);
  const goalCents=data?.goal.amountCents??null;
  const progress=targetProgress(goalCents,won);
  const forecastGap=goalCents===null?null:Math.round((won+weighted)*100)-goalCents;
  const ownerLabel=owner==='all'?'All owners':owner==='mine'?'My deals':data?.members.find(member=>member.id===owner)?.label;

  return withPortableNavigation(user.email,<main className="portable-contacts portable-forecast">
    <PortableCrmHeader email={user.email} page={view} workspaceId={workspaceId}/>
    <section><h1>{title}</h1>
      {!data?<p>Viewing a revenue forecast requires access to Deal amount and Close date.</p>:<>
        <nav aria-label="Forecast views">{data.seeForecast&&<a href={link('forecast')} aria-current={view==='forecast'?'page':undefined}>Forecast</a>}
          {data.seeGoals&&<a href={link('goals')} aria-current={view==='goals'?'page':undefined}>Goals</a>}</nav>
        <form method="get" action="/" className="forecast-filters"><input type="hidden" name="view" value={view}/>
          {workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
          <label>Pipeline<select name="pipelineId" defaultValue={pipelineId}>{data.pipelines.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>Deal owner<select name="owner" defaultValue={owner}><option value="all">{data.partial?'All visible owners':'All owners'}</option>
            <option value="mine">My deals</option>{data.members.filter(m=>m.id!==user.userId||owner===m.id).map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
          <label>Period<select name="period" defaultValue={period}><option value="month">Month</option><option value="quarter">Fiscal quarter</option></select></label>
          <label>Close month<input required type="month" name="month" defaultValue={month}/></label><button>Apply</button>
        </form>
        {data.quarter&&<h2>{data.quarter.label} · {data.quarter.months[0]} through {data.quarter.months[2]}</h2>}
        <dl className="forecast-cards">
          {data.seeForecast&&<><div><dt>Closed won</dt><dd>{amount(won)}</dd></div>
          <div><dt>Weighted open pipeline</dt><dd>{amount(weighted)}</dd></div>
          <div><dt>Forecast including closed won</dt><dd>{amount(won+weighted)}</dd></div></>}
          {data.goalVisible&&<div><dt>Revenue goal</dt><dd>{data.goal.amountCents===null?'No goal set':amount(data.goal.amountCents/100)}</dd></div>}
        </dl>
        {data.seeForecast&&data.goalVisible&&progress.remaining!==null&&<p>{amount(progress.remaining)} remaining to goal{progress.percent!==null?' · '+progress.percent+'% achieved':''}</p>}
        {data.seeForecast&&forecastGap!==null&&<p>{forecastGap===0?'Forecast meets goal':amount(Math.abs(forecastGap)/100)+(forecastGap>0?' above goal at forecast':' below goal at forecast')}</p>}
        {data.seeGoals&&!data.goalVisible&&<p>Totals cover the deals you can view. Choose My deals to see your personal goal.</p>}
        {data.goal.overlappingGoals.length>0&&<section aria-labelledby="earlier-calendar-goals"><h2 id="earlier-calendar-goals">Goals from earlier calendars</h2>
          <p>These targets cover part of the selected quarter. Each stays with its original three months.</p>
          <dl>{data.goal.overlappingGoals.map(goal=><div key={goal.from}><dt>{goal.from} through {goal.through}</dt><dd>{amount(goal.amountCents/100)}</dd></div>)}</dl>
        </section>}
        {view==='goals'&&!workspaceId&&<section aria-label="Set revenue goal"><h2>Goal for {ownerLabel}</h2>
          <p>{data.pipeline.name} · {data.quarter?.label??month}</p>
          <ForecastGoalEditor scope={scope} fiscalStartMonth={String(data.start)} amountCents={goalCents} revision={data.goal.revision}/><FiscalCalendarEditor start={data.start}/></section>}
        {data.teamRows.some(team=>team.named)&&<section aria-labelledby="team-forecast-heading">
          <h2 id="team-forecast-heading">Forecast by primary team</h2>
          <div className="owner-forecast-scroll"><table aria-labelledby="team-forecast-heading"><thead><tr>
            <th scope="col">Primary team</th><th scope="col">Closed won</th><th scope="col">Weighted open</th><th scope="col">Forecast</th>
          </tr></thead><tbody>{data.teamRows.map(team=><tr key={team.id}><th scope="row">{team.reps.length?<details><summary>{team.label}</summary><ul>
              {team.reps.map(rep=><li key={rep.id}><a href={'/?'+new URLSearchParams({...scope,...workspace,view:'forecast',owner:rep.id})}>{rep.label}</a></li>)}
            </ul></details>:team.label}</th><td>{amount(team.won)}</td><td>{amount(team.weighted)}</td><td>{amount(team.contribution)}</td></tr>)}</tbody></table></div></section>}
        {data.compareOwners&&<section aria-labelledby="owner-forecast-heading"><h2 id="owner-forecast-heading">Forecast by deal owner</h2>
          {data.ownerRows.length?<div className="owner-forecast-scroll"><table aria-labelledby="owner-forecast-heading"><thead><tr>
            <th scope="col">Deal owner</th><th scope="col">Closed won</th><th scope="col">Weighted open</th><th scope="col">Forecast</th>
          </tr></thead><tbody>{data.ownerRows.map(row=><tr key={row.id}>
            <th scope="row">{row.link?<a href={'/?'+new URLSearchParams({...scope,...workspace,view:'forecast',owner:row.id})}>{row.label}</a>:row.label}</th>
            <td>{amount(row.won)}</td><td>{amount(row.weighted)}</td><td>{amount(row.contribution)}</td>
          </tr>)}</tbody></table></div>:<p>No visible deals close in this period.</p>}</section>}
        {data.seeForecast&&<><h2>Deals behind the forecast</h2>
        <p>Open deals contribute their amount multiplied by the stage probability. Closed-won deals contribute their full amount.</p>
        <table><thead><tr><th scope="col">Stage</th><th scope="col">Deals</th><th scope="col">Probability</th><th scope="col">Contribution</th></tr></thead>
          <tbody>{data.pipeline.stages.filter(stage=>stage.outcome!=='lost').map(stage=>{
            const row=data.totals.find(r=>r.stageId===stage.id&&!r.month);
            const params=new URLSearchParams({kind:'deals',pipelineId,stage:stage.id,closeMonth:month,...workspace});
            if(owner!=='all')params.set('owner',owner);
            return <tr key={stage.id}><th scope="row">{data.quarter?<details><summary>{stage.name}</summary>
              <ul>{data.quarter.months.map(m=>{
                const monthly=data.totals.find(r=>r.stageId===stage.id&&r.month===m);
                const count=monthly?.dealCount??0;
                const query=new URLSearchParams(params);query.set('closeMonth',m);
                return <li key={m}><a href={'/?'+query}>{m} · {count} {count===1?'deal':'deals'}</a></li>;
              })}</ul></details>:<a href={'/?'+params}>{stage.name}</a>}</th><td>{row?.dealCount??0}</td>
              <td>{stage.probability}%</td><td>{amount(Number(stage.outcome==='won'?row?.wonAmount??0:row?.weightedOpen??0))}</td></tr>;
          })}</tbody></table></>}
      </>}
    </section>
  </main>,{actorId:user.userId,workspaceId,forecastAvailable:!!data});
}
