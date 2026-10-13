import {inspectImage,MAX_BYTES} from './image-type.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^(?:daily|spot)\/[0-9a-f-]{36}\/(?:[0-9a-f-]{36}|legacy)\/[a-f0-9-]+\.(?:jpg|png|webp)$/;
class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
async function limitedBody(request){
 if(Number(request.headers.get('content-length'))>MAX_BYTES)throw new HttpError(413,'图片不能超过 10MB');
 const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'图片为空');let n=0;const chunks=[];
 try{for(;;){const {value,done}=await reader.read();if(done)break;n+=value.length;if(n>MAX_BYTES){await reader.cancel();throw new HttpError(413,'图片不能超过 10MB');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(n);let pos=0;for(const c of chunks){bytes.set(c,pos);pos+=c.length;}return bytes;
}
export default {async fetch(request,env){
 const origin=request.headers.get('Origin');const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
 const headers=new Headers({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'});
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:new Headers([...headers,['Content-Type','application/json']])});
 if(!allowed.length)return json({error:'文件服务尚未配置'},503);
 if(origin&&!allowed.includes(origin))return json({error:'来源不允许'},403);
 if(origin){headers.set('Access-Control-Allow-Origin',origin);headers.set('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');headers.set('Access-Control-Allow-Headers','Authorization,Content-Type,X-Record-Id');}
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
 try{
  const auth=request.headers.get('Authorization');if(!/^Bearer [^\s]+$/.test(auth||''))throw new HttpError(401,'请先登录');
  if(!env.SUPABASE_URL||!env.SUPABASE_PUBLISHABLE_KEY)throw new HttpError(503,'文件服务尚未配置');
  const dbHeaders={apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:auth};
  async function rest(path,options={}){
   const response=await fetch(env.SUPABASE_URL+path,{...options,headers:{...dbHeaders,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new HttpError(response.status===401?401:403,'身份或文件操作权限验证失败');
   const text=await response.text();return text?JSON.parse(text):null;
  }
  const user=await rest('/auth/v1/user');
  const profiles=await rest(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role`);
  if(profiles?.length!==1||!['pengpeng','kaikai'].includes(profiles[0].role))throw new HttpError(403,'账号未授权或会话已退出');
  const url=new URL(request.url),path=url.pathname;
  if(path==='/api/media'&&request.method==='POST'){
   const recordId=request.headers.get('X-Record-Id');if(!UUID.test(recordId||''))throw new HttpError(400,'记录编号不正确');
   let bytes=await limitedBody(request);let image;
   try{image=inspectImage(bytes,request.headers.get('Content-Type'));}catch(e){throw new HttpError(415,e.message);}
   // Keep the complete image codestream; discard opaque bytes after JPEG EOI.
   bytes=bytes.subarray(0,image.byteLength);
   const key=`daily/${recordId}/${user.id}/${crypto.randomUUID()}.${image.ext}`;
   const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
   await env.LOVE_MEDIA.put(key,bytes,{httpMetadata:{contentType:image.type},customMetadata:{owner:user.id,recordId,sha256}});
   try{await rest('/rest/v1/media_objects',{method:'POST',body:JSON.stringify({key,record_id:recordId,owner_id:user.id,content_type:image.type,size_bytes:bytes.length,sha256})});}
   catch(error){await env.LOVE_MEDIA.delete(key);throw error;}
   return json({key,sha256,size:bytes.length,content_type:image.type},201);
  }
  if(!path.startsWith('/api/media/'))throw new HttpError(404,'接口不存在');
  let key;try{key=decodeURIComponent(path.slice('/api/media/'.length));}catch{throw new HttpError(400,'文件编号不正确');}
  if(!KEY.test(key))throw new HttpError(400,'文件编号不正确');
  const rows=await rest(`/rest/v1/media_objects?key=eq.${encodeURIComponent(key)}&select=*`);
  const row=rows?.[0];if(!row)throw new HttpError(404,'文件不存在或无权访问');
  if(request.method==='GET'){
   if(row.state!=='ready')throw new HttpError(404,'文件已删除');
   const object=await env.LOVE_MEDIA.get(key);if(!object)throw new HttpError(404,'文件不存在');
   headers.set('Content-Type',row.content_type);headers.set('Content-Length',String(object.size));headers.set('Content-Disposition','inline');
   return new Response(object.body,{headers});
  }
  if(request.method==='DELETE'){
   if(row.owner_id!==user.id)throw new HttpError(403,'只能删除自己的照片');
   const canDelete=await rest('/rest/v1/rpc/begin_media_delete',{method:'POST',body:JSON.stringify({media_key:key})});
   if(!canDelete)throw new HttpError(404,'文件不存在');
   await env.LOVE_MEDIA.delete(key);
   await rest('/rest/v1/rpc/finish_media_delete',{method:'POST',body:JSON.stringify({media_key:key})});
   return new Response(null,{status:204,headers});
  }
  throw new HttpError(405,'请求方式不支持');
 }catch(error){return json({error:error instanceof HttpError?error.message:'文件服务暂时不可用，请重试'},error instanceof HttpError?error.status:503);}
}};
