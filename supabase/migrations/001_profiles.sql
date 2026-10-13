begin;
create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 role text not null unique check(role in ('pengpeng','kaikai')),
 display_name text generated always as (case role when 'pengpeng' then '朋朋' else '开开' end) stored,
 created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
-- SECURITY DEFINER avoids recursive profiles RLS; live session check revokes access after logout.
create function public.is_love_member() returns boolean language sql stable security definer
set search_path='' as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid())
 and exists(select 1 from auth.sessions s where s.id::text=auth.jwt()->>'session_id' and s.user_id=auth.uid());
$$;
revoke all on function public.is_love_member() from public;
grant execute on function public.is_love_member() to authenticated;
revoke all on public.profiles from anon,authenticated;
grant select on public.profiles to authenticated;
create policy profiles_read on public.profiles for select to authenticated using(public.is_love_member());
commit;
