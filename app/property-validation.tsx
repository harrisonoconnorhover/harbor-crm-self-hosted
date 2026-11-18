"use client";
import {propertyRegexError,propertyRegexLimit,propertyRegexValueLimit} from '@/lib/property-regex';
import {isLinkProperty} from '@/lib/property-links';
import {uniqueNumber} from '@/lib/unique-number';
import {useEffect,useState} from 'react';
import {isTextProperty} from '@/lib/property-text';
import {normalizedValidation,formatPropertyText,propertyValidationError,type ValidationRules} from '@/lib/property-validation';

export function PropertyValidationEditor({type,value,onChange}:{type:string;value:ValidationRules|null;onChange:(v:ValidationRules|null)=>void}){
 if(isLinkProperty(type))return <DomainValidationEditor value={value} onChange={onChange}/>;
 if(!isTextProperty(type)&&type!=='number'&&type!=='date')return null;
 value=normalizedValidation(value);
 const custom=value?.regex!==undefined;
 const controls:{key:'minLength'|'maxLength'|'min'|'max'|'decimals';label:string;min?:number;max?:number;step:string}[]=isTextProperty(type)?[
  {key:'minLength',label:'Minimum characters',min:0,max:65536,step:'1'},
  {key:'maxLength',label:'Maximum characters',min:0,max:65536,step:'1'},
 ]:[{key:'min',label:'Minimum value',step:'any'},{key:'max',label:'Maximum value',step:'any'},{key:'decimals',label:'Maximum decimal places',min:0,max:10,step:'1'}];
 return <fieldset className="property-validation-editor"><legend>Validation rules</legend>
  <p className="form-intro">Optional rules for new or changed values in manual edits, imports and the record API. Existing values stay intact; unrelated edits still work. Empty values are allowed. Workflow actions do not apply these rules.</p>
  {isTextProperty(type)&&!custom&&<p className="form-intro">Spaces and line breaks count. Emoji may count as two characters. Text stays as entered unless you enable automatic removal below.</p>}
  {isTextProperty(type)&&<label className="form-field">Validation method<select value={custom?'custom':'basic'} onChange={e=>onChange(e.target.value==='custom'?{regex:'',regexMessage:'Enter a value matching the required format.'}:null)}><option value="basic">Validate using basic rules</option><option value="custom">Validate using custom rules</option></select></label>}
  {custom?<RegexValidationEditor value={value!} onChange={onChange}/>:<>{type==='date'?<DateValidationEditor value={value} onChange={onChange}/>:<div className="validation-rule-inputs">{controls.map(c=><label className="form-field" key={c.key}>{c.label}<input type="number" min={c.min} max={c.max} step={c.step} value={value?.[c.key]??''} placeholder="No rule" onChange={e=>{const next={...value};if(e.target.value==='')delete next[c.key];else next[c.key]=Number(e.target.value);onChange(Object.keys(next).length?next:null);}}/></label>)}</div>}
  {isTextProperty(type)&&<TextValidationEditor value={value} onChange={onChange}/>}</>}
  {value&&<button type="button" className="text-button" onClick={()=>onChange(null)}>Remove validation rules</button>}
 </fieldset>;
}
function RegexValidationEditor({value,onChange}:{value:ValidationRules;onChange:(v:ValidationRules|null)=>void}){
 const [testValue,setTestValue]=useState('');
 const error=propertyRegexError(value.regex??'');
 const result=error?null:propertyValidationError({label:'Test value',type:'text',validation:value},testValue);
 return <>
  <label className="form-field">Custom rule regex<textarea className="regex-rule-text" rows={2} required maxLength={propertyRegexLimit} value={value.regex??''} onChange={e=>onChange({...value,regex:e.target.value})} placeholder={'^ACCT-[0-9]{5}$'} spellCheck={false}/></label>
  <p className="form-intro">Enter the pattern without enclosing / marks. Matching is case-sensitive; use (?i) for case-insensitive matching. Use ^ and $ to match the entire value, including multi-line text. Without (?m), these anchors refer to the start and end of the whole text. Use (?:...) for groups; backreferences and lookarounds are not supported. Patterns can contain up to {propertyRegexLimit} characters.</p>
  {error&&<small className="property-validation-warning" role="status">{error}</small>}
  <label className="form-field">Invalid value message<input required maxLength={100} value={value.regexMessage??''} onChange={e=>onChange({...value,regexMessage:e.target.value})}/></label>
  <label className="form-field">Additional invalid value help<textarea className="regex-rule-text" rows={2} maxLength={350} value={value.regexHelp??''} onChange={e=>onChange({...value,regexHelp:e.target.value})}/></label>
  <label className="form-field">Test custom rules<textarea className="regex-rule-text" rows={2} value={testValue} onChange={e=>setTestValue(e.target.value)} placeholder="Try a valid or invalid value"/></label>
  <p className={result?'property-validation-warning':'form-intro'} role="status">{error?'Fix the pattern to test a value.':!testValue?'Empty values are allowed.':result||'Valid value — matches your custom rule.'}</p>
  <p className="form-intro">New or changed values are limited to {propertyRegexValueLimit.toLocaleString('en-US')} characters when a custom rule is enabled. The rule validates text; it does not reformat it.</p>
 </>;
}

