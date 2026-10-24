import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import sharp from 'sharp';
import photo from '../api/photo.js';
import photoThumbnail from '../api/photo-thumbnail.js';
import worker from '../worker/src/index.mjs';
import {setSession} from '../server/session.mjs';
import {makeThumbnail} from '../server/photo-worker.mjs';

const A='00000000-0000-4000-8000-000000000001',R='10000000-0000-4000-8000-000000000001',KEY=`daily/${R}/${A}/abc.jpg`;
const sha=b=>createHash('sha256').update(b).digest('hex');
process.env.SUPABASE_URL='https://optimization.invalid';process.env.SUPABASE_PUBLISHABLE_KEY='public';process.env.LOVE_SESSION_SECRET='synthetic-test-session-secret-at-least-32';
const res=()=>({headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},status(s){this.statusCode=s;return this;},json(b){this.body=b;},send(b){this.body=b;}});
function cookie(){const r=res();setSession(r,{access_token:'synthetic-user-token',refresh_token:'synthetic-refresh',expires_in:3600});return r.headers['set-cookie'].split(';')[0];}
function harness(bytes){
 const row={key:KEY,owner_id:A,record_id:R,business_type:'daily',content_type:'image/jpeg',size_bytes:bytes.length,sha256:sha(bytes),state:'ready'},objects=new Map([[KEY,{bytes,httpMetadata:{contentType:'image/jpeg'},customMetadata:{}}]]);
 const counts={supabase:0,reads:0,writes:0};let revoked=false,attached=true,writeFailure=false;
 const env={SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY:'public',ALLOWED_ORIGINS:'https://love.invalid',LOVE_PHOTO_PROXY_SECRET:'synthetic-thumbnail-secret-at-least-32',LOVE_MEDIA:{
  async head(k){const o=objects.get(k);return o&&{size:o.bytes.length,httpMetadata:o.httpMetadata,customMetadata:o.customMetadata};},
  async get(k,{range}={}){counts.reads++;const o=objects.get(k);return o&&{size:o.bytes.length,httpMetadata:o.httpMetadata,customMetadata:o.customMetadata,body:new Response(range?o.bytes.subarray(range.offset,range.offset+range.length):o.bytes).body};},
  async put(k,b,m){counts.writes++;if(writeFailure){writeFailure=false;throw Error('temporary R2 failure');}objects.set(k,{bytes:Buffer.from(b),...m});},async delete(){throw Error('Original deletion is forbidden in these tests');}
 }};
 const fetcher=async(u,o)=>{
  if(String(u).startsWith('https://love-media-api.'))return worker.fetch(new Request(u,o),env);
  counts.supabase++;assert.equal(o.headers.Authorization,'Bearer synthetic-user-token');
  if(u.endsWith('/auth/v1/user'))return revoked?new Response(null,{status:401}):Response.json({id:A});
  if(u.includes('/profiles?'))return Response.json([{id:A,role:'pengpeng'}]);
  if(u.includes('/media_objects?'))return Response.json([row]);
  if(u.includes('/daily_checkins?'))return Response.json(attached?[{id:R}]:[]);
  throw Error('Unexpected route');
 };
 return {counts,env,objects,row,fetcher,revoke(){revoked=true;},detach(){attached=false;},failNextWrite(){writeFailure=true;}};
}
async function withHarness(h,fn){const oldFetch=globalThis.fetch,oldFlag=process.env.PHOTO_WORKER_READS,oldSecret=process.env.LOVE_PHOTO_PROXY_SECRET,info=console.info,warn=console.warn;
 globalThis.fetch=h.fetcher;process.env.PHOTO_WORKER_READS='1';process.env.LOVE_PHOTO_PROXY_SECRET=h.env.LOVE_PHOTO_PROXY_SECRET;console.info=console.warn=()=>{};
 try{await fn();}finally{globalThis.fetch=oldFetch;console.info=info;console.warn=warn;if(oldFlag===undefined)delete process.env.PHOTO_WORKER_READS;else process.env.PHOTO_WORKER_READS=oldFlag;if(oldSecret===undefined)delete process.env.LOVE_PHOTO_PROXY_SECRET;else process.env.LOVE_PHOTO_PROXY_SECRET=oldSecret;}
}
async function call(query,headers={cookie:cookie()}){const r=res();await photo({method:'GET',url:'/api/photo?source=r2&key='+encodeURIComponent(KEY)+'&'+query,headers},r);return r;}
async function thumbnailCall(key=KEY,headers={}){const body={key},r=res();await photoThumbnail({method:'POST',url:'/api/photo-thumbnail',body,headers:{host:'love.invalid',origin:'https://love.invalid','x-love-request':'1','content-type':'application/json','content-length':String(Buffer.byteLength(JSON.stringify(body))),cookie:cookie(),...headers}},r);return r;}

