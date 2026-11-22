'use client';
import {reminderChoices} from '../lib/portable-task-reminders';
import {useEffect,useState} from 'react';
import type {SalesEnrollment,SalesEnrollmentStep,SalesSequenceSummary,SalesSequenceStep} from '../lib/portable-sales-sequences';

export type Page<T>={items:T[];next:string|null};
export type LibraryPage=Page<SalesSequenceSummary>&{readiness:{sender:string|null}};
export type EnrollmentDetail={enrollment:SalesEnrollment;steps:SalesEnrollmentStep[]};

export async function sequenceRequest<T>(query:string,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch('/api/sequences'+(query?'?'+query:''),{
    method:body?'POST':'GET',signal,cache:'no-store',
    ...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),
  });
  const result=await response.json();
  if(!response.ok){
    const message=result&&typeof result==='object'&&'error' in result&&typeof result.error==='string'?result.error:undefined;
    throw Error(message||'Harbor could not complete this sequence request.');
  }
  return result as T;
}

export function useSequenceRead<T>(query:string|null,refresh=0){
  const [result,setResult]=useState<{key:string;value?:T;error?:string}>();
  const key=JSON.stringify([query,refresh]);
  useEffect(()=>{
    if(query===null)return;
    const controller=new AbortController();
    sequenceRequest<T>(query,undefined,controller.signal).then(value=>{
      if(!controller.signal.aborted)setResult({key,value});
    }).catch(error=>{
      if(!controller.signal.aborted)setResult({key,error:(error as Error).message});
    });
    return ()=>controller.abort();
  },[query,key]);
  return result?.key===key?result:undefined;
}

export function stepName(step:SalesSequenceStep){return step.type==='email'?step.subject:step.title;}
export function stepKind(step:SalesSequenceStep){return step.type==='email'?'Email':step.taskType+' task';}
export function stepDelay(days:number){
  return days===0?'No delay':days===1?'After 1 day':'After '+days+' days';
}

export function stepTimingLabel(step:SalesSequenceStep){
  if(step.type!=='task'||!step.timing)return;
  const {dueAfterMinutes,reminderMinutes}=step.timing;
  const due=dueAfterMinutes===0?'Due at assignment':`Due ${dueAfterMinutes} ${dueAfterMinutes===1?'minute':'minutes'} after assignment`;
  const reminder=reminderChoices.find(option=>option.minutes===reminderMinutes);
  return reminder?due+' · Reminder '+reminder.label.toLowerCase():due;
}
