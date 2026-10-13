-- ONLY AFTER migrate-photos.mjs --apply reports every legacy photo verified.
-- Retains all old objects; prevents their old public URLs from being read.
begin;
do $$begin
 if exists(select 1 from public.daily_checkins where photo_key is null and (coalesce(photo_path,'')<>'' or coalesce(photo_url,'')<>'')) then raise exception 'Legacy photos remain unmigrated';end if;
end;$$;
update storage.buckets set public=false where id='love-photos';
create policy love_legacy_closed on storage.objects as restrictive for all to public
 using(bucket_id<>'love-photos') with check(bucket_id<>'love-photos');
commit;
