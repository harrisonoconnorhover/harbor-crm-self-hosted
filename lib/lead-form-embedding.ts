export function leadFormEmbedOrigin(value:unknown,mode:string){
  if(typeof value!=='string'||value.length>254)return undefined;
  const url=URL.parse(value);
  if(!url||(value!==url.origin&&value!==url.origin+'/')||!/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/.test(url.origin))return undefined;
  const local=mode==='local'&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname);
  return url.protocol==='https:'||local?url.origin:undefined;
}

export const publicLeadFormPath=/^\/forms\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function leadFormEmbedHtml(publicFormUrl:string){
  const url=URL.parse(publicFormUrl);
  if(!url||publicFormUrl!==url.origin+url.pathname||!publicLeadFormPath.test(url.pathname)||!leadFormEmbedOrigin(url.origin,'local'))return '';
  return '<iframe src="'+url.href+'" title="Contact form" loading="lazy" '+
    'referrerpolicy="no-referrer" sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" '+
    'style="width:100%;height:720px;border:0"></iframe>';
}
