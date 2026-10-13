import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import {JSDOM} from 'jsdom';
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
async function app({missingSdk=false,brokenSdk=false}={}){
 const html=readFileSync('index.html','utf8');const dom=new JSDOM(html,{url:'https://love.invalid',runScripts:'outside-only'}),w=dom.window;
 let session=null,listener,reads=0;const revoked=[];
 const rows={profiles:[{id:A,role:'pengpeng',display_name:'朋朋'},{id:B,role:'kaikai',display_name:'开开'}],daily_checkins:[],mood_records:[],media_objects:[]};
 const sb={auth:{async getSession(){return {data:{session}}},async getUser(){return {data:{user:session?.user}}},async setSession(tokens){session={...tokens,user:{id:A}};return {}},async signOut(){session=null;listener?.('SIGNED_OUT');return {}},onAuthStateChange(fn){listener=fn;return {data:{subscription:{unsubscribe(){}}}}}},from(table){reads++;let action='select',value,filters=[];const q={select(){return q},order(){return q},range(){return q},or(){return q},eq(k,v){filters.push([k,v]);return q},insert(v){action='insert';value=v;return q},upsert(v){action='upsert';value=v;return q},update(v){action='update';value=v;return q},delete(){action='delete';return q},then(resolve,reject){let data=rows[table].filter(r=>filters.every(([k,v])=>r[k]===v));if(action==='upsert'){rows[table].push({id:'new',...value});data=[value]}if(action==='insert'){rows[table].push({author_id:session.user.id,...value});data=[value]}if(action==='delete')rows[table]=rows[table].filter(r=>!data.includes(r));return Promise.resolve({data,error:null}).then(resolve,reject)}};return q}};
 if(!missingSdk)w.supabase={createClient(){if(brokenSdk)throw Error('Initialization failed');return sb}};w.alert=()=>{};w.confirm=()=>true;w.setTimeout=()=>0;w.setInterval=()=>0;w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=u=>revoked.push(u);w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.fetch=async()=>({ok:true,json:async()=>({access_token:'test',refresh_token:'test'})});
 const context=dom.getInternalVMContext();
 for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){const src=m[1].match(/src="([^"]+)"/);if(src){if(src[1].startsWith('http')||src[1].startsWith('assets/vendor/'))continue;vm.runInContext(readFileSync(src[1],'utf8'),context,{filename:src[1]});}else vm.runInContext(m[2],context,{filename:'index.inline.js'});}
 const run=code=>vm.runInContext(code,context);
 return {w,dom,rows,run,revoked,reads:()=>reads,login(id=A){session={access_token:'test',user:{id}}},expire(){session=null},async close(){dom.window.close()}};
}
test('missing or broken local SDK keeps login gated and shows a recoverable error',async()=>{
 for(const options of [{missingSdk:true},{brokenSdk:true}]){
  const a=await app(options);try{
   await a.run('restoreSession()');a.run("chooseRole('pengpeng')");
   assert(a.w.document.getElementById('privateApp').hidden);
   assert.match(a.w.document.getElementById('authMessage').textContent,options.missingSdk?/SDK_LOAD/:/SDK_INIT/);
   assert.equal(a.reads(),0);
   assert(a.w.document.getElementById('loginSubmit').disabled);
   assert(!a.w.document.getElementById('retryClient').hidden);
   assert.equal(a.run('sb'),null);
  }finally{a.close()}
 }
});
test('first visit stays gated with no private reads; restoration, both moods, edit permissions and logout',async()=>{const a=await app();try{
 await a.run('restoreSession()');assert(a.w.document.getElementById('privateApp').hidden);assert.equal(a.reads(),0);
 a.login();const today=a.run('getMoodDateKey()');a.rows.mood_records.push({id:'1',user_id:A,date:today,mood:'happy',note:'mine'},{id:'2',user_id:B,date:today,mood:'sweet',note:'partner'});
 a.rows.daily_checkins.push({id:'a',author_id:A,content:'mine',created_at:'2026-10-13T12:00:00Z'},{id:'b',author_id:B,content:'partner',created_at:'2026-10-13T12:00:00Z'},{id:'c',author_id:null,content:'legacy',created_at:'2026-10-13T12:00:00Z'});
 await a.run('restoreSession()');assert(!a.w.document.getElementById('privateApp').hidden);
 assert.match(a.w.document.getElementById('currentIdentity').textContent,/朋朋/);
 assert.equal(a.w.document.querySelectorAll('[data-action="delete"]').length,1);
 assert.match(a.w.document.getElementById('dailyList').textContent,/历史记录/);
 const cell=a.w.document.querySelector(`[data-date="${today}"]`);assert.match(cell.textContent,/😊/);assert.match(cell.textContent,/💗/);
 a.run(`openMoodPopover('${today}')`);assert.match(a.w.document.getElementById('moodViewBox').textContent,/partner/);
 a.run("mediaUrls.add('blob:secret')");await a.run('logout()');assert(a.w.document.getElementById('privateApp').hidden);assert.equal(a.w.document.getElementById('dailyList').textContent,'');assert.equal(a.w.document.getElementById('moodViewBox').textContent,'');assert(a.revoked.includes('blob:secret'));
 a.login(B);await a.run('restoreSession()');assert.match(a.w.document.getElementById('currentIdentity').textContent,/开开/);assert.equal(a.w.document.querySelector('[data-action="delete"]').dataset.id,'b');
 assert.equal(a.run("getMoodDateKey(new Date('2026-10-13T16:00:00Z'))"),'2026-10-14');
 assert.equal(a.w.document.querySelectorAll('audio').length,0);
}finally{a.close()}});
test('unknown account remains gated and old local moods stay untouched',async()=>{const a=await app();try{a.w.localStorage.setItem('loveDailyMoodRecordsV1','{"old":"kept"}');a.login('unknown');await a.run('restoreSession()');assert(a.w.document.getElementById('privateApp').hidden);assert.equal(a.w.localStorage.getItem('loveDailyMoodRecordsV1'),'{"old":"kept"}');}finally{a.close()}});
test('late photo response after logout cannot be displayed',async()=>{const a=await app();try{a.login();await a.run('restoreSession()');let finish;a.w.fetch=()=>new Promise(r=>{finish=r});const promise=a.run("mediaFetch('/api/media/key')");await new Promise(r=>setImmediate(r));await a.run('logout()');finish({ok:true,blob:async()=>new Blob(['secret'])});await assert.rejects(promise);}finally{a.close()}});
test('loading a private photo preserves the record text and author buttons',async()=>{const a=await app();try{a.login();a.rows.daily_checkins.push({id:'a',author_id:A,content:'keep this text',photo_key:'daily/key',created_at:'2026-10-13T12:00:00Z'});a.w.fetch=async()=>({ok:true,blob:async()=>new a.w.Blob(['image'])});await a.run('restoreSession()');assert.match(a.w.document.getElementById('dailyList').textContent,/keep this text/);assert(a.w.document.querySelector('[data-action="delete"]'));assert.equal(a.w.document.querySelector('[data-media-key]').src,'blob:test');}finally{a.close()}});
