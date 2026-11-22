import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {authorizeIncoming,configuredInbox,deliverInboxReply,parseInbound} from '../runtime/portable-team-inbox-provider.ts';

test('The inbound envelope determines the workspace and customer HTML becomes plain text',t=>{
  const workspaceId=randomUUID(),other=randomUUID();
  const destination={workspaceId,mailbox:'support@example.test',inbound:'private@inbound.example.test'};
  const key='HARBOR_TEAM_INBOX_ROUTES',oldRoutes=process.env[key],oldSecret=process.env.HARBOR_TEAM_INBOX_SECRET;
  t.after(()=>{
    if(oldRoutes===undefined)delete process.env[key];else process.env[key]=oldRoutes;
    if(oldSecret===undefined)delete process.env.HARBOR_TEAM_INBOX_SECRET;else process.env.HARBOR_TEAM_INBOX_SECRET=oldSecret;
  });
  process.env[key]=JSON.stringify([destination]);process.env.HARBOR_TEAM_INBOX_SECRET='x'.repeat(32);
  const payload={OriginalRecipient:destination.inbound,To:'another@example.test',workspaceId:other,
    Subject:'Broken scanner\r\nBcc: injected',MessageID:'inbound-41',FromFull:{Email:'customer@example.test'},
    HtmlBody:'<p>Reader offline.</p><script>no()</script>',Attachments:[{}],
    Headers:[{Name:'Message-ID',Value:'<original@example.test>'},{Name:'In-Reply-To',Value:'<unsafe id> <previous@example.test>'}]};
  assert.throws(()=>authorizeIncoming(null));authorizeIncoming('Basic '+Buffer.from('harbor:'+'x'.repeat(32)).toString('base64'));
  const message=parseInbound(payload);
  assert.equal(message.workspaceId,workspaceId);assert.equal(message.subject,'Broken scanner Bcc: injected');
  assert.match(message.body,/Reader offline\./);assert.doesNotMatch(message.body,/no\(\)|<p>/);
  assert.deepEqual(message.references,['<previous@example.test>']);
  assert.equal(configuredInbox(other,destination.mailbox),undefined);
  assert.throws(()=>parseInbound({...payload,OriginalRecipient:'unknown@example.test'}));
  process.env[key]=JSON.stringify([destination,{...destination,workspaceId:other}]);
  assert.throws(()=>parseInbound(payload),/configuration/);
});

test('Only an explicit provider receipt settles a send as accepted or refused',async()=>{
  const reply={replyId:randomUUID(),sender:'customer@example.test',mailbox:'support@example.test',subject:'Hi',internetId:'<out@example.test>',inReplyTo:null};
  for(const [status,response,expected] of [[200,{ErrorCode:0,MessageID:'receipt'},'sent'],[200,{},'uncertain'],
    [422,{ErrorCode:300},'failed'],[503,{ErrorCode:500},'uncertain'],[422,{ErrorCode:0},'uncertain']]){
    const result=await deliverInboxReply('test',reply,'Yes',async()=>Response.json(response,{status}));
    assert.equal(result.state,expected);
  }
});
