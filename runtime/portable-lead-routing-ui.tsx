'use client';

import type {readRepWorkload} from '../db/postgres/lead-routing-store';
import {WorkspaceDate,useWorkspaceDefaults} from './portable-workspace-format';
import {scheduledInstants} from '../lib/email/schedule';
import {useRouter} from 'next/navigation';
import type {LeadRoutingTarget} from '../lib/portable-leads';
import type {SharedRecordWriteScope} from '../lib/portable-workspace-access';
import {useEffect,useState,type FormEvent} from 'react';
import {maxTerritoryCountries,territoryRegions,routingReasons,type LeadDistribution,type LeadRoutingMember,type LeadRoutingPreview} from '../lib/portable-lead-routing';

const endpoint='/api/leads?view=routing';
const days=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const time=(minute:number)=>String(Math.floor(minute/60)%24).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
const minutes=(value:string)=>{const [hour,minute]=value.split(':').map(Number);return hour*60+minute;};

type RepLoad=Awaited<ReturnType<typeof readRepWorkload>>;

function RepWorkload({memberId}:{memberId:string}){
  const [workload,setWorkload]=useState<RepLoad|null>(null);
  const [error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    async function load(){
      try{
        const response=await fetch('/api/leads?view=routing-workload&memberId='+encodeURIComponent(memberId),{signal:controller.signal});
        if(!response.ok)throw Error(response.status===404?'This rep is no longer in the routing pool.':'Could not load this rep’s workload.');
        const result=await response.json() as RepLoad;
        if(!controller.signal.aborted)setWorkload(result);
      }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'Could not load this rep’s workload.');}
    }
    void load();
    return ()=>controller.abort();
  },[memberId,refresh]);
  let status=error||'Checking workload…';
  if(workload){
    const {openLeads,capacity}=workload;
    const unit=capacity===1?'open lead':'open leads';
    if(openLeads===null)status=`More than ${capacity} ${unit} · Over capacity`;
    else{
      const remaining=capacity-openLeads;
      status=`${openLeads} of ${capacity} ${unit} · ${remaining===0?'At capacity':remaining+' remaining'}`;
    }
  }
  return <div>
    <p role="status">{status}</p>
    <button type="button" disabled={!error&&!workload} onClick={()=>{setWorkload(null);setError('');setRefresh(n=>n+1);}}>Refresh workload</button>
  </div>;
}

async function fetchRoutingPreview(params:URLSearchParams){
  const response=await fetch('/api/leads?'+params,{cache:'no-store'});
  const result=await response.json() as LeadRoutingPreview&{error?:string};
  if(!response.ok)throw Error(result.error??'Could not check routing.');
  return result;
}

function TerritoryRoutingPreview(){
  const [preview,setPreview]=useState<LeadRoutingPreview|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const defaults=useWorkspaceDefaults();
  const zone=defaults?.timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [local,setLocal]=useState('');
  const instants=local?scheduledInstants(local,zone):[];
  async function check(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(busy)return;
    const values=new FormData(event.currentTarget);
    const params=new URLSearchParams({view:'territory-preview',country:String(values.get('country')??''),region:String(values.get('region')??'')});
    if(local){
      if(!instants.length){setError('This local time does not exist in the selected time zone. Choose another time.');return;}
      const at=instants.length===1?instants[0]:String(values.get('occurrence')??'');
      if(!at||!instants.includes(at)){setError('Choose which occurrence of this time to check.');return;}
      params.set('at',at);
    }
    setBusy(true);setError('');setPreview(null);
    try{
      setPreview(await fetchRoutingPreview(params));
    }catch(cause){setError(cause instanceof Error?cause.message:'Could not check this territory.');}
    finally{setBusy(false);}
  }
  return <details><summary>Test a territory</summary>
    <form onSubmit={check} onChange={()=>{setPreview(null);setError('');}}>
      <p>Leave the time blank to check now. Future checks use scheduled availability, current workloads and the current rotation.</p>
      <fieldset disabled={busy}><legend>Sample lead location</legend>
        <label>Country or region<input name="country" maxLength={100}/></label>
        <label>State or province<input name="region" maxLength={100}/></label>
        <label>Preview time ({defaults?.timeZone??'browser time zone'})<input type="datetime-local" value={local} onChange={event=>setLocal(event.target.value)}/></label>
        {instants.length>1&&<label>Time occurrence<select key={local} name="occurrence" defaultValue="" required>
          <option value="">Choose an occurrence</option>
          {instants.map(at=><option key={at} value={at}>{at.slice(11,16)} UTC</option>)}
        </select></label>}
        <button type="submit">{busy?'Checking…':'Test routing'}</button>
      </fieldset>
      {error&&<p role="alert">{error}</p>}
      {preview&&<CurrentRoutingResult preview={preview} scheduled={!!local}/>}
    </form>
  </details>;
}

