import test from 'node:test';import assert from 'node:assert/strict';import {database,asUser,A,B,C} from './db-harness.mjs';
test('media ownership, atomic attachment, shared reads and deletion lifecycle',async()=>{const db=await database(['001_profiles.sql','003_daily_authors.sql','004_media.sql']);const id='10000000-0000-4000-8000-000000000001',key=`daily/${id}/${A}/abc.jpg`;try{
 await asUser(db,A,`insert into media_objects(key,record_id,owner_id,content_type,size_bytes,sha256) values('${key}','${id}','${A}','image/jpeg',100,'${'a'.repeat(64)}')`);
 assert.equal((await asUser(db,B,'select * from media_objects')).rows.length,0);
 await assert.rejects(asUser(db,B,`insert into daily_checkins(id,content,photo_key) values('${id}','steal','${key}')`));
 await asUser(db,A,`insert into daily_checkins(id,content,photo_key) values('${id}','mine','${key}')`);
 assert.equal((await asUser(db,B,'select * from media_objects')).rows.length,1);
 await assert.rejects(asUser(db,B,`select begin_media_delete('${key}')`));
 await assert.rejects(asUser(db,A,`select begin_media_delete('${key}')`));
 assert.equal((await asUser(db,C,'select * from media_objects')).rows.length,0);
 await asUser(db,A,`delete from daily_checkins where id='${id}'`);
 assert.equal((await asUser(db,A,`select begin_media_delete('${key}') as ok`)).rows[0].ok,true);
 await assert.rejects(asUser(db,A,`insert into daily_checkins(id,content,photo_key) values('${id}','race','${key}')`));
 await asUser(db,A,`select finish_media_delete('${key}')`);
 assert.equal((await asUser(db,A,'select * from media_objects')).rows.length,0);
}finally{await db.close()}});
