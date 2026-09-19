export type CustomerMenuItem={
  id:string;
  name:string;
  category?:string|null;
  subcategory?:string|null;
  description?:string|null;
  priceMinor:string|null;
  available:boolean;
  priceApproved:boolean;
  canOrder?:boolean;
  quantityLabel?:string|null;
};
export type MenuAssistantProduct={id:string;name:string;category:string|null;description:string|null;priceMinor:string;quantityLabel:string|null};
export type MenuAssistantResult={
  answer:string;
  products:MenuAssistantProduct[];
  needsStaff:boolean;
  source:'published_catalogue';
  modelUsed:false;
  stored:false;
  budgetMinor:string|null;
};

const stop=new Set(['ne','neler','var','mi','mı','mu','mü','bir','bana','ben','icin','için','ile','ve','veya','da','de','bu','şu','o','olan','olarak','istiyorum','isterim','bul','goster','göster','oner','öner','yiyebilirim','icebilirim','içebilirim','alabilirim','menu','menü','urun','ürün','secenek','seçenek','fiyat','fiyati','fiyatı','kadar','alti','altı','altinda','altında','butce','bütçe','liraya','lira','tl','try','₺']);
const allergenTerms=['alerji','alerjen','allergy','gluten','glutensiz','laktoz','laktozsuz','sut alerj','süt alerj','findik alerj','fındık alerj','fistik alerj','fıstık alerj','yumurta alerj','susam alerj','soya alerj','capraz temas','çapraz temas','anafilaksi'];
const categoryHints:Record<string,string[]>= {
  sandvic:['sandvic','sandviç'],kahvalti:['kahvalti','kahvaltı'],tatli:['tatli','tatlı'],atistirmalik:['atistirmalik','atıştırmalık'],sicak:['sicak','sıcak'],soguk:['soguk','soğuk','icecek','içecek'],borek:['borek','börek']
};
function norm(v:string){return v.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i').replace(/ş/g,'s').replace(/ğ/g,'g').replace(/ç/g,'c').replace(/ö/g,'o').replace(/ü/g,'u').replace(/[^a-z0-9₺]+/g,' ').trim();}
function safePrice(v:string|null){return typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)?BigInt(v):null;}
function budget(question:string){
 const q=norm(question);const cue=/\b(butce|kadar|altinda|alti|gecmesin|asmasin|harcayabilirim|liraya|tl|try)\b/.test(q)||question.includes('₺');if(!cue)return null;
 const raw=question.toLocaleLowerCase('tr-TR');const m=raw.match(/(?:^|\s)([0-9]{1,6})(?:[.,]([0-9]{1,2}))?\s*(?:tl|try|lira|liraya|₺)?(?:\s|$)/);if(!m)return null;
 const whole=BigInt(m[1]);const fraction=BigInt((m[2]??'').padEnd(2,'0').slice(0,2)||'0');const minor=whole*100n+fraction;return minor<=9223372036854775807n?minor:null;
}
function categoryFilter(q:string){const found:string[]=[];for(const [category,hints] of Object.entries(categoryHints))if(hints.some(h=>q.includes(norm(h))))found.push(category);if(q.includes('icebil'))for(const category of ['sicak','soguk'])if(!found.includes(category))found.push(category);return found;}
function topicalTokens(question:string){return norm(question).split(/\s+/).filter(x=>x.length>1&&!stop.has(x)&&!/^[0-9]+$/.test(x));}
function score(item:CustomerMenuItem,tokens:string[],categories:string[]){
 const name=norm(item.name),desc=norm(item.description??''),sub=norm(item.subcategory??''),cat=norm(item.category??'');let s=0;
 for(const t of tokens){if(name===t)s+=8;else if(name.includes(t))s+=5;if(sub.includes(t))s+=3;if(desc.includes(t))s+=2;if(cat.includes(t))s+=2;}
 if(categories.includes(item.category??''))s+=4;return s;
}
export function answerMenuQuestion(question:string,items:CustomerMenuItem[]):MenuAssistantResult{
 const q=norm(question);const limit=budget(question);const needsStaff=allergenTerms.some(x=>q.includes(norm(x)));
 const categories=categoryFilter(q),tokens=topicalTokens(question);const cheapest=/\b(en ucuz|ucuz|uygun fiyat|ekonomik)\b/.test(q);const broad=limit!==null||cheapest||categories.length>0;
 let candidates=items.map(item=>({item,price:safePrice(item.priceMinor)})).filter((x):x is {item:CustomerMenuItem;price:bigint}=>x.price!==null&&x.item.available&&x.item.priceApproved&&x.item.canOrder!==false);
 if(limit!==null)candidates=candidates.filter(x=>x.price<=limit);
 const ranked=candidates.map(x=>({...x,score:score(x.item,tokens,categories)}));
 const hasSignal=tokens.length>0||categories.length>0;
 let selected=hasSignal?ranked.filter(x=>x.score>0):broad?ranked:[];
 selected.sort((a,b)=>cheapest||limit!==null?(a.price<b.price?-1:a.price>b.price?1:b.score-a.score||a.item.name.localeCompare(b.item.name,'tr')):(b.score-a.score)||(a.price<b.price?-1:a.price>b.price?1:a.item.name.localeCompare(b.item.name,'tr')));
 selected=selected.slice(0,5);
 const products=selected.map(({item,price})=>({id:item.id,name:item.name,category:item.category??null,description:item.description??null,priceMinor:price.toString(),quantityLabel:item.quantityLabel??null}));
 let answer:string;
 if(needsStaff)answer=products.length?'Alerjen veya çapraz temas güvenliği konusunda menü verisinden kesin sonuç veremem. Aşağıdaki eşleşmeler yalnız yayımlanmış ürün adı ve açıklamasına dayanır; siparişten önce personelden doğrulama isteyin.':'Alerjen veya çapraz temas güvenliği konusunda menü verisinden kesin sonuç veremem. Yayımlanmış menüde sorunuza güvenle eşleştirebildiğim bir ürün yok; siparişten önce personelden doğrulama isteyin.';
 else if(!products.length)answer='Yayımlanmış ve siparişe açık menüde bu soruya güvenle eşleştirebildiğim bir ürün bulamadım. Menü aramasını kullanabilir veya personele danışabilirsiniz.';
 else if(limit!==null)answer='Yayımlanmış menüde belirttiğiniz bütçeyi aşmayan siparişe açık eşleşmeleri gösteriyorum.';
 else if(cheapest)answer='Yayımlanmış menüde sorunuzla eşleşen siparişe açık seçenekleri düşük fiyattan başlayarak gösteriyorum.';
 else answer='Yayımlanmış menüde sorunuzla eşleşen siparişe açık seçenekleri gösteriyorum.';
 return {answer,products,needsStaff,source:'published_catalogue',modelUsed:false,stored:false,budgetMinor:limit?.toString()??null};
}
