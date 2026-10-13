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
function revokeMediaUrls(){mediaUrls.forEach(url=>URL.revokeObjectURL(url));mediaUrls.clear();}
async function legacyPhotoFetch(id,epoch){
 const controller=new AbortController();mediaRequests.add(controller);const chunks=[];let total=null,mime;
 try{for(let part=0;part<20;part++){
  const response=await fetch('/api/legacy-photo?id='+encodeURIComponent(id)+'&part='+part,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
  if(!response.ok)throw Error('历史照片读取失败');
  const range=response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);if(!range||Number(range[1])!==part*1048576||(total!==null&&total!==Number(range[3])))throw Error('历史照片响应异常');
  total=Number(range[3]);mime=response.headers.get('content-type');const chunk=await response.arrayBuffer();if(!isCurrent(epoch)||chunk.byteLength!==Number(range[2])-Number(range[1])+1)throw Error('登录状态改变或照片不完整');chunks.push(chunk);
  if(Number(range[2])+1===total)return new Blob(chunks,{type:mime});
 }throw Error('历史照片过大');}finally{mediaRequests.delete(controller);}
}
async function hydratePrivatePhotos(){
 const epoch=authEpoch;
 // Sequential small batches avoid downloading every photo at once.
 const images=[...document.querySelectorAll('img[data-media-key]:not([src]),img[data-legacy-id]:not([src])')];
 async function run(){for(;;){const img=images.shift();if(!img||!isCurrent(epoch))return;
  try{const blob=img.dataset.legacyId?await legacyPhotoFetch(img.dataset.legacyId,epoch):await mediaFetch('/api/media/'+encodeURIComponent(img.dataset.mediaKey),{},epoch);if(!isCurrent(epoch)||!img.isConnected)continue;const url=URL.createObjectURL(blob);mediaUrls.add(url);img.src=url;if(img.nextElementSibling?.classList.contains('photo-retry'))img.nextElementSibling.remove();}
  catch{if(isCurrent(epoch)&&img.isConnected){img.alt='照片暂时无法加载';const button=document.createElement('button');button.type='button';button.className='ghost small-button photo-retry';button.textContent='重试照片';button.onclick=()=>{button.remove();hydratePrivatePhotos();};if(!img.nextElementSibling?.matches('button'))img.after(button);}}
 }}await Promise.all([run(),run(),run()]);
}
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
window.clearPrivateData=()=>{mediaRequests.forEach(c=>c.abort());mediaRequests.clear();revokeMediaUrls();cleanedFor=null;clearDailyData?.();};
