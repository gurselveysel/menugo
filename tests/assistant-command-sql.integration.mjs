// Runs the normal disposable PGlite suite with assistant-command lifecycle checks injected.
import fs from 'node:fs';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
let source=fs.readFileSync('tests/sql.integration.mjs','utf8');
const marker=" await (await import('./platform-ai-checks.mjs')).platformAiChecks({q,db,auth,check,rejects,b,br,users,op});";
if(!source.includes(marker))throw Error('SQL acceptance fixture changed; assistant checks not injected');
source=source.replace(marker," await (await import('./assistant-command-checks.mjs')).assistantCommandChecks({q,db,auth,check,rejects,b,br,users,op,p1});\n\n"+marker);
const temp=resolve('tests/.assistant-command-sql-fixture.mjs');
try{fs.writeFileSync(temp,source);await import(pathToFileURL(temp).href);}finally{fs.rmSync(temp,{force:true});}
if(process.exitCode)throw Error('Assistant command SQL acceptance failed');
