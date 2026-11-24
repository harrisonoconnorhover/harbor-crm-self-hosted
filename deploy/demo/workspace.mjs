import {randomUUID} from 'node:crypto';

export async function seedDemo(origin, roles, session) {
  const headers = {origin, cookie: 'harbor-session=' + await session(roles.manager)};
  async function write(path, body, extras) {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: {...headers, ...(extras || {'content-type':'application/json'})},
      body: extras ? body : JSON.stringify(body),
    });
    if (!response.ok) throw Error('Demo workspace setup failed at ' + path.split('?')[0] + ': ' + response.status + ' ' + await response.text());
    return response.json();
  }
  const create = async (kind, data, links = {}) => (await write('/api/crm', {action:'save', kind, data, ...links})).record;
  const company = await create('companies', {name:'North Pier Coffee', domain:'north-pier.example.test'});
  const buyer = await create('contacts', {name:'Avery Linden', email:'avery@north-pier.example.test'}, {primaryCompanyId:company.id});
  let sharing = await write('/api/workspaces', {action:'grant', email:roles.rep.email});
  for (const permission of [{action:'role', role:'editor'}, {action:'contact_files', enabled:true}, {action:'record_activities', enabled:true}]) {
    const member = sharing.viewers.find(row => row.email === roles.rep.email);
    sharing = await write('/api/workspaces', {...permission, id:member.id});
  }
  const deal = await create('deals', {name:'North Pier spring order', amount:12000, stage:'Qualified to buy'},
    {primaryContactId:buyer.id, companyId:company.id, assigneeId:roles.rep.id});
  await create('deals', {name:'North Pier equipment renewal', amount:4800, stage:'Appointment scheduled'}, {companyId:company.id,assigneeId:roles.rep.id});
  await write('/api/logged-activities?' + new URLSearchParams({kind:'deals', recordId:deal.id}), {
    id:randomUUID(), kind:'Note', occurredAt:Date.now() - 600_000,
    summary:'Avery confirmed the spring order and asked Alex to send the delivery window. The order brief is on Avery’s contact record.',
  });
  await create('tasks', {name:'Confirm the delivery window with Avery', dueDate:new Date().toISOString().slice(0,10)},
    {related:{kind:'deals', id:deal.id}, assigneeId:roles.rep.id});
  await write('/api/record-attachments?' + new URLSearchParams({recordId:buyer.id, fileId:randomUUID(), versionId:randomUUID()}),
    'North Pier Coffee\nSpring order · $12,000\nContact: Avery Linden\nNext step: confirm the delivery window.\n',
    {'x-harbor-file-name':'North Pier order brief.txt'});
  return sharing.owned;
}
