import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {app,A,B} from './browser-harness.mjs';

const CHUNK=1048576;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const input=url=>new URL(url,'https://love.invalid');
const partOf=url=>input(url).searchParams.has('part')?Number(input(url).searchParams.get('part')):null;
function image(url,bytes,version=hash(bytes),sha256=hash(bytes)){
 const part=partOf(url);
 if(part===null)return Response.json({size:bytes.length,type:'image/jpeg',version,sha256});
 const start=part*CHUNK,end=Math.min(start+CHUNK,bytes.length);
 return new Response(bytes.subarray(start,end),{status:206,headers:{'Content-Type':'image/jpeg','Content-Range':`bytes ${start}-${end-1}/${bytes.length}`,'X-Media-Version':version}});
}
const outage=(status=503,extra={})=>Response.json({code:status===429?'MEDIA_SOURCE_RATE_LIMITED':'MEDIA_SOURCE_UNAVAILABLE',error:'synthetic outage'},{status,headers:extra});
async function page(options={}){
 const a=await app({observer:true,...options});Object.defineProperty(a.w.crypto,'subtle',{value:webcrypto.subtle});
 a.login();a.rows.daily_checkins.push({id:'photo',author_id:A,content:'transfer sample',photo_key:'daily/test',created_at:'2026-10-13'});return a;
}
async function start(a){await a.run('restoreSession()');a.visible([0]);await a.idle();}
async function retry(a){const button=a.w.document.querySelector('.photo-retry');assert(button);button.click();await a.idle();}
const ready=a=>assert.equal(a.w.document.querySelector('[data-media-key]').getAttribute('src'),'blob:test');

const originalSource=readFileSync('assets/media.js','utf8').replaceAll("img.dataset.photoVariant==='thumbnail'",'false');
const originalPage=options=>page({mediaSource:originalSource,...options});
function negotiatedImage(url,bytes,partSize,{old=false}={}){
 const query=input(url).searchParams,version=hash(bytes);
 if(!query.has('part'))return Response.json({size:bytes.length,type:'image/jpeg',version,sha256:version,variant:'original',...old?{}:{part_size:partSize}});
 const size=Number(query.get('part_size')||CHUNK),start=Number(query.get('part'))*size,end=Math.min(start+size,bytes.length);
 return new Response(bytes.subarray(start,end),{status:206,headers:{'Content-Type':'image/jpeg','Content-Range':`bytes ${start}-${end-1}/${bytes.length}`,'X-Media-Version':version}});
}

test('negotiated original boundaries assemble and hash identically at 1/2/3MiB, then reuse the same full cache',async()=>{
 for(const size of [CHUNK,2*CHUNK,3*CHUNK])for(const length of [size,size+1,6*CHUNK]){
  const a=await originalPage(),bytes=Buffer.alloc(length,31),parts=[];let chosen=size;
  try{
   a.w.fetch=async url=>{if(partOf(url)!==null){assert.equal(Number(input(url).searchParams.get('part_size')),chosen);parts.push(partOf(url));}return negotiatedImage(url,bytes,chosen);};
   await start(a);ready(a);assert.deepEqual(parts,Array.from({length:Math.ceil(length/size)},(_,i)=>i));
   assert.equal((await a.run('photoCache.stats()')).count,1);const cached=await a.run('photoCache.get([...photoJobs.values()][0].cacheId)');assert.equal(hash(Buffer.from(await cached.blob.arrayBuffer())),hash(bytes));
   chosen=size===CHUNK?3*CHUNK:CHUNK;const before=parts.length;
   a.run('pausePhotoLoads();resumePhotoLoads(currentProfile.id)');await a.idle();ready(a);assert.equal(parts.length,before);assert.equal(a.w.getPhotoLoadMetrics().cacheHits,1);
  }finally{await a.close();}
 }
});

test('same-size retries reuse complete parts; changing negotiated size discards incompatible partial bytes',async()=>{
 for(const changed of [false,true]){
  const a=await originalPage(),bytes=Buffer.alloc(6*CHUNK,13),parts=[];let size=2*CHUNK,healthy=false;
  try{
   a.w.fetch=async url=>{const part=partOf(url);if(part!==null)parts.push([Number(input(url).searchParams.get('part_size')),part]);return part===1&&!healthy?outage():negotiatedImage(url,bytes,size);};
   await start(a);assert.deepEqual(parts,[[size,0],[size,1],[size,1],[size,1]]);assert.equal(a.run('[...photoJobs.values()][0].partial.part_size'),size);
   healthy=true;if(changed)size=3*CHUNK;await retry(a);ready(a);
   assert.deepEqual(parts.slice(4),changed?[[size,0],[size,1]]:[[size,1],[size,2]]);assert.equal((await a.run('photoCache.stats()')).count,1);
  }finally{await a.close();}
 }
});

