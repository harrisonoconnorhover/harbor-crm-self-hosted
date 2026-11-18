import {isNull} from 'drizzle-orm';
import {contacts} from './contact-schema';

export const activeContact=isNull(contacts.archivedAt);
