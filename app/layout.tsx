import type {ReactNode} from 'react';
import './globals.css';

export const metadata={
  title:'Harbor CRM · Your relationships, in focus',
  description:'A private workspace for contacts, companies, deals, and their follow-ups.',
  manifest:'/harbor.webmanifest',
  icons:{icon:'/favicon.svg',apple:{url:'/harbor-icon-180.png',sizes:'180x180'}},
};

export default function HarborLayout({children}:{children:ReactNode}){
  return <html lang="en"><body>{children}</body></html>;
}