export function LeadRoutingSettings(){
  const [open,setOpen]=useState(false),[members,setMembers]=useState<LeadRoutingMember[]>([]);
  const [selected,setSelected]=useState(''),[refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(false),[saving,setSaving]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  const [distribution,setDistribution]=useState<LeadDistribution>('count');
  const current=members.find(member=>member.memberId===selected)??members[0];
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    fetch(endpoint,{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const result=await response.json() as {members:LeadRoutingMember[];distribution:LeadDistribution};
      if(!controller.signal.aborted){setMembers(result.members);setDistribution(result.distribution);}
    }).catch(()=>{if(!controller.signal.aborted){setMembers([]);setError('Could not load the routing pool.');}})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[open,refresh]);

  async function saveBalance(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const selected=new FormData(event.currentTarget).get('balance');
    if(saving)return;
    setSaving(true);setNotice('');setError('');
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'balance',distribution:selected})});
      const result=await response.json() as {distribution?:LeadDistribution;error?:string};
      if(!response.ok||!result.distribution||result.distribution!==selected)throw Error(result.error??'Could not save lead distribution.');
      setDistribution(result.distribution);setNotice('Lead distribution saved.');
    }catch(cause){setError(cause instanceof Error?cause.message:'Could not save lead distribution.');}
    finally{setSaving(false);}
  }

  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!current||saving)return;
    const form=new FormData(event.currentTarget);
    const mask=form.getAll('days').reduce<number>((sum,day)=>sum+(1<<Number(day)),0);
    if(!mask){setError('Choose at least one working day.');return;}
    const start=minutes(String(form.get('start'))),end=minutes(String(form.get('end')))||1440;
    if(end===start){setError('Choose different start and end times, or midnight for both to cover the whole day.');return;}
    const countries=String(form.get('countries')??'').split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
    if(countries.length>maxTerritoryCountries||countries.some(value=>value.length>100)){
      setError('Use up to '+maxTerritoryCountries+' countries, with up to 100 characters per name.');return;
    }
    if(new Set(countries.map(value=>value.toLowerCase())).size!==countries.length){setError('Enter each country only once.');return;}
    const regions=String(form.get('regions')??'').split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
    if(regions.length&&countries.length!==1){setError('Choose one country for a state or province territory.');return;}
    if(!territoryRegions.safeParse(regions).success){setError('Enter up to 50 distinct states or provinces, with up to 100 characters per name.');return;}
    const updated={regions,memberId:current.memberId,revision:current.revision,available:form.has('available'),
      awayThrough:String(form.get('awayThrough')??'')||null,
      country:countries[0]??'',additionalCountries:countries.slice(1),capacity:Number(form.get('capacity')),
      timeZone:String(form.get('timeZone')??'').trim(),days:mask,start,end};
    setSaving(true);setNotice('');setError('');
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(updated)});
      const result=await response.json() as {error?:string;revision?:number};
      if(!response.ok||!result.revision)throw Error(result.error??'Could not save lead routing.');
      const revision=result.revision;
      setMembers(previous=>previous.map(member=>member.memberId===current.memberId?{...member,...updated,revision}:member));
      setNotice('Routing saved for '+current.label+'.');
    }catch(cause){setError(cause instanceof Error?cause.message:'Could not save lead routing.');}
    finally{setSaving(false);}
  }

  return <details onToggle={event=>{
    if(event.target!==event.currentTarget)return;
    const expanded=event.currentTarget.open;
    if(expanded){setLoading(true);setError('');setNotice('');}
    setOpen(expanded);
  }}>
    <summary>Lead routing</summary>
    {open&&<>
      <p>New leads go to an available territory rep during working hours. Harbor uses the linked company’s country first, then the contact’s. A matching state or province takes priority, followed by the country and then the general pool.</p>
      {!loading&&current&&<form onSubmit={saveBalance}>
        <fieldset disabled={saving}><legend>Workspace lead distribution</legend>
          <label>Assign the next lead by<select key={distribution} name="balance" defaultValue={distribution}>
            <option value="count">Fewest open leads</option><option value="capacity">Lowest percentage of capacity used</option>
            <option value="round_robin">Round robin</option>
          </select></label>
          <p>Round robin gives each eligible rep in the territory pool a turn. Reps at their open-lead limit are skipped.</p>
          <button type="submit">Save distribution</button>
        </fieldset>
      </form>}
      {!loading&&<TerritoryRoutingPreview key={distribution+':'+members.map(member=>member.revision).join(',')}/>}
      {loading?<p role="status">Loading reps…</p>:current?<form onSubmit={save}>
        <fieldset disabled={saving}><legend>Routing pool</legend>
          <label>Sales rep<select value={current.memberId} onChange={event=>{setSelected(event.target.value);setNotice('');setError('');}}>
            {members.map(member=><option key={member.memberId} value={member.memberId}>{member.label}</option>)}
          </select></label>
          <fieldset key={current.memberId+':'+current.revision}><legend>{current.label}</legend>
            <label><input type="checkbox" name="available" defaultChecked={current.available}/> Accept new leads</label>
            <label>Away through<input type="date" name="awayThrough" defaultValue={current.awayThrough??''}/></label>
            <p>Routing resumes on the first shift that starts after this date in the rep’s time zone. Harbor also skips reps while they host a team meeting in this workspace.</p>
            <label>Territory countries or regions<textarea name="countries" rows={3} placeholder="All countries"
              defaultValue={[current.country,...(current.additionalCountries??[])].join('\n')} aria-describedby="routing-country-help"/></label>
            <p id="routing-country-help">Enter one country per line, using the names on your CRM records. Leave blank for the general pool.</p>
            <label>States or provinces<textarea name="regions" rows={2} defaultValue={(current.regions??[]).join('\n')}
              aria-describedby="routing-regions-help"/></label>
            <p id="routing-regions-help">For a single country, enter one State/Region value per line. Leave blank to cover the whole country.</p>
            <label>Maximum open leads<input type="number" name="capacity" min={1} max={10000} required defaultValue={current.capacity}/></label>
            <RepWorkload memberId={current.memberId}/>
            <label>Time zone<input name="timeZone" required maxLength={100} defaultValue={current.timeZone} placeholder="America/New_York"/></label>
            <p>Select the days the shift starts. An earlier end time finishes the next day.</p>
            <fieldset><legend>Working days</legend>{days.map((day,index)=><label key={day}><input type="checkbox" name="days"
              value={index} defaultChecked={Boolean(current.days&(1<<index))}/>{day}</label>)}</fieldset>
            <label>From<input type="time" required name="start" defaultValue={time(current.start)}/></label>
            <label>Until (midnight ends the day)<input type="time" required name="end" defaultValue={time(current.end)}/></label>
          </fieldset>
          <button type="submit">Save routing</button>
        </fieldset>
        <p>If everyone is unavailable or at capacity, the lead stays unassigned.</p>
      </form>:!error&&<p>Add a workspace editor to start a routing pool.</p>}
      {error&&<p role="alert">{error} <button type="button" onClick={()=>{setLoading(true);setError('');setRefresh(n=>n+1);}}>Reload settings</button></p>}
      {notice&&<p role="status">{notice}</p>}
    </>}
  </details>;
}

