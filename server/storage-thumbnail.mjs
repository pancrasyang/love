import {createHash} from 'node:crypto';
import {upstream,ApiError} from './session.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Authorization and the business-row lookup run in photos.mjs on EVERY request.
// Cache derived bytes only; bounded memory, short TTL, and a token-specific key.
const thumbnails=new Map();
export async function storageThumbnail(path,token,url,metaOnly,start){
 const probe=await upstream('/storage/v1/object/authenticated/love-photos/'+path,token,{headers:{Range:'bytes=0-0','Accept-Encoding':'identity'}},'LEGACY_STORAGE');
 if(!probe.ok){await probe.body?.cancel();throw new ApiError(probe.status===404?404:503,'照片暂不可用','MEDIA_NOT_FOUND');}
 const tag=probe.headers.get('ETag'),size=Number(probe.headers.get('Content-Range')?.match(/\/(\d+)$/)?.[1]||probe.headers.get('Content-Length'));
 await probe.body?.cancel();
 if(!Number.isInteger(size)||size<1||size>20*1048576)throw new ApiError(503,'照片长度异常','MEDIA_METADATA');
 const cacheKey=hash(token)+'|'+path+'|'+tag+'|'+size;
 for(const [key,value] of thumbnails)if(value.until<Date.now())thumbnails.delete(key);
 let value=tag?thumbnails.get(cacheKey):null;
 if(!value){
  const response=await upstream('/storage/v1/object/authenticated/love-photos/'+path,token,{headers:{'Accept-Encoding':'identity',...(tag?{'If-Match':tag}:{})}},'LEGACY_STORAGE');
  if(!response.ok)throw new ApiError(response.status===412?412:503,'照片读取失败','MEDIA_VERSION_CHANGED');
  const reader=response.body?.getReader();if(!reader)throw new ApiError(503,'照片内容为空','MEDIA_TRUNCATED');
  let total=0;const parts=[];
  try{for(;;){const {done,value:chunk}=await reader.read();if(done)break;total+=chunk.length;if(total>size)throw new ApiError(503,'照片大小异常','MEDIA_METADATA');parts.push(Buffer.from(chunk));}}finally{await reader.cancel().catch(()=>{});}
  if(total!==size)throw new ApiError(503,'照片传输不完整','MEDIA_TRUNCATED');
  const original=Buffer.concat(parts,total),{default:sharp}=await import('sharp');
  const bytes=await sharp(original,{limitInputPixels:60000000}).rotate().resize({width:960,height:960,fit:'inside',withoutEnlargement:true}).webp({quality:78,effort:4}).timeout({seconds:10}).toBuffer();
  if(bytes.length>512*1024)throw new ApiError(503,'缩略图过大','MEDIA_THUMBNAIL_SIZE');
  const version=hash(bytes);value={bytes,until:Date.now()+60000,meta:{size:bytes.length,type:'image/webp',version,sha256:version,variant:'thumbnail',source_version:hash(original)}};
  while(thumbnails.size>=32)thumbnails.delete(thumbnails.keys().next().value);
  if(tag)thumbnails.set(cacheKey,value);
 }
 if(url.searchParams.has('version')&&url.searchParams.get('version')!==value.meta.version)throw new ApiError(412,'照片已更新，请重试','MEDIA_VERSION_CHANGED');
 if(metaOnly)return {meta:value.meta};
 if(start>=value.bytes.length)throw new ApiError(416,'照片分段范围不正确','MEDIA_RANGE_INVALID');
 const end=Math.min(start+1048576,value.bytes.length);
 return {meta:value.meta,response:new Response(value.bytes.subarray(start,end),{status:206,headers:{'Content-Type':'image/webp','Content-Length':String(end-start),'Content-Range':`bytes ${start}-${end-1}/${value.bytes.length}`}})};
}
