import test from 'node:test';
import assert from 'node:assert/strict';
import {app,A} from './browser-harness.mjs';

test('list and explicit original view fetch whole files separately, with lazy loading and no R2 URL',async()=>{
 const a=await app({observer:true});
 try{
  a.login();
  a.rows.daily_checkins.push({id:'history',author_id:A,photo_path:'old.jpg',photo_key:'previous-r2',content:'day',created_at:'2026-10-13'});
  a.w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  const requests=[];
  a.w.fetch=async (url,options)=>{
   const parameters=new URL(url,'https://love.invalid').searchParams;
   const thumbnail=parameters.get('variant')==='thumbnail';
   const type=thumbnail?'image/webp':'image/jpeg',bytes=thumbnail?'small':'full original';
   requests.push({url,parameters,options});
   return new Response(bytes,{headers:{'Content-Type':type,'Content-Length':String(bytes.length),ETag:'W/"'+(thumbnail?'thumbnail':'original')+'-v1-source"'}});
  };
  await a.run('restoreSession()');
  assert.equal(requests.length,0);
  a.visible([0]);await a.idle();
  assert.equal(requests.length,1);
  assert.equal(requests[0].parameters.get('variant'),'thumbnail');
  assert.equal(a.w.document.querySelector('.check-card img').src,'blob:test');
  a.w.document.querySelector('[data-view-photo]').click();
  a.visible([1]);await a.idle();
  assert.equal(requests.length,2);
  assert.equal(requests[1].parameters.get('variant'),null);
  assert.equal(a.w.document.querySelector('dialog img').src,'blob:test');
  assert.equal((await a.run('photoCache.stats()')).count,2);
  for(const {url,parameters,options} of requests){
   assert.match(url,/^\/api\/photo\?/);
   assert.equal(parameters.get('source'),'legacy');
   assert.equal(parameters.get('id'),'history');
   assert.doesNotMatch(url,/part=|meta=|version=|workers\.dev/);
   assert.deepEqual(Object.keys(options.headers),[]);
  }
  await a.run('logout()');
  assert.equal(a.w.document.querySelector('dialog'),null);
 }finally{await a.close();}
});
