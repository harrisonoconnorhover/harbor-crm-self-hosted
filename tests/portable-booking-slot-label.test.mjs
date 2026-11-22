import assert from 'node:assert/strict';
import test from 'node:test';
import {bookingSlotFormatter} from '../lib/calendar/booking-slot-label.ts';

test('guests can distinguish both occurrences of the autumn hour and a meeting spanning the change',()=>{
  const label=bookingSlotFormatter('America/New_York');
  const slot=(start,end)=>({start:'2026-11-01T'+start+':00Z',end:'2026-11-01T'+end+':00Z'});
  assert.match(label(slot('05:00','05:30')),/1:00.*1:30.*GMT-4/);
  assert.match(label(slot('06:00','06:30')),/1:00.*1:30.*GMT-5/);
  assert.match(label(slot('05:45','06:15')),/1:45.*GMT-4.*1:15.*GMT-5/);
});

test('a guest east of midnight sees the next calendar date and fractional-hour offset',()=>{
  const slot={start:'2026-11-21T22:00:00Z',end:'2026-11-21T22:30:00Z'};
  assert.match(bookingSlotFormatter('UTC')(slot),/Saturday, November 21/);
  assert.match(bookingSlotFormatter('Asia/Kathmandu')(slot),/Sunday, November 22.*3:45.*4:15.*GMT\+5:45/);
});
