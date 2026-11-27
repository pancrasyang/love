import test from 'node:test';
import assert from 'node:assert/strict';
import {app,A} from './browser-harness.mjs';

const row={id:'whole-photo',author_id:A,photo_path:'historical/full.jpg',content:'still here',created_at:'2026-10-13'};

test('an incomplete photo is never cached and retry reads one complete file',async()=>{
 const a=await app({observer:true});
 try{
  a.login();
  a.rows.daily_checkins.push(row);
  const calls=[];
  a.w.fetch=async (url,options)=>{
   calls.push({url,options});
   const etag='W/"thumbnail-v1-file-v1"';
   return new Response(calls.length===1?'short':'all of it',{headers:{
    'Content-Length':'9','Content-Type':'image/jpeg',ETag:etag
   }});
  };
  await a.run('restoreSession()');
  a.visible([0]);
  await a.idle();
  assert.equal(calls.length,1);
  assert.equal((await a.run('photoCache.stats()')).count,0);
  assert.equal(a.w.document.querySelector('.check-card img').getAttribute('src'),null);
  a.w.document.querySelector('.photo-retry').click();
  await a.idle();
  assert.equal(calls.length,2);
  assert.equal(calls[0].url,calls[1].url);
  for(const {url,options} of calls){
   assert.doesNotMatch(url,/part=|meta=|version=/);
   assert.deepEqual(Object.keys(options.headers),[]);
  }
  assert.equal((await a.run('photoCache.stats()')).count,1);
  assert.equal(a.w.document.querySelector('.check-card img').src,'blob:test');
  assert.equal(a.w.document.querySelector('.photo-retry'),null);
 }finally{await a.close();}
});

test('clearing local photos invalidates validators, while logout purges cached files and object URLs',async()=>{
 const a=await app({observer:true});
 try{
  a.login();a.rows.daily_checkins.push(row);
  const calls=[];
  a.w.fetch=async (url,options)=>{
   calls.push({url,conditional:options.headers['If-None-Match']});
   return new Response('whole',{headers:{'Content-Length':'5','Content-Type':'image/jpeg',ETag:'W/"thumbnail-v1-file-v1"'}});
  };
  await a.run('restoreSession()');
  a.visible([0]);await a.idle();
  assert.equal((await a.run('photoCache.stats()')).count,1);
  await a.run('clearLocalPhotoCache()');
  assert.equal((await a.run('photoCache.stats()')).count,0);
  a.visible([0]);await a.idle();
  assert.equal(calls.length,2);
  assert(calls.every(x=>x.conditional===undefined));
  assert(a.revoked.includes('blob:test'));
  await a.run('logout()');
  assert.equal((await a.run('photoCache.stats()')).count,0);
  assert.equal(a.w.document.querySelector('.check-card'),null);
 }finally{await a.close();}
});
