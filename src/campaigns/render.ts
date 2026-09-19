import QRCode from 'qrcode';
import {FORMATS,formatMinor,type CampaignSnapshot,type CampaignFormat} from './contracts';
const LOGO='/media/sariyer-brand-transparent-r8.webp';
const PLATFORM='/media/menugo-transparent-r8.png';
async function image(src:string){
 const img=new Image();img.src=src;await img.decode();if(!img.naturalWidth)throw Error('LOGO_UNAVAILABLE');return img;
}
function contain(ctx:CanvasRenderingContext2D,img:HTMLImageElement,x:number,y:number,w:number,h:number){
 const scale=Math.min(w/img.naturalWidth,h/img.naturalHeight);const iw=img.naturalWidth*scale,ih=img.naturalHeight*scale;
 ctx.drawImage(img,x+(w-iw)/2,y+(h-ih)/2,iw,ih);
}
function lines(ctx:CanvasRenderingContext2D,text:string,width:number){
 const out:string[]=[];let line='';
 for(const word of text.trim().split(/\s+/u)){
  if(ctx.measureText(word).width>width)throw Error('TEXT_DOES_NOT_FIT');
  const candidate=line?line+' '+word:word;
  if(ctx.measureText(candidate).width>width){out.push(line);line=word;}else line=candidate;
 }
 if(line)out.push(line);return out;
}
function fitText(ctx:CanvasRenderingContext2D,text:string,x:number,y:number,width:number,maxLines:number,maxSize:number,minSize:number){
 for(let size=maxSize;size>=minSize;size-=2){
  ctx.font=`700 ${size}px Arial, sans-serif`;
  let wrapped:string[];try{wrapped=lines(ctx,text,width);}catch{continue;}
  if(wrapped.length>maxLines)continue;
  wrapped.forEach((line,i)=>ctx.fillText(line,x,y+i*size*1.18));return wrapped.length*size*1.18;
 }
 throw Error('TEXT_DOES_NOT_FIT');
}
/** Exact brand layers + typography, NOT a synthetic photograph or AI image result. */
export async function renderCampaign(canvas:HTMLCanvasElement,s:CampaignSnapshot,format:CampaignFormat):Promise<void>{
 const {width:w,height:h}=FORMATS[format];canvas.width=w;canvas.height=h;
 const ctx=canvas.getContext('2d');if(!ctx)throw Error('CANVAS_UNAVAILABLE');
 const [logo,platform,qr]=await Promise.all([image(LOGO),image(PLATFORM),QRCode.toDataURL(s.productUrl,{width:230,margin:4,errorCorrectionLevel:'M'}).then(image)]);
 ctx.fillStyle='#181716';ctx.fillRect(0,0,w,h);ctx.fillStyle='#d1a251';ctx.fillRect(76,format==='story'?360:286,w-152,3);
 contain(ctx,logo,180,format==='story'?150:76,720,180);
 const top=format==='story'?455:366;
 ctx.textAlign='center';ctx.fillStyle='#dfbe84';ctx.font='600 24px Arial, sans-serif';ctx.fillText(s.branchName.toLocaleUpperCase('tr-TR'),w/2,top);
 ctx.fillStyle='#ffffff';fitText(ctx,s.name,w/2,top+104,884,3,82,40);
 ctx.font='400 27px Arial, sans-serif';ctx.fillStyle='#e4d9c6';
 fitText(ctx,s.quantityLabel||'Menümüzden',w/2,top+365,860,2,30,22);
 ctx.fillStyle='#e9c481';fitText(ctx,formatMinor(s.priceMinor),w/2,top+497,880,2,91,44);
 if(s.options.length){ctx.font='400 23px Arial, sans-serif';ctx.fillStyle='#e4d9c6';ctx.fillText('Seçenekleri menümüzde inceleyin.',w/2,top+576);}
 const footer=h-332;ctx.fillStyle='#ffffff';ctx.fillRect(0,footer,w,332);
 contain(ctx,qr,78,footer+44,220,220);
 ctx.textAlign='left';ctx.fillStyle='#1e2630';ctx.font='700 31px Arial, sans-serif';ctx.fillText('Menümüzü keşfedin',346,footer+102);
 ctx.font='400 23px Arial, sans-serif';ctx.fillText('QR kodu kameranızla okutun.',346,footer+146);
 contain(ctx,platform,346,footer+192,410,85);
}
export async function campaignBlob(canvas:HTMLCanvasElement){return new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('EXPORT_FAILED')),'image/png'));}
