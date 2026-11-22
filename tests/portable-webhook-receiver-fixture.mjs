import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';

const cli='examples/record-receiver/receiver.mjs';
const run=promisify(execFile);

export async function recordReceiver(workspaceId,secret,origin){
  const dir=await mkdtemp(join(tmpdir(),'record-receiver-'));
  const file=join(dir,'mirror.sqlite');
  const env={...process.env,RECEIVER_DATABASE:file,RECEIVER_WORKSPACE_ID:workspaceId,RECEIVER_SECRET:secret,
    RECEIVER_HARBOR_ORIGIN:origin,RECEIVER_PORT:'0'};
  let child,closed,url;
  async function start(){
    child=spawn(process.execPath,[cli,'listen'],{env,stdio:['ignore','pipe','inherit']});
    closed=once(child,'close');
    const lines=createInterface({input:child.stdout});
    try{
      const [line]=await Promise.race([once(lines,'line',{signal:AbortSignal.timeout(8000)}),
        closed.then(()=>{throw Error('Receiver exited before listening.');})]);
      const port=/^Listening on loopback port (\d+)$/.exec(line);
      assert.ok(port,line);url='http://127.0.0.1:'+port[1]+'/incoming';
    }finally{lines.close();}
  }
  async function stop(){
    if(child?.exitCode===null&&child.signalCode===null)child.kill();
    await closed;
  }
  async function close(){try{await stop();}finally{await rm(dir,{recursive:true,force:true});}}
  try{await start();}catch(error){await close();throw error;}
  return {close,
    async restart(){await stop();await start();},
    async accept(headers,body){
      const response=await fetch(url,{method:'POST',headers:{
        'x-harbor-signature':headers['x-harbor-signature'],'x-harbor-timestamp':headers['x-harbor-timestamp'],
        'x-harbor-event-id':headers['x-harbor-event-id'],'idempotency-key':headers['idempotency-key'],
      },body});
      await response.body?.cancel();
      return response.status;
    },
    async command(token,...args){
      const {stdout}=await run(process.execPath,[cli,...args],{env:{...env,RECEIVER_READ_TOKEN:token},timeout:20000});
      return JSON.parse(stdout);
    },
    record(object,id){
      const db=new DatabaseSync(file,{readOnly:true});
      try{return db.prepare('SELECT pending,state,name FROM records WHERE object=? AND id=?').get(object,id);}
      finally{db.close();}
    },
  };
}
