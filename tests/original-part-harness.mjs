// Synthetic browser-Cookie → API → real Worker handler → in-memory R2 fixture.
// No deployed endpoints, real credentials, or private photo bytes are used.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import photo from '../api/photo.js';
import photoMeta from '../api/photo-meta.js';
import worker from '../worker/src/index.mjs';
import {setSession} from '../server/session.mjs';

export const MiB=1048576,A='00000000-0000-4000-8000-000000000001',R='10000000-0000-4000-8000-000000000001',KEY=`daily/${R}/${A}/abc.jpg`;
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const response=()=>({headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},status(s){this.statusCode=s;return this;},json(b){this.body=b;},send(b){this.body=b;}});
export async function fixture(bytes,fn,{delegated=true,delay=0}={}){
 const names=['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','LOVE_SESSION_SECRET','PHOTO_WORKER_READS','PHOTO_ORIGINAL_PART_SIZE'],saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 const oldFetch=globalThis.fetch,info=console.info,warn=console.warn;
 Object.assign(process.env,{SUPABASE_URL:'https://parts.invalid',SUPABASE_PUBLISHABLE_KEY:'synthetic-public',LOVE_SESSION_SECRET:'synthetic-part-test-secret-at-least-32',PHOTO_WORKER_READS:delegated?'1':'0'});delete process.env.PHOTO_ORIGINAL_PART_SIZE;
 const row={key:KEY,owner_id:A,record_id:R,business_type:'daily',content_type:'image/jpeg',size_bytes:bytes.length,sha256:sha(bytes),state:'ready'},counts={auth:0,profile:0,registry:0,business:0,reads:0,bytes:0},ranges=[];
 let revoked=false,detached=false,mutate=r=>r;
 const env={SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY:'synthetic-public',ALLOWED_ORIGINS:'https://parts.invalid',LOVE_MEDIA:{async get(key,{range}={}){
  assert.equal(key,KEY);counts.reads++;ranges.push(range);if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  const body=range?bytes.subarray(range.offset,range.offset+range.length):bytes;counts.bytes+=body.length;
  return {size:bytes.length,body:new Response(body).body};
 }}};
 globalThis.fetch=async(u,o)=>{
  if(String(u).startsWith('https://love-media-api.'))return mutate(await worker.fetch(new Request(u,o),env));
  assert.equal(o.headers.Authorization,'Bearer synthetic-part-token');if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  if(u.includes('/auth/v1/user')){counts.auth++;return revoked?Response.json({},{status:401}):Response.json({id:A});}
  if(u.includes('/profiles')){counts.profile++;return Response.json([{id:A,role:'pengpeng'}]);}
  if(u.includes('/media_objects')){counts.registry++;return Response.json([row]);}
  if(u.includes('/daily_checkins')){counts.business++;return Response.json(detached?[]:[{id:R,photo_key:KEY}]);}
  throw Error('Unexpected fixture route');
 };
 console.info=console.warn=()=>{};
 const issued=response();setSession(issued,{access_token:'synthetic-part-token',refresh_token:'synthetic-part-refresh',expires_in:3600});const cookie=issued.headers['set-cookie'].split(';')[0];
 const path='/api/photo?source=r2&key='+encodeURIComponent(KEY);
 const call=async(query='',headers={cookie})=>{const r=response();await photo({method:'GET',url:path+'&'+query,headers},r);return r;};
 const batch=async()=>{const r=response();await photoMeta({method:'POST',url:'/api/photo-meta',body:{items:[{key:KEY,variant:'original'}]},headers:{host:'parts.invalid',origin:'https://parts.invalid','x-love-request':'1','content-type':'application/json',cookie}},r);return r;};
 try{return await fn({row,counts,ranges,call,batch,revoke(){revoked=true;},detach(){detached=true;},mutate(fn){mutate=fn;}});}
 finally{globalThis.fetch=oldFetch;console.info=info;console.warn=warn;for(const name of names)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}
}
