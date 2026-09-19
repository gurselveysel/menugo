import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
const out='test-results/platform-unit';fs.mkdirSync(out,{recursive:true});fs.writeFileSync(out+'/control.mjs',ts.transpileModule(fs.readFileSync('src/platform/control.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText);
const m=await import('../'+out+'/control.mjs');
test('company policy has a closed schema',()=>assert.deepEqual(m.validatePolicy({aiEnabled:false,dailyAiLimit:5}),{aiEnabled:false,dailyAiLimit:5}));
for(const value of [null,[],{x:1},{aiEnabled:'false'},{dailyAiLimit:0},{dailyAiLimit:51},{dailyAiLimit:2.5},{dailyAiLimit:'5'},{paidFallback:true}])test('invalid config '+JSON.stringify(value),()=>assert.throws(()=>m.validatePolicy(value)));
test('reason required and whitespace normalized',()=>{assert.equal(m.reason('  operational incident  '),'operational incident');assert.throws(()=>m.reason('  ok '));assert.throws(()=>m.reason('x'.repeat(301)));});
test('closed POST envelope',()=>assert.throws(()=>m.strictKeys({operationId:'id',secret:'injected'},['operationId'])));
test('no rendering of unrestricted SQL or unimplemented payments switch',()=>{const source=fs.readFileSync('components/PlatformControl.tsx','utf8');assert.ok(!source.includes('textarea value={sql}'));assert.ok(!source.includes("commit('enable-payment'"));assert.ok(source.includes('Henüz'))});
