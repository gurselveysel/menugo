import {PDF_VERSION,PDF_LIMITS,PdfPreparationError,pdfFileGuard,pageCountGuard,pageFilename,rasterSize} from './pdf-policy';
export interface PreparedPage {page:number;file:File;width:number;height:number;}
export interface PreparedPdf {name:string;pages:PreparedPage[];}
/** No PDF URLs, DOM viewer, forms, scripting or OCR. PDF bytes never leave this browser. */
export async function preparePdf(file:File,signal:AbortSignal,onProgress:(done:number,total:number)=>void):Promise<PreparedPdf>{
 let expired=false,loading:import('pdfjs-dist').PDFDocumentLoadingTask|undefined,render:import('pdfjs-dist').RenderTask|undefined,canvas:HTMLCanvasElement|undefined;
 const stopped=()=>signal.aborted||expired;
 const stop=()=>{render?.cancel();if(loading)void loading.destroy().catch(()=>{});};
 const guard=()=>{if(stopped())throw new PdfPreparationError(expired?'PDF_TIMEOUT':'PDF_CANCELLED');};
 const timer=setTimeout(()=>{expired=true;stop();},PDF_LIMITS.timeoutMs);
 signal.addEventListener('abort',stop,{once:true});
 try{
  guard();pdfFileGuard(file.size,new Uint8Array(await file.slice(0,12).arrayBuffer()));guard();
  const pdfjs=await import('pdfjs-dist');guard();
  pdfjs.GlobalWorkerOptions.workerSrc=`/vendor/pdfjs/${PDF_VERSION}/pdf.worker.min.mjs`;
  const bytes=new Uint8Array(await file.arrayBuffer());guard();
  const options={data:bytes,isEvalSupported:false,enableXfa:false,stopAtErrors:true,disableAutoFetch:true,disableStream:true,disableRange:true,useWorkerFetch:false,useSystemFonts:false,canvasMaxAreaInBytes:16_000_000,cMapUrl:`/vendor/pdfjs/${PDF_VERSION}/cmaps/`,cMapPacked:true,standardFontDataUrl:`/vendor/pdfjs/${PDF_VERSION}/standard_fonts/`,wasmUrl:`/vendor/pdfjs/${PDF_VERSION}/wasm/`,iccUrl:`/vendor/pdfjs/${PDF_VERSION}/iccs/`};
  loading=pdfjs.getDocument(options);
  const doc=await loading.promise;guard();pageCountGuard(doc.numPages);onProgress(0,doc.numPages);
  if(doc.isPureXfa)throw new PdfPreparationError('PDF_UNSUPPORTED');
  const pages:PreparedPage[]=[];let totalBytes=0;
  for(let pageNumber=1;pageNumber<=doc.numPages;pageNumber++){
   guard();const page=await doc.getPage(pageNumber);guard();
   const original=page.getViewport({scale:1});const size=rasterSize(original.width,original.height);
   canvas=document.createElement('canvas');canvas.width=size.width;canvas.height=size.height;
   const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw new PdfPreparationError('PDF_UNSUPPORTED');
   render=page.render({canvas,canvasContext:ctx,viewport:page.getViewport({scale:size.scale}),background:'rgb(255,255,255)',annotationMode:pdfjs.AnnotationMode.ENABLE});
   await render.promise;render=undefined;guard();
   let blob:Blob|null=null;
   for(const quality of [0.92,0.85,0.76]){
    blob=await new Promise<Blob|null>(resolve=>canvas!.toBlob(resolve,'image/jpeg',quality));guard();
    if(blob&&blob.size<=PDF_LIMITS.pageBytes)break;
   }
   if(!blob||blob.size>PDF_LIMITS.pageBytes)throw new PdfPreparationError('PDF_PAGE_TOO_LARGE');
   totalBytes+=blob.size;if(totalBytes>PDF_LIMITS.totalBytes)throw new PdfPreparationError('PDF_TOTAL_TOO_LARGE');
   pages.push({page:pageNumber,file:new File([blob],pageFilename(file.name,pageNumber),{type:'image/jpeg'}),width:canvas.width,height:canvas.height});
   canvas.width=canvas.height=0;canvas=undefined;page.cleanup();onProgress(pageNumber,doc.numPages);
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  guard();return {name:file.name,pages};
 }catch(error:unknown){
  if(stopped())throw new PdfPreparationError(expired?'PDF_TIMEOUT':'PDF_CANCELLED');
  if(error instanceof PdfPreparationError)throw error;
  if(error instanceof Error&&error.name==='PasswordException')throw new PdfPreparationError('PDF_PASSWORD');
  throw new PdfPreparationError('PDF_INVALID');
 }finally{
  clearTimeout(timer);signal.removeEventListener('abort',stop);render?.cancel();if(canvas)canvas.width=canvas.height=0;
  if(loading)void loading.destroy().catch(()=>{});
 }
}
