export type VoiceCatalogueItem={id:string;name:string;options?:string[];priceMinor:string|null;canOrder:boolean;available?:boolean;priceApproved?:boolean};
export type VoiceDraftLine={productId:string;productName:string;quantity:number;option:string|null;unitPriceMinor:string;lineTotalMinor:string};
export type VoiceDraftIssue={productName:string;code:'NOT_ORDERABLE'|'OPTION_REQUIRED'|'OPTION_AMBIGUOUS'|'AMBIGUOUS_PRODUCT'|'QUANTITY_LIMIT';detail:string};
export type VoiceDraft={transcript:string;lines:VoiceDraftLine[];issues:VoiceDraftIssue[];totalMinor:string;reviewRequired:true;autoSubmitted:false};

const NUMBER_WORDS:Record<string,number>={bir:1,iki:2,uc:3,dort:4,bes:5,alti:6,yedi:7,sekiz:8,dokuz:9,on:10,onbir:11,oniki:12,onuc:13,ondort:14,onbes:15,onalti:16,onyedi:17,onsekiz:18,ondokuz:19,yirmi:20};
function fold(value:string){return value.toLocaleLowerCase('tr-TR').replace(/[çÇ]/g,'c').replace(/[ğĞ]/g,'g').replace(/[ıİ]/g,'i').replace(/[öÖ]/g,'o').replace(/[şŞ]/g,'s').replace(/[üÜ]/g,'u').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
function orderable(item:VoiceCatalogueItem){return item.canOrder===true&&item.priceMinor!==null&&/^(0|[1-9][0-9]{0,18})$/.test(item.priceMinor);}
function quantityBefore(text:string,start:number){const prefix=text.slice(Math.max(0,start-36),start).trim();const token=prefix.split(/\s+/).at(-1)?.replace(/[^a-z0-9]/g,'')??'';if(/^\d{1,2}$/.test(token))return Number(token);return NUMBER_WORDS[token]??1;}

type Mention={start:number;end:number;item:VoiceCatalogueItem;nameKey:string};
function mentions(transcriptKey:string,items:readonly VoiceCatalogueItem[]):Mention[]{const all:Mention[]=[];for(const item of items){const key=fold(item.name);if(key.length<2)continue;let from=0;for(;;){const i=transcriptKey.indexOf(key,from);if(i<0)break;const left=i===0?' ':transcriptKey[i-1],right=i+key.length>=transcriptKey.length?' ':transcriptKey[i+key.length];if(left===' '&&right===' ')all.push({start:i,end:i+key.length,item,nameKey:key});from=i+Math.max(1,key.length);}}all.sort((a,b)=>a.start-b.start||(b.end-b.start)-(a.end-a.start)||a.item.id.localeCompare(b.item.id));const picked:Mention[]=[];for(const m of all){const clash=picked.some(x=>m.start<x.end&&m.end>x.start);if(!clash)picked.push(m);}return picked;}

export function buildVoiceDraft(transcript:string,items:readonly VoiceCatalogueItem[]):VoiceDraft{
 if(typeof transcript!=='string'||transcript.trim().length<1||transcript.length>1000)throw Error('INVALID_TRANSCRIPT');
 const clean=transcript.trim();const key=fold(clean);const orderableItems=items.filter(orderable);const byName=new Map<string,VoiceCatalogueItem[]>();for(const item of items){const k=fold(item.name);byName.set(k,[...(byName.get(k)??[]),item]);}
 const found=mentions(key,items);const lines:VoiceDraftLine[]=[];const issues:VoiceDraftIssue[]=[];let total=0n;
 for(let i=0;i<found.length;i++){
  const m=found[i];const same=byName.get(m.nameKey)??[];if(same.length>1){issues.push({productName:m.item.name,code:'AMBIGUOUS_PRODUCT',detail:'Aynı adla birden fazla katalog ürünü bulundu; seçim kullanıcı tarafından netleştirilmeli.'});continue;}
  if(!orderable(m.item)){issues.push({productName:m.item.name,code:'NOT_ORDERABLE',detail:'Ürün şu anda doğrulanmış fiyatla siparişe açık değil.'});continue;}
  const qty=quantityBefore(key,m.start);if(!Number.isInteger(qty)||qty<1||qty>20){issues.push({productName:m.item.name,code:'QUANTITY_LIMIT',detail:'Adet 1–20 aralığında olmalı.'});continue;}
  const prevEnd=i?found[i-1].end:Math.max(0,m.start-36),nextStart=i+1<found.length?found[i+1].start:Math.min(key.length,m.end+80);const segment=key.slice(prevEnd,nextStart);
  const opts=(m.item.options??[]).filter(x=>typeof x==='string'&&x.trim()).map(raw=>({raw,key:fold(raw)}));const matched=opts.filter(o=>o.key&&segment.includes(o.key));let option:string|null=null;
  if(opts.length){if(matched.length===0){issues.push({productName:m.item.name,code:'OPTION_REQUIRED',detail:'Bu ürün için seçenek belirtilmeli.'});continue;}if(matched.length>1){issues.push({productName:m.item.name,code:'OPTION_AMBIGUOUS',detail:'Birden fazla seçenek algılandı; kullanıcı seçim yapmalı.'});continue;}option=matched[0].raw;}
  const unit=m.item.priceMinor!;const lineTotal=BigInt(unit)*BigInt(qty);const existing=lines.find(x=>x.productId===m.item.id&&x.option===option);if(existing){const merged=existing.quantity+qty;if(merged>20){issues.push({productName:m.item.name,code:'QUANTITY_LIMIT',detail:'Aynı ürün için toplam adet 20’yi aşamaz.'});continue;}total-=BigInt(existing.lineTotalMinor);existing.quantity=merged;existing.lineTotalMinor=(BigInt(unit)*BigInt(merged)).toString();total+=BigInt(existing.lineTotalMinor);}else if(lines.length<30){lines.push({productId:m.item.id,productName:m.item.name,quantity:qty,option,unitPriceMinor:unit,lineTotalMinor:lineTotal.toString()});total+=lineTotal;}
 }
 return {transcript:clean,lines,issues,totalMinor:total.toString(),reviewRequired:true,autoSubmitted:false};
}
