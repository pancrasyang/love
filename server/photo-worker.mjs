import {createHash,createHmac} from 'node:crypto';
import {ApiError,clearSession} from './session.mjs';
import {measure,requestDiagnostics} from './diagnostics.mjs';

const BASE='https://love-media-api.pancrasyang.workers.dev/api/media/';
const CHUNK=1048576,flights=new Map();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function checkedPhotoMeta(meta){
 if(!meta||!Number.isInteger(meta.size)||meta.size<=0||meta.size>10*CHUNK||!['image/jpeg','image/png','image/webp'].includes(meta.type)||!/^[a-f0-9]{64}$/.test(meta.sha256||'')||meta.version!==meta.sha256||!['original','thumbnail'].includes(meta.variant)||!/^[a-f0-9]{64}$/.test(meta.source_version||''))throw new ApiError(503,'照片元数据异常','MEDIA_METADATA');
 if(meta.variant==='thumbnail'&&(meta.type!=='image/webp'||meta.size>512*1024))throw new ApiError(503,'缩略图元数据异常','MEDIA_METADATA');
 return meta;
}
async function request(key,token,query,res,options={}){
 const response=await measure('worker',async()=>{try{return await fetch(BASE+encodeURIComponent(key)+'?photo=1&'+query,{...options,headers:{Authorization:'Bearer '+token,'Accept-Encoding':'identity','X-Photo-Request-Id':requestDiagnostics()?.request_id||'',...options.headers},signal:AbortSignal.timeout(25000)});}catch{throw new ApiError(503,'照片服务连接失败','MEDIA_SOURCE_NETWORK');}});
 // Never delegate to an older Worker that ignores photo=1 / business checks.
 if(response.headers.get('X-Love-Photo-Protocol')!=='2'){await response.body?.cancel();throw new ApiError(503,'照片服务版本尚未匹配','MEDIA_WORKER_PROTOCOL');}
 const stage=response.headers.get('X-Media-Stage');if(requestDiagnostics()&&['auth','profile','registry','business','r2_read','r2_thumbnail_read','r2_thumbnail_write'].includes(stage))requestDiagnostics().upstream_stage=stage;
 if(!response.ok){
  const data=await response.json().catch(()=>({}));
  if(response.status===404&&data.code==='MEDIA_VARIANT_NOT_FOUND')return {missing:checkedPhotoMeta(data.original)};
  let status=response.status,code=data.code||'MEDIA_SOURCE_UNAVAILABLE';
  if(status===401&&['AUTH_DENIED','SESSION_REQUIRED'].includes(code)){code='AUTH_USER';clearSession(res);}
  if(status===403&&code==='PROFILE_DENIED'){status=401;clearSession(res);}
  throw Object.assign(new ApiError(status,data.error||'照片请求失败',code),{retryAfter:response.headers.get('Retry-After')});
 }
 return {response};
}
async function boundedBody(response,size){
 const reader=response.body?.getReader();if(!reader)throw new ApiError(503,'照片内容为空','MEDIA_TRUNCATED');
 const parts=[];let total=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>size)throw new ApiError(503,'照片大小异常','MEDIA_METADATA_MISMATCH');parts.push(Buffer.from(value));}}
 finally{await reader.cancel().catch(()=>{});}
 if(total!==size)throw new ApiError(503,'照片传输中断','MEDIA_TRUNCATED');return Buffer.concat(parts,total);
}
export async function makeThumbnail(bytes){
 const {default:sharp}=await import('sharp');
 const result=await sharp(bytes,{limitInputPixels:60000000}).rotate().resize({width:960,height:960,fit:'inside',withoutEnlargement:true}).webp({quality:78,effort:4}).timeout({seconds:10}).toBuffer();
 if(result.length>512*1024)throw new ApiError(503,'缩略图超出上限','MEDIA_THUMBNAIL_SIZE');return result;
}
async function ensureThumbnail(key,token,original,res){
 const secret=process.env.LOVE_PHOTO_PROXY_SECRET;
 if(!secret||secret.length<32){res.setHeader('X-Photo-Thumbnail-Fallback','MEDIA_THUMBNAIL_CONFIG');return original;}
 const id=digest(token)+'|'+key+'|'+original.version;
 if(flights.has(id))return flights.get(id);
 const flight=(async()=>{
  const {response}=await request(key,token,'variant=original&version='+original.version,res);
  if(response.status!==200||response.headers.get('X-Media-Version')!==original.version||response.headers.get('Content-Type')!==original.type||Number(response.headers.get('Content-Length'))!==original.size){await response.body?.cancel();throw new ApiError(503,'原图版本或大小不一致','MEDIA_METADATA_MISMATCH');}
  const bytes=await boundedBody(response,original.size);
  if(digest(bytes)!==original.sha256)throw new ApiError(503,'原图完整性校验失败','MEDIA_HASH_MISMATCH');
  const thumbnail=await measure('thumbnail_encode',()=>makeThumbnail(bytes)),hash=digest(thumbnail),stamp=String(Date.now());
  const proof=createHmac('sha256',secret).update(JSON.stringify([key,original.version,hash,thumbnail.length,stamp])).digest('hex');
  const result=await request(key,token,'variant=thumbnail&version='+original.version,res,{method:'POST',body:thumbnail,headers:{'Content-Type':'image/webp','X-Photo-Timestamp':stamp,'X-Photo-Proof':proof}});
  return checkedPhotoMeta(await result.response.json());
 })();flights.set(id,flight);try{return await flight;}finally{flights.delete(id);}
}
export async function workerPhoto(url,token,metaOnly,start,res){
 const key=url.searchParams.get('key'),variant=url.searchParams.get('variant')||'original',version=url.searchParams.get('version');
 const query='variant='+variant+(metaOnly?'&meta=1':'')+(version?'&version='+version:'');
 let {response,missing}=await request(key,token,query,res,metaOnly?{}:{headers:{Range:`bytes=${start}-${start+CHUNK-1}`}});
 if(missing){
  if(!metaOnly)throw new ApiError(412,'缩略图已更新，请重试','MEDIA_VERSION_CHANGED');
  let meta;
  try{meta=await ensureThumbnail(key,token,missing,res);}catch(error){if([401,403,412].includes(error.status)||['MEDIA_HASH_MISMATCH','MEDIA_METADATA_MISMATCH'].includes(error.code))throw error;res.setHeader('X-Photo-Thumbnail-Fallback',error instanceof ApiError?error.code:'MEDIA_THUMBNAIL_ENCODE');meta=missing;}
  return {meta};
 }
 if(metaOnly)return {meta:checkedPhotoMeta(await response.json())};
 const range=response.headers.get('Content-Range')?.match(/^bytes \d+-\d+\/(\d+)$/);
 try{
  const meta=checkedPhotoMeta({size:Number(range?.[1]),type:response.headers.get('Content-Type'),version:response.headers.get('X-Media-Version'),sha256:response.headers.get('X-Media-Version'),variant:response.headers.get('X-Media-Variant'),source_version:response.headers.get('X-Media-Source-Version')});
  return {response,meta};
 }catch(error){await response.body?.cancel();throw error;}
}
