// The identity provider returns a top-level cross-site form POST. Only the short-lived
// attempt needs SameSite=None. Harbor's session cookie keeps its usual Lax policy.
export const samlAttemptCookieName='__Host-harbor-saml-attempt';
export function samlAttemptCookie(value:string,maxAge:number){
  return samlAttemptCookieName+'='+value+'; Path=/; Secure; HttpOnly; SameSite=None; Max-Age='+maxAge;
}
