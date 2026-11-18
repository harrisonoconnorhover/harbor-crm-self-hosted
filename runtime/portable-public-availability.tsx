import {publicAvailabilityPage} from '../app/availability/public-page';
import {portableGuestBookingEnabled} from './portable-guest-booking';
import {readPortablePublishedAvailability} from './portable-published-availability';

export {metadata} from '../app/availability/public-page';
export default publicAvailabilityPage(readPortablePublishedAvailability,portableGuestBookingEnabled);
