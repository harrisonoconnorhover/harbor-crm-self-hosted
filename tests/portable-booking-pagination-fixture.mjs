import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const path='/api/calendar/availability-page';
const order=(left,right)=>right.verifiedAt-left.verifiedAt
  ||(left.id<right.id?1:left.id>right.id?-1:0);

export async function verifyPortableBookingPagination({request,headers,other,sql,workspaceId,pageId,
  previousPageId=randomUUID(),slot}){
  const read=(cursor,auth=headers)=>request(cursor?path+'?'+new URLSearchParams(cursor):path,{headers:auth});
  const page=async cursor=>{
    const response=await read(cursor);
    assert.equal(response.status,200,await response.clone().text());
    assert.match(response.headers.get('cache-control'),/no-store/);
    const body=await response.json();
    assert.equal(body.page.id,pageId);
    return body;
  };
  const initial=await page();
  assert.equal(initial.nextVerifiedRequests,null);
  const [foreign]=await sql`SELECT id FROM private_workspaces WHERE id<>${workspaceId} LIMIT 1`;
  assert.ok(foreign,'The fixture requires a second workspace.');
  const now=Date.now(),prefix='booking-pagination-'+randomUUID().slice(0,8);
  const booking=(label,values)=>({
    workspace_id:workspaceId,page_id:pageId,id:randomUUID(),email:`${prefix}-${label}@example.test`,
    start:slot.start,end:slot.end,code_hash:'fictional-pagination-code',
    created_at:now-1000,verified_at:now,expires_at:now+900_000,...values,
  });
  // Both full pages split a tied timestamp, so the cursor also needs the UUID.
  const upcoming=Array.from({length:51},(_,index)=>booking(index,{verified_at:index<26?now:now-1000}));
  const unverified=booking('unverified',{verified_at:null});
  const past=booking('past',{start:new Date(now-3_600_000).toISOString(),end:new Date(now-1_800_000).toISOString()});
  const retired=booking('retired',{page_id:previousPageId});
  const foreignRow=booking('foreign',{workspace_id:foreign.id});
  const seeded=[...upcoming,unverified,past,retired,foreignRow];
  const expected=[...initial.verifiedRequests,...upcoming.map(({id,verified_at:verifiedAt})=>({id,verifiedAt}))]
    .sort(order).map(({id})=>id);
  const rejected=async(response,status)=>{
    assert.equal(response.status,status,await response.clone().text());
    assert.match(response.headers.get('cache-control'),/no-store/);
    const body=await response.json();
    assert.deepEqual(Object.keys(body),['error']);
    assert.equal(typeof body.error,'string');
    return body;
  };
  try{
    await sql`INSERT INTO portable_guest_booking_requests ${sql(seeded)}`;
    const first=await page();
    assert.deepEqual(first.verifiedRequests.map(({id})=>id),expected.slice(0,25));
    assert.deepEqual(first.nextVerifiedRequests,{pageId,afterId:expected[24]});
    const second=await page(first.nextVerifiedRequests);
    assert.deepEqual(second.verifiedRequests.map(({id})=>id),expected.slice(25,50));
    assert.deepEqual(second.nextVerifiedRequests,{pageId,afterId:expected[49]});
    const third=await page(second.nextVerifiedRequests);
    assert.deepEqual(third.verifiedRequests.map(({id})=>id),expected.slice(50));
    assert.equal(third.nextVerifiedRequests,null);

    const generic=await rejected(await read({pageId,afterId:randomUUID()}),409);
    for(const afterId of [unverified.id,retired.id,foreignRow.id]){
      assert.deepEqual(await rejected(await read({pageId,afterId}),409),generic);
    }
    assert.deepEqual(await rejected(await read({pageId:previousPageId,afterId:retired.id}),409),generic);
    assert.doesNotMatch(generic.error,new RegExp(prefix));
    await rejected(await read({pageId}),400);
    await rejected(await read({afterId:first.nextVerifiedRequests.afterId}),400);
    await rejected(await read({pageId,afterId:'invalid'}),400);
    const duplicate=new URLSearchParams({...first.nextVerifiedRequests});
    duplicate.append('afterId',first.nextVerifiedRequests.afterId);
    await rejected(await read(duplicate),400);
    await rejected(await read(first.nextVerifiedRequests,other),403);
    await rejected(await read(first.nextVerifiedRequests,{}),401);
    const published=await request('/availability/'+pageId);
    assert.equal(published.status,200);
    assert.doesNotMatch(await published.text(),new RegExp(prefix));
  }finally{
    await sql`DELETE FROM portable_guest_booking_requests WHERE workspace_id IN ${sql([workspaceId,foreign.id])}
      AND id IN ${sql(seeded.map(({id})=>id))}`;
  }
}
