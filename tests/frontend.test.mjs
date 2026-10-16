import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {IDBFactory} from 'fake-indexeddb';import {app,A,B} from './browser-harness.mjs';
async function eventually(check,message='condition was not met'){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(message)}
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
test('delayed comments do not block cards or photos and update without replacing the image',async()=>{
 let release;const delayed=new Promise(resolve=>release=resolve),a=await app({sourceDelays:{daily_comments:()=>delayed}});
 try{
  a.login();a.rows.daily_checkins.push({id:'daily-a',author_id:A,content:'visible first',photo_key:'daily/key',created_at:'2026-10-13T12:00:00Z'});a.rows.daily_comments.push({id:'comment-a',daily_id:'daily-a',author_id:B,content:'arrives later',created_at:'2026-10-13T13:00:00Z'});
  const requests=[];a.w.fetch=async url=>{requests.push(String(url));return servePhoto(url)};
  const restoring=a.run('restoreSession()');await eventually(()=>a.w.document.querySelector('[data-media-key]')?.src==='blob:test');
  const image=a.w.document.querySelector('[data-media-key]'),bodies=requests.filter(url=>url.includes('part=')).length;
  assert.match(a.w.document.getElementById('dailyList').textContent,/visible first/);assert.doesNotMatch(a.w.document.getElementById('dailyList').textContent,/arrives later/);
  release();await restoring;await eventually(()=>/arrives later/.test(a.w.document.getElementById('dailyList').textContent));
  assert.equal(a.w.document.querySelector('[data-media-key]'),image);assert.equal(requests.filter(url=>url.includes('part=')).length,bodies);
 }finally{await a.close()}
});
test('comment failure and retry stay local and never redownload the displayed photo',async()=>{
 const sourceErrors={daily_comments:{message:'temporary'}},a=await app({sourceErrors});
 try{
  a.login();a.rows.daily_checkins.push({id:'daily-a',author_id:A,content:'day',photo_key:'daily/key',created_at:'2026-10-13T12:00:00Z'});a.rows.daily_comments.push({id:'comment-a',daily_id:'daily-a',author_id:B,content:'recovered',created_at:'2026-10-13T13:00:00Z'});
  const requests=[];a.w.fetch=async url=>{requests.push(String(url));return servePhoto(url)};await a.run('restoreSession()');await eventually(()=>a.w.document.querySelector('[data-action="retry-comments"]'));
  const image=a.w.document.querySelector('[data-media-key]'),bodies=requests.filter(url=>url.includes('part=')).length;delete sourceErrors.daily_comments;
  a.w.document.querySelector('[data-action="retry-comments"]').click();await eventually(()=>/recovered/.test(a.w.document.querySelector('.comment-list').textContent));
  assert.equal(a.w.document.querySelector('[data-media-key]'),image);assert.equal(requests.filter(url=>url.includes('part=')).length,bodies);
 }finally{await a.close()}
});
test('legacy photo renders through authorized same-origin chunks without a public URL',async()=>{const a=await app();try{a.login();a.rows.daily_checkins.push({id:A,author_id:null,content:'old text preserved',photo_url:'https://test.supabase.co/storage/v1/object/public/love-photos/old.jpg',created_at:'2026-10-13T12:00:00Z'});let calls=0;a.w.fetch=async url=>{calls++;assert.match(url,/^\/api\/photo\?source=legacy/);if(url.includes('meta=1'))return {ok:true,json:async()=>({size:1048579,type:'image/jpeg',version:'v1'})};const part=Number(new URL(url,'https://love.invalid').searchParams.get('part')),start=part*1048576,size=part===0?1048576:3;return {ok:true,headers:{get:name=>name==='Content-Range'?`bytes ${start}-${start+size-1}/1048579`:name==='X-Media-Version'?'v1':'image/jpeg'},arrayBuffer:async()=>new ArrayBuffer(size)}};await a.run('restoreSession()');assert.equal(calls,3);assert.equal(a.w.document.querySelector('[data-legacy-id]').src,'blob:test');assert.match(a.w.document.getElementById('dailyList').textContent,/old text preserved/);assert(!a.w.document.querySelector('img[src*="supabase.co"]'));}finally{a.close()}});
function servePhoto(url,version='v1',length=5){if(String(url).includes('meta=1'))return {ok:true,json:async()=>({size:length,type:'image/jpeg',version})};const part=Number(new URL(url,'https://love.invalid').searchParams.get('part'));const start=part*1048576,end=Math.min(start+1048575,length-1);return {ok:true,headers:{get:name=>name==='Content-Range'?`bytes ${start}-${end}/${length}`:name==='X-Media-Version'?version:null},arrayBuffer:async()=>new ArrayBuffer(end-start+1)}}
function serveBatch(options,{version,length=5}={}){version||=createHash('sha256').update(Buffer.alloc(length)).digest('hex');const {items}=JSON.parse(options.body);return {ok:true,json:async()=>({results:items.map(item=>({key:item.key,requested_variant:item.variant,status:'available',size:length,type:item.variant==='thumbnail'?'image/webp':'image/jpeg',version,sha256:version,variant:item.variant,source_version:version}))})}}
function addPhotos(a,n=6){for(let i=0;i<n;i++)a.rows.daily_checkins.push({id:'photo'+i,author_id:A,content:'text',photo_key:'daily/key'+i,created_at:'2026-10-13T12:00:00Z'})}
function addDailyPages(a,count=45){const newest=Date.parse('2026-10-16T12:00:00Z');for(let i=0;i<count;i++)a.rows.daily_checkins.push({id:'page-'+String(i).padStart(3,'0'),author_id:A,content:'row '+i,created_at:new Date(newest-i*1000).toISOString()})}
test('daily pagination uses a stable cursor and ignores a newer insertion between pages',async()=>{const a=await app();try{
 a.login();addDailyPages(a);await a.run('restoreSession()');assert.equal(a.w.document.querySelectorAll('.check-card').length,20);assert.equal(a.run('dailyRecords.length'),20);assert.equal(a.w.document.getElementById('loadMoreDaily').hidden,false);
 a.rows.daily_checkins.push({id:'new-between-pages',author_id:A,content:'newer',created_at:'2026-10-17T00:00:00Z'});await a.run('loadMoreDailyCheckins()');
 const ids=[...a.w.document.querySelectorAll('.check-card')].filter(card=>!card.querySelector('[data-legacy-kind]')).map(card=>card.dataset.recordId);assert.equal(ids.length,40);assert.equal(new Set(ids).size,40);assert(!ids.includes('new-between-pages'));
}finally{await a.close()}});
test('focus refresh keeps loaded pages and bounds historical synchronization',async()=>{const a=await app();try{
 a.login();addDailyPages(a,45);const newest=Date.parse('2026-10-15T12:00:00Z');for(let i=0;i<120;i++)a.rows.spot_checkins.push({id:'spot-'+String(i).padStart(3,'0'),spot_name:'spot '+i,created_at:new Date(newest-i*1000).toISOString()});
 await a.run('restoreSession()');await eventually(()=>a.run('legacySpotRecords.length')===120);await a.run('loadMoreDailyCheckins()');assert.equal(a.run('dailyRecords.length'),40);a.queries.length=0;
 await a.run('restoreSession()');assert.equal(a.run('dailyRecords.length'),40);const spotQueries=a.queries.filter(query=>query.table==='spot_checkins');assert.equal(spotQueries.length,2);assert(spotQueries.some(query=>query.range?.[1]===50));assert(spotQueries.some(query=>query.inFilters.some(([key])=>key==='id')));
}finally{await a.close()}});
test('refreshing the first page keeps a valid later-page cache entry',async()=>{const a=await app();try{
 a.login();addDailyPages(a,25);a.rows.daily_checkins.at(-1).photo_key='daily/later';const ticket=await a.run('photoCache.ticket()');await a.run(`photoCache.put({id:'cached-later',account:'${A}',ref:'r2:daily/later:thumbnail',version:'v1',mime:'image/jpeg'},new Blob(['later']),${ticket})`);
 await a.run('restoreSession()');await a.run('loadDailyCheckins()');assert.equal((await a.run('photoCache.stats()')).count,1);assert(await a.run("photoCache.get('cached-later')"));
}finally{await a.close()}});
test('orphan cleanup asks the server about keys outside the current page',async()=>{const a=await app();try{
 a.login();addDailyPages(a,21);a.rows.daily_checkins.at(-1).photo_key='daily/later';a.rows.media_objects.push({key:'daily/later',record_id:a.rows.daily_checkins.at(-1).id,owner_id:A,state:'ready',created_at:'2020-01-01T00:00:00Z'});let deletes=0;a.w.fetch=async url=>{if(String(url).includes('love-media-api'))deletes++;return {ok:true,json:async()=>({}),blob:async()=>new Blob()}};
 await a.run('restoreSession()');await eventually(()=>a.queries.some(query=>query.table==='daily_checkins'&&query.inFilters.some(([key])=>key==='photo_key')));assert.equal(deletes,0);
}finally{await a.close()}});
test('many comments are paged per record without duplicates',async()=>{const a=await app();try{
 a.login();a.rows.daily_checkins.push({id:'daily-a',author_id:A,content:'day',created_at:'2026-10-13T12:00:00Z'});const newest=Date.parse('2026-10-14T12:00:00Z');for(let i=0;i<25;i++)a.rows.daily_comments.push({id:'comment-'+String(i).padStart(3,'0'),daily_id:'daily-a',author_id:B,content:'comment '+i,created_at:new Date(newest-i*1000).toISOString()});
 await a.run('restoreSession()');await eventually(()=>a.w.document.querySelectorAll('.comment').length===20);assert(a.w.document.querySelector('[data-action="more-comments"]'));await a.run("loadCommentsForRecord('daily-a',{more:true})");const comments=[...a.w.document.querySelectorAll('.comment')];assert.equal(comments.length,25);assert.equal(new Set(comments.map(node=>node.textContent)).size,25);
}finally{await a.close()}});
test('IntersectionObserver loads visible photos only, shares in-flight requests and keeps URLs after text changes',async()=>{const a=await app({observer:true});try{a.login();addPhotos(a);const requests=[];let concurrent=0,peak=0;a.w.fetch=async url=>{requests.push(url);concurrent++;peak=Math.max(peak,concurrent);await new Promise(r=>setTimeout(r,5));concurrent--;return servePhoto(url)};await a.run('restoreSession()');assert.equal(requests.length,0);a.visible([0,1]);await Promise.all([a.run('hydratePrivatePhotos()'),a.run('hydratePrivatePhotos()')]);await a.idle();assert.equal(requests.filter(u=>u.includes('part=')).length,2);assert(peak<=2);const img=a.w.document.querySelector('img[data-media-key]'),count=requests.length;a.rows.daily_checkins[0]={...a.rows.daily_checkins[0],content:'new text'};await a.run('loadDailyCheckins()');await a.idle();assert.equal(a.w.document.querySelector('img[data-media-key]'),img);assert.equal(requests.length,count);assert.equal(a.revoked.length,0)}finally{a.close()}});
test('focus restoration during photo download resumes without a late-response loss',async()=>{const a=await app({observer:true});try{a.login();addPhotos(a,1);const version=createHash('sha256').update(Buffer.alloc(5)).digest('hex');let finish;a.w.fetch=async(url,options)=>String(url)==='/api/photo-meta'?serveBatch(options,{version}):url.includes('meta=1')?servePhoto(url,version):new Promise(r=>finish=()=>r(servePhoto(url,version)));await a.run('restoreSession()');a.visible([0]);while(!finish)await new Promise(r=>setTimeout(r,5));await a.run('restoreSession()');finish();await a.idle();assert.equal(a.w.document.querySelector('img[data-media-key]').src,'blob:test');assert.equal(a.w.document.querySelector('.photo-retry'),null)}finally{a.close()}});
test('a new page uses persistent cached bytes after authorization; unsigned users never display cache',async()=>{const factory=new IDBFactory();let downloads=0;async function page(signedIn){const a=await app({observer:true,cacheFactory:factory});addPhotos(a,1);a.w.fetch=async url=>{if(url.includes('part='))downloads++;return servePhoto(url)};if(signedIn)a.login();await a.run('restoreSession()');if(signedIn){a.visible([0]);await a.idle();assert(a.w.document.querySelector('[data-media-key]').hasAttribute('src'))}else{assert(a.w.document.getElementById('privateApp').hidden);assert.equal(a.w.document.querySelector('[data-media-key]'),null)}a.close();}await page(true);assert.equal(downloads,1);await page(false);await page(true);assert.equal(downloads,1)});
test('ten visible cache hits use one metadata batch and download no photo bodies',async()=>{const a=await app({observer:true});try{
 a.login();addPhotos(a,10);const version='a'.repeat(64),ticket=await a.run('photoCache.ticket()');for(let i=0;i<10;i++)await a.run(`photoCache.put({id:'${A}|r2:daily/key${i}:thumbnail|${version}|original',account:'${A}',ref:'r2:daily/key${i}:thumbnail',version:'${version}',mime:'image/webp'},new Blob([new Uint8Array(5)],{type:'image/webp'}),${ticket})`);
 let batches=0,bodies=0;a.w.fetch=async(url,options)=>{if(String(url)==='/api/photo-meta'){batches++;return serveBatch(options,{version});}if(String(url).includes('part='))bodies++;throw Error('unexpected individual photo request')};await a.run('restoreSession()');a.visible([...Array(10).keys()]);await a.idle();const metrics=a.run('getPhotoLoadMetrics()');
 assert.equal(batches,1);assert.equal(bodies,0);assert.equal(metrics.metaRequests,1);assert.equal(metrics.metaItems,10);assert.equal(metrics.cacheHits,10);assert.equal(metrics.bodyRequests,0);assert.equal(a.w.document.querySelectorAll('img[src="blob:test"]').length,10);
}finally{await a.close()}});
test('a cold thumbnail uses batched metadata then the existing verified body path',async()=>{const a=await app({observer:true});try{
 a.login();addPhotos(a,1);const version=createHash('sha256').update(Buffer.alloc(5)).digest('hex');let batches=0,bodies=0,individualMeta=0;a.w.fetch=async(url,options)=>{if(String(url)==='/api/photo-meta'){batches++;return serveBatch(options,{version});}if(String(url).includes('meta=1'))individualMeta++;if(String(url).includes('part='))bodies++;return servePhoto(url,version)};
 await a.run('restoreSession()');a.visible([0]);await a.idle();const metrics=a.run('getPhotoLoadMetrics()');assert.equal(batches,1);assert.equal(individualMeta,0);assert.equal(bodies,1);assert.equal(metrics.cacheMisses,1);assert.equal(metrics.bodyBytes,5);assert.equal(a.w.document.querySelector('[data-media-key]').src,'blob:test');
}finally{await a.close()}});
test('one changed and one denied batch item do not disturb another valid cached photo',async()=>{const a=await app({observer:true});try{
 a.login();addPhotos(a,3);const oldBytes=Buffer.alloc(5,1),oldVersion=createHash('sha256').update(oldBytes).digest('hex'),newVersion=createHash('sha256').update(Buffer.alloc(5)).digest('hex'),ticket=await a.run('photoCache.ticket()');for(let i=0;i<3;i++)await a.run(`photoCache.put({id:'${A}|r2:daily/key${i}:thumbnail|${oldVersion}|original',account:'${A}',ref:'r2:daily/key${i}:thumbnail',version:'${oldVersion}',mime:'image/webp'},new Blob([new Uint8Array([1,1,1,1,1])],{type:'image/webp'}),${ticket})`);
 let bodies=0;a.w.fetch=async(url,options)=>{
  if(String(url)==='/api/photo-meta'){
   const {items}=JSON.parse(options.body),results=items.map(item=>{
    if(item.key.endsWith('key1'))return {key:item.key,requested_variant:item.variant,status:'unavailable'};
    const version=item.key.endsWith('key0')?newVersion:oldVersion;return {key:item.key,requested_variant:item.variant,status:'available',size:5,type:'image/webp',version,sha256:version,variant:'thumbnail',source_version:version};
   });return {ok:true,json:async()=>({results})};
  }
  if(String(url).includes('part=')){bodies++;return servePhoto(url,newVersion)}throw Error('unexpected request');
 };
 await a.run('restoreSession()');a.visible([0,1,2]);await a.idle();const images=[...a.w.document.querySelectorAll('[data-media-key]')];assert.equal(images[0].src,'blob:test');assert.equal(images[1].hasAttribute('src'),false);assert.equal(images[1].dataset.photoState,'error');assert.equal(images[2].src,'blob:test');assert.equal(bodies,1);assert.equal((await a.run('photoCache.stats()')).count,2);
}finally{await a.close()}});
test('a late metadata batch cannot restore photos after logout and account switch',async()=>{const a=await app({observer:true});try{
 a.login();addPhotos(a,1);let release;a.w.fetch=async(url,options)=>String(url)==='/api/photo-meta'?new Promise(resolve=>release=()=>resolve(serveBatch(options))):servePhoto(url);await a.run('restoreSession()');a.visible([0]);await eventually(()=>release);
 await a.run('logout()');a.login(B);const version=createHash('sha256').update(Buffer.alloc(5)).digest('hex');a.w.fetch=async(url,options)=>String(url)==='/api/photo-meta'?serveBatch(options,{version}):servePhoto(url,version);await a.run('restoreSession()');a.visible([0]);await a.idle();release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(a.run('currentProfile.id'),B);assert.equal(a.w.document.querySelector('[data-media-key]').src,'blob:test');
}finally{await a.close()}});
test('photo version replacement and explicit record deletion invalidate persistent cache',async()=>{const a=await app();try{a.login();addPhotos(a,1);let version='v1',downloads=0;a.w.fetch=async url=>{if(url.includes('part='))downloads++;return servePhoto(url,version)};await a.run('restoreSession()');version='v2';await a.run('restoreSession()');assert.equal(downloads,2);assert.equal((await a.run('photoCache.stats()')).count,1);a.rows.daily_checkins=[];await a.run("forgetCachedPhoto('daily/key0')");assert.equal((await a.run('photoCache.stats()')).count,0)}finally{a.close()}});
test('the preserved historical spot photo has a read-only card',async()=>{const a=await app();try{a.login();a.rows.spot_checkins.push({id:A,spot_name:'old location',spot_date:'2026-01-01',created_at:'2026-01-01T00:00:00Z',photo_path:'old.jpg'});a.w.fetch=async url=>servePhoto(url);await a.run('restoreSession()');assert.match(a.w.document.getElementById('dailyList').textContent,/历史地点/);assert.equal(a.w.document.querySelector('[data-legacy-kind]').dataset.legacyKind,'spot');assert.equal(a.w.document.querySelector('[data-action]'),null)}finally{a.close()}});
test('failed photos keep retry controls through rerender and recover with unchanged records',async()=>{const a=await app();try{a.login();addPhotos(a,1);let healthy=false;a.w.fetch=async url=>url.includes('meta=1')||healthy?servePhoto(url):{ok:false,status:503,json:async()=>({error:'temporary outage',code:'MEDIA_SOURCE_UNAVAILABLE'})};await a.run('restoreSession()');assert(a.w.document.querySelector('.photo-retry'));a.rows.daily_checkins[0]={...a.rows.daily_checkins[0],content:'edit while unavailable'};await a.run('loadDailyCheckins()');assert(a.w.document.querySelector('.photo-retry'));healthy=true;await a.run('loadDailyCheckins()');assert.equal(a.w.document.querySelector('[data-media-key]').src,'blob:test');assert.equal(a.w.document.querySelector('.photo-retry'),null)}finally{a.close()}});

