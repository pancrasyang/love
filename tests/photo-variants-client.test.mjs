import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {app,A} from './browser-harness.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const query=url=>new URL(url,'https://love.invalid').searchParams;
function response(url,bytes,variant){const p=query(url),version=hash(bytes);if(p.has('meta'))return Response.json({size:bytes.length,type:variant==='thumbnail'?'image/webp':'image/jpeg',sha256:version,version,variant});const start=Number(p.get('part'))*1048576,end=Math.min(start+1048576,bytes.length);return new Response(bytes.subarray(start,end),{status:206,headers:{'X-Media-Version':version,'Content-Range':`bytes ${start}-${end-1}/${bytes.length}`}});}
async function setup(){const a=await app({observer:true});Object.defineProperty(a.w.crypto,'subtle',{value:webcrypto.subtle});a.w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};a.login();a.rows.daily_checkins.push({id:'sample',author_id:A,content:'sample',photo_key:'daily/test',created_at:'2026-10-14'});return a;}
test('the list downloads only a thumbnail, explicit original view is separate, both representations survive a rerender, logout clears the dialog',async()=>{
 const a=await setup(),thumb=Buffer.alloc(25,1),original=Buffer.alloc(1048583,2),requests=[];
 try{
  a.w.fetch=async url=>{requests.push(url);const thumbnail=query(url).get('variant')==='thumbnail';return response(url,thumbnail?thumb:original,thumbnail?'thumbnail':'original');};
  await a.run('restoreSession()');assert.equal(requests.length,0);a.visible([0]);await a.idle();assert.equal(requests.length,2);assert(requests.every(url=>query(url).get('variant')==='thumbnail'));
  a.w.document.querySelector('[data-view-photo]').click();a.visible([0,1]);await a.idle();assert.equal(requests.length,5);assert.equal((await a.run('photoCache.stats()')).count,2);
  a.w.document.querySelector('dialog button').click();assert.equal(a.w.document.querySelector('dialog'),null);
  const before=requests.length;a.rows.daily_checkins[0].content='changed text';await a.run('loadDailyCheckins()');a.visible([0]);await a.idle();assert.equal(requests.length,before);assert.equal((await a.run('photoCache.stats()')).count,2);
  a.w.document.querySelector('[data-view-photo]').click();a.visible([0,1]);await a.idle();assert.equal(requests.length,before+1); // fresh auth metadata; cached original body
  await a.run('logout()');assert.equal(a.w.document.querySelector('dialog'),null);assert.equal(a.run('photoJobs.size'),0);
 }finally{await a.close();}
});
test('an unavailable thumbnail falls back to the explicitly returned original variant and never sends original hashes to thumbnail ranges',async()=>{
 const a=await setup(),original=Buffer.alloc(1048583,2),parts=[];
 try{
  a.w.fetch=async url=>{if(query(url).has('part')){parts.push(url);assert.equal(query(url).get('variant'),null);}return response(url,original,'original');};
  await a.run('restoreSession()');a.visible([0]);await a.idle();assert.equal(parts.length,2);assert.equal(a.w.document.querySelector('img[data-media-key]').getAttribute('src'),'blob:test');
 }finally{await a.close();}
});
