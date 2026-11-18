import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { safeReturnPath, type HarborIdentity } from '@/lib/identity';
import { requestIdentity } from '@/lib/identity-server';

export type ChatGPTUser = HarborIdentity;

export async function getChatGPTUser(): Promise<HarborIdentity | null> {
  const incomingHeaders = await headers();
  const requestHeaders = new Headers();
  incomingHeaders.forEach((value, name) => requestHeaders.append(name, value));

  return requestIdentity(requestHeaders);
}

export async function requireChatGPTUser(returnTo: string): Promise<HarborIdentity> {
  const user = await getChatGPTUser();
  if (!user) {
    redirect(chatGPTSignInPath(returnTo));
  }

  return user;
}

export function chatGPTSignInPath(returnTo: string): string {
  return authPath('/auth/sign-in', returnTo);
}

export function chatGPTSignOutPath(returnTo = '/'): string {
  return authPath('/auth/sign-out', returnTo);
}

function authPath(route: '/auth/sign-in' | '/auth/sign-out', returnTo: string): string {
  const destination = safeReturnPath(returnTo);
  return `${route}?return_to=${encodeURIComponent(destination)}`;
}