test('a failed record source leaves the other sources and their photos usable, including after focus restoration',async()=>{
 for(const table of ['spot_checkins','daily_checkins','daily_comments']){
  const sourceErrors={},a=await app({sourceErrors});
  try{
   a.login();addPhotos(a,1);a.rows.spot_checkins.push({id:'spot',spot_name:'old place',created_at:'2026-01-01',photo_path:'old.jpg'});a.w.fetch=async url=>servePhoto(url);
   await a.run('restoreSession()');
   sourceErrors[table]={message:'temporary outage',code:'UPSTREAM_NETWORK'};
   await a.run('restoreSession()');
   assert.equal(a.run('photoPaused'),false);assert(!a.w.document.getElementById('privateApp').hidden);
   assert.equal(a.w.document.querySelectorAll('.check-card').length,2);
   assert.equal(a.w.document.querySelector('.check-card img').src,'blob:test');
   const failureSelector=table==='daily_comments'?'.comment-load-error':'.record-source-error';
   await eventually(()=>a.w.document.querySelector(failureSelector),'missing failure notice for '+table);
   assert.match(a.w.document.querySelector(failureSelector).textContent,table==='spot_checkins'?/历史地点/:table==='daily_checkins'?/日常/:/评论/);
   delete sourceErrors[table];await a.run('loadDailyCheckins()');
   await eventually(()=>!a.w.document.querySelector(failureSelector),'stale failure notice for '+table);
   assert.equal(a.w.document.querySelectorAll('.check-card').length,2);assert.equal(a.w.document.querySelector('.record-source-error'),null);
  }finally{await a.close()}
 }
});

