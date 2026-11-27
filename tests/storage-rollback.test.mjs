import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import photo from '../api/photo.js';
import upload from '../api/storage-upload.js';
import retiredMeta from '../api/photo-meta.js';
import retiredThumbnail from '../api/photo-thumbnail.js';
import {setSession} from '../server/session.mjs';
import {database,asUser,A,B,C} from './db-harness.mjs';
const R='10000000-0000-4000-8000-000000000001';
process.env.SUPABASE_URL='https://storage-test.invalid';process.env.SUPABASE_PUBLISHABLE_KEY='test-public';process.env.LOVE_SESSION_SECRET='test-only-session-secret-with-at-least-32-chars';
const result=()=>({headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},removeHeader(k){delete this.headers[k.toLowerCase()];},status(s){this.statusCode=s;return this;},json(body){this.body=body;},send(body){this.body=body;}});
function cookie(){const r=result();setSession(r,{access_token:'synthetic-token',refresh_token:'synthetic-refresh',expires_in:3600});return r.headers['set-cookie'].split(';')[0];}
async function call(handler,{url='/api/photo?source=legacy&id='+R,method='GET',body,loggedIn=true}={},fetcher){const old=globalThis.fetch;globalThis.fetch=async(url,options)=>{assert(!String(url).includes('workers.dev'));return fetcher(url,options);};try{const r=result();await handler({url,method,body,headers:{host:'love.invalid',origin:'https://love.invalid','x-love-request':'1','content-type':'application/json',...(loggedIn?{cookie:cookie()}:{})}},r);return r;}finally{globalThis.fetch=old;}}
function auth(url,{headers},denied=false){assert.equal(headers.Authorization,'Bearer synthetic-token');if(url.endsWith('/auth/v1/user'))return Response.json({id:A});if(url.includes('/profiles?'))return Response.json(denied?[]:[{id:A,role:'pengpeng'}]);}


test('R2-only references are unavailable and every old R2 auxiliary route stops without contacting Worker',async()=>{
 const fetcher=async(url,options)=>auth(url,options)||Response.json([{photo_path:'',photo_url:''}]);
 assert.equal((await call(photo,{},fetcher)).statusCode,404);
 assert.equal((await call(photo,{url:'/api/photo?source=r2&key=daily/old'},fetcher)).statusCode,400);
 for(const handler of [retiredMeta,retiredThumbnail])assert.equal((await call(handler,{method:'POST'},fetcher)).statusCode,410);
 assert.equal((await call(photo,{loggedIn:false},()=>{throw Error('anonymous upstream');})).statusCode,401);
});

test('upload preparation requires a valid member, private bucket and bounded input; no production write is made',async()=>{
 let isPublic=true;const fetcher=async(url,options)=>auth(url,options)||Response.json({id:'love-photos',public:isPublic});
 const input={id:R,type:'image/jpeg',size:9*1048576};
 assert.equal((await call(upload,{method:'POST',body:input},fetcher)).statusCode,503);
 isPublic=false;const ready=await call(upload,{method:'POST',body:input},fetcher);assert.equal(ready.statusCode,200);assert(ready.body.path.startsWith(`private/${A}/${R}/`));assert(!JSON.stringify(ready.body).includes('synthetic-token'));
 assert.equal((await call(upload,{method:'POST',body:{...input,size:10485761}},fetcher)).statusCode,400);
 assert.equal((await call(upload,{method:'POST',body:input,loggedIn:false},()=>{throw Error('not reached');})).statusCode,401);
});

test('private Storage SQL keeps old rows/files, allows own uploads and two-member attached reads, rejects anonymous/nonmember/overwrite/delete',async()=>{
 const db=await database(readdirSync('supabase/migrations').sort());
 try{
  await db.exec(`alter table storage.objects add column owner_id text;create table storage.buckets(id text primary key,public boolean);insert into storage.buckets values('love-photos',true);alter table storage.buckets enable row level security;grant select on storage.buckets to authenticated;insert into storage.objects(bucket_id,name) values('love-photos','daily-checkins/old.jpg'),('love-photos','spot-checkins/old.jpg');`);
  await db.exec(readFileSync('supabase/proposals/restore-storage.sql','utf8'));
  const path=`private/${A}/${R}/20000000-0000-4000-8000-000000000001.jpg`;
  assert.equal((await asUser(db,A,'select * from storage.objects')).rows.length,2);
  assert.equal((await asUser(db,B,'select * from storage.objects')).rows.length,2);
  assert.equal((await asUser(db,C,'select * from storage.objects')).rows.length,0);
  await assert.rejects(asUser(db,null,'select * from storage.objects'));
  await asUser(db,A,`insert into storage.objects(bucket_id,name,owner_id) values('love-photos','${path}','${A}')`);
  await assert.rejects(asUser(db,B,`insert into storage.objects(bucket_id,name,owner_id) values('love-photos','${path}','${B}')`));
  await assert.rejects(asUser(db,C,`insert into storage.objects(bucket_id,name,owner_id) values('love-photos','${path}','${C}')`));
  await asUser(db,A,`insert into daily_checkins(id,content,photo_path) values('${R}','private upload','${path}')`);
  assert.equal((await asUser(db,B,`select * from storage.objects where name='${path}'`)).rows.length,1);
  assert.equal((await asUser(db,A,`delete from storage.objects where name='${path}' returning *`)).rows.length,0);
  await asUser(db,A,`delete from daily_checkins where id='${R}'`);
  assert.equal((await asUser(db,A,`select * from storage.objects where name='${path}'`)).rows.length,0);
  await db.exec('reset role');assert.equal((await db.query('select count(*)::int as n from storage.objects')).rows[0].n,4);
 }finally{await db.close();}
});

test('Vercel preview refuses all production-connected business writes even if isolated-write flag is accidentally set',async()=>{
 const oldEnv=process.env.VERCEL_ENV,oldFlag=process.env.LOVE_STORAGE_PREVIEW_WRITES,oldUrl=process.env.SUPABASE_URL;
 const {default:data}=await import('../api/data.js');
 try{
  process.env.VERCEL_ENV='preview';process.env.SUPABASE_URL='https://oemwxlvdpowjxhipcqil.supabase.co';process.env.LOVE_STORAGE_PREVIEW_WRITES='isolated';
  const never=()=>{throw Error('preview must not reach production');};
  assert.equal((await call(upload,{method:'POST',body:{id:R,type:'image/jpeg',size:100}},never)).body.code,'PREVIEW_READ_ONLY');
  assert.equal((await call(data,{url:'/api/data?resource=daily_checkins',method:'POST',body:{content:'not written'}},never)).body.code,'PREVIEW_READ_ONLY');
 }finally{for(const [key,value] of Object.entries({VERCEL_ENV:oldEnv,LOVE_STORAGE_PREVIEW_WRITES:oldFlag,SUPABASE_URL:oldUrl}))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
