import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {configuredWebhookDestinations,webhookDestinations} from '../runtime/portable-webhook-config.ts';

test('the settings list shows only operator names assigned to that workspace',t=>{
  const key='HARBOR_WEBHOOK_DESTINATIONS',previous=process.env[key];
  t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
  const ws=randomUUID(),other=randomUUID(),secret='test-signing-secret-'.repeat(3);
  const endpoint={workspaceId:ws,name:'Accounting',url:'https://accounting.example.test/incoming',secret};
  process.env[key]=JSON.stringify([endpoint,{...endpoint,name:'Marketing',workspaceId:other}]);
  assert.deepEqual(configuredWebhookDestinations(ws),['Accounting']);
  assert.deepEqual(configuredWebhookDestinations(other),['Marketing']);
  for(const destinations of [[endpoint,endpoint],[{...endpoint,url:'http://receiver.example.test'}],
    [{...endpoint,url:'https://username:password@receiver.example.test'}],[{...endpoint,url:'https://receiver.example.test/#fragment'}],
    [{...endpoint,secret:'short'}],[{...endpoint,name:' new line\n'}]]){
    process.env[key]=JSON.stringify(destinations);
    assert.throws(()=>configuredWebhookDestinations(ws),error=>error.message.startsWith('Invalid HARBOR_WEBHOOK_DESTINATIONS')&&
      !error.message.includes(secret)&&!error.message.includes('https://'));
  }
  process.env[key]=JSON.stringify([{workspaceId:ws,name:'Accounting'}]);
  assert.deepEqual(configuredWebhookDestinations(ws),['Accounting']);
  assert.throws(()=>webhookDestinations(),/Workers also require/);
  delete process.env[key];
  assert.deepEqual(configuredWebhookDestinations(ws),[]);
});
