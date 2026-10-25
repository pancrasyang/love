// Reproducible local protocol measurement, NOT deployed/device performance.
// Runs the real API + unchanged Worker handler with synthetic Auth/DB/R2.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {fixture,MiB,sha} from '../tests/original-part-harness.mjs';

const rounds=Number(process.argv.find(a=>a.startsWith('--rounds='))?.split('=')[1]||3);
if(!Number.isInteger(rounds)||rounds<1||rounds>10)throw Error('Use --rounds=1..10');
const emit=console.log;
for(const size of [MiB/2,MiB+1,6*MiB,10*MiB])for(const partSize of [MiB,2*MiB,3*MiB]){
 const samples=[];
 for(let round=0;round<rounds;round++)await fixture(Buffer.alloc(size,37),async h=>{
  process.env.PHOTO_ORIGINAL_PART_SIZE=String(partSize);
  const began=performance.now(),meta=await h.call('meta=1'),metaMs=performance.now()-began;
  assert.equal(meta.statusCode,200);assert.equal(meta.body.part_size,partSize);
  const parts=[];for(let part=0;part<Math.ceil(size/partSize);part++){
   const r=await h.call(`part=${part}&version=${h.row.sha256}&part_size=${partSize}`);assert.equal(r.statusCode,206);parts.push(r.body);
  }
  assert.equal(sha(Buffer.concat(parts)),h.row.sha256);
  samples.push({meta_requests:1,body_requests:parts.length,body_bytes:h.counts.bytes,auth:h.counts.auth,profile:h.counts.profile,registry:h.counts.registry,business:h.counts.business,meta_ms:Math.round(metaMs),assembly_ms:Math.round(performance.now()-began)});
 },{delay:5});
 const times=samples.map(s=>s.assembly_ms).sort((a,b)=>a-b);
 emit(JSON.stringify({environment:'LOCAL SYNTHETIC; 5ms per Auth/DB/R2; no browser decoding',size_bytes:size,part_size:partSize,rounds,...samples[0],assembly_ms:undefined,assembly_median_ms:times[Math.floor(times.length/2)],assembly_min_ms:times[0],assembly_max_ms:times.at(-1),errors:0,retries:0,failed_body_bytes:0,retried_body_bytes:0}));
}
