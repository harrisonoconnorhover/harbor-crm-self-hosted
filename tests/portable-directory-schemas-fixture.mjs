import assert from 'node:assert/strict';

export async function verifyDirectorySchemas(request,directoryToken,recordToken){
  const path='/scim/v2/Schemas',prefix='urn:ietf:params:scim:schemas:core:2.0:';
  const fetchSchema=(suffix='',token=directoryToken,method='GET')=>request(path+suffix,{method,
    headers:token?{authorization:'Bearer '+token}:{}});
  const read=async(pending,status)=>{
    const response=await pending;
    assert.equal(response.status,status);
    assert.match(response.headers.get('cache-control'),/no-store/);
    assert.match(response.headers.get('content-type'),/^application\/scim\+json/);
    return response.json();
  };
  await read(fetchSchema('',null),401);
  await read(fetchSchema('',recordToken),403);
  const list=await read(fetchSchema('?startIndex=2&count=1'),200);
  assert.deepEqual(list.schemas,['urn:ietf:params:scim:api:messages:2.0:ListResponse']);
  assert.deepEqual([list.totalResults,list.startIndex,list.itemsPerPage],[2,1,2]);
  assert.deepEqual(list.Resources.map(row=>row.name),['User','Group']);
  for(const resource of list.Resources){
    assert.deepEqual(resource.schemas,[prefix+'Schema']);
    assert.equal(resource.id,prefix+resource.name);
    assert.equal(resource.meta.resourceType,'Schema');
    assert.equal(new URL(resource.meta.location).pathname,path+'/'+resource.id);
    assert.deepEqual(await read(fetchSchema('/'+encodeURIComponent(resource.id)),200),resource);
    const fields=Object.fromEntries(resource.attributes.map(attr=>[attr.name,attr]));
    assert.equal(fields.id.mutability,'readOnly');
    assert.equal(fields.externalId.mutability,'immutable');
    if(resource.name==='User'){
      assert.equal(fields.userName.required,true);
      assert.equal(fields.active.type,'boolean');
      assert.deepEqual(fields.roles.subAttributes[0].canonicalValues,['viewer','editor']);
      assert.equal(fields.groups.mutability,'readOnly');
      assert.deepEqual(fields.groups.subAttributes.find(attr=>attr.name==='$ref').referenceTypes,['Group']);
      assert.equal(fields.displayName.mutability,'readWrite');
      assert.equal(fields.emails,undefined);
    }else{
      assert.equal(fields.displayName.required,true);
      assert.equal(fields.displayName.uniqueness,'server');
      assert.deepEqual(fields.members.subAttributes.find(attr=>attr.name==='$ref').referenceTypes,['User']);
    }
  }
  await read(fetchSchema('/'+prefix+'Device'),404);
  await read(fetchSchema('?filter=id'),403);
  await read(fetchSchema('',directoryToken,'POST'),405);
}
