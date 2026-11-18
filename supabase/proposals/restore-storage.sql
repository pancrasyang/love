-- REVIEW ONLY. Never run against production without explicit approval.
-- Apply first to an isolated preview database with a PRIVATE love-photos bucket.
begin;
-- No business row, registry row, or object is deleted or rewritten.
update storage.buckets set public=false where id='love-photos';
-- Existing permissive legacy policies must not bypass the member restrictions.
drop policy if exists love_legacy_closed on storage.objects;
drop policy if exists v21_legacy_no_insert on storage.objects;
-- Keep the existing no-update and no-delete guards: all originals are retained.
create policy storage_restore_members on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id<>'love-photos' or public.is_love_member())
 with check(bucket_id<>'love-photos' or public.is_love_member());
create policy storage_restore_read on storage.objects as restrictive for select to anon,authenticated
 using(bucket_id<>'love-photos' or (
 public.is_love_member() and (
 exists(select 1 from public.daily_checkins d where d.photo_path=name)
 or exists(select 1 from public.spot_checkins s where s.photo_path=name)
 )));
create policy storage_restore_insert on storage.objects as restrictive for insert to anon,authenticated
 with check(bucket_id<>'love-photos' or (
 public.is_love_member() and owner_id=auth.uid()::text
 and name ~ ('^private/'||auth.uid()::text||'/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$')
 ));
create policy storage_restore_bucket_read on storage.buckets for select to authenticated
 using(id='love-photos' and public.is_love_member());
-- Retain the existing author/identity/content guards, allowing record-scoped Storage paths.
create or replace function public.guard_daily() returns trigger language plpgsql set search_path='' as $$
begin
 if current_user='authenticated' and (length(new.content)>10000 or length(btrim(new.content))=0) then raise exception 'Invalid content length';end if;
 if TG_OP='INSERT' and current_user='authenticated' then
  if new.author_id is not null and new.author_id<>auth.uid() then raise exception 'Cannot impersonate another author';end if;
  if coalesce(new.photo_url,'')<>'' then raise exception 'Public photo URLs are forbidden';end if;
  new.author_id=auth.uid();new.created_at=now();
 elsif TG_OP='UPDATE' then
  if new.id is distinct from old.id or new.author_id is distinct from old.author_id or new.created_at is distinct from old.created_at then raise exception 'Daily identity is immutable';end if;
  if current_user='authenticated' and (new.photo_url is distinct from old.photo_url or new.photo_path is distinct from old.photo_path) then raise exception 'Photo association is immutable';end if;
 end if;
 return new;
end;$$;
-- Old broad business policies remain constrained by existing member/author guards.
-- New associations must use their author's own record-scoped upload, never an R2 key.
create function public.guard_storage_photo() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if TG_OP='UPDATE' and new.photo_path is not distinct from old.photo_path
 and new.photo_url is not distinct from old.photo_url and new.photo_key is not distinct from old.photo_key then return new;end if;
 if current_setting('role',true)<>'authenticated' then return new;end if;
 if not public.is_love_member() then raise exception 'Not authorized';end if;
 if coalesce(new.photo_url,'')<>'' or new.photo_key is not null then raise exception 'Use private Storage';end if;
 if coalesce(new.photo_path,'')<>'' and new.photo_path !~ ('^private/'||auth.uid()::text||'/'||new.id::text||'/[0-9a-f-]{36}\.(jpg|png|webp)$') then raise exception 'Invalid Storage association';end if;
 return new;
end;$$;
revoke all on function public.guard_storage_photo() from public,anon,authenticated;
create trigger guard_storage_photo before insert or update on public.daily_checkins for each row execute function public.guard_storage_photo();
commit;
