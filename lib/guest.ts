import 'server-only';
import {cookies} from 'next/headers';
import {client,Failure} from './api';
export function guestCookie(id:string){return 'menugo_visit_'+id;}
export async function guestContext(checkId:string){
 const secret=(await cookies()).get(guestCookie(checkId))?.value;
 if(!secret||!/^[0-9a-f]{64}$/.test(secret))throw new Failure('GUEST_SESSION_REQUIRED',401);
 return {s:await client(),secret};
}
