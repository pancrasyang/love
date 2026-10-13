import {privateResponse,csrf,upstream,validate,setSession,browserSession,revoke,ApiError,failure} from '../server/session.mjs';
export default async function handler(req,res){privateResponse(res);try{
 if(req.method!=='POST')throw new ApiError(405,'请求方式不支持','LOGIN_METHOD');csrf(req);
 if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new ApiError(415,'请求格式不正确','LOGIN_FORMAT');
 const {role,password}=req.body||{};
 if(!['pengpeng','kaikai'].includes(role)||typeof password!=='string'||!password.length||password.length>1024)throw new ApiError(400,'请选择身份并输入密码','LOGIN_INPUT');
 const email=process.env[role==='pengpeng'?'PENGPENG_EMAIL':'KAIKAI_EMAIL'];if(!email)throw new ApiError(503,'登录尚未配置','LOGIN_CONFIG');
 const r=await upstream('/auth/v1/token?grant_type=password',null,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})},'AUTH');
 if(!r.ok)throw new ApiError(r.status>=500?503:r.status===429?429:401,r.status===429?'尝试过于频繁，请稍后再试':r.status>=500?'身份服务暂时不可用':'身份或密码不正确','LOGIN_AUTH');
 const data=await r.json();let identity;
 try{identity=await validate(data.access_token);if(identity.profile.role!==role)throw new ApiError(403,'此账号未获授权','LOGIN_ROLE');}catch(error){try{await revoke(data.access_token);}catch{}throw error;}
 return res.status(200).json(browserSession({...setSession(res,data),...identity}));
}catch(error){return failure(res,error);}}
