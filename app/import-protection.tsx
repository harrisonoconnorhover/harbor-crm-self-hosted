'use client';
import {canProtectImportField} from '@/lib/import-protection';

export function ImportProtection({field,header,index,selected,disabled,onChange}:{field:string;header:string;index:number;selected:string[];disabled?:boolean;onChange:(fields:string[])=>void}){
 if(!canProtectImportField(field))return null;
 return <label className="import-protection-choice"><input type="checkbox" aria-label={`Don't overwrite column ${index+1}: ${header}`} checked={selected.includes(field)} disabled={disabled} onChange={e=>onChange(e.target.checked?[...selected,field]:selected.filter(f=>f!==field))}/>Don&apos;t overwrite</label>;
}
