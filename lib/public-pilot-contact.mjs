const emailAddress=/^[a-z0-9][a-z0-9._+-]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export function publicPilotContact(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||
    typeof input.name!=='string'||typeof input.email!=='string')return null;
  const name=input.name.trim(),email=input.email.trim();
  if(!name||name.length>100||/[<>\p{Cc}]/u.test(name)||email.length>254||!emailAddress.test(email))return null;
  return {name,email};
}

export function readPublicPilotContact(value){
  if(typeof value!=='string'||!value||value.length>1024)return null;
  try{return publicPilotContact(JSON.parse(value));}catch{return null;}
}
