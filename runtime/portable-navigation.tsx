import type {ReactNode} from 'react';
import {PortableNavigationOptions} from './portable-crm-header';
import {portableCalendarConfig} from './portable-calendar-config';
import {portablePersonalGoogleConfig} from './portable-google-config';
import {objectStorageConfigured} from './portable-object-storage';

// Only availability travels to the browser. Each destination checks access itself.
export function withPortableNavigation(email:string,body:ReactNode){
  return <PortableNavigationOptions value={{filesEnabled:objectStorageConfigured(),
    calendarAvailable:portableCalendarConfig()?.owner===email.toLowerCase()||Boolean(portablePersonalGoogleConfig('calendar'))}}>{body}</PortableNavigationOptions>;
}
