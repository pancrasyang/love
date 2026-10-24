/* Shared authenticated state. Data loaders must discard responses from old epochs. */
let currentProfile=null;
let profileList=[];
let authEpoch=0;
let selectedRole=null;
let authSubscription=null;
let restoreFlight=null;
const $=id=>document.getElementById(id);
const isCurrent=epoch=>Boolean(currentProfile)&&epoch===authEpoch;
const sessionFailureCodes=new Set(['SESSION_REQUIRED','SESSION_INVALID','AUTH_REFRESH','AUTH_USER','PROFILE_ACCESS','PROFILE_DENIED']);
const isSessionFailure=error=>sessionFailureCodes.has(error?.code);
function clientReady(){return typeof sb!=='undefined'&&Boolean(sb?.auth);}
function showClientError(){
 $('privateApp').hidden=true;$('authGate').hidden=false;
 $('authMessage').textContent=typeof sdkInitError!=='undefined'&&sdkInitError||'登录组件未能初始化，请重新加载页面。';
 $('loginSubmit').disabled=true;$('retryClient').hidden=false;
}
function clearPrivateView(){
 authEpoch++;
 restoreFlight=null;
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
 if(!clientReady())showClientError();
}
function showRoleChoices(){selectedRole=null;$('roleChoices').hidden=false;$('passwordForm').hidden=true;$('loginPassword').value='';}
async function restoreSession(){
 if(!clientReady()){showClientError();return;}
 if(restoreFlight)return restoreFlight;
 const epoch=authEpoch;
 const flight=(async()=>{
  let restoredUserId=null;
  try {
   const {data:{session},error}=await sb.auth.getSession();
   if(error)throw error;if(epoch!==authEpoch)return;
   if(!session){clearPrivateView();showRoleChoices();$('authMessage').textContent='选择你的名字，回到我们的小日常。';return;}
   restoredUserId=session.user?.id;
   const profile=session.profile;
   if(!profile||profile.id!==restoredUserId||!['pengpeng','kaikai'].includes(profile.role))throw Object.assign(new Error('此账号未获授权或登录已失效'),{code:'PROFILE_DENIED'});
   if(currentProfile&&currentProfile.id!==profile.id){clearPrivateView();return restoreSession();}
   const hadPrivateView=currentProfile?.id===profile.id;
   currentProfile=profile;profileList=[profile,...profileList.filter(item=>item.id!==profile.id)];
   $('currentIdentity').textContent=`${profile.role==='pengpeng'?'☀️':'🌷'} ${profile.display_name}`;
   $('authGate').hidden=true;$('privateApp').hidden=false;$('loginPassword').value='';
   if($('dailyStatus').querySelector('.session-retry'))$('dailyStatus').replaceChildren();
   // Pause only after the server confirms the session. A temporary validation outage keeps the existing view alive.
   window.pausePhotoLoads?.();
   const privateData=Promise.resolve().then(()=>hadPrivateView&&window.refreshPrivateData?window.refreshPrivateData():window.loadPrivateData());
   const partnerProfile=(async()=>{
    try{
     const {data,error}=await sb.from('profiles').select('id,role,display_name').neq('id',profile.id);
     if(epoch!==authEpoch||currentProfile?.id!==profile.id)return;
     if(error){if(isSessionFailure(error))throw error;setStatus('dailyStatus','对方昵称暂时无法同步，照片与记录仍可使用。');return;}
     profileList=[profile,...(data||[]).filter(item=>item.id!==profile.id&&['pengpeng','kaikai'].includes(item.role))];window.refreshPrivateNames?.();
    }catch(error){if(epoch===authEpoch&&currentProfile?.id===profile.id&&isSessionFailure(error))throw error;}
   })();
   await Promise.all([privateData,partnerProfile]);
  }catch(error){if(epoch===authEpoch){
   if(currentProfile&&(!restoredUserId||restoredUserId===currentProfile.id)&&!isSessionFailure(error)){
    setStatus('dailyStatus','暂时无法复核登录状态，请稍后重试。');
    const button=document.createElement('button');button.type='button';button.className='ghost small-button session-retry';button.textContent='重试验证';button.onclick=restoreSession;$('dailyStatus').append(button);
   }else{clearPrivateView();showRoleChoices();$('authMessage').textContent=(error.message||'登录验证失败，请重试')+(error.code?'（'+error.code+'）':'');}
  }}
 })();
 restoreFlight=flight;try{return await flight;}finally{if(restoreFlight===flight)restoreFlight=null;}
}
async function logout(){
 if(!clientReady()){showClientError();return;}
 clearPrivateView();showRoleChoices();$('authMessage').textContent='正在退出登录…';
 const {error}=await sb.auth.signOut({scope:'local'});
 $('authMessage').textContent=error?'暂时无法完成退出，请联网后点击重试退出。':'已退出登录。';
 $('retryLogout').hidden=!error;
}
$('passwordForm').addEventListener('submit',async event=>{
 event.preventDefault();if(!clientReady()){showClientError();return;}const button=$('loginSubmit');button.disabled=true;
 $('authMessage').textContent='正在验证…';
 try{
  const response=await fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Love-Request':'1'},body:JSON.stringify({role:selectedRole,password:$('loginPassword').value})});
  const result=await response.json();if(!response.ok)throw new Error((result.error||'登录失败')+(result.code?'（'+result.code+'）':''));
  const {error}=await sb.auth.setSession(result);if(error)throw error;
  await restoreSession();
 }catch(error){$('authMessage').textContent=error.message||'网络异常，请重试';}
 finally{button.disabled=false;$('loginPassword').value='';}
});
// Do not await SDK operations inside onAuthStateChange's lock.
authSubscription=clientReady()?sb.auth.onAuthStateChange((event,session)=>{
 if(event==='SIGNED_OUT'){clearPrivateView();showRoleChoices();}
 else if(event==='SIGNED_IN'&&session?.user.id!==currentProfile?.id){clearPrivateView();setTimeout(restoreSession,0);}
 else if(event==='TOKEN_REFRESHED'||event==='USER_UPDATED'||event==='SESSION_CHANGED')setTimeout(restoreSession,0);
}):null;
window.loadPrivateData=async()=>{renderTodayMood();renderMoodCalendar();await loadDailyCheckins();};
window.addEventListener('focus',()=>{if(currentProfile)restoreSession();});
window.addEventListener('pageshow',event=>{if(event.persisted)restoreSession();});
// Later feature scripts install their data loaders before this runs.
if(clientReady())setTimeout(restoreSession,0);else showClientError();
