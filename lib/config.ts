export const BRANCH={businessId:'11111111-1111-4111-8111-111111111111',branchId:'22222222-2222-4222-8222-222222222222'} as const;
export const RELEASE='menugo-assistant-commands-20260921-r33';
export const PUBLIC_HOSTS=new Set(['menugo.app','www.menugo.app','sariyerborekcisi.menugo.app','menugo-tau.vercel.app']);
export function trustedHost(host:string){return PUBLIC_HOSTS.has(host)||(host==='localhost:3000'||host==='localhost:3417')||(process.env.VERCEL_URL!==undefined && host===process.env.VERCEL_URL);}
