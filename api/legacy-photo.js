import {privateResponse,authenticate,upstream,ApiError,failure} from '../server/session.mjs';
const CHUNK=1024*1024,MAX=20*1024*1024;
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
export default async function handler(req,res){privateResponse(res);try{
 if(req.method!=='GET')throw new ApiError(405,'请求方式不支持','PHOTO_METHOD');
 if(req.headers['sec-fetch-site']==='cross-site')throw new ApiError(403,'请求来源验证失败','CSRF_REJECTED');
 const url=new URL(req.url,'https://local.invalid'),id=url.searchParams.get('id'),kind=url.searchParams.get('kind')||'daily',part=Number(url.searchParams.get('part')||0);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||'')||!['daily','spot'].includes(kind)||!Number.isInteger(part)||part<0||part>=20)throw new ApiError(400,'照片请求参数不正确','PHOTO_INPUT');
 const session=await authenticate(req,res),table=kind==='daily'?'daily_checkins':'spot_checkins';
 const record=await upstream(`/rest/v1/${table}?id=eq.${id}&select=photo_url,photo_path&limit=1`,session.access_token);
 if(!record.ok)throw new ApiError(503,'历史记录暂时无法读取','PHOTO_RECORD');const rows=await record.json();if(rows.length!==1)throw new ApiError(404,'历史照片不存在','PHOTO_RECORD');
 const start=part*CHUNK,end=start+CHUNK-1;
 const response=await upstream('/storage/v1/object/authenticated/love-photos/'+sourcePath(rows[0]),session.access_token,{headers:{Range:`bytes=${start}-${end}`}},'PHOTO');
 if(!response.ok)throw new ApiError(response.status===404?404:503,'历史照片暂时无法读取','PHOTO_STORAGE');
 const mime=(response.headers.get('content-type')||'').split(';')[0];if(!['image/jpeg','image/png','image/webp'].includes(mime))throw new ApiError(415,'历史照片格式不支持','PHOTO_FORMAT');
 const range=response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/),total=response.status===206?Number(range?.[3]):Number(response.headers.get('content-length'));
 if(!Number.isInteger(total)||total<=0||total>MAX||start>=total||(response.status===206&&(!range||Number(range[1])!==start||Number(range[2])!==Math.min(end,total-1))))throw new ApiError(503,'历史照片分段读取失败','PHOTO_RANGE');
 // Some Storage versions ignore Range. Clip the stream without returning a large Vercel response.
 const reader=response.body.getReader(),chunks=[];let position=response.status===206?start:0,size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;const a=Math.max(0,start-position),b=Math.min(value.length,end+1-position);if(b>a){chunks.push(Buffer.from(value.subarray(a,b)));size+=b-a;}position+=value.length;if(position>end)break;}}finally{await reader.cancel();}
 if(size!==Math.min(CHUNK,total-start))throw new ApiError(503,'历史照片传输不完整，请重试','PHOTO_TRUNCATED');
 res.setHeader('Content-Type',mime);res.setHeader('Content-Range',`bytes ${start}-${start+size-1}/${total}`);return res.status(206).send(Buffer.concat(chunks));
}catch(error){return failure(res,error);}}