test('a new client defaults old metadata to 1MiB and rejects invalid advertised part sizes before body downloads',async()=>{
 for(const advertised of [undefined,0,1048577,'2097152',NaN]){
  const a=await originalPage(),bytes=Buffer.alloc(CHUNK+1,7),parts=[];
  try{
   a.w.fetch=async url=>{if(partOf(url)===null){const meta={size:bytes.length,type:'image/jpeg',version:hash(bytes),sha256:hash(bytes),variant:'original'};if(advertised!==undefined)meta.part_size=advertised;return Response.json(meta);}parts.push(partOf(url));assert.equal(input(url).searchParams.get('part_size'),String(CHUNK));return negotiatedImage(url,bytes,CHUNK,{old:true});};
   await start(a);if(advertised===undefined){ready(a);assert.deepEqual(parts,[0,1]);}else{assert.deepEqual(parts,[]);assert.equal((await a.run('photoCache.stats()')).count,0);}
  }finally{await a.close();}
 }
});

test('larger originals reject wrong MIME, range, version and hash; truncated responses retry without caching bad bytes',async()=>{
 for(const fault of ['mime','range','version','hash','truncated']){
  const a=await originalPage(),bytes=Buffer.alloc(3*CHUNK+1,19);let failures=0,bodies=0;
  try{
   a.w.fetch=async url=>{
    const r=negotiatedImage(url,bytes,3*CHUNK);if(partOf(url)===null)return r;bodies++;
    if(fault==='mime')r.headers.set('Content-Type','text/html');
    if(fault==='range')r.headers.set('Content-Range',`bytes 0-${CHUNK-1}/${bytes.length}`);
    if(fault==='version')r.headers.set('X-Media-Version','b'.repeat(64));
    if(fault==='hash'){const b=new Uint8Array(await r.arrayBuffer());b[0]^=1;return new Response(b,{status:206,headers:r.headers});}
    if(fault==='truncated'&&failures++===0)return new Response(new Uint8Array(1),{status:206,headers:r.headers});return r;
   };
   await start(a);if(fault==='truncated'){ready(a);assert.equal(bodies,3);}else{assert.equal((await a.run('photoCache.stats()')).count,0);assert.equal(a.run('[...photoJobs.values()][0].partial'),null);assert(a.w.document.querySelector('.photo-retry'));}
  }finally{await a.close();}
 }
});

test('logout while a 3MiB body is in flight aborts it; another account cannot receive its late bytes',async()=>{
 const a=await originalPage(),bytes=Buffer.alloc(3*CHUNK+1,11),parts=[];let release,aborted=false;
 try{
  a.w.fetch=async(url,options)=>{const part=partOf(url);if(part===null)return negotiatedImage(url,bytes,3*CHUNK);parts.push(part);if(part===0)return new Promise(resolve=>{release=()=>resolve(negotiatedImage(url,bytes,3*CHUNK));options.signal.addEventListener('abort',()=>{aborted=true;},{once:true});});throw Error('No second part after logout');};
  await a.run('restoreSession()');a.visible([0]);for(let i=0;!release&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));assert(release);
  await a.run('logout()');assert(aborted);a.login(B);release();await a.idle();assert.deepEqual(parts,[0]);assert.equal(a.run('photoJobs.size'),0);assert.equal((await a.run('photoCache.stats()')).count,0);
  a.w.fetch=async url=>{if(partOf(url)!==null)parts.push(partOf(url));return negotiatedImage(url,bytes,3*CHUNK);};await start(a);ready(a);assert.deepEqual(parts,[0,0,1]);
 }finally{await a.close();}
});

