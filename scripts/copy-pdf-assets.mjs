// Exact local package assets only. No CDN, user PDF, credentials or remote fetch.
import {cpSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const version='6.3.289',source=join(process.cwd(),'node_modules/pdfjs-dist');
if(JSON.parse(readFileSync(join(source,'package.json'),'utf8')).version!==version)throw Error('PDF_RENDERER_VERSION_MISMATCH');
const target=join(process.cwd(),'public/vendor/pdfjs',version);mkdirSync(target,{recursive:true});
cpSync(join(source,'legacy/build/pdf.worker.min.mjs'),join(target,'pdf.worker.min.mjs'));
for(const name of ['cmaps','standard_fonts','wasm','iccs']){cpSync(join(source,name),join(target,name),{recursive:true});}
cpSync(join(source,'LICENSE'),join(target,'LICENSE'));
