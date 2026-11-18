import {changePortableTaskQueue,listPortableTaskQueues} from '../db/postgres/task-queue-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableTaskQueueInput,portableTaskQueueLimit} from '../lib/portable-task-queues';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const errors={
  missing:{status:404,error:'Task queue not found.'},
  stale:{status:409,error:'This queue changed. Reload it before saving.'},
  tasks_missing:{status:404,error:'A selected task is unavailable. Refresh the list before trying again.'},
  tasks_stale:{status:409,error:'A selected task changed. Refresh the list before trying again.'},
  duplicate:{status:409,error:'A queue with that name already exists.'},
  limit:{status:409,error:'Keep at most '+portableTaskQueueLimit+' task queues.'},
  in_use:{status:409,error:'Move tasks out of this queue before removing it. Restore any archived tasks in this queue before moving them.'},
};

async function taskQueues(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    if(new URL(request.url).searchParams.size)return json({error:'Open your own workspace to manage task queues.'},403);
    const db=portableDb();
    if(request.method!=='POST')return json({queues:await listPortableTaskQueues(db,user.userId)});
    let body:unknown;
    try{
      const text=await readBoundedRequestText(request,4096);
      if(text!==null)body=JSON.parse(text);
    }catch{}
    const input=portableTaskQueueInput.safeParse(body);
    if(!input.success)return json({error:'Check the task queue settings.'},400);
    const result=await changePortableTaskQueue(db,user.userId,input.data);
    if('error' in result&&result.error){
      const failure=errors[result.error];
      return json({error:failure.error},failure.status);
    }
    return json(result);
  }catch{return json({error:'Could not save or load task queues.'},500);}
}
export {taskQueues as GET,taskQueues as POST};
