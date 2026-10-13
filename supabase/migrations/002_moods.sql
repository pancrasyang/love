begin;
create table public.mood_records (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null default auth.uid() references public.profiles(id),
 date date not null default (now() at time zone 'Asia/Shanghai')::date,
 mood text not null check(mood in ('happy','sweet','miss','calm','tired','sad')),
 note text not null default '' check(length(note)<=2000),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(user_id,date)
);
alter table public.mood_records enable row level security;
revoke all on public.mood_records from anon,authenticated;
grant select,insert,update,delete on public.mood_records to authenticated;
create policy moods_read on public.mood_records for select to authenticated using(public.is_love_member());
create policy moods_insert on public.mood_records for insert to authenticated with check(public.is_love_member() and user_id=auth.uid() and date=(now() at time zone 'Asia/Shanghai')::date);
create policy moods_update on public.mood_records for update to authenticated using(public.is_love_member() and user_id=auth.uid() and date=(now() at time zone 'Asia/Shanghai')::date) with check(public.is_love_member() and user_id=auth.uid() and date=(now() at time zone 'Asia/Shanghai')::date);
create policy moods_delete on public.mood_records for delete to authenticated using(public.is_love_member() and user_id=auth.uid());
create function public.guard_mood() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_OP='UPDATE' and (new.id is distinct from old.id or new.user_id is distinct from old.user_id or new.date is distinct from old.date or new.created_at is distinct from old.created_at) then raise exception 'Mood identity is immutable';end if;
 new.updated_at=now();return new;
end;$$;
create trigger guard_mood before update on public.mood_records for each row execute function public.guard_mood();
commit;
