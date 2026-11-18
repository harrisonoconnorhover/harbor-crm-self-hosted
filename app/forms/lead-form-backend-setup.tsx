'use client';

const example=JSON.stringify({
 id:'REPLACE_WITH_INQUIRY_UUID',
 payload:{name:'Fictional visitor',email:'visitor@example.test',message:'Please contact me about a trial.'},
},null,2);

export function LeadFormBackendSetup({formId,origin,enabled,apiAccessHref}:{
 formId:string;origin:string;enabled:boolean;apiAccessHref:string;
}){
 const endpoint=new URL('/api/v1/forms/'+encodeURIComponent(formId)+'/inquiries',origin).href;
 return <details>
  <summary>Connect a website backend</summary>
  {!enabled&&<p>Enable this form when you’re ready to accept inquiries. Enabling it also opens its public form page.</p>}
  <p>Create a <strong>Form inquiries</strong> token in <a href={apiAccessHref}>API access</a>. Keep it on your website’s server. The token can submit to enabled inbox-only forms in this workspace.</p>
  <label className="form-field">POST endpoint<input readOnly value={endpoint} onFocus={event=>event.currentTarget.select()}/></label>
  <p>Send <code>Authorization: Bearer &lt;token&gt;</code> and <code>Content-Type: application/json</code>.</p>
  <label className="form-field">Example JSON<textarea readOnly rows={8} value={example} onFocus={event=>event.currentTarget.select()}/></label>
  <p>Generate a UUID for each inquiry. If a request fails before you get a confirmation, retry with the same UUID and payload. Accepted inquiries appear in this form’s inbox.</p>
 </details>;
}
