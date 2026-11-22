import {oidcSettings,oidcCallbackPath} from './portable-company-oidc-config';
import {loginOrigin} from '../lib/identity';
import {microsoftCallbackPath,microsoftLoginSettings,portableLoginProviders,type PortableLoginEnvironment} from './portable-login-config';

import {samlLoginSettings,samlCallbackPath,samlMetadataPath} from './portable-saml-config';

export function loginPageOptions(environment:PortableLoginEnvironment){
  const providers=portableLoginProviders(environment);
  const microsoftRequested=microsoftLoginSettings.some(key=>!!environment[key]);
  const googleRequested=!!(environment.HARBOR_LOGIN_GOOGLE_CLIENT_ID||environment.HARBOR_LOGIN_GOOGLE_CLIENT_SECRET);
  const oidcRequested=oidcSettings.some(key=>!!environment[key]);
  const samlRequested=samlLoginSettings.some(key=>!!environment[key]);
  let origin:string|undefined;
  try{origin=loginOrigin(environment).origin;}catch{/* The origin is not configured yet. */}
  return {oidcReady:!!providers.oidc,showOidcSetup:oidcRequested&&!providers.oidc,oidcCallback:origin&&origin+oidcCallbackPath,googleReady:!!providers.google,microsoftReady:!!providers.microsoft,samlReady:!!providers.saml,
    showGoogleSetup:!providers.google&&(googleRequested||(!microsoftRequested&&!samlRequested&&!oidcRequested)),
    showMicrosoftSetup:!providers.microsoft&&microsoftRequested,microsoftCallback:origin&&origin+microsoftCallbackPath,
    showSamlSetup:samlRequested&&!providers.saml,samlCallback:origin&&origin+samlCallbackPath,samlMetadata:origin&&origin+samlMetadataPath};
}
