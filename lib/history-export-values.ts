// Only explicitly marked Harbor history columns use this reversible encoding.
// Ordinary CSV apostrophes, blanks and strings are never reinterpreted.
export const HISTORY_VALUE_MARKER=' [Harbor history value]';
export function historyValueCell(value:unknown):string {
 if(value===null||value===undefined||value===''||Array.isArray(value)&&!value.length)return '~empty';
 const text=Array.isArray(value)?JSON.stringify(value):String(value);
 return /^[\s'=+@~\-]/.test(text)||text.startsWith("text:")?"text:"+text:text;
}
export function decodeHistoryValue(text:string):string|null|undefined {
 if(text==='')return undefined;
 if(text==='~empty')return null;
 return text.startsWith("text:")?text.slice(5):text;
}
export function historyColumnLabel(header:string){return header.endsWith(HISTORY_VALUE_MARKER)?header.slice(0,-HISTORY_VALUE_MARKER.length).replace(/^Property: /,'').replace(/ · (current|previous \d+)$/,''):header;}
