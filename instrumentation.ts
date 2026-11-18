import type {Instrumentation} from 'next';
import {portableTrial} from './lib/trial-platform';

function portablePageLabel(routePath:string){
  switch(routePath){
    case '/':
    case '/tickets':
    case '/products':
    case '/quotes':
      return 'crm-page';
    case '/forms/[id]':
      return 'form-page';
    case '/availability/[id]':
    case '/booking-status':
      return 'booking-page';
    case '/auth/sign-in':
    case '/auth/sign-out':
      return 'sign-in-page';
    default:
      return 'other-page';
  }
}

export const onRequestError:Instrumentation.onRequestError=(_error,_request,context)=>{
  // A render can fail after HTTP headers have already been sent.
  if(!portableTrial||context.routeType!=='render')return;
  console.error(JSON.stringify({event:'harbor_portable_page_failed',route:portablePageLabel(context.routePath)}));
};
