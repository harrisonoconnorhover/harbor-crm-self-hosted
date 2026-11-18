import {RE2JS} from 're2js';

export const propertyRegexLimit=256;
export const propertyRegexValueLimit=1000;
const maxProgramSize=4096;
const maxCachedPrograms=64,maxCachedInstructions=16384;
type Compiled={pattern:RE2JS|null;error:string|null};
// Small bounded cache shared by previews and row validation. Do not use native
// RegExp for configured patterns, or RE2JS.test()'s per-pattern DFA cache.
const cache=new Map<string,Compiled>();
function compile(expression:string):Compiled {
 const cached=cache.get(expression);if(cached)return cached;
 let result:Compiled;
 if(!expression.length)return {pattern:null,error:'Enter a custom rule regex.'};
 if(expression.length>propertyRegexLimit)return {pattern:null,error:`Use at most ${propertyRegexLimit} characters in the regex.`};
 try{
  const pattern=RE2JS.compile(expression);
  result=pattern.groupCount()>0?{pattern:null,error:'Use non-capturing groups (?:...) instead of capturing groups.'}:
   pattern.programSize()>maxProgramSize?{pattern:null,error:'This pattern is too complex. Simplify repeated groups.'}:{pattern,error:null};
 }catch{result={pattern:null,error:'Enter a valid supported regex. Backreferences and lookarounds are not supported.'};}
 // Bound both entry count and compiled instruction weight. Reuse identical
 // expressions across properties; changing a rule uses a different key.
 while(cache.size>=maxCachedPrograms||[...cache.values()].reduce((n,c)=>n+(c.pattern?.programSize()??0),result.pattern?.programSize()??0)>maxCachedInstructions)cache.delete(cache.keys().next().value!);
 cache.set(expression,result);return result;
}
export function propertyRegexError(expression:string){return compile(expression).error;}
export function matchesPropertyRegex(expression:string,value:string){
 if(value.length>propertyRegexValueLimit)return false;
 const compiled=compile(expression);return !!compiled.pattern?.matcher(value).find();
}