test('an initial historical source outage does not strand the list or photo queue',async()=>{
 const a=await app({sourceErrors:{spot_checkins:{message:'unavailable'}}});
 try{a.login();addPhotos(a,1);a.w.fetch=async url=>servePhoto(url);await a.run('restoreSession()');await eventually(()=>a.w.document.querySelector('[data-action="retry-spots"]'));assert.equal(a.run('photoPaused'),false);assert.equal(a.w.document.querySelector('[data-media-key]').src,'blob:test');assert(!a.w.document.querySelector('.loading'));}finally{await a.close()}
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
  assert(!a.w.document.getElementById('privateApp').hidden);assert.equal(a.w.document.querySelectorAll('.check-card').length,1);assert.equal(a.run('photoPaused'),false);assert(a.w.document.querySelector('.session-retry'));
  delete authErrors.session;await a.run('restoreSession()');assert.equal(a.run('photoPaused'),false);assert.equal(a.w.document.querySelector('.session-retry'),null);
  authErrors.session={code:'SESSION_INVALID',message:'expired'};await a.run('restoreSession()');assert(a.w.document.getElementById('privateApp').hidden);assert.equal(a.w.document.querySelector('.check-card'),null);
 }finally{await a.close()}
});
test('simultaneous focus restores share one in-flight session verification',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),a=await app({sourceDelays:{profiles:()=>gate}});
 try{
  a.login();const restoring=a.run('Promise.all([restoreSession(),restoreSession(),restoreSession()])');await eventually(()=>a.sessionChecks()===1);release();await restoring;assert.equal(a.sessionChecks(),1);assert(!a.w.document.getElementById('privateApp').hidden);
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
