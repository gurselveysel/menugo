import {ImportError,minor,matchProduct,type Draft} from './contracts';
export interface Product {id:string;name:string;categoryKey:string;subcategory:string;description:string;serving:string;options:string[];priceMinor:string|null;available:boolean;updatedAt:string;}
export interface ReviewRow {name:string;categoryKey:string;description:string;serving:string;priceMinor:string|null;options:string[];sourcePage:number;sourceText:string;warnings:string[];action:'skip'|'create'|'update';targetId:string|null;expectedUpdatedAt:string|null;reviewed:boolean;}
export function initialReview(draft:Draft,products:Product[]):ReviewRow[]{return draft.items.map(r=>{const id=matchProduct(r.name,products),p=products.find(x=>x.id===id);return {...r,categoryKey:p?.categoryKey??'',action:'skip',targetId:id,expectedUpdatedAt:p?.updatedAt??null,reviewed:false};});}
const id=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateReview(v:unknown):ReviewRow[]{
 if(!Array.isArray(v)||v.length>100)throw new ImportError('INVALID_IMPORT_ROWS');
 return v.map(x=>{if(!x||typeof x!=='object')throw new ImportError('INVALID_IMPORT_ROWS');const r=x as ReviewRow;
 for(const [value,max]of[[r.name,250],[r.categoryKey,120],[r.description,1000],[r.serving,120],[r.sourceText,500]]as const)if(typeof value!=='string'||value.length>max||value.includes('\0'))throw new ImportError('INVALID_IMPORT_ROWS');
 if(!r.name.trim()||!['skip','create','update'].includes(r.action)||typeof r.reviewed!=='boolean'||!Array.isArray(r.options)||r.options.length>20||r.options.some(s=>typeof s!=='string'||s.length>100)||!Array.isArray(r.warnings)||r.warnings.length>8||r.warnings.some(s=>typeof s!=='string'||s.length>200))throw new ImportError('INVALID_IMPORT_ROWS');
 if(r.priceMinor!==null)minor(r.priceMinor);
 if(r.targetId!==null&&(typeof r.targetId!=='string'||!id.test(r.targetId)))throw new ImportError('INVALID_IMPORT_ROWS');
 if(r.expectedUpdatedAt!==null&&(typeof r.expectedUpdatedAt!=='string'||!Number.isFinite(Date.parse(r.expectedUpdatedAt))))throw new ImportError('INVALID_IMPORT_ROWS');
 if(r.action==='update'&&(!r.targetId||!r.expectedUpdatedAt))throw new ImportError('INVALID_IMPORT_ROWS');
 if(!Number.isInteger(r.sourcePage)||r.sourcePage<1||r.sourcePage>8)throw new ImportError('INVALID_IMPORT_ROWS');
 return {name:r.name.trim(),categoryKey:r.categoryKey,description:r.description,serving:r.serving,priceMinor:r.priceMinor,options:r.options,sourcePage:r.sourcePage,sourceText:r.sourceText,warnings:r.warnings,action:r.action,targetId:r.targetId,expectedUpdatedAt:r.expectedUpdatedAt,reviewed:r.reviewed};
 });
}
