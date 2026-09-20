/** Server-only decoding boundary. No network, no model calls, no untrusted image URL. */
import sharp from 'sharp';
import {createHash} from 'node:crypto';
export async function decodePublishedPhoto(value:unknown):Promise<Uint8Array>{
 if(!value||typeof value!=='object')throw Error('INVALID_STORED_PHOTO');
 const v=value as Record<string,unknown>;
 if(v.mime!=='image/webp'||typeof v.data!=='string'||v.data.length>5800000||!v.data.length||typeof v.digest!=='string'||!/^[a-f0-9]{64}$/.test(v.digest))throw Error('INVALID_STORED_PHOTO');
 const data=v.data.replace(/[\r\n]/g,'');
 if(!/^[A-Za-z0-9+/]+={0,2}$/.test(data))throw Error('INVALID_STORED_PHOTO');
 const bytes=Buffer.from(data,'base64');
 if(bytes.length>4194304||bytes.length<20||bytes.toString('base64')!==data||bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,12).toString()!=='WEBP'||createHash('sha256').update(bytes).digest('hex')!==v.digest)throw Error('INVALID_STORED_PHOTO');
 const image=sharp(bytes,{limitInputPixels:4000000,animated:false});const meta=await image.metadata();
 if(meta.format!=='webp'||(meta.pages??1)!==1)throw Error('INVALID_STORED_PHOTO');
 // Re-encode strips metadata and rejects invalid bitstreams before public response.
 return new Uint8Array(await image.rotate().webp({quality:90}).toBuffer());
}
