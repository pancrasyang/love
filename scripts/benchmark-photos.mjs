// Local, synthetic transfer benchmark. No production services or credentials.
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {app,A} from '../tests/browser-harness.mjs';
import photo from '../api/photo.js';
import worker from '../worker/src/index.mjs';
import {setSession} from '../server/session.mjs';

const CHUNK=1048576,R='10000000-0000-4000-8000-000000000001',KEY=`daily/${R}/${A}/abc.jpg`;
const bytes=Buffer.alloc(6*CHUNK,37),sha=createHash('sha256').update(bytes).digest('hex');
const row={key:KEY,record_id:R,business_type:'daily',owner_id:A,state:'ready',sha256:sha,size_bytes:bytes.length,content_type:'image/jpeg'};
process.env.SUPABASE_URL='https://benchmark.invalid';process.env.SUPABASE_PUBLISHABLE_KEY='benchmark-public';process.env.LOVE_SESSION_SECRET='benchmark-only-secret-at-least-32-characters';
const delegated=process.argv.includes('--delegated');
process.env.PHOTO_WORKER_READS=delegated?'1':'0';
const oldFetch=globalThis.fetch,info=console.info,warn=console.warn;
const sourceOption=process.argv.find(arg=>arg.startsWith('--media-source='));
// This benchmark isolates original-image authorization, not thumbnail encoding.
const mediaSource=(sourceOption?readFileSync(sourceOption.slice('--media-source='.length),'utf8'):readFileSync('assets/media.js','utf8')).replaceAll("img.dataset.photoVariant==='thumbnail'",'false');
const recorder=()=>({headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},status(n){this.statusCode=n;return this;},json(value){this.body=value;},send(value){this.body=value;}});
const issued=recorder();setSession(issued,{access_token:'benchmark-user-token',refresh_token:'benchmark-refresh',expires_in:3600});
const cookie=issued.headers['set-cookie'].split(';')[0];
const delay=()=>new Promise(resolve=>setTimeout(resolve,5));

try{
 for(const outage of [false,true]){
  const logs=[],counts={browser:0,supabase:0,r2:0,transferred_bytes:0},stages={};let failed=false;
  console.info=console.warn=value=>logs.push(JSON.parse(value));
  const a=await app({observer:true,mediaSource,timers:(fn,ms)=>ms>0&&ms<=5000?setTimeout(fn,ms):0});
  Object.defineProperty(a.w.crypto,'subtle',{value:webcrypto.subtle});
  const env={SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY:'benchmark-public',ALLOWED_ORIGINS:'https://love.invalid',LOVE_MEDIA:{async get(key,{range}){
   counts.r2++;await delay();
   if(outage&&!failed&&range.offset===4*CHUNK){failed=true;throw Error('synthetic one-time outage');}
   const part=bytes.subarray(range.offset,range.offset+range.length);
   return {size:bytes.length,body:new Response(part).body};
  }}};
  globalThis.fetch=async(url,options)=>{
   if(String(url).startsWith('https://love-media-api.'))return worker.fetch(new Request(url,options),env);
   counts.supabase++;await delay();
   if(url.includes('/auth/v1/user'))return Response.json({id:A});
   if(url.includes('/profiles?'))return Response.json([{id:A,role:'pengpeng'}]);
   if(url.includes('/media_objects?'))return Response.json([row]);
   if(url.includes('/daily_checkins?'))return Response.json([{id:R}]);
   throw Error('Unexpected synthetic route');
  };
  a.w.fetch=async url=>{
   counts.browser++;const r=recorder();
   await photo({method:'GET',url,headers:{cookie}},r);
   if(r.statusCode===206)counts.transferred_bytes+=r.body.length;
   return new Response(r.statusCode===206?r.body:JSON.stringify(r.body),{status:r.statusCode,headers:r.headers});
  };
  try{
   a.login();a.rows.daily_checkins.push({id:R,author_id:A,photo_key:KEY,content:'synthetic record',created_at:'2026-10-13'});
   await a.run('restoreSession()');const began=performance.now();a.visible([0]);await a.idle();
   // The previous implementation needs a user retry after the injected failure.
   if(a.w.document.querySelector('.photo-retry')){a.w.document.querySelector('.photo-retry').click();await a.idle();}
   assert.equal(a.w.document.querySelector('[data-media-key]').getAttribute('src'),'blob:test');
   for(const log of logs){const service=log.stages.some(step=>step.stage==='r2_read')?'worker':'vercel';for(const step of log.stages){const key=service+'.'+step.stage;(stages[key]||={calls:0,total_ms:0}).calls++;stages[key].total_ms+=step.elapsed_ms;}}
   info(JSON.stringify({delegated,scenario:outage?'one-failure-at-part-4':'healthy',network:'local synthetic, 5ms per Supabase/R2 operation',...counts,elapsed_ms:Math.round(performance.now()-began),stages}));
  }finally{await a.close();}
 }
}finally{globalThis.fetch=oldFetch;console.info=info;console.warn=warn;}
