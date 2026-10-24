import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/photo-meta.js';
import worker from '../worker/src/index.mjs';
import {setSession} from '../server/session.mjs';

const A='00000000-0000-4000-8000-000000000001',D='10000000-0000-4000-8000-000000000001',S='10000000-0000-4000-8000-000000000002';
const DAILY=`daily/${D}/${A}/abc.jpg`,SPOT=`spot/${S}/${A}/def.png`,MISSING=`daily/${D}/${A}/ccc.jpg`,V1='a'.repeat(64),V2='b'.repeat(64);
process.env.SUPABASE_URL='https://batch.invalid';process.env.SUPABASE_PUBLISHABLE_KEY='public';process.env.LOVE_SESSION_SECRET='batch-test-session-secret-at-least-32';
function response(){return {headers:{},setHeader(key,value){this.headers[key.toLowerCase()]=value;},status(code){this.statusCode=code;return this;},json(body){this.body=body;}}}
function cookie(){const out=response();setSession(out,{access_token:'batch-user-token',refresh_token:'batch-refresh-token',expires_in:3600});return out.headers['set-cookie'].split(';')[0]}
function request(items,headers={}){const body={items};return {method:'POST',url:'/api/photo-meta',body,headers:{host:'love.invalid',origin:'https://love.invalid','x-love-request':'1','content-type':'application/json','content-length':String(Buffer.byteLength(JSON.stringify(body))),cookie:cookie(),...headers}}}
function setup({revoked=false,badDaily=false}={}){
 const rows=[{key:DAILY,record_id:D,business_type:'daily',state:'ready',size_bytes:100,content_type:'image/jpeg',sha256:badDaily?'bad':V1},{key:SPOT,record_id:S,business_type:'spot',state:'ready',size_bytes:200,content_type:'image/png',sha256:V2}];
 const counts={auth:0,profile:0,registry:0,business:0,heads:0,gets:0},derived=`derived/thumbnail-v1/${V1}/${DAILY}.webp`;
 const env={SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY:'public',ALLOWED_ORIGINS:'https://love.invalid',LOVE_MEDIA:{async head(key){counts.heads++;return key===derived?{size:25,httpMetadata:{contentType:'image/webp'},customMetadata:{sourceVersion:V1,sha256:V2}}:null;},async get(){counts.gets++;throw Error('batch metadata must not read bodies')}}};
 const fetcher=async(url,options)=>{
  if(String(url).startsWith('https://love-media-api.'))return worker.fetch(new Request(url,options),env);
  assert.equal(options.headers.Authorization,'Bearer batch-user-token');
  if(url.endsWith('/auth/v1/user')){counts.auth++;return revoked?new Response(null,{status:401}):Response.json({id:A});}
  if(url.includes('/profiles?')){counts.profile++;return Response.json([{id:A,role:'pengpeng'}]);}
  if(url.includes('/media_objects?')){counts.registry++;return Response.json(rows);}
  if(url.includes('/daily_checkins?')){counts.business++;return Response.json([{photo_key:DAILY}]);}
  if(url.includes('/spot_checkins?')){counts.business++;return Response.json([{photo_key:SPOT}]);}
  throw Error('unexpected route');
 };
 return {counts,fetcher};
}
async function call(req,harness){const oldFetch=globalThis.fetch,info=console.info,warn=console.warn,logs=[];globalThis.fetch=harness.fetcher;console.info=console.warn=value=>logs.push(String(value));try{const out=response();await handler(req,out);out.logs=logs;return out;}finally{globalThis.fetch=oldFetch;console.info=info;console.warn=warn;}}

test('batch metadata authenticates once, batches registry/business reads and only heads requested thumbnails',async()=>{
 const h=setup(),out=await call(request([{key:DAILY,variant:'thumbnail'},{key:SPOT,variant:'original'},{key:MISSING,variant:'thumbnail'}]),h);
 assert.equal(out.statusCode,200);assert.deepEqual(h.counts,{auth:1,profile:1,registry:1,business:2,heads:1,gets:0});assert.equal(out.headers['cache-control'],'private, no-store');
 assert.equal(out.body.results[0].status,'available');assert.equal(out.body.results[0].variant,'thumbnail');assert.equal(out.body.results[1].status,'available');assert.equal(out.body.results[1].version,V2);assert.equal(out.body.results[2].status,'unavailable');assert(!('version' in out.body.results[2]));
 const logs=out.logs.join('\n');assert(!logs.includes('batch-user-token'));assert(!logs.includes('batch-refresh-token'));assert(!logs.includes(DAILY));assert.match(logs,/"batch_items":3/);
});

test('one invalid or unavailable photo does not hide other valid batch results',async()=>{
 const h=setup({badDaily:true}),out=await call(request([{key:DAILY,variant:'original'},{key:SPOT,variant:'original'},{key:MISSING,variant:'original'}]),h);
 assert.equal(out.statusCode,200);assert.equal(out.body.results[0].status,'error');assert.equal(out.body.results[0].code,'MEDIA_METADATA');assert.equal(out.body.results[1].status,'available');assert.equal(out.body.results[2].status,'unavailable');assert.equal(h.counts.gets,0);
});

test('batch input is strict and whole-session failure expires the cookie',async()=>{
 let reached=false;const blocked=setup();blocked.fetcher=async()=>{reached=true;throw Error()};
 const cross=await call(request([{key:DAILY,variant:'original'}],{origin:'https://evil.invalid'}),blocked);assert.equal(cross.statusCode,403);assert.equal(reached,false);
 const duplicate=await call(request([{key:DAILY,variant:'original'},{key:DAILY,variant:'original'}]),setup());assert.equal(duplicate.statusCode,400);
 const revoked=await call(request([{key:DAILY,variant:'original'}]),setup({revoked:true}));assert.equal(revoked.statusCode,401);assert.equal(revoked.body.code,'AUTH_USER');assert.match(revoked.headers['set-cookie'],/Max-Age=0/);
});
