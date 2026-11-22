import {sql,type SQLWrapper} from 'drizzle-orm';
export {textFieldsSearchIndex as commerceSearchIndex,matchesTextFields as matchesCommerceSearch} from './search-index';

export const productSearchFields=(data:SQLWrapper)=>[sql`${data}->>'name'`,sql`${data}->>'sku'`];
export const quoteSearchFields=(data:SQLWrapper,dealName:SQLWrapper)=>[sql`${data}->>'title'`,sql`${data}->'buyer'->>'name'`,dealName];
export const invoiceSearchFields=(data:SQLWrapper)=>[sql`${data}->>'title'`,sql`${data}->'buyer'->>'name'`,sql`${data}->>'reference'`];
