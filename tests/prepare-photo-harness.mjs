// Isolated Next.js harness for actual photo UI/routes and merchant component.
// It avoids unrelated r30 PDF dependency; NOT a full-application production build.
import fs from 'node:fs';import path from 'node:path';
const root=process.cwd(),dest=path.join(root,'.test-build/photo-app');fs.rmSync(dest,{recursive:true,force:true});fs.mkdirSync(dest,{recursive:true});
const seen=new Set();function copy(file){if(seen.has(file))return;seen.add(file);const p=path.join(root,file);fs.mkdirSync(path.dirname(path.join(dest,file)),{recursive:true});fs.copyFileSync(p,path.join(dest,file));if(!/\.[jt]sx?$/.test(file))return;const text=fs.readFileSync(p,'utf8');const re=/(?:from\s*|import\s*\(|import\s*)['"]([^'"]+)['"]/g;for(const[,spec]of text.matchAll(re)){if(!spec.startsWith('.')&&!spec.startsWith('@/'))continue;const base=spec.startsWith('@/')?spec.slice(2):path.normalize(path.join(path.dirname(file),spec));const resolved=[base,base+'.ts',base+'.tsx',base+'.js',base+'/index.ts'].find(x=>fs.existsSync(path.join(root,x))&&fs.statSync(path.join(root,x)).isFile());if(!resolved)throw Error('LOCAL_IMPORT_NOT_FOUND:'+base);copy(resolved);}}
for(const p of ['components/StudioPhotoPublishing.tsx','components/MerchantMenu.tsx','app/globals.css','app/photo-publication.css','app/api/studio/photo-publication/route.ts','app/api/menu-photo/[productId]/[assetId]/route.ts'])copy(p);
fs.symlinkSync(path.join(root,'node_modules'),path.join(dest,'node_modules'),'dir');fs.cpSync('public/media',path.join(dest,'public/media'),{recursive:true});
fs.writeFileSync(path.join(dest,'package.json'),JSON.stringify({name:'menugo-photo-acceptance-harness',private:true,dependencies:{next:'16.3.5',react:'19.2.0','react-dom':'19.2.0'}}));
fs.copyFileSync('tsconfig.json',path.join(dest,'tsconfig.json'));
fs.writeFileSync(path.join(dest,'next.config.mjs'),`export default {experimental:{cpus:1},env:{NEXT_PUBLIC_SUPABASE_URL:'https://example.invalid',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test_only'}};`);
fs.writeFileSync(path.join(dest,'app/layout.tsx'),`import './globals.css';import './photo-publication.css';export default function Layout({children}:{children:React.ReactNode}){return <html lang="tr"><body>{children}</body></html>;}`);
fs.writeFileSync(path.join(dest,'app/page.tsx'),`import {StudioPhotoPublishing} from '@/components/StudioPhotoPublishing';export default function Page(){return <main className="studio-page"><StudioPhotoPublishing/></main>;}`);
fs.mkdirSync(path.join(dest,'app/menu'));fs.writeFileSync(path.join(dest,'app/menu/page.tsx'),`import MerchantMenu from '@/components/MerchantMenu';export default function Page(){return <MerchantMenu/>;}`);
console.log('Prepared real-component test harness; sources:',seen.size);
