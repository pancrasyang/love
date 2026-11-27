import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {privateResponse,authenticate,upstream,ApiError,failure} from './session.mjs';
import {storageThumbnail} from './storage-thumbnail.mjs';
import {measure,withDiagnostics} from './diagnostics.mjs';

const MAX_PHOTO_BYTES=20*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TYPES=['image/jpeg','image/png','image/webp'];
const PHOTO_PARAMS=['source','id','kind','variant'];
const STORAGE_TAG=/^"([A-Za-z0-9._-]{1,128})"$/;

export function sourcePath(row){
 let path=row.photo_path;
 if(!path){
  let url;
  try{url=new URL(row.photo_url);}catch{throw new ApiError(404,'历史照片不存在','PHOTO_SOURCE');}
  if(url.origin!==new URL(process.env.SUPABASE_URL).origin)throw new ApiError(404,'历史照片来源不支持','PHOTO_SOURCE');
  const match=url.pathname.match(/^\/storage\/v1\/object\/(?:public|authenticated)\/love-photos\/(.+)$/);
  if(!match)throw new ApiError(404,'历史照片来源不支持','PHOTO_SOURCE');
  try{path=decodeURIComponent(match[1]);}catch{throw new ApiError(404,'历史照片路径异常','PHOTO_SOURCE');}
 }
 if(typeof path!=='string'||path.length>1024||path.split('/').some(p=>!p||p==='.'||p==='..')||/[\\\x00-\x1f?#]/.test(path)){
  throw new ApiError(404,'历史照片路径异常','PHOTO_SOURCE');
 }
 return path.split('/').map(encodeURIComponent).join('/');
}

function photoInput(req){
 const {searchParams}=new URL(req.url,'https://local.invalid');
 const id=searchParams.get('id'),kind=searchParams.get('kind')||'daily',variant=searchParams.get('variant')||'original';
 if([...searchParams.keys()].some(name=>!PHOTO_PARAMS.includes(name)||searchParams.getAll(name).length!==1)||
    searchParams.get('source')!=='legacy'||!UUID.test(id||'')||!['daily','spot'].includes(kind)||!['thumbnail','original'].includes(variant)){
  throw new ApiError(400,'照片参数不正确，请刷新页面','MEDIA_INPUT');
 }
 return {id,table:kind==='daily'?'daily_checkins':'spot_checkins',variant};
}

function upstreamStatus(response,{storage=false}={}){
 if(response.status===404||(storage&&response.status===400))throw new ApiError(404,'照片不存在或已删除','MEDIA_NOT_FOUND');
 if(response.status===401||response.status===403)throw new ApiError(response.status,'照片访问被拒绝','MEDIA_SOURCE_DENIED');
 if(response.status===429)throw Object.assign(new ApiError(429,'照片来源请求过于频繁，请稍后重试','MEDIA_SOURCE_RATE_LIMITED'),{retryAfter:response.headers.get('Retry-After')});
 if(response.status!==200)throw new ApiError(503,'照片来源暂时无法连接','MEDIA_SOURCE_UNAVAILABLE');
}

function photoDetails(response){
 const type=(response.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
 const size=Number(response.headers.get('Content-Length'));
 if(!IMAGE_TYPES.includes(type))throw new ApiError(415,'照片格式不支持','MEDIA_FORMAT');
 if(!Number.isInteger(size)||size<=0||!response.body)throw new ApiError(503,'照片长度信息不完整','MEDIA_LENGTH_INVALID');
 if(size>MAX_PHOTO_BYTES)throw new ApiError(413,'照片超过读取上限','MEDIA_SIZE_LIMIT');
 return {type,size};
}

// A weak validator identifies the selected view of a Storage object. The list
// can reuse its cached original when a smaller thumbnail was unavailable.
function photoValidator(requestTag,variant){
 const prefix=variant==='thumbnail'?'W/"thumbnail-v1-':'W/"original-v1-';
 const supplied=typeof requestTag==='string'&&requestTag.startsWith(prefix)?'"'+requestTag.slice(prefix.length):null;
 return {
  sourceTag:STORAGE_TAG.test(supplied||'')?supplied:null,
  forSource(value){const match=STORAGE_TAG.exec(value||'');return match?prefix+match[1]+'"':null;}
 };
}

async function writePhoto(res,body,{type,size,variant}){
 res.statusCode=200;
 res.setHeader('Content-Type',type);
 res.setHeader('Content-Length',String(size));
 res.setHeader('X-Media-Variant',variant);
 await measure('photo_body',()=>pipeline(body,res));
}

export function photoHandler(req,res){return withDiagnostics(res,async()=>{
 privateResponse(res);
 let source;
 try{
  if(req.method!=='GET')throw new ApiError(405,'请求方式不支持','MEDIA_METHOD');
  if(req.headers['sec-fetch-site']==='cross-site')throw new ApiError(403,'请求来源验证失败','CSRF_REJECTED');
  const {id,table,variant}=photoInput(req);
  const {access_token:token}=await authenticate(req,res);
  const record=await upstream(`/rest/v1/${table}?id=eq.${id}&select=photo_url,photo_path&limit=1`,token,{},'BUSINESS');
  upstreamStatus(record);
  const rows=await record.json();
  if(rows.length!==1)throw new ApiError(404,'照片记录不存在','MEDIA_NOT_FOUND');
  const path=sourcePath(rows[0]);

  const requestTag=req.headers['if-none-match'];
  const validator=photoValidator(requestTag,variant);
  const headers={'Accept-Encoding':'identity'};
  if(validator.sourceTag)headers['If-None-Match']=validator.sourceTag;
  source=await upstream('/storage/v1/object/authenticated/love-photos/'+path,token,{
   headers,signal:AbortSignal.timeout(45000)
  },'LEGACY_STORAGE');
  if(source.status===304&&validator.sourceTag){
   res.setHeader('ETag',requestTag);
   return res.status(304).end();
  }

  upstreamStatus(source,{storage:true});
  const details=photoDetails(source);
  const etag=validator.forSource(source.headers.get('ETag'));
  if(etag){
   res.setHeader('ETag',etag);
   if(etag===requestTag)return res.status(304).end();
  }
  if(variant==='original'){
   return await writePhoto(res,Readable.fromWeb(source.body),{...details,variant});
  }

  const original=Buffer.from(await source.arrayBuffer());
  if(original.length!==details.size)throw new ApiError(503,'照片传输不完整，请重试','MEDIA_TRUNCATED');
  const thumbnail=await measure('photo_thumbnail',()=>storageThumbnail(original));
  if(thumbnail){
   return await writePhoto(res,Readable.from([thumbnail]),{type:'image/webp',size:thumbnail.length,variant});
  }
  return await writePhoto(res,Readable.from([original]),{...details,variant:'original'});
 }catch(error){
  if(res.headersSent||res.destroyed){
   if(!res.destroyed)res.destroy();
   return;
  }
  res.removeHeader('ETag');
  return failure(res,error instanceof ApiError?error:new ApiError(503,'照片服务暂时不可用','MEDIA_UNKNOWN'));
 }finally{
  if(source?.body&&!source.bodyUsed)await source.body.cancel().catch(()=>{});
 }
},{photo:true});}
