/* Shared authenticated state. Data loaders must discard responses from old epochs. */
let currentProfile=null;
let profileList=[];
let authEpoch=0;
let selectedRole=null;
let authSubscription=null;
const $=id=>document.getElementById(id);
const isCurrent=epoch=>Boolean(currentProfile)&&epoch===authEpoch;
function clearPrivateView(){
 authEpoch++;
 currentProfile=null; profileList=[];
 $('privateApp').hidden=true; $('authGate').hidden=false;
 $('dailyList').replaceChildren(); $('retryLogout').hidden=true;
 $('dailyForm').reset(); $('dailyPreview').removeAttribute('src'); $('dailyPreview').classList.remove('show');
 $('moodCalendarGrid').replaceChildren(); $('moodTodayNote').textContent='';
 closeMoodPopover(); closeLetter();
 window.clearPrivateData?.();
}
function chooseRole(role){
 selectedRole=role;
 $('roleChoices').hidden=true; $('passwordForm').hidden=false;
 $('loginName').textContent=role==='pengpeng'?'朋朋':'开开';
 $('loginPassword').value=''; $('authMessage').textContent=''; $('loginPassword').focus();
}
function showRoleChoices(){selectedRole=null;$('roleChoices').hidden=false;$('passwordForm').hidden=true;$('loginPassword').value='';}
async function restoreSession(){
 const epoch=++authEpoch;
 try {
  const {data:{session},error}=await sb.auth.getSession();
  if(error)throw error;
  if(epoch!==authEpoch)return;
  if(!session){clearPrivateView();showRoleChoices();$('authMessage').textContent='选择你的名字，回到我们的小日常。';return;}
  const {data:{user},error:ue}=await sb.auth.getUser();
  if(ue||!user)throw new Error('请重新登录');
  const {data,error:pe}=await sb.from('profiles').select('id,role,display_name');
  if(pe)throw new Error('账号信息暂时无法读取，请稍后重试');
  if(epoch!==authEpoch)return;
  const profile=data.find(p=>p.id===user.id&&['pengpeng','kaikai'].includes(p.role));
  if(!profile)throw new Error('此账号未获授权或登录已失效');
  currentProfile=profile; profileList=data;
  $('currentIdentity').textContent=`${profile.role==='pengpeng'?'☀️':'🌷'} ${profile.display_name}`;
  $('authGate').hidden=true;$('privateApp').hidden=false;$('loginPassword').value='';
  await window.loadPrivateData();
 }catch(error){if(epoch===authEpoch){clearPrivateView();showRoleChoices();$('authMessage').textContent=error.message||'登录验证失败，请重试';}}
}
async function logout(){
 clearPrivateView();showRoleChoices();$('authMessage').textContent='正在退出登录…';
 const {error}=await sb.auth.signOut({scope:'local'});
 $('authMessage').textContent=error?'暂时无法完成退出，请联网后点击重试退出。':'已退出登录。';
 $('retryLogout').hidden=!error;
}
$('passwordForm').addEventListener('submit',async event=>{
 event.preventDefault();const button=$('loginSubmit');button.disabled=true;
 $('authMessage').textContent='正在验证…';
 try{
  const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:selectedRole,password:$('loginPassword').value})});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'登录失败');
  const {error}=await sb.auth.setSession(result);if(error)throw error;
  await restoreSession();
 }catch(error){$('authMessage').textContent=error.message||'网络异常，请重试';}
 finally{button.disabled=false;$('loginPassword').value='';}
});
// Do not await SDK operations inside onAuthStateChange's lock.
authSubscription=sb.auth.onAuthStateChange((event,session)=>{
 if(event==='SIGNED_OUT'){clearPrivateView();showRoleChoices();}
 else if(event==='SIGNED_IN'&&session?.user.id!==currentProfile?.id){clearPrivateView();setTimeout(restoreSession,0);}
 else if(event==='TOKEN_REFRESHED'||event==='USER_UPDATED')setTimeout(restoreSession,0);
});
window.loadPrivateData=async()=>{renderTodayMood();renderMoodCalendar();await loadDailyCheckins();};
window.addEventListener('focus',()=>{if(currentProfile)restoreSession();});
window.addEventListener('pageshow',event=>{if(event.persisted){clearPrivateView();restoreSession();}});
// Later feature scripts install their data loaders before this runs.
setTimeout(restoreSession,0);
