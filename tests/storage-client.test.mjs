import test from 'node:test';import assert from 'node:assert/strict';import {app,A} from './browser-harness.mjs';
test('clearing a private session purges stored photos and rejects writes started before logout',async()=>{
 const a=await app();try{
  a.login();await a.run('restoreSession()');const ticket=await a.run('photoCache.ticket()');
  await a.run(`photoCache.put({id:'private-test',account:'${A}',ref:'storage-v1:daily:test',version:'v1',mime:'image/jpeg'},new Blob(['private']),${ticket})`);
  assert.equal((await a.run('photoCache.stats()')).count,1);a.run('clearPrivateView()');
  assert.equal((await a.run('photoCache.stats()')).count,0);
  assert.equal(await a.run(`photoCache.put({id:'late',account:'${A}',ref:'storage-v1:daily:late',version:'v1',mime:'image/jpeg'},new Blob(['late']),${ticket})`),false);
 }finally{await a.close();}
});
test('historical Storage references win over old R2 keys; R2-only cards keep their records without any media request',async()=>{
 const a=await app({observer:true});try{
  a.login();a.rows.daily_checkins.push({id:'new-r2-only',author_id:A,content:'keep me',photo_key:'daily/r2-only',photo_path:'',photo_url:'',created_at:'2026-10-20'},{id:'historical',content:'old',photo_key:'daily/migrated',photo_path:'daily-checkins/old.jpg',created_at:'2026-06-01'});
  const calls=[];a.w.fetch=async url=>{calls.push(String(url));return Response.json({});};await a.run('restoreSession()');
  assert.match(a.w.document.querySelector('.photo-unavailable').textContent,/照片暂不可用/);assert.equal(a.rows.daily_checkins.length,2);assert.equal(a.rows.daily_checkins[0].photo_key,'daily/r2-only');
  const images=a.w.document.querySelectorAll('img[data-legacy-id]');assert.equal(images.length,1);assert.equal(images[0].dataset.legacyId,'historical');assert.equal(calls.length,0);
  await a.run('cleanupOrphanPhotos()');assert.equal(calls.length,0);
 }finally{await a.close();}
});
test('new uploads use member-authenticated Supabase requests and return Storage paths without an R2 key',async()=>{
 const a=await app();try{
  a.login();await a.run('restoreSession()');const calls=[];
  a.w.fetch=async(url,options)=>{calls.push({url,options});if(url==='/api/storage-upload'){const body=JSON.parse(options.body);assert.equal(body.id,'record');return Response.json({path:'private/owner/record/photo.jpg',upload_url:'https://storage.invalid/storage/v1/object/love-photos/private/owner/record/photo.jpg'});}assert.match(url,/^https:\/\/storage.invalid\/storage\/v1\/object\/love-photos\//);assert.equal(options.headers.Authorization,'Bearer test');assert.equal(options.headers['x-upsert'],'false');return new Response('{}');};
  const uploaded=await a.run("uploadImage(new Blob(['test-image'],{type:'image/jpeg'}),'record')");assert.equal(uploaded.key,null);assert.equal(uploaded.path,'private/owner/record/photo.jpg');assert.equal(calls.length,2);assert(!calls.some(c=>String(c.url).includes('workers.dev')));
 }finally{await a.close();}
});