export function PropertyValidationHint({field,value,saved=false}:{field:{label:string;type:string;uniqueValues?:boolean;validation?:ValidationRules|null;validationTimeZone?:string};value:unknown;saved?:boolean}){
 const formatted=!saved&&typeof value==='string'?formatPropertyText(field,value):value;
 const removedAll=typeof value==='string'&&value!==''&&formatted==='';
 let numericError='',validationValue=formatted;
 if(!saved&&field.uniqueValues&&field.type==='number'&&value!==undefined&&value!==null&&value!==''){try{validationValue=uniqueNumber(String(value));}catch(error){numericError=(error as Error).message;}}
 const message=numericError||(removedAll?`Automatic formatting would remove every character from ${field.label}. Enter an allowed value or clear it explicitly.`:propertyValidationError(field,validationValue,{ignoreRelative:saved}));
 return <>{formatted!==value&&!removedAll&&<small className="form-intro">New or changed value saves as: <span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{String(formatted)}</span></small>}{message&&<small className="property-validation-warning">Doesn’t meet current validation: {message} An unchanged saved value may be kept.</small>}</>;
}

function TextValidationEditor({value,onChange}:{value:ValidationRules|null;onChange:(v:ValidationRules|null)=>void}){
 return <>
  <div className="validation-rule-inputs">
   <label className="form-field">Whitespace<select value={value?.whitespace||'any'} onChange={e=>onChange({...value,whitespace:e.target.value as ValidationRules['whitespace']})}><option value="any">Allow whitespace</option><option value="trim">No leading or trailing whitespace</option><option value="none">No whitespace</option></select></label>
   <label className="form-field">Allowed characters<select value={value?.characters||'any'} onChange={e=>onChange({...value,characters:e.target.value as ValidationRules['characters'],...(e.target.value==='any'?{autoRemove:false}:{})})}><option value="any">All characters</option><option value="numeric">Numbers only</option><option value="alphanumeric">No symbols or special characters</option></select></label>
   <label className="form-field">Letter casing<select value={value?.casing||'any'} onChange={e=>onChange({...value,casing:e.target.value as ValidationRules['casing']})}><option value="any">Any casing</option><option value="upper">Uppercase only</option><option value="lower">Lowercase only</option><option value="title">Title casing</option></select></label>
  </div>
  {value?.characters&&value.characters!=='any'&&<label className="date-rule-weekdays"><input type="checkbox" checked={value.autoRemove||false} onChange={e=>onChange({...value,autoRemove:e.target.checked})}/>Automatically remove disallowed characters and spaces</label>}
  <p className="form-intro">Numbers only keeps digits and number-format characters (. , + -), including leading zeroes; at least one digit is needed. No symbols allows Unicode letters, accents, digits, spaces, line breaks and script join characters. Tabs and other control characters are excluded. Whitespace rules include tabs and line breaks.</p>
  <p className="form-intro">Title casing requires a capital first letter in each word, while preserving names such as McDonald, acronyms such as USA and number-led words such as 3rd. Hyphens start new words. Casing is validated, never changed automatically.</p>
  {value?.autoRemove&&<p className="form-intro">Manual edits and imports remove disallowed characters before checking other rules. Values that would become empty are rejected; clear the field explicitly instead. The record API validates without automatic removal. Existing values and workflow actions stay unchanged.</p>}
 </>;
}

