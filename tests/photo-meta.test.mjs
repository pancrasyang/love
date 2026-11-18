import test from 'node:test';import assert from 'node:assert/strict';
import meta from '../api/photo-meta.js';import thumbnail from '../api/photo-thumbnail.js';
test('retired R2 helper endpoints do not call any upstream for anonymous requests',async()=>{
 const old=globalThis.fetch;globalThis.fetch=()=>{throw Error('R2 must remain unused');};
 try{for(const handler of [meta,thumbnail]){const r={setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;}};await handler({method:'POST',headers:{}},r);assert.equal(r.code,401);assert.equal(r.body.code,'SESSION_REQUIRED');}}finally{globalThis.fetch=old;}
});