test('larger parts retain two-photo concurrency, serial per-photo requests and the unchanged partial budget',async()=>{
 for(const size of [2*CHUNK,3*CHUNK]){
  const a=await originalPage(),bytes=Buffer.alloc(10*CHUNK,17),active=new Set();let peak=0;
  try{
   a.rows.daily_checkins.push({id:'second',author_id:A,content:'second original',photo_key:'daily/second',created_at:'2026-10-13'});
   a.w.fetch=async url=>{
    if(partOf(url)===null)return negotiatedImage(url,bytes,size);
    const key=input(url).searchParams.get('key');assert(!active.has(key),'same photo must not overlap');active.add(key);peak=Math.max(peak,active.size);
    await new Promise(resolve=>setTimeout(resolve,5));active.delete(key);
    return partOf(url)===Math.ceil(bytes.length/size)-1?outage():negotiatedImage(url,bytes,size);
   };
   await a.run('restoreSession()');a.visible([0,1]);await a.idle();assert.equal(peak,2);
   assert.equal(a.run('PHOTO_PARTIAL_LIMIT'),40*CHUNK);assert(a.run('[...photoJobs.values()].reduce((n,j)=>n+(j.partial?.bytes||0),0)')<=40*CHUNK);
   assert.equal((await a.run('photoCache.stats()')).count,0);
  }finally{await a.close();}
 }
});

test('3MiB keeps the existing timeout, retry and Retry-After budgets',async()=>{
 const bytes=Buffer.alloc(3*CHUNK+1,23),parts=[];let timeoutNext=false,stalled=false;
 const a=await originalPage({timers:(fn,ms)=>ms===45000&&timeoutNext?(timeoutNext=false,setTimeout(fn,0)):ms>0&&ms<=5000?setTimeout(fn,0):0});
 try{
  a.w.fetch=async(url,options)=>{const part=partOf(url);if(part!==null)parts.push(part);if(part===0)timeoutNext=true;if(part===1&&!stalled){stalled=true;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('synthetic timeout')),{once:true}));}return negotiatedImage(url,bytes,3*CHUNK);};
  await start(a);ready(a);assert.deepEqual(parts,[0,1,1]);assert.equal(a.run('PHOTO_REQUEST_TIMEOUT'),45000);assert.equal(a.run('PHOTO_JOB_TIMEOUT'),600000);
 }finally{await a.close();}
 const b=await originalPage();let tries=0;
 try{b.w.fetch=async url=>partOf(url)!==null&&++tries?outage(429,{'Retry-After':'60'}):negotiatedImage(url,bytes,3*CHUNK);await start(b);assert.equal(tries,1);assert(b.w.document.querySelector('.photo-retry'));}finally{await b.close();}
});

test('a transient failed segment retries in place and produces a verified complete image',async()=>{
 const bytes=Buffer.alloc(2*CHUNK+13,37),version=hash(bytes),a=await page(),parts=[];let metadata=0,failed=false;
 try{
  a.w.fetch=async(url,options)=>{
   assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.match(url,/^\/api\/photo\?/);
   const part=partOf(url);if(part===null)metadata++;else{assert.equal(input(url).searchParams.get('version'),version);parts.push(part);}
   if(part===1&&!failed){failed=true;return outage();}return image(url,bytes);
  };
  await start(a);ready(a);assert.deepEqual(parts,[0,1,1,2]);assert.equal(metadata,1);assert.equal((await a.run('photoCache.stats()')).count,1);
  assert.equal(a.run('[...photoJobs.values()][0].partial'),null);
 }finally{await a.close();}
});

test('bounded automatic retries preserve completed segments for a reauthorized manual retry',async()=>{
 const bytes=Buffer.alloc(2*CHUNK+13,18),a=await page(),parts=[];let healthy=false,metadata=0;
 try{
  a.w.fetch=async url=>{const part=partOf(url);if(part===null)metadata++;else parts.push(part);return part===1&&!healthy?outage():image(url,bytes);};
  await start(a);assert.deepEqual(parts,[0,1,1,1]);assert.equal((await a.run('photoCache.stats()')).count,0);
  healthy=true;await retry(a);ready(a);assert.deepEqual(parts,[0,1,1,1,1,2]);assert.equal(metadata,3); // one failed batch probe plus two individual metadata reads
 }finally{await a.close();}
});

test('manual resume discards completed segments when fresh metadata changes the version',async()=>{
 let bytes=Buffer.alloc(CHUNK+7,17),healthy=false;const a=await page(),parts=[];
 try{
  a.w.fetch=async url=>{const part=partOf(url);if(part!==null)parts.push(part);return part===1&&!healthy?outage():image(url,bytes);};
  await start(a);bytes=Buffer.alloc(CHUNK+7,39);healthy=true;await retry(a);ready(a);
  assert.deepEqual(parts,[0,1,1,1,0,1]);assert.equal((await a.run('photoCache.stats()')).count,1);
 }finally{await a.close();}
});

