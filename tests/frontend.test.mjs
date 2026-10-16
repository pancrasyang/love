import test from 'node:test';import assert from 'node:assert/strict';import {IDBFactory} from 'fake-indexeddb';import {app,A,B} from './browser-harness.mjs';
test('missing or broken local SDK keeps login gated and shows a recoverable error',async()=>{
 for(const options of [{missingSdk:true},{brokenSdk:true}]){
  const a=await app(options);try{
   await a.run('restoreSession()');a.run("chooseRole('pengpeng')");
   assert(a.w.document.getElementById('privateApp').hidden);
   assert.match(a.w.document.getElementById('authMessage').textContent,options.missingSdk?/SDK_LOAD/:/SDK_INIT/);
   assert.equal(a.reads(),0);
   assert(a.w.document.getElementById('loginSubmit').disabled);
   assert(!a.w.document.getElementById('retryClient').hidden);
   assert.equal(a.run('sb'),null);
  }finally{a.close()}
 }
});
test('first visit stays gated with no private reads; restoration, both moods, edit permissions and logout',async()=>{const a=await app();try{
 await a.run('restoreSession()');assert(a.w.document.getElementById('privateApp').hidden);assert.equal(a.reads(),0);
 a.login();const today=a.run('getMoodDateKey()');a.rows.mood_records.push({id:'1',user_id:A,date:today,mood:'happy',note:'mine'},{id:'2',user_id:B,date:today,mood:'sweet',note:'partner'});
 a.rows.daily_checkins.push({id:'a',author_id:A,content:'mine',created_at:'2026-10-13T12:00:00Z'},{id:'b',author_id:B,content:'partner',created_at:'2026-10-13T12:00:00Z'},{id:'c',author_id:null,content:'legacy',created_at:'2026-10-13T12:00:00Z'});
 await a.run('restoreSession()');assert(!a.w.document.getElementById('privateApp').hidden);
 assert.match(a.w.document.getElementById('currentIdentity').textContent,/朋朋/);
 assert.equal(a.w.document.querySelectorAll('[data-action="delete"]').length,1);
 assert.match(a.w.document.getElementById('dailyList').textContent,/历史记录/);
 const cell=a.w.document.querySelector(`[data-date="${today}"]`);assert.match(cell.textContent,/😊/);assert.match(cell.textContent,/💗/);
 a.run(`openMoodPopover('${today}')`);assert.match(a.w.document.getElementById('moodViewBox').textContent,/partner/);
 a.run("mediaUrls.add('blob:secret')");await a.run('logout()');assert(a.w.document.getElementById('privateApp').hidden);assert.equal(a.w.document.getElementById('dailyList').textContent,'');assert.equal(a.w.document.getElementById('moodViewBox').textContent,'');assert(a.revoked.includes('blob:secret'));
 a.login(B);await a.run('restoreSession()');assert.match(a.w.document.getElementById('currentIdentity').textContent,/开开/);assert.equal(a.w.document.querySelector('[data-action="delete"]').dataset.id,'b');
 assert.equal(a.run("getMoodDateKey(new Date('2026-10-13T16:00:00Z'))"),'2026-10-14');
 assert.equal(a.w.document.querySelectorAll('audio').length,0);
}finally{a.close()}});
test('unknown account remains gated and old local moods stay untouched',async()=>{const a=await app();try{a.w.localStorage.setItem('loveDailyMoodRecordsV1','{"old":"kept"}');a.login('unknown');await a.run('restoreSession()');assert(a.w.document.getElementById('privateApp').hidden);assert.equal(a.w.localStorage.getItem('loveDailyMoodRecordsV1'),'{"old":"kept"}');}finally{a.close()}});
test('late photo response after logout cannot be displayed',async()=>{const a=await app();try{a.login();await a.run('restoreSession()');let finish;a.w.fetch=()=>new Promise(r=>{finish=r});const promise=a.run("mediaFetch('/api/media/key')");await new Promise(r=>setImmediate(r));await a.run('logout()');finish({ok:true,blob:async()=>new Blob(['secret'])});await assert.rejects(promise);}finally{a.close()}});
test('loading a private photo preserves the record text and author buttons',async()=>{const a=await app();try{a.login();a.rows.daily_checkins.push({id:'a',author_id:A,content:'keep this text',photo_key:'daily/key',created_at:'2026-10-13T12:00:00Z'});a.w.fetch=async url=>String(url).includes('meta=1')?{ok:true,json:async()=>({size:5,type:'image/jpeg',version:'v1'})}:{ok:true,headers:{get:name=>name==='Content-Range'?'bytes 0-4/5':name==='X-Media-Version'?'v1':null},arrayBuffer:async()=>new ArrayBuffer(5)};await a.run('restoreSession()');assert.match(a.w.document.getElementById('dailyList').textContent,/keep this text/);assert(a.w.document.querySelector('[data-action="delete"]'));assert.equal(a.w.document.querySelector('[data-media-key]').src,'blob:test');}finally{a.close()}});
test('members can read and add comments on daily records without adding controls to historical spots',async()=>{const a=await app();try{
 a.login();a.rows.daily_checkins.push({id:'daily-a',author_id:A,content:'day',created_at:'2026-10-13T12:00:00Z'});a.rows.spot_checkins.push({id:'spot-a',spot_name:'place',created_at:'2026-10-12T12:00:00Z'});a.rows.daily_comments.push({id:'comment-a',daily_id:'daily-a',author_id:B,content:'已有评论',created_at:'2026-10-13T13:00:00Z'});
 await a.run('restoreSession()');assert.equal(a.w.document.querySelectorAll('[data-comment-form]').length,1);assert.match(a.w.document.querySelector('.comment-list').textContent,/开开/);assert.match(a.w.document.querySelector('.comment-list').textContent,/已有评论/);
 const form=a.w.document.querySelector('[data-comment-form]');form.elements.content.value=' 新评论 ';form.dispatchEvent(new a.w.Event('submit',{bubbles:true,cancelable:true}));for(let i=0;i<30&&a.rows.daily_comments.length<2;i++)await new Promise(r=>setTimeout(r,5));assert.equal(a.rows.daily_comments[1].content,'新评论');assert.equal(a.rows.daily_comments[1].author_id,A);assert.match(a.w.document.getElementById('dailyList').textContent,/新评论/);
}finally{a.close()}});
test('legacy photo renders through authorized same-origin chunks without a public URL',async()=>{const a=await app();try{a.login();a.rows.daily_checkins.push({id:A,author_id:null,content:'old text preserved',photo_url:'https://test.supabase.co/storage/v1/object/public/love-photos/old.jpg',created_at:'2026-10-13T12:00:00Z'});let calls=0;a.w.fetch=async url=>{calls++;assert.match(url,/^\/api\/photo\?source=legacy/);if(url.includes('meta=1'))return {ok:true,json:async()=>({size:1048579,type:'image/jpeg',version:'v1'})};const part=Number(new URL(url,'https://love.invalid').searchParams.get('part')),start=part*1048576,size=part===0?1048576:3;return {ok:true,headers:{get:name=>name==='Content-Range'?`bytes ${start}-${start+size-1}/1048579`:name==='X-Media-Version'?'v1':'image/jpeg'},arrayBuffer:async()=>new ArrayBuffer(size)}};await a.run('restoreSession()');assert.equal(calls,3);assert.equal(a.w.document.querySelector('[data-legacy-id]').src,'blob:test');assert.match(a.w.document.getElementById('dailyList').textContent,/old text preserved/);assert(!a.w.document.querySelector('img[src*="supabase.co"]'));}finally{a.close()}});
function servePhoto(url,version='v1',length=5){if(String(url).includes('meta=1'))return {ok:true,json:async()=>({size:length,type:'image/jpeg',version})};const part=Number(new URL(url,'https://love.invalid').searchParams.get('part'));const start=part*1048576,end=Math.min(start+1048575,length-1);return {ok:true,headers:{get:name=>name==='Content-Range'?`bytes ${start}-${end}/${length}`:name==='X-Media-Version'?version:null},arrayBuffer:async()=>new ArrayBuffer(end-start+1)}}
function addPhotos(a,n=6){for(let i=0;i<n;i++)a.rows.daily_checkins.push({id:'photo'+i,author_id:A,content:'text',photo_key:'daily/key'+i,created_at:'2026-10-13T12:00:00Z'})}
test('IntersectionObserver loads visible photos only, shares in-flight requests and keeps URLs after text changes',async()=>{const a=await app({observer:true});try{a.login();addPhotos(a);const requests=[];let concurrent=0,peak=0;a.w.fetch=async url=>{requests.push(url);concurrent++;peak=Math.max(peak,concurrent);await new Promise(r=>setTimeout(r,5));concurrent--;return servePhoto(url)};await a.run('restoreSession()');assert.equal(requests.length,0);a.visible([0,1]);await Promise.all([a.run('hydratePrivatePhotos()'),a.run('hydratePrivatePhotos()')]);await a.idle();assert.equal(requests.filter(u=>u.includes('part=')).length,2);assert(peak<=2);const img=a.w.document.querySelector('img[data-media-key]'),count=requests.length;a.rows.daily_checkins[0]={...a.rows.daily_checkins[0],content:'new text'};await a.run('loadDailyCheckins()');await a.idle();assert.equal(a.w.document.querySelector('img[data-media-key]'),img);assert.equal(requests.length,count);assert.equal(a.revoked.length,0)}finally{a.close()}});
test('focus restoration during photo download resumes without a late-response loss',async()=>{const a=await app({observer:true});try{a.login();addPhotos(a,1);let finish;a.w.fetch=async url=>url.includes('meta=1')?servePhoto(url):new Promise(r=>finish=()=>r(servePhoto(url)));await a.run('restoreSession()');a.visible([0]);while(!finish)await new Promise(r=>setTimeout(r,5));await a.run('restoreSession()');finish();await a.idle();assert.equal(a.w.document.querySelector('img[data-media-key]').src,'blob:test');assert.equal(a.w.document.querySelector('.photo-retry'),null)}finally{a.close()}});
test('a new page uses persistent cached bytes after authorization; unsigned users never display cache',async()=>{const factory=new IDBFactory();let downloads=0;async function page(signedIn){const a=await app({observer:true,cacheFactory:factory});addPhotos(a,1);a.w.fetch=async url=>{if(url.includes('part='))downloads++;return servePhoto(url)};if(signedIn)a.login();await a.run('restoreSession()');if(signedIn){a.visible([0]);await a.idle();assert(a.w.document.querySelector('[data-media-key]').hasAttribute('src'))}else{assert(a.w.document.getElementById('privateApp').hidden);assert.equal(a.w.document.querySelector('[data-media-key]'),null)}a.close();}await page(true);assert.equal(downloads,1);await page(false);await page(true);assert.equal(downloads,1)});
test('photo version replacement and record deletion invalidate persistent cache',async()=>{const a=await app();try{a.login();addPhotos(a,1);let version='v1',downloads=0;a.w.fetch=async url=>{if(url.includes('part='))downloads++;return servePhoto(url,version)};await a.run('restoreSession()');version='v2';await a.run('restoreSession()');assert.equal(downloads,2);assert.equal((await a.run('photoCache.stats()')).count,1);a.rows.daily_checkins=[];await a.run('loadDailyCheckins()');await new Promise(r=>setTimeout(r,15));assert.equal((await a.run('photoCache.stats()')).count,0)}finally{a.close()}});
test('the preserved historical spot photo has a read-only card',async()=>{const a=await app();try{a.login();a.rows.spot_checkins.push({id:A,spot_name:'old location',spot_date:'2026-01-01',created_at:'2026-01-01T00:00:00Z',photo_path:'old.jpg'});a.w.fetch=async url=>servePhoto(url);await a.run('restoreSession()');assert.match(a.w.document.getElementById('dailyList').textContent,/历史地点/);assert.equal(a.w.document.querySelector('[data-legacy-kind]').dataset.legacyKind,'spot');assert.equal(a.w.document.querySelector('[data-action]'),null)}finally{a.close()}});
test('failed photos keep retry controls through rerender and recover with unchanged records',async()=>{const a=await app();try{a.login();addPhotos(a,1);let healthy=false;a.w.fetch=async url=>url.includes('meta=1')||healthy?servePhoto(url):{ok:false,status:503,json:async()=>({error:'temporary outage',code:'MEDIA_SOURCE_UNAVAILABLE'})};await a.run('restoreSession()');assert(a.w.document.querySelector('.photo-retry'));a.rows.daily_checkins[0]={...a.rows.daily_checkins[0],content:'edit while unavailable'};await a.run('loadDailyCheckins()');assert(a.w.document.querySelector('.photo-retry'));healthy=true;await a.run('loadDailyCheckins()');assert.equal(a.w.document.querySelector('[data-media-key]').src,'blob:test');assert.equal(a.w.document.querySelector('.photo-retry'),null)}finally{a.close()}});

