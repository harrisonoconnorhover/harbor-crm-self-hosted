import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {parseDocument} from 'htmlparser2';

const bundle=await build({entryPoints:[fileURLToPath(new URL('../lib/harbor-email-design.ts',import.meta.url))],
  bundle:true,platform:'browser',target:'es2022',format:'esm',write:false});
const {createHarborEmailBlock,createHarborEmailProject,harborEmailProjectSchema,harborEmailLimits,
  parseSavedHarborEmail,renderHarborEmail}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const project=(blocks,changes={})=>({...createHarborEmailProject('blank'),blocks,...changes});
const make=(type,data={})=>({...createHarborEmailBlock(type),...data});

test('all starter designs save and reopen deterministically, with stable editable block IDs',()=>{
  for(const template of ['blank','newsletter','announcement']){
    const design=createHarborEmailProject(template),saved=JSON.stringify(design);
    assert.equal(new Set(design.blocks.map(b=>b.id)).size,design.blocks.length);
    assert.ok(design.blocks.length>0);
    const reopened=parseSavedHarborEmail(saved);
    assert.deepEqual(reopened,design);
    assert.equal(JSON.stringify(reopened),saved);
    assert.deepEqual(renderHarborEmail(reopened),renderHarborEmail(design));
    const output=renderHarborEmail(reopened);
    assert.ok(output.plainText.trim());
    assert.ok(Buffer.byteLength(output.html)<harborEmailLimits.htmlBytes);
    assert.equal(output.html.includes('href='),false);
    assert.equal(output.html.includes('src='),false);
    assert.match(output.html,/role="presentation"/);
    assert.match(output.html,/max-width:600px/);
  }
  for(const value of ['{"page":{}}','{',JSON.stringify({...createHarborEmailProject('blank'),version:2})]){
    assert.equal(parseSavedHarborEmail(value),null);
  }
});

test('editable content remains text, links are safe, and the plain alternative preserves paragraphs and button destinations',()=>{
  const design=project([
    make('heading',{text:'Revenue & retention <Q4>'}),make('paragraph',{text:'A <script> alert.\r\n第二段 🪴'}),
    make('image',{url:'https://images.example.com/mail.jpg?x=1&y=2',alt:'A chart labelled "Revenue & growth"'}),
    make('button',{url:'https://shop.example.com/deals?q=a&sort=b#details',label:'See <details>'}),make('divider'),
    make('heading',{text:'Your next steps'}),
  ],{preheader:'What’s new <this week>'});
  const {html,plainText}=renderHarborEmail(design);
  assert.match(html,/&lt;script&gt;/);assert.match(html,/What’s new &lt;this week&gt;/);
  assert.match(html,/sort=b#details/);assert.match(html,/x=1&amp;y=2/);
  const all=[];
  const walk=items=>{for(const node of items){if(node.name)all.push(node);if(node.children)walk(node.children);}};
  walk(parseDocument(html).children);
  assert.ok(!all.some(n=>['script','form','iframe','style'].includes(n.name)));
  assert.deepEqual(all.filter(n=>n.name==='img').map(n=>n.attribs.alt),['A chart labelled "Revenue & growth"']);
  assert.deepEqual(all.filter(n=>n.name==='a').map(n=>n.attribs.href),['https://shop.example.com/deals?q=a&sort=b#details']);
  assert.deepEqual(all.filter(n=>/^h[1-6]$/.test(n.name)).map(n=>n.name),['h1','h2']);
  assert.equal(plainText,'What’s new <this week>\n\nRevenue & retention <Q4>\n\nA <script> alert.\n第二段 🪴\n\nA chart labelled "Revenue & growth"\n\nSee <details>\nhttps://shop.example.com/deals?q=a&sort=b#details\n\n---\n\nYour next steps');
  assert.equal(html.includes('unsubscribe'),false);
});

test('color and URL boundaries, unknown blocks and duplicate IDs are checked before either output is produced',()=>{
  const filled=make('button',{url:'https://news.example.com',label:'Open story'});
  for(const [accent,ink] of [['#ffffff','#000000'],['#000000','#ffffff'],['#777777','#000000']]){
    assert.match(renderHarborEmail(project([filled],{accent})).html,new RegExp('background-color:'+accent+';color:'+ink));
  }
  assert.throws(()=>renderHarborEmail(project([filled,filled])),/own ID/);
  assert.equal(harborEmailProjectSchema.safeParse(project([filled],{accent:'red;'})).success,false);
  assert.throws(()=>renderHarborEmail(project([make('image')])),/image description|HTTPS/);
  for(const url of ['http://news.example.com','https://name:pass@news.example.com','data:text/plain,hi','javascript:void(0)',
    'https://127.0.0.1','https://host.internal/file','/relative']){
    for(const block of [make('image',{alt:'Image',url}),make('button',{url})]){
      assert.throws(()=>renderHarborEmail(project([block])),/public HTTPS/);
    }
  }
  assert.equal(harborEmailProjectSchema.safeParse(project([{id:crypto.randomUUID(),type:'html',html:'<b>raw</b>'}])).success,false);
  assert.equal(harborEmailProjectSchema.safeParse(project([{...filled,html:'raw'}])).success,false);
  assert.equal(harborEmailProjectSchema.safeParse(project([])).success,false);
});

test('both the schema and renderer reject excess UTF-8 bytes even when strings fit their character limits',()=>{
  const blocks=Array.from({length:3},()=>make('paragraph',{text:'語'.repeat(7500)}));
  const tooLarge=project(blocks);
  assert.throws(()=>harborEmailProjectSchema.parse(tooLarge),/64 KiB/);
  assert.throws(()=>renderHarborEmail(tooLarge),/64 KiB/);
  assert.equal(parseSavedHarborEmail(JSON.stringify(tooLarge)),null);
  const output=renderHarborEmail(project(blocks.slice(0,2)));
  assert.ok(Buffer.byteLength(output.plainText)<=harborEmailLimits.plainTextBytes);
  assert.equal(parseSavedHarborEmail(' '.repeat(harborEmailLimits.projectBytes+1)),null);
});
