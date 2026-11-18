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
  async put(k,b,m){if(m.onlyIf?.get('If-None-Match')==='*'&&objects.has(k))return null;counts.writes++;if(writeFailure){writeFailure=false;throw Error('temporary R2 failure');}objects.set(k,{bytes:Buffer.from(b),...m});return {key:k};},async delete(){throw Error('Original deletion is forbidden in these tests');}
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

test('simultaneous Worker thumbnail writes are atomic and never overwrite the winning version',async()=>{
 const original=await sharp({create:{width:20,height:20,channels:3,background:'#234567'}}).jpeg().toBuffer(),thumb=await makeThumbnail(original),h=harness(original);
 let arrivals=0,release;const barrier=new Promise(resolve=>release=resolve),head=h.env.LOVE_MEDIA.head;
 h.env.LOVE_MEDIA.head=async key=>{if(++arrivals<=2){if(arrivals===2)release();await barrier;return null;}return head(key);};
 await withHarness(h,async()=>{
  const stamp=String(Date.now()),proof=createHmac('sha256',h.env.LOVE_PHOTO_PROXY_SECRET).update(JSON.stringify([KEY,h.row.sha256,sha(thumb),thumb.length,stamp])).digest('hex');
  const send=()=>worker.fetch(new Request('https://worker.invalid/api/media/'+encodeURIComponent(KEY)+'?photo=1&variant=thumbnail&version='+h.row.sha256,{method:'POST',body:thumb,headers:{Authorization:'Bearer synthetic-user-token','Content-Type':'image/webp','X-Photo-Timestamp':stamp,'X-Photo-Proof':proof}}),h.env);
  const responses=await Promise.all([send(),send()]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);assert.equal(h.counts.writes,1);const metas=await Promise.all(responses.map(r=>r.json()));assert.equal(metas[0].version,metas[1].version);assert.deepEqual(h.objects.get(KEY).bytes,original);
 });
});


