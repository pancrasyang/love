const mediaRequests=new Set();
async function uploadImage(file,recordId){
 if(!file)return {key:null,path:''};
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10*1024*1024)throw Error('请选择不超过 10MB 的 JPEG、PNG 或 WebP 照片。');
 const epoch=authEpoch,controller=new AbortController();mediaRequests.add(controller);
 try{
  const response=await fetch('/api/storage-upload',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Love-Request':'1'},body:JSON.stringify({id:recordId,type:file.type,size:file.size}),signal:controller.signal});
  const body=await response.json();if(!isCurrent(epoch))throw Error('登录状态已改变');
  if(!response.ok)throw Error(body.error||'照片上传失败');const {data:{session},error}=await sb.auth.getSession();
  if(error||!session||!isCurrent(epoch))throw Error('请重新登录');
  const upload=await fetch(body.upload_url,{method:'POST',cache:'no-store',headers:{'Content-Type':file.type,apikey:body.upload_key,Authorization:'Bearer '+session.access_token,'x-upsert':'false'},body:file,signal:controller.signal});
  await upload.body?.cancel();if(!isCurrent(epoch))throw Error('登录状态已改变');
  if(!upload.ok)throw Error('照片上传失败，请稍后重试');return {key:null,path:body.path};
 }finally{mediaRequests.delete(controller);}
}

const photoCache=createLovePhotoCache();
const photoJobs=new Map();
const photoBindings=new Map();
const PHOTO_READ_TIMEOUT=60000;
const MAX_PHOTO_SIZE=20*1024*1024;
const IMAGE_TYPES=['image/jpeg','image/png','image/webp'];
const PHOTO_SELECTOR='img[data-legacy-id]';
const PHOTO_TAG=/^W\/"[A-Za-z0-9._-]{1,150}"$/;
let photoOwner=null;
let photoPaused=true;
function newPhotoMetrics(){
 return {startedAt:Date.now(),requests:0,bodyRequests:0,bodyBytes:0,cacheHits:0,cacheMisses:0,cacheWriteFailures:0,firstPhotoMs:null};
}
let photoLoadMetrics=newPhotoMetrics();
window.getPhotoLoadMetrics=()=>({...photoLoadMetrics});

function photoDescriptor(img){
 const id=img.dataset.legacyId;
 const kind=img.dataset.legacyKind||'daily';
 const thumbnail=img.dataset.photoVariant==='thumbnail';
 const ref='storage-v1:'+kind+':'+id+(thumbnail?':thumbnail':'');
 const query=new URLSearchParams({source:'legacy',id,kind});
 if(thumbnail)query.set('variant','thumbnail');
 return {ref,url:'/api/photo?'+query};
}

function photoIsCurrent(job){
 return currentProfile?.id===job.owner&&photoJobs.get(job.ref)===job&&[...job.images].some(img=>img.isConnected);
}
function removePhotoURL(job){
 if(job.blobURL)URL.revokeObjectURL(job.blobURL);
 job.blobURL=null;
 job.blob=null;
 job.etag=null;
}
function resetPhotoLoads(){
 photoPaused=true;
 photoOwner=null;
 for(const job of photoJobs.values()){
  job.controller?.abort();
  removePhotoURL(job);
 }
 for(const img of photoBindings.keys()){
  photoObserver?.unobserve(img);
  img.onerror=null;
  img.removeAttribute('src');
  if(img.nextElementSibling?.matches('.photo-retry'))img.nextElementSibling.remove();
 }
 photoJobs.clear();
 photoBindings.clear();
}

window.pausePhotoLoads=()=>{photoPaused=true;};
window.resumePhotoLoads=owner=>{
 if(photoOwner!==owner){
  resetPhotoLoads();
  photoOwner=owner;
  photoLoadMetrics=newPhotoMetrics();
 }else if(photoPaused){
  for(const job of photoJobs.values())if(job.state==='ready')job.state='idle';
 }
 photoPaused=false;
 for(const job of photoJobs.values())loadVisiblePhoto(job);
};

function photoError(message,code,status){
 return Object.assign(new Error(message),{code,status});
}

