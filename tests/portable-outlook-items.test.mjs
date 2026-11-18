import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const code=await build({entryPoints:[fileURLToPath(new URL('../runtime/portable-outlook-items.ts',import.meta.url))],
  bundle:true,platform:'node',format:'esm',write:false});
const {readOutlookItems}=await import('data:text/javascript;base64,'+Buffer.from(code.outputFiles[0].contents).toString('base64'));
const range={start:Date.UTC(2026,10,2),end:Date.UTC(2026,10,3)},owner='owner@example.test';
const search=(contact,assertCurrent,fetcher)=>readOutlookItems('outlook-mail','fixture-access',contact,owner,range,
  AbortSignal.timeout(3000),assertCurrent,fetcher);
const nextPage=(url,number)=>{const next=new URL(url);next.searchParams.set('$skiptoken','opaque='+number);return next.href;};

test('Graph lookup checks authority on each bounded page and safely quotes an apostrophe in a contact address',async()=>{
  let calls=0,checks=0;
  const page=await search("o'connor@example.test",async()=>{checks++;},async(url,options)=>{
    assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(url.origin,'https://graph.microsoft.com');
    assert.match(url.searchParams.get('$filter'),/from\/emailAddress\/address eq 'o''connor@example\.test'$/);
    assert.equal(++calls,checks);
    if(calls>1)assert.equal(url.searchParams.get('$skiptoken'),'opaque='+(calls-1));
    return Response.json({value:[],'@odata.nextLink':nextPage(url,calls)});
  });
  assert.equal(calls,3);assert.deepEqual(page,{items:[],limited:true});
});
test('a revoked connection does not request the next page; an oversized response never becomes a partial search result',async()=>{
  let checks=0,calls=0;
  await assert.rejects(search('contact@example.test',async()=>{if(++checks===2)throw Error('revoked');},async url=>{
    calls++;return Response.json({value:[],'@odata.nextLink':nextPage(url,1)});
  }),/revoked/);assert.equal(calls,1);
  await assert.rejects(search('contact@example.test',async()=>{},async()=>new Response('x'.repeat(525000))),/too large/);
});
