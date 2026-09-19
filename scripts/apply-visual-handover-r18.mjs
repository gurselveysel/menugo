// One-time scoped integration, run on the release branch before acceptance.
// Existing login, QR, order, payment, data and permission logic is untouched.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const expected={
 'components/GuestTable.tsx':'6d19e6e2ba9beda3fd1d552840e334fe210ec138adda5e3ccd6913c28697d50a',
 'lib/config.ts':'3a5cf1d2a3dc765e261672cb708d150ccb61ac392e33dc5a7f69ddf179510bdc',
 'public/release.json':'49cf5b39e1b8376ff3d915c849b78832ef57e979ba2f6aa011628f0c43601471'
};
for(const [file,hash]of Object.entries(expected)){
 if(createHash('sha256').update(readFileSync(file)).digest('hex')!==hash)throw Error('Source changed; review required: '+file);
}
function once(text,from,to){if(text.split(from).length!==2)throw Error('Expected exactly one replacement: '+from);return text.replace(from,to);}
let guest=readFileSync('components/GuestTable.tsx','utf8');
guest=once(guest,"import MenuGoLogo from '@/components/MenuGoLogo';","import MenuGoLogo from '@/components/MenuGoLogo';\nimport {GuestWelcomeExperience,MenuSelectionVisual} from './GuestWelcomeExperience';");
guest=once(guest,'<main className="guest-welcome">','<GuestWelcomeExperience>');
guest=once(guest,'Kısa süreli ziyaret QR’siyle de katılabilirsiniz.</p></main>','Kısa süreli ziyaret QR’siyle de katılabilirsiniz.</p></GuestWelcomeExperience>');
guest=once(guest,'<article className="guest-product" key={p.id}>','<article className="guest-product" key={p.id}><MenuSelectionVisual item={p}/>');
writeFileSync('components/GuestTable.tsx',guest);
let config=readFileSync('lib/config.ts','utf8');
config=once(config,"export const RELEASE='menugo-editorial-branding-20260919-r17';","export const RELEASE='menugo-visual-handover-20260919-r18';");
writeFileSync('lib/config.ts',config);
const manifest=JSON.parse(readFileSync('public/release.json','utf8'));
manifest.previous=manifest.version;manifest.version='menugo-visual-handover-20260919-r18';
manifest.visualOrderingWelcome=true;manifest.visualOrderingProductCards=true;
manifest.canonicalBrandSurfaces=true;manifest.cataloguePricesUnchanged=true;
writeFileSync('public/release.json',JSON.stringify(manifest,null,2)+'\n');
console.log('Integrated presentation-only changes. No API, SQL, auth, prices or original logo files changed.');
