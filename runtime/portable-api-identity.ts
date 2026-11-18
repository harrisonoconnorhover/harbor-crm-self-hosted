import {z} from 'zod';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {identityRequestFailure,loginConfig} from '../lib/identity';
import {env} from './portable-env';
import {portableWorkspaceGuest,requestIdentity} from './portable-identity';
import {portableDb} from './portable-db';
import {portableRateLimit} from './portable-rate-limit';

const guestWorkspacePaths=new Set(['/api/custom-properties','/api/crm','/api/background-jobs','/api/record-attachments','/api/logged-activities','/api/pipeline','/api/associations','/api/crm/views','/api/crm/search','/api/reporting','/api/task-reminders','/api/recycle-bin','/api/record-merge','/api/duplicates','/api/leads','/api/tickets']);

export async function portableApiIdentity(request:Request,scope?:'api_read'|'api_write'){
  const failure=identityRequestFailure(request,env);
  if(failure)return failure;
  const user=await requestIdentity(request.headers);
  if(!user)return Response.json({error:'Sign in to access your CRM.'},{
    status:401,headers:{'cache-control':'private, no-store'},
  });
  const budget=scope??(request.method==='GET'||request.method==='HEAD'?'api_read':'api_write');
  const limited=await portableRateLimit(budget,user.userId);
  if(limited)return limited;
  const guest=portableWorkspaceGuest(user.email);
  const url=new URL(request.url);
  if(guest&&url.pathname!=='/api/workspaces'){
    const workspace=z.string().guid("Invalid uuid").safeParse(url.searchParams.get('workspaceId'));
    if(!guestWorkspacePaths.has(url.pathname)||!workspace.success||
      !await guestWorkspaceAllowed(portableDb(),user.userId,workspace.data,loginConfig(env).allowedEmails)){
      return Response.json({error:'Open a workspace shared with your account.'},{
        status:403,headers:{'cache-control':'private, no-store'},
      });
    }
  }
  return {...user,guest};
}
