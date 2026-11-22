import {effectiveMemberToolPolicy} from '../lib/portable-tool-permissions';
import {sharedToolAllowed} from '../db/postgres/shared-tool-permission';
import {portablePageHasBody} from './portable-page-body';
import {PortableCsvImportPage,PortableSettingsPage} from './portable-settings-page';
import {PortableSalesWorkspacePage} from './portable-sales-workspace-page';
import {PortableNavDestinationPage} from './portable-nav-destination-page';
import {WebAttributionPage} from './portable-journey-page';
import {TeamInboxPage} from './portable-team-inbox-page';
import {CustomObjectPage} from './portable-custom-object-page';
import {LandingPageManager} from './portable-landing-page';
import Link from 'next/link';
import {PortableAccessHistory} from './portable-access-history';
import {accessPartNumber,accessQuery,recordCustomAccess,recordWorkItemAccess,recordAccess,recordPrimaryLinks,readAuditedRecords} from '../db/postgres/record-access-store';
import {portableOidcDirectoryConfig,portableSamlDirectoryConfig,portableDirectoryConfig,portableDirectoryOwnerOidcIssuer,portableDirectoryOwnerIssuer,portableDirectoryOwnerTenant} from './portable-login-config';
import {outlookConfig} from './portable-outlook-provider';
import type {PersonalConnectionProvider} from '../db/postgres/portable-google-schema';
import {readConnectionGrantStatus} from '../db/postgres/portable-connection-store';
import {portablePersonalGoogleConfig,portablePersonalGoogleReadiness} from './portable-google-config';
import {readPortablePropertyGroups} from '../db/postgres/portable-property-group-store';
import {listPortableStandardAccess} from '../db/postgres/standard-property-access';
import {restrictedStandardFields} from '../lib/portable-standard-property-access';
import {visiblePropertyOrganization} from '../lib/portable-custom-properties';
import {listPortableCustomProperties} from '../db/postgres/custom-property-store';
import {recordReturnPath} from '../lib/portable-record-path';
import {notFound} from 'next/navigation';
import {z} from 'zod';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {portableLoginConfig as loginConfig} from './portable-login-config';
import {env} from './portable-env';
import {inviteSignInEnabled,portableWorkspaceGuest} from './portable-identity';
import {readWorkspaceInvitation} from '../db/postgres/workspace-invite-store';
import {workspaceInvitationId,workspaceInvitationPath} from '../lib/portable-workspace-access';
import {PortableGuestHome,PortableInvitationPage,PortableWorkspaceSharing} from './portable-workspace-ui';
import {PortableCrmHeader} from './portable-crm-header';
import {PortableForecastPage} from './portable-forecast-page';
import {withPortableNavigation} from './portable-navigation';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {listLeadForms,readLeadInquiries} from '../db/postgres/lead-form-store';
import {readOwnedWorkspaceId} from '../db/postgres/private-workspace-store';
import {readObjects} from '../db/postgres/custom-object-store';
import {readCustomTaskSource,readPortableWorkflows,readPortableWorkflowRuns} from '../db/postgres/workflow-store';
import {portableRunObjectId,portableRunCustomRecordId,portableRunCompanyId,portableRunTicketId,portableRunDealId,portableRunIssue,portableRunWorkflowId,portableWorkflowCursor} from '../lib/portable-workflows';
import {readOwnerQueue} from '../db/postgres/job-operations-store';
import {jobKinds,portableJobId,queueIssues,queueViews} from '../lib/portable-job-labels';
import {PortableJobOperations} from './portable-job-operations';
import {portableCodeAvailable} from './portable-code-config';
import {PortableWorkflows} from './portable-workflows-ui';
import {readPortableSegments} from '../db/postgres/portable-segment-store';
import {PortableMarketingPage} from './portable-marketing-page';
import {PortableEmailSettings} from './portable-email-settings';
import {PortableLeadForms} from './portable-lead-forms-ui';
import {portableInquiryFilter,portableInquirySearch} from '../lib/portable-lead-forms';
import {readDealPipelines} from '../db/postgres/deal-pipeline-store';
import {listPortableTaskAssignees,readPortableTasks,readPortableTaskSuccessor} from '../db/postgres/task-store';
import {portableTaskRead,taskLinkFields,taskLinkTarget} from '../lib/portable-tasks';
import {listPortableTaskQueues} from '../db/postgres/task-queue-store';
import {NO_QUEUE} from '../lib/task-queues';
import {PortableTasks} from './portable-tasks-ui';
import {readDealBoard,readDealSummary} from '../db/postgres/deal-store';
import {builtinPipeline} from '../lib/portable-deal-pipelines';
import {portableRecordReaders} from '../db/postgres/portable-record-readers';
import {JoinedWorkspaceList} from './portable-joined-workspaces';
import {joinedWorkspacePage,readWorkspaceSharing,sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {dealCloseMonth,portableRecordKind,portableRecordRead,portableRecordReadFields,portableRecordSearch} from '../lib/portable-records';
import {portableDb} from './portable-db';
import {objectStorageConfigured} from './portable-object-storage';
import {portableGmailOwner,portableWorkflowGmailOwner} from './portable-gmail-config';
import {portableGmailInboxOwner} from './portable-gmail-inbox-config';
import {listPortableMeetings} from '../db/postgres/portable-meeting-store';
import {portableCalendarCancellationsEnabled,portableCalendarConfig,portableCalendarInvitesEnabled,portableCalendarReschedulesEnabled} from './portable-calendar-config';
import {PortableCalendar} from './portable-calendar-ui';
import {PortableRecords} from './portable-contacts-ui';
import {PortableRecycleBin} from './portable-contact-recycle-ui';
import {PortableDuplicates} from './portable-duplicates-ui';
import {portableArchiveKind} from '../lib/portable-contact-archive';
import {portableReportSearch} from '../lib/portable-reports';
import {PortableReportPage,SharedReportPage} from './portable-report-page';
import {PortableSubscriptionsPage} from './portable-subscriptions-page';
import {PortablePaymentsPage} from './portable-payments-page';
import {PortableInvoicesPage} from './portable-invoices-page';
import {portableDashboardFilters,portableDashboardSearch} from '../lib/portable-dashboards';
import {PortableDashboardPage} from './portable-dashboard-page';
import {listPortableSavedViews} from '../db/postgres/saved-view-store';
import {PortableLeadPage} from './portable-lead-page';
import {PortableKnowledgePage} from './portable-knowledge-page';
import {PortableSegmentPage} from './portable-segment-page';
import {readWebhookSettings} from '../db/postgres/webhook-management-store';
import {configuredWebhookDestinations} from './portable-webhook-config';
import {readPortableApiTokens} from '../db/postgres/portable-api-token-store';
import {PortableApiTokens} from './portable-api-token-ui';
import {portableSavedViewId,type PortableSavedViewFilters} from '../lib/portable-saved-views';
import {readPortableLastContacted} from '../db/postgres/portable-external-record-store';
import {portableLastContactedColumn} from '../lib/portable-record-list-columns';
import {PortableFileLibraryPage} from './portable-file-library-page';
import {sequencePageQuery} from '../lib/portable-sales-sequences';
import {PortableSalesSequenceLibrary} from './portable-sales-sequence-ui';
import {PortableGettingStarted} from './portable-getting-started';

async function initialWorkspaceSharing(user:{userId:string;email:string},guest=false){
  try{
    const sharing=await readWorkspaceSharing(portableDb(),user.userId,user.email,guest?loginConfig(env).allowedEmails:undefined,guest?undefined:portableDirectoryOwnerTenant(user.email),guest?undefined:portableDirectoryOwnerIssuer(user.email),guest?undefined:portableDirectoryOwnerOidcIssuer(user.email));
    return guest?sharing:{...sharing,inviteSignIn:inviteSignInEnabled()};
  }catch{return undefined;}
}

async function guestHome(user:{userId:string;email:string}){
  return <PortableGuestHome email={user.email} initial={await initialWorkspaceSharing(user,true)}/>;
}

async function personalConnectionStatus(user:{userId:string;email:string},provider:PersonalConnectionProvider){
  try{return await readConnectionGrantStatus(portableDb(),user,provider);}
  catch{
    console.warn(JSON.stringify({event:provider.startsWith('outlook-')?'harbor_portable_outlook_status_unavailable':'harbor_portable_google_status_unavailable',provider}));
    return 'unavailable' as const;
  }
}

export default async function RecordsPage({searchParams}:{searchParams:Promise<{part?:string;objectId?:string;email?:string;from?:string;through?:string;back?:string;file?:string;token?:string;operation?:string;action?:string;add?:string;kind?:string;view?:string;reportId?:string;dashboardId?:string;createdFrom?:string;createdThrough?:string;dashboardPipeline?:string;savedView?:string;formId?:string;submissionId?:string;filter?:string;followUp?:string;inquiries?:string;inquirySearch?:string;runWorkflowId?:string;runDealId?:string;runTicketId?:string;runCompanyId?:string;runObjectId?:string;runCustomRecordId?:string;runIssue?:string;afterAt?:string;afterId?:string;afterFinishedAt?:string;queue?:string;jobOrder?:string;jobId?:string;jobKind?:string;jobIssue?:string;jobContactId?:string;taskQueueId?:string;taskView?:string;taskZone?:string;taskAssignee?:string;taskPriority?:string;taskType?:string;contact?:string;contactId?:string;status?:string;record?:string;companyId?:string;dealId?:string;primaryContactId?:string;search?:string;owner?:string;after?:string;stage?:string;pipelineId?:string;closeMonth?:string;workspaceId?:string;invitation?:string;google?:string;outlook?:string}>}){
  const pageQuery=await searchParams;
  if(pageQuery.view==='forecast'||pageQuery.view==='goals')return <PortableForecastPage input={pageQuery}/>;
  const requestedPagePath=()=> '/?'+new URLSearchParams(Object.entries(pageQuery)
    .filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
  const wantsBoard=pageQuery.kind==='deals'&&pageQuery.view==='board';
  const runWorkflowId=portableRunWorkflowId.optional().safeParse(pageQuery.runWorkflowId===''?undefined:pageQuery.runWorkflowId);
  const runObjectId=portableRunObjectId.optional().safeParse(pageQuery.runObjectId);
  const runCustomRecordId=portableRunCustomRecordId.optional().safeParse(pageQuery.runCustomRecordId);
  const runCompanyId=portableRunCompanyId.optional().safeParse(pageQuery.runCompanyId);
  const runTicketId=portableRunTicketId.optional().safeParse(pageQuery.runTicketId);
  const runDealId=portableRunDealId.optional().safeParse(pageQuery.runDealId);
  const runIssue=portableRunIssue.optional().safeParse(pageQuery.runIssue);
  const sourceFilters=[pageQuery.runDealId,pageQuery.runTicketId,pageQuery.runCompanyId,pageQuery.runCustomRecordId].filter(value=>value!==undefined);
  if(!runObjectId.success||!runCustomRecordId.success||Boolean(runObjectId.data)!==Boolean(runCustomRecordId.data)||!runCompanyId.success||!runTicketId.success||sourceFilters.length>1||!runWorkflowId.success||!runDealId.success||!runIssue.success||
    (sourceFilters.length>0||pageQuery.runWorkflowId!==undefined||pageQuery.runIssue!==undefined)&&pageQuery.view!=='workflows')notFound();
  const inquirySearch=portableInquirySearch.safeParse(pageQuery.inquirySearch);
  if(!inquirySearch.success||pageQuery.inquirySearch!==undefined&&
    (pageQuery.view!=='forms'||!pageQuery.formId&&pageQuery.inquiries!=='workspace'))notFound();
  const jobId=portableJobId.optional().safeParse(pageQuery.jobId);
  if(!jobId.success||jobId.data&&(pageQuery.view!=='job-queue'||Object.keys(pageQuery).length!==2))notFound();
  const jobKind=z.enum(jobKinds).or(z.literal('')).optional().safeParse(pageQuery.jobKind);
  if(!jobKind.success||pageQuery.jobKind!==undefined&&pageQuery.view!=='job-queue')notFound();
  const jobIssue=z.enum(queueIssues).or(z.literal('')).optional().safeParse(pageQuery.jobIssue);
  if(!jobIssue.success||pageQuery.jobIssue!==undefined&&
    (pageQuery.view!=='job-queue'||pageQuery.queue!==undefined&&pageQuery.queue!=='issues'))notFound();
  const jobContact=z.string().guid().or(z.literal('')).optional().safeParse(pageQuery.jobContactId);
  if(!jobContact.success||pageQuery.jobContactId!==undefined&&pageQuery.view!=='job-queue')notFound();
  const finishedFirst=pageQuery.jobOrder==='finished';
  if((pageQuery.jobOrder!==undefined&&(pageQuery.view!=='job-queue'||pageQuery.queue!=='completed'||
      !finishedFirst&&pageQuery.jobOrder!==''))||
    (pageQuery.afterFinishedAt!==undefined&&!finishedFirst)||
    (finishedFirst&&pageQuery.afterAt!==undefined))notFound();
  if(pageQuery.owner!==undefined&&pageQuery.view!==undefined&&pageQuery.view!=='custom-objects'&&!wantsBoard)notFound();
  if(pageQuery.kind!=='tasks'&&(pageQuery.taskAssignee!==undefined||pageQuery.taskPriority!==undefined||pageQuery.taskType!==undefined))notFound();
  if(pageQuery.view==='settings')return <PortableSettingsPage input={pageQuery}/>;
  if(pageQuery.view==='import')return <PortableCsvImportPage input={pageQuery}/>;
  if(pageQuery.view==='sales-workspace')return <PortableSalesWorkspacePage input={pageQuery}/>;
  if(pageQuery.view==='customer-portal'||pageQuery.view==='calls'||pageQuery.view==='campaigns'||pageQuery.view==='meetings'||pageQuery.view==='snippets'||pageQuery.view==='templates'){
    const user=await requireChatGPTUser(requestedPagePath());
    return withPortableNavigation(user.email,<PortableNavDestinationPage user={user} input={pageQuery}/>,{actorId:user.userId,workspaceId:pageQuery.workspaceId});
  }
  if(pageQuery.view==='web-attribution'){
    const user=await requireChatGPTUser(requestedPagePath());
    if(portableWorkspaceGuest(user.email))notFound();
    return withPortableNavigation(user.email,<WebAttributionPage user={user} input={pageQuery}/>);
  }
  if(pageQuery.view==='team-inbox'){
    const user=await requireChatGPTUser(requestedPagePath());
    return withPortableNavigation(user.email,<TeamInboxPage user={user} input={pageQuery}/>,{actorId:user.userId,workspaceId:pageQuery.workspaceId});
  }
  if(pageQuery.view==='custom-objects'){
    const user=await requireChatGPTUser(requestedPagePath());
    return withPortableNavigation(user.email,<CustomObjectPage user={user} input={pageQuery}/>,{actorId:user.userId,workspaceId:pageQuery.workspaceId});
  }
  if(pageQuery.view==='landing-pages'){
    const user=await requireChatGPTUser(requestedPagePath());
    if(portableWorkspaceGuest(user.email))notFound();
    return withPortableNavigation(user.email,<LandingPageManager user={user} input={pageQuery}/>);
  }
  if(pageQuery.view==='record-access'){
    const {part,...filters}=pageQuery;
    const partNumber=accessPartNumber.optional().safeParse(part);
    const query=accessQuery.safeParse({...filters,email:pageQuery.email||undefined,from:pageQuery.from||undefined,through:pageQuery.through||undefined,
      objectId:pageQuery.objectId||undefined,file:pageQuery.file||undefined,token:pageQuery.token||undefined,operation:pageQuery.operation||undefined,kind:pageQuery.kind||undefined,action:pageQuery.action||undefined,record:pageQuery.record||undefined});
    if(!query.success||!partNumber.success)notFound();
    if(partNumber.data){
      const needsCursor=partNumber.data>1;
      if(query.data.event||needsCursor!==Boolean(query.data.afterId))notFound();
    }
    const user=await requireChatGPTUser(requestedPagePath());
    if(portableWorkspaceGuest(user.email))notFound();
    return withPortableNavigation(user.email,<PortableAccessHistory part={partNumber.data} owner={user.userId} email={user.email} query={query.data}/>);
  }
  if(pageQuery.view==='workspaces'){
    const selection=z.object({view:z.literal('workspaces'),workspaceId:z.string().guid().optional()}).strict().safeParse(pageQuery);
    if(!selection.success)notFound();
    const {workspaceId}=selection.data;
    const user=await requireChatGPTUser(requestedPagePath());
    const guest=portableWorkspaceGuest(user.email);
    if(workspaceId){
      const db=portableDb(),owners=guest?loginConfig(env).allowedEmails:undefined;
      const workspaces=await joinedWorkspacePage(db,user.userId,owners,{current:workspaceId});
      if(!workspaces?.current)notFound();
      return withPortableNavigation(user.email,<main className="portable-contacts">
        <PortableCrmHeader email={user.email} page="workspaces" workspaceId={workspaceId}/>
        <section><h1>Switch workspace</h1>
          <div className="portable-settings-cards">
            {!guest&&<Link href="/" prefetch={false}>My workspace</Link>}
            <Link href={'/?workspaceId='+workspaceId} prefetch={false}>
              <strong>Workspace from {workspaces.current.ownerEmail}</strong>
              <span>{workspaces.current.role==='editor'?'Editor':'Viewer'} · Current workspace</span>
            </Link>
          </div>
          <JoinedWorkspaceList initial={workspaces} current={workspaceId}/>
          <p><Link href="/?view=workspaces">Manage my workspaces and invitations</Link></p>
        </section>
      </main>,{actorId:user.userId,workspaceId});
    }
    if(guest)return guestHome(user);
    const sharing=await initialWorkspaceSharing(user);
    return withPortableNavigation(user.email,<main className="portable-contacts">
      <PortableCrmHeader email={user.email} page="workspaces"/>
      <section>
        <p className="portable-guide-kicker">Team settings</p>
        <h1>Workspaces</h1>
        <PortableWorkspaceSharing expanded initial={sharing}/>
        <Link href="/?view=record-access" prefetch={false}>Record access history</Link>
      </section>
    </main>);
  }
  if(pageQuery.view==='sequences'){
    const query=sequencePageQuery.safeParse(pageQuery);
    if(!query.success)notFound();
    const user=await requireChatGPTUser(requestedPagePath());
    if(portableWorkspaceGuest(user.email))notFound();
    return withPortableNavigation(user.email,<PortableSalesSequenceLibrary email={user.email} enrollments={'section' in query.data?query.data:undefined}/>);
  }
  if(pageQuery.view==='getting-started'){
    if(Object.keys(pageQuery).length!==1)notFound();
    const user=await requireChatGPTUser('/?view=getting-started');
    if(portableWorkspaceGuest(user.email))notFound();
    const db=portableDb();
    const readiness=portablePersonalGoogleReadiness(user.email);
    const [customProperties,google]=await Promise.all([
      listPortableCustomProperties(db,user.userId,'contacts'),
      readiness&&Promise.all(readiness.map(async entry=>{
        if(entry.status!=='ready')return entry;
        const grant=await personalConnectionStatus(user,entry.provider);
        if(grant==='unavailable')return {...entry,connection:'unavailable'} as const;
        const connection=grant?(grant.needsReconnect?'reconnect':'connected'):'not_connected';
        return {...entry,connection} as const;
      })),
    ]);
    return withPortableNavigation(user.email,<PortableGettingStarted email={user.email} customProperties={customProperties} google={google}/>);
  }
  if(pageQuery.view==='files')return <PortableFileLibraryPage input={pageQuery}/>;
  if(pageQuery.view==='recycle-bin'){
    const query=z.object({view:z.literal('recycle-bin'),kind:portableArchiveKind.optional(),after:z.string().guid("Invalid uuid").optional(),
      workspaceId:z.string().guid("Invalid uuid").optional()}).strict().safeParse(pageQuery);
    if(!query.success)notFound();
    const params=new URLSearchParams({view:'recycle-bin'});
    for(const key of ['after','kind','workspaceId'] as const)if(query.data[key])params.set(key,query.data[key]);
    const user=await requireChatGPTUser('/?'+params);
    const {workspaceId}=query.data;
    let scope:{workspaceId:string;grantId:string}|undefined;
    let canRestore=true;
    if(workspaceId){
      // Shared Recycle Bins are for editors of that workspace, including invited guests.
      const db=portableDb();
      if(portableWorkspaceGuest(user.email)&&!await guestWorkspaceAllowed(db,user.userId,workspaceId,loginConfig(env).allowedEmails))notFound();
      const grant=await sharedWorkspaceGrant(db,user.userId,workspaceId,true);
      if(grant?.role!=='editor')notFound();
      const binPolicy=effectiveMemberToolPolicy(grant,'recycle-bin');
      if(binPolicy.view==='none')notFound();
      canRestore=binPolicy.edit!=='none'&&effectiveMemberToolPolicy(grant,query.data.kind??'contacts').delete;
      scope={workspaceId,grantId:grant.id};
    }else if(portableWorkspaceGuest(user.email))notFound();
    const kind=query.data.kind??'contacts';
    return withPortableNavigation(user.email,<PortableRecycleBin key={kind+':'+(workspaceId??'own')+':'+(query.data.after??'first')} kind={kind} after={query.data.after}
      email={user.email} scope={scope} canRestore={canRestore}/>,{actorId:user.userId,workspaceId});
  }
  if(pageQuery.view==='duplicates'){
    const query=z.object({view:z.literal('duplicates'),kind:z.enum(['contacts','companies']).optional(),workspaceId:z.string().guid("Invalid uuid").optional()})
      .strict().safeParse(pageQuery);
    if(!query.success)notFound();
    const params=new URLSearchParams({view:'duplicates'});
    for(const key of ['kind','workspaceId'] as const)if(query.data[key])params.set(key,query.data[key]);
    const user=await requireChatGPTUser('/?'+params),db=portableDb();
    const {workspaceId}=query.data,kind=query.data.kind??'contacts';
    let scope:{workspaceId:string;grantId:string}|undefined;
    let canDecide=true,canMerge=true;
    if(workspaceId){
      // Like the shared Recycle Bin, duplicate review is for editors of that workspace.
      if(portableWorkspaceGuest(user.email)&&!await guestWorkspaceAllowed(db,user.userId,workspaceId,loginConfig(env).allowedEmails))notFound();
      const grant=await sharedWorkspaceGrant(db,user.userId,workspaceId,true);
      if(grant?.role!=='editor'||!await sharedToolAllowed(db,user.userId,workspaceId,'duplicates'))notFound();
      canDecide=await sharedToolAllowed(db,user.userId,workspaceId,'duplicates','edit');
      canMerge=canDecide&&grant.editScope==='all'&&grant.recordActivities&&(kind==='companies'||(grant.contactFiles&&grant.contactOutreach&&grant.scheduledNotes));
      scope={workspaceId,grantId:grant.id};
    }else if(portableWorkspaceGuest(user.email))notFound();
    const customProperties=await listPortableCustomProperties(db,user.userId,kind,workspaceId);
    return withPortableNavigation(user.email,<PortableDuplicates key={kind+':'+(workspaceId??'own')} kind={kind} email={user.email} scope={scope} canDecide={canDecide} canMerge={canMerge} customProperties={customProperties}/>,{actorId:user.userId,workspaceId});
  }
  if(pageQuery.view==='subscriptions')return <PortableSubscriptionsPage input={pageQuery}/>;
  if(pageQuery.view==='payments')return <PortablePaymentsPage input={pageQuery}/>;
  if(pageQuery.view==='invoices')return <PortableInvoicesPage {...pageQuery}/>;
  if(pageQuery.view==='knowledge')return <PortableKnowledgePage {...pageQuery}/>;
  if(pageQuery.view==='segments')return <PortableSegmentPage {...pageQuery}/>;
  const {add,kind:requested,view,reportId,dashboardId,savedView,formId,filter,afterAt,afterId,queue,taskQueueId,taskView,taskZone,taskAssignee,taskPriority,taskType,contact,contactId,status,record,companyId,dealId,primaryContactId,search:requestedSearch,owner:requestedOwner,after,stage,pipelineId,closeMonth:requestedMonth,workspaceId:requestedWorkspace,invitation}=pageQuery;
  if(invitation!==undefined){
    const id=workspaceInvitationId.safeParse(invitation);
    if(!id.success)notFound();
    const user=await requireChatGPTUser(workspaceInvitationPath(id.data));
    const owners=portableWorkspaceGuest(user.email)?loginConfig(env).allowedEmails:undefined;
    const review=await readWorkspaceInvitation(portableDb(),user.userId,user.email,id.data,owners);
    return <PortableInvitationPage id={id.data} email={user.email} review={review}/>;
  }
  if(requested==='leads'){
    if(view!==undefined)notFound();
    return <PortableLeadPage search={requestedSearch} stage={stage} owner={requestedOwner}
      after={after} record={record} add={add} workspaceId={requestedWorkspace}/>;
  }
  if(requested==='tasks'){
    const query=portableTaskRead.safeParse({kind:'tasks',after,workspaceId:requestedWorkspace,search:requestedSearch,status,taskView,taskZone,taskAssignee,taskPriority,taskType,contactId,companyId,dealId,queueId:taskQueueId});
    const selection=z.string().guid("Invalid uuid").optional().safeParse(record);
    if(!query.success||!selection.success||view||savedView!==undefined||contact||primaryContactId||requestedOwner!==undefined||stage||pipelineId||requestedMonth)notFound();
    const {workspaceId,search}=query.data;
    const target=taskLinkTarget(query.data);
    const addingLinkedTask=add==='1'&&!!target&&!selection.data&&!query.data.taskView;
    const params=new URLSearchParams({kind:'tasks'});
    for(const [key,value] of Object.entries({after,workspaceId,search,status,contactId,companyId,dealId,record,taskQueueId,taskView,taskZone,taskAssignee,taskPriority,taskType})){
      if(value)params.set(key,value);
    }
    if(addingLinkedTask)params.set('add','1');
    const user=await requireChatGPTUser('/?'+params);
    const db=portableDb();
    if(portableWorkspaceGuest(user.email)){
      if(!workspaceId)return guestHome(user);
      if(!await guestWorkspaceAllowed(db,user.userId,workspaceId,loginConfig(env).allowedEmails))notFound();
    }
    const grant=workspaceId?await sharedWorkspaceGrant(db,user.userId,workspaceId,true):undefined;
    if(workspaceId&&!grant)notFound();
    const assigneeReview=query.data.taskView==='unavailable-assignee';
    const includeBody=await portablePageHasBody();
    const {result,initialRecord,linked,assignees,taskQueues,initialNextTaskId,customSource}=await db.transaction(async tx=>{
      const [result,initial,linked,assignees,taskQueues]=await Promise.all([
        readPortableTasks(tx,user.userId,query.data),
        selection.data?readPortableTasks(tx,user.userId,{kind:'tasks',id:selection.data,workspaceId,limit:1,
          taskView:assigneeReview?'unavailable-assignee':undefined},process.env.HARBOR_PORTABLE_AIRCALL_ENABLED==='true'):undefined,
        target?portableRecordReaders[target.kind](tx,user.userId,{id:target.id,workspaceId,limit:1}):undefined,
        grant?.role==='viewer'?[]:listPortableTaskAssignees(tx,user.userId,workspaceId,undefined,'tasks'),
        workspaceId?[]:listPortableTaskQueues(tx,user.userId),
      ]);
      if(!result||!('records' in result)||taskQueueId&&taskQueueId!==NO_QUEUE&&!taskQueues.some(item=>item.id===taskQueueId))notFound();
      if(selection.data&&(!initial||!('data' in initial)||target&&initial[taskLinkFields[target.kind]]!==target.id||
        query.data.status&&initial.data.status!==query.data.status||
        query.data.taskPriority&&initial.data.priority!==query.data.taskPriority||
        query.data.taskType&&initial.data.taskType!==query.data.taskType||
        (query.data.taskView==='mine'||query.data.taskAssignee==='me')&&(initial.assigneeId!==user.userId||initial.completedAt!==null)||taskQueueId&&initial.queueId!==(taskQueueId===NO_QUEUE?null:taskQueueId)))notFound();
      if(target&&(!linked||!('data' in linked)))notFound();
      const initialRecord=initial&&'data' in initial?initial:undefined;
      const [initialNextTaskId,customSource]=initialRecord?await Promise.all([
        readPortableTaskSuccessor(tx,user.userId,initialRecord.id,workspaceId),
        readCustomTaskSource(tx,user.userId,initialRecord.id,workspaceId),
      ]):[];
      if(includeBody)await recordWorkItemAccess(tx,user,'tasks',result,workspaceId,initialRecord,[
        ...(target?[target]:[]),...(initialNextTaskId?[{kind:'tasks' as const,id:initialNextTaskId}]:[]),
      ]);
      if(includeBody&&customSource)await recordCustomAccess(tx,user,'related',[
        {objectId:customSource.objectId,id:customSource.recordId},
      ],workspaceId);
      return {result,initialRecord,linked,assignees,taskQueues,initialNextTaskId,customSource};
    },{isolationLevel:'repeatable read'});
    return withPortableNavigation(user.email,<PortableTasks key={(grant?.id??'own')+':'+(record??(target?target.kind+':'+target.id:'list'))} email={user.email}
      workspaceId={workspaceId} grant={grant} records={result.records} next={result.next} paged={!!after} search={search}
      assignees={assignees} taskQueues={taskQueues} taskQueueId={taskQueueId} taskView={query.data.taskView} taskZone={query.data.taskZone} taskAssignee={query.data.taskAssignee}
      taskPriority={query.data.taskPriority} taskType={query.data.taskType} status={query.data.status}
      initialRecord={initialRecord} customSource={customSource} initialNextTaskId={initialNextTaskId}
      startNewTask={addingLinkedTask&&(!workspaceId||grant?.role==='editor')}
      related={target&&linked&&'data' in linked?{...target,name:linked.data.name}:undefined}/>,{actorId:user.userId,workspaceId});
  }
  const kind=portableRecordKind.catch('contacts').parse(requested);
  const workspace=z.string().guid("Invalid uuid").optional().safeParse(requestedWorkspace);
  if(!workspace.success)notFound();
  const workspaceId=workspace.data,params=new URLSearchParams();
  const wantsSummary=kind==='deals'&&view==='summary';
  const searchSchema=view==='reports'?portableReportSearch:view==='dashboards'?portableDashboardSearch:portableRecordSearch.optional();
  const search=searchSchema.safeParse(typeof requestedSearch==='string'?requestedSearch.trim()||undefined:requestedSearch);
  if(!search.success||search.data&&view!==undefined&&!wantsBoard&&view!=='reports'&&view!=='dashboards')notFound();
  const owner=portableRecordReadFields.shape.owner.safeParse(requestedOwner===''?undefined:requestedOwner);
  if(!owner.success)notFound();
  const closeMonth=dealCloseMonth.optional().safeParse(requestedMonth||undefined);
  if(!closeMonth.success||closeMonth.data&&kind!=='deals')notFound();
  const relatedId=companyId??primaryContactId;
  const relatedKind=companyId!==undefined?'companies':'contacts';
  const addingLinkedDeal=kind==='deals'&&relatedId!==undefined&&add==='1';
  const recordId=kind==='contacts'?contact:record;
  const viewId=portableSavedViewId.optional().safeParse(savedView);
  if(!viewId.success||viewId.data&&(view!==undefined&&!wantsBoard||wantsBoard&&after!==undefined||
    recordId!==undefined||relatedId!==undefined||requestedSearch!==undefined||requestedOwner!==undefined||
    stage!==undefined||pipelineId!==undefined||requestedMonth!==undefined))notFound();
  if(relatedId!==undefined&&(wantsBoard||recordId!==undefined||view!==undefined))notFound();
  if(kind!=='contacts')params.set('kind',kind);
  if(view==='marketing'||view==='api-access'||view==='workflows'||view==='email-settings'||view==='job-queue'||view==='calendar')params.set('view',view);
  if(view==='workflows'){
    if(runWorkflowId.data)params.set('runWorkflowId',runWorkflowId.data);
    if(runDealId.data)params.set('runDealId',runDealId.data);
    if(runObjectId.data&&runCustomRecordId.data){
      params.set('runObjectId',runObjectId.data);
      params.set('runCustomRecordId',runCustomRecordId.data);
    }
    if(runCompanyId.data)params.set('runCompanyId',runCompanyId.data);
    if(runTicketId.data)params.set('runTicketId',runTicketId.data);
    if(runIssue.data)params.set('runIssue',runIssue.data);
    if(afterAt!==undefined)params.set('afterAt',afterAt);
    if(afterId!==undefined)params.set('afterId',afterId);
  }
  if(jobId.data)params.set('jobId',jobId.data);
  if(view==='job-queue'){
    if(queue)params.set('queue',queue);
    if(jobKind.data)params.set('jobKind',jobKind.data);
    if(jobIssue.data)params.set('jobIssue',jobIssue.data);
    if(jobContact.data)params.set('jobContactId',jobContact.data);
    if(finishedFirst)params.set('jobOrder','finished');
    if(pageQuery.afterFinishedAt!==undefined)params.set('afterFinishedAt',pageQuery.afterFinishedAt);
    if(afterAt!==undefined)params.set('afterAt',afterAt);
    if(afterId!==undefined)params.set('afterId',afterId);
  }
  if(view==='reports'){
    params.set('view','reports');
    if(reportId)params.set('reportId',reportId);
    if(after)params.set('after',after);
  }
  if(view==='dashboards'){
    params.set('view','dashboards');
    if(dashboardId)params.set('dashboardId',dashboardId);
    for(const key of ['createdFrom','createdThrough','dashboardPipeline'] as const){
      if(pageQuery[key])params.set(key,pageQuery[key]!);
    }
    if(after)params.set('after',after);
  }
  if(view==='calendar'){
    if(filter!==undefined&&filter!=='needs_review')notFound();
    if(filter)params.set('filter',filter);
    if(afterAt!==undefined)params.set('afterAt',afterAt);
    if(afterId!==undefined)params.set('afterId',afterId);
  }
  if(view==='forms'){
    params.set('view','forms');
    if(formId)params.set('formId',formId);
    if(pageQuery.submissionId!==undefined){
      if(!z.string().guid().safeParse(pageQuery.submissionId).success||!formId||
        [filter,afterAt,afterId,pageQuery.inquiries,pageQuery.inquirySearch,pageQuery.followUp].some(value=>value!==undefined))notFound();
      params.set('submissionId',pageQuery.submissionId);
    }
    if(pageQuery.inquiries==='workspace')params.set('inquiries','workspace');
    if((formId||pageQuery.inquiries==='workspace')&&filter&&portableInquiryFilter.safeParse(filter).success)params.set('filter',filter);
    if(pageQuery.followUp==='open')params.set('followUp','open');
    if(inquirySearch.data)params.set('inquirySearch',inquirySearch.data);
    if(afterAt!==undefined&&afterId){params.set('afterAt',afterAt);params.set('afterId',afterId);}
  }
  const returnTo=recordId?recordReturnPath(pageQuery.back,workspaceId):undefined;
  if(returnTo)params.set('back',returnTo);
  if(recordId)params.set(kind==='contacts'?'contact':'record',recordId);
  if(companyId!==undefined)params.set('companyId',companyId);
  if(addingLinkedDeal)params.set('add','1');
  if(primaryContactId!==undefined)params.set('primaryContactId',primaryContactId);
  if(search.data)params.set('search',search.data);
  if(owner.data)params.set('owner',owner.data);
  if(!view&&after)params.set('after',after);
  if(closeMonth.data)params.set('closeMonth',closeMonth.data);
  if(wantsBoard||wantsSummary)params.set('view',wantsBoard?'board':'summary');
  if(kind==='deals'&&pipelineId)params.set('pipelineId',pipelineId);
  if(kind==='deals'&&stage&&!wantsBoard&&!wantsSummary)params.set('stage',stage);
  if(workspaceId)params.set('workspaceId',workspaceId);
  if(viewId.data){
    params.set('savedView',viewId.data);
    if(after)params.set('after',after);
  }
  const user=await requireChatGPTUser(params.size?'/?'+params:'/');
  if(portableWorkspaceGuest(user.email)){
    if(view&&!wantsBoard&&!wantsSummary&&view!=='dashboards'&&!(view==='reports'&&workspaceId))notFound();
    if(!workspaceId)return guestHome(user);
    if(!await guestWorkspaceAllowed(portableDb(),user.userId,workspaceId,loginConfig(env).allowedEmails))notFound();
  }
  if(view==='reports'){
    if(workspaceId){
      if(reportId!==undefined)notFound();
      return withPortableNavigation(user.email,<SharedReportPage user={user} workspaceId={workspaceId} after={after} search={search.data}/>,{actorId:user.userId,workspaceId});
    }
    return withPortableNavigation(user.email,<PortableReportPage user={user} reportId={reportId} after={after} search={search.data}/>);
  }
  if(view==='dashboards'){
    const filters=portableDashboardFilters.safeParse({createdFrom:pageQuery.createdFrom||undefined,createdThrough:pageQuery.createdThrough||undefined,dashboardPipeline:pageQuery.dashboardPipeline||undefined});
    if(!filters.success)notFound();
    return withPortableNavigation(user.email,<PortableDashboardPage filters={filters.data} workspaceId={workspaceId} user={user} dashboardId={dashboardId} after={after} search={search.data}/>,{actorId:user.userId,workspaceId});
  }
  const legacyCalendar=portableCalendarConfig()?.owner===user.email.toLowerCase();
  const personalCalendar=!!portablePersonalGoogleConfig('calendar')&&!legacyCalendar;
  const outlookCalendar=Boolean(outlookConfig('outlook-calendar'));
  const calendarAvailable=legacyCalendar||personalCalendar||outlookCalendar;
  const calendarInvites=legacyCalendar&&portableCalendarInvitesEnabled();
  if(view==='calendar'){
    const cursor=portableWorkflowCursor.optional().safeParse(afterAt!==undefined||afterId!==undefined?{at:afterAt,id:afterId}:undefined);
    if(workspaceId||!calendarAvailable||!cursor.success)notFound();
    const meetings=calendarInvites?await listPortableMeetings(portableDb(),user.userId,cursor.data,filter==='needs_review'):undefined;
    return withPortableNavigation(user.email,<PortableCalendar email={user.email} meetings={meetings} legacyGoogle={legacyCalendar}
      outlook={outlookCalendar?await personalConnectionStatus(user,'outlook-calendar'):undefined} outlookOutcome={pageQuery.outlook} personal={personalCalendar?await personalConnectionStatus(user,'calendar'):undefined}
      googleOutcome={pageQuery.google} cancellationsEnabled={portableCalendarCancellationsEnabled()}
      reschedulesEnabled={portableCalendarReschedulesEnabled()}/>);
  }
  if(view==='api-access'){
    if(workspaceId)notFound();
    const db=portableDb();
    const [tokens,webhooks]=await Promise.all([readPortableApiTokens(db,user.userId,{}),readWebhookSettings(db,user.userId,configuredWebhookDestinations)]);
    return withPortableNavigation(user.email,<PortableApiTokens directoryEnabled={!!portableDirectoryConfig()} oidcDirectoryEnabled={!!portableOidcDirectoryConfig()} samlDirectoryEnabled={!!portableSamlDirectoryConfig()} email={user.email} initial={tokens} webhooks={webhooks}/>);
  }
  if(view==='marketing'){
    if(workspaceId)notFound();
    return withPortableNavigation(user.email,<PortableMarketingPage user={user}/>);
  }
  if(view==='email-settings'){
    if(workspaceId)notFound();
    const inboxAvailable=portableGmailInboxOwner()===user.email.toLowerCase();
    return withPortableNavigation(user.email,<PortableEmailSettings email={user.email} inboxAvailable={inboxAvailable}
      outlook={outlookConfig('outlook-mail')?await personalConnectionStatus(user,'outlook-mail'):undefined} outlookOutcome={pageQuery.outlook}
      personal={!inboxAvailable&&portablePersonalGoogleConfig('gmail')?await personalConnectionStatus(user,'gmail'):undefined} googleOutcome={pageQuery.google}/>);
  }
  const db=portableDb();
  if(view==='job-queue'){
    const filter=z.enum(queueViews).default('issues').safeParse(queue);
    const orderedAfter=finishedFirst?pageQuery.afterFinishedAt:afterAt;
    const cursor=portableWorkflowCursor.optional().safeParse(orderedAfter!==undefined||afterId!==undefined?{at:orderedAfter,id:afterId}:undefined);
    if(workspaceId||!filter.success||!cursor.success)notFound();
    const selectedKind=jobKind.data||undefined;
    const page=await readOwnerQueue(db,user.userId,jobId.data?'all':filter.data,{
      after:cursor.data,jobId:jobId.data,kind:selectedKind,issue:jobIssue.data||undefined,
      finishedFirst,contactId:jobContact.data||undefined,
    });
    if(jobId.data&&!page.items.length||jobContact.data&&!page.contact)notFound();
    return withPortableNavigation(user.email,<PortableJobOperations email={user.email} view={filter.data} kind={selectedKind} issue={jobIssue.data||undefined} page={page} focused={Boolean(jobId.data)} finishedFirst={finishedFirst}/>);
  }
  if(view==='workflows'){
    const cursor=portableWorkflowCursor.optional().safeParse(afterAt!==undefined||afterId!==undefined?{at:afterAt,id:afterId}:undefined);
    if(workspaceId||!cursor.success)notFound();
    const runFilters={runWorkflowId:runWorkflowId.data,runDealId:runDealId.data,runTicketId:runTicketId.data,runCompanyId:runCompanyId.data,runObjectId:runObjectId.data,runCustomRecordId:runCustomRecordId.data,runIssue:runIssue.data};
    const [workflows,history,pipelines,segments,catalog,webhookDestinations]=await Promise.all([
      readPortableWorkflows(db,user.userId),readPortableWorkflowRuns(db,user.userId,{after:cursor.data,...runFilters}),readDealPipelines(db,user.userId),
      readPortableSegments(db,user,{limit:25,activeOnly:'true'}),readObjects(db,user.userId,{}),
      readOwnedWorkspaceId(db,user.userId).then(ownedWorkspace=>{
        if(!ownedWorkspace)return [];
        try{return configuredWebhookDestinations(ownedWorkspace);}catch{return [];}
      }),
    ]);
    const savedNames=Object.fromEntries(workflows.flatMap(w=>'objectId' in w.definition&&w.customObjectName?
      [[w.definition.objectId,w.customObjectName]]:[]));
    const objectTypes=catalog.view==='types'?{items:catalog.items,next:catalog.next,savedNames}:{items:[],next:null,savedNames};
    return withPortableNavigation(user.email,<PortableWorkflows objectTypes={objectTypes} email={user.email} webhookDestinations={webhookDestinations} codeAvailable={portableCodeAvailable()} gmailAvailable={portableWorkflowGmailOwner()===user.email.toLowerCase()} workflows={workflows} history={history} {...runFilters} pipelines={[builtinPipeline,...pipelines]}
      segments={segments&&'segments' in segments?segments:{segments:[],next:null}}/>);
  }
  if(view==='forms'){
    const cursor=z.object({at:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),id:z.string().guid("Invalid uuid")})
      .optional().safeParse(afterAt!==undefined||afterId!==undefined?{at:afterAt,id:afterId}:undefined);
    const workspaceInbox=pageQuery.inquiries==='workspace';
    const inquiryFilter=portableInquiryFilter.default(workspaceInbox?'open':'all').safeParse(filter);
    if(workspaceId||!cursor.success||!inquiryFilter.success||
      pageQuery.inquiries!==undefined&&(!workspaceInbox||formId||pageQuery.followUp!==undefined)||
      (filter!==undefined||cursor.data)&&!formId&&!workspaceInbox)notFound();
    const followUp=pageQuery.followUp;
    if(followUp!==undefined&&followUp!=='open')notFound();
    const openOnly=followUp==='open';
    const forms=workspaceInbox?[]:await listLeadForms(db,user.userId);
    const selected=formId?forms.find(form=>form.id===formId):undefined;
    if(formId&&!selected)notFound();
    const page=selected||workspaceInbox?await readLeadInquiries(db,user,{formId:selected?.id,cursor:cursor.data,
      filter:inquiryFilter.data,inquirySearch:inquirySearch.data,submissionId:pageQuery.submissionId},await portablePageHasBody()):undefined;
    if(pageQuery.submissionId&&!page?.results.length)notFound();
    return withPortableNavigation(user.email,<PortableLeadForms key={selected?.id??(workspaceInbox?'inbox':'new')} email={user.email} publicOrigin={loginConfig(env).origin}
      forms={openOnly?forms.filter(form=>form.hasOpenInquiries):forms} openOnly={openOnly} workspaceInbox={workspaceInbox}
      selected={selected} page={page} focusedInquiry={!!pageQuery.submissionId} filter={inquiryFilter.data} inquirySearch={inquirySearch.data}/>);
  }
  const grant=workspaceId?await sharedWorkspaceGrant(db,user.userId,workspaceId,true):undefined;
  if(workspaceId&&!grant)notFound();
  const id=z.string().guid("Invalid uuid").optional().safeParse(recordId);
  if(!id.success)notFound();
  const loadedViews=viewId.data?await listPortableSavedViews(db,user.userId,kind,workspaceId):undefined;
  const activeView=loadedViews?.find(item=>item.id===viewId.data);
  if(viewId.data&&!activeView)notFound();
  const filters:PortableSavedViewFilters=activeView?.filters??{stage:stage||undefined,pipelineId:pipelineId||undefined,closeMonth:closeMonth.data,search:search.data,owner:owner.data};
  const parsed=portableRecordRead.safeParse({kind,after,workspaceId,companyId,primaryContactId,...filters});
  if((activeView||relatedId!==undefined||closeMonth.data||search.data||owner.data)&&!parsed.success)notFound();
  const includeBody=await portablePageHasBody();
  const [result,custom,initial,source,savedViews,customProperties,assignees,workspaceSharing,groupConfig,standardAccess]=await Promise.all([
    (wantsBoard||wantsSummary||id.data)?{records:[],next:null}:readAuditedRecords(db,user,kind,parsed.success?parsed.data:{limit:25,workspaceId},includeBody),
    kind==='deals'?readDealPipelines(db,user.userId,workspaceId):[],
    id.data?readAuditedRecords(db,user,kind,{id:id.data,limit:1,workspaceId},includeBody):undefined,
    relatedId?portableRecordReaders[relatedKind](db,user.userId,{id:relatedId,limit:1,workspaceId}):undefined,
    !view&&!relatedId&&!id.data?(loadedViews??listPortableSavedViews(db,user.userId,kind,workspaceId)):undefined,
    wantsSummary?[]:listPortableCustomProperties(db,user.userId,kind,workspaceId),
    wantsSummary||grant?.role==='viewer'?[]:listPortableTaskAssignees(db,user.userId,workspaceId,undefined,kind),
    kind==='contacts'&&!workspaceId&&!relatedId&&!id.data
      ? initialWorkspaceSharing(user)
      :undefined,
    id.data||wantsBoard?readPortablePropertyGroups(db,user.userId,kind,workspaceId):undefined,
    workspaceId?listPortableStandardAccess(db,user.userId,kind,workspaceId):undefined,
  ]);
  const stageEditable=kind!=='deals'||!standardAccess||standardAccess.some(field=>field.id==='stage');
  const hiddenStandardFields=standardAccess?restrictedStandardFields[kind].filter(id=>!standardAccess.some(field=>field.id===id)):[];
  if(filters.closeMonth&&hiddenStandardFields.includes('closeDate'))notFound();
  if(id.data&&(!initial||'records' in initial))notFound();
  if(relatedId&&(!source||'records' in source))notFound();
  const related=source&&'data' in source?{kind:relatedKind,id:source.id,name:source.data.name} as const:undefined;
  if(!result||!('records' in result))throw Error('Could not load records.');
  const lastContactedById=kind==='contacts'&&(!workspaceId||grant?.contactOutreach)&&(id.data||activeView?.columns?.includes(portableLastContactedColumn.id))
    ?await readPortableLastContacted(db,user.userId,id.data?[id.data]:result.records.map(row=>row.id),workspaceId):undefined;
  const pipelines=[builtinPipeline,...custom];
  const selectedPipeline=wantsBoard||wantsSummary?pipelines.find(item=>item.id===(filters.pipelineId||'default')):undefined;
  if((wantsBoard||wantsSummary)&&!selectedPipeline)notFound();
  const board=wantsBoard&&selectedPipeline?{pipeline:selectedPipeline,lanes:await db.transaction(async tx=>{
    const lanes=await readDealBoard(tx,user.userId,selectedPipeline,{workspaceId,search:filters.search,owner:filters.owner,closeMonth:filters.closeMonth});
    if(includeBody){
      const cards=lanes.flatMap(lane=>lane.cards);
      await recordAccess(tx,user,'deals','list',cards.map(card=>card.id),workspaceId);
      await recordPrimaryLinks(tx,user,cards,workspaceId);
    }
    return lanes;
  },{isolationLevel:'repeatable read'})}:undefined;
  const summary=wantsSummary&&selectedPipeline?{pipeline:selectedPipeline,
    totals:await readDealSummary(db,user.userId,selectedPipeline,closeMonth.data,workspaceId)}:undefined;
  const gmailSender=!workspaceId&&portableGmailOwner()===user.email.toLowerCase()?user.email.toLowerCase():undefined;
  const legacyInbox=portableGmailInboxOwner()===user.email.toLowerCase();
  const personalInbox=kind==='contacts'&&!workspaceId&&!legacyInbox&&!!portablePersonalGoogleConfig('gmail')&&await personalConnectionStatus(user,'gmail');
  const gmailInboxEnabled=kind==='contacts'&&!workspaceId&&(legacyInbox||!!personalInbox&&personalInbox!=='unavailable'&&!personalInbox.needsReconnect);
  const privateContacts=kind==='contacts'&&!workspaceId;
  const [mailGrant,calendarGrant]=privateContacts?await Promise.all([
    outlookConfig('outlook-mail')&&personalConnectionStatus(user,'outlook-mail'),
    outlookCalendar&&personalConnectionStatus(user,'outlook-calendar'),
  ]):[];
  // A visibility change can arrive on refresh without a new record revision or membership ID.
  // Drop cached history and editor state when the shared field set changes.
  const fieldAccessKey=workspaceId?[...hiddenStandardFields,...customProperties.map(property=>property.id)].sort().join(','):'';
  const recordPageKey=[kind,grant?.id??'own',id.data??relatedId??'list',fieldAccessKey,stageEditable].join(':');
  return withPortableNavigation(user.email,<PortableRecords currentPath={params.size?'/?'+params:'/'} returnTo={returnTo} key={recordPageKey} stageEditable={stageEditable} kind={kind} email={user.email} workspaceId={workspaceId} grant={grant}
    outlookMailEnabled={Boolean(mailGrant&&mailGrant!=='unavailable'&&!mailGrant.needsReconnect)}
    outlookCalendarEnabled={Boolean(calendarGrant&&calendarGrant!=='unavailable'&&!calendarGrant.needsReconnect)}
    aircallEnabled={process.env.HARBOR_PORTABLE_AIRCALL_ENABLED==='true'} gmailSender={gmailSender} gmailInboxEnabled={gmailInboxEnabled} calendarAvailable={calendarAvailable} calendarInvites={calendarInvites} initialRecord={initial&&'data' in initial?initial:undefined} related={related} filesEnabled={objectStorageConfigured()} records={result.records}
    startNewDeal={addingLinkedDeal&&(!workspaceId||grant?.role==='editor')}
    pipelines={pipelines} board={board} summary={summary} closeMonth={filters.closeMonth} pipelineId={selectedPipeline?.id??(parsed.success?parsed.data.pipelineId:undefined)}
    search={filters.search} owner={filters.owner} sort={filters.sort} next={result.next} paged={!!(parsed.success&&parsed.data.after)} stage={!wantsBoard&&!wantsSummary&&parsed.success?parsed.data.stage:undefined}
    savedViews={savedViews} activeViewId={activeView?.id} activeViewName={activeView?.name} activeViewColumns={activeView?.columns} customProperties={customProperties} hiddenStandardFields={hiddenStandardFields} lastContactedById={lastContactedById}
    assignees={assignees} workspaceSharing={workspaceSharing}
    propertyOrganization={groupConfig&&visiblePropertyOrganization(kind,customProperties,groupConfig)}/>,{actorId:user.userId,workspaceId});
}
