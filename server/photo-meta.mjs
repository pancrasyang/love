import {privateResponse,csrf,photoCredentials,ApiError,failure} from './session.mjs';
import {workerPhotoBatch} from './photo-worker.mjs';
import {requestDiagnostics,withDiagnostics} from './diagnostics.mjs';

const BODY_LIMIT=8192;
const KEY=/^(?:daily|spot)\/[0-9a-f-]{36}\/(?:[0-9a-f-]{36}|legacy)\/[a-f0-9-]+\.(?:jpg|png|webp)$/;

function input(req){
 const length=Number(req.headers['content-length']);if(Number.isFinite(length)&&length>BODY_LIMIT)throw new ApiError(413,'批量请求过大','MEDIA_BATCH_SIZE');
 if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw new ApiError(415,'请求格式不支持','MEDIA_BATCH_INPUT');
 let body=req.body;if(typeof body==='string'){if(Buffer.byteLength(body)>BODY_LIMIT)throw new ApiError(413,'批量请求过大','MEDIA_BATCH_SIZE');try{body=JSON.parse(body);}catch{throw new ApiError(400,'批量照片参数不正确','MEDIA_BATCH_INPUT');}}
 let encoded;try{encoded=JSON.stringify(body);}catch{throw new ApiError(400,'批量照片参数不正确','MEDIA_BATCH_INPUT');}
 if(!body||Buffer.byteLength(encoded)>BODY_LIMIT||Object.keys(body).length!==1||!Array.isArray(body.items)||body.items.length<1||body.items.length>20)throw new ApiError(400,'批量照片参数不正确','MEDIA_BATCH_INPUT');
 const pairs=new Set(),keys=new Set();
 for(const item of body.items){if(!item||Object.keys(item).sort().join(',')!=='key,variant'||!KEY.test(item.key||'')||!['original','thumbnail'].includes(item.variant)||pairs.has(item.key+'\0'+item.variant))throw new ApiError(400,'批量照片参数不正确','MEDIA_BATCH_INPUT');pairs.add(item.key+'\0'+item.variant);keys.add(item.key);}
 if(keys.size>20)throw new ApiError(400,'批量照片参数不正确','MEDIA_BATCH_INPUT');return body.items;
}

export function photoMetaHandler(req,res){return withDiagnostics(res,async()=>{
 privateResponse(res);
 try{
  if(req.method!=='POST')throw new ApiError(405,'请求方式不支持','MEDIA_METHOD');csrf(req);
  const items=input(req),trace=requestDiagnostics();trace.batch_items=items.length;
  const session=await photoCredentials(req,res),data=await workerPhotoBatch(items,session.access_token,res);
  trace.batch_available=data.results.filter(result=>result.status==='available').length;return res.status(200).json(data);
 }catch(error){return failure(res,error instanceof ApiError?error:new ApiError(503,'照片服务暂时不可用','MEDIA_UNKNOWN'));}
},{photo:true});}