test('version and range mismatches discard partial bytes and do not automatically retry',async()=>{
 for(const mismatch of ['version','range']){
  const bytes=Buffer.alloc(CHUNK+7,13),a=await page(),parts=[];
  try{
   a.w.fetch=async url=>{
    const part=partOf(url);if(part!==null)parts.push(part);const r=image(url,bytes);
    if(part===1)r.headers.set(mismatch==='version'?'X-Media-Version':'Content-Range',mismatch==='version'?'b'.repeat(64):`bytes 0-6/${bytes.length}`);
    return r;
   };
   await start(a);assert.deepEqual(parts,[0,1]);assert.equal(a.run('[...photoJobs.values()][0].partial'),null);assert.equal((await a.run('photoCache.stats()')).count,0);
   a.w.fetch=async url=>{const part=partOf(url);if(part!==null)parts.push(part);return image(url,bytes);};await retry(a);ready(a);assert.deepEqual(parts,[0,1,0,1]);
  }finally{await a.close();}
 }
});

test('truncated bytes retry the failed segment, while a final hash mismatch drops all partial bytes',async()=>{
 const bytes=Buffer.alloc(CHUNK+7,71),a=await page(),parts=[];let truncated=false;
 try{
  a.w.fetch=async url=>{
   const part=partOf(url);if(part!==null)parts.push(part);const r=image(url,bytes);
   if(part===1&&!truncated){truncated=true;return new Response(new Uint8Array(2),{status:206,headers:r.headers});}return r;
  };
  await start(a);ready(a);assert.deepEqual(parts,[0,1,1]);
 }finally{await a.close();}
 const b=await page();
 try{b.w.fetch=async url=>image(url,bytes,'a'.repeat(64),'a'.repeat(64));await start(b);assert.equal((await b.run('photoCache.stats()')).count,0);assert.equal(b.run('[...photoJobs.values()][0].partial'),null);assert.match(b.w.document.querySelector('img[data-media-key]').alt,/MEDIA_HASH_MISMATCH/);}finally{await b.close();}
});

test('a per-request timeout retries a stalled segment without losing an earlier segment',async()=>{
 const bytes=Buffer.alloc(CHUNK+7,23),parts=[];let timeoutNext=false,stalled=false;
 const a=await page({timers:(fn,ms)=>ms===45000&&timeoutNext?(timeoutNext=false,setTimeout(fn,0)):ms>0&&ms<=5000?setTimeout(fn,0):0});
 try{
  a.w.fetch=async(url,options)=>{
   const part=partOf(url);if(part!==null)parts.push(part);
   if(part===0)timeoutNext=true;
   if(part===1&&!stalled){stalled=true;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('synthetic timeout')),{once:true}));}
   return image(url,bytes);
  };
  await start(a);ready(a);assert.deepEqual(parts,[0,1,1]);
 }finally{await a.close();}
});

test('Retry-After controls backoff and long limits do not trigger an early automatic retry',async()=>{
 for(const seconds of [2,60]){
  const delays=[],bytes=Buffer.alloc(7,11),a=await page({timers:(fn,ms)=>{if(ms>0&&ms<=5000){delays.push(ms);return setTimeout(fn,0);}return 0;}});let tries=0;
  try{
   a.w.fetch=async url=>partOf(url)!==null&&++tries===1?outage(429,{'Retry-After':String(seconds)}):image(url,bytes);
   await start(a);
   if(seconds===2){ready(a);assert.equal(tries,2);assert.equal(delays[0],2000);}
   else{assert.equal(tries,1);assert.deepEqual(delays,[]);assert(a.w.document.querySelector('.photo-retry'));}
  }finally{await a.close();}
 }
});

test('permanent source denials do not retry and discard retained bytes',async()=>{
 for(const status of [401,403,404,412]){
  const bytes=Buffer.alloc(CHUNK+7,13),a=await page(),parts=[];
  try{a.w.fetch=async url=>{const part=partOf(url);if(part!==null)parts.push(part);return part===1?Response.json({code:status===412?'MEDIA_VERSION_CHANGED':'MEDIA_SOURCE_DENIED'},{status}):image(url,bytes);};await start(a);assert.deepEqual(parts,[0,1]);assert.equal(a.run('[...photoJobs.values()][0].partial'),null);}finally{await a.close();}
 }
});

