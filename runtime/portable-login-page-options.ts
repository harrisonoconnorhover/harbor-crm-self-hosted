import {loginOrigin} from '../lib/identity';
import {microsoftCallbackPath,microsoftLoginSettings,portableLoginProviders,type PortableLoginEnvironment} from './portable-login-config';

export function loginPageOptions(environment:PortableLoginEnvironment){
  const providers=portableLoginProviders(environment);
  const microsoftRequested=microsoftLoginSettings.some(key=>!!environment[key]);
  const googleRequested=!!(environment.HARBOR_LOGIN_GOOGLE_CLIENT_ID||environment.HARBOR_LOGIN_GOOGLE_CLIENT_SECRET);
  let microsoftCallback:string|undefined;
  try{microsoftCallback=loginOrigin(environment).origin+microsoftCallbackPath;}catch{/* The origin is not configured yet. */}
  return {googleReady:!!providers.google,microsoftReady:!!providers.microsoft,
    showGoogleSetup:!providers.google&&(googleRequested||!microsoftRequested),
    showMicrosoftSetup:!providers.microsoft&&microsoftRequested,microsoftCallback};
}
