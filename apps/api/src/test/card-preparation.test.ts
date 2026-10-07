import {describe,it,expect} from 'vitest';
import {canonicalUnit,planUnitNumbers} from '../domain/card-preparation.js';
describe('inert number preparation',()=>{
 it('keeps source numbers verbatim and allocates only empty values',()=>{const p=planUnitNumbers([{id:'1',unitNumber:'007'},{id:'2',unitNumber:null},{id:'3',unitNumber:'101'}],['102']);expect(p['1']!.number).toBe('007');expect(p['2']!.number).toBe('103');expect(p['3']!.number).toBe('101');});
 it('holds duplicates and invalid source numbers unchanged',()=>{const p=planUnitNumbers([{id:'1',unitNumber:'7'},{id:'2',unitNumber:'007'},{id:'3',unitNumber:'1234'}],[]);expect(p['1']!.issue).toBeTruthy();expect(p['2']!.issue).toBeTruthy();expect(p['3']!.number).toBe('1234');expect(p['3']!.issue).toBeTruthy();});
 it('rejects unsupported numbers',()=>{for(const n of ['0','RVC0001','1000','abc'])expect(canonicalUnit(n)).toBeNull();});
});