export function RouteShownLeads({leads,shared,offerQueue=false}:{offerQueue?:boolean;leads:LeadRoutingTarget[];shared?:SharedRecordWriteScope}){
  const router=useRouter();
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  const [queue,setQueue]=useState(false);
  async function route(){
    if(busy||!leads.length)return;
    setBusy(true);setError('');setNotice('');
    try{
      const response=await fetch('/api/leads'+(shared?'?'+new URLSearchParams(shared):''),{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'route_page',leads,queueIfUnavailable:offerQueue&&queue||undefined}),
      });
      const result=await response.json() as {assigned?:number;queued?:number;unavailable?:number;skipped?:number;error?:string};
      if(!response.ok||typeof result.assigned!=='number')throw Error(result.error||'Could not confirm the assignments. Check the refreshed list.');
      const summary=[result.assigned+' assigned.'];
      if(result.queued)summary.push(result.queued+' waiting for automatic routing.');
      if(result.unavailable)summary.push(result.unavailable+' still waiting for an available rep.');
      if(result.skipped)summary.push(result.skipped+' skipped because the lead changed or became unavailable.');
      setNotice(summary.join(' '));
    }catch(cause){
      setError(cause instanceof Error&&!(cause instanceof TypeError)?cause.message:'Could not confirm the assignments. Check the refreshed list.');
    }finally{setBusy(false);router.refresh();}
  }
  return <div>{offerQueue&&leads.length>0&&<label><input type="checkbox" checked={queue} disabled={busy} onChange={e=>setQueue(e.target.checked)}/> If no rep is available, release any former assignee and queue for automatic routing</label>}
    {leads.length>0&&<button type="button" disabled={busy} onClick={route}>
    {busy?'Routing…':leads.length===1?'Route this lead':`Route these ${leads.length} leads`}</button>}
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}</div>;
}

