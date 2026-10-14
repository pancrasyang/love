import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
export const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002',C='00000000-0000-4000-8000-000000000003';
export async function database(migrations){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table auth.sessions(id uuid primary key,user_id uuid);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant usage on schema auth to authenticated;grant execute on all functions in schema auth to authenticated;
 insert into auth.users values ('${A}'),('${B}'),('${C}');insert into auth.sessions values ('${A}','${A}'),('${B}','${B}'),('${C}','${C}');
 create schema storage;create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text not null,name text);alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated,service_role;grant all on storage.objects to anon,authenticated,service_role;create policy old_storage_read on storage.objects for select to anon,authenticated using(bucket_id='love-photos');create policy old_storage_insert on storage.objects for insert to anon,authenticated with check(bucket_id='love-photos');create policy old_storage_delete on storage.objects for delete to anon,authenticated using(bucket_id='love-photos');insert into storage.objects(bucket_id,name) values('love-photos','old.jpg');
 create table public.daily_checkins(id uuid primary key default gen_random_uuid(),content text not null,photo_url text,photo_path text,created_at timestamptz default now());
 insert into daily_checkins(content,photo_url,photo_path) values ('legacy','https://legacy.invalid/photo.jpg','daily-checkins/old.jpg');
 create table public.spot_checkins(id uuid primary key default gen_random_uuid(),spot_name text,photo_url text,photo_path text,created_at timestamptz default now());insert into spot_checkins(spot_name,photo_path) values('historical spot','spot-checkins/old.jpg');grant all on spot_checkins to anon,authenticated;alter table spot_checkins enable row level security;create policy old_spot on spot_checkins for all using(true) with check(true);
 grant all on public.daily_checkins to anon,authenticated;alter table daily_checkins enable row level security;create policy old_public on daily_checkins for all using(true) with check(true);`);
 for(const file of migrations)await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
 await db.exec(`insert into profiles(id,role) values('${A}','pengpeng'),('${B}','kaikai');`);
 return db;
}
export async function asUser(db,id,sql){await db.exec(`reset role;set role ${id?'authenticated':'anon'};set request.jwt.claim.sub='${id||''}';set request.jwt.claims='${JSON.stringify(id?{sub:id,session_id:id}:{})}';`);return db.query(sql)}
