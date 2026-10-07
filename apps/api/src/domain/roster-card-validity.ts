/** Dormant policy. Does not read people, create tokens or activate verification. */
export type RosterCardState='active'|'lost'|'revoked'|'inactive';
export function cardValidity(state:RosterCardState,activeVolunteer:boolean,expiresAt:Date,now:Date):{valid:boolean;reason:string}{
 if(state==='lost')return{valid:false,reason:'reported_lost'};
 if(state==='revoked')return{valid:false,reason:'revoked'};
 if(state==='inactive'||!activeVolunteer)return{valid:false,reason:'inactive'};
 if(expiresAt.getTime()<=now.getTime())return{valid:false,reason:'expired'};
 return{valid:true,reason:'active'};
}
export function validityDisclosure(result:{valid:boolean;reason:string},person:{name:string;unitNumber:string;photo:string|null},kind:'volunteer'|'vehicle'){
 return result.valid?{valid:true,reason:result.reason,kind,organization:"Refuah V'Chesed",fullName:person.name,unitNumber:person.unitNumber,photo:person.photo}:{valid:false,reason:result.reason,kind};
}
