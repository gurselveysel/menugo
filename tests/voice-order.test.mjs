import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const compiled=ts.transpileModule(fs.readFileSync('lib/voice-order.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {buildVoiceDraft}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const catalogue=[
 {id:'11111111-1111-4111-8111-111111111111',name:'Çay',options:[],priceMinor:'4500',canOrder:true,available:true,priceApproved:true},
 {id:'22222222-2222-4222-8222-222222222222',name:'Tost',options:['Kaşarlı','Karışık'],priceMinor:'12500',canOrder:true,available:true,priceApproved:true},
 {id:'33333333-3333-4333-8333-333333333333',name:'Limonata',options:[],priceMinor:null,canOrder:false,available:true,priceApproved:false},
];

test('catalogue price is authoritative and bigint totals are exact',()=>{
 const d=buildVoiceDraft('iki çay',catalogue);
 assert.deepEqual(d.lines,[{productId:catalogue[0].id,productName:'Çay',quantity:2,option:null,unitPriceMinor:'4500',lineTotalMinor:'9000'}]);
 assert.equal(d.totalMinor,'9000');assert.equal(d.reviewRequired,true);assert.equal(d.autoSubmitted,false);
});

test('option products are withheld until the option is explicit',()=>{
 const missing=buildVoiceDraft('bir tost',catalogue);
 assert.equal(missing.lines.length,0);assert.equal(missing.issues[0]?.code,'OPTION_REQUIRED');
 const selected=buildVoiceDraft('bir kaşarlı tost',catalogue);
 assert.equal(selected.lines.length,1);assert.equal(selected.lines[0].option,'Kaşarlı');assert.equal(selected.totalMinor,'12500');
});

test('unapproved or unavailable catalogue products never become draft lines',()=>{
 const d=buildVoiceDraft('bir limonata',catalogue);
 assert.equal(d.lines.length,0);assert.equal(d.totalMinor,'0');assert.equal(d.issues[0]?.code,'NOT_ORDERABLE');
});

test('duplicate catalogue names remain ambiguous instead of guessing a product',()=>{
 const duplicate=[catalogue[0],{...catalogue[0],id:'44444444-4444-4444-8444-444444444444'}];
 const d=buildVoiceDraft('bir çay',duplicate);
 assert.equal(d.lines.length,0);assert.equal(d.issues[0]?.code,'AMBIGUOUS_PRODUCT');
});

test('quantity boundaries prevent oversized draft mutations',()=>{
 const d=buildVoiceDraft('21 çay',catalogue);
 assert.equal(d.lines.length,0);assert.equal(d.issues[0]?.code,'QUANTITY_LIMIT');
});

test('unknown speech never fabricates a product, price or line',()=>{
 const d=buildVoiceDraft('iki mercimek çorbası ve ayran',catalogue);
 assert.deepEqual(d.lines,[]);assert.deepEqual(d.issues,[]);assert.equal(d.totalMinor,'0');
});

test('repeated mentions merge deterministically without changing unit price',()=>{
 const d=buildVoiceDraft('iki çay ve üç çay',catalogue);
 assert.equal(d.lines.length,1);assert.equal(d.lines[0].quantity,5);assert.equal(d.lines[0].unitPriceMinor,'4500');assert.equal(d.lines[0].lineTotalMinor,'22500');assert.equal(d.totalMinor,'22500');
});

test('production headers allow only first-party camera and microphone capabilities',async()=>{
 const config=(await import('../next.config.mjs?voice-policy-test='+Date.now())).default;
 const rules=await config.headers();const global=rules.find(r=>r.source==='/(.*)');assert.ok(global);
 const policy=global.headers.find(h=>h.key.toLowerCase()==='permissions-policy')?.value;
 assert.equal(policy,'camera=(self), microphone=(self)');
 assert.equal(global.headers.find(h=>h.key.toLowerCase()==='x-frame-options')?.value,'DENY');
});
