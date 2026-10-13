begin;
-- Add nullable author_id WITHOUT a default: existing records must remain unattributed.
alter table public.daily_checkins add column author_id uuid references public.profiles(id);
alter table public.daily_checkins enable row level security;
create function public.guard_daily() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_OP='INSERT' and current_user='authenticated' then
  if new.author_id is not null and new.author_id<>auth.uid() then raise exception 'Cannot impersonate another author';end if;
  new.author_id=auth.uid();new.created_at=now();
 elsif TG_OP='UPDATE' then
  if new.id is distinct from old.id or new.author_id is distinct from old.author_id or new.created_at is distinct from old.created_at then raise exception 'Daily identity is immutable';end if;
 end if;
 return new;
end;$$;
create trigger guard_daily before insert or update on public.daily_checkins for each row execute function public.guard_daily();
revoke all on public.daily_checkins from anon,authenticated;
grant select,insert,update,delete on public.daily_checkins to authenticated;
-- Restrictive guards intersect any old permissive policies, including unknown policies.
create policy daily_member_guard on public.daily_checkins as restrictive for all to authenticated using(public.is_love_member()) with check(public.is_love_member());
create policy daily_insert_guard on public.daily_checkins as restrictive for insert to authenticated with check(author_id=auth.uid());
create policy daily_update_guard on public.daily_checkins as restrictive for update to authenticated using(author_id=auth.uid()) with check(author_id=auth.uid());
create policy daily_delete_guard on public.daily_checkins as restrictive for delete to authenticated using(author_id=auth.uid());
create policy daily_read on public.daily_checkins for select to authenticated using(true);
create policy daily_insert on public.daily_checkins for insert to authenticated with check(true);
create policy daily_update on public.daily_checkins for update to authenticated using(true) with check(true);
create policy daily_delete on public.daily_checkins for delete to authenticated using(true);
create index daily_checkins_author_idx on public.daily_checkins(author_id);
commit;
