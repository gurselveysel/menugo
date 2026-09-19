/** Editorial artwork from supplied AI concepts, not verified product photographs.
 * Names/prices/availability always come from the live catalogue. */
export const EDITORIAL_MEDIA='/media/editorial-r17/';
export const CATEGORY_ART:Record<string,{file:string;width:number;height:number;subtitle:string;en:string}>={
 sandvic:{file:'sandwich.webp',width:463,height:266,subtitle:'Günün lezzetli molası',en:'A savoury break'},
 kahvalti:{file:'breakfast.webp',width:249,height:236,subtitle:'Güne güzel bir başlangıç',en:'A delicious start'},
 tatli:{file:'waffle.webp',width:362,height:297,subtitle:'Tatlı bir mola',en:'A sweet moment'},
 sicak:{file:'hot-drinks.webp',width:252,height:175,subtitle:'Çaydan kahveye',en:'Tea and coffee'},
 soguk:{file:'cold-drinks.webp',width:244,height:237,subtitle:'Molaya serin bir eşlikçi',en:'A refreshing break'},
};
export type EditorialProduct={id:string;name:string;category:string;priceMinor:string|null;available:boolean;priceApproved:boolean};
const PICKS=[
 {name:'Sarıyer Özel Sandviç',category:'sandvic'},
 {name:'Kova Waffle',category:'tatli'},
 {name:'Kahvaltı Tabağı',category:'kahvalti'},
 {name:'Limonata',category:'soguk'},
] as const;
export function editorialPicks<T extends EditorialProduct>(items:readonly T[]):T[]{
 // Editorial selection, never an invented bestseller/review claim.
 return PICKS.flatMap(pick=>{
  const item=items.find(x=>x.name.trim().toLocaleLowerCase('tr')===pick.name.toLocaleLowerCase('tr')&&x.category===pick.category);
  return item&&item.available&&item.priceApproved&&item.priceMinor!==null&&/^(0|[1-9][0-9]*)$/.test(item.priceMinor)?[item]:[];
 });
}
export function productArtwork(item:EditorialProduct){
 return PICKS.some(p=>p.name.toLocaleLowerCase('tr')===item.name.trim().toLocaleLowerCase('tr')&&p.category===item.category)?CATEGORY_ART[item.category]:undefined;
}
