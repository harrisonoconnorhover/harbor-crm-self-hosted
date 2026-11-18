import {createHash} from 'node:crypto';
import {copyFile,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,relative,sep} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=join(root,'.harbor/portable-build');
const marker=join(output,'release.sha256');
await rm(marker,{force:true});
for(const config of ['vite.portable.config.ts','vite.portable-worker.config.ts']){
  const result=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build','--config',config],{
    cwd:root,stdio:'inherit',
  });
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}

// Vinext ships pathslash inside its distribution, outside Vite's package license discovery.
await copyFile(join(root,'runtime/licenses/pathslash-MIT.txt'),join(output,'worker/pathslash-LICENSE.txt'));

async function files(directory){
  const base=join(root,directory);
  const entries=await readdir(base,{recursive:true,withFileTypes:true});
  return entries.filter(entry=>!entry.isDirectory()).map(entry=>{
    if(!entry.isFile())throw Error('The portable build contains a non-regular file.');
    return directory+'/'+relative(base,join(entry.parentPath,entry.name)).split(sep).join('/');
  });
}

const paths=[
  ...await files('.harbor/portable-build/server'),...await files('.harbor/portable-build/client'),
  ...await files('.harbor/portable-build/worker'),
  ...await files('db/postgres/migrations'),
  'runtime/portable-config.mjs','runtime/portable-migrations.mjs','runtime/portable-web.mjs',
  'scripts/portable-web.mjs','package.json','package-lock.json',
];
const digest=createHash('sha256');
for(const file of paths.sort()){
  const sha256=createHash('sha256').update(await readFile(join(root,file))).digest('hex');
  digest.update(JSON.stringify([file,sha256]));
}
const fingerprint=digest.digest('hex');
await writeFile(marker,fingerprint+'\n');
console.log('Portable build fingerprint: '+fingerprint);
