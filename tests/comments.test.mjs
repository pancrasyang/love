import test from 'node:test';import assert from 'node:assert/strict';import {readdirSync} from 'node:fs';import {database,asUser,A,B,C} from './db-harness.mjs';
test('daily comments are shared between members, attributed by the database and immutable',async()=>{const db=await database(readdirSync('supabase/migrations').sort());try{
 const daily=(await asUser(db,A,"insert into daily_checkins(content) values('day') returning id")).rows[0];
 const comment=(await asUser(db,A,`insert into daily_comments(daily_id,content) values('${daily.id}','  hello  ') returning *`)).rows[0];
 assert.equal(comment.author_id,A);assert.equal(comment.content,'hello');
 assert.equal((await asUser(db,B,'select * from daily_comments')).rows.length,1);
 await assert.rejects(asUser(db,A,`insert into daily_comments(daily_id,author_id,content) values('${daily.id}','${B}','fake')`));
 await assert.rejects(asUser(db,A,`insert into daily_comments(daily_id,content) values('${daily.id}','   ')`));
 await assert.rejects(asUser(db,A,`insert into daily_comments(daily_id,content) values('${daily.id}','${'x'.repeat(1001)}')`));
 await assert.rejects(asUser(db,A,`update daily_comments set content='edited' where id='${comment.id}'`));
 await assert.rejects(asUser(db,A,`delete from daily_comments where id='${comment.id}'`));
 await assert.rejects(asUser(db,null,'select * from daily_comments'));
 assert.equal((await asUser(db,C,'select * from daily_comments')).rows.length,0);
 await asUser(db,A,`delete from daily_checkins where id='${daily.id}'`);
 assert.equal((await asUser(db,B,'select * from daily_comments')).rows.length,0);
}finally{await db.close()}});
