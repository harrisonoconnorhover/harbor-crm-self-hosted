import {attachmentImageType,MAX_ATTACHMENT_BYTES} from '../lib/activity-attachments';
import {maxLandingImageChars,maxLandingImageSide} from '../lib/portable-landing';

// Re-encode only the rendered pixels. The published copy needs no original filename or photo metadata.
export async function prepareLandingImage(file:File){
  if(file.size>MAX_ATTACHMENT_BYTES)throw Error('Choose a picture of 10 MB or less.');
  const type=attachmentImageType(new Uint8Array(await file.slice(0,12).arrayBuffer()));
  if(!type||!['image/png','image/jpeg','image/webp'].includes(type))throw Error('Choose a JPEG, PNG or WebP picture.');
  const bitmap=await createImageBitmap(file);
  try{
    const canvas=document.createElement('canvas');
    const ctx=canvas.getContext('2d');
    if(!ctx)throw Error('This browser could not prepare the picture.');
    let scale=Math.min(1,maxLandingImageSide/Math.max(bitmap.width,bitmap.height));
    for(;;){
      canvas.width=Math.max(1,Math.round(bitmap.width*scale));
      canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      ctx.fillStyle='white';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const url=canvas.toDataURL('image/jpeg',0.84);
      if(!url.startsWith('data:image/jpeg;base64,'))throw Error('This browser could not encode the picture.');
      const jpeg=url.slice('data:image/jpeg;base64,'.length);
      if(jpeg.length<=maxLandingImageChars)return {jpeg,width:canvas.width,height:canvas.height};
      scale*=0.75;
    }
  }finally{bitmap.close();}
}