test('a failed record source leaves the other source and its photos usable, including after focus restoration',async()=>{
 for(const table of ['spot_checkins','daily_checkins']){
  const sourceErrors={},a=await app({sourceErrors});
  try{
   a.login();addPhotos(a,1);a.rows.spot_checkins.push({id:'spot',spot_name:'old place',created_at:'2026-01-01',photo_path:'old.jpg'});a.w.fetch=async url=>servePhoto(url);
   await a.run('restoreSession()');
   sourceErrors[table]={message:'temporary outage',code:'UPSTREAM_NETWORK'};
   await a.run('restoreSession()');
   assert.equal(a.run('photoPaused'),false);assert(!a.w.document.getElementById('privateApp').hidden);
   assert.equal(a.w.document.querySelectorAll('.check-card').length,1);
   assert.equal(a.w.document.querySelector('.check-card img').src,'blob:test');
   assert.match(a.w.document.querySelector('.record-source-error').textContent,table==='spot_checkins'?/历史地点/:/日常记录/);
   delete sourceErrors[table];await a.run('loadDailyCheckins()');
   assert.equal(a.w.document.querySelectorAll('.check-card').length,2);assert.equal(a.w.document.querySelector('.record-source-error'),null);
  }finally{await a.close()}
 }
});

test('an initial historical source outage does not strand the list or photo queue',async()=>{
 const a=await app({sourceErrors:{spot_checkins:{message:'unavailable'}}});
 try{a.login();addPhotos(a,1);a.w.fetch=async url=>servePhoto(url);await a.run('restoreSession()');assert.equal(a.run('photoPaused'),false);assert.equal(a.w.document.querySelector('[data-media-key]').src,'blob:test');assert(!a.w.document.querySelector('.loading'));assert(a.w.document.querySelector('[data-action="retry"]'));}finally{await a.close()}
});

