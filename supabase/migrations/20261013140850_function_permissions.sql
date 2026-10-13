begin;
-- Supabase grants EXECUTE directly to anon/authenticated as default privileges.
-- Revoking PUBLIC alone does not remove those direct grants.
revoke all on function public.is_love_member(), public.guard_mood(),
 public.guard_daily(), public.guard_daily_media(),
 public.begin_media_delete(text), public.finish_media_delete(text)
 from public, anon, authenticated;
-- These are the only client-callable functions; each verifies live membership,
-- and media deletion additionally verifies ownership and business associations.
grant execute on function public.is_love_member(),
 public.begin_media_delete(text), public.finish_media_delete(text)
 to authenticated;
-- Trigger helpers need no runtime client EXECUTE grant.
commit;
