import {helpPageHeaders} from '../lib/help-page-headers';
import {z} from 'zod';
import {helpStyles} from './portable-help-page-styles';
import {helpArticleSearch,publicTopic} from '../lib/help-center';
import {publicHelp,publicHelpTopics} from '../db/postgres/help-center-store';
import {normalizeArticleHtml} from '../lib/knowledge-base';
import {escapeEmailText as escape} from '../lib/email/rich-text';
import {portableDb} from './portable-db';

const query=helpArticleSearch.omit({workspaceId:true});
const browseTopics=z.object({browse:z.literal('topics'),afterTopic:publicTopic.optional()}).strict();
const unavailable=()=>new Response('Help page unavailable.',{status:404,headers:{...helpPageHeaders,'Content-Type':'text/plain; charset=utf-8'}});
export async function GET(request:Request,{params}:{params:Promise<{centerId:string;slug?:string}>}){
  const {centerId:portal,slug}=await params,url=new URL(request.url);
  if(!z.string().guid().safeParse(portal).success||url.searchParams.size!==new Set(url.searchParams.keys()).size)return unavailable();
  const path='/help/'+portal;
  const link=(fields:Record<string,string>)=>path+'?'+escape(new URLSearchParams(fields).toString());
  const fields=Object.fromEntries(url.searchParams);
  if('browse' in fields){
    const parsed=browseTopics.safeParse(fields);
    if(slug||!parsed.success)return unavailable();
    const directory=await publicHelpTopics(portableDb(),portal,parsed.data.afterTopic);
    if(!directory)return unavailable();
    const links=directory.topics.map(topic=>'<li><a href="'+link({topic})+'">'+escape(topic)+'</a></li>').join('');
    const body='<p><a href="'+path+'">All articles</a></p><h1>Browse topics</h1>'+
      (links?'<ul class="results">'+links+'</ul>':'<p>No published topics on this page.</p>')+
      (directory.next?'<a href="'+link({browse:'topics',afterTopic:directory.next})+'">More topics</a>':'');
    return renderHelpPage(path,directory,'Browse topics',body);
  }
  const parsed=query.safeParse(fields);
  if(!parsed.success||slug&&(!z.string().guid().safeParse(slug).success||parsed.data.q||parsed.data.after||parsed.data.topic))return unavailable();
  const input={...parsed.data,article:slug};
  const result=await publicHelp(portableDb(),portal,input);
  if(!result)return unavailable();
  const item=input.article?result.items[0]:null;
  const title=escape(item?.title??input.topic??result.name);
  const topic=input.topic?{topic:input.topic}:undefined;
  const articleLinks=(rows:typeof result.items)=>rows.map(row=>'<li><a href="'+path+'/'+row.id+'">'+escape(row.title)+'</a>'+
    (row.subtitle?'<p>'+escape(row.subtitle)+'</p>':'')+'</li>').join('');
  const articles=articleLinks(result.items);
  const related=item?.topic&&result.related.length?'<section><h2>More in '+escape(item.topic)+'</h2><ul class="results">'+
    articleLinks(result.related)+'</ul></section>':'';
  const all='<a href="'+path+'">All articles</a>';
  const browse='<a href="'+link({browse:'topics'})+'">Browse topics</a>';
  const body=item?'<p>'+all+(item.topic?' · <a href="'+link({topic:item.topic})+'">'+escape(item.topic)+'</a>':'')+'</p><article><h1>'+title+'</h1><p class="subtitle">'+escape(item.subtitle)+'</p>'+
    normalizeArticleHtml(item.body).bodyHtml+'</article>'+related:'<h1>'+title+'</h1><p>'+(topic?all+' · ':'')+browse+'</p><form action="'+path+'" method="get">'+
    (topic?'<input type="hidden" name="topic" value="'+escape(topic.topic)+'">':'')+
    '<input type="search" name="q" maxlength="200" aria-label="Search articles" placeholder="Search articles" value="'+escape(input.q??'')+'"><button>Search</button></form>'+
    (result.suggested?'<h2>Similar articles</h2>':'')+
    (articles?'<ul class="results">'+articles+'</ul>':'<p>'+(input.q?'No matching articles.':'No published articles yet.')+'</p>')+
    (result.next?'<a href="'+link({...topic,...(input.q?{q:input.q}:{}),after:result.next})+'">More articles</a>':'');
  return renderHelpPage(path,result,item?.title??input.topic,body);
}

function renderHelpPage(path:string,center:{name:string;accent:string},heading:string|undefined,body:string){
  const name=escape(center.name);
  return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<title>'+(heading?escape(heading)+' · ':'')+name+'</title><style>:root{--accent:'+escape(center.accent)+'}'+helpStyles+'</style></head><body>'+
    '<header><div><a href="'+path+'">'+name+'</a> · <a href="'+path+'/cases">My cases</a></div></header><main>'+body+'</main></body></html>',
    {headers:helpPageHeaders});
}
