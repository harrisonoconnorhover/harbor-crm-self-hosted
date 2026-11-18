'use client';
import {useEffect,useRef,useState} from 'react';
import type {PDFDocumentProxy,PDFDocumentLoadingTask,RenderTask} from 'pdfjs-dist';

export function PdfPreview({url,name,restoreRequired=false}:{url:string;name:string;restoreRequired?:boolean}){
 const [document,setDocument]=useState<PDFDocumentProxy|null>(null),[page,setPage]=useState(1),[zoom,setZoom]=useState(100),[error,setError]=useState(''),[rendering,setRendering]=useState(true),[text,setText]=useState(''),[width,setWidth]=useState(600);
 const surface=useRef<HTMLDivElement>(null);
 useEffect(()=>{const element=surface.current;if(!element)return;const observer=new ResizeObserver(entries=>setWidth(Math.max(200,entries[0].contentRect.width)));observer.observe(element);return()=>observer.disconnect();},[]);
 useEffect(()=>{
  let disposed=false,task:PDFDocumentLoadingTask|undefined;
  setDocument(null);setPage(1);setError('');setRendering(true);
  void import('pdfjs-dist').then(async pdfjs=>{
   if(disposed)return;
   const assets=`/pdfjs/${pdfjs.version}/`;
   pdfjs.GlobalWorkerOptions.workerSrc=assets+'pdf.worker.min.mjs';
   task=pdfjs.getDocument({url,cMapUrl:assets+'cmaps/',cMapPacked:true,standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/',iccUrl:assets+'iccs/',enableXfa:false,maxImageSize:16_777_216,canvasMaxAreaInBytes:48*1024*1024});
   const pdf=await task.promise;if(!disposed)setDocument(pdf);
  }).catch(e=>{if(!disposed){setError((e?.name==='PasswordException'?'This PDF is password protected. ':'This PDF could not be opened. ')+(restoreRequired?'Restore it to download and open it in another viewer.':'Download it to open it in another viewer.'));setRendering(false);}});
  return()=>{disposed=true;void task?.destroy().catch(()=>{});};
 },[url,restoreRequired]);
 useEffect(()=>{
  if(!document||!surface.current)return;
  let disposed=false,render:RenderTask|undefined;
  const host=surface.current,canvas=window.document.createElement('canvas');
  canvas.setAttribute('role','img');canvas.setAttribute('aria-label',`${name}, page ${page}`);
  host.replaceChildren(canvas);setRendering(true);setError('');setText('');
  void (async()=>{
   const pdfPage=await document.getPage(page);if(disposed)return;
   const original=pdfPage.getViewport({scale:1});
   const displayScale=Math.min(width,1000)/original.width*zoom/100;
   const scale=Math.min(displayScale*Math.min(window.devicePixelRatio||1,2),4096/original.width,4096/original.height,Math.sqrt(12_000_000/(original.width*original.height)));
   const viewport=pdfPage.getViewport({scale});canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
   canvas.style.width=`${original.width*displayScale}px`;canvas.style.height=`${original.height*displayScale}px`;
   render=pdfPage.render({canvas,viewport});await render.promise;if(disposed)return;
   setRendering(false);
   // Some scanned/malformed PDFs render but cannot provide text. Keep the image.
   const content=await pdfPage.getTextContent().catch(()=>null);if(!disposed&&content)setText(content.items.map(item=>'str'in item?item.str+(item.hasEOL?'\n':' '):'').join(''));
  })().catch(e=>{if(!disposed&&e?.name!=='RenderingCancelledException'){setError('This page could not be displayed. '+(restoreRequired?'Restore the file to download and open it.':'Download the PDF to open it.'));setRendering(false);}});
  return()=>{disposed=true;render?.cancel();canvas.remove();};
 },[document,page,zoom,width,name,restoreRequired]);
 return <div className="pdf-preview">
  {document&&<div className="pdf-controls"><button type="button" className="secondary" disabled={page===1} onClick={()=>setPage(p=>p-1)}>Previous page</button><span>Page {page} of {document.numPages}</span><button type="button" className="secondary" disabled={page===document.numPages} onClick={()=>setPage(p=>p+1)}>Next page</button><label>Zoom <select value={zoom} onChange={e=>setZoom(Number(e.target.value))}>{[50,75,100,125,150,200].map(z=><option key={z} value={z}>{z}%</option>)}</select></label></div>}
  {rendering&&<p role="status">Rendering PDF…</p>}{error&&<p role="alert">{error}</p>}
  <div className="pdf-pages" ref={surface}/>
  {text&&<details className="pdf-page-text"><summary>Text on this page</summary><pre>{text}</pre></details>}
 </div>;
}
