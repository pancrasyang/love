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
const photoCache=createLovePhotoCache();
const photoJobs=new Map(),photoBindings=new Map();
let photoOwner=null,photoSerial=0,photoPaused=true,photoActive=0,photoQueue=[],photoWaiters=[];
const photoLive=job=>Boolean(currentProfile)&&currentProfile.id===job.owner&&job.serial===photoSerial&&photoJobs.get(job.ref)===job&&job.images.size>0;
function revokeMediaUrls(){mediaUrls.forEach(url=>URL.revokeObjectURL(url));mediaUrls.clear();}
function dropPhotoUrl(job){if(job.url){URL.revokeObjectURL(job.url);mediaUrls.delete(job.url);job.url=null;}job.blob=null;}
function resetPhotoLoads(){
 photoSerial++;photoPaused=true;photoOwner=null;photoQueue=[];
 photoJobs.forEach(job=>{job.controller?.abort();dropPhotoUrl(job);});photoJobs.clear();
 photoBindings.forEach((job,img)=>photoObserver?.unobserve(img));photoBindings.clear();revokeMediaUrls();settlePhotoWaiters();
}
window.pausePhotoLoads=()=>{photoPaused=true;};
window.resumePhotoLoads=owner=>{
 if(photoOwner!==owner){resetPhotoLoads();photoOwner=owner;}
 else if(photoPaused)photoJobs.forEach(job=>{if(['ready','error','aborted'].includes(job.state)){job.state='idle';job.meta=null;}});
 photoPaused=false;photoJobs.forEach(job=>{if(job.state==='ready')showPhoto(job);else queuePhoto(job);});pumpPhotos();
};
function photoDescriptor(img){
 const kind=img.dataset.legacyKind||'daily';
 return img.dataset.mediaKey?{ref:'r2:'+img.dataset.mediaKey,query:'source=r2&key='+encodeURIComponent(img.dataset.mediaKey)}:{ref:'legacy:'+kind+':'+img.dataset.legacyId,query:'source=legacy&kind='+kind+'&id='+encodeURIComponent(img.dataset.legacyId)};
}
function photoError(code,message='照片暂时无法加载'){return Object.assign(new Error(message),{code});}
async function photoRequest(query,controller){
 let response;
 try{response=await fetch('/api/photo?'+query,{credentials:'same-origin',cache:'no-store',signal:controller.signal});}
 catch(error){if(controller.signal.aborted)throw error;throw photoError('MEDIA_NETWORK','照片连接失败，请检查网络');}
 if(!response.ok){const body=await response.json().catch(()=>({}));if(response.status===401){clearPrivateView();showRoleChoices();$('authMessage').textContent='登录已失效，请重新登录。';}throw photoError(body.code||'MEDIA_HTTP_'+response.status,body.error||'照片请求失败');}
 return response;
}
async function readPhoto(job){
 const ticket=await photoCache.ticket();
 const response=await photoRequest(job.query+'&meta=1',job.controller),meta=await response.json();
 if(!photoLive(job))throw photoError('MEDIA_ABORTED');
 if(!Number.isInteger(meta.size)||meta.size<=0||meta.size>20*1048576||!['image/jpeg','image/png','image/webp'].includes(meta.type)||typeof meta.version!=='string')throw photoError('MEDIA_METADATA');
 const id=job.owner+'|'+job.ref+'|'+meta.version+'|original';job.meta=meta;
 const cached=await photoCache.get(id);if(cached&&photoLive(job))return {blob:cached.blob,id};
 const chunks=[];
 for(let start=0,part=0;start<meta.size;start+=1048576,part++){
  const r=await photoRequest(job.query+'&part='+part,job.controller);
  const range=r.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if(!range||Number(range[1])!==start||Number(range[2])!==Math.min(start+1048575,meta.size-1)||Number(range[3])!==meta.size)throw photoError('MEDIA_RANGE_INVALID');
  if(r.headers.get('X-Media-Version')!==meta.version)throw photoError('MEDIA_VERSION_CHANGED','照片已更新，请重试');
  const data=await r.arrayBuffer();if(data.byteLength!==Number(range[2])-start+1)throw photoError('MEDIA_TRUNCATED');
  if(!photoLive(job))throw photoError('MEDIA_ABORTED');chunks.push(data);
 }
 const blob=new Blob(chunks,{type:meta.type});
 if(meta.sha256){const bytes=await blob.arrayBuffer();const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==meta.sha256)throw photoError('MEDIA_HASH_MISMATCH');}
 if(!photoLive(job))throw photoError('MEDIA_ABORTED');
 await photoCache.put({id,account:job.owner,ref:job.ref,version:meta.version,mime:meta.type},blob,ticket);
 return {blob,id};
}
function showPhoto(job){
 if(photoPaused||!photoLive(job)||!job.blob)return;
 if(!job.url){job.url=URL.createObjectURL(job.blob);mediaUrls.add(job.url);}
 for(const img of job.images){if(!img.isConnected||!img._photoVisible)continue;img.src=job.url;img.alt='日常照片';img.dataset.photoState='ready';img.nextElementSibling?.classList.contains('photo-retry')&&img.nextElementSibling.remove();}
}
function showPhotoFailure(job,error){
 for(const img of job.images){if(!img.isConnected)continue;img.dataset.photoState='error';img.alt=(error.message||'照片暂时无法加载')+'（'+(error.code||'MEDIA_UNKNOWN')+'）';
  if(img.nextElementSibling?.classList.contains('photo-retry'))continue;
  const button=document.createElement('button');button.type='button';button.className='ghost small-button photo-retry';button.textContent='重试照片';
  button.onclick=()=>{button.remove();job.state='idle';job.meta=null;queuePhoto(job);pumpPhotos();};img.after(button);
 }
}
function queuePhoto(job){
 if(photoPaused||!photoLive(job)||!job.images.size||![...job.images].some(img=>img._photoVisible&&img.isConnected))return;
 if(job.state==='ready'){showPhoto(job);return;}
 if(job.state==='idle'||job.state==='aborted'){job.state='queued';photoQueue.push(job);}
}
function settlePhotoWaiters(){if(photoActive===0&&(!photoQueue.length||photoPaused)){photoWaiters.splice(0).forEach(resolve=>resolve());}}
function pumpPhotos(){
 if(photoPaused){settlePhotoWaiters();return;}
 while(photoActive<2&&photoQueue.length){
  const job=photoQueue.shift();if(!photoLive(job)||!job.images.size||![...job.images].some(img=>img.isConnected&&img._photoVisible)){job.state='idle';continue;}
  job.state='loading';photoActive++;job.controller=new AbortController();mediaRequests.add(job.controller);
  const timer=setTimeout(()=>job.controller.abort(),90000);
  readPhoto(job).then(({blob,id})=>{
   if(!photoLive(job))return;
   if(job.cacheId!==id)dropPhotoUrl(job);job.blob=blob;job.cacheId=id;job.state='ready';showPhoto(job);
  }).catch(error=>{
   if(!photoLive(job))return;
   if(job.controller.signal.aborted){job.state='aborted';if(!photoPaused)showPhotoFailure(job,photoError('MEDIA_TIMEOUT','照片加载超时，请重试'));}
   else{job.state='error';job.error=error;showPhotoFailure(job,error);}
  }).finally(()=>{clearTimeout(timer);mediaRequests.delete(job.controller);photoActive--;pumpPhotos();settlePhotoWaiters();updatePhotoCacheStatus();});
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
 for(const job of photoJobs.values())if(!job.images.size){job.controller?.abort();dropPhotoUrl(job);photoJobs.delete(job.ref);}
 for(const img of document.querySelectorAll('img[data-media-key],img[data-legacy-id]')){
  if(photoBindings.has(img))continue;
  const descriptor=photoDescriptor(img);let job=photoJobs.get(descriptor.ref);
  if(!job){job={...descriptor,owner:photoOwner,serial:photoSerial,state:'idle',images:new Set()};photoJobs.set(job.ref,job);}
  job.images.add(img);photoBindings.set(img,job);
  img.onerror=()=>{if(!photoLive(job))return;photoCache.remove(job.cacheId);dropPhotoUrl(job);job.state='error';showPhotoFailure(job,photoError('MEDIA_DECODE','照片解码失败，请重试'));};
  photoObserver?.observe(img);
 }
 for(const job of photoJobs.values()){if(job.state==='error'){if(recoverFailures){job.state='idle';job.meta=null;}else showPhotoFailure(job,job.error||photoError('MEDIA_UNKNOWN'));}queuePhoto(job);}
 updateFallbackVisibility();pumpPhotos();
 if(!photoObserver&&photoActive)await new Promise(resolve=>photoWaiters.push(resolve));
}
async function updatePhotoCacheStatus(){if(!currentProfile)return;const stats=await photoCache.stats();if(currentProfile&&window.document&&$('photoCacheStatus'))$('photoCacheStatus').textContent=stats.available?'本机照片缓存 '+(stats.bytes/1048576).toFixed(1)+'MB / 200MB':'照片缓存暂不可用，使用按需读取';}
async function clearLocalPhotoCache(broadcast=true){
 const owner=currentProfile?.id;resetPhotoLoads();await photoCache.clear();
 document.querySelectorAll('img[data-media-key],img[data-legacy-id]').forEach(img=>{img.removeAttribute('src');img.nextElementSibling?.classList.contains('photo-retry')&&img.nextElementSibling.remove();});
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
 for(const row of data||[]){
  if(!isCurrent(epoch))return;
  if(dailyRecords.some(r=>r.photo_key===row.key))continue;
  if(row.state!=='deleting'&&Date.now()-new Date(row.created_at).getTime()<3600000)continue;
  try{await removeImage(row.key);}catch{cleanedFor=null;}
 }
}
const clearDailyData=window.clearPrivateData;
window.clearPrivateData=()=>{mediaRequests.forEach(c=>c.abort());mediaRequests.clear();resetPhotoLoads();cleanedFor=null;clearDailyData?.();};
