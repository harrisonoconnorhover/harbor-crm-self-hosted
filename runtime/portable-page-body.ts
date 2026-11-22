import {headers} from 'next/headers';

export async function portablePageHasBody(){
  return (await headers()).get('x-harbor-page-method')!=='HEAD';
}
