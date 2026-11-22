import {X509Certificate} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {DOMParser} from '@xmldom/xmldom';
import type {SamlLoginConfig} from './portable-saml-config';

const metadata='urn:oasis:names:tc:SAML:2.0:metadata';
const protocol='urn:oasis:names:tc:SAML:2.0:protocol';
const redirect='urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const signature='http://www.w3.org/2000/09/xmldsig#';

function elements(parent:Element,namespace:string,name:string){
  return Array.from(parent.getElementsByTagNameNS(namespace,name)).filter(child=>child.parentNode===parent);
}

export function compareSamlMetadata(xml:string,config:Pick<SamlLoginConfig,'issuer'|'entryPoint'|'certificates'>){
  try{
    if(/<!DOCTYPE\b/i.test(xml))return {status:'invalid_metadata'};
    const document=new DOMParser({errorHandler:()=>{throw Error();}}).parseFromString(xml,'application/xml');
    const entity=document.documentElement;
    if(entity?.namespaceURI!==metadata||entity.localName!=='EntityDescriptor')return {status:'expected_provider_entity'};
    if(entity.getAttribute('entityID')!==config.issuer)return {status:'issuer_mismatch'};
    const roles=elements(entity,metadata,'IDPSSODescriptor').filter(role=>
      role.getAttribute('protocolSupportEnumeration')?.split(/\s+/).includes(protocol));
    if(roles.length!==1)return {status:'expected_saml2_provider_role'};
    const role=roles[0];
    const matchesAddress=elements(role,metadata,'SingleSignOnService').some(service=>
      service.getAttribute('Binding')===redirect&&URL.parse(service.getAttribute('Location')??'')?.href===config.entryPoint);
    if(!matchesAddress)return {status:'redirect_mismatch'};
    const published=new Set<string>();
    for(const key of elements(role,metadata,'KeyDescriptor')){
      if(key.hasAttribute('use')&&key.getAttribute('use')!=='signing')continue;
      const certificates=elements(key,signature,'KeyInfo').flatMap(info=>elements(info,signature,'X509Data'))
        .flatMap(data=>elements(data,signature,'X509Certificate'));
      // A chain or key reference does not unambiguously identify a single signing certificate.
      if(certificates.length!==1)return {status:'unsupported_signing_key'};
      const encoded=(certificates[0].textContent??'').replace(/\s/g,'');
      if(!encoded||!/^[A-Za-z0-9+/]+=*$/.test(encoded))return {status:'invalid_metadata'};
      published.add(new X509Certificate(Buffer.from(encoded,'base64')).fingerprint256);
    }
    if(!published.size)return {status:'no_signing_certificate'};
    const configured=new Set(config.certificates.map(cert=>cert.fingerprint256));
    const providerOnly=[...published].filter(key=>!configured.has(key));
    const harborOnly=[...configured].filter(key=>!published.has(key));
    const status=providerOnly.length===published.size?'no_matching_certificate':
      providerOnly.length?'provider_certificate_missing':'ok';
    return {status,providerOnly,harborOnly};
  }catch{return {status:'invalid_metadata'};}
}

export async function checkSamlMetadataFile(path:string,config:SamlLoginConfig|undefined){
  if(!config)return {status:'configure_saml_first'};
  try{
    const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
    try{
      const stat=await file.stat();
      if(!stat.isFile()||stat.size>1024*1024)return {status:'expected_metadata_file_under_1mib'};
      return compareSamlMetadata(await file.readFile('utf8'),config);
    }finally{await file.close();}
  }catch{return {status:'metadata_file_unreadable'};}
}
