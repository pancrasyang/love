import test from 'node:test';import assert from 'node:assert/strict';import worker from '../worker/src/index.mjs';import {inspectImage,MAX_BYTES} from '../worker/src/image-type.mjs';
import {createHash} from 'node:crypto';
import {JPEG,PROGRESSIVE_JPEG} from './jpeg-fixtures.mjs';
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002',R='10000000-0000-4000-8000-000000000001',KEY=`daily/${R}/${A}/abc.png`;
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=','base64');
function env(){const objects=new Map();return {SUPABASE_URL:'https://supabase.invalid',SUPABASE_PUBLISHABLE_KEY:'public',ALLOWED_ORIGINS:'https://love.invalid',objects,LOVE_MEDIA:{async put(k,b){objects.set(k,b)},async delete(k){objects.delete(k)},async get(k){const b=objects.get(k);return b?{body:b,size:b.length}:null}}}}
function request(path,method='GET',body=null,extra={}){return new Request('https://worker.invalid'+path,{method,headers:{Origin:'https://love.invalid',Authorization:'Bearer valid',...(body?{'Content-Type':'image/png','X-Record-Id':R}:{}),...extra},body})}
async function mock(fn,run){const old=globalThis.fetch;globalThis.fetch=fn;try{await run()}finally{globalThis.fetch=old}}
function authRoutes(url,profile=A){if(url.endsWith('/auth/v1/user'))return Response.json({id:A});if(url.includes('/profiles?'))return Response.json(profile?[{id:profile,role:'pengpeng'}]:[]);return null}
test('reject spoofed MIME, SVG, truncated and oversized images',()=>{assert.equal(inspectImage(PNG,'image/png').ext,'png');for(const [data,type] of [[PNG,'image/jpeg'],[Buffer.from('<svg/>'),'image/png'],[PNG.subarray(0,40),'image/png'],[new Uint8Array(MAX_BYTES+1),'image/png']])assert.throws(()=>inspectImage(data,type))});
test('JPEG EOI is parsed structurally; baseline, progressive and trailers are supported',()=>{
 for(const jpeg of [JPEG,PROGRESSIVE_JPEG]){
  const input=Buffer.concat([jpeg,Buffer.alloc(24,19)]);
  assert.equal(inspectImage(input,'image/jpeg').byteLength,jpeg.length);
  assert.throws(()=>inspectImage(jpeg.subarray(0,-2),'image/jpeg'),/JPEG/);
  assert.throws(()=>inspectImage(input,'image/png'),/类型/);
 }
 // An EOI-looking sequence in metadata must not truncate the actual image.
 const metadata=Buffer.from([255,226,0,6,255,217,0,0]);
 const embedded=Buffer.concat([JPEG.subarray(0,2),metadata,JPEG.subarray(2)]);
 assert.equal(inspectImage(embedded,'image/jpeg').byteLength,embedded.length);
 assert.throws(()=>inspectImage(Buffer.from([255,216,255,217,...Buffer.alloc(20)]),'image/jpeg'),/缺少图像数据/);
});
test('upload strips JPEG trailer before R2 storage, size and hash registration',async()=>{
 const e=env(),input=Buffer.concat([JPEG,Buffer.from('<script>discarded trailer</script>')]);
 await mock(async(u,o)=>{
  const auth=authRoutes(u);if(auth)return auth;
  const row=JSON.parse(o.body);
  assert.equal(row.size_bytes,JPEG.length);
  assert.equal(row.sha256,createHash('sha256').update(JPEG).digest('hex'));
  assert.equal(row.content_type,'image/jpeg');
  return new Response(null,{status:201});
 },async()=>{
  const response=await worker.fetch(request('/api/media','POST',input,{'Content-Type':'image/jpeg'}),e);
  assert.equal(response.status,201);
  assert.deepEqual(Buffer.from([...e.objects.values()][0]),JPEG);
  assert.equal((await response.json()).size,JPEG.length);
 });
});
test('CORS, absent token and revoked membership reject before R2',async()=>{const e=env();assert.equal((await worker.fetch(request('/api/media/x','GET',null,{Origin:'https://evil.invalid'}),e)).status,403);assert.equal((await worker.fetch(request('/api/media/x','GET',null,{Authorization:''}),e)).status,401);await mock(async u=>authRoutes(u,null),async()=>assert.equal((await worker.fetch(request('/api/media/'+KEY),e)).status,403));assert.equal(e.objects.size,0)});
test('upload stores verified type and owner and rolls back metadata failure',async()=>{const e=env();await mock(async(u,o)=>{const auth=authRoutes(u);if(auth)return auth;const row=JSON.parse(o.body);assert.equal(row.owner_id,A);assert.match(row.key,new RegExp(`^daily/${R}/${A}/`));return new Response(null,{status:201})},async()=>{const response=await worker.fetch(request('/api/media','POST',PNG),e);assert.equal(response.status,201);assert.equal(e.objects.size,1)});
 const e2=env();await mock(async u=>authRoutes(u)||new Response(null,{status:403}),async()=>{assert.equal((await worker.fetch(request('/api/media','POST',PNG),e2)).status,403);assert.equal(e2.objects.size,0)});
});
test('private GET is no-store; partner cannot delete owner media',async()=>{const e=env();e.objects.set(KEY,PNG);await mock(async u=>authRoutes(u)||Response.json([{key:KEY,owner_id:B,content_type:'image/png',state:'ready'}]),async()=>{const r=await worker.fetch(request('/api/media/'+KEY),e);assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'private, no-store');assert.equal((await worker.fetch(request('/api/media/'+KEY,'DELETE'),e)).status,403);assert.equal(e.objects.size,1)})});
test('attached image cannot be removed, orphan deletion is recoverable',async()=>{const e=env();e.objects.set(KEY,PNG);let attached=true;await mock(async u=>{const auth=authRoutes(u);if(auth)return auth;if(u.includes('begin_media_delete'))return attached?new Response(null,{status:400}):Response.json(true);if(u.includes('finish_media_delete'))return Response.json(null);return Response.json([{key:KEY,owner_id:A,state:'ready'}])},async()=>{assert.equal((await worker.fetch(request('/api/media/'+KEY,'DELETE'),e)).status,403);assert.equal(e.objects.size,1);attached=false;assert.equal((await worker.fetch(request('/api/media/'+KEY,'DELETE'),e)).status,204);assert.equal(e.objects.size,0)})});
