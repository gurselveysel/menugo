export {money} from '@/components/transport';
export const CATEGORIES=[
{id:'sandvic',title:'Sandviçler',en:'Sandwiches',symbol:'🥪',image:'/media/editorial-r17/sandwich.webp',pos:'50% 50%'},
{id:'kahvalti',title:'Kahvaltı',en:'Breakfast',symbol:'🍳',image:'/media/editorial-r17/breakfast.webp',pos:'50% 50%'},
{id:'tatli',title:'Waffle & Tatlı',en:'Waffle & Desserts',symbol:'🧇',image:'/media/editorial-r17/waffle.webp',pos:'50% 50%'},
{id:'atistirmalik',title:'Atıştırmalıklar',en:'Snacks',symbol:'🍟',image:'/media/hero.avif',pos:'80% 60%'},
{id:'sicak',title:'Sıcak İçecekler',en:'Hot Drinks',symbol:'☕',image:'/media/editorial-r17/hot-drinks.webp',pos:'50% 50%'},
{id:'soguk',title:'Soğuk İçecekler',en:'Cold Drinks',symbol:'🥤',image:'/media/editorial-r17/cold-drinks.webp',pos:'50% 50%'},
{id:'borek',title:'Börekler',en:'Börek',symbol:'🥐',image:'/media/hero.avif',pos:'10% 60%'}];
export function catTitle(id:string){return CATEGORIES.find(c=>c.id===id)?.title??id;}
