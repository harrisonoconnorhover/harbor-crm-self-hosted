import type {LandingDraft} from './portable-landing';

const escape=(value:string)=>value.replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));
export function landingDocument(draft:LandingDraft,origin:string,preview=false,journey?:{siteId:string;path:string},publicUrl?:string|null,pageLinks?:ReadonlyMap<string,string>){
  const text=escape;
  const title=text(draft.searchTitle?.trim()||draft.title),description=text(draft.searchDescription?.trim()||draft.description);
  const preferred=!preview&&publicUrl?text(publicUrl):null;
  const metadata='<meta name="description" content="'+description+'">'+
    (draft.excludeFromSearch?'<meta name="robots" content="noindex">':'')+
    (preferred?'<link rel="canonical" href="'+preferred+'"><meta property="og:url" content="'+preferred+'">':'')+
    '<meta property="og:type" content="website"><meta property="og:title" content="'+title+'"><meta property="og:description" content="'+description+'">';
  const tracked=!preview&&journey;
  const script=tracked?'<script defer src="'+text(origin+'/journey.js')+'" data-site="'+text(tracked.siteId)+
    '" data-paths="'+text(tracked.path)+'" data-landing-consent="true" referrerpolicy="no-referrer"></script>':'';
  const firstInline=draft.blocks.find(b=>b.type==='form'&&b.display==='inline');
  const consent=tracked?'<aside hidden data-journey-consent><section aria-label="Visit measurement">'+
    '<p data-journey-status role="status">Optional visit measurement links pages you visit with inquiries you submit.</p>'+
    '<button type="button" data-journey-toggle>Allow visit measurement</button></section></aside>':'';
  const sections=new Set(draft.blocks.filter(b=>b.type!=='button').map(b=>b.id));
  const targets=new Set(draft.blocks.flatMap(b=>b.type==='button'&&'sectionId' in b.target?[b.target.sectionId]:[]));
  function render(b:LandingDraft['blocks'][number]){
    switch(b.type){
      case 'heading':return '<h2>'+text(b.text)+'</h2>';
      case 'text':return '<p>'+text(b.text)+'</p>';
      case 'image':return b.jpeg?'<figure><img src="data:image/jpeg;base64,'+text(b.jpeg)+'" width="'+Number(b.width)+'" height="'+Number(b.height)+
        '" alt="'+text(b.alt)+'" decoding="async">'+(b.caption?'<figcaption>'+text(b.caption)+'</figcaption>':'')+'</figure>':'';
      case 'quote':return '<blockquote>'+text(b.text)+'</blockquote>';
      case 'columns':return '<div class="columns">'+[b.left,b.right].map(col=>
        '<div>'+(col.heading?'<h2>'+text(col.heading)+'</h2>':'')+'<p>'+text(col.text)+'</p></div>').join('')+'</div>';
      case 'button':{
        if('sectionId' in b.target&&!sections.has(b.target.sectionId))return '';
        if(preview)return '<span class="cta">'+text(b.label)+'</span>';
        const href='url' in b.target?b.target.url:'sectionId' in b.target?'#section-'+b.target.sectionId:pageLinks?.get(b.target.pageId);
        return href?'<a class="cta" referrerpolicy="no-referrer" href="'+text(href)+'">'+text(b.label)+'</a>':'';
      }
      case 'form':{
        if(b.display==='inline'){
          const content=preview?'<p>Lead form preview · submissions disabled</p>':
            '<iframe title="'+text(b.label)+'" src="'+text(origin+'/forms/'+b.formId)+'" loading="lazy" referrerpolicy="no-referrer" '+
            'sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>';
          return '<section class="lead-capture"><h2>'+text(b.label)+'</h2>'+(b===firstInline?consent:'')+content+'</section>';
        }
        return preview?'<span class="cta">'+text(b.label)+'</span>':
        '<a class="cta" href="'+text(origin+'/forms/'+b.formId)+'">'+text(b.label)+'</a>';
      }
    }
  }
  const blocks=draft.blocks.map(b=>targets.has(b.id)
    ?'<div tabindex="-1" id="section-'+text(b.id)+'">'+render(b)+'</div>':render(b)).join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+
    title+'</title>'+metadata+script+'<style>'+
    ':root{--accent:'+(/^#[a-f0-9]{6}$/i.test(draft.accent)?draft.accent:'#126264')+'}*{box-sizing:border-box}body{margin:0;color:#233536;background:white;font:1.125rem/1.65 system-ui,sans-serif;overflow-wrap:anywhere}'+
    'header{border-top:.45rem solid var(--accent);background:#f2f6f5;padding:clamp(3rem,8vw,7rem) 1.5rem}header>div,main{max-width:46rem;margin:auto}'+
    'h1,h2{line-height:1.1;letter-spacing:-.035em}h1{font-size:clamp(2.2rem,6vw,4.6rem);margin:0}header p{font-size:1.2rem;margin:1rem 0 0;color:#4a6260}'+
    'main{padding:1.75rem 1.5rem 4rem}h2{margin:2rem 0 .5rem;font-size:1.65rem}p,blockquote{white-space:pre-line}blockquote{border-left:.25rem solid var(--accent);margin:1.5rem 0;padding:.35rem 1.25rem;font:italic 1.4rem/1.5 Georgia,serif}'+
    'figure{margin:1.5rem 0}figure img{display:block;max-width:100%;height:auto;border-radius:.5rem}figcaption{margin-top:.5rem;color:#4a6260;font-size:.92rem}'+
    '.columns{display:grid;gap:.75rem;margin:1.5rem 0}.columns h2{margin-top:0}.columns p{margin:0}@media(min-width:36rem){.columns{grid-template-columns:repeat(2,minmax(0,1fr));gap:2rem}}'+
    '.cta{display:inline-block;margin:.5rem .75rem .5rem 0;border-radius:.5rem;border-bottom:.25rem solid var(--accent);background:#193b3b;color:white;text-decoration:none;padding:.65rem 1.2rem;font-weight:650}.cta:focus-visible{outline:3px solid #1674b1;outline-offset:3px}'+
    '.lead-capture iframe{display:block;width:100%;height:45rem;border:0}.lead-capture>p{padding:2rem;background:#f2f6f5;border:1px dashed #94aaa6}'+
    (tracked?'[data-journey-consent]{border-top:1px solid #d6e1df;padding:1.25rem 1.5rem;color:#405452;font-size:.9rem}[data-journey-consent] section{max-width:46rem;margin:auto}[data-journey-consent] p{margin:0 0 .4rem}[data-journey-consent] button{background:none;color:#1c5352;border:0;text-decoration:underline;font:inherit;cursor:pointer;padding:.25rem 0;text-underline-offset:.2em}':'')+'</style></head><body>'+
    '<header><div><h1>'+text(draft.title)+'</h1>'+(draft.description?'<p>'+text(draft.description)+'</p>':'')+'</div></header><main>'+blocks+'</main>'+(firstInline?'':consent)+'</body></html>';
}
