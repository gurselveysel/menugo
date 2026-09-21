export type AssistantProduct={id:string;name:string;available:boolean;updatedAt:string};
export type AvailabilityCommand={operationId:string;productId:string;expectedUpdatedAt:string;available:boolean;confirmed:true;reason:string};
export type UndoCommand={operationId:string;commandId:string;confirmed:true;reason:string};
export type PendingAssistantCommand={kind:'apply';request:AvailabilityCommand}|{kind:'undo';request:UndoCommand};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function cleanReason(value:string){const v=value.trim();if(v.length<5||v.length>200||/[\u0000-\u001f\u007f]/.test(v))throw Error('INVALID_ASSISTANT_COMMAND');return v;}
function id(value:string){if(!uuid.test(value))throw Error('INVALID_ASSISTANT_COMMAND');return value;}
function timestamp(value:string){if(typeof value!=='string'||value.length>60||Number.isNaN(Date.parse(value)))throw Error('INVALID_ASSISTANT_COMMAND');return value;}
export function availabilityCommand(operationId:string,product:AssistantProduct,available:boolean,reason:string):AvailabilityCommand{
 if(typeof available!=='boolean'||typeof product?.name!=='string'||typeof product.available!=='boolean')throw Error('INVALID_ASSISTANT_COMMAND');
 return {operationId:id(operationId),productId:id(product.id),expectedUpdatedAt:timestamp(product.updatedAt),available,confirmed:true,reason:cleanReason(reason)};
}
export function undoCommand(operationId:string,commandId:string,reason:string):UndoCommand{return {operationId:id(operationId),commandId:id(commandId),confirmed:true,reason:cleanReason(reason)};}
export function pendingKey(scopeKey:string){if(typeof scopeKey!=='string'||scopeKey.length<3||scopeKey.length>160||/[\u0000-\u001f\u007f]/.test(scopeKey))throw Error('INVALID_ASSISTANT_COMMAND');return 'menugo:assistant-command:v1:'+scopeKey;}
export function parsePending(value:string|null):PendingAssistantCommand|null{if(!value)return null;try{const v=JSON.parse(value);if(!v||typeof v!=='object'||!['apply','undo'].includes(v.kind)||!v.request||typeof v.request!=='object')return null;if(v.kind==='apply'){const r=v.request;if(Object.keys(r).sort().join(',')!=='available,confirmed,expectedUpdatedAt,operationId,productId,reason'||r.confirmed!==true||typeof r.available!=='boolean')return null;availabilityCommand(r.operationId,{id:r.productId,name:'pending',available:!r.available,updatedAt:r.expectedUpdatedAt},r.available,r.reason);return v;}const r=v.request;if(Object.keys(r).sort().join(',')!=='commandId,confirmed,operationId,reason'||r.confirmed!==true)return null;undoCommand(r.operationId,r.commandId,r.reason);return v;}catch{return null;}}
