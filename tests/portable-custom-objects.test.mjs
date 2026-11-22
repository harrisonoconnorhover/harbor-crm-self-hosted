import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {objectDefinition,objectValues,validateDefinitionChange} from '../lib/portable-custom-objects.ts';

const field=(label,type,required=false,options=[])=>({id:randomUUID(),label,type,required,options});

test('Partial record edits preserve zero and false and distinguish clearing a field from omitting it',()=>{
  const amount=field('Amount','number',true),autoRenew=field('Auto-renew','checkbox',true),tags=field('Regions','multiselect',false,['East','West']);
  const definition=objectDefinition.parse({name:'Subscriptions',fields:[amount,autoRenew,tags]});
  const initial=objectValues(definition,{[amount.id]:0,[autoRenew.id]:false,[tags.id]:['west','east']});
  assert.deepEqual(initial[tags.id],['East','West']);
  assert.deepEqual(objectValues(definition,{[tags.id]:null},initial),{[amount.id]:0,[autoRenew.id]:false});
  assert.throws(()=>objectValues(definition,{[amount.id]:null},initial),/Amount is required/);
  assert.throws(()=>objectValues(definition,{[tags.id]:['North']},initial),/Regions/);
});

test('Schema edits retain field IDs and saved choices after a label is renamed',()=>{
  const plan=field('Plan','select',false,['Standard']);
  const before=objectDefinition.parse({name:'Contracts',fields:[plan]});
  const after={...before,fields:[{...plan,label:'Service level',options:['Standard','Plus']}]};
  assert.doesNotThrow(()=>validateDefinitionChange(before,after,true));
  assert.throws(()=>validateDefinitionChange(after,before,true),/choices/);
  assert.throws(()=>validateDefinitionChange(before,{...before,fields:[{...plan,id:randomUUID()}]},true),/properties/);
  assert.equal(objectDefinition.safeParse({...before,fields:[plan,{...plan,id:randomUUID(),label:'plan'}]}).success,false);
});
