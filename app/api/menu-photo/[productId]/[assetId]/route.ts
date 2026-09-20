import {decodePublishedPhoto} from '@/src/studio/photo-bytes';
import {client,failed,json,origin,rpc,scope,uuid} from '@/lib/api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** No arbitrary fetch, SVG, private source image, image URL or paid API is accepted. */
export async function GET(req:Request,ctx:{params:Promise<{productId:string;assetId:string}>}){
 try{
  origin(req);const p=await ctx.params;
  const value=await rpc(await client(),'menu_photo',{...scope,p_product_id:uuid(p.productId),p_asset_id:uuid(p.assetId)});
  if(!value)return json({error:{code:'PHOTO_NOT_FOUND'}},404);
  const output=await decodePublishedPhoto(value);
  return new Response(new Uint8Array(output),{headers:{'Content-Type':'image/webp','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cross-Origin-Resource-Policy':'same-origin'}});
 }catch(e){return failed(e);}
}
