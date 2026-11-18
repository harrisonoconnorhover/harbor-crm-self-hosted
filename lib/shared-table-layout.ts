import {z} from 'zod';
import {columnWidthsSchema,columnWidth,type ColumnWidths} from './column-widths';
export const sharedTableLayoutSchema=z.object({widths:columnWidthsSchema,frozen:z.number().int().min(0).max(20).default(1)}).strict().prefault({widths:{},frozen:1});
export type SharedTableLayout=z.infer<typeof sharedTableLayoutSchema>;
export const defaultSharedTableLayout:SharedTableLayout={widths:{},frozen:1};
export function sharedTableLayoutFromHash(hash:string,fallback:SharedTableLayout=defaultSharedTableLayout){
 const raw=new URLSearchParams(hash.replace(/^#/, '')).get('tableLayout');if(!raw)return fallback;
 try{const result=sharedTableLayoutSchema.safeParse(JSON.parse(raw));return result.success?result.data:fallback}catch{return fallback}
}
// Reserve the optional selection gutter and space to scroll other properties
// when a saved frozen range is wider than the current screen.
export function sharedFrozenOffsets(columns:string[],widths:ColumnWidths,count:number,availableWidth:number,selectionWidth=0){
 const offsets=new Map<string,number>();let left=selectionWidth;
 for(const id of columns.slice(0,count)){const width=columnWidth(id,widths);if(left+width>availableWidth-100)break;offsets.set(id,left);left+=width}
 return offsets;
}
