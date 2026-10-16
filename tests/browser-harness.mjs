import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

export const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';

export async function app({missingSdk=false,brokenSdk=false,cacheFactory=new IDBFactory(),observer=false,sourceErrors={},sourceDelays={},authErrors={},mediaSource,timers}={}){
 const html=readFileSync('index.html','utf8'),dom=new JSDOM(html,{url:'https://love.invalid',runScripts:'outside-only'}),w=dom.window;
 let session=null,listener,reads=0,sessionChecks=0,intersection;
 const observed=new Set(),revoked=[],queries=[];
 if(observer)w.IntersectionObserver=class{constructor(fn){intersection=fn;}observe(img){observed.add(img)}unobserve(img){observed.delete(img)}};
 w.Blob=Blob;w.indexedDB=cacheFactory;w.clearTimeout=clearTimeout;
 const rows={profiles:[{id:A,role:'pengpeng',display_name:'朋朋'},{id:B,role:'kaikai',display_name:'开开'}],daily_checkins:[],daily_comments:[],mood_records:[],media_objects:[],spot_checkins:[]};
 const waitForSource=async table=>{const delay=sourceDelays[table];if(typeof delay==='number')await new Promise(resolve=>setTimeout(resolve,delay));else if(typeof delay==='function')await delay();else if(delay)await delay;};
 const sb={
  auth:{
   async getSession(){sessionChecks++;return {data:{session:authErrors.session?null:session},error:authErrors.session}},
   async getUser(){return {data:{user:session?.user||null},error:null}},
   async setSession(tokens){const profile=rows.profiles.find(row=>row.id===A);session={...tokens,user:{id:A},profile};return {data:{session},error:null}},
   async signOut(){session=null;listener?.('SIGNED_OUT',null);return {error:null}},
   onAuthStateChange(fn){listener=fn;return {data:{subscription:{unsubscribe(){}}}}}
  },
  from(table){
   reads++;let action='select',value,range=null,orFilter=null;
   const filters=[],inFilters=[],notFilters=[],orders=[];
   const q={
    select(){return q},
    order(key,{ascending=true}={}){orders.push({key,ascending});return q},
    range(from,to){range=[from,to];return q},
    or(expression){orFilter=expression;return q},
    eq(key,expected){filters.push([key,expected]);return q},
    neq(key,expected){notFilters.push([key,expected]);return q},
    in(key,values){inFilters.push([key,new Set(values)]);return q},
    insert(next){action='insert';value=next;return q},
    upsert(next){action='upsert';value=next;return q},
    update(next){action='update';value=next;return q},
    delete(){action='delete';return q},
    then(resolve,reject){
     return (async()=>{
      await waitForSource(table);
      queries.push({table,action,range,or:orFilter,filters:[...filters],inFilters:inFilters.map(([key,set])=>[key,[...set]]),notFilters:[...notFilters],orders:[...orders]});
      if(sourceErrors[table])return {data:null,error:sourceErrors[table]};
      const matches=row=>{
       if(!filters.every(([key,expected])=>row[key]===expected))return false;
       if(!notFilters.every(([key,expected])=>row[key]!==expected))return false;
       if(!inFilters.every(([key,values])=>values.has(row[key])))return false;
       if(orFilter?.startsWith('created_at.lt.')){
        const match=orFilter.match(/^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/);
        if(match&&!(String(row.created_at)<match[1]||(String(row.created_at)===match[2]&&String(row.id)<match[3])))return false;
       }
       return true;
      };
      const matched=rows[table].filter(matches);
      if(action==='upsert'){
       const existing=rows[table].find(row=>value.id&&row.id===value.id);
       if(existing)Object.assign(existing,value);else rows[table].push({id:value.id||'new',...value});
       return {data:[{...value}],error:null};
      }
      if(action==='insert'){
       const item={id:value.id||'new-'+rows[table].length,created_at:value.created_at||'2026-10-16T03:00:00Z',author_id:session?.user.id,...value};
       rows[table].push(item);return {data:[{...item}],error:null};
      }
      if(action==='update'){for(const row of matched)Object.assign(row,value);return {data:matched.map(row=>({...row})),error:null};}
      if(action==='delete'){const ids=new Set(matched);rows[table]=rows[table].filter(row=>!ids.has(row));return {data:matched.map(row=>({...row})),error:null};}
      let data=matched.map(row=>({...row}));
      if(orders.length)data.sort((left,right)=>{for(const {key,ascending} of orders){if(left[key]===right[key])continue;const comparison=left[key]<right[key]?-1:1;return ascending?comparison:-comparison;}return 0;});
      if(range)data=data.slice(range[0],range[1]+1);
      return {data,error:null};
     })().then(resolve,reject);
    }
   };
   return q;
  }
 };
 if(!missingSdk)w.supabase={createClient(){if(brokenSdk)throw Error('Initialization failed');return sb}};
 w.alert=()=>{};w.confirm=()=>true;w.setTimeout=timers||((fn,ms)=>ms>0&&ms<=5000?setTimeout(fn,0):0);w.setInterval=()=>0;
 w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=url=>revoked.push(url);w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.fetch=async()=>({ok:true,json:async()=>({access_token:'test',refresh_token:'test'})});
 w.createLoveClient=()=>w.supabase.createClient();
 const context=dom.getInternalVMContext();
 for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){
  const src=match[1].match(/src="([^"]+)"/);
  if(src){
   if(src[1].startsWith('http')||src[1].startsWith('assets/vendor/')||src[1]==='assets/session-client.js')continue;
   vm.runInContext(src[1]==='assets/media.js'&&mediaSource!==undefined?mediaSource:readFileSync(src[1],'utf8'),context,{filename:src[1]});
  }else vm.runInContext(match[2],context,{filename:'index.inline.js'});
 }
 const run=code=>vm.runInContext(code,context);
 const profile=id=>rows.profiles.find(row=>row.id===id);
 return {
  w,dom,rows,queries,run,revoked,
  visible(indices){const images=[...observed];intersection(images.map((target,index)=>({target,isIntersecting:indices.includes(index)})));},
  async idle(){for(let i=0;i<300;i++){if(run('photoActive===0&&photoQueue.length===0'))return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Photo queue did not settle');},
  reads:()=>reads,sessionChecks:()=>sessionChecks,
  login(id=A){session={access_token:'test',expires_at:Date.now()/1000+3600,user:{id},profile:profile(id)};},
  expire(){session=null;},
  emit(event){listener?.(event,session);},
  async close(){run('clearPrivateView()');dom.window.close();}
 };
}
