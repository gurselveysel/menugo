// Explicit bounded provider acceptance. No public inference endpoint or business data.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';
import ts from 'typescript';import sharp from 'sharp';import {PDFDocument,StandardFonts} from 'pdf-lib';
const trigger='chore: verify r15 AI provider with synthetic menu only';
if(process.env.VERCEL_ENV!=='production'||process.env.VERCEL_GIT_COMMIT_MESSAGE?.trim()!==trigger){console.log('AI_PROVIDER_ACCEPTANCE: not triggered; no provider request');process.exit(0);}
const report={test:'r15-synthetic-menu',realProviderRequests:0,customerDataSent:false,databaseWrites:false,creditsPurchased:false,checks:[],at:new Date().toISOString()};
const token=process.env.AI_GATEWAY_API_KEY||process.env.VERCEL_OIDC_TOKEN;
let dir;
try{
 if(!token)throw Error('AI_NOT_CONFIGURED');
 const credits=await fetch('https://ai-gateway.vercel.sh/v1/credits',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(8000)});
 if(!credits.ok)throw Error('AI_CREDITS_ACCESS_'+credits.status);
 const balance=(await credits.json()).balance;
 if(typeof balance!=='string'||!/^\d+(\.\d+)?$/.test(balance))throw Error('CREDIT_CHECK_UNAVAILABLE');
 const [whole,fraction='']=balance.split('.');
 const micros=BigInt(whole)*1000000n+BigInt((fraction+'000000').slice(0,6));
 if(micros<1000000n)throw Error('EXISTING_CREDIT_REQUIRED_FOR_TEST');
 report.checks.push('existing credit confirmed without purchase');
 dir=mkdtempSync(join(tmpdir(),'menugo-ai-probe-'));
 const transpile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 const contracts=readFileSync('lib/ai-menu/contracts.ts','utf8').replace(/import\s+['"]server-only['"];?/g,'');
 const provider=readFileSync('lib/ai-menu/provider.ts','utf8').replace(/import\s+['"]server-only['"];?/g,'').replace(/from ['"]\.\/contracts['"]/g,"from './contracts.mjs'").replace(/import\s*\{getVercelOidcToken\}\s*from\s*['"]@vercel\/oidc['"];?/,"const getVercelOidcToken=async()=>process.env.VERCEL_OIDC_TOKEN;");
 writeFileSync(join(dir,'contracts.mjs'),transpile(contracts));writeFileSync(join(dir,'provider.mjs'),transpile(provider));
 const {extractMenu}=await import(pathToFileURL(join(dir,'provider.mjs')).href);
 const image=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="500"><rect width="100%" height="100%" fill="white"/><g fill="black" font-size="44" font-family="sans-serif"><text x="60" y="90">TEST MENU - TRY</text><text x="60" y="210">Tea ........ 25.50 TL</text><text x="60" y="330">Toast ...... 80.00 TL</text></g></svg>')).png().toBuffer();
 const doc=await PDFDocument.create();const page=doc.addPage([550,300]);const font=await doc.embedFont(StandardFonts.Helvetica);page.drawText('TEST MENU - TRY\n\nTea ........ 25.50 TL\n\nToast ...... 80.00 TL',{x:35,y:250,size:22,font});const pdf=Buffer.from(await doc.save());
 for(const [label,bytes,mime]of[['image',image,'image/png'],['pdf',pdf,'application/pdf']]){
  report.realProviderRequests++;
  const result=await extractMenu(bytes.toString('base64'),mime,token);
  const values=result.draft.items.map(x=>x.priceMinor).sort();
  if(JSON.stringify(values)!==JSON.stringify(['2550','8000']))throw Error('EXTRACTION_MISMATCH_'+label.toUpperCase());
  report.checks.push(label+': real provider returned exact two prices as cents');
 }
 report.passed=true;
}catch(error){report.passed=false;report.error=typeof error?.code==='string'?error.code:typeof error?.message==='string'&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'AI_PROVIDER_TEST_INCOMPLETE';}
finally{if(dir)rmSync(dir,{recursive:true,force:true});console.log('AI_PROVIDER_ACCEPTANCE '+JSON.stringify(report));writeFileSync('public/ai-provider-acceptance.json',JSON.stringify(report));}
