import {inspectImage,MAX_BYTES} from './image-type.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^(?:daily|spot)\/[0-9a-f-]{36}\/(?:[0-9a-f-]{36}|legacy)\/[a-f0-9-]+\.(?:jpg|png|webp)$/;
class HttpError extends Error{constructor(status,message,code='MEDIA_REQUEST'){super(message);this.status=status;this.code=code;}}
async function limitedBody(request){
 if(Number(request.headers.get('content-length'))>MAX_BYTES)throw new HttpError(413,'图片不能超过 10MB');
 const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'图片为空');let n=0;const chunks=[];
 try{for(;;){const {value,done}=await reader.read();if(done)break;n+=value.length;if(n>MAX_BYTES){await reader.cancel();throw new HttpError(413,'图片不能超过 10MB');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(n);let pos=0;for(const c of chunks){bytes.set(c,pos);pos+=c.length;}return bytes;
}
async function handle(request,env,trace){
 async function measure(stage,action){
  trace.stage=stage;const began=Date.now();
  try{const result=await action();trace.stages.push({stage,status:result?.status||200,elapsed_ms:Date.now()-began});return result;}
  catch(error){if(error instanceof HttpError)error.stage=stage;trace.stages.push({stage,status:error.status||503,elapsed_ms:Date.now()-began});throw error;}
 }
 const origin=request.headers.get('Origin');const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
 const headers=new Headers({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'});
 const json=(body,status=200)=>{if(body.code)trace.code=body.code;return new Response(JSON.stringify(status>=400?{...body,request_id:trace.request_id,stage:trace.stage}:body),{status,headers:new Headers([...headers,['Content-Type','application/json']])});};
 if(!allowed.length)return json({error:'文件服务尚未配置',code:'MEDIA_CONFIG'},503);
 if(origin&&!allowed.includes(origin))return json({error:'来源不允许',code:'MEDIA_ORIGIN_DENIED'},403);
 if(origin){headers.set('Access-Control-Allow-Origin',origin);headers.set('Access-Control-Allow-Methods','GET,HEAD,POST,DELETE,OPTIONS');headers.set('Access-Control-Allow-Headers','Authorization,Content-Type,X-Record-Id,Range');}
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
 try{
  const auth=request.headers.get('Authorization');if(!/^Bearer [^\s]+$/.test(auth||''))throw new HttpError(401,'请先登录','SESSION_REQUIRED');
  if(!env.SUPABASE_URL||!env.SUPABASE_PUBLISHABLE_KEY)throw new HttpError(503,'文件服务尚未配置','MEDIA_CONFIG');
  const dbHeaders={apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:auth};
  async function rest(path,options={},stage='registry'){
   return measure(stage,async()=>{
    let response;try{response=await fetch(env.SUPABASE_URL+path,{...options,headers:{...dbHeaders,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});}catch{throw new HttpError(503,'文件服务连接失败，请稍后重试',stage.toUpperCase()+'_NETWORK');}
    if(response.status===429){const retryAfter=response.headers.get('Retry-After');if(retryAfter&&retryAfter.length<=128&&(/^\d+$/.test(retryAfter)||Number.isFinite(Date.parse(retryAfter))))headers.set('Retry-After',retryAfter);throw new HttpError(429,'文件服务请求过于频繁，请稍后重试',stage.toUpperCase()+'_RATE_LIMITED');}
    if(!response.ok){
     const status=response.status===401?401:[400,403].includes(response.status)?403:503;
     throw new HttpError(status,status===503?'文件服务暂时不可用，请稍后重试':'身份或文件操作权限验证失败',stage.toUpperCase()+(status===503?'_UNAVAILABLE':'_DENIED'));
    }
    const text=await response.text();return text?JSON.parse(text):null;
   });
  }
  const user=await rest('/auth/v1/user',{},'auth');
  if(!user?.id)throw new HttpError(503,'身份服务响应异常','AUTH_RESPONSE');
  const profiles=await rest(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role`,{},'profile');
  if(!Array.isArray(profiles))throw new HttpError(503,'账号权限服务响应异常','PROFILE_RESPONSE');
  if(profiles.length!==1||!['pengpeng','kaikai'].includes(profiles[0].role))throw new HttpError(403,'账号未授权或会话已退出','PROFILE_DENIED');
  const url=new URL(request.url),path=url.pathname;
  if(path==='/api/media'&&request.method==='POST'){
   const recordId=request.headers.get('X-Record-Id');if(!UUID.test(recordId||''))throw new HttpError(400,'记录编号不正确');
   let bytes=await limitedBody(request);let image;
   try{image=inspectImage(bytes,request.headers.get('Content-Type'));}catch(e){throw new HttpError(415,e.message);}
   // Keep the complete image codestream; discard opaque bytes after JPEG EOI.
   bytes=bytes.subarray(0,image.byteLength);
   const key=`daily/${recordId}/${user.id}/${crypto.randomUUID()}.${image.ext}`;
   const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
   await measure('r2_write',()=>env.LOVE_MEDIA.put(key,bytes,{httpMetadata:{contentType:image.type},customMetadata:{owner:user.id,recordId,sha256}}));
   try{await rest('/rest/v1/media_objects',{method:'POST',body:JSON.stringify({key,record_id:recordId,owner_id:user.id,content_type:image.type,size_bytes:bytes.length,sha256})});}
   catch(error){await measure('r2_rollback',()=>env.LOVE_MEDIA.delete(key));throw error;}
   return json({key,sha256,size:bytes.length,content_type:image.type},201);
  }
  if(!path.startsWith('/api/media/'))throw new HttpError(404,'接口不存在');
  let key;try{key=decodeURIComponent(path.slice('/api/media/'.length));}catch{throw new HttpError(400,'文件编号不正确');}
  if(!KEY.test(key))throw new HttpError(400,'文件编号不正确');
  const rows=await rest(`/rest/v1/media_objects?key=eq.${encodeURIComponent(key)}&select=*`);
  const row=rows?.[0];if(!row)throw new HttpError(404,'文件不存在或无权访问');
  if(request.method==='GET'||request.method==='HEAD'){
   if(row.state!=='ready')throw new HttpError(404,'文件已删除');
   const rangeHeader=request.headers.get('Range');let range;
   if(rangeHeader){const match=rangeHeader.match(/^bytes=(\d+)-(\d*)$/);if(!match)throw new HttpError(416,'文件分段范围不正确');const start=Number(match[1]),end=match[2]?Number(match[2]):row.size_bytes-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=row.size_bytes)throw new HttpError(416,'文件分段范围不正确');range={offset:start,length:Math.min(end,row.size_bytes-1)-start+1};}
   const object=await measure('r2_read',()=>env.LOVE_MEDIA.get(key,range?{range}:undefined));if(!object)throw new HttpError(404,'文件不存在','MEDIA_NOT_FOUND');
   if(row.size_bytes&&object.size!==row.size_bytes)throw new HttpError(503,'文件大小与登记不一致');
   headers.set('Content-Type',row.content_type);headers.set('Content-Length',String(range?.length||object.size));headers.set('Content-Disposition','inline');headers.set('Accept-Ranges','bytes');
   if(row.sha256){headers.set('X-Media-Version',row.sha256);headers.set('ETag','"'+row.sha256+'"');}
   if(range)headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${object.size}`);
   headers.set('Access-Control-Expose-Headers','Content-Range,Content-Length,ETag,X-Media-Version,X-Photo-Request-Id,X-Media-Stage');
   if(request.method==='HEAD'){try{await object.body?.cancel?.();}catch{}return new Response(null,{headers});}
   return new Response(object.body,{status:range?206:200,headers});
  }
  if(request.method==='DELETE'){
   if(row.owner_id!==user.id)throw new HttpError(403,'只能删除自己的照片');
   const canDelete=await rest('/rest/v1/rpc/begin_media_delete',{method:'POST',body:JSON.stringify({media_key:key})},'begin_delete');
   if(!canDelete)throw new HttpError(404,'文件不存在');
   await measure('r2_delete',()=>env.LOVE_MEDIA.delete(key));
   await rest('/rest/v1/rpc/finish_media_delete',{method:'POST',body:JSON.stringify({media_key:key})},'finish_delete');
   return new Response(null,{status:204,headers});
  }
  throw new HttpError(405,'请求方式不支持');
 }catch(error){if(error instanceof HttpError&&error.stage)trace.stage=error.stage;trace.code=error instanceof HttpError?error.code:'MEDIA_UNAVAILABLE';return json({error:error instanceof HttpError?error.message:'文件服务暂时不可用，请重试',code:trace.code},error instanceof HttpError?error.status:503);}
}
export default {async fetch(request,env){
 const incoming=request.headers.get('X-Photo-Request-Id');
 const trace={request_id:UUID.test(incoming||'')?incoming:crypto.randomUUID(),stage:'request',stages:[]},began=Date.now();
 const response=await handle(request,env,trace);
 response.headers.set('X-Photo-Request-Id',trace.request_id);response.headers.set('X-Media-Stage',trace.stage);
 console[response.status>=400?'warn':'info'](JSON.stringify({...trace,status:response.status,elapsed_ms:Date.now()-began}));
 return response;
}};
