// V2 deliberately leaves loveDailyMoodRecordsV1 untouched (user requested no migration).
const moodMap={happy:{icon:'😊',label:'开心'},sweet:{icon:'💗',label:'超甜'},miss:{icon:'🥺',label:'想你'},calm:{icon:'🌙',label:'平静'},tired:{icon:'😴',label:'疲惫'},sad:{icon:'🌧️',label:'低落'}};
let moodRecords=[],selectedMood=null,selectedMoodDateKey=null,moodLoading=false,moodRequest=0;
function getMoodDateKey(date=new Date()){return new Date(date.getTime()+8*3600000).toISOString().slice(0,10);}
let moodViewMonth=getMoodDateKey().slice(0,7);
function nameOf(id){return profileList.find(p=>p.id===id)?.display_name||'历史记录';}
function recordsOn(date){return moodRecords.filter(r=>r.date===date).sort((a,b)=>nameOf(a.user_id).localeCompare(nameOf(b.user_id)));}
function myMood(date){return moodRecords.find(r=>r.date===date&&r.user_id===currentProfile?.id);}
async function loadMoods(){
 if(!currentProfile)return;const epoch=authEpoch,request=++moodRequest;
 const start=moodViewMonth+'-01';const d=new Date(start+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);const end=d.toISOString().slice(0,10);
 // Month query + today's records keeps requests bounded even after many years.
 const today=getMoodDateKey();
 const {data,error}=await sb.from('mood_records').select('*').or(`and(date.gte.${start},date.lt.${end}),date.eq.${today}`);
 if(!isCurrent(epoch)||request!==moodRequest)return;
 if(error){$('moodSyncStatus').textContent='心情加载失败，请点击刷新重试。';return;}
 moodRecords=data||[];$('moodSyncStatus').textContent='北京时间 · 双方心情自动同步';renderTodayMood();renderMoodCalendar();
}
function renderTodayMood(){
 const records=recordsOn(getMoodDateKey());
 $('moodTodayDate').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit'}).format(new Date());
 $('moodTodayIcon').textContent=records.map(r=>moodMap[r.mood]?.icon||'♡').join(' ')||'♡';
 $('moodTodayText').textContent=records.map(r=>`${nameOf(r.user_id)}：${moodMap[r.mood]?.label||''}`).join(' · ')||'今天还没有打卡';
 $('moodTodayNote').textContent=myMood(getMoodDateKey())?.note||'点击今天，为自己记录一份心情。';
}
function renderMoodCalendar(){
 const [year,month]=moodViewMonth.split('-').map(Number);$('moodMonthTitle').textContent=`${year}年${month}月`;
 const first=new Date(Date.UTC(year,month-1,1)).getUTCDay();const count=new Date(Date.UTC(year,month,0)).getUTCDate();
 const cells=Array.from({length:first},()=>'<div class="mood-day is-empty"></div>');
 for(let day=1;day<=count;day++){
  const key=`${moodViewMonth}-${String(day).padStart(2,'0')}`;
  const icons=recordsOn(key).map(r=>`<span title="${escapeHtml(nameOf(r.user_id))}">${moodMap[r.mood]?.icon||'♡'}</span>`).join('');
  cells.push(`<button type="button" class="mood-day ${key===getMoodDateKey()?'is-today':''}" data-date="${key}" aria-label="${key} 心情"><span class="mood-day-icon">${icons}</span><span class="mood-day-number">${day}</span></button>`);
 }
 $('moodCalendarGrid').innerHTML=cells.join('');
}
function openMoodPopover(date){
 if(!currentProfile)return;selectedMoodDateKey=date;
 const mine=myMood(date),canEdit=date===getMoodDateKey();selectedMood=mine?.mood||null;
 $('moodNoteInput').value=mine?.note||'';$('moodPopoverDate').textContent=date;
 $('moodPopover').classList.toggle('readonly',!canEdit);$('moodPopover').classList.toggle('no-record',!mine);
 $('moodPopoverTip').textContent=canEdit?'只编辑自己的今日心情；下方可查看双方记录。':'历史心情只能查看，可以删除自己的记录。';
 $('moodViewBox').classList.add('show');$('moodViewBox').style.display='block';
 $('moodViewBox').innerHTML=recordsOn(date).map(r=>`<p><strong>${escapeHtml(nameOf(r.user_id))} ${moodMap[r.mood]?.icon||'♡'} ${moodMap[r.mood]?.label||''}</strong>${escapeHtml(r.note||'没有备注')}</p>`).join('<hr>')||'<p>这一天还没有心情记录。</p>';
 $('moodSaveButton').textContent=mine?'更新今日心情':'保存今日心情';$('moodDeleteButton').textContent='删除我的记录';
 updateMoodOptionActive();$('moodPopover').classList.add('show');$('moodPopover').setAttribute('aria-hidden','false');
}
function closeMoodPopover(){$('moodPopover').classList.remove('show');$('moodPopover').setAttribute('aria-hidden','true');}
function updateMoodOptionActive(){document.querySelectorAll('.mood-option').forEach(b=>b.classList.toggle('active',b.dataset.mood===selectedMood));}
async function saveSelectedMood(){
 if(!currentProfile||moodLoading)return;
 if(selectedMoodDateKey!==getMoodDateKey())return alert('只能新增或修改北京时间今天的心情。');
 if(!selectedMood)return alert('请先选择心情。');
 const epoch=authEpoch;moodLoading=true;$('moodSaveButton').disabled=true;
 try{
  const {error}=await sb.from('mood_records').upsert({user_id:currentProfile.id,date:selectedMoodDateKey,mood:selectedMood,note:$('moodNoteInput').value.trim()},{onConflict:'user_id,date'});
  if(error)throw error;if(!isCurrent(epoch))return;await loadMoods();closeMoodPopover();throwHearts();
 }catch{if(isCurrent(epoch))alert('心情保存失败，请检查网络后重试。');}
 finally{moodLoading=false;$('moodSaveButton').disabled=false;}
}
async function clearSelectedMood(){
 const row=myMood(selectedMoodDateKey);if(!row||moodLoading||!confirm('删除自己的这条心情吗？'))return;
 const epoch=authEpoch;moodLoading=true;
 try{const {data,error}=await sb.from('mood_records').delete().eq('id',row.id).select('id');if(error||!data?.length)throw error||Error();if(isCurrent(epoch)){await loadMoods();closeMoodPopover();}}
 catch{if(isCurrent(epoch))alert('删除失败，请刷新重试。');}finally{moodLoading=false;}
}
function changeMoodMonth(offset){const d=new Date(moodViewMonth+'-01T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+offset);moodViewMonth=d.toISOString().slice(0,7);closeMoodPopover();loadMoods();}
$('moodCalendarGrid').addEventListener('click',e=>{const key=e.target.closest('[data-date]')?.dataset.date;if(key)openMoodPopover(key);});
document.querySelectorAll('.mood-option').forEach(button=>button.addEventListener('click',()=>{if(selectedMoodDateKey===getMoodDateKey()){selectedMood=button.dataset.mood;updateMoodOptionActive();}}));
$('moodPopover').addEventListener('click',e=>{if(e.target===$('moodPopover'))closeMoodPopover();});
$('refreshMoods').addEventListener('click',loadMoods);
window.loadPrivateData=async()=>{await Promise.all([loadDailyCheckins(),loadMoods()]);};
window.clearPrivateData=()=>{moodRecords=[];moodRequest++;$('moodViewBox').replaceChildren();$('moodNoteInput').value='';$('moodTodayText').textContent='';$('moodTodayIcon').textContent='♡';};
setInterval(()=>{if(currentProfile&&!document.hidden)loadPrivateData();},30000);
