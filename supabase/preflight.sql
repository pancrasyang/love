-- Read only; run in Supabase SQL editor BEFORE migration and retain the result privately.
select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns
where table_schema='public' and table_name in ('daily_checkins','profiles','mood_records') order by table_name,ordinal_position;
select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname in ('public','storage');
select count(*) as checkin_count, count(photo_path) filter(where photo_path <> '') as photo_count from public.daily_checkins;
select id,name,public,file_size_limit,allowed_mime_types from storage.buckets;
select trigger_name,event_manipulation,action_statement from information_schema.triggers where event_object_schema='public';
