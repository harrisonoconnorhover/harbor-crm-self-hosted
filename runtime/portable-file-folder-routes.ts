import {z} from 'zod';
import {readPortableFileFolders,writePortableFileFolder} from '../db/postgres/portable-file-folder-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableFolderPage,portableFolderWrite} from '../lib/portable-file-folders';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {objectStorageConfigured} from './portable-object-storage';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

async function route(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    if(user.guest)return json({error:'Only the workspace owner can manage file folders.'},403);
    if(!objectStorageConfigured())return json({error:'Files are unavailable on this installation.'},404);
    const db=portableDb(),params=new URL(request.url).searchParams;
    if(request.method!=='POST'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid folder page.'},400);
      const {after,parentId}=portableFolderPage.parse(Object.fromEntries(params));
      const page=await readPortableFileFolders(db,user.userId,after,parentId);
      return page?json(page):json({error:'Folder not found in your workspace.'},404);
    }
    if(params.size)return json({error:'Invalid folder request.'},400);
    const body=await readBoundedRequestText(request,4096);
    if(body===null)return json({error:'Folder request is too large.'},413);
    const input=portableFolderWrite.parse(JSON.parse(body));
    const result=await writePortableFileFolder(db,user.userId,input);
    if(result==='missing')return json({error:'File or folder not found in your workspace.'},404);
    if(result==='stale')return json({error:'The file or folder changed. Refresh Files and try again.'},409);
    if(result==='invalidParent')return json({error:'Choose a destination outside this folder and within 32 levels.'},409);
    if(result==='notEmpty')return json({error:'Remove child folders and move files, including files on archived Contacts, before deleting this folder.'},409);
    if(result==='duplicate')return json({error:'A folder with that name already exists.'},409);
    return json({ok:true},result==='created'?201:200);
  }catch(error){
    if(error instanceof z.ZodError)return json({error:error.issues[0]?.message??'Check the folder details.'},400);
    if(error instanceof SyntaxError)return json({error:'Send valid JSON.'},400);
    return json({error:'Could not manage file folders. Try again.'},503);
  }
}

export {route as GET,route as POST};
