/** A role label never grants access. Destinations are derived from server-verified roles. */
export function safeDestination(value:string|null):string|null {
 if(!value || value.length>500 || /[\\\u0000-\u0020]/.test(value))return null;
 try {
  const u=new URL(value,'https://menugo.invalid');
  if(u.origin!=='https://menugo.invalid'||u.hash||!value.startsWith('/')||value.startsWith('//'))return null;
  if(!['/siparis','/hesabim','/isletme','/garson','/mutfak','/kasa','/panel','/parola','/yardim','/platform','/platform/ayarlar','/platform/yapay-zeka'].includes(u.pathname))return null;
  return u.pathname+u.search;
 }catch{return null;}
}
export function accountDestination(actualRole:string|null,selectedRole:string,next:string|null):string {
 const wanted=safeDestination(next),path=wanted?.split('?')[0];
 const owner=actualRole==='owner'||actualRole==='manager';
 const allowed=new Set(['/hesabim','/siparis','/parola','/yardim']);
 if(owner){for(const p of ['/isletme','/panel','/garson','/mutfak','/kasa'])allowed.add(p);}
 if(actualRole==='waiter')allowed.add('/garson');
 if(actualRole==='kitchen')allowed.add('/mutfak');
 if(actualRole==='cashier')allowed.add('/kasa');
 if(wanted&&path&&allowed.has(path))return wanted;
 if(selectedRole==='customer')return '/hesabim';
 if(owner)return '/isletme';
 if(actualRole==='waiter')return '/garson';
 if(actualRole==='kitchen')return '/mutfak';
 if(actualRole==='cashier')return '/kasa';
 return '/hesabim';
}
