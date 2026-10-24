const DAILY_PAGE_SIZE=20,COMMENT_PAGE_SIZE=20,COMMENT_CONCURRENCY=4,SPOT_PAGE_SIZE=50;
let dailyRecords=[],legacySpotRecords=[],dailyComments=[],editingDailyId=null,dailyBusy=false,dailyRequest=0,dailyCursor=null,dailyHasMore=false,dailyPageBusy=false,spotRequest=0;
const commentBusy=new Set(),commentStates=new Map();
let commentQueue=[],commentActive=0;
const stableSort=(a,b)=>new Date(b.created_at)-new Date(a.created_at)||String(b.id).localeCompare(String(a.id));
const cursorOf=rows=>rows.length?{created_at:rows.at(-1).created_at,id:rows.at(-1).id}:null;
const withCursor=(query,cursor)=>cursor?query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`):query;
function sessionExpired(error){
 if(!isSessionFailure(error))return false;
 clearPrivateView();showRoleChoices();$('authMessage').textContent='登录已失效，请重新登录。';return true;
}
function sourceNotice(kind,message){
 const host=$('dailySourceNotices'),existing=host?.querySelector(`[data-source="${kind}"]`);existing?.remove();
 if(!message||!host)return;
 const notice=document.createElement('div');notice.className='empty record-source-error';notice.dataset.source=kind;notice.setAttribute('role','status');notice.textContent=message;
 const button=document.createElement('button');button.type='button';button.className='ghost small-button';button.dataset.action=kind==='spot'?'retry-spots':'retry-daily';button.textContent='重试';notice.append(button);host.append(notice);
}
async function readDailyPage(cursor,epoch,request){
 try{
  let query=sb.from('daily_checkins').select('*').order('created_at',{ascending:false}).order('id',{ascending:false});
  query=withCursor(query,cursor).range(0,DAILY_PAGE_SIZE);
  const {data,error}=await query;
  if(!isCurrent(epoch)||request!==dailyRequest)return null;
  if(error)return {rows:[],error,hasMore:false,cursor:null};
  const rows=(data||[]).slice(0,DAILY_PAGE_SIZE);
  return {rows,error:null,hasMore:(data||[]).length>DAILY_PAGE_SIZE,cursor:cursorOf(rows)};
 }catch(error){return {rows:[],error,hasMore:false,cursor:null};}
}
function loadedRows(){
 return [...dailyRecords,...legacySpotRecords.map(row=>({...row,source_kind:'spot',author_id:null,content:(row.spot_name||'历史地点')+(row.spot_date?' · '+row.spot_date:'')}))].sort(stableSort);
}
function commentState(id){
 let state=commentStates.get(id);
 if(!state){state={rows:[],cursor:null,hasMore:false,loading:false,error:null,request:0,flight:null};commentStates.set(id,state);}
 return state;
}
function commentMarkup(comment){
 return `<div class="comment"><div class="comment-meta"><strong data-author-id="${escapeHtml(comment.author_id)}">${escapeHtml(nameOf(comment.author_id))}</strong><span>${escapeHtml(formatDateTime(comment.created_at))}</span></div><p>${escapeHtml(comment.content)}</p></div>`;
}
function commentSummary(state){
 if(state.loading&&!state.rows.length)return '正在加载评论…';
 return state.rows.length?state.rows.length+(state.hasMore?'+':'')+' 条':'还没有评论';
}
function commentSectionMarkup(item){
 const state=commentState(item.id),rows=[...state.rows].reverse();
 const problem=state.error?`<div class="comment-load-error" role="status">评论暂时无法读取。<button type="button" class="ghost small-button" data-action="retry-comments" data-id="${escapeHtml(item.id)}">重试评论</button></div>`:'';
 const more=state.hasMore&&!state.error?`<button type="button" class="ghost small-button comment-more" data-action="more-comments" data-id="${escapeHtml(item.id)}" ${state.loading?'disabled':''}>${state.loading?'正在加载…':'加载更多评论'}</button>`:'';
 return `<section class="comments" aria-label="这条日常的评论" data-comments-for="${escapeHtml(item.id)}"><div class="comments-heading"><strong>💬 评论</strong><span data-comment-summary>${commentSummary(state)}</span></div><div class="comment-list" data-comment-list>${rows.map(commentMarkup).join('')}</div>${problem}${more}<form class="comment-form" data-comment-form data-daily-id="${escapeHtml(item.id)}"><textarea name="content" maxlength="1000" rows="2" aria-label="评论内容" placeholder="写下想说的话…" required></textarea><button type="submit" class="ghost small-button">发送</button><div class="comment-status status" role="status" aria-live="polite"></div></form></section>`;
}
function commentsElement(id){
 return [...$('dailyList').querySelectorAll('[data-comments-for]')].find(node=>node.dataset.commentsFor===String(id));
}
function updateComments(id){
 const section=commentsElement(id);if(!section)return;
 const state=commentState(id),rows=[...state.rows].reverse();
 section.querySelector('[data-comment-summary]').textContent=commentSummary(state);
 section.querySelector('[data-comment-list]').innerHTML=rows.map(commentMarkup).join('');
 section.querySelector('.comment-load-error')?.remove();section.querySelector('.comment-more')?.remove();
 const form=section.querySelector('[data-comment-form]');
 if(state.error){
  const error=document.createElement('div');error.className='comment-load-error';error.setAttribute('role','status');
  error.innerHTML=`评论暂时无法读取。<button type="button" class="ghost small-button" data-action="retry-comments" data-id="${escapeHtml(id)}">重试评论</button>`;section.insertBefore(error,form);
 }else if(state.hasMore){
  const more=document.createElement('button');more.type='button';more.className='ghost small-button comment-more';more.dataset.action='more-comments';more.dataset.id=id;more.disabled=state.loading;more.textContent=state.loading?'正在加载…':'加载更多评论';section.insertBefore(more,form);
 }
}
function syncCommentFlatList(){dailyComments=[...commentStates.values()].flatMap(state=>state.rows);}
function runCommentQueue(){
 while(commentActive<COMMENT_CONCURRENCY&&commentQueue.length){
  const task=commentQueue.shift();commentActive++;task().finally(()=>{commentActive--;runCommentQueue();});
 }
}
function loadCommentsForRecord(id,{more=false}={}){
 if(!currentProfile||!dailyRecords.some(row=>row.id===id))return Promise.resolve();
 const state=commentState(id);if(state.loading)return state.flight||Promise.resolve();
 const epoch=authEpoch,request=dailyRequest,commentRequest=++state.request,cursor=more?state.cursor:null;
 state.loading=true;state.error=null;updateComments(id);
 let finishFlight;state.flight=new Promise(resolve=>finishFlight=resolve);
 commentQueue.push(async()=>{
  try{
   let query=sb.from('daily_comments').select('id,daily_id,author_id,content,created_at').eq('daily_id',id).order('created_at',{ascending:false}).order('id',{ascending:false});
   query=withCursor(query,cursor).range(0,COMMENT_PAGE_SIZE);
   const {data,error}=await query;
   if(!isCurrent(epoch)||request!==dailyRequest||commentRequest!==state.request||!dailyRecords.some(row=>row.id===id))return;
   if(error){if(!sessionExpired(error))state.error=error;return;}
   const page=(data||[]).slice(0,COMMENT_PAGE_SIZE),existing=more?state.rows:[];
   state.rows=[...new Map([...existing,...page].map(row=>[row.id,row])).values()].sort(stableSort);
   state.cursor=cursorOf(page);state.hasMore=(data||[]).length>COMMENT_PAGE_SIZE;state.error=null;syncCommentFlatList();
  }catch(error){if(isCurrent(epoch)&&request===dailyRequest&&commentRequest===state.request)state.error=error;}
  finally{if(commentRequest===state.request){state.loading=false;state.flight=null;updateComments(id);}finishFlight();}
 });runCommentQueue();return state.flight;
}
function loadCommentsForRecords(rows,{refresh=false}={}){
 for(const id of [...commentStates.keys()])if(!dailyRecords.some(row=>row.id===id))commentStates.delete(id);
 for(const {id} of rows){
  const state=commentState(id);
  if(refresh||(!state.rows.length&&!state.loading&&!state.error))loadCommentsForRecord(id);
 }
}
function updatePagination(){
 const button=$('loadMoreDaily');if(!button)return;
 button.hidden=!dailyHasMore;button.disabled=dailyPageBusy;button.textContent=dailyPageBusy?'正在加载…':'加载更多日常';
}
function renderDailyCheckins(rows=loadedRows()){
 const list=$('dailyList');
 if(!rows.length){list.innerHTML='<div class="empty">还没有日常打卡。<br>写下今天第一句想记录的话吧。</div>';updatePagination();return;}
 const existing=new Map([...list.querySelectorAll('.check-card')].map(card=>[card.dataset.recordId,card]));
 const cards=rows.map(item=>{
  const mine=item.author_id===currentProfile.id;
  const photo=item.photo_key?`<img data-media-key="${escapeHtml(item.photo_key)}" data-photo-variant="thumbnail" alt="正在加载私人照片" loading="lazy">`:(item.photo_url||item.photo_path)?`<img data-legacy-kind="${item.source_kind||'daily'}" data-legacy-id="${escapeHtml(item.id)}" alt="正在加载历史照片" loading="lazy">`:'';
  const comments=item.source_kind==='spot'?'':commentSectionMarkup(item);
  const tag=item.source_kind==='spot'?'📍 历史地点':'📝 '+escapeHtml(nameOf(item.author_id));
  const markup=`<article class="check-card" data-record-id="${escapeHtml(item.id)}">${photo}<div class="check-body"><div class="meta-row"><span class="tag" ${item.source_kind==='spot'?'':`data-author-id="${escapeHtml(item.author_id)}"`}>${tag}</span><span>⏰ ${escapeHtml(formatDateTime(item.created_at))}</span></div><p>${escapeHtml(item.content)}</p>${item.photo_key?`<button type="button" class="ghost small-button" data-view-photo="${escapeHtml(item.photo_key)}">查看原图</button>`:''}${mine?`<div class="card-actions"><button class="ghost small-button" data-action="edit" data-id="${escapeHtml(item.id)}">编辑文字</button><button class="danger small-button" data-action="delete" data-id="${escapeHtml(item.id)}">删除</button></div>`:''}${comments}</div></article>`;
  const old=existing.get(String(item.id)),holder=document.createElement('template');holder.innerHTML=markup;const card=holder.content.firstElementChild;
  const before=old?.querySelector('img'),after=card.querySelector('img');
  if(before&&after&&before.dataset.mediaKey===after.dataset.mediaKey&&before.dataset.photoVariant===after.dataset.photoVariant&&before.dataset.legacyId===after.dataset.legacyId&&before.dataset.legacyKind===after.dataset.legacyKind)after.replaceWith(before);
  return card;
 });
 list.replaceChildren(...cards);updatePagination();
}
window.refreshPrivateNames=()=>{
 document.querySelectorAll('[data-author-id]').forEach(node=>{node.textContent=(node.classList.contains('tag')?'📝 ':'')+nameOf(node.dataset.authorId);});
 if(typeof renderTodayMood==='function')renderTodayMood();if(typeof renderMoodCalendar==='function')renderMoodCalendar();
};
async function loadLegacySpots(epoch,request){
 const own=++spotRequest,rows=[];let cursor=null;
 for(;;){
  let query=sb.from('spot_checkins').select('id,spot_name,spot_date,created_at,photo_url,photo_path,photo_key').order('created_at',{ascending:false}).order('id',{ascending:false});
  query=withCursor(query,cursor).range(0,SPOT_PAGE_SIZE);
  let result;try{result=await query;}catch(error){result={data:null,error};}
  if(!isCurrent(epoch)||request!==dailyRequest||own!==spotRequest)return;
  if(result.error){if(!sessionExpired(result.error))sourceNotice('spot','历史地点暂时无法读取，请重试。');return;}
  const page=(result.data||[]).slice(0,SPOT_PAGE_SIZE);rows.push(...page);legacySpotRecords=rows;sourceNotice('spot','');renderDailyCheckins();hydratePrivatePhotos({recoverFailures:true});
  if((result.data||[]).length<=SPOT_PAGE_SIZE)return;cursor=cursorOf(page);
 }
}
async function refreshLegacySpots(epoch,request){
 const own=++spotRequest,shown=legacySpotRecords.map(row=>row.id);
 try{
  let latestQuery=sb.from('spot_checkins').select('id,spot_name,spot_date,created_at,photo_url,photo_path,photo_key').order('created_at',{ascending:false}).order('id',{ascending:false}).range(0,SPOT_PAGE_SIZE);
  const [latest,displayed]=await Promise.all([latestQuery,shown.length?sb.from('spot_checkins').select('id,spot_name,spot_date,created_at,photo_url,photo_path,photo_key').in('id',shown):Promise.resolve({data:[],error:null})]);
  if(!isCurrent(epoch)||request!==dailyRequest||own!==spotRequest)return;
  const error=latest.error||displayed.error;if(error){if(!sessionExpired(error))sourceNotice('spot','历史地点同步暂时失败，请重试。');return;}
  legacySpotRecords=[...new Map([...(latest.data||[]).slice(0,SPOT_PAGE_SIZE),...(displayed.data||[])].map(row=>[row.id,row])).values()].sort(stableSort);
  sourceNotice('spot','');renderDailyCheckins();hydratePrivatePhotos({recoverFailures:true});
 }catch(error){if(isCurrent(epoch)&&request===dailyRequest&&own===spotRequest)sourceNotice('spot','历史地点同步暂时失败，请重试。');}
}
async function loadDailyCheckins(){
 if(!currentProfile)return;
 const epoch=authEpoch,request=++dailyRequest;dailyPageBusy=true;updatePagination();
 if(!dailyRecords.length)$('dailyList').innerHTML='<div class="loading">正在加载日常记录…</div>';
 window.resumePhotoLoads?.(currentProfile.id);
 loadLegacySpots(epoch,request);
 const page=await readDailyPage(null,epoch,request);
 if(!page)return;
 if(page.error){
  dailyPageBusy=false;updatePagination();if(sessionExpired(page.error))return;
  sourceNotice('daily','日常记录暂时无法读取，请重试。');$('dailyList').querySelector('.loading')?.remove();return;
 }
 dailyRecords=page.rows;dailyCursor=page.cursor;dailyHasMore=page.hasMore;dailyPageBusy=false;sourceNotice('daily','');renderDailyCheckins();syncRightRecordPanelsOnly();
 const photos=hydratePrivatePhotos({recoverFailures:true});
 loadCommentsForRecords(page.rows,{refresh:true});cleanupOrphanPhotos();
 await photos;
}
async function loadMoreDailyCheckins(){
 if(!currentProfile||dailyPageBusy||!dailyHasMore)return;
 const epoch=authEpoch,request=dailyRequest;dailyPageBusy=true;updatePagination();
 const page=await readDailyPage(dailyCursor,epoch,request);
 if(!page){dailyPageBusy=false;updatePagination();return;}
 if(page.error){dailyPageBusy=false;updatePagination();if(!sessionExpired(page.error))sourceNotice('daily','更多日常暂时无法读取，请重试。');return;}
 const added=page.rows.filter(row=>!dailyRecords.some(existing=>existing.id===row.id));
 dailyRecords.push(...added);dailyRecords.sort(stableSort);dailyCursor=page.cursor;dailyHasMore=page.hasMore;dailyPageBusy=false;sourceNotice('daily','');renderDailyCheckins();
 const photos=hydratePrivatePhotos();loadCommentsForRecords(added);await photos;
}
async function refreshDailyCheckins(){
 if(!currentProfile)return;
 const epoch=authEpoch,request=++dailyRequest,shown=dailyRecords.map(row=>row.id),previousHasMore=dailyHasMore;
 window.resumePhotoLoads?.(currentProfile.id);
 refreshLegacySpots(epoch,request);
 const latest=await readDailyPage(null,epoch,request);if(!latest)return;
 if(latest.error){if(!sessionExpired(latest.error))sourceNotice('daily','日常同步暂时失败，请重试。');return;}
 let displayed=[];
 if(shown.length){
  try{
   const result=await sb.from('daily_checkins').select('*').in('id',shown);
   if(!isCurrent(epoch)||request!==dailyRequest)return;
   if(result.error){if(sessionExpired(result.error))return;displayed=dailyRecords;}else displayed=result.data||[];
  }catch{displayed=dailyRecords;}
 }
 dailyRecords=[...new Map([...latest.rows,...displayed].map(row=>[row.id,row])).values()].sort(stableSort);
 dailyCursor=cursorOf(dailyRecords);dailyHasMore=previousHasMore||latest.hasMore;sourceNotice('daily','');renderDailyCheckins();
 const photos=hydratePrivatePhotos({recoverFailures:true});loadCommentsForRecords(latest.rows,{refresh:true});await photos;
}
async function submitDailyComment(form){
 const id=form.dataset.dailyId,input=form.elements.content,content=input.value.trim();if(!currentProfile||!dailyRecords.some(row=>row.id===id)||commentBusy.has(id))return;
 if(!content){input.focus();return;}
 const epoch=authEpoch,button=form.querySelector('button[type="submit"]'),status=form.querySelector('.comment-status');commentBusy.add(id);input.disabled=true;button.disabled=true;status.textContent='正在发送…';status.classList.add('show');
 try{
  const {data,error}=await sb.from('daily_comments').insert({daily_id:id,content}).select('id');
  if(error||!data?.length)throw error||Error('评论未保存');if(!isCurrent(epoch))return;
  input.value='';const state=commentState(id);if(state.loading)await state.flight;await loadCommentsForRecord(id);status.textContent='';status.classList.remove('show');
 }catch(error){if(isCurrent(epoch)){status.textContent=error.message||'评论发送失败，请稍后重试。';status.classList.add('show');}}
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
async function finishPublishedThumbnail(key,epoch){
 const status=$('dailyStatus');setStatus('dailyStatus','日常已保存，正在生成缩略图…');
 try{await prepareThumbnail(key,epoch);if(!isCurrent(epoch))return;refreshThumbnailPhoto(key);setStatus('dailyStatus','保存成功，缩略图已就绪。');}
 catch(error){
  if(!isCurrent(epoch))return;setStatus('dailyStatus','日常已保存；缩略图暂未生成，可重试或直接查看原图。');
  const button=document.createElement('button');button.type='button';button.className='ghost small-button thumbnail-generate-retry';button.textContent='重试生成缩略图';button.onclick=async()=>{button.disabled=true;button.textContent='正在重试…';await finishPublishedThumbnail(key,authEpoch);};status.append(button);
 }
}
$('dailyForm').addEventListener('submit',async event=>{
 event.preventDefault();if(!currentProfile||dailyBusy)return;
 const text=$('dailyText').value.trim(),file=$('dailyPhoto').files[0];if(!text)return;
 dailyBusy=true;$('dailySubmitBtn').disabled=true;const epoch=authEpoch,id=editingDailyId;
 setStatus('dailyStatus',id?'正在保存修改…':'正在保存日常…');let uploadedKey=null,linked=false;
 try{
  let result;
  if(id)result=await sb.from('daily_checkins').update({content:text}).eq('id',id).select('id');
  else{
   const recordId=crypto.randomUUID(),photo=await uploadImage(file,recordId);uploadedKey=photo.key;
   if(!isCurrent(epoch))throw Error('登录已改变，请重新发布');
   result=await sb.from('daily_checkins').insert({id:recordId,content:text,photo_key:photo.key,photo_url:'',photo_path:''}).select('id');
  }
  if(result.error||!result.data?.length)throw result.error||Error('记录未保存');
  linked=true;if(!isCurrent(epoch))return;resetDailyForm();if(uploadedKey)await finishPublishedThumbnail(uploadedKey,epoch);await loadDailyCheckins();if(!uploadedKey)setStatus('dailyStatus','保存成功。');throwHearts();
 }catch(error){if(isCurrent(epoch)){if(uploadedKey&&!linked){try{await removeImage(uploadedKey);}catch{/* The server refuses deletion if an ambiguous save attached the photo. */}}setStatus('dailyStatus',linked?'日常已保存，页面刷新暂时失败。':error.message||'保存失败，请检查网络后重试。');}}
 finally{dailyBusy=false;$('dailySubmitBtn').disabled=false;}
});
async function deleteDailyCheckin(id){
 const item=dailyRecords.find(r=>r.id===id&&r.author_id===currentProfile?.id);if(!item||dailyBusy||!confirm('确定删除自己的这条日常吗？'))return;
 const epoch=authEpoch;dailyBusy=true;let removed=false;
 try{
  const {data,error}=await sb.from('daily_checkins').delete().eq('id',id).select('id');if(error||!data?.length)throw error||Error();removed=true;
  if(isCurrent(epoch)){if(item.photo_key)await forgetCachedPhoto(item.photo_key);await loadDailyCheckins();if(item.photo_key)await removeImage(item.photo_key);}
 }catch{if(isCurrent(epoch)){cleanedFor=null;alert(removed?'记录已删除，照片清理暂未完成，下次登录会自动重试。':'删除失败，请刷新重试。');}}
 finally{dailyBusy=false;}
}
$('dailyList').addEventListener('click',event=>{
 const button=event.target.closest('[data-action]');if(!button)return;
 if(button.dataset.action==='edit')editDailyCheckin(button.dataset.id);
 else if(button.dataset.action==='delete')deleteDailyCheckin(button.dataset.id);
 else if(button.dataset.action==='retry-comments')loadCommentsForRecord(button.dataset.id);
 else if(button.dataset.action==='more-comments')loadCommentsForRecord(button.dataset.id,{more:true});
});
$('dailySourceNotices').addEventListener('click',event=>{
 const button=event.target.closest('[data-action]');if(!button)return;
 if(button.dataset.action==='retry-daily')loadDailyCheckins();
 else if(button.dataset.action==='retry-spots')loadLegacySpots(authEpoch,dailyRequest);
});
$('loadMoreDaily').addEventListener('click',loadMoreDailyCheckins);
$('dailyList').addEventListener('submit',event=>{const form=event.target.closest('[data-comment-form]');if(!form)return;event.preventDefault();submitDailyComment(form);});
const clearMoodData=window.clearPrivateData;
window.clearPrivateData=()=>{
 clearMoodData?.();dailyRecords=[];legacySpotRecords=[];dailyComments=[];commentBusy.clear();for(const state of commentStates.values())state.request++;commentStates.clear();commentQueue=[];dailyRequest++;spotRequest++;dailyCursor=null;dailyHasMore=false;dailyPageBusy=false;editingDailyId=null;
 $('dailySourceNotices')?.replaceChildren();resetDailyForm();updatePagination();
};
