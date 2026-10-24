const MEDIA_API='https://love-media-api.pancrasyang.workers.dev';
const mediaUrls=new Set(),mediaRequests=new Set();
async function mediaFetch(path,options={},epoch=authEpoch){
 if(!isCurrent(epoch))throw Error('请重新登录');
 const {data:{session},error}=await sb.auth.getSession();
 if(error||!session||!isCurrent(epoch)||session.user.id!==currentProfile.id)throw Error('请重新登录');
 const controller=new AbortController();mediaRequests.add(controller);
 try{
  const response=await fetch(MEDIA_API+path,{...options,cache:'no-store',signal:controller.signal,headers:{...options.headers,Authorization:`Bearer ${session.access_token}`}});
  if(!isCurrent(epoch))throw Error('登录状态已改变');
  if(!response.ok){const body=await response.json().catch(()=>({}));throw Error(body.error||'照片请求失败');}
  // Read body while the controller remains registered, including large downloads.
  const result=options.method==='DELETE'?null:options.method==='POST'?await response.json():await response.blob();
  if(!isCurrent(epoch))throw Error('登录状态已改变');return result;
 }finally{mediaRequests.delete(controller);}
}
async function uploadImage(file,recordId){
 if(!file)return {key:null};
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10*1024*1024)throw Error('请选择不超过 10MB 的 JPEG、PNG 或 WebP 照片。');
 return mediaFetch('/api/media',{method:'POST',headers:{'Content-Type':file.type,'X-Record-Id':recordId},body:file});
}
async function removeImage(key){if(key)await mediaFetch('/api/media/'+encodeURIComponent(key),{method:'DELETE'});}
async function prepareThumbnail(key,epoch=authEpoch){
 if(!key||!isCurrent(epoch))throw Error('请重新登录');const controller=new AbortController();mediaRequests.add(controller);
 try{
  let response;try{response=await fetch('/api/photo-thumbnail',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Love-Request':'1'},body:JSON.stringify({key}),signal:controller.signal});}catch{throw Error('缩略图生成连接失败');}
  const body=await response.json().catch(()=>({}));if(!isCurrent(epoch))throw Error('登录状态已改变');
  if(!response.ok){if(response.status===401&&isSessionFailure(body)){clearPrivateView();showRoleChoices();$('authMessage').textContent='登录已失效，请重新登录。';}throw Object.assign(Error(body.error||'缩略图生成失败'),{code:body.code,status:response.status});}
  if(body.status!=='ready'||!/^[a-f0-9]{64}$/.test(body.version||'')||!/^[a-f0-9]{64}$/.test(body.source_version||''))throw Error('缩略图响应异常');return body;
 }finally{mediaRequests.delete(controller);}
}
function refreshThumbnailPhoto(key){
 const job=photoJobs.get('r2:'+key+':thumbnail');if(!job||!photoLive(job))return;if(job.state==='loading'){job.refreshAfterLoad=true;return;}job.state='idle';job.meta=null;job.metaState='idle';job.batchFallback=false;job.compactFallback=false;job.thumbnailFallback=false;job.error=null;queuePhoto(job);pumpPhotos();
}
const photoCache=createLovePhotoCache();
async function forgetCachedPhoto(key){
 if(!currentProfile||!key)return;
 await photoCache.prune(currentProfile.id,{removeRefs:['r2:'+key,'r2:'+key+':thumbnail']});
}
const photoJobs=new Map(),photoBindings=new Map();
const PHOTO_CHUNK=1048576,PHOTO_PARTIAL_LIMIT=40*PHOTO_CHUNK,PHOTO_PARTIAL_TTL=5*60*1000;
const PHOTO_REQUEST_TIMEOUT=45000,PHOTO_JOB_TIMEOUT=10*60*1000;
let photoOwner=null,photoSerial=0,photoPaused=true,photoActive=0,photoQueue=[],photoWaiters=[],photoMetaSerial=0,photoMetaPending=new Set(),photoMetaScheduled=false,photoMetaController=null;
let photoLoadMetrics={startedAt:Date.now(),metaRequests:0,metaBatches:0,metaItems:0,bodyRequests:0,bodyBytes:0,cacheHits:0,cacheMisses:0,cacheWriteFailures:0,firstPhotoMs:null};
const resetPhotoMetrics=()=>{photoLoadMetrics={startedAt:Date.now(),metaRequests:0,metaBatches:0,metaItems:0,bodyRequests:0,bodyBytes:0,cacheHits:0,cacheMisses:0,cacheWriteFailures:0,firstPhotoMs:null};};
window.getPhotoLoadMetrics=()=>({...photoLoadMetrics});
const photoLive=job=>Boolean(currentProfile)&&currentProfile.id===job.owner&&job.serial===photoSerial&&photoJobs.get(job.ref)===job&&job.images.size>0;
function revokeMediaUrls(){mediaUrls.forEach(url=>URL.revokeObjectURL(url));mediaUrls.clear();}
function dropPhotoUrl(job){if(job.url){URL.revokeObjectURL(job.url);mediaUrls.delete(job.url);job.url=null;}job.blob=null;}
function trimPhotoPartials(){
 const retained=[];let bytes=0;
 for(const job of photoJobs.values()){
  if(!job.partial)continue;
  if(job.state!=='loading'&&Date.now()-job.partial.touched>PHOTO_PARTIAL_TTL){job.partial=null;continue;}
  bytes+=job.partial.bytes;if(job.state!=='loading')retained.push(job);
 }
 retained.sort((a,b)=>a.partial.touched-b.partial.touched);
 while(bytes>PHOTO_PARTIAL_LIMIT&&retained.length){const job=retained.shift();bytes-=job.partial.bytes;job.partial=null;}
}
function resetPhotoLoads(){
 photoSerial++;photoMetaSerial++;photoPaused=true;photoOwner=null;photoQueue=[];photoMetaPending.clear();photoMetaScheduled=false;photoMetaController?.abort();photoMetaController=null;
 photoJobs.forEach(job=>{job.controller?.abort();job.partial=null;dropPhotoUrl(job);});photoJobs.clear();
 photoBindings.forEach((job,img)=>photoObserver?.unobserve(img));photoBindings.clear();revokeMediaUrls();settlePhotoWaiters();
}
window.pausePhotoLoads=()=>{photoPaused=true;photoMetaSerial++;photoMetaPending.clear();photoMetaScheduled=false;photoMetaController?.abort();};
window.resumePhotoLoads=owner=>{
 if(photoOwner!==owner){resetPhotoLoads();photoOwner=owner;resetPhotoMetrics();}
 else if(photoPaused)photoJobs.forEach(job=>{if(['ready','error','aborted'].includes(job.state))job.state='idle';if(job.state!=='loading'){job.meta=null;job.metaState='idle';job.batchFallback=false;job.compactFallback=false;job.thumbnailFallback=false;}});
 photoPaused=false;photoJobs.forEach(job=>{if(job.state==='ready')showPhoto(job);else queuePhoto(job);});pumpPhotos();
};
function photoDescriptor(img){
 const kind=img.dataset.legacyKind||'daily';
 return img.dataset.mediaKey?{ref:'r2:'+img.dataset.mediaKey+(img.dataset.photoVariant==='thumbnail'?':thumbnail':''),query:'source=r2&key='+encodeURIComponent(img.dataset.mediaKey)+(img.dataset.photoVariant==='thumbnail'?'&variant=thumbnail':''),key:img.dataset.mediaKey,variant:img.dataset.photoVariant==='thumbnail'?'thumbnail':'original'}:{ref:'legacy:'+kind+':'+img.dataset.legacyId,query:'source=legacy&kind='+kind+'&id='+encodeURIComponent(img.dataset.legacyId)};
}
function photoError(code,message='照片暂时无法加载'){return Object.assign(new Error(message),{code});}
function retryablePhotoError(error){
 if(['MEDIA_NETWORK','MEDIA_REQUEST_TIMEOUT','MEDIA_TRUNCATED','MEDIA_SOURCE_TIMEOUT'].includes(error.code))return true;
 return [408,429,500,502,503,504].includes(error.status)&&!['MEDIA_RANGE_INVALID','MEDIA_METADATA','MEDIA_METADATA_MISMATCH','MEDIA_FORMAT','MEDIA_SIZE_LIMIT','MEDIA_EDGE_BLOCKED'].includes(error.code);
}
function photoRetryDelay(response){
 const value=response.headers?.get('Retry-After');if(!value)return 0;
 if(/^\d+$/.test(value))return Number(value)*1000;
 const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-Date.now()):0;
}
function waitForPhotoRetry(ms,signal){
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(photoError('MEDIA_ABORTED'));return;}
  const finish=()=>{signal.removeEventListener('abort',abort);resolve();};
  const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(photoError('MEDIA_ABORTED'));};
  const timer=setTimeout(finish,ms);signal.addEventListener('abort',abort,{once:true});
 });
}
async function photoRequest(query,controller){
 const parameters=new URLSearchParams(query);if(parameters.get('meta')==='1')photoLoadMetrics.metaRequests++;else if(parameters.has('part'))photoLoadMetrics.bodyRequests++;
 let response;
 try{response=await fetch('/api/photo?'+query,{credentials:'same-origin',cache:'no-store',signal:controller.signal});}
 catch(error){if(controller.signal.aborted)throw error;throw photoError('MEDIA_NETWORK','照片连接失败，请检查网络');}
 if(controller.signal.aborted)throw photoError('MEDIA_ABORTED');
 if(!response.ok){const body=await response.json().catch(()=>({}));if(controller.signal.aborted)throw photoError('MEDIA_ABORTED');if(response.status===401&&isSessionFailure(body)){clearPrivateView();showRoleChoices();$('authMessage').textContent='登录已失效，请重新登录。';}throw Object.assign(photoError(body.code||'MEDIA_HTTP_'+response.status,body.error||'照片请求失败'),{status:response.status,retryAfter:photoRetryDelay(response),requestId:body.request_id||response.headers?.get('X-Photo-Request-Id'),stage:body.stage});}
 return response;
}
function checkedClientMeta(meta){
 if(!meta||!Number.isInteger(meta.size)||meta.size<=0||meta.size>20*PHOTO_CHUNK||!['image/jpeg','image/png','image/webp'].includes(meta.type)||typeof meta.version!=='string'||!meta.version||meta.version.length>128||meta.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(meta.sha256)||meta.variant!==undefined&&!['original','thumbnail'].includes(meta.variant)||meta.source_version!==undefined&&!/^[a-f0-9]{64}$/.test(meta.source_version))throw photoError('MEDIA_METADATA');
 if(meta.variant==='thumbnail'&&(meta.type!=='image/webp'||meta.size>512*1024))throw photoError('MEDIA_METADATA');return meta;
}
async function photoStep(job,parent,query,read,{retry=true}={}){
 for(let attempt=0;;attempt++){
  if(!photoLive(job)||parent.signal.aborted)throw photoError('MEDIA_ABORTED');
  const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;
  parent.signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},PHOTO_REQUEST_TIMEOUT);
  let failure;
  try{
   const response=await photoRequest(query,controller),result=await read(response);
   if(controller.signal.aborted)throw photoError('MEDIA_ABORTED');
   if(!photoLive(job))throw photoError('MEDIA_ABORTED');
   return result;
  }catch(error){failure=timedOut&&!parent.signal.aborted?photoError('MEDIA_REQUEST_TIMEOUT','照片分段读取超时，请重试'):error;}
  finally{clearTimeout(timer);parent.signal.removeEventListener('abort',abort);}
  if(!photoLive(job)||parent.signal.aborted)throw photoError('MEDIA_ABORTED');
  // Long Retry-After values are left for a later user retry, never shortened.
  if(!retry||attempt>=2||!retryablePhotoError(failure)||failure.retryAfter>5000)throw failure;
  const delay=Math.max(500*2**attempt+Math.floor(Math.random()*250),failure.retryAfter||0);
  await waitForPhotoRetry(delay,parent.signal);
 }
}
function schedulePhotoMeta(job){
 if(photoPaused||!photoLive(job)||job.meta||job.batchFallback||job.metaState==='queued'||job.metaState==='loading')return;
 job.metaState='queued';photoMetaPending.add(job);
 if(!photoMetaScheduled){photoMetaScheduled=true;Promise.resolve().then(flushPhotoMeta);}
}
async function flushPhotoMeta(){
 photoMetaScheduled=false;if(photoPaused||photoMetaController)return;
 const jobs=[];for(const job of photoMetaPending){photoMetaPending.delete(job);if(photoLive(job)&&job.state==='idle'&&[...job.images].some(img=>img.isConnected&&img._photoVisible)){job.metaState='loading';jobs.push(job);}if(jobs.length===20)break;}
 if(!jobs.length){settlePhotoWaiters();return;}
 const serial=photoMetaSerial,controller=new AbortController();photoMetaController=controller;mediaRequests.add(controller);photoLoadMetrics.metaRequests++;photoLoadMetrics.metaBatches++;photoLoadMetrics.metaItems+=jobs.length;
 try{
  let response;try{response=await fetch('/api/photo-meta',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Love-Request':'1'},body:JSON.stringify({items:jobs.map(job=>({key:job.key,variant:job.variant}))}),signal:controller.signal});}catch{throw photoError('MEDIA_NETWORK','照片版本核验连接失败');}
  if(!response.ok){const body=await response.json().catch(()=>({}));if(response.status===401&&isSessionFailure(body)&&serial===photoMetaSerial){clearPrivateView();showRoleChoices();$('authMessage').textContent='登录已失效，请重新登录。';}throw Object.assign(photoError(body.code||'MEDIA_HTTP_'+response.status,body.error||'照片版本核验失败'),{status:response.status});}
  const data=await response.json(),results=Array.isArray(data?.results)?data.results:null;if(!results||results.length!==jobs.length)throw photoError('MEDIA_METADATA');
  const byPair=new Map();for(const result of results){const pair=result?.key+'\0'+result?.requested_variant;if(byPair.has(pair))throw photoError('MEDIA_METADATA');byPair.set(pair,result);}
  for(const job of jobs){
   if(serial!==photoMetaSerial||!photoLive(job))continue;
   const result=byPair.get(job.key+'\0'+job.variant);
   if(result?.status==='available'){
    const meta=checkedClientMeta(result);if(meta.variant!==job.variant)throw photoError('MEDIA_METADATA');job.meta=meta;job.metaState='ready';job.batchFallback=false;job.compactFallback=false;queuePhoto(job);
   }else if(result?.status==='unavailable'){
    job.metaState='error';job.state='error';dropPhotoUrl(job);for(const img of job.images)img.removeAttribute('src');await photoCache.prune(job.owner,{removeRefs:[job.ref,job.ref.replace(/:thumbnail$/,'')]});showPhotoFailure(job,photoError('MEDIA_NOT_FOUND','照片不存在或已无权访问'));
   }else if(result?.status==='pending'||result?.status==='error'){
    job.metaState='idle';job.batchFallback=true;job.compactFallback=result.status==='error'&&result.code==='MEDIA_SOURCE_UNAVAILABLE'&&job.variant==='thumbnail';queuePhoto(job);
   }else throw photoError('MEDIA_METADATA');
  }
 }catch(error){
  for(const job of jobs)if(serial===photoMetaSerial&&photoLive(job)&&job.metaState==='loading'){job.metaState='idle';job.batchFallback=true;job.compactFallback=job.variant==='thumbnail'&&['MEDIA_SOURCE_UNAVAILABLE','MEDIA_HTTP_503'].includes(error.code);queuePhoto(job);}
 }finally{
  mediaRequests.delete(controller);if(photoMetaController===controller)photoMetaController=null;
  if(photoMetaPending.size&&!photoPaused&&!photoMetaScheduled){photoMetaScheduled=true;Promise.resolve().then(flushPhotoMeta);}pumpPhotos();settlePhotoWaiters();
 }
}
async function readCompactThumbnail(job,controller,ticket){
 return photoStep(job,controller,job.query+'&part=0&compact=1',async response=>{
  const range=response.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/),version=response.headers.get('X-Media-Version'),sourceVersion=response.headers.get('X-Media-Source-Version'),sha256=response.headers.get('X-Media-Sha256'),type=(response.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
  const meta=checkedClientMeta({size:Number(range?.[3]),type,version,sha256,variant:response.headers.get('X-Media-Variant'),source_version:sourceVersion});
  if(meta.variant!=='thumbnail'||meta.size>512*1024||meta.version!==meta.sha256||Number(range?.[1])!==0||Number(range?.[2])!==meta.size-1)throw photoError('MEDIA_METADATA');
  let bytes;try{bytes=await response.arrayBuffer();}catch{throw photoError('MEDIA_TRUNCATED','照片传输中断，请重试');}photoLoadMetrics.bodyBytes+=bytes.byteLength;
  if(bytes.byteLength!==meta.size)throw photoError('MEDIA_TRUNCATED');const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==meta.sha256)throw photoError('MEDIA_HASH_MISMATCH');
  const blob=new Blob([bytes],{type:meta.type}),id=job.owner+'|'+job.ref+'|'+meta.version+'|original';if(!photoLive(job))throw photoError('MEDIA_ABORTED');if(!await photoCache.put({id,account:job.owner,ref:job.ref,version:meta.version,mime:meta.type},blob,ticket))photoLoadMetrics.cacheWriteFailures++;job.meta=meta;job.partial=null;return {blob,id};
 },{retry:true});
}
async function readPhoto(job,controller){
 const ticket=await photoCache.ticket();
 if(!job.meta&&job.compactFallback&&job.variant==='thumbnail'){
  photoLoadMetrics.cacheMisses++;try{return await readCompactThumbnail(job,controller,ticket);}catch(error){if(!['MEDIA_VERSION_CHANGED','MEDIA_VARIANT_NOT_FOUND','MEDIA_NOT_FOUND'].includes(error.code))throw error;job.compactFallback=false;photoLoadMetrics.cacheMisses--;}
 }
 const meta=checkedClientMeta(job.meta||await photoStep(job,controller,job.query+'&meta=1',async response=>{try{return await response.json();}catch{throw photoError('MEDIA_METADATA');}}));job.meta=meta;job.thumbnailFallback=job.variant==='thumbnail'&&meta.variant==='original';
 if(!photoLive(job))throw photoError('MEDIA_ABORTED');
 // Explicit original fallback reuses the existing original cache namespace.
 const cacheRef=meta.variant==='original'?job.ref.replace(/:thumbnail$/,''):job.ref;
 const id=job.owner+'|'+cacheRef+'|'+meta.version+'|original';job.meta=meta;
 const resumable=Boolean(meta.sha256&&/^[a-f0-9]{64}$/.test(meta.sha256))||meta.resumable===true;
 const cached=await photoCache.get(id);
 if(cached&&photoLive(job)&&cached.blob.size===meta.size&&cached.blob.type===meta.type){photoLoadMetrics.cacheHits++;job.partial=null;return {blob:cached.blob,id};}
 photoLoadMetrics.cacheMisses++;if(cached)await photoCache.remove(id);
 trimPhotoPartials();
 const signature=JSON.stringify([id,meta.size,meta.type,meta.sha256||null]);
 if(!resumable||!job.partial||job.partial.signature!==signature||Date.now()-job.partial.touched>PHOTO_PARTIAL_TTL)job.partial={signature,resumable,parts:[],bytes:0,touched:Date.now()};
 const partial=job.partial;partial.touched=Date.now();
 for(let start=partial.bytes,part=partial.parts.length;start<meta.size;start+=PHOTO_CHUNK,part++){
  const data=await photoStep(job,controller,(meta.variant==='original'?job.query.replace('&variant=thumbnail',''):job.query)+'&part='+part+'&version='+encodeURIComponent(meta.version),async r=>{
   const range=r.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
   if(r.headers.get('X-Media-Version')!==meta.version){try{await r.body?.cancel();}catch{}throw photoError('MEDIA_VERSION_CHANGED','照片已更新，请重试');}
   if(!range||Number(range[1])!==start||Number(range[2])!==Math.min(start+PHOTO_CHUNK-1,meta.size-1)||Number(range[3])!==meta.size){try{await r.body?.cancel();}catch{}throw photoError('MEDIA_RANGE_INVALID');}
   let bytes;try{bytes=await r.arrayBuffer();}catch{throw photoError('MEDIA_TRUNCATED','照片传输中断，请重试');}photoLoadMetrics.bodyBytes+=bytes.byteLength;
   if(bytes.byteLength!==Number(range[2])-start+1)throw photoError('MEDIA_TRUNCATED');return bytes;
  },{retry:resumable||start===0});
  partial.parts.push(data);partial.bytes+=data.byteLength;partial.touched=Date.now();trimPhotoPartials();
 }
 const blob=new Blob(partial.parts,{type:meta.type});
 if(meta.sha256){const bytes=await blob.arrayBuffer();const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==meta.sha256)throw photoError('MEDIA_HASH_MISMATCH');}
 if(!photoLive(job))throw photoError('MEDIA_ABORTED');
 if(!await photoCache.put({id,account:job.owner,ref:cacheRef,version:meta.version,mime:meta.type},blob,ticket))photoLoadMetrics.cacheWriteFailures++;
 job.partial=null;
 return {blob,id};
}
function showPhoto(job){
 if(photoPaused||!photoLive(job)||!job.blob)return;
 if(!job.url){job.url=URL.createObjectURL(job.blob);mediaUrls.add(job.url);}
 for(const img of job.images){if(!img.isConnected||!img._photoVisible)continue;img.src=job.url;img.alt=job.thumbnailFallback?'日常照片（缩略图暂不可用，已显示原图）':'日常照片';img.dataset.photoState='ready';img.nextElementSibling?.classList.contains('photo-retry')&&img.nextElementSibling.remove();
  let note=img.nextElementSibling?.classList.contains('thumbnail-fallback')?img.nextElementSibling:null;if(!job.thumbnailFallback){note?.remove();}else if(!note){note=document.createElement('button');note.type='button';note.className='ghost small-button thumbnail-fallback';note.textContent='已回退原图 · 重试缩略图';note.onclick=()=>{note.remove();job.state='idle';job.meta=null;job.metaState='idle';job.batchFallback=false;job.compactFallback=false;job.thumbnailFallback=false;queuePhoto(job);pumpPhotos();};img.after(note);}if(photoLoadMetrics.firstPhotoMs===null)photoLoadMetrics.firstPhotoMs=Date.now()-photoLoadMetrics.startedAt;}
}
function showPhotoFailure(job,error){
 for(const img of job.images){if(!img.isConnected)continue;img.dataset.photoState='error';img.alt=(error.message||'照片暂时无法加载')+'（'+(error.code||'MEDIA_UNKNOWN')+'）';
  if(img.nextElementSibling?.classList.contains('photo-retry'))continue;
  const button=document.createElement('button');button.type='button';button.className='ghost small-button photo-retry';button.textContent='重试照片';
  button.onclick=()=>{if(['loading','queued'].includes(job.state))return;button.remove();job.state='idle';job.meta=null;job.metaState='idle';job.compactFallback=false;queuePhoto(job);pumpPhotos();};img.after(button);
 }
}
function queuePhoto(job){
 if(photoPaused||!photoLive(job)||!job.images.size||![...job.images].some(img=>img._photoVisible&&img.isConnected))return;
 if(job.state==='ready'){showPhoto(job);return;}
 if(job.key&&!job.meta&&!job.batchFallback){schedulePhotoMeta(job);return;}
 if(job.state==='idle'||job.state==='aborted'){job.state='queued';photoQueue.push(job);}
}
function settlePhotoWaiters(){if(photoActive===0&&(!photoQueue.length||photoPaused)&&(!photoMetaPending.size||photoPaused)&&!photoMetaController&&!photoMetaScheduled){photoWaiters.splice(0).forEach(resolve=>resolve());}}
function pumpPhotos(){
 if(photoPaused){settlePhotoWaiters();return;}
 while(photoActive<2&&photoQueue.length){
  const job=photoQueue.shift();if(job.state!=='queued')continue;if(!photoLive(job)||!job.images.size||![...job.images].some(img=>img.isConnected&&img._photoVisible)){job.state='idle';continue;}
  job.state='loading';photoActive++;job.controller=new AbortController();mediaRequests.add(job.controller);
  const controller=job.controller,timer=setTimeout(()=>controller.abort(),PHOTO_JOB_TIMEOUT);
  readPhoto(job,controller).then(({blob,id})=>{
   if(!photoLive(job))return;
   if(job.cacheId!==id)dropPhotoUrl(job);job.blob=blob;job.cacheId=id;job.state='ready';showPhoto(job);
  }).catch(error=>{
   if(!photoLive(job))return;
   if(controller.signal.aborted){job.state='aborted';if(!job.partial?.resumable)job.partial=null;if(!photoPaused)showPhotoFailure(job,photoError('MEDIA_TIMEOUT','照片加载超时，请重试'));}
   else{job.state='error';job.error=error;if(!retryablePhotoError(error)||!job.partial?.resumable)job.partial=null;showPhotoFailure(job,error);}
   trimPhotoPartials();
  }).finally(()=>{clearTimeout(timer);mediaRequests.delete(controller);photoActive--;if(photoLive(job)&&job.refreshAfterLoad){job.refreshAfterLoad=false;job.state='idle';job.meta=null;job.metaState='idle';job.batchFallback=false;job.compactFallback=false;job.thumbnailFallback=false;job.error=null;queuePhoto(job);}pumpPhotos();settlePhotoWaiters();updatePhotoCacheStatus();});
 }
 settlePhotoWaiters();
}
const photoObserver=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
 for(const {target,isIntersecting} of entries){target._photoVisible=isIntersecting;const job=photoBindings.get(target);if(job)queuePhoto(job);}pumpPhotos();
},{rootMargin:'300px 0px'}):null;
function updateFallbackVisibility(){if(photoObserver)return;for(const [img,job] of photoBindings){const rect=img.getBoundingClientRect();img._photoVisible=rect.bottom>=-300&&rect.top<=innerHeight+300;queuePhoto(job);}pumpPhotos();}
async function hydratePrivatePhotos({recoverFailures=false}={}){
 if(!currentProfile||photoPaused)return;
 for(const [img,job] of photoBindings){if(img.isConnected)continue;photoObserver?.unobserve(img);photoBindings.delete(img);job.images.delete(img);}
 for(const job of photoJobs.values())if(!job.images.size){job.controller?.abort();job.partial=null;dropPhotoUrl(job);photoJobs.delete(job.ref);}
 for(const img of document.querySelectorAll('img[data-media-key],img[data-legacy-id]')){
  if(photoBindings.has(img))continue;
  const descriptor=photoDescriptor(img);let job=photoJobs.get(descriptor.ref);
  if(!job){job={...descriptor,owner:photoOwner,serial:photoSerial,state:'idle',metaState:'idle',batchFallback:false,compactFallback:false,thumbnailFallback:false,images:new Set()};photoJobs.set(job.ref,job);}
  job.images.add(img);photoBindings.set(img,job);
  img.onerror=()=>{if(!photoLive(job))return;photoCache.remove(job.cacheId);dropPhotoUrl(job);job.state='error';showPhotoFailure(job,photoError('MEDIA_DECODE','照片解码失败，请重试'));};
  photoObserver?.observe(img);
 }
 for(const job of photoJobs.values()){if(job.state==='error'){if(recoverFailures){job.state='idle';job.meta=null;job.metaState='idle';job.batchFallback=false;job.compactFallback=false;}else showPhotoFailure(job,job.error||photoError('MEDIA_UNKNOWN'));}queuePhoto(job);}
 updateFallbackVisibility();pumpPhotos();
 if(!photoObserver&&(photoActive||photoQueue.length||photoMetaPending.size||photoMetaController||photoMetaScheduled))await new Promise(resolve=>photoWaiters.push(resolve));
}
async function updatePhotoCacheStatus(){if(!currentProfile)return;const stats=await photoCache.stats();if(currentProfile&&window.document&&$('photoCacheStatus'))$('photoCacheStatus').textContent=stats.available?'本机照片缓存 '+(stats.bytes/1048576).toFixed(1)+'MB / 200MB':'照片缓存暂不可用，使用按需读取';}
async function clearLocalPhotoCache(broadcast=true){
 const owner=currentProfile?.id;resetPhotoLoads();await photoCache.clear();
 document.querySelectorAll('img[data-media-key],img[data-legacy-id]').forEach(img=>{img.removeAttribute('src');if(img.nextElementSibling?.matches('.photo-retry,.thumbnail-fallback'))img.nextElementSibling.remove();});
 if(broadcast){try{localStorage.setItem('love-photo-cache-clear',Date.now()+':'+Math.random());}catch{}}
 if(owner&&currentProfile?.id===owner){window.resumePhotoLoads(owner);await hydratePrivatePhotos();await updatePhotoCacheStatus();}
}
$('clearPhotoCache')?.addEventListener('click',()=>clearLocalPhotoCache());
window.addEventListener('storage',event=>{if(event.key==='love-photo-cache-clear')clearLocalPhotoCache(false);});
window.addEventListener('scroll',updateFallbackVisibility,true);window.addEventListener('resize',updateFallbackVisibility);
let cleanedFor=null;
async function cleanupOrphanPhotos(){
 if(!currentProfile||cleanedFor===currentProfile.id)return;
 const owner=currentProfile.id,epoch=authEpoch;cleanedFor=owner;
 const {data,error}=await sb.from('media_objects').select('key,record_id,created_at,state').eq('owner_id',owner);
 if(error||!isCurrent(epoch)){cleanedFor=null;return;}
 const candidates=(data||[]).filter(row=>row.state==='deleting'||Date.now()-new Date(row.created_at).getTime()>=3600000);
 for(let offset=0;offset<candidates.length;offset+=20){
  if(!isCurrent(epoch))return;
  const batch=candidates.slice(offset,offset+20),keys=batch.map(row=>row.key);
  let daily,spots;
  try{[daily,spots]=await Promise.all([
   sb.from('daily_checkins').select('photo_key').in('photo_key',keys),
   sb.from('spot_checkins').select('photo_key').in('photo_key',keys)
  ]);}catch{cleanedFor=null;return;}
  if(!isCurrent(epoch))return;
  if(daily.error||spots.error){cleanedFor=null;return;}
  const referenced=new Set([...(daily.data||[]),...(spots.data||[])].map(row=>row.photo_key).filter(Boolean));
  for(const row of batch){
   if(!isCurrent(epoch))return;if(referenced.has(row.key))continue;
   try{await removeImage(row.key);await forgetCachedPhoto(row.key);}catch{cleanedFor=null;}
  }
 }
}
const clearDailyData=window.clearPrivateData;
window.clearPrivateData=()=>{closeOriginalPhoto();mediaRequests.forEach(c=>c.abort());mediaRequests.clear();resetPhotoLoads();cleanedFor=null;clearDailyData?.();};

let originalPhotoDialog=null;
function closeOriginalPhoto(){if(!originalPhotoDialog)return;originalPhotoDialog.remove();originalPhotoDialog=null;hydratePrivatePhotos();}
function openOriginalPhoto(key){
 if(!currentProfile||photoPaused)return;closeOriginalPhoto();
 const dialog=document.createElement('dialog');dialog.className='original-photo-dialog';dialog.setAttribute('aria-label','查看原图');
 const close=document.createElement('button');close.type='button';close.textContent='关闭原图';close.onclick=closeOriginalPhoto;
 const img=document.createElement('img');img.dataset.mediaKey=key;img.alt='正在加载原图';
 dialog.append(close,img);document.body.append(dialog);originalPhotoDialog=dialog;
 dialog.addEventListener('cancel',closeOriginalPhoto);dialog.showModal();hydratePrivatePhotos();
}
$('dailyList').addEventListener('click',event=>{const button=event.target.closest('[data-view-photo]');if(button)openOriginalPhoto(button.dataset.viewPhoto);});
