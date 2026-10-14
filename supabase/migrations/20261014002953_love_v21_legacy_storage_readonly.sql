-- Keep legacy objects as a read-only rollback source. Service-role migration
-- access and existing reads are retained; no object or business row is removed.
drop policy if exists v21_legacy_no_insert on storage.objects;
create policy v21_legacy_no_insert on storage.objects as restrictive
for insert to anon, authenticated with check (bucket_id <> 'love-photos');
drop policy if exists v21_legacy_no_update on storage.objects;
create policy v21_legacy_no_update on storage.objects as restrictive
for update to anon, authenticated using (bucket_id <> 'love-photos')
with check (bucket_id <> 'love-photos');
drop policy if exists v21_legacy_no_delete on storage.objects;
create policy v21_legacy_no_delete on storage.objects as restrictive
for delete to anon, authenticated using (bucket_id <> 'love-photos');
