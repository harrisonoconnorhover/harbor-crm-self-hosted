import {and,asc,eq,inArray,ne,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portableTaskQueueLimit,type PortableTaskQueue,type PortableTaskQueueInput} from '../../lib/portable-task-queues';
import {lockRecordWorkspace} from './private-workspace-store';
import {portableTaskQueues as queues} from './task-queue-schema';
import {activeTask,portableTaskEvents,portableTaskSnapshot,portableTasks as tasks} from './task-schema';
import {privateWorkspaces} from './workspace-schema';

const fields={id:queues.id,name:queues.name,revision:queues.revision};
export function listPortableTaskQueues(db:PostgresJsDatabase,actorId:string):Promise<PortableTaskQueue[]>{
  return db.select(fields).from(queues).innerJoin(privateWorkspaces,eq(queues.workspaceId,privateWorkspaces.id))
    .where(eq(privateWorkspaces.ownerId,actorId)).orderBy(asc(sql`lower(${queues.name})`),asc(queues.id)).limit(portableTaskQueueLimit);
}

export function changePortableTaskQueue(db:PostgresJsDatabase,actorId:string,input:PortableTaskQueueInput){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,input.action==='create',undefined,undefined,true);
    if(!workspaceId)return {error:'missing'} as const;
    const scope=eq(queues.workspaceId,workspaceId);
    if(input.action==='assign'){
      const taskScope=and(eq(tasks.workspaceId,workspaceId),activeTask);
      const requested=new Map(input.tasks.map(task=>[task.id,task.expectedRevision]));
      const selected=await tx.select().from(tasks).where(and(taskScope,inArray(tasks.id,[...requested.keys()]))).for('update');
      if(selected.length!==requested.size)return {error:'tasks_missing'} as const;
      if(selected.some(task=>task.revision!==requested.get(task.id)))return {error:'tasks_stale'} as const;
      if(input.queueId){
        const [destination]=await tx.select({id:queues.id}).from(queues).where(and(scope,eq(queues.id,input.queueId)));
        if(!destination)return {error:'missing'} as const;
      }
      const changed=selected.filter(task=>task.queueId!==input.queueId);
      if(!changed.length)return {changed:0};
      // Keep the Task's modified time while invalidating stale editors that still carry its old queue.
      const occurredAt=new Date().toISOString();
      await tx.update(tasks).set({queueId:input.queueId,revision:sql`${tasks.revision}+1`})
        .where(and(taskScope,inArray(tasks.id,changed.map(task=>task.id))));
      await tx.insert(portableTaskEvents).values(changed.map(task=>({workspaceId,taskId:task.id,revision:task.revision+1,
        actorId,previous:portableTaskSnapshot(task),data:portableTaskSnapshot({...task,queueId:input.queueId}),occurredAt})));
      return {changed:changed.length};
    }
    const target=and(scope,eq(queues.id,input.id));
    const [current]=await tx.select(fields).from(queues).where(target);
    if(input.action==='create'&&current){
      return current.name===input.name?{queue:current}:{error:'stale'} as const;
    }
    if(input.action!=='create'){
      if(!current)return {error:'missing'} as const;
      if(current.revision!==input.revision)return {error:'stale'} as const;
    }
    if(input.action==='remove'){
      const [used]=await tx.select({id:tasks.id}).from(tasks)
        .where(and(eq(tasks.workspaceId,workspaceId),eq(tasks.queueId,input.id))).limit(1);
      if(used)return {error:'in_use'} as const;
      await tx.delete(queues).where(target);
      return {removed:true} as const;
    }
    const [duplicate]=await tx.select({id:queues.id}).from(queues).where(and(scope,ne(queues.id,input.id),
      sql`lower(${queues.name})=lower(${input.name})`)).limit(1);
    if(duplicate)return {error:'duplicate'} as const;
    if(input.action==='create'){
      const existing=await tx.select({id:queues.id}).from(queues).where(scope).limit(portableTaskQueueLimit);
      if(existing.length>=portableTaskQueueLimit)return {error:'limit'} as const;
      const [queue]=await tx.insert(queues).values({workspaceId,id:input.id,name:input.name,revision:1}).returning(fields);
      return {queue};
    }
    const [queue]=await tx.update(queues).set({name:input.name,revision:input.revision+1}).where(target).returning(fields);
    return {queue};
  });
}
