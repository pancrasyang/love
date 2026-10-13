begin;
-- Explicitly remove inherited PUBLIC privileges as well as anon grants.
revoke all on public.profiles,public.mood_records,public.daily_checkins,public.media_objects from public,anon;
grant all on public.profiles,public.mood_records,public.daily_checkins,public.media_objects to service_role;
create or replace function public.guard_daily() returns trigger language plpgsql set search_path='' as $$
begin
 if current_user='authenticated' and (length(new.content)>10000 or length(btrim(new.content))=0) then raise exception 'Invalid content length';end if;
 if TG_OP='INSERT' and current_user='authenticated' then
  if new.author_id is not null and new.author_id<>auth.uid() then raise exception 'Cannot impersonate another author';end if;
  if coalesce(new.photo_url,'')<>'' or coalesce(new.photo_path,'')<>'' then raise exception 'New photos must use the private media API';end if;
  new.author_id=auth.uid();new.created_at=now();
 elsif TG_OP='UPDATE' then
  if new.id is distinct from old.id or new.author_id is distinct from old.author_id or new.created_at is distinct from old.created_at then raise exception 'Daily identity is immutable';end if;
  if current_user='authenticated' and (new.photo_url is distinct from old.photo_url or new.photo_path is distinct from old.photo_path) then raise exception 'Legacy photo metadata is immutable';end if;
 end if;
 return new;
end;$$;
commit;
