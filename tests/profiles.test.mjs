import test from 'node:test';import assert from 'node:assert/strict';import {database,asUser,A,B,C} from './db-harness.mjs';
test('profiles enforce two roles, trusted provisioning and live sessions',async()=>{const db=await database(['001_profiles.sql']);try{
 assert.equal((await asUser(db,A,'select * from profiles')).rows.length,2);
 assert.equal((await asUser(db,C,'select * from profiles')).rows.length,0);
 await assert.rejects(asUser(db,A,`update profiles set role='kaikai' where id='${A}'`));
 await assert.rejects(asUser(db,null,'select * from profiles'));
 await db.exec(`reset role;delete from auth.sessions where user_id='${A}'`);
 assert.equal((await asUser(db,A,'select * from profiles')).rows.length,0);
}finally{await db.close()}});
