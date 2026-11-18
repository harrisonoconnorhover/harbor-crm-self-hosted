import {isNull} from 'drizzle-orm';
import {companies} from './company-schema';

export const activeCompany=isNull(companies.archivedAt);
