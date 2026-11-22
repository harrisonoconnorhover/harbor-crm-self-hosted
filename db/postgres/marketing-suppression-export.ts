import {link,lstat,open,unlink} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {emailSuppressions} from './email-suppression-schema';
import {marketingAudienceContacts as contacts} from './marketing-audience-schema';
import {marketingAudienceStatus} from './marketing-audience-store';

const pageSize=500;
const validContactId=/^003[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

function hasCode(error:unknown,code:string){
  return error instanceof Error&&'code' in error&&error.code===code;
}

export async function exportSalesforceOptOuts(db:PostgresJsDatabase,workspaceId:string,filePath:string){
  const target=resolve(filePath);
  // Fail early on existing files, including dangling symlinks. link() below also covers races.
  try{
    await lstat(target);
    throw new Error('Choose a new file for the Salesforce opt-out export.');
  }catch(error){if(!hasCode(error,'ENOENT'))throw error;}
  const temporary=join(dirname(target),'.harbor-optouts-'+crypto.randomUUID()+'.tmp');
  const file=await open(temporary,'wx',0o600);
  try{
    const result=await db.transaction(async tx=>{
      const snapshot=await marketingAudienceStatus(tx,workspaceId);
      if(snapshot.state!=='ready'||!snapshot.generation||!snapshot.completedAt){
        throw new Error('Refresh the Salesforce audience successfully before exporting opt-outs.');
      }
      const currentId=snapshot.generation;
      const [counts]=await tx.execute<{confirmed:number;matched:number}>(sql`
        SELECT count(*)::int AS confirmed,count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM ${contacts} c WHERE c.workspace_id=b.workspace_id AND c.generation=${currentId}::uuid
            AND c.email=b.email
        ))::int AS matched
        FROM ${emailSuppressions} b WHERE b.workspace_id=${workspaceId}::uuid AND b.recipient_opted_out_at IS NOT NULL`);
      let after='',contactRows=0;
      await file.writeFile('Id,HasOptedOutOfEmail\r\n');
      for(;;){
        const rows=await tx.execute<{id:string}>(sql`SELECT c.id FROM ${contacts} c
          JOIN ${emailSuppressions} b ON b.workspace_id=c.workspace_id AND b.email=c.email
          WHERE c.workspace_id=${workspaceId}::uuid AND c.generation=${currentId}::uuid AND c.id>${after}
            AND b.recipient_opted_out_at IS NOT NULL ORDER BY c.id LIMIT ${pageSize}`);
        if(!rows.length)break;
        const lines=rows.map(row=>{
          if(!validContactId.test(row.id))throw new Error('An invalid Salesforce Contact ID prevented the export. Refresh the audience.');
          return row.id+',TRUE\r\n';
        });
        await file.writeFile(lines.join(''));
        contactRows+=rows.length;after=rows[rows.length-1].id;
        if(rows.length<pageSize)break;
      }
      return {workspaceId,snapshot:snapshot.completedAt,generation:currentId,confirmedAddresses:counts.confirmed,
        matchedAddresses:counts.matched,unmatchedAddresses:counts.confirmed-counts.matched,contactRows};
    },{isolationLevel:'repeatable read',accessMode:'read only'});
    await file.sync();
    const latest=await marketingAudienceStatus(db,workspaceId);
    if(latest.state!=='ready'||latest.generation!==result.generation)throw new Error('The Salesforce audience changed during export. Run the export again.');
    // Atomic, exclusive publication on the same filesystem. Never replace an existing path.
    await link(temporary,target).catch(error=>{
      if(hasCode(error,'EEXIST'))throw new Error('Choose a new file for the Salesforce opt-out export.');
      throw error;
    });
    return result;
  }finally{
    try{await file.close();}finally{await unlink(temporary);}
  }
}
