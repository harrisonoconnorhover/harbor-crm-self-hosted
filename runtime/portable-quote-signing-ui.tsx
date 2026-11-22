'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import type {PortableQuoteDetail} from '../lib/portable-quotes';

export function QuoteSigning({detail,canIssue}:{detail:PortableQuoteDetail;canIssue:boolean}){
  const {quote,signature}=detail,router=useRouter();
  const [link,setLink]=useState('');
  const [pending,setPending]=useState(false),[message,setMessage]=useState('');
  async function change(issue:boolean){
    setPending(true);setMessage('');
    try{
      const response=await fetch('/api/quotes',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:issue?'issue-signing-link':'revoke-signing-link',id:quote.id,revision:quote.revision,
          version:quote.version,expectedLink:detail.signingLinkId})});
      const result=await response.json() as {token?:string;error?:string};
      if(!response.ok)throw Error(result.error??'Could not change the signing link.');
      setLink(result.token?location.origin+'/quote-sign#'+result.token:'');
      setMessage(issue?'Signing link ready.':'Signing link revoked.');
      router.refresh();
    }catch(error){setMessage(error instanceof Error?error.message:'Reload to check the signing link.');}
    finally{setPending(false);}
  }
  return <section aria-label="Buyer signature"><h3>Buyer signature</h3>
    {signature&&<p>Signed by <strong>{signature.signedName}</strong> · {new Date(signature.signedAt).toLocaleString()}. The downloaded quote includes the signature receipt.</p>}
    {canIssue&&<><p>Share the link privately with the buyer. Anyone who has it can review and sign this version.</p>
      <button type="button" disabled={pending} onClick={()=>void change(true)}>{detail.signingLinkId?'Replace signing link':'Create signing link'}</button></>}
    {detail.signingLinkId&&<button type="button" disabled={pending} onClick={()=>void change(false)}>Revoke signing link</button>}
    {link&&<label>Private signing link<input readOnly value={link} onFocus={e=>e.target.select()}/></label>}
    <p role="status">{message}</p>
  </section>;
}
