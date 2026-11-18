import {readContacts} from './contact-store';
import {readCompanies} from './company-store';
import {readDeals} from './deal-store';

export const portableRecordReaders={contacts:readContacts,companies:readCompanies,deals:readDeals};
