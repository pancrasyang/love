import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {database,asUser,A,B,C} from './db-harness.mjs';
test('direct Supabase function grants are revoked without breaking triggers or authorized deletion',async()=>{
 const migration='20261013140850_function_permissions.sql';
 const db=await database(readdirSync('supabase/migrations').sort().filter(f=>f!==migration));
 try{
  // Reproduce the live project's default direct function grants.
  await db.exec('grant execute on all functions in schema public to anon,authenticated');
  assert.equal((await db.query("select has_function_privilege('anon','public.begin_media_delete(text)','EXECUTE') as allowed")).rows[0].allowed,true);
  await db.exec(readFileSync('supabase/migrations/'+migration,'utf8'));
  for(const signature of ['is_love_member()','guard_mood()','guard_daily()','guard_daily_media()','begin_media_delete(text)','finish_media_delete(text)']){
   assert.equal((await db.query(`select has_function_privilege('anon','public.${signature}','EXECUTE') as allowed`)).rows[0].allowed,false);
  }
  await assert.rejects(asUser(db,null,"select begin_media_delete('missing')"));
  await assert.rejects(asUser(db,C,"select begin_media_delete('missing')"));
  assert.equal((await asUser(db,A,"select begin_media_delete('missing') as result")).rows[0].result,false);
  const row=(await asUser(db,A,"insert into daily_checkins(content) values('permission check') returning id,author_id")).rows[0];
  assert.equal(row.author_id,A);
  assert.equal((await asUser(db,B,`update daily_checkins set content='forbidden' where id='${row.id}' returning id`)).rows.length,0);
  await asUser(db,A,"insert into mood_records(mood) values('happy')");
  await asUser(db,A,"update mood_records set mood='sweet'");
  for(const name of ['guard_mood','guard_daily','guard_daily_media']){
   await db.exec('reset role');
   assert.equal((await db.query(`select has_function_privilege('authenticated','public.${name}()','EXECUTE') as allowed`)).rows[0].allowed,false);
  }
 }finally{await db.close()}
});
