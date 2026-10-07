import type {CardFields} from './card-artwork';
export function missingCardFields(f:CardFields,kind:'volunteer'|'vehicle'):string[]{
 const missing:string[]=[];if(!f.name.trim())missing.push('Name');if(!/^\d{1,3}$/.test(f.number)||Number(f.number)<1)missing.push('Volunteer number');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(f.expiry))missing.push('Expiry');
 if(kind==='volunteer'&&!f.photo)missing.push('Photo');if(kind==='vehicle'){if(!f.plate.trim())missing.push('License plate');if(!/^\d{1,3}$/.test(f.unit)||Number(f.unit)<1)missing.push('Unit number');}return missing;
}