function RoutingReasonCounts({counts}:{counts:LeadRoutingPreview['counts']}){
  return <ul>{Object.entries(routingReasons).map(([reason,label])=>{
    const count=counts[reason as keyof typeof routingReasons];
    return count?<li key={reason}>{label} · {count}</li>:null;
  })}</ul>;
}

function CurrentRoutingResult({preview,scheduled=false}:{preview:LeadRoutingPreview;scheduled?:boolean}){
  return <><p role="status">{preview.next?(scheduled?'Projected rep: ':'Next in line: ')+preview.next:
      !Object.keys(preview.counts).length?'No reps are configured for lead routing.':scheduled?'No rep qualifies at the selected time.':'No rep currently qualifies for this lead.'}</p>
      <RoutingReasonCounts counts={preview.counts}/></>;
}

export function RoutingPreview({id,workspaceId}:{id:string;workspaceId?:string}){
  const [preview,setPreview]=useState<LeadRoutingPreview|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function check(){
    setBusy(true);setError('');setPreview(null);
    try{
      const params=new URLSearchParams({view:'routing-preview',id});
      if(workspaceId)params.set('workspaceId',workspaceId);
      setPreview(await fetchRoutingPreview(params));
    }catch(cause){setError(cause instanceof Error?cause.message:'Could not check routing.');}
    finally{setBusy(false);}
  }
  return <section aria-label="Routing preview">
    <button type="button" disabled={busy} onClick={check}>{busy?'Checking routing…':preview?'Refresh routing preview':'Preview routing'}</button>
    {error&&<p role="alert">{error}</p>}
    {preview&&<><CurrentRoutingResult preview={preview}/>
      <p>Routing checks availability again when you assign the lead.</p>
      {preview.lastMiss&&<section aria-label="Last automatic check">
        <h3>Last automatic check</h3>
        <p>No rep qualified on <time dateTime={preview.lastMiss.checkedAt}><WorkspaceDate value={preview.lastMiss.checkedAt}>{new Date(preview.lastMiss.checkedAt).toLocaleString()}</WorkspaceDate></time>.</p>
        {Object.keys(preview.lastMiss.counts).length?<RoutingReasonCounts counts={preview.lastMiss.counts}/>:<p>No reps were configured for routing.</p>}
      </section>}</>}
  </section>;
}
