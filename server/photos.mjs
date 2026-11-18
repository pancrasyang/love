import {createHash} from 'node:crypto';
import {privateResponse,authenticate,upstream,ApiError,failure} from './session.mjs';
import {storageThumbnail} from './storage-thumbnail.mjs';
import {measure,withDiagnostics} from './diagnostics.mjs';
const CHUNK=1048576,MAX=20*CHUNK,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const types=['image/jpeg','image/png','image/webp'];
export function sourcePath(row){
 let path=row.photo_path;
 if(!path){let url;try{url=new URL(row.photo_url);}catch{throw new ApiError(404,'历史照片不存在','PHOTO_SOURCE');}
  if(url.origin!==new URL(process.env.SUPABASE_URL).origin)throw new ApiError(404,'历史照片来源不支持','PHOTO_SOURCE');
  const match=url.pathname.match(/^\/storage\/v1\/object\/(?:public|authenticated)\/love-photos\/(.+)$/);if(!match)throw new ApiError(404,'历史照片来源不支持','PHOTO_SOURCE');
  try{path=decodeURIComponent(match[1]);}catch{throw new ApiError(404,'历史照片路径异常','PHOTO_SOURCE');}
 }
 if(typeof path!=='string'||path.length>1024||path.split('/').some(p=>!p||p==='.'||p==='..')||/[\\\x00-\x1f?#]/.test(path))throw new ApiError(404,'历史照片路径异常','PHOTO_SOURCE');
 return path.split('/').map(encodeURIComponent).join('/');
}
function upstreamStatus(response){
 if(response.status===404)throw new ApiError(404,'照片不存在或已删除','MEDIA_NOT_FOUND');
 if(response.status===401||response.status===403)throw new ApiError(response.status,'照片访问被拒绝','MEDIA_SOURCE_DENIED');
 if(response.status===416)throw new ApiError(416,'照片分段范围不正确','MEDIA_RANGE_INVALID');
 if(response.status===429)throw Object.assign(new ApiError(429,'照片来源请求过于频繁，请稍后重试','MEDIA_SOURCE_RATE_LIMITED'),{retryAfter:response.headers.get('Retry-After')});
 if(!response.ok)throw new ApiError(503,'照片来源暂时无法连接','MEDIA_SOURCE_UNAVAILABLE');
}
async function requireVersion(url,meta,response){
 const expected=url.searchParams.get('version');
 if(expected!==null&&expected!==meta.version){try{await response?.body?.cancel();}catch{}throw new ApiError(412,'照片已更新，请重试','MEDIA_VERSION_CHANGED');}
}
function details(response){
 const type=(response.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
 const range=response.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
 const length=response.headers.get('Content-Length'),size=response.status===206?Number(range?.[3]):length===null?NaN:Number(length);
 if(!types.includes(type))throw new ApiError(415,'照片格式不支持','MEDIA_FORMAT');
 if(!Number.isInteger(size)||size<=0)throw new ApiError(503,'照片长度信息不完整','MEDIA_LENGTH_INVALID');
 if(size>MAX)throw new ApiError(413,'照片超过读取上限','MEDIA_SIZE_LIMIT');
 return {type,size,range};
}
async function windowBytes(response,start,size){
 const {range}=details(response),end=Math.min(start+CHUNK-1,size-1);
 if(start>=size)throw new ApiError(416,'照片分段范围不正确','MEDIA_RANGE_INVALID');
 if(response.status===206&&(!range||Number(range[1])!==start||Number(range[2])!==end))throw new ApiError(503,'照片分段响应不正确','MEDIA_RANGE_INVALID');
 const reader=response.body?.getReader();if(!reader)throw new ApiError(503,'照片内容为空','MEDIA_TRUNCATED');
 let position=response.status===206?start:0,length=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;const a=Math.max(0,start-position),b=Math.min(value.length,end+1-position);if(b>a){chunks.push(Buffer.from(value.subarray(a,b)));length+=b-a;}position+=value.length;if(position>end)break;}}
 catch{throw new ApiError(503,'照片传输中断或超时，请重试','MEDIA_SOURCE_TIMEOUT');}
 finally{try{await reader.cancel();}catch{}}
 if(length!==end-start+1)throw new ApiError(503,'照片传输不完整，请重试','MEDIA_TRUNCATED');
 return Buffer.concat(chunks,length);
}
async function legacy(url,token,metaOnly,start){
 const id=url.searchParams.get('id'),kind=url.searchParams.get('kind')||'daily';if(!UUID.test(id||'')||!['daily','spot'].includes(kind))throw new ApiError(400,'照片参数不正确','MEDIA_INPUT');
 const table=kind==='daily'?'daily_checkins':'spot_checkins';
 const record=await upstream(`/rest/v1/${table}?id=eq.${id}&select=photo_url,photo_path&limit=1`,token,{},'BUSINESS');upstreamStatus(record);
 const rows=await record.json();if(rows.length!==1)throw new ApiError(404,'照片记录不存在','MEDIA_NOT_FOUND');
 const path=sourcePath(rows[0]);
 if(url.searchParams.get('variant')==='thumbnail'){
  try{return await storageThumbnail(path,token,url,metaOnly,start);}catch(error){
   if(error instanceof ApiError&&error.status!==503)throw error;
   // Explicit original fallback retains authorization and the original cache namespace.
  }
 }
 const end=metaOnly?0:start+CHUNK-1;
 const response=await upstream('/storage/v1/object/authenticated/love-photos/'+path,token,{headers:{Range:`bytes=${metaOnly?0:start}-${end}`,'Accept-Encoding':'identity'}},'LEGACY_STORAGE');upstreamStatus(response);
 const meta=details(response),strongEtag=response.headers.get('ETag')||'',etag=strongEtag||response.headers.get('Last-Modified')||'';
 meta.resumable=/^"[^"\x00-\x20\x7f]*"$/.test(strongEtag);
 meta.version=createHash('sha256').update(path+'|'+etag+'|'+meta.type+'|'+meta.size).digest('hex');delete meta.range;
 await requireVersion(url,meta,response);
 return {response,meta};
}
export function photoHandler(req,res){return withDiagnostics(res,async()=>{
 privateResponse(res);
 try{
  if(req.method!=='GET')throw new ApiError(405,'请求方式不支持','MEDIA_METHOD');
  if(req.headers['sec-fetch-site']==='cross-site')throw new ApiError(403,'请求来源验证失败','CSRF_REJECTED');
  const url=new URL(req.url,'https://local.invalid'),source=url.searchParams.get('source'),partText=url.searchParams.get('part')||'0',metaOnly=url.searchParams.get('meta')==='1';
  const version=url.searchParams.get('version');
  const compact=url.searchParams.get('compact')==='1';
  if(source!=='legacy'||!/^\d+$/.test(partText)||Number(partText)>=20||url.searchParams.getAll('version').length>1||(version!==null&&!/^[a-f0-9]{64}$/.test(version))||url.searchParams.getAll('compact').length>1)throw new ApiError(400,'照片参数不正确','MEDIA_INPUT');
  const variant=url.searchParams.get('variant')||'original';
  if(!['original','thumbnail'].includes(variant)||url.searchParams.getAll('variant').length>1)throw new ApiError(400,'照片参数不正确','MEDIA_INPUT');
  if(compact)throw new ApiError(400,'照片参数不正确','MEDIA_INPUT');
  const session=await authenticate(req,res),start=Number(partText)*CHUNK;
  let {response,meta}=await legacy(url,session.access_token,metaOnly,start);
  meta.variant||='original';
  res.setHeader('X-Media-Version',meta.version);res.setHeader('ETag','"'+meta.version+'"');
  if(meta.sha256)res.setHeader('X-Media-Sha256',meta.sha256);if(meta.variant)res.setHeader('X-Media-Variant',meta.variant);if(meta.source_version)res.setHeader('X-Media-Source-Version',meta.source_version);
  if(metaOnly){try{await response?.body?.cancel();}catch{}return res.status(200).json(meta);}
  const body=await measure('photo_body',()=>windowBytes(response,start,meta.size));
  res.setHeader('Content-Type',meta.type);res.setHeader('Content-Range',`bytes ${start}-${start+body.length-1}/${meta.size}`);res.setHeader('Accept-Ranges','bytes');return res.status(206).send(body);
 }catch(error){
  return failure(res,error instanceof ApiError?error:new ApiError(503,'照片服务暂时不可用','MEDIA_UNKNOWN'));
 }
},{photo:true});}
