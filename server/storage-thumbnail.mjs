// Reuse the existing thumbnail format. If it cannot save bytes, serve the
// original already read from Storage in the same request.
export async function storageThumbnail(original){
 try{
  const {default:sharp}=await import('sharp');
  const thumbnail=await sharp(original,{limitInputPixels:60000000})
   .rotate()
   .resize({width:960,height:960,fit:'inside',withoutEnlargement:true})
   .webp({quality:78,effort:4})
   .timeout({seconds:10})
   .toBuffer();
  return thumbnail.length<original.length&&thumbnail.length<=512*1024?thumbnail:null;
 }catch{
  return null;
 }
}
