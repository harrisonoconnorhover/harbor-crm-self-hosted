import {drizzle,type PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

let connection:PostgresJsDatabase|undefined;
let client:ReturnType<typeof postgres>|undefined;

export function portableDb(){
  const url=process.env.DATABASE_URL;
  if(!url)throw Error('Set DATABASE_URL for portable Harbor.');
  client??=postgres(url);
  connection??=drizzle(client);
  return connection;
}

export async function closePortableDb(){
  await client?.end({timeout:5});
  connection=undefined;
  client=undefined;
}
