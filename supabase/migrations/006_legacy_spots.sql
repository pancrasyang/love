-- Live preflight found one historical spot record outside the current homepage.
-- Preserve and secure it, and let the photo migration cover all 15 legacy photos.
begin;
alter table public.media_objects add column business_type text not null default 'daily' check(business_type in ('daily','spot'));
alter table public.spot_checkins add column photo_key text unique references public.media_objects(key);
alter table public.spot_checkins enable row level security;
revoke all on public.spot_checkins from public,anon,authenticated;
grant select on public.spot_checkins to authenticated;
grant all on public.spot_checkins to service_role;
create policy spot_member_guard on public.spot_checkins as restrictive for all to authenticated using(public.is_love_member()) with check(false);
create policy spot_read on public.spot_checkins for select to authenticated using(true);
drop policy media_read on public.media_objects;
create policy media_read on public.media_objects for select to authenticated using(public.is_love_member() and (owner_id=auth.uid() or exists(select 1 from public.daily_checkins d where d.photo_key=key) or exists(select 1 from public.spot_checkins s where s.photo_key=key)));
create policy media_business_guard on public.media_objects as restrictive for insert to authenticated with check(business_type='daily');
create or replace function public.guard_daily_media() returns trigger language plpgsql security definer set search_path='' as $$
declare m public.media_objects;
begin
 if TG_OP='UPDATE' and new.photo_key is not distinct from old.photo_key then return new;end if;
 if new.photo_key is null then return new;end if;
 select * into m from public.media_objects where key=new.photo_key for update;
 if not found or m.state<>'ready' or m.business_type<>(case when TG_TABLE_NAME='daily_checkins' then 'daily' else 'spot' end) or m.record_id<>new.id then raise exception 'Invalid media association';end if;
 if current_setting('role',true)='authenticated' and m.owner_id is distinct from auth.uid() then raise exception 'Cannot attach another author media';end if;
 return new;
end;$$;
create trigger guard_spot_media before insert or update on public.spot_checkins for each row execute function public.guard_daily_media();
create or replace function public.begin_media_delete(media_key text) returns boolean language plpgsql security definer set search_path='' as $$
declare m public.media_objects;
begin
 if not public.is_love_member() then raise exception 'Not authorized';end if;
 select * into m from public.media_objects where key=media_key for update;
 if not found then return false;end if;
 if m.owner_id is distinct from auth.uid() then raise exception 'Not owner';end if;
 if exists(select 1 from public.daily_checkins where photo_key=media_key) or exists(select 1 from public.spot_checkins where photo_key=media_key) then raise exception 'Media is still attached';end if;
 update public.media_objects set state='deleting' where key=media_key;return true;
end;$$;
commit;
