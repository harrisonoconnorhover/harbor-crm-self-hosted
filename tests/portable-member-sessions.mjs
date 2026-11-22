import {createHash,randomBytes,randomUUID} from 'node:crypto';

// Seed distinct, short-lived sessions in the disposable database. HTTP reads and
// writes still pass through the real identity, membership and rate-limit checks.
export async function seedMemberSessions(sql,teams,emails){
  const people=[];
  const now=Date.now();
  await sql.begin(async tx=>{
    for(const [index,email] of emails.entries()){
      const id=randomUUID(),grant=randomUUID(),team=index%teams.length,token=randomBytes(32).toString('base64url');
      await tx`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
        VALUES(${id},${id},${email},${now},${now})`;
      await tx`INSERT INTO login_sessions(token_hash,user_id,created_at,expires_at)
        VALUES(${createHash('sha256').update(token).digest('base64url')},${id},${now},${now+600000})`;
      await tx`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role)
        VALUES(${teams[team]},${id},${grant},'editor')`;
      people.push({headers:{cookie:'harbor-session='+token},team,grant});
    }
  });
  return people;
}
