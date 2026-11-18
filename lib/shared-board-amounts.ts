export type BoardAmounts={total:number|null;average:number|null;weighted:number|null;valued:number;missing:number;withoutProbability:number};
export function laneBoardAmounts(count:number,valued:number,sum:number,probability:number|undefined):BoardAmounts{
 const total=Number.isFinite(sum)?sum:null,known=typeof probability==='number'&&Number.isFinite(probability)&&probability>=0&&probability<=100;
 const weighted=valued===0?0:total===null||!known?null:total*(probability!/100);
 return {total,average:valued&&total!==null?total/valued:null,weighted:weighted!==null&&Number.isFinite(weighted)?weighted:null,valued,missing:count-valued,withoutProbability:known?0:valued};
}
export function combinedBoardAmounts(lanes:BoardAmounts[]):BoardAmounts{
 const valued=lanes.reduce((n,l)=>n+l.valued,0),sum=lanes.reduce((n,l)=>n+(l.total??0),0),weightedSum=lanes.reduce((n,l)=>n+(l.weighted??0),0);
 const total=lanes.some(l=>l.total===null)||!Number.isFinite(sum)?null:sum,weighted=lanes.some(l=>l.weighted===null)||!Number.isFinite(weightedSum)?null:weightedSum;
 return {total,weighted,average:valued&&total!==null?total/valued:null,valued,missing:lanes.reduce((n,l)=>n+l.missing,0),withoutProbability:lanes.reduce((n,l)=>n+l.withoutProbability,0)};
}