function DateValidationEditor({value,onChange}:{value:ValidationRules|null;onChange:(v:ValidationRules|null)=>void}){
 const [zone,setZone]=useState(''),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();fetch('/api/workspace-settings',{cache:'no-store',signal:controller.signal}).then(async r=>{const j=await r.json() as {settings:{timeZone:string};error?:string};if(!r.ok)throw Error(j.error);setZone(j.settings.timeZone);}).catch(e=>{if(e.name!=='AbortError')setError('Could not load workspace time zone. Reopen this dialog to retry.');});return()=>controller.abort();},[]);
 const mode=value?.dateMode||'any';
 const future=value?.bufferDays!==undefined?'buffer':value?.rollingDays!==undefined?'rolling':'any';
 function changeMode(dateMode:NonNullable<ValidationRules['dateMode']>){onChange({dateMode,...(value?.weekdaysOnly?{weekdaysOnly:true}:{})});}
 return <>
  <label className="form-field">Allowed dates<select value={mode} onChange={e=>changeMode(e.target.value as NonNullable<ValidationRules['dateMode']>)}><option value="any">Any date</option><option value="future">Future dates only</option><option value="past">Past dates only</option><option value="range">Specific date range</option></select></label>
  {mode==='future'&&<><label className="form-field">Allowed future dates<select value={future} onChange={e=>{const next={...value};delete next.bufferDays;delete next.rollingDays;if(e.target.value==='buffer')next.bufferDays=0;if(e.target.value==='rolling')next.rollingDays=30;onChange(next);}}><option value="any">Any future date</option><option value="buffer">After buffer time</option><option value="rolling">Within a rolling date range</option></select></label>
   {future!=='any'&&<label className="form-field">{future==='buffer'?'Full buffer days after today':'Number of days ahead'}<input required type="number" min={future==='buffer'?0:1} max={3650} step={1} value={Number.isNaN(future==='buffer'?value?.bufferDays:value?.rollingDays)?'':(future==='buffer'?value?.bufferDays:value?.rollingDays)??''} onChange={e=>onChange({...value,[future==='buffer'?'bufferDays':'rollingDays']:e.target.value===''?NaN:Number(e.target.value)})}/></label>}
  </>}
  {mode==='range'&&<div className="validation-rule-inputs"><label className="form-field">First allowed date<input type="date" required onInput={e=>onChange({...value,dateFrom:e.currentTarget.value})} value={value?.dateFrom||''} onChange={e=>onChange({...value,dateFrom:e.target.value})}/></label><label className="form-field">Last allowed date<input type="date" required onInput={e=>onChange({...value,dateTo:e.currentTarget.value})} value={value?.dateTo||''} onChange={e=>onChange({...value,dateTo:e.target.value})}/></label></div>}
  <label className="date-rule-weekdays"><input type="checkbox" checked={value?.weekdaysOnly||false} onChange={e=>onChange({...value,weekdaysOnly:e.target.checked})}/>Allow Monday through Friday only</label>
  <p className="form-intro">Date-only values use YYYY-MM-DD. Fixed range boundaries are included. Past and future modes exclude today. A buffer of 2 means the first allowed date is three calendar days after today. Rolling ranges start tomorrow and include the last day.</p>
  <p className="form-intro">Workspace time zone: <strong>{zone||(error?'Unavailable':'Loading…')}</strong>. Change it under the workspace account menu → Workspace settings. Relative rules are checked when entering a new or changed value; saved dates can naturally become past dates.</p>
  {error&&<p role="alert">{error}</p>}
 </>;
}

function DomainValidationEditor({value,onChange}:{value:ValidationRules|null;onChange:(v:ValidationRules|null)=>void}){
 const mode=value?.domainMode||'any';
 const [text,setText]=useState((value?.domains||[]).join('\n'));
 return <fieldset className="property-validation-editor"><legend>Validation rules</legend>
  <label className="form-field">Allowed domains<select value={mode} onChange={e=>{const domainMode=e.target.value as NonNullable<ValidationRules['domainMode']>;onChange(domainMode==='any'?null:{domainMode,domains:text.split(/[,\n]/).map(v=>v.trim()).filter(Boolean)});}}><option value="any">All domains</option><option value="allow">Allow certain domains only</option><option value="block">Block certain domains</option></select></label>
  {mode!=='any'&&<label className="form-field">Domains<textarea rows={4} required value={text} placeholder="example.com" onChange={e=>{setText(e.target.value);onChange({domainMode:mode,domains:e.target.value.split(/[,\n]/).map(v=>v.trim()).filter(Boolean)});}}/></label>}
  <p className="form-intro">Enter up to 100 domains, separated by commas or new lines. Each entry also matches its subdomains. Use domain names only, without https://, ports or wildcards.</p>
  <p className="form-intro">Domain rules apply to new or changed values in manual edits, imports and the record API. Existing values stay intact. Workflow actions validate the address or URL format but do not apply optional domain rules.</p>
 </fieldset>;
}
