import {z} from 'zod';
import {emailContent,type EmailContent} from './message';
import {escapeEmailText} from './rich-text';
export const unsubscribeInput=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
export function appendUnsubscribeFooter(content:EmailContent,url:string):EmailContent{
 return emailContent.parse({...content,body:content.body+'\n\nUnsubscribe from emails from this workspace: '+url,
  ...(content.bodyHtml?{bodyHtml:content.bodyHtml+'<p><a href="'+escapeEmailText(url)+'">Unsubscribe from emails from this workspace</a></p>'}:{})});
}
