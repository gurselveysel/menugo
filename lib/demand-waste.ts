export const WASTE_REASONS=[
 ['prep','Hazırlık firesi'],['spoilage','Bozulma / son kullanma'],['return','İade / servis dönüşü'],['other','Diğer']
] as const;
export type WasteReason=(typeof WASTE_REASONS)[number][0];
export function decimalUnitsToMilli(raw:string):number{
 const v=raw.trim().replace(',','.');
 if(!/^\d{1,3}(?:\.\d{1,3})?$/.test(v))throw new Error('INVALID_WASTE_QUANTITY');
 const[whole,frac='']=v.split('.');const n=Number(whole)*1000+Number(frac.padEnd(3,'0'));
 if(!Number.isSafeInteger(n)||n<1||n>999000)throw new Error('INVALID_WASTE_QUANTITY');
 return n;
}
export function milliToUnits(raw:string|number):string{
 let n:bigint;try{n=typeof raw==='number'?BigInt(raw):BigInt(raw);}catch{throw new Error('INVALID_MILLI');}
 if(n<0n)throw new Error('INVALID_MILLI');const whole=n/1000n,rem=n%1000n,frac=String(rem).padStart(3,'0').replace(/0+$/,'');return frac?`${whole},${frac}`:String(whole);
}