test('delegated photo reads make four fresh authorization queries per segment, retain integrity and refuse a revoked session',async()=>{
 const bytes=Buffer.alloc(2*1048576+13,37),h=harness(bytes);
 await withHarness(h,async()=>{
  const meta=await call('meta=1');assert.equal(meta.statusCode,200);assert.equal(h.counts.supabase,4);assert.equal(h.counts.reads,0);
  const parts=[];for(let n=0;n<3;n++){const before=h.counts.supabase,r=await call('part='+n+'&version='+h.row.sha256);assert.equal(r.statusCode,206);assert.equal(h.counts.supabase-before,4);parts.push(r.body);}
  assert.deepEqual(Buffer.concat(parts),bytes);h.revoke();const reads=h.counts.reads,r=await call('part=0&version='+h.row.sha256);assert.equal(r.statusCode,401);assert.equal(r.body.code,'AUTH_USER');assert.match(r.headers['set-cookie'],/Max-Age=0/);assert.equal(h.counts.reads,reads);
 });
});
test('delegation refuses detached records, wrong versions and old Workers before serving bytes',async()=>{
 const h=harness(Buffer.alloc(7));await withHarness(h,async()=>{
  const changed=await call('part=0&version='+'a'.repeat(64));assert.equal(changed.statusCode,412);assert.equal(h.counts.reads,0);
  h.detach();assert.equal((await call('meta=1')).statusCode,404);assert.equal(h.counts.reads,0);
  globalThis.fetch=async()=>Response.json({size:7,type:'image/jpeg',version:h.row.sha256,sha256:h.row.sha256});
  assert.equal((await call('meta=1')).body.code,'MEDIA_WORKER_PROTOCOL');
  let fetched=false;globalThis.fetch=async()=>{fetched=true;throw Error();};assert.equal((await call('meta=1',{})).statusCode,401);assert.equal(fetched,false);
 });
});
test('a private thumbnail is generated once, stored separately, versioned and verified while original stays byte-identical',async()=>{
 const bytes=await sharp({create:{width:2400,height:1600,channels:3,background:'#923557'}}).jpeg({quality:95}).toBuffer(),h=harness(bytes);
 await withHarness(h,async()=>{
  const meta=await call('variant=thumbnail&meta=1');assert.equal(meta.statusCode,200);assert.equal(meta.body.variant,'thumbnail');assert.equal(meta.body.source_version,h.row.sha256);assert.equal(h.counts.writes,1);assert.equal(h.objects.size,2);assert.deepEqual(h.objects.get(KEY).bytes,bytes);
  const r=await call('variant=thumbnail&part=0&version='+meta.body.version);assert.equal(r.statusCode,206);assert.equal(r.body.length,meta.body.size);assert.equal(sha(r.body),meta.body.sha256);
  const image=await sharp(r.body).metadata();assert.equal(image.format,'webp');assert(image.width<=960&&image.height<=960);assert(r.body.length<bytes.length);
  assert.equal((await call('variant=thumbnail&meta=1')).body.version,meta.body.version);assert.equal(h.counts.writes,1);
  h.row.sha256='c'.repeat(64);const next=await call('variant=thumbnail&meta=1');assert.equal(next.statusCode,503);assert.equal(h.counts.writes,1); // different original cannot reuse old derivative
 });
});
test('thumbnail writes reject unsigned clients and proof replay against another version',async()=>{
 const bytes=await sharp({create:{width:10,height:10,channels:3,background:'#923557'}}).jpeg().toBuffer(),h=harness(bytes),thumb=await makeThumbnail(bytes);
 await withHarness(h,async()=>{
  const base='https://love-media-api.pancrasyang.workers.dev/api/media/'+encodeURIComponent(KEY)+'?photo=1&variant=thumbnail&version='+h.row.sha256;
  const headers={Authorization:'Bearer synthetic-user-token','Content-Type':'image/webp'};
  const r=await worker.fetch(new Request(base,{method:'POST',body:thumb,headers}),h.env);assert.equal(r.status,403);assert.equal(h.counts.writes,0);
  const stamp=String(Date.now()),proof=createHmac('sha256',h.env.LOVE_PHOTO_PROXY_SECRET).update(JSON.stringify([KEY,h.row.sha256,sha(thumb),thumb.length,stamp])).digest('hex');
  const altered=Buffer.concat([thumb,Buffer.from('tamper')]);
  assert.equal((await worker.fetch(new Request(base,{method:'POST',body:altered,headers:{...headers,'X-Photo-Timestamp':stamp,'X-Photo-Proof':proof}}),h.env)).status,403);assert.equal(h.counts.writes,0);
 });
});
test('missing thumbnail configuration falls back to explicit original metadata without weakening authorization',async()=>{
 const h=harness(Buffer.alloc(7));await withHarness(h,async()=>{delete process.env.LOVE_PHOTO_PROXY_SECRET;const meta=await call('variant=thumbnail&meta=1');assert.equal(meta.statusCode,200);assert.equal(meta.body.variant,'original');assert.equal(h.counts.writes,0);assert.equal(h.counts.reads,0);assert.equal(h.counts.supabase,4);});
});
test('post-association thumbnail generation is idempotent, coalesces concurrent work and preserves the original',async()=>{
 const bytes=await sharp({create:{width:1200,height:800,channels:3,background:'#345678'}}).jpeg({quality:90}).toBuffer(),h=harness(bytes);
 await withHarness(h,async()=>{
  const [first,second]=await Promise.all([thumbnailCall(),thumbnailCall()]);assert.deepEqual([first.statusCode,second.statusCode],[201,201]);assert.equal(h.counts.writes,1);assert.deepEqual(h.objects.get(KEY).bytes,bytes);
  const compact=await call('variant=thumbnail&part=0&compact=1');assert.equal(compact.statusCode,206);assert.equal(compact.headers['x-media-variant'],'thumbnail');assert.match(compact.headers['x-media-sha256'],/^[a-f0-9]{64}$/);assert.equal(compact.headers['x-media-source-version'],h.row.sha256);assert.equal(sha(compact.body),compact.headers['x-media-sha256']);
  const writes=h.counts.writes,reads=h.counts.reads,again=await thumbnailCall();assert.equal(again.statusCode,200);assert.equal(again.body.generated,false);assert.equal(h.counts.writes,writes);assert.equal(h.counts.reads,reads);
 });
});
test('thumbnail generation failure is retryable and never damages an attached original',async()=>{
 const bytes=await sharp({create:{width:1000,height:700,channels:3,background:'#765432'}}).jpeg().toBuffer(),h=harness(bytes);
 await withHarness(h,async()=>{
  h.failNextWrite();const failed=await thumbnailCall();assert.equal(failed.statusCode,503);assert.equal(failed.body.code,'MEDIA_SOURCE_UNAVAILABLE');assert.deepEqual(h.objects.get(KEY).bytes,bytes);
  const retried=await thumbnailCall();assert.equal(retried.statusCode,201);assert.equal(retried.body.status,'ready');assert.equal(h.counts.writes,2);assert.deepEqual(h.objects.get(KEY).bytes,bytes);
  h.detach();const detached=await thumbnailCall();assert.equal(detached.statusCode,404);assert.deepEqual(h.objects.get(KEY).bytes,bytes);
 });
});
