import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import handler from '../api/photo.js';import worker from '../worker/src/index.mjs';import {setSession} from '../server/session.mjs';
const A='00000000-0000-4000-8000-000000000001',R='10000000-0000-4000-8000-000000000001',KEY=`daily/${R}/${A}/abc.jpg`;
process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_PUBLISHABLE_KEY='public-test';process.env.LOVE_SESSION_SECRET='test-only-session-secret-at-least-32-characters';
function res(){return {headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v},status(s){this.statusCode=s;return this},json(b){this.body=b},send(b){this.body=b}}}
function cookie(){const r=res();setSession(r,{access_token:'synthetic-user-token',refresh_token:'synthetic-private-refresh',expires_in:3600});return r.headers['set-cookie'].split(';')[0]}
async function call(path,fetcher,headers={cookie:cookie()}){const old=globalThis.fetch,warn=console.warn,info=console.info,logs=[];globalThis.fetch=fetcher;console.warn=console.info=s=>logs.push(s);try{const r=res();await handler({method:'GET',url:path,headers},r);for(const log of logs){assert(!log.includes('synthetic-user-token'));assert(!log.includes('synthetic-private-refresh'));assert(!log.includes(KEY));}r.logs=logs.map(log=>JSON.parse(log));return r}finally{globalThis.fetch=old;console.warn=warn;console.info=info}}
function auth(url,opt){assert.equal(opt.headers.Authorization,'Bearer synthetic-user-token');assert.equal(opt.headers.apikey,'public-test');if(url.includes('/auth/v1/user'))return Response.json({id:A});if(url.includes('/profiles'))return Response.json([{id:A,role:'pengpeng'}]);return null}
test('browser-cookie → same-origin API → authenticated Worker → R2: metadata and bounded chunks for a 6MiB image',async()=>{
 const bytes=Buffer.alloc(6*1048576+13,37),sha=createHash('sha256').update(bytes).digest('hex'),row={key:KEY,record_id:R,business_type:'daily',owner_id:A,state:'ready',sha256:sha,size_bytes:bytes.length,content_type:'image/jpeg'};
 let gets=0;const env={SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY:'public-test',ALLOWED_ORIGINS:'https://love.invalid',LOVE_MEDIA:{async get(key,options){assert.equal(key,KEY);gets++;const range=options?.range;return {size:bytes.length,body:new Response(range?bytes.subarray(range.offset,range.offset+range.length):bytes).body}}}};
 const router=async(url,opt)=>{if(String(url).startsWith('https://love-media-api.'))return worker.fetch(new Request(url,opt),env);const r=auth(url,opt);if(r)return r;if(url.includes('/media_objects'))return Response.json([row]);if(url.includes('/daily_checkins'))return Response.json([{id:R}]);throw Error('Unexpected request')};
 const path='/api/photo?source=r2&key='+encodeURIComponent(KEY),meta=await call(path+'&meta=1',router);assert.equal(meta.statusCode,200);assert.equal(meta.body.sha256,sha);assert.equal(gets,0);
 const chunks=[];for(let part=0;part<7;part++){const r=await call(path+'&part='+part,router,{cookie:cookie(),authorization:'Bearer impersonator'});assert.equal(r.statusCode,206);assert(r.body.length<=1048576);assert.equal(r.headers['x-media-version'],sha);assert.equal(r.headers['cache-control'],'private, no-store');chunks.push(r.body)}assert(Buffer.concat(chunks).equals(bytes));assert.equal(gets,7);
});
test('anonymous, revoked profile, unregistered key and detached files do not reach R2',async()=>{let reached=false;const empty=async()=>{reached=true;throw Error()};assert.equal((await call('/api/photo?source=r2&key='+KEY,empty,{})).statusCode,401);assert.equal(reached,false);const denied=await call('/api/photo?source=r2&key='+KEY,async(url,opt)=>url.includes('/auth/v1/user')?auth(url,opt):Response.json([]));assert.equal(denied.statusCode,401);const missing=await call('/api/photo?source=r2&key='+KEY,async(url,opt)=>auth(url,opt)||Response.json([]));assert.equal(missing.statusCode,404)});
test('legacy metadata is stable across ranges and respects source ETag changes',async()=>{let etag='old';const bytes=Buffer.alloc(1048583,5);const router=async(url,opt)=>{const a=auth(url,opt);if(a)return a;if(url.includes('/daily_checkins'))return Response.json([{photo_path:'old.jpg'}]);const m=opt.headers.Range.match(/bytes=(\d+)-(\d+)/),start=Number(m[1]),end=Math.min(Number(m[2]),bytes.length-1);return new Response(bytes.subarray(start,end+1),{status:206,headers:{'Content-Type':'image/jpeg','Content-Range':`bytes ${start}-${end}/${bytes.length}`,ETag:etag}})};
 const path='/api/photo?source=legacy&id='+R;const m=await call(path+'&meta=1',router),p=await call(path+'&part=1',router);assert.equal(m.statusCode,200);assert.equal(p.headers['x-media-version'],m.body.version);assert.equal(p.body.length,7);etag='new';assert.notEqual((await call(path+'&meta=1',router)).body.version,m.body.version);
});
test('legacy failures distinguish missing, unavailable, invalid range, oversize and stream timeout safely',async()=>{
 const cases=[[()=>new Response(null,{status:404}),404,'MEDIA_NOT_FOUND'],[()=>new Response(null,{status:503}),503,'MEDIA_SOURCE_UNAVAILABLE'],[()=>new Response(null,{status:416}),416,'MEDIA_RANGE_INVALID'],[()=>new Response('x',{headers:{'Content-Type':'image/jpeg','Content-Length':String(21*1048576)}}),413,'MEDIA_SIZE_LIMIT'],[()=>new Response(new ReadableStream({start(c){c.error(Error('private stream error'))}}),{status:206,headers:{'Content-Type':'image/jpeg','Content-Range':'bytes 0-0/1'}}),503,'MEDIA_SOURCE_TIMEOUT']];
 for(const [source,status,code] of cases){const r=await call('/api/photo?source=legacy&id='+R,async(url,opt)=>auth(url,opt)||(url.includes('/daily_checkins')?Response.json([{photo_path:'old.jpg'}]):source()));assert.equal(r.statusCode,status);assert.equal(r.body.code,code);assert(!JSON.stringify(r.body).includes('private stream error'))}
});