async function readPhoto(job,controller){
 const ticket=await photoCache.ticket();
 const saved=job.blob?{blob:job.blob,version:job.etag}:await photoCache.get(job.cacheId);
 if(controller.signal.aborted||!photoIsCurrent(job))return null;
 const etag=PHOTO_TAG.test(saved?.version||'')?saved.version:null;
 photoLoadMetrics.requests++;
 const response=await fetch(job.url,{
  credentials:'same-origin',cache:'no-store',signal:controller.signal,
  headers:etag?{'If-None-Match':etag}:{}
 });
 if(controller.signal.aborted||!photoIsCurrent(job))return null;
 if(response.status===304&&etag){
  photoLoadMetrics.cacheHits++;
  return {blob:saved.blob,etag};
 }
 if(response.status!==200){
  const info=await response.json().catch(()=>({}));
  if(!controller.signal.aborted&&photoIsCurrent(job)&&response.status===401&&isSessionFailure(info)){
   clearPrivateView();
   showRoleChoices();
   $('authMessage').textContent='登录已失效，请重新登录。';
  }
  throw photoError(info.error||'照片暂时无法加载',info.code||'MEDIA_HTTP_'+response.status,response.status);
 }
 const type=(response.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
 const length=response.headers.get('Content-Length');
 const size=length===null?null:Number(length);
 if(!IMAGE_TYPES.includes(type)||size!==null&&(!Number.isInteger(size)||size<=0||size>MAX_PHOTO_SIZE)){
  await response.body?.cancel();
  throw photoError('照片格式或大小异常','MEDIA_FORMAT');
 }
 photoLoadMetrics.bodyRequests++;
 photoLoadMetrics.cacheMisses++;
 const blob=await response.blob();
 if(!blob.size||blob.size>MAX_PHOTO_SIZE||size!==null&&blob.size!==size){
  throw photoError('照片传输不完整，请重试','MEDIA_TRUNCATED');
 }
 if(controller.signal.aborted||!photoIsCurrent(job))return null;
 photoLoadMetrics.bodyBytes+=blob.size;
 const receivedTag=response.headers.get('ETag');
 const version=PHOTO_TAG.test(receivedTag||'')?receivedTag:null;
 if(version){
  const stored=await photoCache.put({id:job.cacheId,account:job.owner,ref:job.ref,version,mime:type},blob,ticket);
  if(!stored&&photoIsCurrent(job))photoLoadMetrics.cacheWriteFailures++;
 }else if(saved){
  await photoCache.remove(job.cacheId);
 }
 return {blob,etag:version};
}

function showPhoto(job){
 if(!job.blob||photoPaused||!photoIsCurrent(job))return;
 if(!job.blobURL)job.blobURL=URL.createObjectURL(job.blob);
 for(const img of job.images){
  if(!img.isConnected||!img._photoVisible)continue;
  if(img.getAttribute('src')!==job.blobURL)img.src=job.blobURL;
  img.alt='私人照片';
  img.dataset.photoState='ready';
  if(img.nextElementSibling?.matches('.photo-retry'))img.nextElementSibling.remove();
 }
 if(photoLoadMetrics.firstPhotoMs===null)photoLoadMetrics.firstPhotoMs=Date.now()-photoLoadMetrics.startedAt;
}

function showPhotoFailure(job,error){
 job.state='error';
 job.error=error;
 removePhotoURL(job);
 for(const img of job.images){
  if(!img.isConnected)continue;
  img.removeAttribute('src');
  img.dataset.photoState='error';
  img.alt=error.message||'照片暂时无法加载';
  if(img.nextElementSibling?.matches('.photo-retry'))continue;
  const button=document.createElement('button');
  button.type='button';
  button.className='ghost small-button photo-retry';
  button.textContent='重试照片';
  button.onclick=()=>{
   if(!photoIsCurrent(job)||job.state!=='error')return;
   button.remove();
   job.state='idle';
   loadVisiblePhoto(job);
  };
  img.after(button);
 }
}

function loadVisiblePhoto(job){
 if(photoPaused||!photoIsCurrent(job)||![...job.images].some(img=>img.isConnected&&img._photoVisible))return;
 if(job.state==='ready'){showPhoto(job);return;}
 if(job.state!=='idle'||job.pending)return;
 const controller=new AbortController();
 job.controller=controller;
 job.state='loading';
 let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},PHOTO_READ_TIMEOUT);
 job.pending=readPhoto(job,controller).then(result=>{
  if(!photoIsCurrent(job))return;
  if(!result){
   if(timedOut)throw photoError('照片加载超时，请重试','MEDIA_TIMEOUT');
   job.state='idle';
   return;
  }
  if(job.blob!==result.blob)removePhotoURL(job);
  job.blob=result.blob;
  job.etag=result.etag;
  job.state='ready';
  showPhoto(job);
 }).catch(error=>{
  if(!photoIsCurrent(job))return;
  if([403,404].includes(error.status))void photoCache.remove(job.cacheId);
  showPhotoFailure(job,timedOut?photoError('照片加载超时，请重试','MEDIA_TIMEOUT'):error);
 }).finally(()=>{
  clearTimeout(timer);
  job.pending=null;
  job.controller=null;
  if(photoIsCurrent(job))void updatePhotoCacheStatus();
 });
}

const photoObserver=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
 for(const {target,isIntersecting} of entries){
  target._photoVisible=isIntersecting;
  const job=photoBindings.get(target);
  if(job)loadVisiblePhoto(job);
 }
},{rootMargin:'300px 0px'}):null;
function updateFallbackVisibility(){
 if(photoObserver)return;
 for(const [img,job] of photoBindings){
  const rect=img.getBoundingClientRect();
  img._photoVisible=rect.bottom>=-300&&rect.top<=innerHeight+300;
  loadVisiblePhoto(job);
 }
}

