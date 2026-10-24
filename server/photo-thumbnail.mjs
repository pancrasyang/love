import {privateResponse,csrf,photoCredentials,ApiError,failure} from './session.mjs';
import {prepareWorkerThumbnail} from './photo-worker.mjs';
import {withDiagnostics} from './diagnostics.mjs';

const BODY_LIMIT=4096;
const KEY=/^(?:daily|spot)\/[0-9a-f-]{36}\/(?:[0-9a-f-]{36}|legacy)\/[a-f0-9-]+\.(?:jpg|png|webp)$/;

function input(req){
 const length=Number(req.headers['content-length']);if(Number.isFinite(length)&&length>BODY_LIMIT)throw new ApiError(413,'缩略图请求过大','MEDIA_THUMBNAIL_INPUT');
 if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw new ApiError(415,'请求格式不支持','MEDIA_THUMBNAIL_INPUT');
 let body=req.body;if(typeof body==='string'){if(Buffer.byteLength(body)>BODY_LIMIT)throw new ApiError(413,'缩略图请求过大','MEDIA_THUMBNAIL_INPUT');try{body=JSON.parse(body);}catch{throw new ApiError(400,'缩略图参数不正确','MEDIA_THUMBNAIL_INPUT');}}
 let encoded;try{encoded=JSON.stringify(body);}catch{throw new ApiError(400,'缩略图参数不正确','MEDIA_THUMBNAIL_INPUT');}
 if(!body||Buffer.byteLength(encoded)>BODY_LIMIT||Object.keys(body).sort().join(',')!=='key'||!KEY.test(body.key||''))throw new ApiError(400,'缩略图参数不正确','MEDIA_THUMBNAIL_INPUT');
 return body.key;
}

export function photoThumbnailHandler(req,res){return withDiagnostics(res,async()=>{
 privateResponse(res);
 try{
  if(req.method!=='POST')throw new ApiError(405,'请求方式不支持','MEDIA_METHOD');csrf(req);
  const key=input(req),session=await photoCredentials(req,res),result=await prepareWorkerThumbnail(key,session.access_token,res);
  return res.status(result.generated?201:200).json({status:'ready',generated:result.generated,version:result.meta.version,source_version:result.meta.source_version});
 }catch(error){return failure(res,error instanceof ApiError?error:new ApiError(503,'缩略图暂时无法生成','MEDIA_THUMBNAIL_UNAVAILABLE'));}
},{photo:true});}
