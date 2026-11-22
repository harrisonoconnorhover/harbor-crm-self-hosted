import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

const lib=new URL('../lib/',import.meta.url).href;
registerHooks({resolve(specifier,context,next){
  const local=context.parentURL?.startsWith(lib)&&specifier.startsWith('.')&&!/\.[a-z]+$/.test(specifier);
  return next(local?specifier+'.ts':specifier,context);
}});
const {preparePortableOutreach}=await import('../lib/portable-contact-activities.ts');

test('a Now note takes the first submission time and retries the same request',t=>{
  let clock=Date.UTC(2026,9,15,14,35,27,321);
  t.mock.method(Date,'now',()=>clock);
  const first=preparePortableOutreach('Note','Quarterly review','now');
  assert.equal(first.input.occurredAt,clock);
  clock+=125_000;
  const retry=preparePortableOutreach('Note','Quarterly review','now',first);
  assert.deepEqual(retry.input,first.input);
  const changed=preparePortableOutreach('Note','Revised summary','now',first);
  assert.notEqual(changed.input.id,first.input.id);
  assert.equal(changed.input.occurredAt,clock);
});

test('backdating preserves the chosen instant and distinguishes a changed time or mode',()=>{
  const when=Date.UTC(2026,7,1,11,20);
  const first=preparePortableOutreach('Note','Quarterly review',when);
  assert.equal(first.input.occurredAt,when);
  assert.deepEqual(preparePortableOutreach('Note','Quarterly review',when,first).input,first.input);
  const changed=preparePortableOutreach('Note','Quarterly review',when-60_000,first);
  assert.notEqual(changed.input.id,first.input.id);
  assert.equal(changed.input.occurredAt,when-60_000);
  assert.notEqual(preparePortableOutreach('Note','Quarterly review','now',first).input.id,first.input.id);
});
