// Limit bytes while reading so an undeclared or incorrect length cannot bypass the cap.
export async function readBoundedRequestText(request:Pick<Request,'body'|'headers'>,maxBytes:number){
 if(Number(request.headers.get('content-length'))>maxBytes){
  void request.body?.cancel().catch(()=>{});
  return null;
 }
 if(!request.body)return '';
 const reader=request.body.getReader(),decoder=new TextDecoder();
 let bytes=0,text='';
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)return text+decoder.decode();
   bytes+=value.byteLength;
   if(bytes>maxBytes){
    void reader.cancel().catch(()=>{});
    return null;
   }
   text+=decoder.decode(value,{stream:true});
  }
 }finally{reader.releaseLock();}
}