test('logout during retry backoff cancels future requests and a different account starts from zero',async()=>{
 const bytes=Buffer.alloc(CHUNK+7,29),parts=[];let release;
 const a=await page({timers:(fn,ms)=>{if(ms>0&&ms<=5000){release=fn;}return 0;}});
 try{
  a.w.fetch=async url=>{const part=partOf(url);if(part!==null)parts.push(part);return part===1?outage():image(url,bytes);};
  await a.run('restoreSession()');a.visible([0]);for(let n=0;!release&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,5));assert(release);
  await a.run('logout()');release();await a.idle();assert.deepEqual(parts,[0,1]);assert.equal(a.run('photoJobs.size'),0);
  a.login(B);a.w.fetch=async url=>{const part=partOf(url);if(part!==null)parts.push(part);return image(url,bytes);};await start(a);ready(a);assert.deepEqual(parts,[0,1,0,1]);
 }finally{await a.close();}
});

test('clearing the cache or expiring partial bytes forces a fresh download',async()=>{
 for(const reason of ['clear','expire']){
  const bytes=Buffer.alloc(CHUNK+7,47),a=await page(),parts=[];let healthy=false;
  try{
   a.w.fetch=async url=>{const part=partOf(url);if(part!==null)parts.push(part);return part===1&&!healthy?outage():image(url,bytes);};await start(a);
   healthy=true;
   if(reason==='clear'){await a.run('clearLocalPhotoCache(false)');a.visible([0]);await a.idle();}
   else{a.run('Date.now=()=>'+(Date.now()+6*60*1000));await retry(a);}
   ready(a);assert.deepEqual(parts,[0,1,1,1,0,1]);
  }finally{await a.close();}
 }
});

test('retained partial downloads stay within 40MiB and evicted photos download again',async()=>{
 const a=await page(),parts=new Map(),chunk=Buffer.alloc(CHUNK,7),size=20*CHUNK;let healthy=false;
 try{
  a.rows.daily_checkins.push(...[1,2].map(n=>({id:'photo'+n,author_id:A,content:'large transfer',photo_key:'daily/test'+n,created_at:'2026-10-13'})));
  a.w.fetch=async url=>{
   const part=partOf(url),key=input(url).searchParams.get('key');
   if(part===null)return Response.json({size,type:'image/jpeg',version:'a'.repeat(64),resumable:true});
   const counts=parts.get(key)||[];counts.push(part);parts.set(key,counts);
   if(part===19&&!healthy)return outage();
   return new Response(chunk,{status:206,headers:{'Content-Type':'image/jpeg','Content-Range':`bytes ${part*CHUNK}-${(part+1)*CHUNK-1}/${size}`,'X-Media-Version':'a'.repeat(64)}});
  };
  await a.run('restoreSession()');a.visible([0,1,2]);await a.idle();
  assert.equal((await a.run('photoCache.stats()')).count,0);
  const retained=a.run('[...photoJobs.values()].reduce((n,job)=>n+(job.partial?.bytes||0),0)');assert(retained<=40*CHUNK);
  const evicted=a.run('[...photoJobs.values()].find(job=>!job.partial).ref.slice(3).replace(/:thumbnail$/, "")');assert(evicted);
  const before=parts.get(evicted).filter(part=>part===0).length;healthy=true;
  const img=[...a.w.document.querySelectorAll('[data-media-key]')].find(img=>img.dataset.mediaKey===evicted);img.nextElementSibling.click();await a.idle();
  assert.equal(parts.get(evicted).filter(part=>part===0).length,before+1);assert.equal(img.getAttribute('src'),'blob:test');
 }finally{await a.close();}
});

test('legacy sources without a strong validator restart rather than mix retained segments',async()=>{
 const bytes=Buffer.alloc(CHUNK+7,41),a=await page(),parts=[];let healthy=false;
 try{
  a.w.fetch=async url=>{
   const part=partOf(url);if(part===null)return Response.json({size:bytes.length,type:'image/jpeg',version:'a'.repeat(64),resumable:false});
   parts.push(part);return part===1&&!healthy?outage():image(url,bytes,'a'.repeat(64));
  };
  await start(a);assert.deepEqual(parts,[0,1]);assert.equal(a.run('[...photoJobs.values()][0].partial'),null);
  healthy=true;await retry(a);ready(a);assert.deepEqual(parts,[0,1,0,1]);
 }finally{await a.close();}
});
