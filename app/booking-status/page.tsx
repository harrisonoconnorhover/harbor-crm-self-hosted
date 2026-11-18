import {BookingStatus} from './booking-status';
import '../forms/lead-forms.css';

export const dynamic='force-dynamic';
export const metadata={title:'Booking status · Harbor',robots:{index:false,follow:false},referrer:'no-referrer'};

export default function BookingStatusPage(){
  return <main className="lead-form-page"><div className="lead-form-card">
    <h1>Booking status</h1>
    <BookingStatus/>
  </div></main>;
}