async function hydratePrivatePhotos({recoverFailures=false}={}){
 if(!currentProfile||photoPaused)return;
 for(const [img,job] of photoBindings){
  if(img.isConnected)continue;
  photoObserver?.unobserve(img);
  photoBindings.delete(img);
  job.images.delete(img);
 }
 for(const job of photoJobs.values()){
  if(job.images.size)continue;
  job.controller?.abort();
  removePhotoURL(job);
  photoJobs.delete(job.ref);
 }
 for(const img of document.querySelectorAll(PHOTO_SELECTOR)){
  if(photoBindings.has(img))continue;
  const descriptor=photoDescriptor(img);
  let job=photoJobs.get(descriptor.ref);
  if(!job){
   job={...descriptor,owner:photoOwner,cacheId:photoOwner+'|'+descriptor.ref,state:'idle',images:new Set()};
   photoJobs.set(job.ref,job);
  }
  job.images.add(img);
  photoBindings.set(img,job);
  img.onerror=()=>{
   if(!photoIsCurrent(job)||!job.blobURL)return;
   void photoCache.remove(job.cacheId);
   showPhotoFailure(job,photoError('照片解码失败，请重试','MEDIA_DECODE'));
  };
  photoObserver?.observe(img);
 }
 for(const job of photoJobs.values()){
  if(job.state==='error'){
   if(recoverFailures)job.state='idle';
   else showPhotoFailure(job,job.error);
  }
  loadVisiblePhoto(job);
 }
 updateFallbackVisibility();
 if(!photoObserver)await Promise.all([...photoJobs.values()].map(job=>job.pending).filter(Boolean));
}

async function forgetCachedPhoto(id){
 const owner=currentProfile?.id;
 if(!owner)return;
 const ref='storage-v1:daily:'+id;
 await photoCache.prune(owner,{removeRefs:[ref,ref+':thumbnail']});
}
async function updatePhotoCacheStatus(){
 const profile=currentProfile;
 const status=$('photoCacheStatus');
 if(!profile||!status)return;
 const stats=await photoCache.stats();
 if(currentProfile===profile&&status.isConnected){
  status.textContent=stats.available?'本机照片缓存 '+(stats.bytes/1048576).toFixed(1)+'MB / 200MB':'照片缓存暂不可用，使用按需读取';
 }
}
async function clearLocalPhotoCache(broadcast=true){
 const owner=currentProfile?.id;
 resetPhotoLoads();
 await photoCache.clear();
 if(broadcast){try{localStorage.setItem('love-photo-cache-clear',Date.now()+':'+Math.random());}catch{}}
 if(owner&&currentProfile?.id===owner){
  window.resumePhotoLoads(owner);
  await hydratePrivatePhotos();
  await updatePhotoCacheStatus();
 }
}
$('clearPhotoCache')?.addEventListener('click',()=>clearLocalPhotoCache());
window.addEventListener('storage',event=>{if(event.key==='love-photo-cache-clear')clearLocalPhotoCache(false);});
window.addEventListener('scroll',updateFallbackVisibility,true);
window.addEventListener('resize',updateFallbackVisibility);
const clearDailyData=window.clearPrivateData;
window.clearPrivateData=()=>{
 closeOriginalPhoto();
 mediaRequests.forEach(controller=>controller.abort());
 mediaRequests.clear();
 resetPhotoLoads();
 void photoCache.clear();
 clearDailyData?.();
};

let originalPhotoDialog=null;
function closeOriginalPhoto(){
 if(!originalPhotoDialog)return;
 originalPhotoDialog.remove();
 originalPhotoDialog=null;
 hydratePrivatePhotos();
}
function openOriginalPhoto(id,kind='daily'){
 if(!currentProfile||photoPaused)return;
 closeOriginalPhoto();
 const dialog=document.createElement('dialog');
 dialog.className='original-photo-dialog';
 dialog.setAttribute('aria-label','查看原图');
 const close=document.createElement('button');
 close.type='button';
 close.textContent='关闭原图';
 close.onclick=closeOriginalPhoto;
 const img=document.createElement('img');
 img.dataset.legacyId=id;
 img.dataset.legacyKind=kind;
 img.alt='正在加载原图';
 dialog.append(close,img);
 document.body.append(dialog);
 originalPhotoDialog=dialog;
 dialog.addEventListener('cancel',closeOriginalPhoto);
 dialog.showModal();
 hydratePrivatePhotos();
}
$('dailyList').addEventListener('click',event=>{
 const button=event.target.closest('[data-view-photo]');
 if(button)openOriginalPhoto(button.dataset.viewPhoto,button.dataset.photoKind||'daily');
});
