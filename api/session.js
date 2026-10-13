import {privateResponse,csrf,authenticate,refresh,validate,setSession,browserSession,clearSession,revoke,ApiError,failure} from '../server/session.mjs';
export default async function handler(req,res){privateResponse(res);try{
 if(req.headers['sec-fetch-site']==='cross-site')throw new ApiError(403,'请求来源验证失败','CSRF_REJECTED');
 if(req.method==='GET'){const data=await authenticate(req,res,{optional:true});return res.status(200).json(data?browserSession(data):{user:null});}
 csrf(req);
 if(req.method==='DELETE'){let data;try{data=await authenticate(req,res,{optional:true});}catch(error){if(error.status!==401)throw error;}if(data)await revoke(data.access_token);clearSession(res);return res.status(200).json({user:null});}
 if(req.method==='POST'&&!String(req.headers['content-type']||'').startsWith('application/json'))throw new ApiError(415,'请求格式不正确','SESSION_FORMAT');
 if(req.method==='POST'&&req.body?.action==='import'&&typeof req.body.refresh_token==='string'&&req.body.refresh_token.length<2048){const data=await refresh(req.body.refresh_token),identity=await validate(data.access_token);return res.status(200).json(browserSession({...setSession(res,data),...identity}));}
 throw new ApiError(405,'请求方式不支持','SESSION_METHOD');
}catch(error){return failure(res,error);}}
