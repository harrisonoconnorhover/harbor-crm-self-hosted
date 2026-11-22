import assert from 'node:assert/strict';
import test from 'node:test';
import {landingDomains} from '../runtime/portable-config.mjs';
import {landingDocument} from '../lib/landing-document.ts';
import {landingDraft} from '../lib/portable-landing.ts';

const workspace='11111111-1111-4111-8111-111111111111';
const origin='https://crm.example.test',custom='https://events.example.test';
const settings=overrides=>({HARBOR_LOGIN_ORIGIN:origin,HARBOR_PORTABLE_MODE:'hosted',
  HARBOR_LANDING_DOMAINS:JSON.stringify(overrides)});
test('Custom domains accept distinct exact origins with an explicit workspace',()=>{
  assert.deepEqual([...landingDomains(settings({[custom]:workspace}))],[[custom,workspace]]);
  for(const key of [origin,'http://events.example.test',custom+'/events','https://a@events.example.test',custom+'?open=1'])
    assert.throws(()=>landingDomains(settings({[key]:workspace})));
  assert.throws(()=>landingDomains(settings({[custom]:'missing-workspace'})));
});
test('Public pages render user text as literal content and preview keeps form buttons inactive',()=>{
  const text='<b>Ask "Harbor" & friends</b>';
  const page=landingDraft.parse({title:text,description:text,slug:'field-day',accent:'#36705a',
    blocks:[{type:'text',id:workspace,text},{type:'form',id:crypto.randomUUID(),label:'Register',formId:workspace}]});
  const html=landingDocument(page,origin);
  assert.doesNotMatch(html,/<b>/);
  assert.match(html,/&lt;b&gt;Ask &quot;Harbor&quot; &amp; friends/);
  assert.ok(html.includes('href="'+origin+'/forms/'+workspace+'"'));
  assert.ok(!landingDocument(page,origin,true).includes('href='));
  const journey={siteId:workspace,path:'/field-day'};
  const tracked=landingDocument(page,origin,false,journey);
  assert.ok(tracked.includes('src="'+origin+'/journey.js"')&&tracked.includes('data-paths="/field-day"'));
  assert.ok(tracked.includes('Allow visit measurement'));
  assert.doesNotMatch(html+landingDocument(page,origin,true,journey),/<script|data-journey-consent/);
  for(const slug of ['a/b','../test','with space','MyPage','a'.repeat(73)])assert.ok(!landingDraft.safeParse({...page,slug}).success);
  assert.ok(!landingDraft.safeParse({...page,blocks:[page.blocks[0],page.blocks[0]]}).success);
});

test('Two-column pages require copy on both sides and render each field as text',()=>{
  const section={id:workspace,type:'columns',left:{heading:'',text:'Morning <details>'},
    right:{heading:'Q&A',text:'Questions > slides'}};
  const draft={title:'Sessions',slug:'sessions',description:'',accent:'#17696b',blocks:[section]};
  const html=landingDocument(landingDraft.parse(draft),origin);
  assert.ok(html.includes('<div><p>Morning &lt;details&gt;</p></div><div><h2>Q&amp;A</h2><p>Questions &gt; slides</p></div>'));
  assert.equal(landingDraft.safeParse({...draft,blocks:[{...section,left:{heading:'Title only',text:'  '}}]}).success,false);
});

test('Call-to-action buttons require a secure destination or an existing content section',()=>{
  const heading={type:'heading',id:workspace,text:'Demo schedule'};
  const button={type:'button',id:crypto.randomUUID(),label:'View schedule',target:{sectionId:heading.id}};
  const page={title:'Product clinic',slug:'clinic',description:'',accent:'#17696b',blocks:[button,heading]};
  const html=landingDocument(landingDraft.parse(page),origin);
  assert.ok(html.includes('href="#section-'+workspace+'"')&&html.includes('id="section-'+workspace+'"'));
  for(const target of [{sectionId:button.id},{sectionId:crypto.randomUUID()},{url:'relative/path'},
    {url:'http://calendar.example.test/'},{url:'https://person@calendar.example.test/'}]){
    assert.equal(landingDraft.safeParse({...page,blocks:[heading,{...button,target}]}).success,false);
  }
});

test('Search listing overrides are bounded and escaped, with an independent visible heading',()=>{
  const page={title:'Event',slug:'event',description:'Welcome',accent:'#17696b',blocks:[],
    searchTitle:'Q&A <November>',searchDescription:'Say "hello" & learn',excludeFromSearch:true};
  const html=landingDocument(landingDraft.parse(page),origin,false,undefined,custom+'/event');
  assert.ok(html.includes('<title>Q&amp;A &lt;November&gt;</title>'));
  assert.ok(html.includes('name="description" content="Say &quot;hello&quot; &amp; learn"'));
  assert.ok(html.includes('<h1>Event</h1>'));
  assert.ok(!landingDraft.safeParse({...page,searchTitle:'t'.repeat(121)}).success);
  assert.ok(!landingDraft.safeParse({...page,searchDescription:'d'.repeat(301)}).success);
});

test('Landing images require bounded inline JPEG data, dimensions and alt text',()=>{
  const draft={title:'Clinic',slug:'clinic',description:'',accent:'#17696b'};
  // These envelopes exercise storage limits. The browser fixture uploads and decodes real pixels.
  function image(bytes=64){
    const file=Buffer.alloc(bytes);
    file.set([255,216,255],0);file.set([255,217],bytes-2);
    return {type:'image',id:crypto.randomUUID(),jpeg:file.toString('base64'),width:300,height:200,alt:'Clinic <product>',caption:'Doors at 9'};
  }
  const picture=image();
  const valid=blocks=>landingDraft.safeParse({...draft,blocks}).success;
  assert.ok(valid([picture]));
  for(const patch of [{jpeg:'https://images.example.test/item.jpg'},{jpeg:Buffer.from('not a picture').toString('base64')},
    {jpeg:picture.jpeg.slice(0,-8)+'AAAAAAAA'},{alt:'  '},{width:0},{height:1601}])assert.equal(valid([{...picture,...patch}]),false);
  assert.equal(valid([image(150*1024)]),false);
  assert.equal(valid(Array.from({length:4},()=>image(110*1024))),false);
  const doc=landingDocument({...draft,blocks:[picture]},origin);
  assert.ok(doc.includes('alt="Clinic &lt;product&gt;"'));
});
