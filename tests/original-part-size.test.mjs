import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PART_SIZE,PART_SIZES,partBounds,originalPartSize,requestPartSize,MAX_R2_BYTES,MAX_LEGACY_BYTES} from '../server/photo-parts.mjs';
import {fixture,MiB,sha} from './original-part-harness.mjs';

test('all part sizes cover exact boundaries, plus-one boundaries and short tails without gaps or overlap',()=>{
 for(const partSize of PART_SIZES)for(const size of [1,partSize-1,partSize,partSize+1,6*MiB,10*MiB]){
  let next=0;for(let part=0;part<Math.ceil(size/partSize);part++){const b=partBounds(part,partSize,size);assert.equal(b.start,next);assert.equal(b.count,Math.ceil(size/partSize));assert(b.end>=b.start&&b.end-b.start+1<=partSize);next=b.end+1;}assert.equal(next,size);assert.throws(()=>partBounds(Math.ceil(size/partSize),partSize,size));
 }
 assert.equal(MAX_R2_BYTES,10*MiB);assert.equal(MAX_LEGACY_BYTES,20*MiB);assert.equal(DEFAULT_PART_SIZE,MiB);
});

test('binary API and unchanged Worker assemble identical SHA-256 at 1/2/3MiB, in both authorization paths',async()=>{
 for(const delegated of [false,true])for(const partSize of PART_SIZES)await fixture(Buffer.alloc(6*MiB+1,37),async h=>{
  process.env.PHOTO_ORIGINAL_PART_SIZE=String(partSize);
  const meta=await h.call('meta=1');assert.equal(meta.statusCode,200);assert.equal(meta.body.part_size,partSize);assert.equal(h.counts.reads,0);
  const parts=[];for(let part=0;part<Math.ceil(h.row.size_bytes/partSize);part++){
   const before=h.counts.auth,r=await h.call(`part=${part}&part_size=${partSize}&version=${h.row.sha256}`),b=partBounds(part,partSize,h.row.size_bytes);
   assert.equal(r.statusCode,206);assert.equal(r.headers['content-range'],`bytes ${b.start}-${b.end}/${h.row.size_bytes}`);assert.equal(r.body.length,b.end-b.start+1);assert(Buffer.isBuffer(r.body));assert.equal(r.headers['content-type'],'image/jpeg');assert.equal(r.headers['cache-control'],'private, no-store');assert.equal(r.headers['x-media-version'],h.row.sha256);assert(h.counts.auth>before);parts.push(r.body);
  }
  assert.equal(sha(Buffer.concat(parts)),h.row.sha256);assert.equal(h.counts.bytes,h.row.size_bytes);
 },{delegated});
});

test('server-selected single and batch metadata agree; config rollback never reinterprets explicit in-flight offsets',async()=>{
 await fixture(Buffer.alloc(6*MiB,7),async h=>{
  for(const partSize of PART_SIZES){process.env.PHOTO_ORIGINAL_PART_SIZE=String(partSize);assert.equal((await h.call('meta=1')).body.part_size,partSize);assert.equal((await h.batch()).body.results[0].part_size,partSize);}
  process.env.PHOTO_ORIGINAL_PART_SIZE=String(MiB);
  for(const partSize of PART_SIZES){const r=await h.call(`part=1&part_size=${partSize}&version=${h.row.sha256}`);assert.equal(r.statusCode,206);assert.equal(r.headers['content-range'],`bytes ${partSize}-${2*partSize-1}/${6*MiB}`);}
  process.env.PHOTO_ORIGINAL_PART_SIZE=String(3*MiB);
  const old=await h.call('part=1');assert.equal(old.statusCode,206);assert.equal(old.headers['content-range'],`bytes ${MiB}-${2*MiB-1}/${6*MiB}`);
  process.env.PHOTO_ORIGINAL_PART_SIZE='4000000';assert.equal((await h.call('meta=1')).body.code,'MEDIA_PART_CONFIG');
  assert.equal((await h.call(`part=0&part_size=${2*MiB}&version=${h.row.sha256}`)).statusCode,206);
 });
});

test('strict part parameters reject duplicates, abnormal numbers and non-original use before credentials or R2',async()=>{
 await fixture(Buffer.alloc(7),async h=>{
  const v=h.row.sha256;
  const bad=['part=-1','part=1.5','part=1e0','part=NaN','part=Infinity','part=9007199254740992','part=00','part=','part=0&part=0',`part=0&version=${v}&part_size=0`,`part=0&version=${v}&part_size=1048577`,`part=0&version=${v}&part_size=2097152.0`,`part=0&version=${v}&part_size=2e6`,`part=0&version=${v}&part_size=2097152&part_size=2097152`,`part=0&part_size=2097152`,`meta=1&part_size=2097152`,`part=0&version=${v}&part_size=2097152&variant=thumbnail`];
  for(const q of bad){const r=await h.call(q);assert.equal(r.statusCode,400,q);assert.equal(r.body.code,'MEDIA_INPUT',q);}assert.equal(h.counts.auth,0);assert.equal(h.counts.reads,0);
  assert.throws(()=>requestPartSize(new URL(`https://test/?source=legacy&part=0&version=${v}&part_size=2097152`)));
  assert.equal(originalPartSize(),MiB);
 });
});

test('out-of-range, stale, anonymous, detached and revoked segments do not read R2 at any size',async()=>{
 for(const partSize of PART_SIZES)await fixture(Buffer.alloc(partSize+1,9),async h=>{
  const query=`part=0&part_size=${partSize}&version=${h.row.sha256}`;
  assert.equal((await h.call(query,{})).statusCode,401);
  assert.equal((await h.call(query.replace(h.row.sha256,'a'.repeat(64)))).statusCode,412);
  assert.equal((await h.call(query.replace('part=0','part=2'))).statusCode,416);assert.equal(h.counts.reads,0);
  assert.equal((await h.call(query)).statusCode,206);const reads=h.counts.reads;h.detach();assert.equal((await h.call(query)).statusCode,404);h.revoke();assert.equal((await h.call(query)).statusCode,401);assert.equal(h.counts.reads,reads);
 });
});

test('API refuses wrong ranges, versions, MIME, oversized and truncated segment bodies',async()=>{
 for(const delegated of [false,true])for(const fault of ['range','version','mime','extra','truncated','status'])await fixture(Buffer.alloc(2*MiB+1,7),async h=>{
  h.mutate(async r=>{
   const bytes=Buffer.from(await r.arrayBuffer()),headers=new Headers(r.headers);
   if(fault==='range')headers.set('Content-Range',`bytes 1-${2*MiB}/${h.row.size_bytes}`);
   if(fault==='version')headers.set('X-Media-Version','a'.repeat(64));
   if(fault==='mime')headers.set('Content-Type','text/plain');
   return new Response(fault==='extra'?Buffer.concat([bytes,Buffer.from([1])]):fault==='truncated'?bytes.subarray(1):bytes,{status:fault==='status'?200:206,headers});
  });
  const r=await h.call(`part=0&part_size=${2*MiB}&version=${h.row.sha256}`);assert([412,415,503].includes(r.statusCode),fault);assert(!Buffer.isBuffer(r.body));
 },{delegated});
});
