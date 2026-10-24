import {randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {measure,requestDiagnostics} from './diagnostics.mjs';
export const COOKIE='__Host-love-session';
const age=30*86400,flights=new Map();
export class ApiError extends Error{constructor(status,message,code){super(message);this.status=status;this.code=code;}}
export function privateResponse(res){res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');}
export function failure(res,error){const message=error instanceof ApiError?error.message:'服务暂时无法连接，请稍后重试',code=error instanceof ApiError?error.code:'UPSTREAM_NETWORK',trace=requestDiagnostics();if(trace)trace.code=code;if(typeof error.retryAfter==='string'&&error.retryAfter.length<=128&&(/^\d+$/.test(error.retryAfter)||Number.isFinite(Date.parse(error.retryAfter))))res.setHeader('Retry-After',error.retryAfter);return res.status(error instanceof ApiError?error.status:503).json({error:message,message,code,...(trace?{request_id:trace.request_id,stage:trace.stage,...(trace.upstream_stage?{upstream_stage:trace.upstream_stage}:{})}:{})});}
export function csrf(req){const expected=`https://${req.headers.host}`;if(req.headers['sec-fetch-site']==='cross-site'||req.headers['x-love-request']!=='1'||!req.headers.origin||(req.headers.origin!==expected&&req.headers.origin!==process.env.LOCAL_DEV_ORIGIN))throw new ApiError(403,'请求来源验证失败，请刷新页面','CSRF_REJECTED');}
function secret(){if(!process.env.LOVE_SESSION_SECRET||process.env.LOVE_SESSION_SECRET.length<32)throw new ApiError(503,'会话服务尚未配置','SESSION_CONFIG');return createHash('sha256').update(process.env.LOVE_SESSION_SECRET).digest();}
export function setSession(res,data){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret(),iv);cipher.setAAD(Buffer.from(COOKIE));
 const payload={access_token:data.access_token,refresh_token:data.refresh_token,expires_at:data.expires_at||Math.floor(Date.now()/1000)+(data.expires_in||3600)};
 if(typeof payload.access_token!=='string'||typeof payload.refresh_token!=='string')throw new ApiError(503,'身份服务响应异常','AUTH_RESPONSE');
 const body=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final()]);const value=Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');
 if(value.length>3800)throw new ApiError(503,'会话信息超出限制','SESSION_SIZE');
 res.setHeader('Set-Cookie',`${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`);return payload;
}
export function clearSession(res){res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);}
function readSession(req){const entry=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='));if(!entry)return null;try{const bytes=Buffer.from(entry.slice(COOKIE.length+1),'base64url');if(bytes.length<29||bytes.length>4096)throw Error();const decipher=createDecipheriv('aes-256-gcm',secret(),bytes.subarray(0,12));decipher.setAAD(Buffer.from(COOKIE));decipher.setAuthTag(bytes.subarray(12,28));const data=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());if(typeof data.access_token!=='string'||typeof data.refresh_token!=='string'||!Number.isFinite(data.expires_at))throw Error();return data;}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(401,'登录已失效，请重新登录','SESSION_INVALID');}}
export async function upstream(path,token,options={},stage='DATA'){
 const base=process.env.SUPABASE_URL,key=process.env.SUPABASE_PUBLISHABLE_KEY;if(!base||!key)throw new ApiError(503,'服务尚未配置',stage+'_CONFIG');
 return measure(stage.toLowerCase(),async()=>{try{return await fetch(base+path,{...options,headers:{apikey:key,...(token?{Authorization:'Bearer '+token}:{}),...options.headers},signal:AbortSignal.timeout(15000)});}catch{throw new ApiError(503,stage==='AUTH'?'身份验证服务连接失败，请稍后重试':'云端记录服务连接失败，请稍后重试',stage+'_NETWORK');}});
}
function authFailure(response,code,message,{refresh=false,profile=false}={}){
 if(response.status===429)throw Object.assign(new ApiError(429,'身份服务请求过于频繁，请稍后重试',code+'_RATE_LIMITED'),{retryAfter:response.headers.get('Retry-After')});
 if(response.status>=500)throw new ApiError(503,'身份服务暂时不可用，请稍后重试',code+'_UNAVAILABLE');
 if(profile&&response.status===403)throw new ApiError(403,'账号权限服务拒绝了请求，请稍后重试',code+'_DENIED');
 if(response.status===401||response.status===403||(refresh&&response.status===400))throw new ApiError(401,message,code);
 throw new ApiError(503,'身份服务响应异常，请稍后重试',code+'_RESPONSE');
}
export async function refresh(refreshToken){
 const id=createHash('sha256').update(refreshToken).digest('hex');if(flights.has(id))return flights.get(id);
 const promise=(async()=>{const r=await upstream('/auth/v1/token?grant_type=refresh_token',null,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:refreshToken})},'AUTH');if(!r.ok)authFailure(r,'AUTH_REFRESH','会话续期失败，请重新登录',{refresh:true});return r.json();})();flights.set(id,promise);try{return await promise;}finally{flights.delete(id);}
}
export async function validate(token){
 const r=await upstream('/auth/v1/user',token,{},'AUTH');if(!r.ok)authFailure(r,'AUTH_USER','身份验证失败，请重新登录');const user=await r.json();if(!user.id)throw new ApiError(503,'身份服务响应异常','AUTH_USER_RESPONSE');
 const p=await upstream(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role,display_name`,token,{},'PROFILE');if(!p.ok)authFailure(p,'PROFILE_ACCESS','账号权限验证失败，请重新登录',{profile:true});const rows=await p.json();if(!Array.isArray(rows))throw new ApiError(503,'账号权限服务响应异常','PROFILE_RESPONSE');if(rows.length!==1||!['pengpeng','kaikai'].includes(rows[0].role))throw new ApiError(401,'此账号未获授权或会话已退出','PROFILE_DENIED');return {user:{id:user.id},profile:rows[0]};
}
// Only the photo proxy may delegate validation to the authoritative Worker.
// This reads/refreshes the HttpOnly cookie; it never authorizes a data operation.
export async function photoCredentials(req,res){try{let data=readSession(req);if(!data)throw new ApiError(401,'请先登录','SESSION_REQUIRED');if(data.expires_at<Date.now()/1000+60)data=setSession(res,await refresh(data.refresh_token));return data;}catch(error){if(error instanceof ApiError&&error.status===401)clearSession(res);throw error;}}
export async function authenticate(req,res,{optional=false}={}){try{let data=readSession(req);if(!data){if(optional)return null;throw new ApiError(401,'请先登录','SESSION_REQUIRED');}if(data.expires_at<Date.now()/1000+60)data=setSession(res,await refresh(data.refresh_token));return {...data,...await validate(data.access_token)};}catch(error){if(error instanceof ApiError&&error.status===401)clearSession(res);throw error;}}
export function browserSession(data){return {access_token:data.access_token,expires_at:data.expires_at,user:data.user,profile:data.profile};}
export async function revoke(token){const r=await upstream('/auth/v1/logout?scope=local',token,{method:'POST'},'AUTH');if(!r.ok&&r.status!==401)throw new ApiError(503,'退出失败，请联网后重试','AUTH_LOGOUT');}
