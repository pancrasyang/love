import test from 'node:test';import assert from 'node:assert/strict';import {database,asUser,A,B,C} from './db-harness.mjs';
test('mood permissions, Beijing date, unique daily record and historical deletion',async()=>{const db=await database(['001_profiles.sql','002_moods.sql']);try{
 await asUser(db,A,"insert into mood_records(mood) values('happy')");
 await asUser(db,B,"insert into mood_records(mood) values('sweet')");
 assert.equal((await asUser(db,A,'select * from mood_records')).rows.length,2);
 await assert.rejects(asUser(db,A,"insert into mood_records(mood) values('happy')"));
 await assert.rejects(asUser(db,A,`insert into mood_records(user_id,mood,date) values('${B}','sad',current_date-1)`));
 assert.equal((await asUser(db,A,`update mood_records set note='bad' where user_id='${B}' returning id`)).rows.length,0);
 assert.equal((await asUser(db,A,`delete from mood_records where user_id='${B}' returning id`)).rows.length,0);
 await assert.rejects(asUser(db,A,"insert into mood_records(mood,date) values('happy',(now() at time zone 'Asia/Shanghai')::date-1)"));
 await asUser(db,A,"update mood_records set note='today' where user_id=auth.uid()");
 await db.exec(`reset role;insert into mood_records(user_id,mood,date) values('${A}','calm',(now() at time zone 'Asia/Shanghai')::date-1)`);
 assert.equal((await asUser(db,A,"update mood_records set note='bad' where date=(now() at time zone 'Asia/Shanghai')::date-1 returning id")).rows.length,0);
 assert.equal((await asUser(db,A,"delete from mood_records where date=(now() at time zone 'Asia/Shanghai')::date-1 returning id")).rows.length,1);
 assert.equal((await asUser(db,C,'select * from mood_records')).rows.length,0);
 assert.equal((await asUser(db,A,"select (timestamptz '2026-10-13 16:00:00+00' at time zone 'Asia/Shanghai')::date::text as date")).rows[0].date,'2026-10-14');
}finally{await db.close()}});
