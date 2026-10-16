begin;

create table public.daily_comments (
 id uuid primary key default gen_random_uuid(),
 daily_id uuid not null references public.daily_checkins(id) on delete cascade,
 author_id uuid not null references public.profiles(id),
 content text not null check(char_length(btrim(content)) between 1 and 1000),
 created_at timestamptz not null default now()
);

create index daily_comments_daily_created_idx
 on public.daily_comments(daily_id,created_at,id);

alter table public.daily_comments enable row level security;
revoke all on public.daily_comments from public,anon,authenticated;
grant select,insert on public.daily_comments to authenticated;
grant all on public.daily_comments to service_role;

create function public.guard_daily_comment() returns trigger
language plpgsql set search_path='' as $$
begin
 if current_user='authenticated' then
  if new.author_id is not null and new.author_id<>(select auth.uid()) then
   raise exception 'Cannot impersonate another author';
  end if;
  new.author_id=(select auth.uid());
  new.created_at=now();
 end if;
 new.content=btrim(new.content);
 return new;
end;
$$;

create trigger guard_daily_comment
 before insert on public.daily_comments
 for each row execute function public.guard_daily_comment();

revoke all on function public.guard_daily_comment() from public,anon,authenticated;

create policy comments_member_guard on public.daily_comments
 as restrictive for all to authenticated
 using((select public.is_love_member()))
 with check((select public.is_love_member()));

create policy comments_read on public.daily_comments
 for select to authenticated using(true);

create policy comments_insert on public.daily_comments
 for insert to authenticated with check(author_id=(select auth.uid()));

commit;
