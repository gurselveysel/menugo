import test from 'node:test';import assert from 'node:assert/strict';import fs from'node:fs';import ts from'typescript';
const compiled=ts.transpileModule(fs.readFileSync('lib/customer-menu-assistant.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;const{answerMenuQuestion}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const items=[
 {id:'1',name:'Türk Kahvesi',category:'sicak',subcategory:'SICAK KAHVE',description:null,priceMinor:'9000',available:true,priceApproved:true,canOrder:true},
 {id:'2',name:'Latte',category:'sicak',subcategory:'SICAK KAHVE',description:null,priceMinor:'14000',available:true,priceApproved:true,canOrder:true},
 {id:'3',name:'Kahvaltı Tabağı',category:'kahvalti',subcategory:'KAHVALTI',description:'Peynir, domates',priceMinor:'25000',available:true,priceApproved:true,canOrder:true},
 {id:'4',name:'Serpme Kahvaltı',category:'kahvalti',subcategory:'KAHVALTI',description:null,priceMinor:'50000',available:true,priceApproved:true,canOrder:true},
 {id:'5',name:'Gizli Ürün',category:'kahvalti',subcategory:'KAHVALTI',description:null,priceMinor:'1000',available:false,priceApproved:true,canOrder:false},
 {id:'6',name:'Fiyatsız Ürün',category:'kahvalti',subcategory:'KAHVALTI',description:null,priceMinor:null,available:true,priceApproved:false,canOrder:false}
];
test('explicit budget uses bigint minor units and never exceeds it',()=>{const r=answerMenuQuestion('200 TL altında ne içebilirim?',items);assert.equal(r.budgetMinor,'20000');assert.deepEqual(r.products.map(x=>x.name),['Türk Kahvesi','Latte']);assert.ok(r.products.every(x=>BigInt(x.priceMinor)<=20000n));});
test('category question is grounded only in orderable approved catalogue',()=>{const r=answerMenuQuestion('kahvaltı ne var?',items);assert.deepEqual(r.products.map(x=>x.name),['Kahvaltı Tabağı','Serpme Kahvaltı']);assert.ok(!r.products.some(x=>x.name.includes('Gizli')||x.name.includes('Fiyatsız')));});
test('cheapest request sorts by authoritative catalogue price',()=>{const r=answerMenuQuestion('en ucuz kahve hangisi?',items);assert.equal(r.products[0]?.name,'Türk Kahvesi');assert.equal(r.products[0]?.priceMinor,'9000');});
test('allergen intent never declares a product safe',()=>{const r=answerMenuQuestion('fındık alerjim var, kahvaltı güvenli mi?',items);assert.equal(r.needsStaff,true);assert.ok(/kesin sonuç veremem/.test(r.answer));assert.ok(!/alerjensizdir|güvenlidir/.test(r.answer));});
test('unknown request fabricates no product or price',()=>{const r=answerMenuQuestion('mercimek çorbası var mı?',items);assert.deepEqual(r.products,[]);assert.ok(/bulamadım/.test(r.answer));});
test('response is capped and explicitly read-only/private',()=>{const many=Array.from({length:12},(_,i)=>({id:String(i+10),name:'Kahve '+i,category:'sicak',subcategory:'KAHVE',description:null,priceMinor:String(1000+i),available:true,priceApproved:true,canOrder:true}));const r=answerMenuQuestion('kahve seçenekleri',many);assert.ok(r.products.length<=5);assert.equal(r.source,'published_catalogue');assert.equal(r.modelUsed,false);assert.equal(r.stored,false);});
