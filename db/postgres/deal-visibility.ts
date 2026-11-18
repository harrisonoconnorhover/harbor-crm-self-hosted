import {isNull} from 'drizzle-orm';
import {deals} from './deal-schema';

export const activeDeal=isNull(deals.archivedAt);