test('source errors retain sessions and identify the failing stage without logging private data',async()=>{
 for(const status of [401,403,429,503]){
  const r=await call('/api/photo?source=legacy&id='+R,async(url,opt)=>auth(url,opt)||(url.includes('/daily_checkins')?Response.json([{photo_path:'private-old-photo.jpg'}]):new Response(null,{status})));
  assert.equal(r.statusCode,status);assert.equal(r.headers['set-cookie'],undefined);
  assert.equal(r.body.stage,'legacy_storage');assert.equal(r.body.request_id,r.headers['x-photo-request-id']);
  const log=r.logs.at(-1);assert.equal(log.request_id,r.body.request_id);assert.equal(log.stage,'legacy_storage');assert.equal(log.stages.at(-1).status,status);
  assert(log.stages.every(step=>Number.isFinite(step.elapsed_ms)&&step.elapsed_ms>=0));
  assert(!JSON.stringify(r.logs).includes('private-old-photo.jpg'));assert(!JSON.stringify(r.logs).includes('supabase.co'));
 }
});

test('Worker and Vercel share a request id and retain the upstream failure stage',async()=>{
 const row={key:KEY,record_id:R,business_type:'daily',owner_id:A,state:'ready',sha256:'a'.repeat(64),size_bytes:1,content_type:'image/jpeg'};
 const env={SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY:'public-test',ALLOWED_ORIGINS:'https://love.invalid',LOVE_MEDIA:{async get(){throw Error('private R2 details')}}};
 const r=await call('/api/photo?source=r2&key='+encodeURIComponent(KEY),async(url,opt)=>{
  if(String(url).startsWith('https://love-media-api.'))return worker.fetch(new Request(url,opt),env);
  return auth(url,opt)||(url.includes('/media_objects')?Response.json([row]):Response.json([{id:R}]));
 });
 assert.equal(r.statusCode,503);assert.equal(r.body.stage,'worker');assert.equal(r.body.upstream_stage,'r2_read');assert.equal(r.headers['set-cookie'],undefined);
 assert.equal(r.logs.length,2);assert(r.logs.every(log=>log.request_id===r.body.request_id));assert.equal(r.logs[0].stage,'r2_read');assert.equal(r.logs[1].upstream_stage,'r2_read');assert(!JSON.stringify(r.logs).includes('private R2 details'));
});

