/* Private, account-scoped application cache. HTTP responses remain no-store. */
function createLovePhotoCache({factory,name='love-private-photos-v1',limit=200*1024*1024,ttl=30*86400000,now=()=>Date.now()}={}){
 try{if(factory===undefined)factory=window.indexedDB;}catch{factory=null;}
 const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 let opening;
 async function database(){
  if(!factory)return null;
  if(!opening)opening=new Promise((resolve,reject)=>{
   const r=factory.open(name,1);
   r.onupgradeneeded=()=>{for(const store of ['meta','photos','control'])r.result.createObjectStore(store,{keyPath:'id'});};
   r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
   r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('CACHE_BLOCKED'));
  }).catch(()=>null);
  return opening;
 }
 async function transaction(action){
  const db=await database();if(!db)return null;
  const tx=db.transaction(['meta','photos','control'],'readwrite');
  const finished=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('CACHE_ABORTED'));});
  try{const value=await action(Object.fromEntries(['meta','photos','control'].map(k=>[k,tx.objectStore(k)])));await finished;return value;}
  catch(error){try{tx.abort();}catch{}await finished.catch(()=>{});throw error;}
 }
 const remove=(stores,id)=>{stores.meta.delete(id);stores.photos.delete(id);};
 return {
  async ticket(){try{return await transaction(async s=>(await request(s.control.get('generation')))?.value||0);}catch{return null;}},
  async get(id){try{return await transaction(async s=>{
   const meta=await request(s.meta.get(id));if(!meta)return null;
   if(meta.expiresAt<=now()){remove(s,id);return null;}
   const data=await request(s.photos.get(id));if(!data?.blob||data.blob.size!==meta.size){remove(s,id);return null;}
   meta.lastAccess=now();s.meta.put(meta);return {blob:data.blob,...meta};
  });}catch{return null;}},
  async put(meta,blob,ticket){
   if(ticket===null||!blob||blob.size>limit)return false;
   async function save(){return transaction(async s=>{
    const generation=(await request(s.control.get('generation')))?.value||0;if(generation!==ticket)return false;
    const rows=await request(s.meta.getAll());let total=0;const keep=[];
    for(const row of rows){if(row.id===meta.id||row.expiresAt<=now()||(row.account===meta.account&&row.ref===meta.ref)){remove(s,row.id);}else{keep.push(row);total+=row.size;}}
    keep.sort((a,b)=>a.lastAccess-b.lastAccess);
    while(total+blob.size>limit&&keep.length){const row=keep.shift();remove(s,row.id);total-=row.size;}
    s.meta.put({...meta,size:blob.size,createdAt:now(),expiresAt:now()+ttl,lastAccess:now()});s.photos.put({id:meta.id,blob});return true;
   });}
   try{return Boolean(await save());}catch(error){
    if(error?.name!=='QuotaExceededError')return false;
    // Browser quota may be below the configured cap. Make space and retry once.
    await this.trim(Math.max(0,limit/2));try{return Boolean(await save());}catch{return false;}
   }
  },
  async remove(id){try{await transaction(async s=>remove(s,id));}catch{}},
  // Pagination is not proof of deletion. Only expiry or an explicit server-confirmed ref is pruned here.
  async prune(account,{removeRefs=[]}={}){try{const refs=new Set(removeRefs);await transaction(async s=>{for(const row of await request(s.meta.getAll()))if(row.expiresAt<=now()||(row.account===account&&refs.has(row.ref)))remove(s,row.id);});}catch{}},
  async trim(target=limit){try{await transaction(async s=>{const rows=await request(s.meta.getAll());let total=rows.reduce((n,r)=>n+r.size,0);rows.sort((a,b)=>a.lastAccess-b.lastAccess);for(const row of rows)if(row.expiresAt<=now()||total>target){remove(s,row.id);total-=row.size;}});}catch{}},
  async clear(){try{return await transaction(async s=>{const value=((await request(s.control.get('generation')))?.value||0)+1;s.meta.clear();s.photos.clear();s.control.put({id:'generation',value});return value;});}catch{return null;}},
  async stats(){try{return await transaction(async s=>{const rows=await request(s.meta.getAll());return {count:rows.length,bytes:rows.reduce((n,r)=>n+r.size,0),available:true};})||{count:0,bytes:0,available:false};}catch{return {count:0,bytes:0,available:false};}}
 };
}
