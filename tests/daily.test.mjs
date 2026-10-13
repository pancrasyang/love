import test from 'node:test';import assert from 'node:assert/strict';import {database,asUser,A,B,C} from './db-harness.mjs';
test('old permissive policies cannot bypass author guards; historical content is preserved',async()=>{const db=await database(['001_profiles.sql','003_daily_authors.sql']);try{
 const legacy=(await asUser(db,A,'select * from daily_checkins')).rows[0];assert.equal(legacy.author_id,null);assert.equal(legacy.content,'legacy');
 const mine=(await asUser(db,A,"insert into daily_checkins(content) values('mine') returning *")).rows[0];assert.equal(mine.author_id,A);
 await assert.rejects(asUser(db,A,`insert into daily_checkins(content,author_id) values('fake','${B}')`));
 assert.equal((await asUser(db,B,`update daily_checkins set content='bad' where id='${mine.id}' returning id`)).rows.length,0);
 assert.equal((await asUser(db,B,`delete from daily_checkins where id='${mine.id}' returning id`)).rows.length,0);
 assert.equal((await asUser(db,A,`delete from daily_checkins where id='${legacy.id}' returning id`)).rows.length,0);
 await assert.rejects(asUser(db,A,`update daily_checkins set author_id='${B}' where id='${mine.id}'`));
 assert.equal((await asUser(db,C,'select * from daily_checkins')).rows.length,0);
 await assert.rejects(asUser(db,null,'select * from daily_checkins'));
 assert.equal((await asUser(db,A,`update daily_checkins set content='edited' where id='${mine.id}' returning id`)).rows.length,1);
 assert.equal((await asUser(db,A,`delete from daily_checkins where id='${mine.id}' returning id`)).rows.length,1);
}finally{await db.close()}});
