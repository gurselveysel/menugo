/** Pure display-only selection. Never reprices, adds a line or calculates a cart total. */
export type MenuProduct={id:string;name:string;priceMinor:string|null;available:boolean;priceApproved:boolean;description?:string|null};
export type MenuInfo={productId:string;ingredients:string|null;published:boolean};
export type MenuSort='menu'|'price-asc'|'price-desc'|'name';
export function discover<T extends MenuProduct>(items:readonly T[],info:readonly MenuInfo[],options:{sort:MenuSort;availableOnly:boolean;informationOnly:boolean}):T[]{
 const informed=new Set(info.filter(x=>x.published&&!!x.ingredients?.trim()).map(x=>x.productId));
 const rows=items.filter(x=>(!options.availableOnly||(x.available&&x.priceApproved&&x.priceMinor!==null))&&(!options.informationOnly||informed.has(x.id)));
 if(options.sort==='menu')return rows;
 return rows.sort((a,b)=>{if(options.sort==='name')return a.name.localeCompare(b.name,'tr')||a.id.localeCompare(b.id);
 if(a.priceMinor===null||b.priceMinor===null)return a.priceMinor===b.priceMinor?0:a.priceMinor===null?1:-1;
 const av=BigInt(a.priceMinor),bv=BigInt(b.priceMinor);const cmp=av===bv?0:av<bv?-1:1;return (options.sort==='price-desc'?-cmp:cmp)||a.name.localeCompare(b.name,'tr');});
}
export function productSharePath(id:string):string{if(!/^[0-9a-f-]{36}$/i.test(id))throw Error('INVALID_PRODUCT');return '/bahcesehir?urun='+encodeURIComponent(id);}
/** Spreadsheet formula injection guard. Used only for operator CSV export. */
export function csvCell(input:string|number):string{const s=String(input);const safe=/^[\s]*[=+@\-\t\r]/.test(s)?"'"+s:s;return '"'+safe.replace(/"/g,'""')+'"';}
