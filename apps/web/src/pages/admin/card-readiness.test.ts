import {it,expect} from 'vitest';
import {missingCardFields} from './card-readiness';
import {initialCardFields} from './card-artwork';
it('separates volunteer and vehicle requirements',()=>{const f={...initialCardFields,name:'Synthetic',number:'101',unit:'101',expiry:'2028-10',plate:''};expect(missingCardFields(f,'volunteer')).toEqual(['Photo']);expect(missingCardFields(f,'vehicle')).toEqual(['License plate']);});
it('blocks invalid displayed numbers and expiry',()=>{expect(missingCardFields({...initialCardFields,number:'RVC0001',expiry:''},'volunteer')).toContain('Volunteer number');});
