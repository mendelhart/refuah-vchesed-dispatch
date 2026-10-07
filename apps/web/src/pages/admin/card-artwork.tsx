import React from 'react';
export interface CardFields {
  name: string; number: string; photo: string | null; plate: string; unit: string; expiry: string;
  termsFr: string; termsEn: string;
}
export const initialCardFields: CardFields = {
  name: 'SAMPLE VOLUNTEER', number: 'SAMPLE-ID', photo: null, plate: 'SAMPLE', unit: 'SAMPLE', expiry: '',
  termsFr: "Cette carte identifie un bénévole de Refuah V’Chesed. Elle est personnelle et non transférable. Utilisez-la uniquement dans le cadre des activités bénévoles autorisées par l’organisation. Respectez la confidentialité des patients et les règles de l’établissement. Signalez toute perte à Refuah V’Chesed. Cette carte ne confère aucun privilège de circulation, de stationnement ou d’accès.",
  termsEn: "This card identifies a Refuah V’Chesed volunteer. It is personal and non-transferable. Use it only for volunteer activities approved by the organization. Respect patient privacy and facility rules. Report a lost card to Refuah V’Chesed. This card grants no traffic, parking or access privileges.",
};
export type Face = 'volunteer-front' | 'volunteer-back' | 'vehicle-front' | 'vehicle-back';
const R = '#ed1925';
const logo = '/brand/cards/rvc-logo.svg';
const heart = '/brand/cards/rvc-heart.svg';
const font = 'CardCondensed, sans-serif';
const FontContext = React.createContext(font);
function Text({x,y,size=28,fill='black',bold=false,anchor='start',children}:{x:number;y:number;size?:number;fill?:string;bold?:boolean;anchor?:'start'|'middle'|'end';children:React.ReactNode}) {
  return <text x={x} y={y} fontSize={size} fill={fill} fontWeight={bold?700:400} textAnchor={anchor} fontFamily={React.useContext(FontContext)}>{children}</text>;
}
function Lines({x,y,width,text,size=25,line=33,bold=false}:{x:number;y:number;width:number;text:string;size?:number;line?:number;bold?:boolean}) {
  // Conservative wrap: the condensed font is <= 0.55 em for ordinary letters.
  const max=Math.floor(width/(size*.5)); const rows:string[]=[]; let row='';
  for(const word of text.split(/\s+/)){if((row+' '+word).length>max&&row){rows.push(row);row=word;}else row+=(row?' ':'')+word;} if(row)rows.push(row);
  return <>{rows.map((v,i)=><Text key={i} x={x} y={y+i*line} size={size} bold={bold}>{v}</Text>)}</>;
}
function Draft({w,h}:{w:number;h:number}) {return <g opacity="0.20"><text transform={`translate(${w/2},${h/2}) rotate(-30)`} textAnchor="middle" fontFamily={font} fontWeight="700" fontSize={w*.115} fill="#333">DRAFT · NOT VALID</text></g>;}
function Stripe({bottom=false}:{bottom?:boolean}) {return <g transform={bottom?'translate(1250,800) rotate(180)':undefined}><path d="M0 0H1250V60H0Z" fill="#262626"/><path d="M0 0H515L490 25H0Z" fill={R}/><path d="M0 27H897L925 0H967L912 60H0Z" fill="#d6d6d6"/><path d="M0 51H910L960 0" fill="none" stroke={R} strokeWidth="2"/><path d="M1190 60L1250 0V60Z" fill={R}/></g>;}
export function CardArtwork({face,fields}:{face:Face;fields:CardFields}):React.JSX.Element {
 const id=face.startsWith('volunteer');const w=id?855:1250;const h=id?1355:800;const expiry=fields.expiry?fields.expiry.split('-').reverse().join('/'):'À CONFIRMER';
 const unique=React.useId().replace(/:/g,'');
 return <FontContext.Provider value={id?font:'VehicleCondensed, sans-serif'}><svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${w} ${h}`} aria-label={face} style={{display:'block',width:'100%',height:'auto'}}>
 <defs><radialGradient id={`bg${unique}`} cx="50%" cy="40%" r="80%"><stop offset="0" stopColor="white"/><stop offset="1" stopColor="#d8d9dc"/></radialGradient><pattern id={`p${unique}`} width="260" height="250" patternUnits="userSpaceOnUse" patternTransform="rotate(-15)"><image href={heart} width="125" height="125" x="60" y="55" opacity=".14"/></pattern><clipPath id={`c${unique}`}><rect x="236" y="281" width="382" height="500" rx="20"/></clipPath></defs>
 <rect width={w} height={h} fill={id?"white":`url(#bg${unique})`}/>
 {id?<><rect width={w} height={h} fill={`url(#p${unique})`}/><path d="M0 0H855V302Q490 295 0 474Z" fill="#b31d27"/><path d="M0 0H855V302Q475 350 0 235Z" fill={R}/><path d="M0 1185Q315 1400 855 1148V1355H0Z" fill="#b31d27"/><path d="M0 1268Q520 1305 855 1148V1355H0Z" fill={R}/></>:<><Stripe/><Stripe bottom/></>}
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
 <rect x="55" y="350" width="745" height="825" fill="white" opacity=".94"/>
 <Lines x={85} y={407} width={685} text={fields.termsFr} size={fields.termsFr.length>450?22:27} line={fields.termsFr.length>450?30:35}/>
 <Lines x={85} y={787} width={685} text={fields.termsEn} size={27} line={35}/>
 <Text x={85} y={1090} size={32} bold fill={R}>SI TROUVÉE · IF FOUND</Text>
 <Text x={85} y={1130} size={29}>514 357 2167 · info@refuahvchesed.org</Text>
 <Text x={427} y={1318} size={29} fill="white" anchor="middle">Texte proposé · Wording for review</Text>
 </>}
 {face==='vehicle-front'&&<>
 <image href="/brand/cards/chesed-on-the-go.svg" x="44" y="70" width="404" height="242"/>
 <Text x={853} y={143} size={57} fill="#e60000" bold anchor="middle">SERVICES DE</Text><Text x={853} y={211} size={57} fill="#e60000" bold anchor="middle">TRANSPORT HOSPITALIER</Text><Text x={853} y={274} size={49} bold anchor="middle">BÉNÉVOLES CHESED ON THE GO</Text>
 <image href="/brand/cards/fleur.svg" x="56" y="312" width="261" height="320"/><image href="/brand/cards/accessibility.svg" x="1035" y="374" width="180" height="270"/>
 <rect x="294" y="347" width="666" height="66" fill="black"/>
 <Text x={627} y={393} size={36} bold fill="white" anchor="middle">VÉHICULE DE RÉPONSE AUTORISÉ</Text>
 <rect x="242" y="434" width="467" height="212" fill="white" stroke="#666" strokeWidth="3"/><Text x={475} y={482} size={38} fill="#555" anchor="middle">PRÉPARÉ POUR LA PLAQUE</Text><Text x={475} y={530} size={38} fill="#555" anchor="middle">D’IMMATRICULATION:</Text><Text x={475} y={617} size={Math.min(92,690/Math.max(1,fields.plate.length))} bold fill="#ee0000" anchor="middle">{fields.plate||'À CONFIRMER'}</Text>
 <rect x="779" y="473" width="204" height="173" fill="white" stroke="#666" strokeWidth="3"/><Text x={881} y={523} size={37} fill="#555" anchor="middle">ID UNITÉ</Text><Text x={881} y={617} size={Math.min(88,300/Math.max(1,fields.unit.length))} bold fill="#ee0000" anchor="middle">{fields.unit||'À CONFIRMER'}</Text>
 <Text x={95} y={731} size={35} fill="#555">Exp. {expiry}</Text><image href="/brand/cards/rvc-original-compact.svg" x="930" y="657" width="245" height="85"/>
 </>}
 {face==='vehicle-back'&&<>
 <Text x={64} y={115} size={23}>The owner of this vehicle is part of the Refuah V’Chesed Organization’s Chesed on the Go volunteer program, providing</Text>
 <Text x={64} y={147} size={23}>free transportation for patients and their family members to and from hospitals in the Montreal, Quebec area.</Text>
 <Text x={64} y={196} size={23}>We kindly request that law enforcement officials be sensitive to the important community service this member is</Text>
 <Text x={64} y={228} size={23}>offering. Thank you!</Text>
 <path d="M493 263H764" stroke={R} strokeDasharray="8 4"/>
 <Lines x={64} y={311} width={1123} size={25} line={32} bold text="Le propriétaire de ce véhicule fait partie du programme de bénévolat Chesed on the Go de l’organisation Refuah V’Chesed, offrant un transport gratuit aux patients et à leurs familles vers et en provenance des hôpitaux de la région de Montréal, Québec."/>
 <Lines x={64} y={425} width={1123} size={25} line={32} bold text="Nous demandons respectueusement aux agents de la loi d’être attentifs au service communautaire que ce membre fournit. Merci!"/>
 <Text x={625} y={491} size={25} bold anchor="middle">Cette carte est la propriété de :</Text><Text x={625} y={526} size={31} bold fill={R} anchor="middle">REFUAH V’CHESED</Text>
 <image href="/brand/cards/rvc-original-compact.svg" x="103" y="572" width="292" height="122"/>
 <Text x={1183} y={576} size={27} bold fill={R} anchor="end">SI TROUVÉ, VEUILLEZ RETOURNER À :</Text>
 <Text x={1183} y={612} size={25} anchor="end">420, rue Beaubien O, bureau 101</Text>
 <Text x={1183} y={645} size={25} anchor="end">Montréal, QC, H2V 4S6</Text>
 <Text x={1183} y={678} size={25} anchor="end">Numéro de téléphone : 514 357 2167</Text>
 <Text x={1183} y={711} size={25} anchor="end">Adresse e-mail : info@refuahvchesed.org</Text>
 </>}
 {id?<Draft w={w} h={h}/>:<g><rect x="490" y="774" width="270" height="22" rx="3" fill="white" opacity=".95"/><text x="625" y="790" textAnchor="middle" fontFamily={font} fontSize="16" fill="#555">REVIEW DRAFT · NOT VALID</text></g>}
 </svg></FontContext.Provider>;
}
