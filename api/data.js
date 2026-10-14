import {withDiagnostics} from '../server/diagnostics.mjs';
import {privateResponse,csrf,authenticate,upstream,ApiError,failure} from '../server/session.mjs';
const methods={profiles:['GET','HEAD'],daily_checkins:['GET','HEAD','POST','PATCH','DELETE'],mood_records:['GET','HEAD','POST','PATCH','DELETE'],media_objects:['GET','HEAD'],spot_checkins:['GET','HEAD']};
export default function handler(req,res){return withDiagnostics(res,async()=>{privateResponse(res);try{
 if(req.headers['sec-fetch-site']==='cross-site')throw new ApiError(403,'请求来源验证失败','CSRF_REJECTED');
 const url=new URL(req.url,'https://local.invalid'),resource=url.searchParams.get('resource');if(url.searchParams.getAll('resource').length!==1||!methods[resource]?.includes(req.method))throw new ApiError(405,'此数据操作不支持','DATA_ROUTE');
 if(!['GET','HEAD'].includes(req.method)){csrf(req);if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new ApiError(415,'数据请求格式不正确','DATA_FORMAT');}
 const session=await authenticate(req,res);url.searchParams.delete('resource');const headers={};for(const name of ['accept','content-type','prefer','range','range-unit'])if(req.headers[name])headers[name]=req.headers[name];
 const body=['POST','PATCH'].includes(req.method)?JSON.stringify(req.body):undefined;if(body&&Buffer.byteLength(body)>65536)throw new ApiError(413,'记录内容过大','DATA_SIZE');
 const response=await upstream(`/rest/v1/${resource}?${url.searchParams}`,session.access_token,{method:req.method,headers,...(body?{body}:{})});for(const name of ['content-type','content-range','preference-applied'])if(response.headers.get(name))res.setHeader(name,response.headers.get(name));
 if(req.method==='HEAD')return res.status(response.status).end();return res.status(response.status).send(await response.text());
}catch(error){return failure(res,error);}});}
