import postgres from 'postgres';

const databaseStatusDeadlineMs=5_000;

type Client=ReturnType<typeof postgres>;
// postgres.js 3.4 passes a callable tag to begin(), but its TransactionSql declaration omits that signature.
export type StatusQuery=<R extends postgres.Row[]=postgres.Row[]>(parts:TemplateStringsArray,...values:boolean[])=>PromiseLike<R>;

export function readPortableDatabaseStatus<T>(url:URL,read:(client:Client)=>Promise<T>){
  return boundedStatus(url,read,{statement_timeout:3000});
}

// PgBouncer can move the next transaction to a different backend.
export function boundedStatusTransaction<T extends string>(client:Client,read:(tx:StatusQuery)=>Promise<T>){
  return client.begin(async tx=>{
    await tx.unsafe("SET LOCAL statement_timeout = '3s'");
    return read(tx as unknown as StatusQuery);
  });
}

export function readPortableDatabaseTransaction<T extends string>(url:URL,read:(tx:StatusQuery)=>Promise<T>){
  return boundedStatus(url,client=>boundedStatusTransaction(client,read));
}

async function boundedStatus<T>(url:URL,read:(client:Client)=>Promise<T>,connection?:{statement_timeout:number}){
  const client=postgres(url.href,{max:1,connect_timeout:3,connection,onnotice:()=>{}});
  let timer:ReturnType<typeof setTimeout>|undefined;
  let timedOut=false;
  try{
    // A statement timeout cannot deliver a reply if the established socket is blackholed.
    const deadline=new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{
        timedOut=true;
        reject(new Error('Portable database status check timed out.'));
      },databaseStatusDeadlineMs);
    });
    return await Promise.race([read(client),deadline]);
  }finally{
    clearTimeout(timer);
    await client.end({timeout:timedOut?0:3});
  }
}
