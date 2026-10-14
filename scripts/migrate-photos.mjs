/** Run only in a trusted administrator shell; secrets are read from environment.
 * Default is dry-run. --apply copies + verifies + links, never deletes old files.
 */
import {createHash,createHmac} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {inspectImage} from '../worker/src/image-type.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const encode=s=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export function sourcePath(row,base,bucket){
 if(row.photo_path){const p=row.photo_path;if(p.startsWith('/')||p.split('/').some(x=>x==='..'||x===''))throw Error('Unsafe source path');return p;}
 const url=new URL(row.photo_url),prefix=`/storage/v1/object/public/${bucket}/`;
 if(url.origin!==new URL(base).origin||!url.pathname.startsWith(prefix))throw Error('Unknown photo host; review manually');
 const p=decodeURIComponent(url.pathname.slice(prefix.length));if(p.split('/').some(x=>x==='..'||x===''))throw Error('Unsafe source path');return p;
}
export function signedS3(method,key,body,cfg,now=new Date(),contentType=''){
 const pathname='/'+[cfg.bucket,...key.split('/')].map(encode).join('/');
 const url=new URL(pathname,cfg.endpoint),stamp=now.toISOString().replace(/[:-]|\.\d{3}/g,''),date=stamp.slice(0,8),payload=hash(body||'');
 const names=(contentType?'content-type;':'')+'host;x-amz-content-sha256;x-amz-date';
 const canonical=[method,pathname,'',`${contentType?'content-type:'+contentType+'\n':''}host:${url.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${stamp}\n`,names,payload].join('\n');
 const scope=`${date}/auto/s3/aws4_request`;
 const kDate=hmac('AWS4'+cfg.secret,date),kRegion=hmac(kDate,'auto'),kService=hmac(kRegion,'s3'),kSigning=hmac(kService,'aws4_request');
 const signature=hmac(kSigning,['AWS4-HMAC-SHA256',stamp,scope,hash(canonical)].join('\n')).toString('hex');
 return {url:url.href,options:{method,headers:{...(contentType?{'Content-Type':contentType}:{}),'x-amz-content-sha256':payload,'x-amz-date':stamp,Authorization:`AWS4-HMAC-SHA256 Credential=${cfg.access}/${scope}, SignedHeaders=${names}, Signature=${signature}`},...(body?{body}: {})}};
}
export async function migrate({apply=false,env=process.env,fetcher=fetch,reportPath='migration-report.local.json'}={}){
 const base=env.SUPABASE_URL,key=env.SUPABASE_SERVICE_ROLE_KEY,bucket=env.SUPABASE_PHOTO_BUCKET||'love-photos';
 if(!base||!key)throw Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the trusted shell');
 const dbHeaders={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key})};
 const cfg={endpoint:env.R2_ENDPOINT,bucket:'love-media',access:env.R2_ACCESS_KEY_ID,secret:env.R2_SECRET_ACCESS_KEY};
 if(apply&&(!cfg.endpoint||!cfg.access||!cfg.secret))throw Error('Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
 if(cfg.endpoint&&(!/^https:\/\/[a-zA-Z0-9]+\.r2\.cloudflarestorage\.com\/?$/.test(cfg.endpoint)))throw Error('Invalid R2 endpoint');
 async function db(path,options={}){const r=await fetcher(base+'/rest/v1/'+path,{...options,headers:{...dbHeaders,'Content-Type':'application/json',...options.headers}});if(!r.ok)throw Error('Database request failed: HTTP '+r.status);const t=await r.text();return t?JSON.parse(t):null;}
 async function object(method,key,body,contentType){const signed=signedS3(method,key,body,cfg,new Date(),contentType);const r=await fetcher(signed.url,signed.options);if(!r.ok)throw Error('R2 request failed: HTTP '+r.status);return r;}
 const rows=[];for(const table of ['daily_checkins','spot_checkins']){for(let offset=0;;offset+=200){const columns=table==='daily_checkins'?'id,author_id,photo_url,photo_path,photo_key':'id,photo_url,photo_path,photo_key';const page=await db(`${table}?select=${columns}&order=id&offset=${offset}&limit=200`);rows.push(...page.map(row=>({author_id:null,...row,source_table:table,business_type:table==='daily_checkins'?'daily':'spot'})));if(page.length<200)break;}}
 const report={mode:apply?'apply':'dry-run',started_at:new Date().toISOString(),record_count:rows.length,items:[]};
 for(const row of rows){
  if(!row.photo_path&&!row.photo_url&&!row.photo_key)continue;
  const result={id:row.id,source_table:row.source_table};report.items.push(result);
  try{
   if(row.photo_key){
    if(!apply){result.status='already-linked-needs-r2-verification';continue;}
    const registry=await db(`media_objects?key=eq.${encodeURIComponent(row.photo_key)}&select=sha256,size_bytes,record_id,content_type,business_type,owner_id,state`);
    const response=await object('GET',row.photo_key),bytes=new Uint8Array(await response.arrayBuffer());
    if(registry.length!==1||registry[0].record_id!==row.id||registry[0].sha256!==hash(bytes)||registry[0].size_bytes!==bytes.length)throw Error('Existing R2 metadata/hash mismatch');
    if(registry[0].business_type!==row.business_type||registry[0].owner_id!==row.author_id||registry[0].state!=='ready'||(response.headers.get('Content-Type')||'').split(';')[0]!==registry[0].content_type||inspectImage(bytes).type!==registry[0].content_type)throw Error('Existing R2 MIME/association mismatch');
    // For migrated legacy records, also recheck source bytes to prove source equality.
    if(row.photo_path||row.photo_url){const path=sourcePath(row,base,bucket);const source=await fetcher(`${base}/storage/v1/object/authenticated/${encode(bucket)}/${path.split('/').map(encode).join('/')}`,{headers:dbHeaders});if(!source.ok)throw Error('Legacy source download failed');if(hash(new Uint8Array(await source.arrayBuffer()))!==hash(bytes))throw Error('Legacy source differs from R2');}
    result.sha256=hash(bytes);result.status='verified-existing';continue;
   }
   const path=sourcePath(row,base,bucket);
   const source=await fetcher(`${base}/storage/v1/object/authenticated/${encode(bucket)}/${path.split('/').map(encode).join('/')}`,{headers:dbHeaders});if(!source.ok)throw Error('Source download failed: HTTP '+source.status);
   const bytes=new Uint8Array(await source.arrayBuffer()),image=inspectImage(bytes),digest=hash(bytes);
   const dest=`${row.business_type}/${row.id}/${row.author_id||'legacy'}/${digest}.${image.ext}`;
   result.key=dest;result.previous_photo_key=row.photo_key||null;result.sha256=digest;result.size=bytes.length;result.content_type=image.type;
   if(!apply){result.status='ready';continue;}
   await object('PUT',dest,bytes,image.type);
   const response=await object('GET',dest),copied=new Uint8Array(await response.arrayBuffer());if(hash(copied)!==digest||copied.length!==bytes.length)throw Error('R2 verification mismatch; not linked');
   if((response.headers.get('Content-Type')||'').split(';')[0]!==image.type||inspectImage(copied).type!==image.type)throw Error('R2 MIME verification mismatch; not linked');
   const existing=await db(`media_objects?key=eq.${encodeURIComponent(dest)}&select=sha256,record_id,owner_id,content_type,size_bytes,business_type,state`);
   if(existing.length){if(existing[0].sha256!==digest||existing[0].record_id!==row.id||existing[0].owner_id!==row.author_id||existing[0].content_type!==image.type||existing[0].size_bytes!==bytes.length||existing[0].business_type!==row.business_type||existing[0].state!=='ready')throw Error('Registry conflict');}
   else await db('media_objects',{method:'POST',body:JSON.stringify({key:dest,record_id:row.id,business_type:row.business_type,owner_id:row.author_id,content_type:image.type,size_bytes:bytes.length,sha256:digest})});
   const linked=await db(`${row.source_table}?id=eq.${row.id}&photo_key=is.null`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({photo_key:dest})});
   if(linked?.length!==1)throw Error('Record changed concurrently; not overwritten');
   result.status='copied-verified-linked';
  }catch(e){result.status='failed';result.error=e.message;}
  finally{writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});}
 }
 report.completed_at=new Date().toISOString();report.failed=report.items.filter(r=>r.status==='failed').length;
 writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const r=await migrate({apply:process.argv.includes('--apply')});console.log(JSON.stringify({mode:r.mode,records:r.record_count,photos:r.items.length,failed:r.failed}));if(r.failed)process.exitCode=1;}
 catch(e){console.error(e.message);process.exitCode=1;}
}
