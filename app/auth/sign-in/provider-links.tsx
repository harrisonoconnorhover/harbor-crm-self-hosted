import {ArrowRight} from 'lucide-react';

export type SignInProviders={returnTo:string;google:boolean;microsoft:boolean;saml:boolean;oidc:boolean};

export function ProviderLinks({returnTo,google,microsoft,saml,oidc}:SignInProviders){
  const destination=encodeURIComponent(returnTo);
  return <>{([
    ['google','Google',google],['microsoft','Microsoft',microsoft],['saml','company SSO',saml],['oidc','company OpenID Connect',oidc],
  ] as const).map(([provider,label,enabled])=>enabled&&
    <a key={provider} className="auth-primary welcome-google" href={'/auth/'+provider+'/start?return_to='+destination} target="_top">
      <span>{'Continue with '+label}</span><ArrowRight size={18} aria-hidden="true"/>
    </a>)}</>;
}
