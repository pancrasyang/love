import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {migrate,sourcePath,signedS3} from '../scripts/migrate-photos.mjs';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=','base64');
test('migration rejects unknown legacy photo hosts and traversal',()=>{assert.throws(()=>sourcePath({photo_url:'https://evil.invalid/photo'},'https://test.supabase.co','love-photos'));assert.throws(()=>sourcePath({photo_path:'../private'},'https://test.supabase.co','love-photos'))});
for(const corrupt of [false,true])test(`migration ${corrupt?'does not link corrupted copy':'verifies copy before linking'} and retains source`,async()=>{const dir=mkdtempSync(join(tmpdir(),'love-migration-'));let linked=false,put=false;const calls=[];try{
 const report=await migrate({apply:true,reportPath:join(dir,'report.json'),env:{SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fake',R2_ENDPOINT:'https://test.r2.cloudflarestorage.com',R2_ACCESS_KEY_ID:'fake',R2_SECRET_ACCESS_KEY:'fake'},fetcher:async(url,opt={})=>{
  calls.push(opt.method||'GET');if(url.includes('/object/authenticated/'))return new Response(PNG);
  if(url.includes('r2.cloudflarestorage.com')){if(opt.method==='PUT'){put=true;return new Response('')}assert(put);return new Response(corrupt?'bad':PNG)}
  if(url.includes('media_objects'))return Response.json([]);
  if(opt.method==='PATCH'){assert(put);linked=true;return Response.json([{id:'x'}])}
  return Response.json([{id:'10000000-0000-4000-8000-000000000001',author_id:null,photo_path:'daily-checkins/old.png',photo_key:null}]);
 }});assert.equal(linked,!corrupt);assert.equal(report.failed,corrupt?1:0);assert(!calls.includes('DELETE'));
 }finally{rmSync(dir,{recursive:true,force:true})}});
test('default migration dry-run performs zero writes',async()=>{const dir=mkdtempSync(join(tmpdir(),'love-dry-'));try{const report=await migrate({reportPath:join(dir,'r.json'),env:{SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fake'},fetcher:async(url,o={})=>{assert(!o.method||o.method==='GET');return url.includes('/object/')?new Response(PNG):Response.json([{id:'a',photo_path:'daily/old.png'}])}});assert.equal(report.items[0].status,'ready')}finally{rmSync(dir,{recursive:true,force:true})}});
