import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import sharp from 'sharp';
import photo from '../api/photo.js';
import {setSession} from '../server/session.mjs';

const USER='00000000-0000-4000-8000-000000000001';
const RECORD='10000000-0000-4000-8000-000000000001';
const PATH='/api/photo?source=legacy&id='+RECORD;
process.env.SUPABASE_URL='https://test.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY='public-test';
process.env.LOVE_SESSION_SECRET='test-only-session-secret-at-least-32-characters';
const issued={setHeader(name,value){this.cookie=value.split(';')[0];}};
setSession(issued,{access_token:'synthetic-user-token',refresh_token:'synthetic-private-refresh'});
const nativeFetch=globalThis.fetch;

async function fixture(run){
 const info=console.info,warn=console.warn,logs=[];
 console.info=console.warn=line=>logs.push(line);
 let photoData,storageStatus,ignoreConditional=false,member=true,attached=true;
 const calls=[];
 const server=createServer((req,res)=>{
  res.status=code=>{res.statusCode=code;return res;};
  res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  void photo(req,res).catch(error=>res.destroy(error));
 });
 globalThis.fetch=async(url,options)=>{
  calls.push({url,options});
  assert.equal(options.headers.Authorization,'Bearer synthetic-user-token');
  if(url.endsWith('/auth/v1/user'))return Response.json({id:USER});
  if(url.includes('/profiles?'))return Response.json(member?[{id:USER,role:'pengpeng'}]:[]);
  if(url.includes('/daily_checkins?')||url.includes('/spot_checkins?')){
   return Response.json(attached?[{photo_path:'historical/private-preview-image.jpg'}]:[]);
  }
  assert.match(url,/\/storage\/v1\/object\/authenticated\/love-photos\/historical\/private-preview-image\.jpg$/);
  assert.equal(options.headers.Range,undefined);
  assert.equal(options.method??'GET','GET');
  if(storageStatus)return new Response(null,storageStatus);
  const {bytes,tag='"file-v1"',type='image/jpeg',size=bytes.length}=photoData;
  if(!ignoreConditional&&options.headers['If-None-Match']===tag)return new Response(null,{status:304,headers:{ETag:tag}});
  return new Response(bytes,{headers:{ETag:tag,'Content-Type':type,'Content-Length':String(size)}});
 };
 try{
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  await run({
   logs,storageCalls:()=>calls.filter(c=>c.url.includes('/storage/')),
   image(data){photoData=data;},storageError(data){storageStatus=data;},
   disableSourceRevalidation(){ignoreConditional=true;},revoke(){member=false;},detach(){attached=false;},
   get:(path=PATH,headers={})=>nativeFetch(base+path,{headers:{cookie:issued.cookie,...headers}})
  });
  assert(!logs.join('\n').includes('synthetic-user-token'));
  assert(!logs.join('\n').includes('synthetic-private-refresh'));
  assert(!logs.join('\n').includes('private-preview-image.jpg'));
 }finally{
  globalThis.fetch=nativeFetch;
  console.info=info;
  console.warn=warn;
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
 }
}

test('the private original route streams a complete large file using one Storage GET',async()=>{
 await fixture(async f=>{
  const bytes=Buffer.alloc(6*1024*1024+73,5);
  f.image({bytes});
  const response=await f.get();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Content-Range'),null);
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.equal(response.headers.get('X-Media-Variant'),'original');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  assert.equal(f.storageCalls().length,1);
 });
});

test('version checks reuse a cached file via 304 but first verify membership and its record',async()=>{
 await fixture(async f=>{
  f.image({bytes:Buffer.from('one')});
  const cold=await f.get();
  const tag=cold.headers.get('ETag');
  await cold.arrayBuffer();
  const conditional={'If-None-Match':tag};
  assert.ok(tag);
  const warm=await f.get(PATH,conditional);
  assert.equal(warm.status,304);
  assert.equal((await warm.arrayBuffer()).byteLength,0);
  assert.equal(f.storageCalls().at(-1).options.headers['If-None-Match'],'"file-v1"');
  f.disableSourceRevalidation();
  assert.equal((await f.get(PATH,conditional)).status,304);
  f.image({bytes:Buffer.from('two'),tag:'"file-v2"'});
  const changed=await f.get(PATH,conditional);
  assert.equal(changed.status,200);
  assert.notEqual(changed.headers.get('ETag'),tag);
  assert.equal(await changed.text(),'two');
  f.detach();
  assert.equal((await f.get(PATH,conditional)).status,404);
  f.revoke();
  assert.equal((await f.get(PATH,conditional)).status,401);
  assert.equal((await f.get(PATH,{...conditional,cookie:''})).status,401);
  assert.equal(f.storageCalls().length,4);
 });
});

test('list uses a smaller thumbnail when possible and falls back to the original in the same GET',async()=>{
 await fixture(async f=>{
  const large=await sharp({create:{width:1200,height:800,channels:3,background:'#705f53'}}).jpeg().toBuffer();
  f.image({bytes:large});
  const list=PATH+'&variant=thumbnail';
  const first=await f.get(list);
  assert.equal(first.status,200);
  assert.equal(first.headers.get('X-Media-Variant'),'thumbnail');
  assert.equal(first.headers.get('Content-Type'),'image/webp');
  const thumb=Buffer.from(await first.arrayBuffer());
  assert((await sharp(thumb).metadata()).width===960&&thumb.length<large.length);
  assert.equal(f.storageCalls().length,1);
  const warm=await f.get(list,{'If-None-Match':first.headers.get('ETag')});
  assert.equal(warm.status,304);
  const small=await sharp({create:{width:1,height:1,channels:3,background:'#334455'}}).webp({quality:78,effort:4}).toBuffer();
  f.image({bytes:small,type:'image/webp',tag:'"tiny"'});
  const fallback=await f.get(list.replace('source=legacy','source=legacy&kind=spot'));
  assert.equal(fallback.status,200);
  assert.equal(fallback.headers.get('X-Media-Variant'),'original');
  assert.deepEqual(Buffer.from(await fallback.arrayBuffer()),small);
  assert.equal(f.storageCalls().length,3);
 });
});

test('retired photo parameters and cross-site reads never reach Storage',async()=>{
 await fixture(async f=>{
  for(const query of ['part=0','meta=1','compact=1','version=1','id='+RECORD]){
   assert.equal((await f.get(PATH+'&'+query)).status,400);
  }
  assert.equal((await f.get(PATH.replace('source=legacy','source=r2'))).status,400);
  assert.equal((await f.get(PATH,{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal(f.storageCalls().length,0);
 });
});

test('Storage errors do not clear the cookie or expose paths (429 retains Retry-After)',async()=>{
 await fixture(async f=>{
  for(const [status,expected] of [[400,404],[401,401],[403,403],[404,404],[429,429],[503,503]]){
   f.storageError({status,headers:{'Retry-After':'60'}});
   const response=await f.get();
   assert.equal(response.status,expected);
   assert.equal(response.headers.get('Set-Cookie'),null);
   if(status===429)assert.equal(response.headers.get('Retry-After'),'60');
   const body=await response.json();
   assert.equal(body.stage,'legacy_storage');
   assert.equal(body.request_id,response.headers.get('X-Photo-Request-Id'));
  }
  f.storageError(null);
  f.image({bytes:Buffer.from('x'),size:21*1024*1024});
  assert.equal((await f.get()).status,413);
  f.image({bytes:Buffer.from('x'),type:'text/html'});
  assert.equal((await f.get()).status,415);
 });
});
