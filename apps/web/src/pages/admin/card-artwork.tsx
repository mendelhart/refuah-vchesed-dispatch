import React from 'react';
import {QrCode} from '../MyIdCard';
import {cardGlyphWidths} from './card-text-metrics';
export interface CardFields {
  name: string; number: string; photo: string | null; plate: string; unit: string; expiry: string;
  termsFr: string; termsEn: string; make?:string;model?:string;year?:string; verificationUrl?:string; vehicleVerificationUrl?:string; issued?:boolean; vehicleIssued?:boolean;
}
export const initialCardFields: CardFields = {
  name: 'SAMPLE VOLUNTEER', number: 'SAMPLE-ID', photo: null, plate: 'SAMPLE', unit: 'SAMPLE', expiry: '',
  termsFr: "Cette carte identifie un bénévole de Refuah V’Chesed. Elle est personnelle et non transférable. Utilisez-la uniquement dans le cadre des activités bénévoles autorisées par l’organisation. Respectez la confidentialité des patients et les règles de l’établissement. Signalez toute perte à Refuah V’Chesed.",
  termsEn: "This card identifies a Refuah V’Chesed volunteer. It is personal and non-transferable. Use it only for volunteer activities approved by the organization. Respect patient privacy and facility rules. Report a lost card to Refuah V’Chesed.",
};
export type Face = 'volunteer-front' | 'volunteer-back' | 'vehicle-front' | 'vehicle-back';
const R = '#ed1925';
const logo = '/brand/cards/rvc-logo.svg';
const font = 'CardCondensed, sans-serif';
const FontContext = React.createContext(font);
function Text({x,y,size=28,fill='black',bold=false,anchor='start',children}:{x:number;y:number;size?:number;fill?:string;bold?:boolean;anchor?:'start'|'middle'|'end';children:React.ReactNode}) {
  return <text x={x} y={y} fontSize={size} fill={fill} fontWeight={bold?700:400} textAnchor={anchor} fontFamily={React.useContext(FontContext)}>{children}</text>;
}
function Lines({x,y,width,text,size=25,line=33,bold=false}:{x:number;y:number;width:number;text:string;size?:number;line?:number;bold?:boolean}) {
  const rows:string[]=[]; let row='';
  const measure=(value:string)=>[...value].reduce((sum,c)=>sum+(cardGlyphWidths[c]??.55)*size,0);
  for(const word of text.split(/\s+/)){if(measure(row+' '+word)>width&&row){rows.push(row);row=word;}else row+=(row?' ':'')+word;} if(row)rows.push(row);
  return <>{rows.map((v,i)=><Text key={i} x={x} y={y+i*line} size={size} bold={bold}>{v}</Text>)}</>;
}
function Draft({w,h}:{w:number;h:number}) {return <g opacity="0.20"><text transform={`translate(${w/2},${h/2}) rotate(-30)`} textAnchor="middle" fontFamily={font} fontWeight="700" fontSize={w*.115} fill="#333">DRAFT · NOT VALID</text></g>;}
function Stripe({bottom=false}:{bottom?:boolean}) {return <g transform={bottom?'translate(1250,800) rotate(180)':undefined}><path d="M0 0H1250V60H0Z" fill="#262626"/><path d="M0 0H515L490 25H0Z" fill={R}/><path d="M0 27H897L925 0H967L912 60H0Z" fill="#d6d6d6"/><path d="M0 51H910L960 0" fill="none" stroke={R} strokeWidth="2"/><path d="M1190 60L1250 0V60Z" fill={R}/></g>;}
export function CardArtwork({face,fields}:{face:Face;fields:CardFields}):React.JSX.Element {
 const id=face.startsWith('volunteer');const w=id?855:1250;const h=id?1355:800;const expiry=fields.expiry?fields.expiry.split('-').reverse().join('/'):'À CONFIRMER';
 const unique=React.useId().replace(/:/g,'');
 return <FontContext.Provider value={id?font:'VehicleCondensed, sans-serif'}><svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${w} ${h}`} aria-label={face} style={{display:'block',width:'100%',height:'auto'}}>
 <defs><radialGradient id={`bg${unique}`} cx="50%" cy="40%" r="80%"><stop offset="0" stopColor="white"/><stop offset="1" stopColor="#d8d9dc"/></radialGradient><clipPath id={`c${unique}`}><rect x="236" y="281" width="382" height="500" rx="20"/></clipPath></defs>
 <rect width={w} height={h} fill={id?"white":`url(#bg${unique})`}/>
 {id?<><g transform="rotate(-15)" opacity=".22">{Array.from({length:42},(_,i)=>{const col=i%6-1,row=Math.floor(i/6);return <g key={i} transform={`translate(${60+260*col},${55+250*row}) scale(.912) translate(-147.48,-314.191)`}><path d="M 280.617188 400.363281 C 275.742188 405.472656 253.675781 427.457031 217.394531 427.457031 C 181.390625 427.457031 152.125 391.304688 152.125 360.878906 C 152.125 342.761719 162.578125 333.238281 182.089844 333.238281 C 207.175781 333.238281 213.675781 355.304688 213.675781 355.304688 L 218.324219 355.304688 C 218.324219 355.304688 225.289062 332.773438 249.910156 332.773438 C 271.28125 332.773438 279.875 340.203125 279.875 356.695312 C 279.875 379.574219 246.894531 399.214844 216 396.5625 C 197.019531 394.933594 178.824219 380.03125 169.546875 366.683594 L 165.828125 377.367188 C 173.050781 396.4375 197.019531 412.621094 216 415.023438 C 249.9375 419.316406 284.519531 392.746094 284.519531 356.695312 C 284.519531 329.289062 272.675781 314.191406 249.910156 314.191406 C 231.328125 314.191406 220.414062 333.46875 216 343.691406 C 211.585938 333.703125 200.902344 314.65625 182.089844 314.65625 C 160.953125 314.65625 147.480469 333.238281 147.480469 360.878906 C 147.480469 410.117188 182.648438 446.035156 217.394531 446.035156 C 241.085938 446.035156 268.074219 429.863281 283.871094 412.90625 Z M 280.617188 400.363281 " fill="#777"/></g>;})}</g><path d="M0 0H855V302Q490 295 0 474Z" fill="#b31d27"/><path d="M0 0H855V302Q475 350 0 235Z" fill={R}/><path d="M0 1185Q315 1400 855 1148V1355H0Z" fill="#b31d27"/><path d="M0 1268Q520 1305 855 1148V1355H0Z" fill={R}/></>:<>{face==='vehicle-front'&&<><Stripe/><Stripe bottom/></>}</>}
 {face==='volunteer-front'&&<>
 <Text x={427} y={194} size={67} fill="white" bold anchor="middle">BÉNÉVOLE · VOLUNTEER</Text>
 <rect x="225" y="270" width="404" height="522" rx="29" fill="white"/>
 {fields.photo?<image href={fields.photo} x="236" y="281" width="382" height="500" preserveAspectRatio="xMidYMid slice" clipPath={`url(#c${unique})`}/>:<><rect x="236" y="281" width="382" height="500" rx="20" fill="#ececec"/><circle cx="427" cy="443" r="78" fill="#c5c5c5"/><path d="M290 719V664a137 137 0 01274 0v55" fill="#c5c5c5"/><Text x={427} y={754} size={29} anchor="middle">PHOTO À CONFIRMER</Text></>}
 <Text x={427} y={906} size={Math.min(67,1120/Math.max(fields.name.length,1))} fill={R} bold anchor="middle">{fields.name}</Text>
 <Text x={70} y={994} size={32}>NUMÉRO D’IDENTIFICATION:</Text><Text x={785} y={994} size={38} bold anchor="end">{fields.number||'À CONFIRMER'}</Text>
 <image href={logo} x="70" y="1060" width="420" height="152"/>
 <Text x={785} y={1320} size={32} fill="white" anchor="end">EXPIRATION: {expiry}</Text>
 </>}
 {face==='volunteer-back'&&<>
 <Text x={427} y={147} size={52} fill="white" bold anchor="middle">CONDITIONS · TERMS</Text>
 <rect x="55" y="350" width="745" height="665" fill="white" opacity=".94"/>
 <Lines x={85} y={407} width={685} text={fields.termsFr} size={fields.termsFr.length>450?22:27} line={fields.termsFr.length>450?30:35}/>
 <Lines x={85} y={747} width={685} text={fields.termsEn} size={27} line={35}/>
 <Text x={85} y={970} size={32} bold fill={R}>SI TROUVÉE · IF FOUND</Text>
 <Text x={85} y={1010} size={29}>514 357 2167 · info@refuahvchesed.org</Text>
 <svg x="90" y="1040" width="220" height="220" viewBox="0 0 220 220"><QrCode text={fields.verificationUrl??"https://rvc-web-0klk.onrender.com/verify/preview?kind=volunteer"} title="Preview QR: verification not activated"/></svg><Text x={340} y={1130} size={27} bold>{fields.issued?'SCAN FOR VALIDITY':'QR PREVIEW ONLY'}</Text><Text x={340} y={1170} size={25}>{fields.issued?'VERIFY THE HOLDER':'VERIFICATION NOT ACTIVE'}</Text>
 <Text x={427} y={1318} size={29} fill="white" anchor="middle">{fields.issued?'REFUAH V’CHESED':'BROUILLON · DRAFT'}</Text>
 </>}
 {face==='vehicle-front'&&<>
 <image href="/brand/cards/chesed-on-the-go.svg" x="44" y="70" width="404" height="242"/>
 <Text x={853} y={143} size={57} fill="#e60000" bold anchor="middle">SERVICES DE</Text><Text x={853} y={211} size={57} fill="#e60000" bold anchor="middle">TRANSPORT HOSPITALIER</Text><Text x={853} y={274} size={49} bold anchor="middle">BÉNÉVOLES CHESED ON THE GO</Text>
 <image href="/brand/cards/fleur.svg" x="56" y="312" width="261" height="320"/><image href="/brand/cards/accessibility.svg" x="1035" y="374" width="180" height="270"/>
 <rect x="294" y="347" width="666" height="66" fill="black"/>
 <Text x={627} y={393} size={36} bold fill="white" anchor="middle">VÉHICULE DE RÉPONSE AUTORISÉ</Text>
 <rect x="242" y="434" width="467" height="212" fill="white" stroke="#666" strokeWidth="3"/><Text x={475} y={482} size={38} fill="#555" anchor="middle">PRÉPARÉ POUR LA PLAQUE</Text><Text x={475} y={530} size={38} fill="#555" anchor="middle">D’IMMATRICULATION:</Text><Text x={475} y={617} size={Math.min(92,690/(fields.plate||'À CONFIRMER').length)} bold fill="#ee0000" anchor="middle">{fields.plate||'À CONFIRMER'}</Text>
 <rect x="779" y="473" width="204" height="173" fill="white" stroke="#666" strokeWidth="3"/><Text x={881} y={523} size={37} fill="#555" anchor="middle">ID UNITÉ</Text><Text x={881} y={617} size={Math.min(88,300/(fields.unit||'À CONFIRMER').length)} bold fill="#ee0000" anchor="middle">{fields.unit||'À CONFIRMER'}</Text>
 <rect x="64" y="671" width="360" height="73" rx="3" fill="white" stroke="#ed1925" strokeWidth="3"/><Text x={87} y={719} size={33} fill="#555">EXPIRATION</Text><Text x={404} y={719} size={40} bold fill="#ed1925" anchor="end">{expiry}</Text><image href="/brand/cards/rvc-original-compact.svg" x="930" y="657" width="245" height="85"/>
 </>}
 {face==='vehicle-back'&&<>
 <rect width="1250" height="800" fill="white"/>
 <rect x="12" y="12" width="1226" height="776" fill="none" stroke={R} strokeWidth="3"/>
 <rect x="16" y="16" width="1218" height="63" fill={R}/>
 <Text x={625} y={61} size={37} fill="white" bold anchor="middle">VÉRIFICATION DU VÉHICULE / VEHICLE VERIFICATION</Text>
 <image href={logo} x="58" y="106" width="325" height="122"/>
 <Text x={447} y={145} size={34} bold>TRANSPORT HOSPITALIER BÉNÉVOLE</Text>
 <Text x={447} y={191} size={29}>Plaque {fields.plate||'À CONFIRMER'} · Unité {fields.unit||'À CONFIRMER'} · Exp. {expiry}</Text>
 <path d="M58 258H1192" stroke="#ddd" strokeWidth="2"/>
 <Text x={58} y={313} size={34} bold>Vérifiez le statut actuel avant de vous fier à cette plaque.</Text>
 <Text x={58} y={359} size={29}>Transport gratuit de patients et de leurs proches vers et depuis les hôpitaux.</Text>
 <Text x={58} y={402} size={29}>Utilisation réservée aux activités autorisées par Refuah V’Chesed.</Text>
 <Text x={58} y={470} size={33} bold>Check the current status before relying on this plaque.</Text>
 <Text x={58} y={511} size={29}>Free hospital transport for patients and their family members.</Text>
 <Text x={58} y={550} size={29}>For volunteer activities approved by Refuah V’Chesed only.</Text>
 <svg x="963" y="288" width="214" height="214" viewBox="0 0 214 214"><QrCode text={fields.vehicleVerificationUrl??"https://rvc-web-0klk.onrender.com/verify/preview?kind=vehicle"} title={fields.vehicleIssued?'Vehicle verification':'Demonstration QR: not issued'}/></svg>
 <Text x={1070} y={535} size={24} fill="#555" anchor="middle">{fields.vehicleIssued?'VÉRIFIER / VERIFY':'QR DE DÉMONSTRATION'}</Text>
 <path d="M58 590H1192" stroke={R} strokeWidth="3"/>
 <Text x={58} y={636} size={31} bold>SI TROUVÉE / IF FOUND</Text>
 <Text x={58} y={678} size={32}>514 357 2167 · info@refuahvchesed.org</Text>
 <Text x={58} y={717} size={25} fill="#666">420, rue Beaubien O, bureau 101 · Montréal, QC H2V 4S6</Text>
 <rect x="16" y="752" width="1218" height="33" fill="#eee"/>
 <Text x={625} y={776} size={22} anchor="middle">{fields.vehicleIssued?'REFUAH V’CHESED':'SPÉCIMEN · DONNÉES FICTIVES · NON VALIDE'}</Text>
 </>}
 {(!(id?fields.issued:fields.vehicleIssued))&&face!=='vehicle-back'&&(id?<Draft w={w} h={h}/>:<g><rect x="490" y="774" width="270" height="22" rx="3" fill="white" opacity=".95"/><text x="625" y="790" textAnchor="middle" fontFamily={font} fontSize="16" fill="#555">REVIEW DRAFT · NOT VALID</text></g>)}
 </svg></FontContext.Provider>;
}