test('expected photo versions are checked after authorization and before R2 bytes are requested',async()=>{
 const version='a'.repeat(64),row={key:KEY,record_id:R,business_type:'daily',state:'ready',sha256:version,size_bytes:1,content_type:'image/jpeg'};let reached=false;
 const router=async(url,opt)=>{
  if(String(url).startsWith('https://love-media-api.')){reached=true;return new Response(new Uint8Array([7]),{status:206,headers:{'Content-Type':'image/jpeg','Content-Range':'bytes 0-0/1','X-Media-Version':version}});}
  return auth(url,opt)||(url.includes('/media_objects')?Response.json([row]):Response.json([{id:R}]));
 };
 const path='/api/photo?source=r2&key='+encodeURIComponent(KEY);
 const stale=await call(path+'&version='+'b'.repeat(64),router);assert.equal(stale.statusCode,412);assert.equal(stale.body.code,'MEDIA_VERSION_CHANGED');assert.equal(reached,false);
 const anon=await call(path+'&version='+version,router,{});assert.equal(anon.statusCode,401);assert.equal(reached,false);
 const fresh=await call(path+'&version='+version,router);assert.equal(fresh.statusCode,206);assert.equal(reached,true);
 assert.equal((await call(path+'&version=invalid',router)).statusCode,400);assert.equal((await call(path+'&version='+version+'&version='+version,router)).statusCode,400);
});

test('changed legacy versions cancel the source body and rate limits preserve Retry-After',async()=>{
 let cancelled=false;
 const router=async(url,opt)=>auth(url,opt)||(url.includes('/daily_checkins')?Response.json([{photo_path:'old.jpg'}]):new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:206,headers:{'Content-Type':'image/jpeg','Content-Range':'bytes 0-0/1',ETag:'new'}}));
 const r=await call('/api/photo?source=legacy&id='+R+'&version='+'b'.repeat(64),router);assert.equal(r.statusCode,412);assert.equal(r.body.code,'MEDIA_VERSION_CHANGED');assert.equal(cancelled,true);
 for(const target of ['auth','storage']){
  const limited=await call('/api/photo?source=legacy&id='+R,async(url,opt)=>{
   if(target==='auth'&&url.includes('/auth/v1/user')||target==='storage'&&url.includes('/storage/'))return new Response(null,{status:429,headers:{'Retry-After':'60'}});
   return auth(url,opt)||Response.json([{photo_path:'old.jpg'}]);
  });assert.equal(limited.statusCode,429);assert.equal(limited.headers['retry-after'],'60');assert.equal(limited.headers['set-cookie'],undefined);
 }
});

test('legacy resumption requires a strong ETag, rather than a size or modification-time fingerprint',async()=>{
 for(const [headers,resumable] of [[{ETag:'"content-v1"'},true],[{ETag:'W/"content-v1"'},false],[{'Last-Modified':'Wed, 14 Oct 2026 00:00:00 GMT'},false],[{},false]]){
  const r=await call('/api/photo?source=legacy&id='+R+'&meta=1',async(url,opt)=>auth(url,opt)||(url.includes('/daily_checkins')?Response.json([{photo_path:'old.jpg'}]):new Response(new Uint8Array([7]),{status:206,headers:{'Content-Type':'image/jpeg','Content-Range':'bytes 0-0/1',...headers}})));
  assert.equal(r.statusCode,200);assert.equal(r.body.resumable,resumable);
 }
});
