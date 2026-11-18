import {z} from 'zod';
import {utcDateTime} from './iso-date-time';
export const fileCategories={all:'All file types',image:'Images',document:'Documents',spreadsheet:'Spreadsheets',presentation:'Presentations',audio:'Audio',video:'Videos',archive:'Archives',other:'Other'} as const;
export const fileExtensions={image:['png','jpg','jpeg','gif','webp','svg','avif','bmp','tif','tiff','ico','heic'],document:['pdf','txt','md','rtf','doc','docx','odt'],spreadsheet:['csv','tsv','xls','xlsx','ods'],presentation:['ppt','pptx','odp'],audio:['mp3','wav','m4a','aac','ogg','flac'],video:['mp4','mov','webm','avi','mkv','m4v'],archive:['zip','gz','tgz','tar','7z','rar']} as const;
export const fileSorts={addedDesc:'Newest added',addedAsc:'Oldest added',nameAsc:'Name (A–Z)',nameDesc:'Name (Z–A)',sizeDesc:'Largest first',sizeAsc:'Smallest first'} as const;
export type FileCategory=keyof typeof fileCategories;
export type FileSort=keyof typeof fileSorts;
export const fileFolderNameInput=z.string().transform(s=>s.normalize('NFC').trim()).pipe(z.string().min(1).max(120).refine(s=>!/[\x00-\x1f\x7f/\\]/.test(s)&&s!=='.'&&s!=='..','Use a folder name without slashes or control characters.'));
export const folderIdInput=z.union([z.literal(''),z.string().guid("Invalid uuid")]);
export const libraryFilters=z.object({status:z.enum(['active','archived','all','trash']).default('active'),folder:z.union([z.literal('all'),z.literal('root'),z.string().guid("Invalid uuid")]).optional(),query:z.string().max(200).default(''),type:z.enum(['all','image','document','spreadsheet','presentation','audio','video','archive','other']).default('all'),sort:z.enum(['addedDesc','addedAsc','nameAsc','nameDesc','sizeDesc','sizeAsc']).default('addedDesc')});
export type LibraryFilters=z.infer<typeof libraryFilters>;
export const libraryCursor=z.union([
 z.object({at:utcDateTime,id:z.string().guid("Invalid uuid")}).strict(),
 libraryFilters.omit({status:true}).extend({status:z.enum(['active','archived','all','trash']).optional(),v:z.literal(1),id:z.string().guid("Invalid uuid"),value:z.union([z.string().max(200),z.number().int().nonnegative()])}).strict(),
]);
export type LibraryCursor=z.infer<typeof libraryCursor>;
export function fileCategory(name:string):FileCategory{
 const ext=name.includes('.')?name.split('.').at(-1)!.toLowerCase():'';
 for(const [category,extensions] of Object.entries(fileExtensions))if((extensions as readonly string[]).includes(ext))return category as FileCategory;
 return 'other';
}
// UTF-8 preserves non-ASCII file names and searches in opaque API cursors.
export const encodeLibraryCursor=(cursor:LibraryCursor)=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))));
export const decodeLibraryCursor=(value:string)=>libraryCursor.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value),c=>c.charCodeAt(0)))));
