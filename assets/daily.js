let dailyRecords=[],legacySpotRecords=[],dailyComments=[],editingDailyId=null,dailyBusy=false,dailyRequest=0;const commentBusy=new Set();
async function readRecordSource(table,columns,epoch,request){
 const rows=[];
 try{
  for(let offset=0;;offset+=200){
   const {data,error}=await sb.from(table).select(columns).order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+199);
   if(!isCurrent(epoch)||request!==dailyRequest)return null;
   if(error)return {rows:[],error};
   rows.push(...data);if(data.length<200)return {rows,error:null};
  }
 }catch(error){return {rows:[],error};}
}
function showRecordSourceFailures(daily,spots,comments){
 document.querySelectorAll('.record-source-error').forEach(node=>node.remove());
 if((daily.error||spots.error)&&!$('dailyList').querySelector('.check-card'))$('dailyList').replaceChildren();
 for(const [result,label] of [[daily,'日常记录'],[spots,'历史地点'],[comments,'评论']]){
  if(!result.error)continue;
  const notice=document.createElement('div');notice.className='empty record-source-error';notice.setAttribute('role','status');
  notice.textContent=label+'暂时无法读取，请重试。';
  const button=document.createElement('button');button.type='button';button.className='ghost small-button';button.dataset.action='retry';button.textContent='重试';notice.append(button);$('dailyList').append(notice);
 }
}
async function loadDailyCheckins(){
 if(!currentProfile)return;const epoch=authEpoch,request=++dailyRequest;
 if(!dailyRecords.length)$('dailyList').innerHTML='<div class="loading">正在加载日常记录…</div>';
 const [daily,legacy,comments]=await Promise.all([readRecordSource('daily_checkins','*',epoch,request),readRecordSource('spot_checkins','id,spot_name,spot_date,created_at,photo_url,photo_path,photo_key',epoch,request),readRecordSource('daily_comments','id,daily_id,author_id,content,created_at',epoch,request)]);
 if(!isCurrent(epoch)||request!==dailyRequest)return;
 const denied=[daily.error,legacy.error,comments.error].find(isSessionFailure);
 if(denied){clearPrivateView();showRoleChoices();$('authMessage').textContent='登录已失效，请重新登录。';return;}
 const rows=daily.rows,spots=legacy.rows,commentRows=comments.rows;
 window.resumePhotoLoads?.(currentProfile.id);
 if(!daily.error&&!legacy.error&&!comments.error&&!$('dailyList').querySelector('.record-source-error')&&JSON.stringify(rows)===JSON.stringify(dailyRecords)&&JSON.stringify(spots)===JSON.stringify(legacySpotRecords)&&JSON.stringify(commentRows)===JSON.stringify(dailyComments)&&$('dailyList').querySelector('.check-card,.empty')){await hydratePrivatePhotos({recoverFailures:true});return;}
 dailyRecords=rows;legacySpotRecords=spots;dailyComments=commentRows;renderDailyCheckins([...rows,...spots.map(row=>({...row,source_kind:'spot',author_id:null,content:(row.spot_name||'历史地点')+(row.spot_date?' · '+row.spot_date:'')}))].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)));syncRightRecordPanelsOnly();
 showRecordSourceFailures(daily,legacy,comments);
 await hydratePrivatePhotos({recoverFailures:true}); if(isCurrent(epoch)&&!daily.error&&!legacy.error&&!comments.error)cleanupOrphanPhotos();
}
function renderDailyCheckins(rows){
 const list=$('dailyList');
 if(!rows.length){photoCache.prune(currentProfile.id,new Set());list.innerHTML='<div class="empty">还没有日常打卡。<br>写下今天第一句想记录的话吧。</div>';return;}
 const existing=new Map([...list.children].map(card=>[card.dataset.recordId,card]));
 const groupedComments=new Map();for(const comment of [...dailyComments].reverse()){const group=groupedComments.get(comment.daily_id)||[];group.push(comment);groupedComments.set(comment.daily_id,group);}
 const cards=rows.map(item=>{
  const mine=item.author_id===currentProfile.id;
  const photo=item.photo_key?`<img data-media-key="${escapeHtml(item.photo_key)}" data-photo-variant="thumbnail" alt="正在加载私人照片" loading="lazy">`:(item.photo_url||item.photo_path)?`<img data-legacy-kind="${item.source_kind||'daily'}" data-legacy-id="${escapeHtml(item.id)}" alt="正在加载历史照片" loading="lazy">`:'';
  const comments=groupedComments.get(item.id)||[],commentSection=item.source_kind==='spot'?'':`<section class="comments" aria-label="这条日常的评论"><div class="comments-heading"><strong>💬 评论</strong><span>${comments.length?comments.length+' 条':'还没有评论'}</span></div><div class="comment-list">${comments.map(comment=>`<div class="comment"><div class="comment-meta"><strong>${escapeHtml(nameOf(comment.author_id))}</strong><span>${escapeHtml(formatDateTime(comment.created_at))}</span></div><p>${escapeHtml(comment.content)}</p></div>`).join('')}</div><form class="comment-form" data-comment-form data-daily-id="${escapeHtml(item.id)}"><textarea name="content" maxlength="1000" rows="2" aria-label="评论内容" placeholder="写下想说的话…" required></textarea><button type="submit" class="ghost small-button">发送</button><div class="comment-status status" role="status" aria-live="polite"></div></form></section>`;
  const markup=`<article class="check-card" data-record-id="${escapeHtml(item.id)}">${photo}<div class="check-body"><div class="meta-row"><span class="tag">${item.source_kind==='spot'?'📍 历史地点':'📝 '+escapeHtml(nameOf(item.author_id))}</span><span>⏰ ${escapeHtml(formatDateTime(item.created_at))}</span></div><p>${escapeHtml(item.content)}</p>${item.photo_key?`<button type="button" class="ghost small-button" data-view-photo="${escapeHtml(item.photo_key)}">查看原图</button>`:''}${mine?`<div class="card-actions"><button class="ghost small-button" data-action="edit" data-id="${escapeHtml(item.id)}">编辑文字</button><button class="danger small-button" data-action="delete" data-id="${escapeHtml(item.id)}">删除</button></div>`:''}${commentSection}</div></article>`;
  const old=existing.get(String(item.id)),holder=document.createElement('template');holder.innerHTML=markup;const card=holder.content.firstElementChild;
  const before=old?.querySelector('img'),after=card.querySelector('img');
  if(before&&after&&before.dataset.mediaKey===after.dataset.mediaKey&&before.dataset.photoVariant===after.dataset.photoVariant&&before.dataset.legacyId===after.dataset.legacyId&&before.dataset.legacyKind===after.dataset.legacyKind)after.replaceWith(before);
  return card;
 });
 list.replaceChildren(...cards);
 photoCache.prune(currentProfile.id,new Set(cards.map(card=>card.querySelector('img')).filter(Boolean).flatMap(img=>[photoDescriptor(img).ref,...(img.dataset.mediaKey?['r2:'+img.dataset.mediaKey]:[])])));
}
async function submitDailyComment(form){
 const id=form.dataset.dailyId,input=form.elements.content,content=input.value.trim();if(!currentProfile||!dailyRecords.some(row=>row.id===id)||commentBusy.has(id))return;
 if(!content){input.focus();return;}const epoch=authEpoch,button=form.querySelector('button[type="submit"]'),status=form.querySelector('.comment-status');commentBusy.add(id);input.disabled=true;button.disabled=true;status.textContent='正在发送…';status.classList.add('show');
 try{const {data,error}=await sb.from('daily_comments').insert({daily_id:id,content}).select('id');if(error||!data?.length)throw error||Error('评论未保存');if(!isCurrent(epoch))return;input.value='';await loadDailyCheckins();}
 catch(error){if(isCurrent(epoch)){status.textContent=error.message||'评论发送失败，请稍后重试。';status.classList.add('show');}}
 finally{commentBusy.delete(id);if(isCurrent(epoch)&&form.isConnected){input.disabled=false;button.disabled=false;}}
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
 let uploadedKey=null;
 try{
  let result;
  if(id)result=await sb.from('daily_checkins').update({content:text}).eq('id',id).select('id');
  else{const recordId=crypto.randomUUID();const photo=await uploadImage(file,recordId);uploadedKey=photo.key;if(!isCurrent(epoch))throw Error('登录已改变，请重新发布');result=await sb.from('daily_checkins').insert({id:recordId,content:text,photo_key:photo.key,photo_url:'',photo_path:''}).select('id');}
  if(result.error||!result.data?.length)throw result.error||Error('记录未保存');
  if(!isCurrent(epoch))return;resetDailyForm();await loadDailyCheckins();setStatus('dailyStatus','保存成功。');throwHearts();
 }catch(error){if(isCurrent(epoch)){if(uploadedKey){try{await removeImage(uploadedKey);}catch{/* An ambiguous save may have attached the photo; the server refuses deletion. */}}setStatus('dailyStatus',error.message||'保存失败，请检查网络后重试。');}}
 finally{dailyBusy=false;$('dailySubmitBtn').disabled=false;}
});
async function deleteDailyCheckin(id){
 const item=dailyRecords.find(r=>r.id===id&&r.author_id===currentProfile?.id);if(!item||dailyBusy||!confirm('确定删除自己的这条日常吗？'))return;
 const epoch=authEpoch;dailyBusy=true;let removed=false;
 try{const {data,error}=await sb.from('daily_checkins').delete().eq('id',id).select('id');if(error||!data?.length)throw error||Error();removed=true;if(isCurrent(epoch)){await loadDailyCheckins();if(item.photo_key)await removeImage(item.photo_key);}}
 catch{if(isCurrent(epoch)){cleanedFor=null;alert(removed?'记录已删除，照片清理暂未完成，下次登录会自动重试。':'删除失败，请刷新重试。');}}finally{dailyBusy=false;}
}
$('dailyList').addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;if(b.dataset.action==='retry')loadDailyCheckins();else if(b.dataset.action==='edit')editDailyCheckin(b.dataset.id);else if(b.dataset.action==='delete')deleteDailyCheckin(b.dataset.id);});
/* Comments stay inside their daily card and use the same authenticated data proxy. */
$('dailyList').addEventListener('submit',e=>{const form=e.target.closest('[data-comment-form]');if(!form)return;e.preventDefault();submitDailyComment(form);});
const clearMoodData=window.clearPrivateData;
window.clearPrivateData=()=>{clearMoodData?.();dailyRecords=[];legacySpotRecords=[];dailyComments=[];commentBusy.clear();dailyRequest++;editingDailyId=null;resetDailyForm();};