test('photo source refusal stays local; confirmed session expiry clears the private view',async()=>{
 for(const [status,code,cleared] of [[401,'MEDIA_SOURCE_DENIED',false],[403,'MEDIA_SOURCE_DENIED',false],[429,'MEDIA_SOURCE_RATE_LIMITED',false],[503,'MEDIA_SOURCE_UNAVAILABLE',false],[401,'SESSION_INVALID',true],[401,'PROFILE_DENIED',true]]){
  const a=await app();
  try{
   a.login();addPhotos(a,1);a.w.fetch=async()=>({ok:false,status,json:async()=>({error:'request failed',code,request_id:'diagnostic-id',stage:'legacy_storage'})});
   await a.run('restoreSession()');assert.equal(a.w.document.getElementById('privateApp').hidden,cleared,code);
   if(!cleared){assert(a.w.document.querySelector('.photo-retry'));assert.equal(a.run('currentProfile.id'),A);}
  }finally{await a.close()}
 }
});

test('temporary session verification failure preserves the view with a retry, while revoked sessions clear it',async()=>{
 const authErrors={},a=await app({authErrors});
 try{
  a.login();addPhotos(a,1);a.w.fetch=async url=>servePhoto(url);await a.run('restoreSession()');
  authErrors.session={code:'AUTH_USER_RATE_LIMITED',message:'rate limited'};await a.run('restoreSession()');
  assert(!a.w.document.getElementById('privateApp').hidden);assert.equal(a.w.document.querySelectorAll('.check-card').length,1);assert.equal(a.run('photoPaused'),true);assert(a.w.document.querySelector('.session-retry'));
  delete authErrors.session;await a.run('restoreSession()');assert.equal(a.run('photoPaused'),false);assert.equal(a.w.document.querySelector('.session-retry'),null);
  authErrors.session={code:'SESSION_INVALID',message:'expired'};await a.run('restoreSession()');assert(a.w.document.getElementById('privateApp').hidden);assert.equal(a.w.document.querySelector('.check-card'),null);
 }finally{await a.close()}
});

test('an expired-photo response arriving after an account switch cannot sign out the new account',async()=>{
 const a=await app({observer:true});
 try{
  a.login();addPhotos(a,1);let finish;a.w.fetch=()=>new Promise(resolve=>finish=resolve);
  await a.run('restoreSession()');a.visible([0]);while(!finish)await new Promise(resolve=>setImmediate(resolve));
  await a.run('logout()');a.login(B);a.w.fetch=async url=>servePhoto(url);await a.run('restoreSession()');a.visible([0]);
  finish({ok:false,status:401,json:async()=>({code:'SESSION_INVALID',error:'old session expired'})});await a.idle();
  assert(!a.w.document.getElementById('privateApp').hidden);assert.equal(a.run('currentProfile.id'),B);assert.equal(a.w.document.querySelector('[data-media-key]').src,'blob:test');
 }finally{await a.close()}
});
