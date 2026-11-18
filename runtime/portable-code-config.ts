import {portableMode} from './portable-config.mjs';

export const portableCodeAvailable=()=>portableMode(process.env)==='local'&&process.env.HARBOR_PORTABLE_CODE_ENABLED==='true';
