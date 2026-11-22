import {z} from 'zod';
import {readBookmarks,setBookmark} from '../db/postgres/navigation-bookmarks';
import {isPortableTool,type PortableTool} from '../lib/portable-nav-tools';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const command=z.object({tool:z.custom<PortableTool>(isPortableTool),pin:z.boolean()}).strict();
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'private, no-store'}});
export async function portableBookmarks(request:Request){
  const user=await portableApiIdentity(request);
  if(user instanceof Response)return user;
  const db=portableDb();
  if(request.method==='GET')return json({items:await readBookmarks(db,user.userId)});
  const body=await readBoundedRequestText(request,1024);
  if(body===null)return json({error:'Bookmark request too large.'},413);
  let parsed;
  try{parsed=command.safeParse(JSON.parse(body));}catch{return json({error:'Invalid bookmark request.'},400);}
  if(!parsed.success)return json({error:'Choose a navigation item.'},400);
  const items=await setBookmark(db,user.userId,parsed.data.tool,parsed.data.pin);
  return items?json({items}):json({error:'Remove a bookmark before adding another.'},409);
}
