import postgres from 'postgres';

const databaseStatusDeadlineMs=5_000;

export async function readPortableDatabaseStatus<T>(
  url:URL, read:(client:ReturnType<typeof postgres>)=>Promise<T>,
){
  const client=postgres(url.href,{max:1,connect_timeout:3,connection:{statement_timeout:3000},onnotice:()=>{}});
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
