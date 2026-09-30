import type { MobilityNeed, RecurrenceFrequency, TripPriority, TripType } from '@rvc/shared';
import { emptyAddress, type AddressDraft } from '@/components/address-draft';
export interface FormState {
  callerName: string;
  callerPhone: string;
  callbackNumber: string;
  pickup: AddressDraft;
  dropoff: AddressDraft;
  pickupEntrance: string;
  pickupParking: string;
  dropoffEntrance: string;
  dropoffParking: string;
  tripType: TripType;
  priority: TripPriority;
  groupSlug: string;
  mobilityNeeds: MobilityNeed[];
  passengerNotes: string;
  appointmentOffsetMinutes: string;
  frequency: RecurrenceFrequency;
  byWeekday: number[];
  byMonthDay: string;
  pickupTime: string;
  startDate: string;
  endDate: string;
  leadTimeMinutes: string;
}

export function blankForm(): FormState {
  return {
    callerName: '',
    callerPhone: '',
    callbackNumber: '',
    pickup: emptyAddress(),
    dropoff: emptyAddress(),
    pickupEntrance: '',
    pickupParking: '',
    dropoffEntrance: '',
    dropoffParking: '',
    tripType: 'ride',
    priority: 'routine',
    groupSlug: 'chesed_on_the_go',
    mobilityNeeds: [],
    passengerNotes: '',
    appointmentOffsetMinutes: '',
    frequency: 'weekly',
    byWeekday: [],
    byMonthDay: '1',
    pickupTime: '09:00',
    startDate: '',
    endDate: '',
    leadTimeMinutes: '1440',
  };
}

