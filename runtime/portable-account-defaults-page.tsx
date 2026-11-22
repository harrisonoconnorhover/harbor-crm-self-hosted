import {readAccountDefaults} from '../db/postgres/account-defaults-store';
import {portableDb} from './portable-db';
import {AccountDefaultsForm} from './portable-account-defaults-ui';
import './portable-account-defaults.css';

export async function PortableAccountDefaults({ownerId}:{ownerId:string}){
  const initial=await readAccountDefaults(portableDb(),ownerId);
  return <AccountDefaultsForm initial={initial}/>;
}
