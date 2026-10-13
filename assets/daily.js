let dailyRecords=[],editingDailyId=null,dailyBusy=false,dailyRequest=0;
async function loadDailyCheckins(){
 if(!currentProfile)return;const epoch=authEpoch,request=++dailyRequest,rows=[];
 if(!dailyRecords.length)$('dailyList').innerHTML='<div class="loading">正在加载日常记录…</div>';
 for(let offset=0;;offset+=200){
  const {data,error}=await sb.from('daily_checkins').select('*').order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+199);
  if(!isCurrent(epoch)||request!==dailyRequest)return;
  if(error){$('dailyList').innerHTML='<div class="empty">记录加载失败，请稍后刷新。</div>';return;}
  rows.push(...data);if(data.length<200)break;
 }
 dailyRecords=rows;renderDailyCheckins(rows);syncRightRecordPanelsOnly();
}
function legacyPhotoUrl(value){try{const url=new URL(value);return url.protocol==='https:'?url.href:'';}catch{return '';}}
function renderDailyCheckins(rows){
 const list=$('dailyList');
 if(!rows.length){list.innerHTML='<div class="empty">还没有日常打卡。<br>写下今天第一句想记录的话吧。</div>';return;}
 list.innerHTML=rows.map(item=>{
  const mine=item.author_id===currentProfile.id;
  const url=legacyPhotoUrl(item.photo_url);
  return `<article class="check-card">${url?`<img src="${escapeHtml(url)}" alt="日常打卡照片" loading="lazy">`:''}<div class="check-body"><div class="meta-row"><span class="tag">📝 ${escapeHtml(nameOf(item.author_id))}</span><span>⏰ ${escapeHtml(formatDateTime(item.created_at))}</span></div><p>${escapeHtml(item.content)}</p>${mine?`<div class="card-actions"><button class="ghost small-button" data-action="edit" data-id="${escapeHtml(item.id)}">编辑文字</button><button class="danger small-button" data-action="delete" data-id="${escapeHtml(item.id)}">删除</button></div>`:''}</div></article>`;
 }).join('');
}
function editDailyCheckin(id){
 const item=dailyRecords.find(r=>r.id===id&&r.author_id===currentProfile?.id);if(!item||dailyBusy)return;
 editingDailyId=id;$('dailyText').value=item.content;$('dailyPhoto').value='';$('dailyPhoto').disabled=true;
 $('dailyPreview').removeAttribute('src');$('dailyPreview').classList.remove('show');
 $('dailySubmitBtn').textContent='保存文字修改';$('dailyText').focus();$('dailyForm').scrollIntoView({behavior:'smooth',block:'center'});
 setStatus('dailyStatus','正在编辑自己的记录，照片保持不变。');
}
function resetDailyForm(){
 editingDailyId=null;$('dailyForm').reset();$('dailyPhoto').disabled=false;$('dailySubmitBtn').textContent='在线发布日常打卡';
 $('dailyPreview').removeAttribute('src');$('dailyPreview').classList.remove('show');setStatus('dailyStatus','');syncRightRecordPanelsOnly();
}
$('dailyForm').addEventListener('submit',async event=>{
 event.preventDefault();if(!currentProfile||dailyBusy)return;
 const text=$('dailyText').value.trim(),file=$('dailyPhoto').files[0];if(!text)return;
 dailyBusy=true;$('dailySubmitBtn').disabled=true;const epoch=authEpoch,id=editingDailyId;
 setStatus('dailyStatus',id?'正在保存修改…':'正在保存日常…');
 try{
  let result;
  if(id)result=await sb.from('daily_checkins').update({content:text}).eq('id',id).select('id');
  else{const photo=await uploadImage(file,'daily-checkins');if(!isCurrent(epoch))throw Error('登录已改变，请重新发布');result=await sb.from('daily_checkins').insert({content:text,photo_url:photo.url,photo_path:photo.path}).select('id');}
  if(result.error||!result.data?.length)throw result.error||Error('记录未保存');
  if(!isCurrent(epoch))return;resetDailyForm();await loadDailyCheckins();setStatus('dailyStatus','保存成功。');throwHearts();
 }catch{if(isCurrent(epoch))setStatus('dailyStatus','保存失败，请检查网络后重试。');}
 finally{dailyBusy=false;$('dailySubmitBtn').disabled=false;}
});
async function deleteDailyCheckin(id){
 const item=dailyRecords.find(r=>r.id===id&&r.author_id===currentProfile?.id);if(!item||dailyBusy||!confirm('确定删除自己的这条日常吗？'))return;
 const epoch=authEpoch;dailyBusy=true;
 try{const {data,error}=await sb.from('daily_checkins').delete().eq('id',id).select('id');if(error||!data?.length)throw error||Error();if(isCurrent(epoch))await loadDailyCheckins();}
 catch{if(isCurrent(epoch))alert('删除失败，请刷新重试。');}finally{dailyBusy=false;}
}
$('dailyList').addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;if(b.dataset.action==='edit')editDailyCheckin(b.dataset.id);else deleteDailyCheckin(b.dataset.id);});
const clearMoodData=window.clearPrivateData;
window.clearPrivateData=()=>{clearMoodData?.();dailyRecords=[];dailyRequest++;editingDailyId=null;resetDailyForm();};
