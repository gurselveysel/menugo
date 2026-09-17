export {money} from '@/components/transport';
export const CATEGORIES=[
{id:'sandvic',title:'Sandviçler',en:'Sandwiches',symbol:'🥪',image:'/media/sariyer-wide.avif',pos:'14% 60%'},
{id:'kahvalti',title:'Kahvaltı',en:'Breakfast',symbol:'🍳',image:'/media/hero.avif',pos:'15% 60%'},
{id:'tatli',title:'Waffle & Tatlı',en:'Waffle & Desserts',symbol:'🧇',image:'/media/sariyer-wide.avif',pos:'52% 60%'},
{id:'atistirmalik',title:'Atıştırmalıklar',en:'Snacks',symbol:'🍟',image:'/media/hero.avif',pos:'80% 60%'},
{id:'sicak',title:'Sıcak İçecekler',en:'Hot Drinks',symbol:'☕',image:'/media/hero.avif',pos:'50% 50%'},
{id:'soguk',title:'Soğuk İçecekler',en:'Cold Drinks',symbol:'🥤',image:'/media/hero.avif',pos:'50% 50%'},
{id:'borek',title:'Börekler',en:'Börek',symbol:'🥐',image:'/media/hero.avif',pos:'10% 60%'}];
export function catTitle(id:string){return CATEGORIES.find(c=>c.id===id)?.title??id;}
