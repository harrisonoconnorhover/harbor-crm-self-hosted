import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {inflateRawSync} from 'node:zlib';

const require=createRequire(import.meta.url);
const {SignedXml}=createRequire(require.resolve('@node-saml/node-saml'))('xml-crypto');
const saml='urn:oasis:names:tc:SAML:2.0:assertion',protocol='urn:oasis:names:tc:SAML:2.0:protocol';
const c14n='http://www.w3.org/2001/10/xml-exc-c14n#';
const escaped=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');

// Both signatures use the disposable key created by the loopback fixture runner.
function sign(xml,element,key,hasIssuer=true){
  const xpath="/*[local-name()='"+element+"']";
  const signer=new SignedXml({privateKey:key,canonicalizationAlgorithm:c14n,
    signatureAlgorithm:'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'});
  signer.addReference({xpath,transforms:['http://www.w3.org/2000/09/xmldsig#enveloped-signature',c14n],
    digestAlgorithm:'http://www.w3.org/2001/04/xmlenc#sha256'});
  signer.computeSignature(xml,{location:hasIssuer?{reference:xpath+"/*[local-name()='Issuer']",action:'after'}:{reference:xpath,action:'prepend'}});
  return signer.getSignedXml();
}

export async function samlProvider({origin,issuer,ownerNameId,key}){
  const audience=origin+'/auth/saml/metadata',callback=origin+'/auth/saml/callback';
  function responseFor(location,nameId=ownerNameId,{assertionIssuer=issuer,responseIssuer=issuer,responseDestination=callback,signResponse=true}={}){
    const redirect=new URL(location);
    const request=inflateRawSync(Buffer.from(redirect.searchParams.get('SAMLRequest'),'base64')).toString();
    assert.ok(request.includes(audience));
    assert.ok(request.includes('AssertionConsumerServiceURL="'+callback+'"'));
    const requestId=request.match(/<(?:[\w.-]+:)?AuthnRequest\s[^>]*?\bID="([^"]+)"/)?.[1];
    assert.ok(requestId,'Expected a request ID in Harbor’s AuthnRequest');
    const relay=redirect.searchParams.get('RelayState');
    assert.ok(relay);
    const issued=new Date().toISOString(),from=new Date(Date.now()-30000).toISOString(),until=new Date(Date.now()+120000).toISOString();
    const assertion=sign(`<saml:Assertion xmlns:saml="${saml}" Version="2.0" ID="_${randomUUID()}" IssueInstant="${issued}">
 <saml:Issuer>${escaped(assertionIssuer)}</saml:Issuer>
 <saml:Subject>
  <saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${escaped(nameId)}</saml:NameID>
  <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${escaped(requestId)}" Recipient="${callback}" NotOnOrAfter="${until}"/></saml:SubjectConfirmation>
 </saml:Subject>
 <saml:Conditions NotBefore="${from}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
 <saml:AuthnStatement AuthnInstant="${issued}" SessionIndex="_${randomUUID()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>
</saml:Assertion>`,'Assertion',key);
    const envelope=`<samlp:Response xmlns:samlp="${protocol}" Version="2.0" ID="_${randomUUID()}" IssueInstant="${issued}" Destination="${escaped(responseDestination)}" InResponseTo="${escaped(requestId)}">
 ${responseIssuer==null?'':'<saml:Issuer xmlns:saml="'+saml+'">'+escaped(responseIssuer)+'</saml:Issuer>'}
 <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
 ${assertion}
</samlp:Response>`;
    const response=signResponse?sign(envelope,'Response',key,responseIssuer!=null):envelope;
    return new URLSearchParams({RelayState:relay,SAMLResponse:Buffer.from(response).toString('base64')});
  }
  const server=createServer((req,res)=>{
    try{
      const url=new URL(req.url,entryPoint);
      if(url.pathname!=='/sso'){res.writeHead(404).end();return;}
      const body=responseFor(url);
      res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});
      res.end('<form method="post" action="'+callback+'">'+Array.from(body,([name,value])=>'<input type="hidden" name="'+name+'" value="'+escaped(value)+'">').join('')+'<button>Continue as fictional operator</button></form>');
    }catch{
      res.writeHead(400).end('The local identity provider could not read the request.');
    }
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  // Distinct loopback hostnames exercise the browser’s cross-site form post.
  const entryPoint='http://localhost:'+server.address().port+'/sso';
  return {entryPoint,responseFor,useSigningKey(replacement){key=replacement;},close:()=>new Promise(resolve=>server.close(resolve))};
}
