// One-time, reviewable source migration on feat/local-pdf-menu-r30 only.
// No environment reads, remote downloads, credentials, catalogue or DB writes.
import fs from 'node:fs';
const studio='components/AiMenuStudio.tsx';let s=fs.readFileSync(studio,'utf8');
if(!s.includes("import {PdfMenuImport}")){
 if(!s.includes("import {Card} from './Shell';")||!s.includes(' {job&&<Card>'))throw Error('STUDIO_SOURCE_CHANGED');
 s=s.replace("import {Card} from './Shell';","import {Card} from './Shell';\nimport {PdfMenuImport} from './PdfMenuImport';");
 s=s.replace(' {job&&<Card>',' <PdfMenuImport aiReady={list?.aiConfigured===true} remaining={Math.max(0,(list?.dailyLimit??0)-(list?.usedToday??0))} onUploaded={id=>{void loadList();void open(id);}}/>\n {job&&<Card>');
}
s=s.replace('Açık kaynak bağlantısı: menü fotoğrafları kendi model sunucunuzda işlenir. PDF sayfalarını görüntü olarak yükleyin. Model erişimi doğrulanmadan analiz başlamaz.','AI altyapısı MenüGO şirket yönetimi tarafından sağlanır. Yalnızca uygun ücretsiz hizmetler kullanılır. Fotoğrafı yükleyebilir veya PDF sayfalarını önce cihazınızda hazırlayabilirsiniz.')
.replace('JPG, PNG, WebP veya en fazla 8 sayfalık PDF. Dosya başına 2 MB.','JPG, PNG veya WebP. Fotoğraf başına 2 MB. PDF için aşağıdaki sayfa hazırlama alanını kullanın.')
.replace('accept="image/jpeg,image/png,image/webp,application/pdf"','accept="image/jpeg,image/png,image/webp"')
.replace('Sağlayıcı bağlantısını “LLM Asistanı” bölümünden yönetin.','Sağlayıcı bağlantılarını yalnız MenüGO şirket yönetimi düzenler.')
.replace('Ek kredi satın alınmaz; sağlayıcının mevcut kullanım/kredi koşulları geçerlidir.','Ücretli modele geçilmez ve kredi satın alınmaz.');
fs.writeFileSync(studio,s);
const contract='lib/ai-menu/contracts.ts';let c=fs.readFileSync(contract,'utf8');
c=c.replace('Sunucuda AI Gateway erişimi tanımlanmalı.','Altyapı MenüGO şirket yönetimi tarafından sağlanır.')
.replace('işletme hesabındaki AI bağlantısını kontrol edin.','bağlantıyı MenüGO şirket yönetimi kontrol etmelidir.')
.replace('Kendi açık kaynak model sunucunuz henüz bağlı değil. LLM Asistanı bölümünden bağlantıyı kurun.','AI bağlantısı henüz etkin değil. Altyapı MenüGO şirket yönetimi tarafından sağlanır.')
.replace('Bu sürüm yalnız açık kaynak model bağlantısını kullanır; ücretli API’ye geçilmez.','Bu iş için uygun ücretsiz AI bağlantısı bulunmuyor. Ücretli modele geçilmez.')
.replace('PDF sayfalarını fotoğraf/görüntü olarak yükleyin. Doğrudan PDF dönüştürme henüz bağlı değil.','PDF’yi sayfa hazırlama alanından açıp seçilen sayfaları görüntü olarak gönderin.')
.replace("'LLM bağlantısını kontrol edin: '+code+' · Bağlantıyı LLM Asistanı bölümünden yönetin.'","'AI hizmeti şu anda kullanılamıyor. Yapılandırmayı MenüGO şirket yönetimi kontrol eder.'");fs.writeFileSync(contract,c);
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));if(pkg.dependencies['pdfjs-dist']!=='6.3.289')throw Error('PDF_DEPENDENCY_NOT_LOCKED');pkg.scripts.prebuild='node scripts/copy-pdf-assets.mjs';pkg.scripts.predev='node scripts/copy-pdf-assets.mjs';fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');
let ignore=fs.readFileSync('.gitignore','utf8');if(!ignore.includes('public/vendor/pdfjs/'))fs.appendFileSync('.gitignore','\npublic/vendor/pdfjs/\n');
