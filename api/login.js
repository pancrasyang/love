// Vercel server function. Email mappings exist ONLY in server environment variables.
export default async function handler(req,res) {
 res.setHeader('Cache-Control','no-store');
 const reply=(status,body)=>res.status(status).json(body);
 if(req.method!=='POST')return reply(405,{error:'请求方式不支持'});
 const origin=req.headers.origin;
 if(origin && origin!==`https://${req.headers.host}` && origin!==process.env.LOCAL_DEV_ORIGIN)return reply(403,{error:'来源不允许'});
 if(!String(req.headers['content-type']||'').startsWith('application/json'))return reply(415,{error:'请求格式不正确'});
 const {role,password}=req.body||{};
 if(!['pengpeng','kaikai'].includes(role)||typeof password!=='string'||password.length<1||password.length>1024)return reply(400,{error:'请选择身份并输入密码'});
 const email=process.env[role==='pengpeng'?'PENGPENG_EMAIL':'KAIKAI_EMAIL'];
 const url=process.env.SUPABASE_URL, key=process.env.SUPABASE_PUBLISHABLE_KEY;
 if(!email||!url||!key)return reply(503,{error:'登录尚未配置，请联系网站管理员'});
 try {
  const result=await fetch(`${url}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify({email,password}),signal:AbortSignal.timeout(15000)});
  if(!result.ok)return reply(result.status===429?429:401,{error:result.status===429?'尝试过于频繁，请稍后再试':'身份或密码不正确'});
  const data=await result.json();
  const headers={apikey:key,Authorization:`Bearer ${data.access_token}`};
  const profile=await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(data.user.id)}&select=role`,{headers,signal:AbortSignal.timeout(10000)});
  const rows=profile.ok?await profile.json():[];
  if(rows.length!==1||rows[0].role!==role){
   await fetch(`${url}/auth/v1/logout?scope=local`,{method:'POST',headers,signal:AbortSignal.timeout(10000)});
   return reply(403,{error:'此账号未获授权'});
  }
  return reply(200,{access_token:data.access_token,refresh_token:data.refresh_token});
 } catch {return reply(503,{error:'暂时无法登录，请稍后再试'});}
}
