/** Browser preparation limits. This module performs no inference or money calculation. */
export const PDF_VERSION = '6.3.289';
export const PDF_LIMITS = Object.freeze({bytes:10*1024*1024,pages:8,pixels:3_000_000,edge:2400,pageBytes:2*1024*1024,totalBytes:12*1024*1024,timeoutMs:60000});
export class PdfPreparationError extends Error {
 constructor(public readonly code:string){super(code);this.name='PdfPreparationError';}
}
export function pdfFileGuard(size:number,header:Uint8Array){
 if(!Number.isSafeInteger(size)||size<12||size>PDF_LIMITS.bytes)throw new PdfPreparationError('PDF_SIZE');
 if(new TextDecoder().decode(header.slice(0,5))!=='%PDF-')throw new PdfPreparationError('PDF_INVALID');
}
export function pageCountGuard(count:number){if(!Number.isInteger(count)||count<1||count>PDF_LIMITS.pages)throw new PdfPreparationError('PDF_PAGES');}
export function rasterSize(width:number,height:number){
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width>14400||height>14400||Math.max(width/height,height/width)>20)throw new PdfPreparationError('PDF_DIMENSIONS');
 const scale=Math.min(2,PDF_LIMITS.edge/Math.max(width,height),Math.sqrt(PDF_LIMITS.pixels/(width*height)));
 return Object.freeze({scale,width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale))});
}
export function pageFilename(name:string,page:number){
 if(!Number.isInteger(page)||page<1||page>PDF_LIMITS.pages)throw new PdfPreparationError('PDF_PAGES');
 const clean=name.replace(/\.pdf$/i,'').replace(/[\u0000-\u001f\u007f/\\]/g,' ').trim().slice(0,110)||'menu';
 return `${clean} - sayfa ${page}.jpg`;
}
export function pdfMessage(error:unknown){
 const code=error instanceof PdfPreparationError?error.code:'';
 const messages:Record<string,string>={PDF_SIZE:'PDF en fazla 10 MB olabilir.',PDF_INVALID:'PDF okunamadı. Dosyayı yeniden dışa aktarın veya sayfa fotoğraflarını yükleyin.',PDF_PASSWORD:'Şifreli PDF açılamadı. Parolasız bir kopya kullanın.',PDF_PAGES:'Tek PDF için 1–8 sayfa destekleniyor. Daha uzun belgeyi bölerek yükleyin.',PDF_DIMENSIONS:'Bu sayfanın boyutları desteklenmiyor. Standart sayfa boyutunda yeniden kaydedin.',PDF_PAGE_TOO_LARGE:'Sayfa görüntüsü 2 MB sınırını aşıyor. Daha sade bir PDF veya net bir sayfa fotoğrafı kullanın.',PDF_TOTAL_TOO_LARGE:'Sayfa görüntülerinin toplamı 12 MB sınırını aşıyor. Belgeyi daha küçük parçalara ayırın.',PDF_TIMEOUT:'PDF hazırlığı zaman sınırına ulaştı. Daha küçük bir belgeyle tekrar deneyin.',PDF_CANCELLED:'PDF hazırlığı iptal edildi.',PDF_UNSUPPORTED:'PDF hazırlama bu tarayıcıda açılamadı. Güncel bir tarayıcı veya sayfa fotoğrafı kullanın.'};
 return messages[code]||messages.PDF_INVALID;
}
