import {randomUUID} from 'node:crypto';
import {privateResponse,csrf,authenticate,upstream,ApiError,failure} from '../server/session.mjs';
import {requirePreviewWriteTarget} from '../server/storage-target.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Prepare a JWT-authenticated direct upload, avoiding Vercel's body size limit.
export default async function handler(req,res){
 privateResponse(res);
 try{
  if(req.method!=='POST')throw new ApiError(405,'请求方式不支持','MEDIA_METHOD');csrf(req);requirePreviewWriteTarget();
  const session=await authenticate(req,res),{id,type,size}=req.body||{};
  if(!UUID.test(id||'')||!Number.isInteger(size)||size<1||size>10485760)throw new ApiError(400,'照片参数不正确','MEDIA_INPUT');
  const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[type];if(!ext)throw new ApiError(415,'照片格式不支持','MEDIA_FORMAT');
  const bucket=await upstream('/storage/v1/bucket/love-photos',session.access_token,{},'STORAGE_CONFIG');
  if(!bucket.ok||(await bucket.json()).public!==false)throw new ApiError(503,'私人照片存储尚未启用','MEDIA_STORAGE_CONFIG');
  const path=`private/${session.user.id}/${id}/${randomUUID()}.${ext}`;
  return res.status(200).json({path,upload_url:process.env.SUPABASE_URL+'/storage/v1/object/love-photos/'+path,upload_key:process.env.SUPABASE_PUBLISHABLE_KEY});
 }catch(error){return failure(res,error);}
}
