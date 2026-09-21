import {StudioError} from './operations';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INT=/^(0|[1-9][0-9]{0,18})$/;
const POS=/^[1-9][0-9]{0,18}$/;
const MAX=9223372036854775807n;
const record=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new StudioError('INVALID_COST_INPUT');return v as Record<string,unknown>;};
const exact=(v:Record<string,unknown>,keys:readonly string[])=>{if(Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))throw new StudioError('INVALID_COST_INPUT');};
const id=(v:unknown)=>{if(typeof v!=='string'||!UUID.test(v))throw new StudioError('INVALID_COST_INPUT');return v;};
const integer=(v:unknown,positive=false)=>{if(typeof v!=='string'||!(positive?POS:INT).test(v)||BigInt(v)>MAX)throw new StudioError('INVALID_COST_INPUT');return v;};
const clean=(v:unknown,max:number)=>{if(typeof v!=='string'){throw new StudioError('INVALID_COST_INPUT');}const out=v.normalize('NFC').trim();if(!out||out.length>max||/[\u0000-\u001f\u007f]/.test(out))throw new StudioError('INVALID_COST_INPUT');return out;};

export type PurchasePostCommand={action:'post-invoice';payload:{operationId:string;jobId:string;revision:string;confirmed:true}};
export type RecipeSaveCommand={action:'save-recipe';payload:{operationId:string;productId:string;name:string;portions:number;overheadMinor:string;ingredients:{name:string;unit:'g'|'ml'|'piece';packQuantity:string;packCostMinor:string;recipeQuantity:string;edibleYieldBps:number}[];confirmed:true}};
export type CostLedgerCommand=PurchasePostCommand|RecipeSaveCommand;

export function readCostLedgerCommand(value:unknown):CostLedgerCommand{
 const v=record(value),action=v.action;
 if(action==='post-invoice'){
  exact(v,['action','operationId','jobId','revision','confirmed']);
  if(v.confirmed!==true)throw new StudioError('INVALID_COST_INPUT');
  return {action,payload:{operationId:id(v.operationId),jobId:id(v.jobId),revision:integer(v.revision),confirmed:true}};
 }
 if(action==='save-recipe'){
  exact(v,['action','operationId','productId','name','portions','overheadMinor','ingredients','confirmed']);
  if(v.confirmed!==true||!Number.isSafeInteger(v.portions)||Number(v.portions)<1||Number(v.portions)>1000||!Array.isArray(v.ingredients)||v.ingredients.length<1||v.ingredients.length>100)throw new StudioError('INVALID_COST_INPUT');
  const ingredients=v.ingredients.map(raw=>{const x=record(raw);exact(x,['name','unit','packQuantity','packCostMinor','recipeQuantity','edibleYieldBps']);if(!['g','ml','piece'].includes(String(x.unit))||!Number.isSafeInteger(x.edibleYieldBps)||Number(x.edibleYieldBps)<1||Number(x.edibleYieldBps)>10000)throw new StudioError('INVALID_COST_INPUT');return {name:clean(x.name,160),unit:x.unit as 'g'|'ml'|'piece',packQuantity:integer(x.packQuantity,true),packCostMinor:integer(x.packCostMinor),recipeQuantity:integer(x.recipeQuantity,true),edibleYieldBps:Number(x.edibleYieldBps)};});
  return {action,payload:{operationId:id(v.operationId),productId:id(v.productId),name:clean(v.name,120),portions:Number(v.portions),overheadMinor:integer(v.overheadMinor),ingredients,confirmed:true}};
 }
 throw new StudioError('INVALID_COST_INPUT');
}
