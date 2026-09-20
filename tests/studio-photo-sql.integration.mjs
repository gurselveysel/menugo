// Connector-safe acceptance adapter: runs the unchanged r30 SQL suite with the r31 photo lifecycle checks injected.
// Disposable PGlite only; never connects to production.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
let source=fs.readFileSync('tests/sql.integration.mjs','utf8');
const marker=" await (await import('./platform-control-checks.mjs')).platformControlChecks({q,db,auth,check,rejects,b,br,users,op,p1,p2});";
if(!source.includes(marker))throw Error('SQL acceptance fixture changed; photo checks not injected');
source=source.replace(marker," await (await import('./studio-photo-checks.mjs')).photoPublicationChecks({q,db,auth,check,b,br,users,op,p1,p2});\n"+marker);
const temp=resolve('tests/.studio-photo-sql-fixture.mjs');
try{fs.writeFileSync(temp,source);await import(pathToFileURL(temp).href);}finally{fs.rmSync(temp,{force:true});}
if(process.exitCode)throw Error('Photo SQL acceptance failed');
