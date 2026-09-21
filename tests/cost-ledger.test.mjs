import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
const root='test-results/cost-ledger-unit';fs.mkdirSync(root,{recursive:true});
for(const [name,path] of [['operations','src/studio/operations.ts'],['cost-ledger','src/studio/cost-ledger.ts']]){
 const source=fs.readFileSync(path,'utf8').replaceAll("from './operations'","from './operations.mjs'");
 fs.writeFileSync(`${root}/${name}.mjs`,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
}
const c=await import('../'+root+'/cost-ledger.mjs');
const op='44444444-4444-4444-8444-000000009001',job='55555555-5555-4555-8555-555555555555',product='66666666-6666-4666-8666-666666666666';
test('approved invoice post command is proof-only',()=>{const v=c.readCostLedgerCommand({action:'post-invoice',operationId:op,jobId:job,revision:'7',confirmed:true});assert.deepEqual(v.payload,{operationId:op,jobId:job,revision:'7',confirmed:true});});
test('invoice command rejects client monetary fields',()=>assert.throws(()=>c.readCostLedgerCommand({action:'post-invoice',operationId:op,jobId:job,revision:'7',confirmed:true,totalMinor:'1'}),/INVALID_COST_INPUT/));
test('recipe command keeps canonical integer minor units',()=>{const v=c.readCostLedgerCommand({action:'save-recipe',operationId:op,productId:product,name:' Börek ',portions:3,overheadMinor:'100',confirmed:true,ingredients:[{name:' Un ',unit:'g',packQuantity:'1000',packCostMinor:'12345',recipeQuantity:'100',edibleYieldBps:10000}]});assert.equal(v.payload.name,'Börek');assert.equal(v.payload.ingredients[0].name,'Un');assert.equal(v.payload.ingredients[0].packCostMinor,'12345');});
for(const bad of [
 {action:'save-recipe',operationId:op,productId:product,name:'X',portions:0,overheadMinor:'0',confirmed:true,ingredients:[{name:'Un',unit:'g',packQuantity:'1',packCostMinor:'1',recipeQuantity:'1',edibleYieldBps:10000}]},
 {action:'save-recipe',operationId:op,productId:product,name:'X',portions:1,overheadMinor:'1.2',confirmed:true,ingredients:[{name:'Un',unit:'g',packQuantity:'1',packCostMinor:'1',recipeQuantity:'1',edibleYieldBps:10000}]},
 {action:'save-recipe',operationId:op,productId:product,name:'X',portions:1,overheadMinor:'0',confirmed:true,ingredients:[{name:'Un',unit:'kg',packQuantity:'1',packCostMinor:'1',recipeQuantity:'1',edibleYieldBps:10000}]},
 {action:'save-recipe',operationId:op,productId:product,name:'X',portions:1,overheadMinor:'0',confirmed:false,ingredients:[{name:'Un',unit:'g',packQuantity:'1',packCostMinor:'1',recipeQuantity:'1',edibleYieldBps:10000}]}
])test('invalid ledger command rejected '+JSON.stringify(bad).slice(0,70),()=>assert.throws(()=>c.readCostLedgerCommand(bad),/INVALID_COST_INPUT/));
