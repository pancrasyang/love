begin;
-- Fail before making changes if live preflight reveals an incompatible existing ID type.
do $$begin
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='daily_checkins' and column_name='id' and udt_name='uuid') then raise exception 'daily_checkins.id must be UUID; review live schema before migration';end if;
end;$$;
create table public.media_objects (
 key text primary key,
 record_id uuid not null,
 owner_id uuid references public.profiles(id),
 content_type text not null check(content_type in ('image/jpeg','image/png','image/webp')),
 size_bytes integer not null check(size_bytes between 1 and 10485760),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 state text not null default 'ready' check(state in ('ready','deleting')),
 created_at timestamptz not null default now()
);
alter table public.daily_checkins add column photo_key text unique references public.media_objects(key);
alter table public.media_objects enable row level security;
revoke all on public.media_objects from anon,authenticated;
grant select,insert on public.media_objects to authenticated;
create policy media_read on public.media_objects for select to authenticated using(public.is_love_member() and (owner_id=auth.uid() or exists(select 1 from public.daily_checkins d where d.photo_key=key)));
create policy media_insert on public.media_objects for insert to authenticated with check(public.is_love_member() and owner_id=auth.uid() and state='ready' and split_part(key,'/',1)='daily' and split_part(key,'/',2)=record_id::text and split_part(key,'/',3)=auth.uid()::text);
create function public.guard_daily_media() returns trigger language plpgsql security definer set search_path='' as $$
declare m public.media_objects;
begin
 if TG_OP='UPDATE' and new.photo_key is not distinct from old.photo_key then return new;end if;
 if new.photo_key is null then return new;end if;
 select * into m from public.media_objects where key=new.photo_key for update;
 if not found or m.state<>'ready' or m.record_id<>new.id then raise exception 'Invalid media association';end if;
 if current_setting('role',true)='authenticated' and m.owner_id is distinct from auth.uid() then raise exception 'Cannot attach another author media';end if;
 return new;
end;$$;
-- Only this trigger can lock registry rows; clients cannot modify registry metadata.
create trigger guard_daily_media before insert or update on public.daily_checkins for each row execute function public.guard_daily_media();
-- Lock registry then mark deleting before R2 deletion: new associations are now forbidden.
create function public.begin_media_delete(media_key text) returns boolean language plpgsql security definer set search_path='' as $$
declare m public.media_objects;
begin
 if not public.is_love_member() then raise exception 'Not authorized';end if;
 select * into m from public.media_objects where key=media_key for update;
 if not found then return false;end if;
 if m.owner_id is distinct from auth.uid() then raise exception 'Not owner';end if;
 if exists(select 1 from public.daily_checkins where photo_key=media_key) then raise exception 'Media is still attached';end if;
 update public.media_objects set state='deleting' where key=media_key;return true;
end;$$;
create function public.finish_media_delete(media_key text) returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.is_love_member() then raise exception 'Not authorized';end if;
 delete from public.media_objects where key=media_key and owner_id=auth.uid() and state='deleting';
end;$$;
revoke all on function public.begin_media_delete(text),public.finish_media_delete(text) from public;
grant execute on function public.begin_media_delete(text),public.finish_media_delete(text) to authenticated;
commit;
